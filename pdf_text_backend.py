"""Generate persistent PDF text data for the reader and HTML review providers.

Persistent data contains text and format indexes only. Page/block offsets are
Unicode code points; prepared comparison indexes use UTF-16. PDF.js owns reader geometry;
Python review crops read only the requested PDF pages. Scan images are never changed.
"""
import argparse
import gzip
import hashlib
import html
import json
import os
import re
from pathlib import Path
from urllib.parse import urlsplit
from urllib.request import url2pathname

SCHEMA = 7


CONFIG_NAMES = ('.mew-reader.json', 'mew-reader.json')


def find_default_config(explicit=None):
    """Match reader-server.js: CLI, CONFIG, cwd ancestors, known siblings."""
    explicit = explicit or os.environ.get('CONFIG')
    if explicit:
        return Path(explicit).resolve()
    here = Path.cwd().resolve()
    for directory in (here, *here.parents):
        for name in CONFIG_NAMES:
            candidate = directory / name
            if candidate.is_file():
                return candidate
    server_dir = Path(__file__).resolve().parent
    candidates = [server_dir / '.mew-reader.json',
                  server_dir.parent / 'MEW_BRIEF' / '.mew-reader.json',
                  server_dir.parent / 'MECW_reconv' / '.mew-reader.json']
    return next((p for p in candidates if p.is_file()), candidates[0])


def local_resource(value, base):
    value = str(value or '.')
    parsed = urlsplit(value)
    if parsed.scheme.lower() in {'http', 'https'}:
        raise ValueError('Review requires local HTML/PDF resources; HTTP URLs are not editable')
    if parsed.scheme.lower() == 'file':
        value = url2pathname(parsed.path)
        if parsed.netloc:
            value = '//' + parsed.netloc + value
    return (base / value).resolve()


def load_reader_config(path):
    """Normalize the same library fields as reader-server.normalizedVolumes."""
    path = Path(path).resolve()
    config = json.loads(path.read_text('utf-8-sig'))
    if not isinstance(config, dict):
        raise ValueError('Reader config must be a JSON object')
    entries = config.get('volumes') or [config]
    if not isinstance(entries, list):
        raise ValueError('volumes must be an array')
    volumes = []
    for index, volume in enumerate(entries):
        if not isinstance(volume, dict):
            raise ValueError('Each volume must be a JSON object')
        pages = volume.get('pages', {})
        page_options = pages if isinstance(pages, dict) else {}
        identity = str(volume.get('id', config.get('id', index+1)))
        pattern = page_options.get('pattern', volume.get('pagePattern', config.get('pagePattern')))
        pdf = volume.get('pdf', config.get('pdf'))
        if isinstance(pdf, dict):
            pdf = pdf.get('file')
        if not pattern or not pdf:
            raise ValueError(f'Volume {identity} requires pages.pattern/pagePattern and pdf')
        # JavaScript named capture syntax -> Python, preserving ordinary groups.
        pattern = re.sub(r'\(\?<([A-Za-z_]\w*)>', r'(?P<\1>', pattern)
        expression = re.compile(pattern, re.I)
        if not expression.groups:
            raise ValueError(f'Volume {identity}: pagePattern requires a page capture group')
        directory = page_options.get('directory', volume.get('htmlRoot', config.get('htmlRoot', '.')))
        explicit = page_options.get('list', pages if isinstance(pages, list) else [])
        if not isinstance(explicit, list):
            raise ValueError(f'Volume {identity}: pages.list must be an array')
        volumes.append({'id': identity, 'directory': local_resource(directory, path.parent),
                        'pdf': local_resource(pdf, path.parent), 'pattern': expression,
                        'pageLabel': str(volume.get('pageLabel', config.get('pageLabel', '{page}'))),
                        'list': {int(p) for p in explicit}})
    return config, volumes

def cache_path(pdf, directory=None):
    pdf = Path(pdf).resolve()
    digest = hashlib.sha256(str(pdf).encode('utf-8')).hexdigest()[:16]
    return Path(directory or pdf.parent) / 'OCR_DATA' / f'{pdf.stem}.{digest}' / 'manifest.json'


def browser_path(pdf, directory=None):
    return cache_path(pdf, directory)


def pdf_identity(pdf):
    pdf = Path(pdf).resolve()
    stat = pdf.stat()
    return f'{pdf}:{(stat.st_mtime_ns, stat.st_size)}'


def save_json(target, data):
    target.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(data, ensure_ascii=False, allow_nan=False, indent=2) + '\n'
    target.write_text(payload, encoding='utf-8')


def read_json(target):
    opener = gzip.open if target.suffix == '.gz' else open
    with opener(target, 'rt', encoding='utf-8') as source:
        return json.load(source)


