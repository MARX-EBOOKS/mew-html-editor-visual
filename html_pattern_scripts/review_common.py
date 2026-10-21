"""Pure text helpers shared by review providers (no file IO)."""
import html
import re
from bisect import bisect_left, bisect_right
from functools import cached_property
from html.parser import HTMLParser


def line_column(lines, offset):
    line = bisect_right(lines, offset) - 1
    return line + 1, offset - lines[line] + 1


class VisibleText(HTMLParser):
    """Decoded body characters mapped to exact source spans (Python offsets)."""
    def __init__(self, source):
        super().__init__(convert_charrefs=False)
        self.source, self.text, self.spans = source, [], []
        self.lines = [0] + [m.end() for m in re.finditer('\n', source)]
        self.hidden = 0
        self.feed(source)

    def source_offset(self):
        line, column = self.getpos()
        return self.lines[line - 1] + column

    def handle_starttag(self, tag, attrs):
        if tag in {'head', 'script', 'style', 'template'}:
            self.hidden += 1
        if tag in {'p', 'div', 'br', 'aside', 'li', 'h1', 'h2', 'h3', 'tr'}:
            self.text.append(' ')
            self.spans.append(None)

    def handle_endtag(self, tag):
        if tag in {'head', 'script', 'style', 'template'}:
            self.hidden = max(0, self.hidden - 1)
        if tag in {'p', 'div', 'aside', 'li', 'h1', 'h2', 'h3', 'tr'}:
            self.text.append(' ')
            self.spans.append(None)

    def handle_data(self, data):
        if not self.hidden:
            start = self.source_offset()
            self.text.extend(data)
            self.spans.extend((start + i, start + i + 1) for i in range(len(data)))

    def entity(self, value):
        if not self.hidden:
            start = self.source_offset()
            token = re.compile(r'&(?:#\w+|\w+);?').match(self.source, start)[0]
            decoded = html.unescape(token)
            self.text.extend(decoded)
            self.spans.extend([(start, start + len(token))] * len(decoded))

    handle_entityref = entity
    handle_charref = entity

    @cached_property
    def source_index(self):
        # Entity expansions may share spans; synthetic block spaces have none.
        positions = [i for i, span in enumerate(self.spans) if span]
        return (positions, [self.spans[i][0] for i in positions],
                [self.spans[i][1] for i in positions])

    def source_range(self, start, end):
        positions, starts, ends = self.source_index
        first = bisect_left(starts, start)
        stop = max(first, bisect_right(ends, end))
        return positions[first:stop]

    def source_neighbors(self, start, end):
        positions, starts, ends = self.source_index
        before, after = bisect_right(ends, start) - 1, bisect_left(starts, end)
        return (self.text[positions[before]] if before >= 0 else '',
                self.text[positions[after]] if after < len(positions) else '')

    def visible_offset(self, offset):
        positions, starts, _ = self.source_index
        index = bisect_left(starts, offset)
        return positions[index] if index < len(positions) else len(self.text)


def normalized(text, mapping):
    """Ignore layout whitespace and line-end hyphenation; retain source coordinates."""
    ignored = set()
    for match in re.finditer(r'(?<=\w)[-\u00ad]\s*\n\s*(?=\w)', text):
        ignored.update(range(match.start(), match.end()))
    pairs = [(c, mapping[i]) for i, c in enumerate(text)
             if not c.isspace() and c != '\u00ad' and i not in ignored]
    return ''.join(c for c, _ in pairs), [span for _, span in pairs]


class StyledText(VisibleText):
    def __init__(self, source):
        self.styles, self.stack = [], []
        super().__init__(source)

    def flags(self):
        return self.stack[-1][1] if self.stack else 0

    def handle_starttag(self, tag, attrs):
        before = len(self.text)
        super().handle_starttag(tag, attrs)
        self.styles.extend([0] * (len(self.text) - before))
        flags = self.flags()
        if tag in {'i', 'em'}:
            flags |= 2
        if tag in {'b', 'strong'}:
            flags |= 16
        style = dict(attrs).get('style', '') or ''
        for name, value in re.findall(r'([\w-]+)\s*:\s*([^;]+)', style.lower()):
            value = value.replace('!important', '').strip()
            if name == 'font-style':
                flags = (flags & ~2) | (2 if value in {'italic', 'oblique'} else 0)
            if name == 'font-weight':
                flags = (flags & ~16) | (16 if value in {'bold', 'bolder'} or value.isdigit() and int(value) >= 600 else 0)
        if tag not in {'br', 'img', 'meta', 'link', 'hr', 'input', 'wbr', 'source'}:
            self.stack.append((tag, flags))

    def handle_endtag(self, tag):
        before = len(self.text)
        super().handle_endtag(tag)
        self.styles.extend([0] * (len(self.text) - before))
        for i in range(len(self.stack)-1, -1, -1):
            if self.stack[i][0] == tag:
                del self.stack[i:]
                break

    def handle_data(self, data):
        before = len(self.text)
        super().handle_data(data)
        self.styles.extend([self.flags()] * (len(self.text) - before))

    def entity(self, value):
        before = len(self.text)
        super().entity(value)
        self.styles.extend([self.flags()] * (len(self.text) - before))

    handle_entityref = entity
    handle_charref = entity


