"""Regular expression search provider, operating on source strings only."""
import re
from review_common import line_column

DEFAULT_PATTERNS = [
    {'id': 'font', 'label': 'Legacy font tags', 'regex': r'</?font\b[^>]*>', 'flags': re.I},
    {'id': 'empty-p', 'label': 'Empty paragraphs',
     'regex': r'<p\b[^>]*>(?:\s|&nbsp;|&#160;|<br\s*/?>)*</p\s*>', 'flags': re.I},
    {'id': 'replacement', 'label': 'Replacement characters', 'regex': '\ufffd'},
]

class HtmlPatterns:
    id = 'patterns'
    label = 'HTML 格式模式'
    requires_pdf = False
    reviewable = False
    kinds = {}
    actions = []

    def __init__(self, patterns=None):
        self.patterns = DEFAULT_PATTERNS if patterns is None else patterns
        if len({p['id'] for p in self.patterns}) != len(self.patterns):
            raise ValueError('Pattern IDs must be unique')
        self.compiled = [(p['id'], re.compile(p['regex'], p.get('flags', 0))) for p in self.patterns]

    def compare(self, context):
        source = context.source
        lines = [0] + [m.end() for m in re.finditer('\n', source)]
        matches = []
        for identity, expression in self.compiled:
            for match in expression.finditer(source):
                line, column = line_column(lines, match.start())
                matches.append({'pattern': identity, 'start': match.start(), 'end': match.end(),
                                'line': line, 'column': column,
                                'text': match[0], 'context_start': max(0, match.start()-65),
                                'context': source[max(0, match.start()-65):match.end()+65]})
        matches.sort(key=lambda m: (m['start'], m['end'], m['pattern']))
        return {'matches': matches}
