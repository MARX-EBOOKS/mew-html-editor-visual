import json
from pathlib import Path
import tempfile
import threading
import unittest
import sys
import io
sys.path.insert(0, str(Path(__file__).resolve().parent / 'html_pattern_scripts'))
from http.server import ThreadingHTTPServer
from urllib.error import HTTPError
from urllib.request import urlopen

from html_pattern_review import Review, make_handler, read_html
from html_patterns import HtmlPatterns


class BusinessOptions(HtmlPatterns):
    """Fixture with arbitrary action IDs, labels and a fourth action."""
    id = 'business-options'
    label = '业务选项测试'
    reviewable = True
    actions = [{'id': 'accept', 'label': '接受'}, {'id': 'skip', 'label': '略过'},
               {'id': 'later', 'label': '稍后'},
               {'id': 'append-note', 'label': '添加备注', 'input': 'text'}]

    def compare(self, context):
        end = len(context.source)
        return {'alignment': 1, 'matches': [{'id': 'note', 'pattern': 'font', 'kind': 'note',
                'start': end, 'end': end, 'line': 1, 'column': 1, 'text': '', 'ocr': '',
                'context': '业务脚本提供的选项', 'spans': [], 'crops': [], 'decision': None}]}

    def decide(self, context, hit, choice, text):
        import html
        return {'edits': [(hit['start'], hit['end'], html.escape(text))] if choice == 'append-note' else [],
                'text': text or '', 'message': '业务脚本已处理', 'advance': False}


class TextIndexTests(unittest.TestCase):
    def test_source_index_preserves_entities_hidden_text_and_boundaries(self):
        from review_common import StyledText, line_column
        source = '<head>x</head>\n<p>A&NotEqualTilde;<b>😀</b>&amp; B</p>\n'
        visible = StyledText(source)
        for start in range(len(source) + 1):
            expected = next((i for i, span in enumerate(visible.spans)
                             if span and span[0] >= start), len(visible.text))
            self.assertEqual(visible.visible_offset(start), expected)
            self.assertEqual(line_column(visible.lines, start),
                             (source.count('\n', 0, start) + 1,
                              start - source.rfind('\n', 0, start)))
            for end in range(start, len(source) + 1):
                indices = [i for i, span in enumerate(visible.spans)
                           if span and start <= span[0] and span[1] <= end]
                self.assertEqual(visible.source_range(start, end), indices)
                before = next((ch for ch, span in reversed(list(zip(visible.text, visible.spans)))
                               if span and span[1] <= start), '')
                after = next((ch for ch, span in zip(visible.text, visible.spans)
                              if span and span[0] >= end), '')
                self.assertEqual(visible.source_neighbors(start, end), (before, after))


class ReviewTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        (self.root / 'volume').mkdir()
        (self.root / 'volume' / 'page.HTML').write_text(
            '<p>😀 Ä</p>\n<font size="2">Text</font><p>&nbsp;</p>\ufffd', encoding='utf-8')
        (self.root / 'clean.htm').write_text('<p>Clean</p>', encoding='utf-8')
        (self.root / 'ignore.txt').write_text('<font>', encoding='utf-8')
        self.review = Review(self.root)

    def test_recursive_scan_counts_and_positions(self):
        files = self.review.scan()['files']
        self.assertEqual([file['path'] for file in files], ['clean.htm', 'volume/page.HTML'])
        self.assertEqual(files[1]['counts'], {'font': 2, 'empty-p': 1, 'replacement': 1})
        document = self.review.document('volume/page.HTML')
        match = document['matches'][0]
        self.assertEqual((match['line'], match['column']), (2, 1))
        self.assertEqual(document['source'][match['start']:match['end']], '<font size="2">')
        self.assertEqual(files[0]['counts']['font'], 0)

    def test_custom_patterns_and_zero_length(self):
        review = Review(self.root, [{'id': 'text', 'label': 'Text', 'regex': r'(?=Text)'}])
        match = review.document('volume/page.HTML')['matches'][0]
        self.assertEqual(match['start'], match['end'])

    def test_reuse_scan_keeps_results_without_reading_files(self):
        from unittest.mock import patch
        self.review.scan()
        with patch.object(self.review, 'review_document', side_effect=AssertionError('rescanned')):
            restored = self.review.scan(reuse=True)
        self.assertTrue(restored['restored'])
        (self.root / 'clean.htm').write_text('<font>Changed</font>', encoding='utf-8')
        self.review.document('clean.htm')
        restored = self.review.scan(reuse=True)
        self.assertEqual(restored['files'][0]['counts']['font'], 2)
        (self.root / 'new.html').write_text('<p>New</p>', encoding='utf-8')
        self.assertEqual(len(self.review.scan(reuse=True)['files']), 2)
        self.assertEqual(len(self.review.scan()['files']), 3)
        self.assertNotIn('restored', self.review.scan())

    def test_declared_encoding(self):
        path = self.root / 'encoded.htm'
        path.write_bytes('<meta charset="windows-1252"><p>Größe</p>'.encode('cp1252'))
        self.assertIn('Größe', read_html(path)[0])

    def test_paths_cannot_escape_root(self):
        for path in ['../outside.html', str(self.root.parent / 'outside.html'), 'ignore.txt']:
            with self.subTest(path=path), self.assertRaises(ValueError):
                self.review.resolve(path)

    def test_http_routes_and_preview_sandbox(self):
        server = ThreadingHTTPServer(('127.0.0.1', 0), make_handler(self.review))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(thread.join)
        self.addCleanup(server.shutdown)
        base = f'http://127.0.0.1:{server.server_port}'
        for route in ['/', '/app.js', '/style.css', '/api/files', '/api/document?path=clean.htm']:
            with self.subTest(route=route), urlopen(base + route) as response:
                self.assertEqual(response.status, 200)
                if route == '/api/files':
                    self.assertEqual(len(json.load(response)['files']), 2)
        with urlopen(base + '/api/preview?path=clean.htm') as response:
            self.assertIn("sandbox; default-src 'none'", response.headers['Content-Security-Policy'])
            self.assertEqual(response.read().decode(), '<p>Clean</p>')
        for route, status in [('/api/document?path=..%2Fescape.html', 400),
                              ('/api/document?path=missing.html', 404), ('/not-found', 404)]:
            with self.subTest(route=route), self.assertRaises(HTTPError) as error:
                urlopen(base + route)
            self.assertEqual(error.exception.code, status)
            error.exception.close()


