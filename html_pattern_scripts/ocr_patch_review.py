"""Prepare native embedded-image crops for an applied-patch review. No page rendering."""
import argparse
import json
import hashlib
import math
from collections import Counter, defaultdict
from pathlib import Path

import fitz
from PIL import Image, ImageDraw, ImageFont

# Shared native scan tools are owned by the review backend.
from html_pattern_review import crop, scan_for_box


def select_crop(doc, entry):
    """Select native scan pixels with a scrollable, unscaled rectangle picker."""
    import tkinter as tk
    from PIL import ImageTk

    scan, info = scan_for_box(doc[entry['pdf_page'] - 1], fitz.Rect(entry['bbox']), entry['id'])
    root = tk.Tk()
    root.title(f"Patch {entry['id']} — drag area, Enter to save, Esc to cancel")
    selected = None
    anchor = None
    rectangle = None
    status = tk.StringVar(value='Drag a rectangle. Scroll to move; Shift + wheel scrolls horizontally.')
    canvas = tk.Canvas(root, width=min(scan.width, root.winfo_screenwidth()-120),
                       height=min(scan.height, root.winfo_screenheight()-200), highlightthickness=0)
    horizontal = tk.Scrollbar(root, orient='horizontal', command=canvas.xview)
    vertical = tk.Scrollbar(root, orient='vertical', command=canvas.yview)
    canvas.configure(xscrollcommand=horizontal.set, yscrollcommand=vertical.set,
                     scrollregion=(0, 0, scan.width, scan.height))
    canvas.grid(row=0, column=0, sticky='nsew')
    vertical.grid(row=0, column=1, sticky='ns')
    horizontal.grid(row=1, column=0, sticky='ew')
    tk.Label(root, textvariable=status).grid(row=2, column=0, columnspan=2)
    root.rowconfigure(0, weight=1)
    root.columnconfigure(0, weight=1)
    photo = ImageTk.PhotoImage(scan, master=root)
    canvas.create_image(0, 0, image=photo, anchor='nw')
    patch = fitz.Rect(entry['bbox']) * ~fitz.Matrix(info['transform'])
    canvas.create_rectangle(patch.x0*scan.width, patch.y0*scan.height,
                            patch.x1*scan.width, patch.y1*scan.height, outline='blue', width=2)

    def point(event):
        return (max(0, min(scan.width, int(canvas.canvasx(event.x)))),
                max(0, min(scan.height, int(canvas.canvasy(event.y)))))

    def begin(event):
        nonlocal anchor, rectangle, selected
        anchor, selected = point(event), None
        if rectangle is not None:
            canvas.delete(rectangle)
        rectangle = canvas.create_rectangle(*anchor, *anchor, outline='red', width=2)

    def drag(event):
        nonlocal selected
        if anchor is None:
            return
        x, y = point(event)
        selected = (min(anchor[0], x), min(anchor[1], y), max(anchor[0], x), max(anchor[1], y))
        canvas.coords(rectangle, *selected)
        status.set(f'{selected[2]-selected[0]} × {selected[3]-selected[1]} pixels — Enter to save; Esc to cancel')

    def finish(event=None):
        if selected and selected[2] > selected[0] and selected[3] > selected[1]:
            root.quit()

    def cancel(event=None):
        nonlocal selected
        selected = None
        root.quit()

    canvas.bind('<Button-1>', begin)
    canvas.bind('<B1-Motion>', drag)
    canvas.bind('<ButtonRelease-1>', drag)
    canvas.bind('<MouseWheel>', lambda e: canvas.yview_scroll(-int(e.delta/120), 'units'))
    canvas.bind('<Shift-MouseWheel>', lambda e: canvas.xview_scroll(-int(e.delta/120), 'units'))
    root.bind('<Return>', finish)
    root.bind('<Escape>', cancel)
    root.protocol('WM_DELETE_WINDOW', cancel)
    try:
        root.mainloop()
    finally:
        root.destroy()
    return scan.crop(selected).convert('RGB') if selected else None


def read_manifest(directory):
    return json.loads((Path(directory) / 'manifest.json').read_text(encoding='utf-8'))


def report_entries(report):
    entries = []
    for page in sorted(report['pages'], key=lambda p: p['pdf_page']):
        for index, patch in enumerate(page['applied']):
            entries.append(dict(patch, id=len(entries)+1, pdf_page=page['pdf_page'],
                                printed_page=page['printed_page'], applied_index=index))
    return entries


