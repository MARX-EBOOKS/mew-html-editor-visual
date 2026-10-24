from pathlib import Path
p=Path('public/pdfdiff/pdf-selection-diff.js')
s=p.read_text(encoding='utf-8')
a=s.index('    return connection.editorDiff ||= textDiff('); b=s.index('\n  sourceRange(',a)
s=s[:a]+'''    if (connection.editorDiff) return connection.editorDiff;
    const sides = [[this, connection.start, connection.end], [target, connection.targetStart, connection.targetEnd]]
      .map(([index, start, end]) => {
        const raw = index.raw.slice(start, end), offsets = [];
        let text = '';
        for (let at = 0; at < raw.length; at++) if (significantText(raw[at], index, start + at)) {
          text += raw[at]; offsets.push(at);
        }
        offsets.push(raw.length);
        return { raw, text, offsets };
      });
    const [left, right] = sides, diff = textDiff(left.text, right.text, true, 128), parts = [];
    let a = 0, b = 0, x = 0, y = 0;
    const append = (endA, endB, changed) => {
      appendPart(parts, left.raw.slice(x, endA), right.raw.slice(y, endB), changed);
      x = endA; y = endB;
    };
    // Align meaningful characters first; line wrapping never decides their correspondence.
    if (diff.distance <= 128) for (const part of diff.parts) {
      if (part.changed) {
        append(left.offsets[a], right.offsets[b], true);
        a += part.html.length; b += part.pdf.length;
        append(left.offsets[a - 1] + (part.html ? 1 : 0), right.offsets[b - 1] + (part.pdf ? 1 : 0), true);
      } else for (let at = 0; at < part.html.length; at++, a++, b++) {
        append(left.offsets[a], right.offsets[b], true);
        append(left.offsets[a] + 1, right.offsets[b] + 1, false);
      }
    }
    if (diff.distance <= 128) append(left.raw.length, right.raw.length, true);
    return connection.editorDiff = { distance: diff.distance, parts };
  }''' +s[b:]
# simplify preview context: no second inverse mapping table or PDF-line heuristic
start=s.index('      const projection = [];'); end=s.index('      for (const part of parts || []) {',s.index('      const project =',start))
s=s[:start]+s[end:]
start=s.index("          const lineStart = pdfRaw.lastIndexOf"); end=s.index('          const before =',start)
s=s[:start]+'''          const a = Math.max(0, from - 45), b = Math.min(this.raw.length, end + 45);
'''+s[end:]
s=s.replace("const add = (start, parts, pdfRaw = '', pdfStart = 0) => {",'const add = (start, parts) => {').replace('const from = start, end = start += part.html.length, at = pdfStart;\n        pdfStart += part.pdf.length;','const from = start, end = start += part.html.length;').replace('add(connection.start, this.connectionDiff(target, connection).parts, target.raw, connection.targetStart);','add(connection.start, this.connectionDiff(target, connection).parts);')
p.write_text(s,encoding='utf-8')