class OcrReviewTests(unittest.TestCase):
    def setUp(self):
        import fitz
        from PIL import Image
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.html = self.root / 'html'
        self.html.mkdir()
        self.pdf = self.root / 'pdf'
        self.pdf.mkdir()
        self.path = self.html / 'ME16-009.html'
        self.path.write_text('<html><head><title>Ignored</title></head><body><p>Hello <i>wrld</i> &amp; friends.</p></body></html>', 'utf-8')
        (self.html / 'ME16-011.html').write_text('<p>Last page.</p>', 'utf-8')
        image = Image.new('RGB', (600, 400), 'white')
        image.putpixel((50, 50), (12, 34, 56))
        output = io.BytesIO()
        image.save(output, format='PNG')
        with fitz.open() as pdf:
            for text in ['Hello world & friends.', 'Second page.', 'Last page.']:
                page = pdf.new_page(width=300, height=200)
                page.insert_image(page.rect, stream=output.getvalue())
                page.insert_text((25, 40), text)
            pdf.set_page_labels([{'startpage': 0, 'prefix': '', 'style': 'D', 'firstpagenum': 9}])
            pdf.save(self.pdf / 'mew_band16.pdf')
        self.review = Review(self.html, pdf_root=self.pdf, data_dir=self.root / 'data')

    def payload(self, doc, hit, choice, text=''):
        return {'path': doc['path'], 'version': doc['version'], 'id': hit['id'], 'choice': choice, 'text': text}

    def test_shared_pdf_index_and_alignment_across_providers_and_html_edits(self):
        from unittest.mock import patch
        from diff_engine import PdfTextIndex, SequenceMatcher
        with patch('diff_engine.PdfTextIndex', wraps=PdfTextIndex) as loading, \
             patch('diff_engine.SequenceMatcher', wraps=SequenceMatcher) as matching:
            self.review.ocr_document(self.path.name)
            self.review.review_document(self.path.name, 'ocr-styles')
            self.assertEqual(loading.call_count, 1)
            self.assertEqual(matching.call_count, 1)
            self.path.write_text('<p>Changed HTML</p>', 'utf-8')
            self.review.ocr_document(self.path.name)
            self.assertEqual(loading.call_count, 1)
            self.assertEqual(matching.call_count, 2)
            self.review.ocr_document('ME16-011.html')
            self.assertEqual(loading.call_count, 1)

    def test_replacing_pdf_invalidates_shared_index_and_alignment(self):
        import fitz
        from unittest.mock import patch
        from diff_engine import PdfTextIndex
        with patch('diff_engine.PdfTextIndex', wraps=PdfTextIndex) as loading:
            before = self.review.ocr_document(self.path.name)
            with fitz.open(self.pdf / 'mew_band16.pdf') as pdf:
                pdf[0].insert_text((25, 80), 'New OCR text')
                pdf.saveIncr()
            after = self.review.ocr_document(self.path.name)
            self.assertEqual(loading.call_count, 2)
            self.assertNotEqual(before['matches'], after['matches'])

    def test_previous_is_backend_navigation_without_writes(self):
        from unittest.mock import patch
        doc = self.review.ocr_document(self.path.name)
        original = self.path.read_bytes()
        with patch.object(self.review.provider('ocr'), 'decide', side_effect=AssertionError('business navigation')):
            result = self.review.decide(self.payload(doc, doc['matches'][0], 'previous'))
        self.assertEqual(result['decisionResult']['step'], -1)
        self.assertEqual(self.path.read_bytes(), original)
        self.assertFalse(self.review.journal_path(self.path.name).exists())

    def test_infers_range_from_next_filename_and_loads_native_page(self):
        from PIL import Image
        from urllib.parse import parse_qs, urlsplit
        doc = self.review.ocr_document(self.path.name)
        self.assertEqual([p['label'] for p in doc['pages']], ['9', '10'])
        self.assertTrue(any('Second' in h['ocr'] for h in doc['matches']))
        hit = next(h for h in doc['matches'] if h['ocr'].strip() == 'o')
        geometry = self.review.image(self.path.name, doc['version'], hit['id'], 0, with_geometry=True)
        query = parse_qs(urlsplit(geometry['image']).query)
        content, kind = self.review.image(query['path'][0], query['version'][0], query['id'][0], int(query['index'][0]))
        image = Image.open(io.BytesIO(content))
        self.assertEqual(image.size, (600, 400))
        self.assertEqual(kind, 'image/png')
        self.assertGreater(geometry['highlight'][2], 0)
        self.assertEqual(image.getpixel((50, 50)), (12, 34, 56))
        self.assertEqual(image.getpixel((0, 0)), (255, 255, 255))
        # A new filename changes the inferred ownership and invalidates cached diff.
        (self.html / 'ME16-010.html').write_text('<p>Second page.</p>', 'utf-8')
        self.assertEqual(len(self.review.ocr_document(self.path.name)['pages']), 1)

    def test_whole_page_images_cover_range_without_hits_and_preserve_scan_bytes(self):
        import fitz
        from html_pattern_review import Conflict
        from urllib.parse import parse_qs, urlsplit
        pdf_path = self.pdf / 'mew_band16.pdf'
        original = pdf_path.read_bytes()
        document = self.review.review_document(self.path.name, 'patterns')
        self.assertEqual(document['matches'], [])
        pages = self.review.page_images(self.path.name, document['version'])
        self.assertEqual([page['label'] for page in pages], ['9', '10'])
        with fitz.open(pdf_path) as pdf:
            for page in pages:
                self.assertEqual(len(page['images']), 1)
                query = parse_qs(urlsplit(page['images'][0]['src']).query)
                content, _ = self.review.image(query['path'][0], query['version'][0],
                                               query['id'][0], int(query['index'][0]))
                self.assertEqual(content, pdf.extract_image(int(query['id'][0]))['image'])
        last = self.review.source_document('ME16-011.html')
        self.assertEqual([page['label'] for page in self.review.page_images(last['path'], last['version'])], ['11'])
        self.path.write_text('<p>Changed</p>', 'utf-8')
        with self.assertRaises(Conflict):
            self.review.page_images(self.path.name, document['version'])
        self.assertEqual(pdf_path.read_bytes(), original)

    def test_three_choices_persist_preserve_tags_and_reject_stale_save(self):
        from html_pattern_review import Conflict
        doc = self.review.ocr_document(self.path.name)
        hit = next(h for h in doc['matches'] if h['ocr'].strip() == 'o')
        original = self.path.read_bytes()
        kept = self.review.decide(self.payload(doc, hit, 'next'))
        self.assertEqual(self.path.read_bytes(), original)
        self.assertEqual(next(h for h in kept['matches'] if h['id'] == hit['id'])['decision'], None)
        changed = self.review.decide(self.payload(doc, hit, 'ocr'))
        self.assertIn('<i>world</i> &amp;', self.path.read_text('utf-8'))
        self.assertFalse(self.path.read_bytes().startswith(b'\xef\xbb\xbf'))
        self.assertEqual(next((self.root / 'data').glob('*.original')).read_bytes(), original)
        with self.assertRaises(Conflict):
            self.review.decide(self.payload(doc, hit, 'ocr'))
        hit = changed['matches'][0]
        edited = changed['source'][:hit['start']] + '<b>correct &amp; new</b>' + changed['source'][hit['end']:]
        payload = self.payload(changed, hit, 'custom', edited)
        proposed = self.review.decide(payload, preview=True)
        self.assertEqual(proposed['source'], edited)
        self.assertEqual(self.path.read_text('utf-8'), changed['source'])
        self.review.decide(payload)
        self.assertEqual(self.path.read_text('utf-8'), edited)
        with self.assertRaises(Conflict):
            self.review.decide(payload)

    def test_word_insertions_have_spaces_and_entities_keep_offsets(self):
        self.path.write_text('<body>Hello &amp; friends.</body>', 'utf-8')
        (self.html / 'ME16-010.html').write_text('<p>Second page.</p>', 'utf-8')
        doc = self.review.ocr_document(self.path.name)
        hit = next(h for h in doc['matches'] if 'world' in h['ocr'])
        self.review.decide(self.payload(doc, hit, 'ocr'))
        self.assertEqual(self.path.read_text('utf-8'), '<body>Hello world &amp; friends.</body>')

    def test_http_save_and_crop_errors(self):
        from urllib.request import Request
        server = ThreadingHTTPServer(('127.0.0.1', 0), make_handler(self.review))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(thread.join)
        self.addCleanup(server.shutdown)
        base = f'http://127.0.0.1:{server.server_port}'
        doc = self.review.ocr_document(self.path.name)
        request = Request(base + '/api/decision', data=json.dumps(self.payload(doc, doc['matches'][0], 'next')).encode(),
                          headers={'Content-Type': 'application/json', 'Origin': f'http://localhost:{server.server_port}'})
        with urlopen(request) as response:
            self.assertEqual(response.status, 200)
        request.add_header('Origin', 'http://foreign.example')
        with self.assertRaises(HTTPError) as error:
            urlopen(request)
        self.assertEqual(error.exception.code, 400)
        error.exception.close()

    def test_next_survives_other_edits_and_empty_body_is_reviewable(self):
        doc = self.review.ocr_document(self.path.name)
        first = doc['matches'][0]
        self.review.decide(self.payload(doc, first, 'next'))
        hit = doc['matches'][-1]
        edited = doc['source'][:hit['start']] + 'Another reading.' + doc['source'][hit['end']:]
        changed = self.review.decide(self.payload(doc, hit, 'custom', edited))
        self.assertEqual(next(h for h in changed['matches'] if h['id'] == first['id'])['decision'], None)
        self.path.write_text('<html><head><title>Title</title></head><body></body></html>', 'utf-8')
        (self.html / 'ME16-010.html').write_text('<p>Second page.</p>', 'utf-8')
        empty = self.review.ocr_document(self.path.name)
        self.assertEqual(len(empty['matches']), 1)
        self.review.decide(self.payload(empty, empty['matches'][0], 'ocr'))
        self.assertIn('<body>Hello world &amp; friends.</body>', self.path.read_text('utf-8'))


