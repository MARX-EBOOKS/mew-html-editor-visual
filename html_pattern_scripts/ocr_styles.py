"""Find PDF OCR italic/bold runs and compare HTML markup, without file IO."""
import hashlib
from review_common import StyledText, line_column


class OcrStyles:
    id = 'ocr-styles'
    label = 'PDF OCR 粗体 / 斜体'
    requires_pdf = True
    reviewable = True
    patterns = [{'id': 'italic', 'label': '斜体', 'regex': ''},
                {'id': 'bold', 'label': '粗体', 'regex': ''}]
    kinds = {'missing': 'HTML 缺少格式', 'matched': '格式一致', 'review': '文字未可靠对齐'}
    actions = [{'id': 'ocr', 'label': '补上 OCR 标记的格式'}]

    def decide(self, context, hit, choice, text):
        return {'edits': hit['edits'], 'text': hit['text'],
                'message': '已保存 HTML 格式；原文备份已保留。'}

    def compare(self, context):
        diff = context.diff
        visible, text = diff.visible, diff.text
        lm, right, rm = diff.left_map, diff.right, diff.right_map
        matcher, aligned = diff.matcher, diff.aligned
        matches = []
        for bit, pattern in [(2, 'italic'), (16, 'bold')]:
            i = 0
            while i < len(right):
                if not context.styles[rm[i]] & bit:
                    i += 1
                    continue
                end = i + 1
                page = context.coordinates[rm[i]][0]
                while end < len(right) and context.styles[rm[end]] & bit and context.coordinates[rm[end]][0] == page:
                    end += 1
                positions = [aligned.get(j) for j in range(i, end)]
                reliable = all(p is not None for p in positions) and positions == list(range(positions[0], positions[0]+len(positions)))
                indices = [lm[p] for p in positions if p is not None]
                spans = sorted(set(visible.spans[j] for j in indices if visible.spans[j]))
                start = spans[0][0] if spans else 0
                stop = spans[-1][1] if spans else start
                old = ''.join(visible.text[j] for j in visible.source_range(start, stop))
                kind = 'review' if not reliable else 'matched' if all(visible.styles[j] & bit for j in indices) else 'missing'
                edits = []
                if reliable:
                    # Wrap contiguous text ranges only; preserve existing elements and entities.
                    missing = sorted(set(visible.spans[j] for j in range(indices[0], indices[-1]+1)
                                         if visible.spans[j] and not visible.styles[j] & bit))
                    groups = []
                    for a, b in missing:
                        if groups and groups[-1][1] == a:
                            groups[-1][1] = b
                        else:
                            groups.append([a, b])
                    tag = 'i' if bit == 2 else 'b'
                    edits = [(a, b, f'<{tag}>' + context.source[a:b] + f'</{tag}>') for a, b in groups]
                reading = context.ocr[rm[i]:rm[end-1]+1]
                identity = hashlib.sha256(f'{context.pdf_identity}:{pattern}:{i}:{end}:{reading}:{kind}:{old}'.encode()).hexdigest()[:20]
                line, column = line_column(visible.lines, start)
                matches.append({'id': identity, 'pattern': pattern, 'start': start, 'end': stop,
                                'line': line, 'column': column,
                                'text': old, 'ocr': reading, 'spans': spans, 'kind': kind,
                                'context': text[max(0, indices[0]-65):indices[-1]+66] if indices else '未定位 HTML；请检查 OCR 文字或阅读顺序。',
                                'crops': diff.crops(range(rm[i], rm[end-1]+1)),
                                'decision': None, 'choices': ['ocr'] if kind == 'missing' else [],
                                'edits': edits})
                i = end
        return {'matches': matches, 'alignment': round(matcher.ratio(), 3)}
