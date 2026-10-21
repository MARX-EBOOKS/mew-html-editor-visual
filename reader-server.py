"""Python reader backend, preserving reader-server.js HTTP and CLI contracts."""
import argparse
import json
import math
import mimetypes
import os
from pathlib import Path
import queue
import re
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, quote, unquote, urlsplit
from urllib.request import urlopen, url2pathname

HERE = Path(__file__).resolve().parent
from pdf_text_backend import browser_path, find_default_config, load_browser

SETTINGS_FILE = HERE / 'reader.settings.json'
MIME = {'.gz': 'application/gzip', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
        '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
        '.css': 'text/css; charset=utf-8', '.wasm': 'application/wasm'}


def inside(candidate, root):
    return candidate.resolve().is_relative_to(root.resolve())


def resource(raw, base):
    value = str(raw or '.')
    parsed = urlsplit(value)
    if parsed.scheme in ('http', 'https'):
        return dict(kind='url', path=value.rstrip('/'))
    if parsed.scheme == 'file':
        value = ('//' + parsed.netloc if parsed.netloc else '') + url2pathname(parsed.path)
    return dict(kind='file', path=(base / value).resolve())


def settings(value=None):
    value = value or {}
    def color(name, fallback):
        item = str(value.get(name, ''))
        return item.lower() if re.fullmatch(r'#[0-9a-fA-F]{6}', item) else fallback
    try:
        brightness = float(value.get('brightness') or 100)
        if not math.isfinite(brightness):
            brightness = 100
    except (ValueError, TypeError):
        brightness = 100
    scale = value.get('scale')
    return dict(brightness=max(50, min(160, brightness)), paper=color('paper', '#ffffff'),
                ink=color('ink', '#000000'), invert=bool(value.get('invert')),
                horizontal=bool(value.get('horizontal')),
                scale=scale if isinstance(scale, str) and len(scale) <= 32 else 'page-width',
                diffHighlight=value.get('diffHighlight') is not False,
                selectionHighlight=value.get('selectionHighlight') is not False)


def load_settings():
    try:
        return settings(json.loads(SETTINGS_FILE.read_text('utf-8')))
    except (OSError, ValueError):
        return settings()


