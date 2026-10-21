"""Interactive Python regex search/replacement; no PDF or file IO required."""
import hashlib
import re

from html_patterns import HtmlPatterns


class RegexSearch(HtmlPatterns):
    id = 'regex'
    label = '正则搜索 / 替换'
    reviewable = True
    configurable = True
    actions = [{'id': 'replace', 'label': '替换此处'}]

    def __init__(self, options=None):
        options = options or {}
        self.query = str(options.get('query', ''))
        self.replacement = str(options.get('replacement', ''))
        flags = str(options.get('flags', ''))
        if any(flag not in 'ims' for flag in flags):
            raise ValueError('Regex flags must use i, m or s')
        try:
            self.expression = re.compile(self.query, sum(value for flag, value in
                                         [('i', re.I), ('m', re.M), ('s', re.S)] if flag in flags))
            # Validate replacement references even when there are no matches.
            self.expression.sub(self.replacement, '')
        except (re.error, IndexError) as error:
            raise ValueError(f'Regex error: {error}') from error
        super().__init__([{'id': 'regex', 'label': '正则匹配', 'regex': self.query,
                           'flags': self.expression.flags}])

    def configured(self, options):
        return type(self)(options)

    def compare(self, context):
        result = super().compare(context) if self.query else {'matches': []}
        for hit in result['matches']:
            hit.update(id=hashlib.sha256(f'{self.query}:{hit["start"]}:{hit["end"]}'.encode()).hexdigest(),
                       crops=[], decision=None)
        return result

    def decide(self, context, hit, choice, text):
        # Match against the whole source so lookarounds and anchors retain context.
        # finditer can return an empty match followed by a nonempty match at the
        # same position. match() alone would always choose the first one.
        match = None
        for candidate in self.expression.finditer(context.source, hit['start']):
            if candidate.start() > hit['start']:
                break
            if candidate.end() == hit['end']:
                match = candidate
                break
        if match is None:
            raise ValueError('Regex match changed; search again')
        replacement = match.expand(self.replacement)
        return {'edits': [(hit['start'], hit['end'], replacement)], 'text': replacement,
                'advance': False}