class ProviderTests(unittest.TestCase):
    def test_edit_assembly_and_latest_journal_decisions(self):
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = '<p>Original &amp; text</p>'
            (root / 'page.html').write_text(source, encoding='utf-8')
            provider = BusinessOptions()
            review = Review(root, providers=[provider], data_dir=root / 'journal')
            document = review.review_document('page.html', provider.id)
            edits = [(3, 3, 'A'), (3, 3, 'B'), (3, 11, 'changed'),
                     (12, 17, '&lt;'), (len(source), len(source), '!')]
            expected = source
            for a, b, replacement in reversed(edits):
                expected = expected[:a] + replacement + expected[b:]
            payload = {'path': 'page.html', 'purpose': provider.id,
                       'version': document['version'], 'id': 'note', 'choice': 'accept'}
            with patch.object(provider, 'decide', return_value={'edits': edits, 'text': ''}):
                self.assertEqual(review.decide(payload, preview=True)['source'], expected)
            self.assertEqual((root / 'page.html').read_text('utf-8'), source)
            journal = review.journal_path('page.html')
            journal.parent.mkdir()
            journal.write_text(json.dumps([
                {'id': 'note', 'purpose': provider.id, 'choice': 'accept', 'edits': []},
                {'id': 'note', 'purpose': provider.id, 'choice': 'later', 'edits': []},
                {'id': 'note', 'purpose': provider.id, 'choice': 'append-note', 'edits': [[0, 0, 'x']]},
                {'id': 'note', 'purpose': 'other', 'choice': 'skip', 'edits': []},
            ]), encoding='utf-8')
            review.cache.clear()
            self.assertEqual(review.review_document('page.html', provider.id)['matches'][0]['decision'], 'later')

    setUp = ReviewTests.setUp

    def test_business_defined_actions_and_decision(self):
        review = Review(self.root, providers=[BusinessOptions()], data_dir=self.root / 'data')
        doc = review.review_document('clean.htm', 'business-options')
        self.assertEqual(len(doc['actions']), 4)
        self.assertEqual(doc['navigation'][1], {'id': 'next', 'label': '下一条', 'step': 1})
        payload = {'path': doc['path'], 'purpose': 'business-options', 'version': doc['version'],
                   'id': 'note', 'choice': 'append-note', 'text': '<note>'}
        changed = review.decide(payload)
        self.assertTrue(changed['source'].endswith('&lt;note&gt;'))
        self.assertEqual(changed['decisionResult']['message'], '业务脚本已处理')
        payload.update(version=changed['version'], choice='skip')
        saved = review.decide(payload)
        self.assertEqual(saved['matches'][0]['decision'], 'skip')
        payload['choice'] = 'unknown'
        with self.assertRaises(ValueError):
            review.decide(payload)

    def test_next_is_owned_by_backend_without_recompare_or_business_decision(self):
        from unittest.mock import patch
        provider = BusinessOptions()
        review = Review(self.root, providers=[provider], data_dir=self.root / 'data')
        doc = review.review_document('clean.htm', provider.id)
        original = (self.root / 'clean.htm').read_bytes()
        with patch.object(provider, 'compare', side_effect=AssertionError('unnecessary comparison')), \
             patch.object(provider, 'decide', side_effect=AssertionError('business next handler')):
            result = review.decide({'path': doc['path'], 'purpose': provider.id, 'version': doc['version'],
                                    'id': 'note', 'choice': 'next'})
        self.assertEqual(result['decisionResult']['step'], 1)
        self.assertFalse(review.journal_path(doc['path']).exists())
        self.assertEqual((self.root / 'clean.htm').read_bytes(), original)

    def test_explicit_registration_and_unknown_provider(self):
        from html_patterns import HtmlPatterns

        class Words(HtmlPatterns):
            id = 'words'
            label = 'Custom words'

        custom = Words([{'id': 'clean', 'label': 'Clean', 'regex': 'Clean'}])
        review = Review(self.root, providers=[custom])
        listing = review.scan('words')
        self.assertEqual(listing['purposes'], [{'id': 'words', 'label': 'Custom words'}])
        self.assertEqual(review.review_document('clean.htm', 'words')['matches'][0]['text'], 'Clean')
        with self.assertRaisesRegex(ValueError, 'Unknown review purpose'):
            review.scan('ocr')
        with self.assertRaisesRegex(ValueError, 'unique'):
            Review(self.root, providers=[custom, custom])