def load_browser(pdf, cache_dir=None):
    """Load the manifest only; the browser fetches the individual page results."""
    target = browser_path(pdf, cache_dir)
    try:
        data = read_json(target)
        if data['schema'] != SCHEMA or data['identity'] != pdf_identity(pdf):
            raise ValueError('stale text data')
        if not isinstance(data['fonts'], list) or len(data['pages']) != data['page_count']:
            raise ValueError('incomplete text data')
        previous = 0
        for number, page in enumerate(data['pages']):
            if (page['page_index'] != number or page['start'] != previous or page['end'] < previous
                    or page['file'] not in (f'page-{number + 1:05d}.json', f'page-{number + 1:05d}.json.gz')
                    or not isinstance(page['page_label'], str)):
                raise ValueError('invalid page index')
            if not (target.parent / page['file']).is_file():
                raise ValueError('missing page result')
            previous = page['end']
        if previous != data['text_length']:
            raise ValueError('incomplete pages')
        return data
    except (OSError, EOFError, ValueError, KeyError, TypeError) as error:
        raise ValueError(f'PDF text data missing, stale or invalid: {target}. '
                         'Run pdf_text_backend.py with the reader config, then reload.') from error


def generate_pdf_text(pdf, cache_dir=None):
    """Prepare JSON pages with block data and comparison indexes."""
    PdfTextIndex(pdf, cache_dir=cache_dir, prepare=True)
    return cache_path(pdf, cache_dir)


