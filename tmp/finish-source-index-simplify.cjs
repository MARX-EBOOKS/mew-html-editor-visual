const fs = require('fs');
const file = 'public/pdfdiff/pdf-review-provider.js';
const baseline = fs.readFileSync('tmp/pdf-source-index-simplify-before.js', 'utf8').replace(/\r\n/g, '\n');
const current = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
const prefix = current.slice(0, current.indexOf('\n}\nif (scope)'));
const matches = `
    }
    if (scope) scope.normalized = this.normalizedRange(scope.start, scope.end);
    this.pageScopes.set(page, { scope, prepared: connect });
    return scope;
  }
  *matchPositions(needle, { text }, anchors) {
    if (!anchors) {
      for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + 1)) yield at;
      return;
    }
    // Index aligned 16-character blocks to find 32-character anchors without full rescans.
    this.anchorBlocks ||= Map.groupBy(Array.from({ length: Math.floor(text.length / 16) }, (_, i) => i * 16),
      at => text.slice(at, at + 16));
    for (let offset = 0; offset < 16 && offset + 16 <= needle.length; offset++) {
      for (const position of this.anchorBlocks.get(needle.slice(offset, offset + 16)) || []) {
        const at = position - offset;
        if (at >= 0 && text.startsWith(needle, at)) yield at;
      }
    }
  }
  matches(queries, haystack = this.normalized, anchors = false) {
    const found = new Map(), word = char => !!char && /[\\p{L}\\p{N}_]/u.test(char);
    for (const query of queries) {
      const needle = anchors ? query : this.locator.normalized(query).text.trim();
      if (!needle) continue;
      for (const at of this.matchPositions(needle, haystack, anchors)) {
        const end = at + needle.length;
        const before = [...haystack.text.slice(Math.max(0, at - 2), at)].pop(), after = [...haystack.text.slice(end, end + 2)][0];
        if (!this.locator.options.wholeWords || ((!word(needle[0]) || !word(before)) && (!word([...needle].pop()) || !word(after)))) {
          const start = haystack.starts[at], stop = haystack.ends[end - 1];
          found.set(\x60\x24{start}:\x24{stop}\x60, { start, end: stop });
          if (anchors && found.size > 1) return [...found.values()]; // Only unique anchors are useful.
        }
      }
    }
    return [...found.values()];
  }
`;
let suffix = baseline.slice(baseline.indexOf('  normalizedRange(start, end) {'));
suffix = suffix.replace('return start === 0 && end === this.raw.length && this.normalized\n      ? this.normalized :', 'return start === 0 && end === this.raw.length ? this.normalized :');
suffix = suffix.replace('    const a = raw ? start - offset : this.locator.lowerBound(from.ends, start - offset + 1),\n      b = raw ? end - offset : this.locator.lowerBound(from.starts, end - offset);',
  '    const { start: a, end: b } = raw ? { start: start - offset, end: end - offset } : this.rawRange(start - offset, end - offset, from);');
suffix = suffix.replace('    const selected = (reverse ? target : this).raw.slice(start, end),\n      mapped = (reverse ? this : target).raw.slice(hit.start, hit.end);\n    hit.approximate = toolbox.significantText(selected) !== toolbox.significantText(mapped);\n    return hit;',
  '    return { ...hit, approximate: toolbox.significantText((reverse ? target : this).raw.slice(start, end))\n      !== toolbox.significantText((reverse ? this : target).raw.slice(hit.start, hit.end)) };');
const result = prefix + matches + suffix;
if (!prefix.includes('scope = { start: Math.max(to.starts[start]')) throw Error('Missing prefix');
if (result.slice(result.indexOf('class PdfLocator')) !== baseline.slice(baseline.indexOf('class PdfLocator'))) throw Error('Unrelated changes');
fs.writeFileSync(file, result);
console.log('Lines:', result.split('\n').length - Number(result.endsWith('\n')));
