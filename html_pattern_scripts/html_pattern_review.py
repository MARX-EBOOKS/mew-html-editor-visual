"""Local HTML pattern and PDF OCR reviewer."""
import argparse
from collections import OrderedDict
import hashlib
import math
import mimetypes
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import re
from urllib.parse import parse_qs, urlsplit, urlencode
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from pdf_text_backend import CONFIG_NAMES, find_default_config, load_reader_config, local_resource

from review_provider import ReviewContext, ReviewProvider, ReviewGroup
from diff_engine import DiffEngine
from html_patterns import HtmlPatterns
from regex_search import RegexSearch
from ocr_diff import OcrDiff
from ocr_styles import OcrStyles


BASE_DIR = Path(__file__).resolve().parent
DEFAULT_ROOT = next((p / 'MEW_BRIEF' for p in BASE_DIR.parents
                     if (p / 'MEW_BRIEF').is_dir()), BASE_DIR.parent / 'MEW_BRIEF')
DEFAULT_PDF_ROOT = DEFAULT_ROOT.parent / '马恩全集德文'
# Add a provider: import it above, then register its instance here.
PROVIDERS: tuple[ReviewProvider, ...] = (OcrDiff(), HtmlPatterns(), OcrStyles(), RegexSearch())
NAVIGATION_ACTIONS = [
    {'id': 'previous', 'label': '上一条', 'step': -1},
    {'id': 'next', 'label': '下一条', 'step': 1},
]


class Conflict(ValueError):
    pass


