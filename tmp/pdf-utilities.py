from pathlib import Path
p=Path('public/pdfdiff/pdf-selection-diff.js');s=p.read_text(encoding='utf-8')
s=s.replace('const documents = new WeakMap(), sourceIndexes = new WeakMap();','const documents = new WeakMap(), sourceIndexes = new WeakMap(), noPdf = {};')
s=s.replace('''      const pdf = environment.getPdf?.(), version = model.getVersionId?.();
      const saved = sourceIndexes.get(model), previous = saved?.pdf === pdf ? saved?.index : null;''','''      let pairs = sourceIndexes.get(model);
      if (!pairs) sourceIndexes.set(model, pairs = new WeakMap());
      const pdf = environment.getPdf?.() || noPdf;
      const previous = pairs.get(pdf), version = model.getVersionId?.();''')
s=s.replace('      sourceIndexes.set(model, { pdf, index });','      pairs.set(pdf, index);')
a=s.index('  function sourceSegments('); b=s.index('  function validateEdits(',a)
edits=s[a:b]
s=s[:a]+'''  function sourceSegments(...args) { return window.PdfLocalTextDiff.sourceSegments(...args); }
  function insertionSegment(...args) { return window.PdfLocalTextDiff.insertionSegment(...args); }
  function textEdits(...args) { return window.PdfLocalTextDiff.textEdits(...args); }
'''+s[b:];p.write_text(s,encoding='utf-8')
p=Path('public/pdfdiff/local-text-diff.js');s=p.read_text(encoding='utf-8')
s=s.replace('applyEdits, lowerBound };','applyEdits, lowerBound, sourceSegments, insertionSegment, textEdits };')
s=s.rsplit('})();',1)[0]+edits+'})();\n';p.write_text(s,encoding='utf-8')
print('engine lines',len(Path('public/pdfdiff/pdf-selection-diff.js').read_text(encoding='utf-8').splitlines()))