def finite(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def read_text(file):
    with file.open('r', encoding='utf-8', newline='') as source:
        return source.read()


def mtime(file):
    return file.stat().st_mtime_ns / 1_000_000


class Library:
    def __init__(self, config_file):
        self.config_file = config_file.resolve()
        self.config = json.loads(config_file.read_text('utf-8-sig'))
        base, config = config_file.parent, self.config
        self.volumes = []
        for index, volume in enumerate(config.get('volumes') or [config]):
            pages = volume.get('pages', {})
            options = pages if isinstance(pages, dict) else {}
            identity = str(volume.get('id', config.get('id', index + 1)))
            pattern = options.get('pattern', volume.get('pagePattern', config.get('pagePattern')))
            pdf = volume.get('pdf', config.get('pdf'))
            if isinstance(pdf, dict):
                pdf = pdf.get('file')
            if not pattern or not pdf:
                raise ValueError(f'Volume {identity} requires pages.pattern/pagePattern and pdf')
            pattern = re.sub(r'\(\?<([A-Za-z_]\w*)>', r'(?P<\1>', pattern)
            explicit = options.get('list', pages if isinstance(pages, list) else [])
            item = dict(id=identity, title=str(volume.get('title', config.get('title', f'PDF {identity}'))),
                        shortTitle=str(volume.get('shortTitle', volume.get('title', config.get('shortTitle', config.get('title', identity))))),
                        pageLabel=str(volume.get('pageLabel', config.get('pageLabel', '{page}'))),
                        toc=volume.get('toc') if isinstance(volume.get('toc'), list) else [],
                        pattern=re.compile(pattern, re.I), explicitPages={int(p) for p in explicit},
                        pageDir=resource(options.get('directory', volume.get('htmlRoot', config.get('htmlRoot', '.'))), base),
                        pdf=resource(pdf, base))
            self.scan(item)
            if item['pages']:
                self.volumes.append(item)
        editor = resource(config.get('editorRoot', '.'), base)
        self.editor_root = editor['path'] if editor['kind'] == 'file' and editor['path'].exists() else None
        self.browser_files = {browser_path(v['pdf']['path'], self.config_file.parent).parent.name:
                              browser_path(v['pdf']['path'], self.config_file.parent)
                              for v in self.volumes if v['pdf']['kind'] == 'file'}
        self.clients, self.clients_lock = set(), threading.Lock()

    def scan(self, volume):
        directory, files = volume['pageDir'], {}
        if directory['kind'] == 'file' and directory['path'].is_dir():
            for entry in directory['path'].iterdir():
                match = volume['pattern'].search(entry.name)
                if entry.is_dir() or not match:
                    continue
                try:
                    page = int(match.groupdict().get('page') or match.group(1))
                except (ValueError, IndexError):
                    continue
                if not volume['explicitPages'] or page in volume['explicitPages']:
                    files[page] = entry.name
        elif directory['kind'] == 'url':
            files = dict.fromkeys(volume['explicitPages'])
        volume['pageFiles'], volume['pages'] = files, sorted(files)

    def volume(self, identity):
        return next(v for v in self.volumes if v['id'] == identity)

    def location(self, volume, page):
        if page not in volume['pages'] or not volume['pageFiles'][page]:
            raise ValueError(f'Page {page} has no corresponding file')
        directory, name = volume['pageDir'], volume['pageFiles'][page]
        return directory['path'] / name if directory['kind'] == 'file' else directory['path'] + '/' + name

    def editor_path(self, volume, page):
        if self.editor_root and volume['pageDir']['kind'] == 'file':
            location = self.location(volume, page)
            if inside(location, self.editor_root):
                return location.relative_to(self.editor_root).as_posix()
        return None

    def editor_target(self, relative=''):
        if not self.editor_root:
            raise ValueError('No local editor root configured')
        full = (self.editor_root / relative.lstrip('/\\')).resolve()
        if not inside(full, self.editor_root):
            raise ValueError(f'Path outside root: {self.editor_root}')
        relative = full.relative_to(self.editor_root).as_posix()
        return full, '' if relative == '.' else relative

    def publish(self, event, path):
        with self.clients_lock:
            for client in self.clients:
                client.put(dict(event=event, path=path))

    def watch(self, stop):
        # Native fs.watch is replaced by one shared poller, including external HTML edits.
        previous = None
        while not stop.wait(0.3):
            current = {}
            roots = {self.editor_root} if self.editor_root else set()
            roots.update(v['pageDir']['path'] for v in self.volumes if v['pageDir']['kind'] == 'file'
                         and (not self.editor_root or not inside(v['pageDir']['path'], self.editor_root)))
            for root in roots:
                try:
                    entries = root.rglob('*') if root == self.editor_root else root.iterdir()
                    for file in entries:
                        if file.is_file() and 'OCR_DATA' not in file.parts:
                            stat = file.stat()
                            relative = file.relative_to(self.editor_root).as_posix() if self.editor_root and inside(file, self.editor_root) else ''
                            current[str(file)] = (stat.st_mtime_ns, stat.st_size, relative)
                except OSError:
                    continue
            if previous is not None:
                for name in current.keys() | previous.keys():
                    if current.get(name) != previous.get(name):
                        self.publish('rename' if name not in current or name not in previous else 'change',
                                     (current.get(name) or previous[name])[2])
            previous = current


def handler(library, legacy=False):
    public = HERE / ('public_legacy' if legacy else 'public')
    monaco = HERE / 'monaco' if (HERE / 'monaco/min/vs/loader.js').exists() else HERE / 'node_modules/monaco-editor'

    class Handler(BaseHTTPRequestHandler):
        protocol_version = 'HTTP/1.1'

        def handle(self):
            try:
                super().handle()
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                self.close_connection = True

        def reply(self, status, value, content_type='application/json; charset=utf-8'):
            if not isinstance(value, (bytes, str)):
                value = json.dumps(value, ensure_ascii=False)
            body = value.encode('utf-8') if isinstance(value, str) else value
            self.send_response(status)
            self.send_header('Content-Type', content_type)
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            if self.command != 'HEAD':
                self.wfile.write(body)

        def body(self):
            return json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0))) or b'{}')

        def file(self, file, ranges=False):
            size = file.stat().st_size
            compressed_json = file.name.endswith('.json.gz')
            content_type = 'application/json; charset=utf-8' if compressed_json else MIME.get(file.suffix.lower(), mimetypes.guess_type(file.name)[0] or 'application/octet-stream')
            match = re.fullmatch(r'bytes=(\d*)-(\d*)', self.headers.get('Range', '')) if ranges else None
            start, end = 0, size - 1
            if match:
                a, b = match.groups()
                if not a and b:
                    start = max(0, size - int(b))
                else:
                    start, end = int(a or 0), min(int(b) if b else end, end)
                if start > end or start >= size:
                    self.send_response(416)
                    self.send_header('Content-Range', f'bytes */{size}')
                    self.send_header('Content-Length', '0')
                    self.end_headers()
                    return
            self.send_response(206 if match else 200)
            self.send_header('Content-Type', content_type)
            if compressed_json:
                self.send_header('Content-Encoding', 'gzip')
            self.send_header('Content-Length', str(max(0, end - start + 1)))
            self.send_header('Cache-Control', 'no-store')
            if ranges:
                self.send_header('Accept-Ranges', 'bytes')
            if match:
                self.send_header('Content-Range', f'bytes {start}-{end}/{size}')
            self.end_headers()
            if self.command != 'HEAD':
                with file.open('rb') as stream:
                    stream.seek(start)
                    left = end - start + 1
                    while left > 0:
                        block = stream.read(min(left, 256 * 1024))
                        if not block:
                            break
                        self.wfile.write(block)
                        left -= len(block)

        def css(self):
            try:
                return (library.editor_root / 'mewde.css').read_text('utf-8')
            except (OSError, TypeError):
                return 'body { background: #fff; color: #1d2430; font-family: serif; line-height: 1.5; }\n'

        def events(self):
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream; charset=utf-8')
            self.send_header('Cache-Control', 'no-cache')
            self.send_header('Connection', 'keep-alive')
            self.end_headers()
            client = queue.Queue()
            with library.clients_lock:
                library.clients.add(client)
            try:
                self.wfile.write(b'data: {"event":"ready","path":""}\n\n')
                self.wfile.flush()
                while True:
                    try:
                        message = 'data: ' + json.dumps(client.get(timeout=25), ensure_ascii=False) + '\n\n'
                    except queue.Empty:
                        message = ': keep-alive\n\n'
                    self.wfile.write(message.encode('utf-8'))
                    self.wfile.flush()
            finally:
                with library.clients_lock:
                    library.clients.discard(client)

        def dispatch(self):
            url = urlsplit(self.path)
            path = url.path
            params = parse_qs(url.query, keep_blank_values=True)
            param = lambda name, fallback='': params.get(name, [fallback])[0]
            parts = [unquote(p) for p in path.split('/') if p]
            method = self.command
            if path.startswith('/OCR_DATA/') and method in ('GET', 'HEAD'):
                # Only configured PDF directories and known page-result filenames are public.
                manifest = library.browser_files.get(parts[1]) if len(parts) == 3 else None
                name = parts[2] if len(parts) == 3 else ''
                file = manifest.parent / name if manifest and (name == manifest.name or re.fullmatch(r'page-\d{5}\.json(?:\.gz)?', name)) else None
                if file is None or not file.is_file():
                    return self.reply(404, 'PDF text JSON not found', 'text/plain')
                return self.file(file)
            if path == '/api/reader/config':
                volumes = []
                for volume in library.volumes:
                    library.scan(volume)
                    volumes.append({**{k: volume[k] for k in ('id', 'title', 'shortTitle', 'pages', 'toc', 'pageLabel')},
                        'pdfUrl': volume['pdf']['path'] if volume['pdf']['kind'] == 'url' else '/api/reader/pdf/' + volume['id'],
                        'pdfTextUrl': '/OCR_DATA/' + quote(browser_path(volume['pdf']['path'], library.config_file.parent).parent.name) + '/manifest.json'
                            if volume['pdf']['kind'] == 'file' else None})
                return self.reply(200, dict(title=library.config.get('title', '阅读器'), configPath=str(library.config_file),
                    editorRoot=str(library.editor_root) if library.editor_root else None,
                    editorAvailable=bool(library.editor_root), volumes=volumes))
            if path == '/api/reader/settings':
                if method == 'GET':
                    return self.reply(200, load_settings())
                if method == 'PUT':
                    value = settings({**load_settings(), **self.body()})
                    SETTINGS_FILE.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', 'utf-8')
                    return self.reply(200, value)
                return self.reply(405, dict(error='Only GET or PUT supported'))
            if path == '/api/reader/locate':
                _, relative = library.editor_target(param('path'))
                for volume in library.volumes:
                    for page in volume['pages']:
                        target = library.editor_path(volume, page)
                        if target and target.lower() == relative.lower():
                            return self.reply(200, dict(volume=volume['id'], page=page, path=target))
                return self.reply(404, dict(error='File is not in the reader configuration'))
            if path.startswith('/api/reader/') and len(parts) >= 4:
                kind, volume = parts[2], library.volume(parts[3])
                if kind == 'pdf':
                    if volume['pdf']['kind'] != 'file' or not volume['pdf']['path'].is_file():
                        return self.reply(404, 'PDF not found', 'text/plain')
                    return self.file(volume['pdf']['path'], ranges=True)
                if kind == 'resource':
                    directory = volume['pageDir']
                    if directory['kind'] != 'file':
                        return self.reply(404, 'Not found', 'text/plain')
                    file = (directory['path'] / '/'.join(parts[4:])).resolve()
                    if not inside(file, directory['path']):
                        return self.reply(403, 'Forbidden', 'text/plain')
                    return self.file(file)
                if kind in ('page', 'link') and len(parts) >= 5:
                    page = int(parts[4])
                    file = library.location(volume, page)
                    target = library.editor_path(volume, page)
                    if kind == 'link':
                        return self.reply(200, dict(volume=volume['id'], page=page, path=target)) if target else self.reply(404, dict(error='Page outside editor root'))
                    if method == 'GET':
                        local = volume['pageDir']['kind'] == 'file'
                        if local:
                            text = read_text(file)
                        else:
                            with urlopen(file) as response:
                                text = response.read().decode('utf-8')
                        return self.reply(200, dict(volume=volume['id'], page=page, path=target, text=text,
                                                   mtime=mtime(file) if local else None, editable=local))
                    if method == 'PUT':
                        if volume['pageDir']['kind'] != 'file':
                            return self.reply(403, dict(error='Remote page is read-only'))
                        data = self.body()
                        if finite(data.get('mtime')) and abs(mtime(file) - data['mtime']) > 1:
                            return self.reply(409, dict(error='File changed on disk. Reload before saving.'))
                        file.write_text(str(data.get('text') or ''), encoding='utf-8', newline='')
                        return self.reply(200, dict(ok=True, mtime=mtime(file)))
            if path == '/api/events' and method == 'GET':
                return self.events()
            if path == '/api/tree':
                directory, _ = library.editor_target(param('path'))
                natural = lambda name: tuple((1, int(p)) if p.isdigit() else (0, p.lower()) for p in re.split(r'(\d+)', name))
                entries = sorted((f for f in directory.iterdir() if not f.name.startswith('.')),
                                 key=lambda f: (not f.is_dir(), natural(f.name)))
                return self.reply(200, dict(root=str(library.editor_root), entries=[dict(name=f.name,
                    path=f.relative_to(library.editor_root).as_posix(), type='dir' if f.is_dir() else 'file') for f in entries]))
            if path == '/api/file':
                file, relative = library.editor_target(param('path'))
                if not file.is_file():
                    return self.reply(400, dict(error='Not a file'))
                return self.reply(200, dict(path=relative, text=read_text(file), mtime=mtime(file)))
            if path in ('/api/save', '/api/create') and method == 'POST':
                data = self.body()
                file, relative = library.editor_target(data.get('path') or '')
                exists = file.exists()
                if path == '/api/create':
                    if not relative or re.search(r'[\\/:*?"<>|\x00-\x1f]|[. ]$', file.name) or re.match(r'^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)', file.name, re.I):
                        raise ValueError('Invalid file name')
                    if not file.parent.is_dir():
                        return self.reply(400, dict(error='Target directory does not exist'))
                    if exists and not data.get('overwrite'):
                        return self.reply(409, dict(error='A file with this name already exists.', code='FILE_EXISTS', mtime=mtime(file)))
                    if exists and not file.is_file():
                        return self.reply(400, dict(error='Target is not a file'))
                    if exists and (not finite(data.get('mtime')) or abs(mtime(file) - data['mtime']) > 1):
                        return self.reply(409, dict(error='Target file changed before it could be overwritten.', code='TARGET_CHANGED', mtime=mtime(file)))
                elif finite(data.get('mtime')) and abs(mtime(file) - data['mtime']) > 1:
                    return self.reply(409, dict(error='File changed on disk. Reload before saving.', mtime=mtime(file)))
                try:
                    with file.open('x' if path == '/api/create' and not exists else 'w', encoding='utf-8', newline='') as output:
                        output.write(str(data.get('text') or ''))
                except FileExistsError:
                    return self.reply(409, dict(error='A file with this name already exists.', code='FILE_EXISTS', mtime=mtime(file)))
                return self.reply(201 if path == '/api/create' else 200, dict(ok=True, path=relative, mtime=mtime(file)))
            if path.startswith('/raw/'):
                file, _ = library.editor_target(unquote(path[5:]))
                if file.suffix.lower() != '.html':
                    return self.file(file)
                safe = lambda value: value if re.fullmatch(r'[#\w\s(),.%+\-]+', value) else '#fff'
                text = f'<style>{self.css()}</style><style>body{{background:{safe(param("bg", "#fff"))};color:{safe(param("fg", "#1d2430"))}}}</style>' + read_text(file)
                return self.reply(200, text, MIME['.html'])
            if path == '/mewde.css':
                return self.reply(200, self.css(), MIME['.css'])
            if path.startswith('/api/'):
                return self.reply(404, dict(error='Unknown API'))
            root, relative = public, unquote(path.lstrip('/') or 'reader.html')
            for prefix, directory in (('/vendor/pdfjs/', HERE / 'node_modules/pdfjs-dist'), ('/monaco/', monaco)):
                if path.startswith(prefix):
                    root, relative = directory, unquote(path[len(prefix):])
                    break
            file = (root / relative).resolve()
            if not inside(file, root):
                return self.reply(403, 'Forbidden', 'text/plain')
            if not file.is_file():
                return self.reply(404, 'Not found', 'text/plain')
            return self.file(file)

        def run_request(self):
            try:
                self.dispatch()
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                pass
            except Exception as error:
                self.reply(400, dict(error=str(error)))

        do_GET = do_HEAD = do_POST = do_PUT = run_request

    return Handler


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('-c', '--config', type=Path)
    parser.add_argument('-p', '--port', type=int, default=int(os.environ.get('PORT', 49100)))
    parser.add_argument('--legacy', action='store_true')
    args = parser.parse_args()
    config = find_default_config(args.config)
    library = Library(config)
    if not library.volumes:
        parser.error(f'No volumes found in {config}; check htmlRoot and pagePattern')
    for pdf in dict.fromkeys(v['pdf']['path'] for v in library.volumes if v['pdf']['kind'] == 'file'):
        try:
            load_browser(pdf, cache_dir=config.parent)
        except ValueError as error:
            parser.error(f'{error}\nPrepare first: python pdf_text_backend.py --config "{config}"')
    stop = threading.Event()
    threading.Thread(target=library.watch, args=(stop,), daemon=True).start()
    server = ThreadingHTTPServer(('', args.port), handler(library, args.legacy))
    server.daemon_threads = True
    if os.environ.get('MEW_READER_LAUNCHER') == '1':
        def launcher_closed():
            sys.stdin.buffer.read()
            server.shutdown()
        threading.Thread(target=launcher_closed, daemon=True).start()
    print(f'Config: {config}\nEditor root: {library.editor_root}\nReader: http://localhost:{server.server_port} ({len(library.volumes)} volumes)', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        stop.set()
        server.server_close()


if __name__ == '__main__':
    main()