def revision(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def read_html(path):
    raw = path.read_bytes()
    charset = re.search(br'charset\s*=\s*[\x22\x27]?\s*([\w-]+)', raw[:8192], re.I)
    encodings = ['utf-8-sig' if raw.startswith(b'\xef\xbb\xbf') else 'utf-8']
    if charset:
        encodings.append(charset[1].decode('ascii'))
    encodings.extend(['cp1252', 'latin-1'])
    for encoding in encodings:
        try:
            return raw.decode(encoding), encoding
        except (UnicodeDecodeError, LookupError):
            continue
    raise ValueError(f'Cannot decode {path.name}')


def scan_for_box(page, box, identity):
    """Read the unique embedded scan covering a page-space rectangle."""
    import fitz
    from PIL import Image
    if box.is_empty or box.is_infinite or not all(math.isfinite(v) for v in box):
        raise ValueError('Crop box must be a finite, nonempty rectangle')
    choices = [i for i in page.get_image_info(xrefs=True) if i['xref'] and fitz.Rect(i['bbox']).contains(box)]
    if len(choices) != 1:
        raise ValueError(f"Patch {identity}: expected one covering embedded scan, got {len(choices)}")
    info = choices[0]
    pix = fitz.Pixmap(page.parent, info['xref'])
    if pix.colorspace.n != 1 and pix.colorspace.n != 3:
        pix = fitz.Pixmap(fitz.csRGB, pix)
    if pix.alpha:
        pix = fitz.Pixmap(pix, 0)
    scan = Image.frombytes('L' if pix.n == 1 else 'RGB', (pix.width, pix.height), pix.samples)
    return scan, info


def crop(doc, entry, padding=10, bbox=None, *, with_geometry=False):
    """Crop a patch or an explicit rectangle in original PDF page coordinates."""
    import fitz
    if padding < 0:
        raise ValueError('padding must be nonnegative')
    box = fitz.Rect(entry['bbox'] if bbox is None else bbox)
    scan, info = scan_for_box(doc[entry['pdf_page'] - 1], box, entry['id'])
    unit = box * ~fitz.Matrix(info['transform'])
    # Matrix inversion can put an exact pixel boundary a few millionths off.
    rect = (max(0, math.floor(round(unit.x0 * info['width'], 4)) - padding),
            max(0, math.floor(round(unit.y0 * info['height'], 4)) - padding),
            min(info['width'], math.ceil(round(unit.x1 * info['width'], 4)) + padding),
            min(info['height'], math.ceil(round(unit.y1 * info['height'], 4)) + padding))
    image = scan.crop(rect).convert('RGB')
    if not with_geometry:
        return image
    target = fitz.Rect(entry.get('highlight', entry['bbox'])) * ~fitz.Matrix(info['transform'])
    left = max(0, min(image.width, target.x0 * info['width'] - rect[0]))
    top = max(0, min(image.height, target.y0 * info['height'] - rect[1]))
    right = max(left, min(image.width, target.x1 * info['width'] - rect[0]))
    bottom = max(top, min(image.height, target.y1 * info['height'] - rect[1]))
    return image, [left, top, right - left, bottom - top]


class Review:
    def __init__(self, root=None, patterns=None, pdf_root=DEFAULT_PDF_ROOT,
                 data_dir=None, providers=None, config_path=None):
        self.config_path = Path(config_path).resolve() if config_path else None
        self.config, self.volumes = {}, None
        if self.config_path:
            self.config, self.volumes = load_reader_config(self.config_path)
            directories = [v['directory'] for v in self.volumes if v['directory'].is_dir()]
            if not directories:
                raise ValueError('Reader config contains no existing local HTML directories')
            root = Path(os.path.commonpath(directories))
        if root is None:
            raise ValueError('Provide a reader config or an HTML directory')
        self.root = Path(root).resolve()
        if not self.root.is_dir():
            raise ValueError(f'HTML directory does not exist: {self.root}')
        selected = list(PROVIDERS if providers is None else providers)
        if patterns is not None:
            selected = [HtmlPatterns(patterns) if p.id == 'patterns' else p for p in selected]
        self.providers = {provider.id: provider for provider in selected}
        if len(self.providers) != len(selected):
            raise ValueError('Provider IDs must be unique')
        if any(action['id'] in {'previous', 'next'} for provider in selected for action in provider.actions):
            raise ValueError('previous and next are reserved backend actions')
        self.pdf_root = Path(pdf_root).resolve()
        self.file_pages = {}
        self.volume_page_cache = {}
        self.data_dir = Path(data_dir) if data_dir else BASE_DIR / 'review_data'
        self.lock = threading.RLock()
        self.cache = OrderedDict()
        self.scan_result = None
        self.scan_key = None
        self.scan_files = {}
        self.diff_engine = DiffEngine(self.config_path.parent if self.config_path else self.data_dir)

    def volume_pages(self, volume):
        directory = volume['directory']
        if not directory.is_dir():
            return []
        key = (directory, volume['pattern'].pattern, tuple(sorted(volume['list'])))
        stamp = directory.stat().st_mtime_ns
        cached = self.volume_page_cache.get(key)
        if cached and cached[0] == stamp:
            return cached[1]
        pages = []
        for path in directory.iterdir():
            match = volume['pattern'].search(path.name)
            if not path.is_file() or path.suffix.lower() not in {'.html', '.htm'} or not match:
                continue
            raw = match.groupdict().get('page') if 'page' in match.groupdict() else match[1]
            try:
                page = int(raw)
            except (TypeError, ValueError):
                continue
            if volume['list'] and page not in volume['list']:
                continue
            pages.append((page, path))
        result = sorted(pages, key=lambda item: (item[0], item[1].name.casefold()))
        self.volume_page_cache[key] = (stamp, result)
        return result

    def configured_location(self, path, *, for_pdf=True):
        locations = []
        for volume in self.volumes:
            if path.parent != volume['directory']:
                continue
            pages = self.volume_pages(volume)
            for i, (page, candidate) in enumerate(pages):
                if candidate == path:
                    duplicates = [p for number, p in pages if number == page]
                    if for_pdf and len(duplicates) > 1:
                        names = ', '.join(p.name for p in duplicates)
                        raise ValueError(f"Ambiguous HTML page {page} in volume {volume['id']}: {names}")
                    label = volume['pageLabel'].replace('{page}', str(page))
                    following = next((number for number, _ in pages[i+1:] if number > page), None)
                    next_label = volume['pageLabel'].replace('{page}', str(following)) if following is not None else None
                    locations.append((volume['pdf'], label, next_label))
        if len(locations) != 1:
            raise ValueError('HTML must belong to exactly one configured volume/page')
        return locations[0]

    def pdf_location(self, relative):
        if self.volumes is not None:
            location = self.configured_location(self.resolve(relative))
            if not location[0].is_file():
                raise FileNotFoundError(f'PDF not found: {location[0]}')
            return location
        name = re.fullmatch(r'ME(\d+)-(\d+)([a-z]?)\.html?', Path(relative).name, re.I)
        if not name:
            raise ValueError('PDF mapping requires an ME16-009.html style filename')
        volume, number, suffix = int(name[1]), int(name[2]), name[3]
        path = self.resolve(relative)
        folder = path.parent
        stamp = folder.stat().st_mtime_ns
        if self.file_pages.get(folder, (None,))[0] != stamp:
            siblings = []
            for sibling in folder.iterdir():
                match = re.fullmatch(r'ME(\d+)-(\d+)([a-z]?)\.html?', sibling.name, re.I)
                if match and sibling.is_file():
                    siblings.append((int(match[1]), int(match[2]), match[3].lower()))
            self.file_pages[folder] = (stamp, sorted(set(siblings)))
        later = [entry for entry in self.file_pages[folder][1]
                 if entry[0] == volume and (entry[1], entry[2]) > (number, suffix.lower())]
        next_label = str(later[0][1]) + later[0][2] if later else None
        pdf = self.pdf_root / f'mew_band{volume:02}.pdf'
        if not pdf.is_file():
            raise FileNotFoundError(f'PDF not found: {pdf}')
        return pdf, str(number) + suffix.lower(), next_label

    def provider(self, purpose, options=None):
        if ',' in purpose:
            identities = list(dict.fromkeys(purpose.split(',')))
            return ReviewGroup([self.provider(identity, options) for identity in identities])
        if purpose not in self.providers:
            raise ValueError(f'Unknown review purpose: {purpose}')
        provider = self.providers[purpose]
        return provider.configured(options or {}) if getattr(provider, 'configurable', False) else provider

    def ocr_document(self, relative):
        """Compatibility entry point for the text diff provider."""
        return self.review_document(relative, 'ocr')

    def review_document(self, relative, purpose='patterns', options=None):
        provider = self.provider(purpose, options)
        with self.lock:
            if isinstance(provider, ReviewGroup):
                documents = [self.review_document(relative, p.id, options) for p in provider.providers]
                if len({d['version'] for d in documents}) != 1:
                    raise Conflict('HTML changed while comparing; reload')
                document = dict(documents[0])
                matches, actions = [], []
                for p, part in zip(provider.providers, documents):
                    actions.extend({**a, 'id': f'{p.id}:{a["id"]}'} for a in part['actions'])
                    for index, hit in enumerate(part['matches']):
                        matches.append({**hit, 'id': f'{p.id}:{hit.get("id", index)}',
                                        'purpose': p.id, 'original_id': hit.get('id'),
                                        'pattern': f'{p.id}:{hit["pattern"]}',
                                        'kind': f'{p.id}:{hit["kind"]}' if hit.get('kind') else None,
                                        'choices': [f'{p.id}:{a["id"]}' for a in part['actions']
                                                    if a['id'] in hit.get('choices', [a['id'] for a in part['actions']])],
                                        'alignment': part.get('alignment')})
                    if 'pdf' in part:
                        document.update(pdf=part['pdf'], pages=part['pages'])
                matches.sort(key=lambda hit: (hit['start'], hit['end'], hit['pattern']))
                document.pop('alignment', None)
                document.update(matches=matches, purpose=purpose, kinds=provider.kinds, actions=actions,
                                configurableActions=[f'{p.id}:{a["id"]}' for p in provider.providers
                                                     if getattr(p, 'configurable', False) for a in p.actions],
                                navigation=NAVIGATION_ACTIONS if provider.reviewable else [])
                return self.remember_scanned_document(document, purpose, options)
            document = self.source_document(relative)
            relative = document['path']
            key = (relative, document['version'], purpose, json.dumps(options or {}, sort_keys=True))
            pdf_info = None
            if provider.requires_pdf:
                pdf_info = self.pdf_location(relative)
                stat = pdf_info[0].stat()
                key += (str(pdf_info[0]), stat.st_mtime_ns, stat.st_size, pdf_info[2])
            if key in self.cache:
                self.cache.move_to_end(key)
                return self.remember_scanned_document(self.cache[key], purpose, options)
            context = ReviewContext(document['source'])
            if pdf_info:
                context, pages = self.read_pdf_context(document['source'], pdf_info)
                document.update(pdf=str(pdf_info[0]), pages=pages)
            result = provider.compare(context)
            matches = result['matches']
            document.update(result, purpose=purpose, kinds=provider.kinds, actions=provider.actions,
                            configurableActions=[a['id'] for a in provider.actions]
                                                if getattr(provider, 'configurable', False) else [],
                            navigation=NAVIGATION_ACTIONS if provider.reviewable else [])
            journal = self.journal_path(relative)
            if journal.is_file():
                saved = json.loads(journal.read_text('utf-8'))
                decisions = {entry['id']: entry for entry in saved
                             if not entry.get('edits') and entry.get('purpose', 'ocr') == purpose}
                for hit in matches:
                    entry = decisions.get(hit.get('id'))
                    if entry:
                        hit['decision'] = entry['choice']
            self.cache[key] = document
            while len(self.cache) > 24:
                self.cache.popitem(last=False)
            return self.remember_scanned_document(document, purpose, options)

    def remember_scanned_document(self, document, purpose, options):
        if self.scan_key == (purpose, json.dumps(options or {}, sort_keys=True)):
            file = self.scan_files.get(document['path'])
            if file is not None:
                file.update(matches=document['matches'], version=document['version'],
                            counts={p['id']: sum(h['pattern'] == p['id'] for h in document['matches'])
                                    for p in self.scan_result['patterns']})
                file.pop('error', None)
        return document

    def read_pdf_context(self, source, location):
        """Use one shared PDF index and alignment context for all providers."""
        return self.diff_engine.read(source, location)

    def journal_path(self, relative):
        return self.data_dir / (hashlib.sha256(str(self.resolve(relative)).encode()).hexdigest() + '.json')

    def page_images(self, relative, version):
        """List embedded scans for every page owned by this HTML, independent of hits."""
        import fitz
        with self.lock:
            document = self.source_document(relative)
            if document['version'] != version:
                raise Conflict('HTML changed; reload the document')
            location = self.pdf_location(relative)
            _, pages = self.read_pdf_context(document['source'], location)
            stat = location[0].stat()
            stamp = f'{stat.st_mtime_ns}:{stat.st_size}'
            result = []
            with fitz.open(location[0]) as pdf:
                for page in pages:
                    images, seen = [], set()
                    for info in sorted(pdf[page['page'] - 1].get_image_info(xrefs=True),
                                       key=lambda info: (info['bbox'][1], info['bbox'][0])):
                        xref = info['xref']
                        if not xref or xref in seen:
                            continue
                        seen.add(xref)
                        images.append({'src': '/api/crop?' + urlencode({'path': relative,
                                       'index': page['page'], 'id': xref, 'version': stamp}),
                                       'width': info['width'], 'height': info['height']})
                    result.append({**page, 'images': images})
            latest = location[0].stat()
            if (latest.st_mtime_ns, latest.st_size) != (stat.st_mtime_ns, stat.st_size):
                raise Conflict('PDF changed; reload the document')
            return result

    def image(self, relative, version, identity, index, purpose='ocr', *, with_geometry=False):
        import fitz
        with self.lock:
            pdf_path = self.pdf_location(relative)[0]
            stat = pdf_path.stat()
            stamp = f'{stat.st_mtime_ns}:{stat.st_size}'
            if with_geometry:
                document = self.review_document(relative, purpose)
                if document['version'] != version:
                    raise Conflict('HTML changed; reload the document')
                hit = next((h for h in document['matches'] if h['id'] == identity), None)
                if hit is None or index < 0 or index >= len(hit['crops']):
                    raise ValueError('Unknown crop')
                entry = hit['crops'][index]
            elif stamp != version:
                raise Conflict('PDF changed; reload the document')
            with fitz.open(pdf_path) as pdf:
                if with_geometry:
                    box = fitz.Rect(entry['bbox'])
                    choices = [info for info in pdf[entry['page'] - 1].get_image_info(xrefs=True)
                               if info['xref'] and fitz.Rect(info['bbox']).contains(box)]
                    if len(choices) != 1:
                        raise ValueError('Expected one covering embedded scan')
                    info = choices[0]
                    target = fitz.Rect(entry.get('highlight', entry['bbox'])) * ~fitz.Matrix(info['transform'])
                    left, top = target.x0 * info['width'], target.y0 * info['height']
                    return {'image': '/api/crop?' + urlencode({'path': relative, 'index': entry['page'],
                            'id': info['xref'], 'version': stamp}),
                            'width': info['width'], 'height': info['height'],
                            'highlight': [left, top, target.width * info['width'], target.height * info['height']],
                            'anchor': hit.get('kind') == 'delete'}
                xref = int(identity)
                if not 1 <= index <= len(pdf) or xref not in {i['xref'] for i in pdf[index - 1].get_image_info(xrefs=True)}:
                    raise ValueError('Unknown page scan')
                scan = pdf.extract_image(xref)
                if scan['ext'] in {'png', 'jpeg', 'jpg', 'webp'}:
                    return scan['image'], 'image/' + scan['ext']
                pix = fitz.Pixmap(pdf, xref)
                if pix.colorspace.n not in {1, 3}:
                    pix = fitz.Pixmap(fitz.csRGB, pix)
                return pix.tobytes('png'), 'image/png'

    def decide(self, payload, *, preview=False):
        with self.lock:
            relative, choice = payload['path'], payload['choice']
            purpose = payload.get('purpose', 'ocr')
            options = payload.get('options') or {}
            provider = self.provider(purpose, options)
            document = self.review_document(relative, purpose, options)
            if payload['version'] != document['version']:
                raise Conflict('HTML changed; reload before saving')
            hit = next((h for h in document['matches'] if h['id'] == payload['id']), None)
            if not hit:
                raise Conflict('Difference no longer exists; reload')
            navigation = next((a for a in document['navigation'] if a['id'] == choice), None)
            if navigation:
                return {**document, 'decisionResult': {'step': navigation['step']}}
            if isinstance(provider, ReviewGroup):
                prefix = hit['purpose'] + ':'
                if not choice.startswith(prefix) or choice not in hit['choices']:
                    raise ValueError('Unsupported choice for this candidate')
                result = self.decide({**payload, 'purpose': hit['purpose'], 'id': hit['original_id'],
                                      'choice': choice[len(prefix):]}, preview=preview)
                if preview:
                    return result
                return {**self.review_document(relative, purpose, options),
                        'decisionResult': result['decisionResult']}
            if choice not in {a['id'] for a in document['actions']} or choice not in hit.get('choices', [a['id'] for a in document['actions']]):
                raise ValueError('This candidate requires manual review; unsupported choice')
            source = document['source']
            result = provider.decide(ReviewContext(source), hit, choice, payload.get('text'))
            replacement, edits = result['text'], result['edits']
            previous = 0
            for a, b, text in edits:
                if not (previous <= a <= b <= len(source)) or not isinstance(text, str):
                    raise ValueError('Invalid or overlapping provider edits')
                previous = b
            pieces, previous = [], 0
            for a, b, text in edits:
                pieces.extend((source[previous:a], text))
                previous = b
            pieces.append(source[previous:])
            source = ''.join(pieces)
            if preview:
                # Use the exact provider edits used by saving; preview never writes.
                return {'source': source, 'version': document['version']}
            path = self.resolve(relative)
            original = path.read_bytes()
            if hashlib.sha256(original).hexdigest() != payload['version']:
                raise Conflict('HTML changed during save; reload')
            # Encode before touching disk; unrepresentable input leaves the original intact.
            encoded = source.encode(document['encoding'])
            journal = self.journal_path(relative)
            journal.parent.mkdir(parents=True, exist_ok=True)
            entries = json.loads(journal.read_text('utf-8')) if journal.is_file() else []
            entries.append({'id': hit['id'], 'version': document['version'], 'choice': choice,
                            'path': relative, 'purpose': purpose, 'pattern': hit['pattern'],
                            'old': hit['text'], 'new': replacement, 'edits': edits})
            if edits:
                # First original is a recoverable byte-for-byte backup, outside the HTML tree.
                backup = journal.with_suffix('.original')
                if not backup.exists():
                    backup.write_bytes(original)
                temporary = path.with_suffix(path.suffix + '.review-tmp')
                try:
                    temporary.write_bytes(encoded)
                    if revision(path) != payload['version']:
                        raise Conflict('HTML changed during save; reload')
                    os.replace(temporary, path)
                finally:
                    temporary.unlink(missing_ok=True)
            journal_tmp = journal.with_suffix('.tmp')
            journal_tmp.write_text(json.dumps(entries, ensure_ascii=False, indent=2), 'utf-8')
            os.replace(journal_tmp, journal)
            if edits:
                self.cache.clear()
            else:
                hit['decision'] = choice
            return {**self.review_document(relative, purpose, options),
                    'decisionResult': {'message': result.get('message', '已保存。'),
                                       'advance': result.get('advance', False), 'step': result.get('step', 0)}}

    def resolve(self, relative):
        path = (self.root / relative).resolve()
        if not path.is_relative_to(self.root) or path.suffix.lower() not in {'.html', '.htm'}:
            raise ValueError('Path must be an HTML file inside the configured directory')
        if not path.is_file():
            raise FileNotFoundError(relative)
        if self.volumes is not None:
            self.configured_location(path, for_pdf=False)
        return path

    def source_document(self, relative):
        path = self.resolve(relative)
        version = revision(path)
        source, encoding = read_html(path)
        if revision(path) != version:
            raise Conflict('HTML changed while reading; reload')
        return {'path': path.relative_to(self.root).as_posix(), 'source': source,
                'encoding': encoding, 'version': version}

    def document(self, relative):
        """Compatibility entry point for HTML pattern search."""
        return self.review_document(relative, 'patterns')

    def scan(self, purpose='patterns', options=None, *, reuse=False):
        key = (purpose, json.dumps(options or {}, sort_keys=True))
        if reuse and self.scan_key == key and self.scan_result is not None:
            return {**self.scan_result, 'restored': True}
        provider = self.provider(purpose, options)
        files = []
        candidates = (self.root.rglob('*') if self.volumes is None else
                      {p for v in self.volumes for _, p in self.volume_pages(v)})
        for path in sorted(candidates, key=lambda path: path.as_posix().casefold()):
            if not path.is_file() or path.suffix.lower() not in {'.html', '.htm'}:
                continue
            relative = path.relative_to(self.root).as_posix()
            try:
                if provider.requires_pdf:
                    files.append({'path': relative, 'counts': {p['id']: None for p in provider.patterns},
                                  'version': revision(path)})
                    continue
                document = self.review_document(relative, purpose, options)
                counts = {pattern['id']: 0 for pattern in provider.patterns}
                for match in document['matches']:
                    counts[match['pattern']] += 1
                files.append({'path': relative, 'counts': counts, 'version': document['version'], 'matches': document['matches']})
            except (OSError, ValueError) as error:
                files.append({'path': relative, 'counts': {}, 'error': str(error)})
        self.scan_result = {'root': str(self.root), 'pdfRoot': str(self.pdf_root) if self.volumes is None else None,
                'configPath': str(self.config_path) if self.config_path else None, 'title': self.config.get('title', 'HTML 审阅'),
                'patterns': provider.patterns, 'files': files, 'purpose': purpose,
                'configurable': getattr(provider, 'configurable', False),
                'kinds': provider.kinds, 'requiresPdf': provider.requires_pdf, 'reviewable': provider.reviewable,
                'purposes': [{'id': p.id, 'label': p.label} for p in self.providers.values()]}
        self.scan_key = key
        self.scan_files = {file['path']: file for file in files}
        return self.scan_result



def make_handler(review):
    class Handler(BaseHTTPRequestHandler):
        def send_content(self, status, body, content_type, preview=False, cache=False):
            content = body if isinstance(body, bytes) else body.encode('utf-8')
            self.send_response(status)
            self.send_header('Content-Type', content_type + ('; charset=utf-8' if not isinstance(body, bytes) else ''))
            self.send_header('Content-Length', str(len(content)))
            self.send_header('Cache-Control', 'private, max-age=86400' if cache else 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.send_header('Content-Security-Policy',
                             "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:"
                             if preview else "default-src 'self'; script-src 'self' 'unsafe-eval'; "
                             "style-src 'self' 'unsafe-inline'; worker-src 'self' blob:; "
                             "font-src 'self' data:; img-src 'self' data:; frame-src 'self'; object-src 'none'; "
                             "base-uri 'none'; frame-ancestors 'none'")
            self.end_headers()
            try:
                self.wfile.write(content)
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                pass  # Switching files may cancel an in-flight preview or crop.

        def do_GET(self):
            request = urlsplit(self.path)
            query = parse_qs(request.query, keep_blank_values=True)
            try:
                if request.path == '/api/providers':
                    self.send_content(200, json.dumps([{'id': p.id, 'label': p.label}
                                                      for p in review.providers.values()], ensure_ascii=False), 'application/json')
                elif request.path == '/api/files':
                    with review.lock:
                        listing = review.scan(query.get('purpose', ['patterns'])[0],
                                              json.loads(query.get('options', ['{}'])[0]),
                                              reuse=query.get('reuse', ['0'])[0] == '1')
                        content = json.dumps(listing, ensure_ascii=False)
                    self.send_content(200, content, 'application/json')
                elif request.path == '/api/pages':
                    content = review.page_images(query['path'][0], query['version'][0])
                    self.send_content(200, json.dumps(content, ensure_ascii=False), 'application/json')
                elif request.path == '/api/crop':
                    geometry = query.get('geometry', ['0'])[0] == '1'
                    content = review.image(query['path'][0], query['version'][0], query['id'][0], int(query['index'][0]),
                                           query.get('purpose', ['ocr'])[0], with_geometry=geometry)
                    self.send_content(200, json.dumps(content) if geometry else content[0],
                                      'application/json' if geometry else content[1], cache=not geometry)
                elif request.path in {'/api/document', '/api/preview'}:
                    relative = query.get('path', [''])[0]
                    document = (review.source_document(relative) if request.path == '/api/preview' else
                                review.review_document(relative, query.get('purpose', ['patterns'])[0], json.loads(query.get('options', ['{}'])[0])))
                    if request.path == '/api/preview':
                        self.send_content(200, document['source'], 'text/html', preview=True)
                    else:
                        self.send_content(200, json.dumps(document, ensure_ascii=False), 'application/json')
                elif request.path.startswith('/monaco/'):
                    root = (BASE_DIR.parent / 'node_modules' / 'monaco-editor' / 'min' / 'vs').resolve()
                    asset = (root / request.path.removeprefix('/monaco/')).resolve()
                    if not asset.is_relative_to(root) or not asset.is_file():
                        raise FileNotFoundError('Monaco asset not found; run npm install in the project directory')
                    kind = mimetypes.guess_type(asset.name)[0] or 'application/octet-stream'
                    if asset.suffix == '.js':
                        kind = 'text/javascript'
                    self.send_content(200, asset.read_bytes(), kind)
                elif request.path in {'/', '/app.js', '/style.css'}:
                    filename, kind = {'/': ('index.html', 'text/html'),
                                      '/app.js': ('app.js', 'text/javascript'),
                                      '/style.css': ('style.css', 'text/css')}[request.path]
                    self.send_content(200, (BASE_DIR.parent / 'html_pattern_review' / filename).read_text('utf-8'), kind)
                else:
                    self.send_content(404, json.dumps({'error': 'Not found'}), 'application/json')
            except (ValueError, OSError, KeyError, ImportError, RuntimeError) as error:
                self.send_content(409 if isinstance(error, Conflict) else 404 if isinstance(error, FileNotFoundError) else 400,
                                  json.dumps({'error': str(error)}), 'application/json')

        def do_POST(self):
            try:
                if self.path not in {'/api/decision', '/api/proposal'}:
                    raise ValueError('Unknown endpoint')
                origin = self.headers.get('Origin')
                expected = {f'http://{host}:{self.server.server_port}' for host in ('127.0.0.1', 'localhost')}
                if origin and origin not in expected:
                    raise ValueError('Cross-origin saves are not allowed')
                if self.headers.get('Content-Type', '').split(';')[0] != 'application/json':
                    raise ValueError('Expected application/json')
                length = int(self.headers.get('Content-Length', '0'))
                if not 0 < length <= 1000000:
                    raise ValueError('Invalid request size')
                payload = json.loads(self.rfile.read(length))
                result = review.decide(payload, preview=self.path == '/api/proposal')
                self.send_content(200, json.dumps(result, ensure_ascii=False), 'application/json')
            except (ValueError, OSError, KeyError, TypeError, ImportError, RuntimeError) as error:
                self.send_content(409 if isinstance(error, Conflict) else 400,
                                  json.dumps({'error': str(error)}), 'application/json')

    return Handler


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('-c', '--config', type=Path, help='reader-server compatible library JSON')
    parser.add_argument('--root', type=Path, help='Legacy manual HTML directory (without JSON)')
    parser.add_argument('-p', '--port', type=int, default=int(os.environ.get('PORT', '8765')))
    parser.add_argument('--pdf-root', type=Path, default=DEFAULT_PDF_ROOT)
    parser.add_argument('--data-dir', type=Path, help='Decision journals and original HTML backups')
    args = parser.parse_args()
    try:
        if args.root and args.config:
            raise ValueError('--root and --config cannot be combined')
        config_path = None if args.root else find_default_config(args.config)
        review = Review(args.root, pdf_root=args.pdf_root, data_dir=args.data_dir, config_path=config_path)
    except (ValueError, OSError, re.error) as error:
        parser.error(str(error))
    with ThreadingHTTPServer(('127.0.0.1', args.port), make_handler(review)) as server:
        print(f'HTML reviewer: http://127.0.0.1:{server.server_port}', flush=True)
        print(f'HTML directory: {review.root}', flush=True)
        if review.config_path:
            print(f'Reader config: {review.config_path}', flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == '__main__':
    main()