class OcrStyleReviewTests(unittest.TestCase):
    setUp = OcrReviewTests.setUp

    def styled_pdf(self):
        import fitz
        path = self.pdf / 'mew_band16.pdf'
        with fitz.open(path) as original:
            image = original.extract_image(original[0].get_images()[0][0])['image']
        with fitz.open() as pdf:
            page = pdf.new_page(width=300, height=200)
            page.insert_image(page.rect, stream=image)
            x = 25
            for text, font in [('Italic & ', 'heit'), ('Bold', 'hebo'), (' Both', 'hebi')]:
                page.insert_text((x, 40), text, fontname=font, fontsize=11)
                x += fitz.get_text_length(text, fontname=font, fontsize=11)
            pdf.set_page_labels([{'startpage': 0, 'style': 'D', 'firstpagenum': 9}])
            pdf.save(path)
        (self.html / 'ME16-011.html').unlink()
        self.path.write_text('<p>Italic &amp; <strong>Bold</strong> <em>Both</em></p>', 'utf-8')

    def decision(self, doc, hit, choice):
        return {'path': self.path.name, 'purpose': 'ocr-styles', 'version': doc['version'],
                'id': hit['id'], 'choice': choice}

    def test_styles_apply_preserving_entities_tags_pdf_and_backup(self):
        from html_pattern_review import Conflict
        self.styled_pdf()
        original = self.path.read_bytes()
        pdf_original = (self.pdf / 'mew_band16.pdf').read_bytes()
        scan = self.review.scan('ocr-styles')
        self.assertEqual(scan['files'][0]['counts'], {'italic': None, 'bold': None})
        doc = self.review.review_document(self.path.name, 'ocr-styles')
        self.assertEqual(len(doc['matches']), 3)
        self.assertEqual([h['kind'] for h in doc['matches']], ['missing', 'matched', 'missing'])
        hit = doc['matches'][0]
        kept = self.review.decide(self.decision(doc, hit, 'next'))
        self.assertEqual(kept['matches'][0]['decision'], None)
        self.assertGreater(self.review.image(self.path.name, doc['version'], hit['id'], 0, 'ocr-styles', with_geometry=True)['highlight'][2], 0)
        changed = self.review.decide(self.decision(doc, hit, 'ocr'))
        self.assertIn('<i>Italic &amp;</i>', self.path.read_text('utf-8'))
        self.assertIn('<strong>Bold</strong> <em>Both</em>', self.path.read_text('utf-8'))
        self.assertEqual(changed['matches'][0]['kind'], 'matched')
        with self.assertRaises(Conflict):
            self.review.decide(self.decision(doc, hit, 'ocr'))
        bold = next(h for h in changed['matches'] if h['pattern'] == 'bold')
        final = self.review.decide(self.decision(changed, bold, 'ocr'))
        self.assertTrue(all(h['kind'] == 'matched' for h in final['matches']))
        self.assertEqual(next((self.root/'data').glob('*.original')).read_bytes(), original)
        self.assertEqual((self.pdf/'mew_band16.pdf').read_bytes(), pdf_original)
        self.assertEqual(len(self.review.ocr_document(self.path.name)['matches']), 0)

    def test_unaligned_is_review_only_and_plain_pdf_has_no_style_hits(self):
        self.assertEqual(self.review.review_document(self.path.name, 'ocr-styles')['matches'], [])
        self.styled_pdf()
        self.path.write_text('<p>Completely different.</p>', 'utf-8')
        doc = self.review.review_document(self.path.name, 'ocr-styles')
        self.assertTrue(all(h['kind'] == 'review' for h in doc['matches']))
        before = self.path.read_bytes()
        with self.assertRaises(ValueError):
            self.review.decide(self.decision(doc, doc['matches'][0], 'ocr'))
        self.assertEqual(self.path.read_bytes(), before)

    def test_inline_styles_nested_resets_and_entities(self):
        from ocr_styles import StyledText, OcrStyles
        from review_provider import ReviewContext
        source = '<p style="font-weight:700;font-style:italic">A&amp;<span style="font-weight:normal;font-style:normal">B</span>C</p>'
        visible = StyledText(source)
        flags = {ch: f for ch, f in zip(visible.text, visible.styles) if ch.strip()}
        self.assertEqual(flags, {'A': 18, '&': 18, 'B': 0, 'C': 18})
        source = '<p>abc</p>'
        ctx = ReviewContext(source, 'axc', [(1, '9', (1, 1, 2, 2))]*3, [2]*3, 'test')
        self.assertEqual(OcrStyles().compare(ctx)['matches'][0]['kind'], 'review')


