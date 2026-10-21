from pathlib import Path
p=Path('public/pdfdiff/pdf-selection-diff.js'); s=p.read_text(encoding='utf-8')
# A single cached walk publishes both kinds of difference, with raw offsets attached.
a=s.index('  // Compare formatting only'); b=s.index('    // Merge adjacent format changes',a)
s=s[:a]+'''  const analyses = new WeakMap();
  function differences(index, target, connection) {
    const diff = connectionDiff(index, target, connection);
    const cached = analyses.get(connection);
    if (cached?.index === index && cached.target === target && cached.diff === diff
      && cached.fontVersion === target.fontVersion) return cached;
    const result = { index, target, diff, fontVersion: target.fontVersion, text: [], fonts: [], spans: [] };
    const runs = index.formats ? fontRuns(target, connection.targetStart, connection.targetEnd) : [];
    let left = connection.start, right = connection.targetStart, run = 0;
    for (const part of diff?.parts || []) {
      const end = left + part.html.length, stop = right + part.pdf.length;
      const span = { ...part, start: left, end, pdfStart: right, pdfEnd: stop };
      if (part.pdf.length) result.spans.push(span);
      if (part.changed) {
        if (significantText(part.html, index, left) !== significantText(part.pdf)) result.text.push(span);
      } else {
        while (run < runs.length && runs[run].end <= right) run++;
        for (let i = run; i < runs.length && runs[i].start < stop; i++) {
          const font = runs[i], limit = left + Math.min(stop, font.end) - right;
          let start = left + Math.max(right, font.start) - right;
          while (start < limit) {
            const htmlFont = index.formats[start];
            let end = start + 1;
            while (end < limit && index.formats[end] === htmlFont) end++;
            if (htmlFont && ['italic', 'bold'].some(key => typeof font[key] === 'boolean' && font[key] !== htmlFont[key])) {
              const text = index.raw.slice(start, end);
              const a = start + text.length - text.trimStart().length, b = end - text.length + text.trimEnd().length;
              if (a < b) result.fonts.push({ sourceStart: a, sourceEnd: b, font, htmlFont, formats: [{ font, htmlFont }] });
            }
            start = end;
          }
        }
      }
      left = end;
      right = stop;
    }
    analyses.set(connection, result);
    return result;
  }
  function formatDifferences(index, connections) {
    const items = new Map();
    for (const [connection, target] of connections)
      for (const item of differences(index, target, connection).fonts)
        items.set(`${item.sourceStart}:${item.sourceEnd}`, item);
''' + s[b:]
# Never mutate cached format runs while joining presentation ranges.
s=s.replace('if (!joins) { merged.push(item); continue; }','if (!joins) { merged.push({ ...item, formats: [...item.formats] }); continue; }')
s=s.replace('textDiff, connectionDiff, sourceSegments,', 'textDiff, connectionDiff, differences, sourceSegments,')
# Generic edit checks belong with the shared text helpers.
a=s.index('  function validateEdits('); b=s.index('  function applyEdits(',a)
utilities=s[a:b]
s=s[:a]+'''  function validateEdits(...args) { return window.PdfLocalTextDiff.validateEdits(...args); }
  function previewEdits(...args) { return window.PdfLocalTextDiff.previewEdits(...args); }
'''+s[b:]
l=Path('public/pdfdiff/local-text-diff.js'); t=l.read_text(encoding='utf-8')
t=t.replace('appendPart, createMatcher };','appendPart, createMatcher, validateEdits, previewEdits };')
t=t.rsplit('})();',1)[0]+utilities+'})();\n'; l.write_text(t,encoding='utf-8')
# Existing prepared format edits are reused by callers; no full source prefix/suffix scan.
a=s.index('        let left = nearby && new RegExp(');b=s.index('        const wrapper =',a)
s=s[:a]+'''        const before = nearby && index.formats[start - 1]?.tags.findLast(tag => tag[key] === true
          && tag.opening.toLowerCase() === `<${tag.name}>` && tag.closeEnd <= a
          && keys.every(other => other === key || tag[other] === null || tag[other] === original[other])
          && /^[ \\t]*$/.test(index.source.slice(tag.closeEnd, a)));
        const after = nearby && index.formats[end]?.tags.find(tag => tag[key] === true
          && tag.opening.toLowerCase() === `<${tag.name}>` && tag.openStart >= b
          && /^[ \\t]*$/.test(index.source.slice(b, tag.openStart)));
        const left = before && [index.source.slice(before.closeStart, a), before.name, index.source.slice(before.closeEnd, a)];
        const right = after && (!left || after.name === left[1])
          && [index.source.slice(b, after.openEnd), index.source.slice(b, after.openStart), after.name];
        const name = key === 'italic' ? 'i' : 'b';
'''+s[b:]
p.write_text(s,encoding='utf-8')
print('engine',len(s.splitlines()))
