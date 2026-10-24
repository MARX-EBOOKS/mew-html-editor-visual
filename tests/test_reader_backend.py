"""Reader migration contracts and persistent OCR sequence regression checks."""
from concurrent.futures import ThreadPoolExecutor
import importlib.util
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / 'html_pattern_scripts'))
spec = importlib.util.spec_from_file_location('reader_backend', ROOT / 'reader-server.py')
backend = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backend)
from pdf_text_backend import PdfTextIndex, browser_path, cache_path, generate_pdf_text, load_browser, read_json
import fitz


class ReaderBackendTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        (self.root / 'pages').mkdir()
        (self.root / 'pages/ME01-001.html').write_text('<p>Normal <em>Italic</em> <strong>Bold</strong></p>', 'utf-8')
        self.pdf = self.root / 'scan.pdf'
        with fitz.open() as book:
            page = book.new_page()
            page.insert_text((30, 30), 'Normal', fontname='Times-Roman')
            page.insert_text((30, 50), 'Italic', fontname='Times-Italic', fontsize=14, color=(1, 0, 0))
            page.insert_text((30, 70), 'Bold', fontname='Times-Bold', fontsize=18)
            book.set_page_labels([dict(startpage=0, prefix='', style='D', firstpagenum=1)])
            book.save(self.pdf)
        self.config = self.root / '.mew-reader.json'
        self.config.write_text(json.dumps(dict(title='Fixture', volumes=[dict(id='1',
            pages=dict(directory='pages', pattern=r'^ME01-(?<page>\d+)[.]html$'), pdf='scan.pdf')])), 'utf-8')
        self.library = backend.Library(self.config)

    def start(self):
        listener = socket.socket()
        listener.bind(('127.0.0.1', 0))
        port = listener.getsockname()[1]
        server = backend.uvicorn.Server(backend.uvicorn.Config(
            backend.create_app(self.library), log_level='error'))
        worker = threading.Thread(target=server.run, kwargs={'sockets': [listener]}, daemon=True)
        worker.start()

        def close():
            server.should_exit = True
            worker.join(timeout=5)
            listener.close()
        self.addCleanup(close)
        deadline = time.monotonic() + 5
        while not server.started:
            if not worker.is_alive() or time.monotonic() > deadline:
                self.fail('FastAPI server did not start')
            time.sleep(0.01)
        self.base = f'http://127.0.0.1:{port}'

    def request(self, path, data=None, method=None, headers=None):
        request = Request(self.base + path, data=json.dumps(data).encode() if data is not None else None,
                          method=method, headers=headers or {})
        return urlopen(request)

    def test_js_and_fastapi_http_contracts_match(self):
        self.start()
        with socket.socket() as listener:
            listener.bind(('127.0.0.1', 0))
            port = listener.getsockname()[1]
        process = subprocess.Popen(['node', str(ROOT / 'reader-server.js'), '-c', str(self.config),
                                    '-p', str(port)], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)

        def close():
            process.terminate()
            process.wait(timeout=5)
            process.stderr.close()
        self.addCleanup(close)
        node_base = f'http://127.0.0.1:{port}'
        deadline = time.monotonic() + 5
        while True:
            if process.poll() is not None:
                self.fail(process.stderr.read().decode('utf-8', errors='replace'))
            try:
                with urlopen(node_base + '/api/reader/config', timeout=0.2):
                    break
            except OSError:
                if time.monotonic() > deadline:
                    self.fail('Node reader did not start')
                time.sleep(0.02)

        for path in ('/api/reader/config', '/api/reader/page/1/1', '/api/reader/link/1/1',
                     '/api/reader/locate?path=pages%2FME01-001.html', '/api/tree',
                     '/api/file?path=pages%2FME01-001.html',
                     '/api/reader/resource/1/ME01-001.html', '/raw/pages/ME01-001.html',
                     '/mewde.css', '/', '/monaco/min/vs/loader.js', '/api/reader/pdf/1'):
            with self.subTest(path=path):
                for method, headers in [('GET', {}), ('HEAD', {})] if path == '/api/reader/pdf/1' else [('GET', {})]:
                    with urlopen(Request(node_base + path, method=method, headers=headers)) as node, \
                            self.request(path, method=method, headers=headers) as python:
                        self.assertEqual(python.status, node.status)
                        self.assertEqual(python.headers['Content-Type'], node.headers['Content-Type'])
                        self.assertEqual(python.headers['Cache-Control'], node.headers['Cache-Control'])
                        expected, actual = node.read(), python.read()
                        if method != 'HEAD' and 'application/json' in node.headers['Content-Type']:
                            actual, expected = json.loads(actual), json.loads(expected)
                            # Path.resolve() restores disk casing on Windows; Node keeps input casing.
                            for key in ('configPath', 'editorRoot', 'root'):
                                if key in actual and actual[key] is not None:
                                    actual[key] = os.path.normcase(actual[key])
                                    expected[key] = os.path.normcase(expected[key])
                            self.assertEqual(actual, expected)
                        else:
                            self.assertEqual(actual, expected)
        for byte_range in ('bytes=0-9', 'bytes=10-'):
            with self.subTest(byte_range=byte_range):
                with urlopen(Request(node_base + '/api/reader/pdf/1', headers={'Range': byte_range})) as node, \
                        self.request('/api/reader/pdf/1', headers={'Range': byte_range}) as python:
                    self.assertEqual(python.status, node.status)
                    self.assertEqual(python.headers['Content-Range'], node.headers['Content-Range'])
                    self.assertEqual(python.read(), node.read())

    def test_existing_routes_ranges_and_write_conflicts(self):
        self.start()
        with self.request('/api/reader/config') as response:
            config = json.load(response)
        self.assertEqual(config['volumes'][0]['pages'], [1])
        with self.request('/api/reader/pdf/1', headers={'Range': 'bytes=-20'}) as response:
            self.assertEqual(response.status, 206)
            self.assertEqual(response.read(), self.pdf.read_bytes()[-20:])
        with self.request('/api/reader/pdf/1', headers={'Range': 'bytes=0-9'}, method='HEAD') as response:
            self.assertEqual(response.headers['Content-Length'], '10')
            self.assertEqual(response.read(), b'')
        with self.assertRaises(HTTPError) as error:
            self.request('/api/reader/pdf/1', headers={'Range': 'bytes=9999999-'})
        self.assertEqual(error.exception.code, 416)
        error.exception.close()
        with self.request('/api/file?path=pages%2FME01-001.html') as response:
            file = json.load(response)
        with self.request('/api/save', dict(path=file['path'], mtime=file['mtime'], text='<p>changed</p>')) as response:
            self.assertEqual(json.load(response)['ok'], True)
        with self.assertRaises(HTTPError) as error:
            self.request('/api/save', dict(path=file['path'], mtime=-1, text='stale'))
        self.assertEqual(error.exception.code, 409)
        error.exception.close()
        with self.request('/api/create', dict(path='new.html', text='new')) as response:
            self.assertEqual(response.status, 201)
        with self.assertRaises(HTTPError) as error:
            self.request('/api/create', dict(path='new.html', text='overwrite'))
        self.assertEqual(error.exception.code, 409)
        error.exception.close()
        self.assertEqual((self.root / 'new.html').read_text(), 'new')
        for path in ('/api/file?path=..%2Foutside', '/api/reader/resource/1/%2e%2e/%2e%2e/outside'):
            with self.assertRaises(HTTPError) as error:
                self.request(path)
            self.assertIn(error.exception.code, (400, 403))
            error.exception.close()
        with self.request('/monaco/min/vs/loader.js') as response:
            self.assertIn('javascript', response.headers['Content-Type'])

    def test_cache_survives_restart_and_is_shared_with_review(self):
        original = self.pdf.read_bytes()
        generate_pdf_text(self.pdf, self.root)
        first = PdfTextIndex(self.pdf, cache_dir=self.root).browser()
        self.assertTrue(cache_path(self.pdf, self.root).is_file())
        self.assertTrue(any(run['text'] == '<i>Italic</i>' for run in first['formatted']))
        self.assertTrue(any(run['text'] == '<b>Bold</b>' for run in first['formatted']))
        italic = next(first['fonts'][run['fontIndex']] for run in first['formatted'] if run['text'] == '<i>Italic</i>')
        self.assertEqual(italic['size'], 14)
        self.assertEqual(italic['color'], 0xFF0000)
        self.assertEqual(italic['alpha'], 255)
        self.assertGreater(italic['ascender'], 0)
        self.assertLess(italic['descender'], 0)
        from diff_engine import DiffEngine
        with patch('fitz.open', side_effect=AssertionError('PDF reopened')):
            second = PdfTextIndex(self.pdf, cache_dir=self.root).browser()
        context, _ = DiffEngine(self.root).read('<p>Normal</p>', (self.pdf, '1', None))
        self.assertEqual(first, second)
        self.assertIn('Normal', context.ocr)
        self.assertEqual(original, self.pdf.read_bytes())

    def test_pdf_backend_and_reader_import_without_review_scripts(self):
        isolated = self.root / 'standalone'
        isolated.mkdir()
        for name in ('pdf_text_backend.py', 'reader-server.py'):
            shutil.copy2(ROOT / name, isolated / name)
        original = self.pdf.read_bytes()

        def run(name, *args):
            return subprocess.run([sys.executable, '-E', '-B', str(isolated / name), *map(str, args)],
                                  cwd=self.root, capture_output=True, text=True, check=True).stdout

        data = json.loads(run('pdf_text_backend.py', '--pdf', self.pdf, '--browser'))
        self.assertEqual(data['page_count'], 1)
        self.assertEqual(json.loads(browser_path(self.pdf).read_bytes()), data)
        cache = cache_path(self.pdf, self.root)
        self.assertEqual(Path(run('pdf_text_backend.py', '-c', self.config).strip()), cache)
        self.assertEqual(Path(run('pdf_text_backend.py').strip()), cache)
        self.assertIn('--config', run('reader-server.py', '--help'))
        self.assertEqual(original, self.pdf.read_bytes())

    def test_parallel_requests_only_load_saved_data_and_replaced_pdf_invalidates(self):
        generate_pdf_text(self.pdf, self.root)
        original = fitz.open
        with patch('fitz.open', wraps=original) as opening:
            with ThreadPoolExecutor(4) as pool:
                results = list(pool.map(lambda _: load_browser(self.pdf, self.root), range(4)))
            self.assertEqual(opening.call_count, 0)
        self.assertTrue(all(result == results[0] for result in results))
        with fitz.open(self.pdf) as book:
            book[0].insert_text((30, 100), 'Updated')
            book.saveIncr()
        with self.assertRaisesRegex(ValueError, 'Run pdf_text_backend.py'):
            load_browser(self.pdf, self.root)
        generate_pdf_text(self.pdf, self.root)
        updated = load_browser(self.pdf, self.root)
        self.assertIn('Updated', PdfTextIndex(self.pdf, cache_dir=self.root).text)
        self.assertNotEqual(updated['identity'], results[0]['identity'])

    def test_missing_or_corrupt_browser_data_requires_generation(self):
        with patch('fitz.open', side_effect=AssertionError('Request opened PDF')):
            with self.assertRaisesRegex(ValueError, 'Run pdf_text_backend.py'):
                load_browser(self.pdf, self.root)
        generate_pdf_text(self.pdf, self.root)
        target = browser_path(self.pdf, self.root)
        target.write_text('{}', 'utf-8')
        generate_pdf_text(self.pdf, self.root)
        self.assertIn('Normal', PdfTextIndex(self.pdf, cache_dir=self.root).text)
        unchanged = target.stat().st_mtime_ns
        with patch.object(PdfTextIndex, 'browser', side_effect=AssertionError('Browser data rebuilt')):
            generate_pdf_text(self.pdf, self.root)
        self.assertEqual(target.stat().st_mtime_ns, unchanged)

    def test_startup_is_standalone_and_never_extracts(self):
        with patch.object(sys, 'argv', ['reader-server.py', '-c', str(self.config), '-p', '17000']), \
                patch.object(PdfTextIndex, 'extract', side_effect=AssertionError('Reader extracted PDF')), \
                patch.object(backend.uvicorn.Server, 'run') as run, \
                patch('builtins.print'):
            backend.main()
            run.assert_called_once()
        self.assertFalse((self.root / 'OCR_DATA').exists())
        self.start()
        with self.request('/api/reader/config') as response:
            self.assertEqual(json.load(response)['volumes'][0]['pages'], [1])

    def test_browser_offsets_are_utf16_and_canonical_runs_keep_font_indexes(self):
        generate_pdf_text(self.pdf, self.root)
        index = PdfTextIndex(self.pdf, cache_dir=self.root)
        index.text = 'A😀I'
        index.fonts = [dict(name='Italic', italic=True, bold=False)]
        index.pages = [dict(page=1, label='1', start=0, end=3, height=100,
                            parts=[dict(start=2, end=3, fontIndex=0, bbox=[1, 2, 3, 4])])]
        result = index.browser()
        self.assertEqual(result['pages'][0]['end'], 4)
        self.assertEqual(result['pages'][0]['parts'][0]['start'], 3)
        self.assertEqual(result['formatted'][0], dict(start=3, end=4, fontIndex=0, text='<i>I</i>'))
        index.text += '\n'
        page = index.pages[0]
        page['end'] = 4
        page['blocks'] = [dict(start=0, end=4, lines=[dict(start=0, end=4,
            spans=[dict(start=0, end=3, fontIndex=0)])])]
        page['parts'] = page['blocks'][0]['lines'][0]['spans']
        index.save(cache_path(self.pdf, self.root))
        manifest = load_browser(self.pdf, self.root)
        saved = read_json(cache_path(self.pdf, self.root).parent / manifest['pages'][0]['file'])
        self.assertEqual(saved['parsing_res_list'][0]['block_content'], 'A😀I\n')
        self.assertEqual(saved['parsing_res_list'][0]['end'], 4)
        self.assertEqual(saved['comparison']['end'], 5)
        self.assertEqual(saved['comparison']['parts'][0]['end'], 4)
        self.assertEqual(PdfTextIndex(self.pdf, cache_dir=self.root).text, index.text)


    def test_reader_matches_js_config_without_pdf_text_backend(self):
        self.start()
        with self.request('/api/reader/config') as response:
            volume = json.load(response)['volumes'][0]
        self.assertEqual(volume['pdfUrl'], '/api/reader/pdf/1')
        self.assertNotIn('pdfTextUrl', volume)
        self.assertFalse((self.root / 'OCR_DATA').exists())
        for url in ('/OCR_DATA/private.ocr.json', '/api/reader/pdf-text/1'):
            with self.assertRaises(HTTPError) as error:
                self.request(url)
            self.assertEqual(error.exception.code, 404)
            error.exception.close()

    def test_old_cache_rebuilds_and_same_font_at_different_sizes_keeps_its_style(self):
        with fitz.open(self.pdf) as book:
            book[0].insert_text((30, 100), 'Larger', fontname='Times-Roman', fontsize=22)
            book.saveIncr()
        generate_pdf_text(self.pdf, self.root)
        index = PdfTextIndex(self.pdf, cache_dir=self.root)
        target = cache_path(self.pdf, self.root)
        old = json.loads(target.read_bytes())
        old['schema'] = 2
        target.write_text(json.dumps(old), encoding='utf-8')
        original = fitz.open
        with patch('fitz.open', wraps=original) as opening:
            with self.assertRaisesRegex(ValueError, 'Run pdf_text_backend.py'):
                PdfTextIndex(self.pdf, cache_dir=self.root)
            self.assertEqual(opening.call_count, 0)
            generate_pdf_text(self.pdf, self.root)
            rebuilt = PdfTextIndex(self.pdf, cache_dir=self.root).browser()
        self.assertEqual(opening.call_count, 1)
        self.assertEqual(json.loads(target.read_bytes())['schema'], 7)
        styles = {rebuilt['raw'][part['start']:part['end']]: rebuilt['fonts'][part['fontIndex']]
                  for page in rebuilt['pages'] for part in page['parts']}
        self.assertEqual(styles['Normal']['name'], styles['Larger']['name'])
        self.assertEqual(styles['Normal']['size'], 11)
        self.assertEqual(styles['Larger']['size'], 22)
        self.assertEqual(index.browser(), rebuilt)

    def test_plain_json_pages_regenerate_if_missing_and_preserve_large_results(self):
        generate_pdf_text(self.pdf, self.root)
        target = cache_path(self.pdf, self.root)
        manifest = load_browser(self.pdf, self.root)
        page = target.parent / manifest['pages'][0]['file']
        page.unlink()
        with patch.object(PdfTextIndex, 'extract', side_effect=AssertionError('Reader extracted PDF')):
            with self.assertRaisesRegex(ValueError, 'Run pdf_text_backend.py'):
                PdfTextIndex(self.pdf, cache_dir=self.root)
        generate_pdf_text(self.pdf, self.root)
        index = PdfTextIndex(self.pdf, cache_dir=self.root)
        self.assertTrue(page.is_file())
        self.assertEqual(page.suffix, '.json')
        # A serialized page over the former limit must still save losslessly.
        index.text = 'x' * 5_000_001 + '\n'
        end = len(index.text)
        spans = [dict(start=0, end=end - 1, fontIndex=0)]
        index.pages[0].update(start=0, end=end, parts=spans,
            blocks=[dict(start=0, end=end, lines=[dict(start=0, end=end, spans=spans)])])
        index.save(target)
        self.assertGreater(page.stat().st_size, 5_000_000)
        self.assertEqual(json.loads(page.read_text('utf-8'))['comparison']['raw'], index.text)
        self.assertEqual(PdfTextIndex(self.pdf, cache_dir=self.root).browser(), index.browser())
        self.assertEqual([target.parent.name], [p.name for p in target.parent.parent.iterdir()])

    def test_page_links_settings_and_exact_newlines(self):
        self.start()
        source = self.root / 'pages/ME01-001.html'
        source.write_bytes(b'<p>first</p>\r\n<p>second</p>\r\n')
        with self.request('/api/reader/page/1/1') as response:
            page = json.load(response)
        self.assertIn('\r\n', page['text'])
        with self.request('/api/reader/page/1/1', dict(text=page['text'], mtime=page['mtime']), 'PUT') as response:
            self.assertTrue(json.load(response)['ok'])
        self.assertEqual(source.read_bytes(), page['text'].encode())
        with self.request('/api/reader/link/1/1') as response:
            self.assertEqual(json.load(response)['path'], 'pages/ME01-001.html')
        with self.request('/api/reader/locate?path=pages%2FME01-001.html') as response:
            self.assertEqual(json.load(response)['page'], 1)
        with patch.object(backend, 'SETTINGS_FILE', self.root / 'settings.json'):
            with self.request('/api/reader/settings', dict(brightness=120, paper='#123456'), 'PUT') as response:
                self.assertEqual(json.load(response)['brightness'], 120)
            with self.request('/api/reader/settings') as response:
                self.assertEqual(json.load(response)['paper'], '#123456')

    def test_external_changes_publish_existing_event_contract(self):
        self.start()
        with self.request('/api/events') as response:
            self.assertEqual(json.loads(response.readline().decode()[6:])['event'], 'ready')
            response.readline()
            time.sleep(0.6)
            (self.root / 'pages/ME01-001.html').write_text('external change', 'utf-8')
            event = json.loads(response.readline().decode()[6:])
            self.assertEqual(event, dict(event='change', path='pages/ME01-001.html'))


if __name__ == '__main__':
    unittest.main()