class ReaderConfigTests(unittest.TestCase):
    setUp = OcrReviewTests.setUp

    def test_duplicate_page_does_not_block_library_or_other_documents(self):
        duplicate = self.html / 'ME16-0011.html'
        duplicate.write_text('<p>Duplicate page</p>', 'utf-8')
        review = Review(config_path=self.config(), data_dir=self.root / 'data')
        listing = review.scan('ocr')
        self.assertEqual(len(listing['files']), 3)
        doc = review.ocr_document('ME16-009.html')
        self.assertEqual([p['label'] for p in doc['pages']], ['9', '10'])
        self.assertTrue(doc['matches'])
        for name in ['ME16-011.html', duplicate.name]:
            with self.assertRaisesRegex(ValueError, 'Ambiguous HTML page 11'):
                review.ocr_document(name)
            self.assertIn('<p>', review.source_document(name)['source'])
        self.assertEqual(len(review.scan('patterns')['files']), 3)

    def config(self, **overrides):
        value = {'htmlRoot': 'html', 'pdf': 'pdf/mew_band16.pdf',
                 'pagePattern': r'^ME16-(?<page>\d+)\.html?$', 'pageLabel': '{page}'}
        value.update(overrides)
        path = self.root / '.mew-reader.json'
        path.write_text(json.dumps(value), 'utf-8')
        return path

    def test_same_reader_config_drives_scan_diff_save_and_native_crop(self):
        self.path.rename(self.html / 'chapter-009.html')
        (self.html / 'ME16-011.html').rename(self.html / 'chapter-011.html')
        config = self.config(pagePattern=r'^chapter-(?<page>\d+)\.html?$')
        review = Review(config_path=config, data_dir=self.root / 'data')
        listing = review.scan('ocr')
        self.assertEqual([f['path'] for f in listing['files']], ['chapter-009.html', 'chapter-011.html'])
        self.assertEqual(Path(listing['configPath']), config.resolve())
        doc = review.ocr_document('chapter-009.html')
        self.assertEqual([p['label'] for p in doc['pages']], ['9', '10'])
        hit = next(h for h in doc['matches'] if h['ocr'].strip() == 'o')
        self.assertGreater(review.image(doc['path'], doc['version'], hit['id'], 0, with_geometry=True)['highlight'][2], 0)
        review.decide({'path': doc['path'], 'id': hit['id'], 'version': doc['version'], 'choice': 'ocr'})
        self.assertIn('<i>world</i>', (self.html/'chapter-009.html').read_text('utf-8'))
        # New matching filenames invalidate the inferred page range.
        (self.html/'chapter-010.html').write_text('<p>Second page.</p>', 'utf-8')
        self.assertEqual(len(review.ocr_document('chapter-009.html')['pages']), 1)

    def test_multi_volume_nested_pages_and_explicit_list(self):
        extra = self.root / 'extra'
        extra.mkdir()
        (extra/'part-009.html').write_text('<p>Hello world</p>', 'utf-8')
        (extra/'part-011.html').write_text('<p>Excluded</p>', 'utf-8')
        config = self.config(volumes=[
            {'id': 'a', 'pages': {'directory': 'html', 'list': [9, 11]}},
            {'id': 'b', 'pdf': {'file': 'pdf/mew_band16.pdf'},
             'pages': {'directory': 'extra', 'pattern': r'^part-(\d+)\.html$', 'list': [9]}}
        ])
        review = Review(config_path=config)
        self.assertEqual([f['path'] for f in review.scan()['files']],
                         ['extra/part-009.html', 'html/ME16-009.html', 'html/ME16-011.html'])
        self.assertEqual(len(review.ocr_document('extra/part-009.html')['pages']), 3)
        with self.assertRaisesRegex(ValueError, 'configured volume'):
            review.resolve('extra/part-011.html')
        (self.root/'outside.html').write_text('<p>Unconfigured</p>', 'utf-8')
        with self.assertRaises(ValueError):
            review.resolve('outside.html')

    def test_page_label_template_and_file_uri(self):
        import fitz
        from html_pattern_review import local_resource
        config = self.config(pdf={'file': (self.pdf/'mew_band16.pdf').as_uri()}, pageLabel='p.{page}')
        with fitz.open(self.pdf/'mew_band16.pdf') as pdf:
            pdf.set_page_labels([{'startpage': 0, 'prefix': 'p.', 'style': 'D', 'firstpagenum': 9}])
            pdf.saveIncr()
        review = Review(config_path=config)
        self.assertEqual([p['label'] for p in review.ocr_document(self.path.name)['pages']], ['p.9', 'p.10'])
        self.assertEqual(local_resource(self.path.as_uri(), self.root), self.path)
        with self.assertRaisesRegex(ValueError, 'local'):
            local_resource('https://example.org/book.pdf', self.root)

    def test_config_discovery_precedence_and_invalid_config(self):
        from unittest.mock import patch
        from html_pattern_review import find_default_config
        config = self.config()
        nested = self.root/'nested'/'child'
        nested.mkdir(parents=True)
        with patch.dict('os.environ', {'CONFIG': ''}), patch('html_pattern_review.Path.cwd', return_value=nested):
            self.assertEqual(find_default_config(), config)
            nearer = nested/'mew-reader.json'
            nearer.write_text('{}', 'utf-8')
            self.assertEqual(find_default_config(), nearer)
            with patch.dict('os.environ', {'CONFIG': str(config)}):
                self.assertEqual(find_default_config(), config)
                self.assertEqual(find_default_config(nearer), nearer)
        config.write_text('{broken', 'utf-8')
        with self.assertRaises(ValueError):
            Review(config_path=config)

    def test_shared_crop_owner_and_invalid_box(self):
        import fitz
        import html_pattern_review as backend
        import ocr_patch_review as old
        self.assertIs(old.crop, backend.crop)
        self.assertIs(old.scan_for_box, backend.scan_for_box)
        with fitz.open(self.pdf/'mew_band16.pdf') as pdf:
            with self.assertRaisesRegex(ValueError, 'nonnegative'):
                backend.crop(pdf, {}, padding=-1)
            with self.assertRaisesRegex(ValueError, 'nonempty'):
                backend.scan_for_box(pdf[0], fitz.Rect(0, 0, 0, 0), 'bad')


if __name__ == '__main__':
    unittest.main()
