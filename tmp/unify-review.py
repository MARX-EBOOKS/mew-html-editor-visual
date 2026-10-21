from pathlib import Path
p=Path('public/pdfdiff/pdf-selection-diff.js');s=p.read_text(encoding='utf-8')
a=s.index('    const add = (start, parts,'); b=s.index('    return items.sort(',a)
s=s[:a]+'''    const add = (data, pdfRaw = '') => {
      const project = (offset, endBias) => {
        const spans = data.spans;
        let low = 0, high = spans.length;
        while (low < high) {
          const middle = (low + high) >>> 1;
          if (spans[middle].pdfEnd < offset) low = middle + 1; else high = middle;
        }
        const hit = spans[low];
        if (!hit) return data.text.at(-1)?.end ?? 0;
        if (!hit.changed) return hit.start + Math.max(0, offset - hit.pdfStart);
        return offset <= hit.pdfStart ? hit.start : endBias || offset === hit.pdfEnd ? hit.end : hit.start;
      };
      for (const { start, end, html: from, pdf, pdfStart } of data.text) {
        if (!claim(start, end)) continue;
        const lineStart = pdfRaw.lastIndexOf('\\n', Math.max(0, pdfStart - 1)) + 1;
        const nextLine = pdfRaw.indexOf('\\n', pdfStart + pdf.length);
        const a = Math.max(0, pdfRaw ? Math.min(start, project(lineStart, false)) : index.raw.lastIndexOf('\\n', Math.max(0, start - 1)) + 1);
        const lineEnd = pdfRaw ? project(nextLine < 0 ? pdfRaw.length : nextLine, true) : index.raw.indexOf('\\n', end);
        const b = Math.min(index.raw.length, lineEnd < 0 ? index.raw.length : Math.max(end, lineEnd));
        const html = index.raw.slice(a, b);
        items.push({ id: `${start}:${end}`, sourceStart: start, sourceEnd: end, previewStart: a, previewEnd: b,
          preview: { html, pdf: index.raw.slice(a, start) + pdf + index.raw.slice(end, b) },
          comparison: { html: from, pdf }, options: [{ id: 'pdf', label: '替换', edits: textEdits(index, start, end, pdf) }] });
      }
    };
    for (const target of targets.filter(Boolean)) for (const connection of index.connections.get(target) || [])
      add(differences(index, target, connection), target.raw);
    if (notice?.source && index.raw.slice(notice.source.start, notice.source.end) === notice.html)
      add(differences(index, { raw: notice.pdf }, { start: notice.source.start, end: notice.source.end,
        targetStart: 0, targetEnd: notice.pdf.length, editorDiff: { parts: selectedParts || textDiff(notice.html, notice.pdf, true)?.parts } }));
'''+s[b:]
# Keep neighboring format lookup local even when whitespace sits outside a wrapper.
s=s.replace("        const pattern = key === 'italic' ? 'i|em' : 'b|strong';\n",'')
s=s.replace("        const before = nearby && index.formats[start - 1]?.tags.findLast", "        let previous = start - 1, next = end;\n        while (previous >= 0 && /[ \\t]/.test(index.raw[previous])) previous--;\n        while (next < index.raw.length && /[ \\t]/.test(index.raw[next])) next++;\n        const before = nearby && index.formats[previous]?.tags.findLast")
s=s.replace('const after = nearby && index.formats[end]?.tags.find', 'const after = nearby && index.formats[next]?.tags.find')
p.write_text(s,encoding='utf-8')
p=Path('public/pdfdiff/pdf-review-provider.js');s=p.read_text(encoding='utf-8')
a=s.index('    for (const [connection, target] of connections) {',s.index('  function sourceDecorations'));b=s.index('    for (const item of toolbox.formatDifferences(',a)
s=s[:a]+'''    const escape = text => JSON.stringify(text.trim() ? text : '').replace(/[\\\\`*_{}\\[\\]()#+.!<>|~-]/g, '\\\\$&');
    for (const [connection, target] of connections) {
      for (const { start, end, html, pdf } of toolbox.differences(index, target, connection).text)
        add(start === end ? [toolbox.insertionSegment(index, start)] : toolbox.sourceSegments(index, start, end), '', {
          description: 'PDF OCR text difference',
          inlineClassName: html.length ? 'mew-ocr-diff-text' : undefined,
          beforeContentClassName: html.length ? undefined : 'mew-ocr-diff-insert',
          hoverMessage: { value: 'HTML: ' + escape(html) + '\\n\\nOCR: ' + escape(pdf), isTrusted: false },
          linesDecorationsTooltip: 'Text differs from PDF OCR'
        });
    }
'''+s[b:]
# Prepared candidate edits already belong to this exact model/source version.
a=s.index('    if (all || item?.font)');b=s.index('    const checked = toolbox.validateEdits',a)
s=s[:a]+'''    const key = item && pattern(item), selected = all ? state.items : state.items.filter(value => pattern(value) === key);
    const edits = selected.flatMap(value => value.options.find(option => option.id === state.choices.get(value.id)).edits);
'''+s[b:]
# Avoid per-click byte serialization; it only guarded synchronous code without awaits.
s=s.replace('  let dismissed = null, differenceRequest = 0;','  let dismissed = null;')
s=s.replace('  async function onDifference(event) {','  function onDifference(event) {')
s=s.replace("    const request = ++differenceRequest, version = model?.getVersionId?.();\n    if (request !== differenceRequest || editor?.getModel() !== model || model?.getVersionId?.() !== version) return;\n",'')
p.write_text(s,encoding='utf-8')
print('engine',len(Path('public/pdfdiff/pdf-selection-diff.js').read_text(encoding='utf-8').splitlines()))