def file_sha256(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def list_patches(directory, start=1, limit=60):
    """Return JSON-serializable records for a future diff-webview backend."""
    if start < 1 or limit < 1:
        raise ValueError('start and limit must be positive')
    manifest = read_manifest(directory)
    return {'total':len(manifest['entries']), 'start':start,
            'entries':manifest['entries'][start-1:start-1+limit]}


def read_decisions(manifest, paths, require_complete=True):
    """Merge disjoint reviewer files; reject conflicts, omissions and unsafe edits."""
    valid = {entry['id']: entry for entry in manifest['entries']}
    decisions = {}
    for path in paths:
        payload = json.loads(Path(path).read_text(encoding='utf-8'))
        for item in payload['decisions']:
            identity = item['id']
            if identity not in valid or identity in decisions:
                raise ValueError(f'Unknown or duplicate patch ID: {identity}')
            if item['decision'] not in {'keep', 'revert', 'correct', 'uncertain'}:
                raise ValueError(f'Invalid decision for {identity}')
            if item['decision'] != 'keep' and not item.get('reason'):
                raise ValueError(f'Missing visual evidence reason for {identity}')
            if item['decision'] == 'correct' and not item.get('reading', '').strip():
                raise ValueError(f'Missing corrected reading for {identity}')
            decisions[identity] = item
    missing = sorted(set(valid) - set(decisions))
    if require_complete and missing:
        raise ValueError(f'{len(missing)} unreviewed patches, beginning {missing[:10]}')
    return decisions


def source_edits(page, entries, ocr, decisions=None):
    """Resolve report token ranges against the original OCR, never output OCR."""
    words = page.get_text('words', sort=False)
    _, owners = ocr.logical_words(words)
    edits, occupied = {}, set()
    for entry in entries:
        a, b = entry['old_token_range']
        if not 0 <= a <= b <= len(owners) or (a == b and not entry.get('items')):
            raise ValueError(f"Out-of-range source tokens for {entry['id']}")
        indices = [j for owner in owners[a:b] for j in owner]
        if occupied.intersection(indices):
            raise ValueError(f"Invalid/overlapping source token range for {entry['id']}")
        occupied.update(indices)
        old = ' '.join(words[j][4] for j in indices)
        rect = fitz.Rect(words[indices[0]][:4]) if indices else fitz.Rect(entry['bbox'])
        for j in indices[1:]:
            rect |= fitz.Rect(words[j][:4])
        if old != entry['old'] or len(entry['bbox']) != 4 or (
                entry.get('operation') != 'rebuild_from_source_regions'
                and any(abs(x-y) > .001 for x,y in zip(rect,entry['bbox']))):
            raise ValueError(f"Source text/box mismatch for patch {entry['id']}")
        decision = decisions[entry['id']] if decisions is not None else {'decision':'keep'}
        if decision['decision'] == 'revert':
            continue
        text = decision['reading'] if decision['decision'] == 'correct' else entry['new']
        for j in indices:
            edits[j] = (None, '')
        start = indices[0] if indices else (owners[a][0] if a < len(owners) else len(words))
        if 'items' in entry:
            items = [(fitz.Rect(box), value) for box, value in entry['items']]
            if decision['decision'] == 'correct' and items:
                # Reuse the correction planner to retain separate physical lines.
                synthetic, line = [], 0
                for box, value in items:
                    if synthetic and abs(box.y0 - synthetic[-1][1]) > box.height / 2:
                        line += 1
                    synthetic.append((*box, value, 0, line, len(synthetic)))
                corrected, detail = ocr.plan_corrections(synthetic, text, min_similarity=0)
                if detail['reviews']:
                    raise ValueError(f"Cannot locate corrected reading for patch {entry['id']}")
                items = ocr.replacement_words(synthetic, corrected)
            elif decision['decision'] == 'correct':
                items = [(rect, text)] if text else []
        else:
            items = [(rect, text)] if text else []
        for offset, item in enumerate(items):
            # Empty source ranges insert immediately before the next word.
            position = start + offset / (len(items) + 1) if indices else start - 1e-6 + (offset+1)*1e-6/(len(items)+1)
            edits[position] = item
    return words, edits


def check_report_text(source, corrected, groups, ocr):
    if (len(source) != len(corrected) or source.get_page_labels() != corrected.get_page_labels()
            or source.metadata != corrected.metadata or source.get_toc() != corrected.get_toc()):
        raise ValueError('Source and corrected document structure/metadata differ')
    for index in range(len(source)):
        words, edits = source_edits(source[index], groups.get(index, []), ocr)
        expected = ocr.compact(' '.join(text for _,text in ocr.replacement_words(words,edits)))
        if expected != ocr.compact(corrected[index].get_text()):
            raise ValueError(f'Corrected PDF text disagrees with report on physical page {index+1}')


def apply_decisions(directory, decision_paths, output, font_path, helpers):
    """Build only affected hidden layers; publish after all-page object verification."""
    import importlib.util
    import sys
    sys.path.insert(0, str(Path(helpers).resolve()))
    spec = importlib.util.spec_from_file_location('review_ocr_helpers', Path(helpers) / 'correct_pdf_ocr.py')
    ocr = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(ocr)
    manifest = read_manifest(directory)
    report = json.loads(Path(manifest['report']).read_text(encoding='utf-8'))
    decisions = read_decisions(manifest, decision_paths)
    output = Path(output).resolve()
    corrected_path = Path(report['summary']['output_pdf']).resolve()
    source_path = Path(manifest['source_pdf']).resolve()
    if output in {corrected_path, source_path} or output.exists():
        raise ValueError('Use a new output path; source and previous corrected PDF are preserved')
    # A manifest is a snapshot: reject stale or edited reports before using its boxes.
    if report_entries(report) != manifest['entries']:
        raise ValueError('Report differs from review manifest')
    groups = defaultdict(list)
    for entry in manifest['entries']:
        groups[entry['pdf_page']-1].append(entry)
    changed = {i for i, entries in groups.items() if any(decisions[e['id']]['decision'] in {'revert', 'correct'} for e in entries)}
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix('.tmp.pdf')
    if temporary.exists():
        raise ValueError(f'Temporary output already exists: {temporary}')
    audit_path = output.with_suffix('.review.json')
    if audit_path.exists():
        raise ValueError(f'Audit output already exists: {audit_path}')
    font = fitz.Font(fontfile=str(font_path))
    expected_hashes = {}
    with fitz.open(source_path) as source, fitz.open(corrected_path) as doc:
        check_report_text(source, doc, groups, ocr)
        signatures = [ocr.image_layer_signature(page) for page in doc]
        if any(ocr.image_layer_signature(source[i]) != signatures[i] for i in range(len(doc))):
            raise ValueError('Corrected PDF image layer differs from source')
        untouched_text = {i: doc[i].get_text() for i in range(len(doc)) if i not in changed}
        for i in sorted(changed):
            words, edits = source_edits(source[i], groups[i], ocr, decisions)
            _, expected_hashes[i] = ocr.replace_hidden_layer(doc[i], ocr.replacement_words(words, edits), font_path, font)
        try:
            doc.save(temporary, garbage=0, deflate=False, deflate_images=False)
            with fitz.open(temporary) as check:
                if (len(check) != len(doc) or check.get_page_labels() != doc.get_page_labels()
                        or check.metadata != doc.metadata or check.get_toc() != doc.get_toc()):
                    raise RuntimeError('Document structure/metadata changed')
                for i, signature in enumerate(signatures):
                    if ocr.image_layer_signature(check[i]) != signature:
                        raise RuntimeError(f'Image layer changed on physical page {i+1}')
                    if i in expected_hashes:
                        actual = hashlib.sha256(' '.join(check[i].get_text().split()).encode('utf-8')).hexdigest()
                        if actual != expected_hashes[i]:
                            raise RuntimeError(f'Text mismatch on physical page {i+1}')
                    elif check[i].get_text() != untouched_text[i]:
                        raise RuntimeError(f'Untouched text changed on physical page {i+1}')
            audit = {'source_report':manifest['report'], 'source_pdf':str(source_path),
                     'prior_corrected_pdf':str(corrected_path), 'output_pdf':str(output),
                     'summary':dict(Counter(d['decision'] for d in decisions.values())),
                     'reviewed_patches':len(decisions), 'rebuilt_pages':len(changed),
                     'image_layer_verified_pages':len(doc),
                     'provenance_sha256':{str(path.resolve()):file_sha256(path)
                                          for path in [source_path,corrected_path,Path(manifest['report']),*map(Path,decision_paths)]},
                     'decisions':[dict(manifest['entries'][identity-1], **{'review_decision':decisions[identity]}) for identity in sorted(decisions)]}
            temporary.replace(output)
            audit_path.write_text(json.dumps(audit,ensure_ascii=False,indent=2),encoding='utf-8')
        finally:
            temporary.unlink(missing_ok=True)
    return {'output_pdf':str(output), 'audit':str(audit_path), **audit['summary']}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('mode', choices=['prepare', 'crop', 'list', 'validate', 'apply'])
    parser.add_argument('--report', type=Path)
    parser.add_argument('--directory', type=Path, required=True)
    parser.add_argument('--id', type=int)
    area = parser.add_mutually_exclusive_group()
    area.add_argument('--select', action='store_true', help='Drag a native scan rectangle for crop')
    area.add_argument('--bbox', type=float, nargs=4, metavar=('X0', 'Y0', 'X1', 'Y1'),
                      help='Crop rectangle in original PDF page coordinates')
    parser.add_argument('--padding', type=int, help='Crop padding in native pixels (default: 65; bbox: 0)')
    parser.add_argument('--start', type=int, default=1)
    parser.add_argument('--limit', type=int, default=60)
    parser.add_argument('--decisions', type=Path, nargs='+')
    parser.add_argument('--output', type=Path)
    parser.add_argument('--font', type=Path, default=Path('C:/Windows/Fonts/arial.ttf'))
    parser.add_argument('--helpers', type=Path, default=Path(__file__).resolve().parent)
    args = parser.parse_args()
    if args.mode != 'crop' and (args.select or args.bbox is not None or args.padding is not None):
        parser.error('--select, --bbox and --padding require crop mode')
    if args.padding is not None and (args.padding < 0 or args.select):
        parser.error('--padding must be nonnegative and cannot be used with --select')
    args.directory.mkdir(parents=True, exist_ok=True)
    if args.mode == 'list':
        print(json.dumps(list_patches(args.directory,args.start,args.limit),ensure_ascii=False))
        return
    if args.mode == 'validate':
        decisions = read_decisions(read_manifest(args.directory), args.decisions or [])
        print(json.dumps(dict(Counter(d['decision'] for d in decisions.values()))))
        return
    if args.mode == 'apply':
        if not args.output or not args.decisions:
            parser.error('apply requires --output and --decisions')
        print(json.dumps(apply_decisions(args.directory, args.decisions, args.output, args.font, args.helpers), ensure_ascii=False))
        return
    manifest_path = args.directory / 'manifest.json'
    if args.mode == 'prepare':
        if not args.report:
            parser.error('prepare requires --report')
        report = json.loads(args.report.read_text(encoding='utf-8'))
        entries = report_entries(report)
        manifest = dict(source_pdf=report['summary']['input_pdf'], report=str(args.report.resolve()), entries=entries)
        if manifest_path.exists() and read_manifest(args.directory) != manifest:
            raise ValueError('Directory contains a different manifest; use a new review directory')
        manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
    else:
        manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
    with fitz.open(manifest['source_pdf']) as doc:
        if args.mode == 'crop':
            if not args.id or not 1 <= args.id <= len(manifest['entries']):
                parser.error('crop requires a valid --id')
            entry = manifest['entries'][args.id-1]
            output = args.output or args.directory / f"crop-{args.id:05}.png"
            image = (select_crop(doc, entry) if args.select else
                     crop(doc, entry, args.padding if args.padding is not None else (0 if args.bbox else 65), args.bbox))
            if image is None:
                print('Selection cancelled; no crop saved.')
                return
            if output.resolve() == Path(manifest['source_pdf']).resolve() or output.suffix.lower() != '.png':
                parser.error('crop output must be a PNG path separate from the source PDF')
            output.parent.mkdir(parents=True, exist_ok=True)
            image.save(output)
            print(output)
            return
        font = ImageFont.truetype('C:/Windows/Fonts/arial.ttf', 19)
        for start in range(0, len(entries), 60):
            subset = entries[start:start+60]
            sheet = Image.new('RGB', (2200, 30*150), 'white')
            draw = ImageDraw.Draw(sheet)
            for offset, entry in enumerate(subset):
                x, y = (offset//30)*1100, (offset%30)*150
                draw.text((x+6, y+2), f"#{entry['id']} p{entry['pdf_page']} [{entry['printed_page']}] OLD: {entry['old']}", fill='black', font=font)
                draw.text((x+6, y+25), 'NEW: '+entry['new'], fill='blue', font=font)
                image = crop(doc, entry)
                # Preserve native pixels. Oversize rows are explicitly flagged for individual viewing.
                sheet.paste(image.crop((0, 0, min(1090,image.width), min(96,image.height))), (x+5,y+50))
                if image.width > 1090 or image.height > 96:
                    draw.text((x+800,y+25), 'OPEN FULL CROP', fill='red',font=font)
                draw.line((x,y+149,x+1100,y+149), fill='#aaaaaa')
            sheet.save(args.directory / f'sheet-{start//60+1:03}.png')
        print(f'{len(entries)} patches; {math.ceil(len(entries)/60)} sheets')


if __name__ == '__main__':
    main()
