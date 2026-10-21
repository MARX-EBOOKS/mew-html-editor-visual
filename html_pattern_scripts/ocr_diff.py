"""PDF OCR text diff provider. No file reads or writes."""
import hashlib
import html
import re
from review_common import line_column


class OcrDiff:
    id = 'ocr'
    label = 'PDF OCR 文本差异'
    requires_pdf = True
    reviewable = True
    patterns = [{'id': 'ocr', 'label': 'PDF OCR 差异', 'regex': ''}]
    kinds = {'replace': '文字不同', 'insert': '仅 OCR 有文字', 'delete': '仅 HTML 有文字'}
    actions = [
        {'id': 'ocr', 'label': '按照 OCR 文字修改'},
        {'id': 'custom', 'label': '自行修改', 'input': 'source'},
    ]

    def decide(self, context, hit, choice, text):
        if choice == 'custom':
            if not isinstance(text, str):
                raise ValueError('Edited HTML source must be text')
            return {'edits': [(0, len(context.source), text)] if text != context.source else [],
                    'text': text, 'message': '已保存 HTML；原文备份已保留。'}
        replacement = hit['ocr'] if choice == 'ocr' else text
        if not isinstance(replacement, str):
            raise ValueError('Replacement must be text (empty text deletes)')
        edits = [(a, b, '') for a, b in hit['spans']]
        if edits:
            edits[0] = (edits[0][0], edits[0][1], html.escape(replacement, quote=False))
        else:
            edits = [(hit['start'], hit['end'], html.escape(replacement, quote=False))]
        return {'edits': edits, 'text': replacement,
                'message': '已保存 HTML；原文备份已保留。'}

    def compare(self, context):
        source = context.source
        diff = context.diff
        visible, visible_text = diff.visible, diff.text
        left_map = [visible.spans[i] for i in diff.left_map]
        raw_ocr = context.ocr
        right_map, matcher = diff.right_map, diff.matcher
        matches = []
        for tag, a, b, c, d in matcher.get_opcodes():
            if tag == 'equal':
                continue
            spans = list(dict.fromkeys(s for s in left_map[a:b] if s))
            if spans:
                start, end = spans[0][0], spans[-1][1]
            else:
                anchor = left_map[a] if a < len(left_map) else left_map[-1] if left_map else None
                if not anchor:
                    body = re.search(r'<body\b[^>]*>|<(?:p|div)\b[^>]*>', source, re.I)
                    start = end = body.end() if body else 0
                else:
                    start = end = anchor[0] if a < len(left_map) else anchor[1]
            # Include all source text, whitespace and entities inside this range.
            indices = visible.source_range(start, end)
            spans = list(dict.fromkeys(visible.spans[i] for i in indices))
            old = ''.join(visible.text[i] for i in indices)
            new = raw_ocr[right_map[c]:right_map[d - 1] + 1] if c < d else ''
            # Normalize layout only within replacement text, never the HTML source.
            new = re.sub(r'(?<=\w)[-\u00ad]\s*\n\s*(?=\w)', '', new)
            new = re.sub(r'\s+', ' ', new).strip()
            if c < d:
                # Whitespace is ignored for alignment, but word insertions still
                # need their boundary spaces when the HTML has none at that edge.
                before, after = visible.source_neighbors(start, end)
                raw_start, raw_end = right_map[c], right_map[d - 1] + 1
                if raw_start and raw_ocr[raw_start - 1].isspace() and before and not before.isspace():
                    new = ' ' + new
                if raw_end < len(raw_ocr) and raw_ocr[raw_end].isspace() and after and not after.isspace():
                    new += ' '
            selected = right_map[c:d] or right_map[max(0, c - 1):min(len(right_map), c + 1)]
            identity = hashlib.sha256(f'{context.pdf_identity}:{c}:{d}:{old}:{new}'.encode()).hexdigest()[:20]
            visible_start, visible_end = visible.visible_offset(start), visible.visible_offset(end)
            line, column = line_column(visible.lines, start)
            matches.append({'id': identity, 'pattern': 'ocr', 'start': start, 'end': end,
                            'line': line, 'column': column,
                            'text': old, 'ocr': new, 'spans': spans,
                            'context': visible_text[max(0, visible_start - 65):visible_start] + '【' + old + '】' + visible_text[visible_end:visible_end + 65],
                            'crops': diff.crops(selected, padding=28),
                            'kind': tag, 'decision': None})
        return {'matches': matches, 'alignment': round(matcher.ratio(), 3)}