class PdfTextIndex:
    """Persistent text and format indexes; geometry is read only for Python crops."""
    def __init__(self, pdf, stamp=None, cache_dir=None, *, prepare=False):
        self.pdf = Path(pdf).resolve()
        stat = self.pdf.stat()
        stamp = stamp or (stat.st_mtime_ns, stat.st_size)
        self.identity = f'{self.pdf}:{stamp}'
        target = cache_path(self.pdf, cache_dir)
        try:
            data = load_browser(self.pdf, cache_dir)
            if data['identity'] != self.identity:
                raise ValueError('PDF changed while loading text')
            self.fonts, self.pages, texts = data['fonts'], [], []
            for entry in data['pages']:
                result = read_json(target.parent / entry['file'])
                if (result['schema'] != SCHEMA or result['document_id'] != data['document_id']
                        or result['page_index'] != entry['page_index'] or result['page_label'] != entry['page_label']
                        or result['page_count'] != data['page_count']):
                    raise ValueError('mismatched page result')
                parts, blocks, cursor = [], [], 0
                for order, block in enumerate(result['parsing_res_list']):
                    value = block['block_content']
                    if block['block_id'] != order or block['block_order'] != order or block['start'] != cursor or block['end'] != cursor + len(value):
                        raise ValueError('invalid block offsets')
                    lines, line_cursor = [], cursor
                    for line in block['lines']:
                        if line['start'] != line_cursor or not line_cursor < line['end'] <= block['end']:
                            raise ValueError('invalid line offsets')
                        spans, span_cursor = [], line_cursor
                        for span in line['spans']:
                            a, font = span_cursor, span['font_index']
                            b = a + span['length']
                            if (not isinstance(span['length'], int) or not a < b < line['end']
                                    or not isinstance(font, int) or not 0 <= font < len(self.fonts)):
                                raise ValueError('invalid span offsets')
                            part = dict(start=entry['start'] + a, end=entry['start'] + b, fontIndex=font)
                            parts.append(part)
                            spans.append(part)
                            span_cursor = b
                        if span_cursor != line['end'] - 1 or value[line['end'] - cursor - 1] != '\n':
                            raise ValueError('invalid line break')
                        lines.append(dict(start=entry['start'] + line['start'], end=entry['start'] + line['end'], spans=spans))
                        line_cursor = line['end']
                    if line_cursor != block['end']:
                        raise ValueError('incomplete block')
                    blocks.append(dict(start=entry['start'] + cursor, end=entry['start'] + block['end'], lines=lines))
                    texts.append(value)
                    cursor = block['end']
                if cursor != entry['end'] - entry['start']:
                    raise ValueError('incomplete page text')
                comparison = result['comparison']
                if (comparison['offset_unit'] != 'utf16'
                        or comparison['raw'] != ''.join(block['block_content'] for block in result['parsing_res_list'])):
                    raise ValueError('invalid prepared comparison text')
                self.pages.append(dict(page=entry['page_index'] + 1, label=entry['page_label'],
                                       start=entry['start'], end=entry['end'], parts=parts, blocks=blocks))
            self.text = ''.join(texts)
        except (OSError, EOFError, ValueError, KeyError, TypeError) as error:
            if not prepare:
                raise ValueError(f'PDF text data missing, stale or invalid: {target}. '
                                 'Run pdf_text_backend.py with the reader config, then reload.') from error
            self.extract(self.pdf)
            if pdf_identity(self.pdf) != self.identity:
                raise ValueError('PDF changed while extracting; retry')
            self.save(target)
        self.labels = {}
        for number, page in enumerate(self.pages):
            self.labels.setdefault(page['label'], []).append(number)

    def save(self, target):
        """PaddleOCR-VL-1.6 page/block fields with lossless line/font extensions."""
        prepared = self.browser()
        document_id = hashlib.sha256(self.identity.encode('utf-8')).hexdigest()[:16]
        target.parent.mkdir(parents=True, exist_ok=True)
        entries = []
        for page in self.pages:
            start, blocks = page['start'], []
            for order, block in enumerate(page['blocks']):
                lines = [dict(start=line['start'] - start, end=line['end'] - start,
                    spans=[dict(length=part['end'] - part['start'], font_index=part['fontIndex'])
                           for part in line['spans']]) for line in block['lines']]
                blocks.append(dict(block_id=order, block_order=order, block_label='text', block_bbox=None,
                    block_content=self.text[block['start']:block['end']], start=block['start'] - start,
                    end=block['end'] - start, lines=lines))
            name = f"page-{page['page']:05d}.json"
            save_json(target.parent / name, dict(schema=SCHEMA, document_id=document_id,
                input_path=str(self.pdf), page_index=page['page'] - 1, page_count=len(self.pages),
                page_label=page['label'], parsing_res_list=blocks,
                comparison=dict(offset_unit='utf16', raw=self.text[start:page['end']],
                    **{key: prepared['pages'][page['page'] - 1][key] for key in ('start', 'end', 'parts')})))
            entries.append(dict(page_index=page['page'] - 1, page_label=page['label'],
                                start=start, end=page['end'], file=name))
        if pdf_identity(self.pdf) != self.identity:
            raise ValueError('PDF changed while writing page results; retry')
        save_json(target, dict(schema=SCHEMA, identity=self.identity, document_id=document_id,
            input_path=str(self.pdf), interface='PaddleOCR-VL-1.6', source='embedded_pdf_text', geometry='pdfjs',
            offset_unit='unicode_code_point', page_count=len(self.pages), text_length=len(self.text),
            fonts=self.fonts, pages=entries))
        current = {entry['file'] for entry in entries}
        for old in target.parent.glob('page-*.json*'):
            if re.fullmatch(r'page-\d{5}\.json(?:\.gz)?', old.name) and old.name not in current:
                old.unlink()

    def extract(self, pdf):
        import fitz
        self.pages, self.fonts = [], []
        text, offset, font_ids = [], 0, {}
        with fitz.open(pdf) as book:
            for number, page in enumerate(book):
                start, parts, structure = offset, [], []
                blocks = page.get_text('dict', sort=True,
                    flags=fitz.TEXTFLAGS_DICT & ~fitz.TEXT_PRESERVE_IMAGES)['blocks']
                for block in blocks:
                    block_start, lines = offset, []
                    for line in block.get('lines', []):
                        line_start, first_part = offset, len(parts)
                        for span in line['spans']:
                            name, flags = span.get('font', ''), span.get('flags', 0)
                            unknown = 'glyphlessfont' in name.lower()
                            style = dict(name=name, italic=None if unknown else bool(flags & 2),
                                         bold=None if unknown else bool(flags & 16), flags=flags)
                            # Embedded text metadata: size is in PDF points, color is 0xRRGGBB,
                            # alpha is 0..255, and metrics are relative to size 1.
                            # These describe the text layer, not the original scan's appearance.
                            for field in ('size', 'color', 'alpha', 'ascender', 'descender'):
                                style[field] = span.get(field, 255 if field == 'alpha' else None)
                            if unknown:
                                style['reason'] = 'GlyphLessFont does not retain OCR style'
                            key = json.dumps(style, sort_keys=True)
                            if key not in font_ids:
                                font_ids[key] = len(self.fonts)
                                self.fonts.append(style)
                            first = offset
                            value = span['text']
                            text.append(value)
                            offset += len(value)
                            if offset > first:
                                parts.append(dict(start=first, end=offset, fontIndex=font_ids[key]))
                        text.append('\n')
                        offset += 1
                        lines.append(dict(start=line_start, end=offset, spans=parts[first_part:]))
                    structure.append(dict(start=block_start, end=offset, lines=lines))
                # Match the browser's conservative treatment of page-uniform OCR declarations.
                total = sum(p['end'] - p['start'] for p in parts)
                for name in ('italic', 'bold'):
                    styled = sum(p['end'] - p['start'] for p in parts if self.fonts[p['fontIndex']][name] is True)
                    if total and styled / total >= (0.8 if name == 'bold' else 1):
                        for part in parts:
                            original = self.fonts[part['fontIndex']]
                            if original[name] is not True:
                                continue
                            style = dict(original, **{name: None, 'declared' + name.title(): True,
                                                     'reason': 'Page-uniform OCR font declaration'})
                            key = json.dumps(style, sort_keys=True)
                            if key not in font_ids:
                                font_ids[key] = len(self.fonts)
                                self.fonts.append(style)
                            part['fontIndex'] = font_ids[key]
                self.pages.append(dict(page=number + 1, label=page.get_label(), start=start,
                                       end=offset, parts=parts, blocks=structure))
        self.text = ''.join(text)

    def browser(self):
        # Build one conversion table, preserving astral characters and exact source indexes.
        offsets, offset = [0], 0
        for char in self.text:
            offset += 2 if ord(char) > 0xffff else 1
            offsets.append(offset)
        pages = []
        for page in self.pages:
            parts = []
            for part in page['parts']:
                a, b = part['start'], part['end']
                parts.append(dict(start=offsets[a], end=offsets[b], fontIndex=part['fontIndex']))
            pages.append(dict(number=page['page'], label=page['label'], start=offsets[page['start']],
                              end=offsets[page['end']], parts=parts))
        formatted = self.formatted()
        for run in formatted:
            run['start'], run['end'] = offsets[run['start']], offsets[run['end']]
        return dict(schema=SCHEMA, identity=self.identity, raw=self.text, fonts=self.fonts,
                    pages=pages, formatted=formatted)

    def formatted(self):
        # Tags are canonical; each run retains its plain-text indexes and font-table index.
        runs = []
        for page in self.pages:
            for part in page['parts']:
                font = self.fonts[part['fontIndex']]
                value = html.escape(self.text[part['start']:part['end']], quote=False)
                for name, tag in (('italic', 'i'), ('bold', 'b')):
                    if font[name] is True:
                        value = f'<{tag}>{value}</{tag}>'
                runs.append(dict(start=part['start'], end=part['end'], fontIndex=part['fontIndex'], text=value))
        return runs

    def physical(self, label):
        numbers = self.labels.get(label, [])
        if len(numbers) != 1:
            raise ValueError(f'PDF label {label!r} is missing or ambiguous; no physical-page fallback')
        return numbers[0]

    def context(self, source, start_label, next_label):
        """Return review data and selected pages without importing review providers."""
        first = self.physical(start_label)
        stop = self.physical(next_label) if next_label is not None else len(self.pages)
        if stop <= first:
            raise ValueError('Next HTML page label precedes the current PDF page')
        selected = self.pages[first:stop]
        start, end = selected[0]['start'], selected[-1]['end']
        # Python review crops are the only consumer of these coordinates. Read just
        # the requested pages, keep native PDF precision, and never write geometry.
        import fitz
        coordinates, extracted = [], []
        styles = bytearray(end - start)
        with fitz.open(self.pdf) as book:
            for page in selected:
                blocks = book[page['page'] - 1].get_text('rawdict', sort=True,
                    flags=fitz.TEXTFLAGS_RAWDICT & ~fitz.TEXT_PRESERVE_IMAGES)['blocks']
                for block in blocks:
                    for line in block.get('lines', []):
                        for span in line['spans']:
                            for char in span['chars']:
                                extracted.append(char['c'])
                                coordinates.extend([(page['page'], page['label'], tuple(char['bbox']))] * len(char['c']))
                        extracted.append('\n')
                        coordinates.append(None)
                for part in page['parts']:
                    font = self.fonts[part['fontIndex']]
                    style = (2 if font['italic'] is True else 0) | (16 if font['bold'] is True else 0)
                    styles[part['start'] - start:part['end'] - start] = bytes([style]) * (part['end'] - part['start'])
        if pdf_identity(self.pdf) != self.identity or ''.join(extracted) != self.text[start:end]:
            raise ValueError('PDF text changed while reading crop coordinates; regenerate text data')
        context = dict(source=source, ocr=self.text[start:end], coordinates=coordinates,
                       styles=styles, pdf_identity=self.identity)
        return context, [{'page': p['page'], 'label': p['label']} for p in selected]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('-c', '--config', type=Path)
    parser.add_argument('--pdf', type=Path)
    parser.add_argument('--cache-dir', type=Path)
    parser.add_argument('--browser', action='store_true')
    args = parser.parse_args()
    if args.pdf:
        target = generate_pdf_text(args.pdf, args.cache_dir)
        print(json.dumps(load_browser(args.pdf, args.cache_dir) if args.browser else
                         {'cache': str(target), 'browser': str(browser_path(args.pdf, args.cache_dir))}, ensure_ascii=True))
    else:
        config = find_default_config(args.config)
        _, volumes = load_reader_config(config)
        for volume in volumes:
            print(generate_pdf_text(volume['pdf'], args.cache_dir or config.parent), flush=True)


if __name__ == '__main__':
    main()
