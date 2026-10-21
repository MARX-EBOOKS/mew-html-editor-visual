from pathlib import Path
root = Path('public/pdfdiff')
p = root/'pdf-selection-diff.js'; engine=p.read_text(encoding='utf-8')
helper=(root/'local-text-diff.js').read_text(encoding='utf-8')
# Inline the existing implementations into their owners; remove every forwarding wrapper.
local=helper[helper.index('  // A Levenshtein wavefront'):helper.index('  function compare(')]
local=local.replace('  function textDiff(', '  function localTextDiff(',1)
comparison=helper[helper.index('  function compare('):helper.index('  function createMatcher(')]
comparison=comparison.replace('function compare(computer, left, right, details = false, limit = Infinity)',
                              'function textDiff(left, right, details = false, limit = Infinity)')
comparison=comparison.replace('return textDiff(', 'return localTextDiff(')
comparison=comparison.replace('monacoTextDiff(computer, left, right, details)', 'monacoTextDiff(left, right, details)')
comparison=comparison.replace('function monacoTextDiff(computer, left, right, details = false)',
                              'function monacoTextDiff(left, right, details = false)')
comparison=comparison.replace('const refined = textDiff(', 'const refined = localTextDiff(')
matcher=helper[helper.index('    function anchorMatches('):helper.index('  function validateEdits(')].rstrip()
assert matcher.endswith('  }'); matcher=matcher[:-3].rstrip()+'\n'
edits=helper[helper.index('  function validateEdits('):helper.rindex('})();')]
a=engine.index('  function rangeAt(...args)');b=engine.index('  function createLocator(',a)
engine=engine[:a]+local+comparison+edits+engine[b:]
engine=engine.replace('''    const { anchorMatches, normalized, matches, normalizedRange, locate, approximateMatches, lowerBound }
      = window.PdfLocalTextDiff.createMatcher(options, textDiff);
''','')
engine=engine.replace('    function sourceIndex(source) {',matcher+'    function sourceIndex(source) {')
engine=engine.replace("      if (!window.PdfLocalTextDiff) await import('./local-text-diff.js');\n",'')
engine=engine.replace('const runs = [], { lowerBound } = window.PdfLocalTextDiff;', 'const runs = [];')
engine=engine.replace('    textDiff, connectionDiff, differences,', '    textDiff, localTextDiff, connectionDiff, differences,')
# The shared OCR page read starts its font metadata task once, using these exact text items.
a=engine.index('  function readPageText(');b=engine.index('  function significantText(',a)
engine=engine[:a]+'''  function readPageText(page) {
    if (!pageTexts.has(page)) pageTexts.set(page, Promise.resolve().then(() => page.getTextContent()).then(content => {
      const result = { ...content };
      result.fontTask = readPageFonts(page, content.items).catch(() => new Map()).then(fonts => result.fonts = fonts);
      return result;
    }).catch(error => { pageTexts.delete(page); throw error; }));
    return pageTexts.get(page);
  }

'''+engine[b:]
engine=engine.replace('const fonts = await readPageFonts(page, items);', 'const fonts = await content.fontTask;')
engine=engine.replace('''        const pages = [], mapped = { text: "", starts: [], ends: [] };
        for''','''        const pages = [], mapped = { text: "", starts: [], ends: [] };
        const index = { pages, fontVersion: 0, normalized: mapped, connections: new WeakMap(), pageScopes: new WeakMap() };
        for''')
engine=engine.replace('''            parts.push({ start: start + pageRaw.length, end: start + pageRaw.length + item.str.length, item });''','''            parts.push({ start: start + pageRaw.length, end: start + pageRaw.length + item.str.length,
              item, font: textItemFont(content.fonts, item) });''')
engine=engine.replace('''          pages.push({ number, start, end: start + pageRaw.length, parts });''','''          const entry = { number, start, end: start + pageRaw.length, parts };
          entry.fontTask = content.fontTask.then(fonts => {
            for (const part of parts) part.font = textItemFont(fonts, part.item);
            index.fontVersion++;
            if (cached.index && environment.isCurrent(pdf)) environment.onIndexed?.();
          });
          pages.push(entry);''')
engine=engine.replace('''        cached.index = { raw, pages, normalized: mapped, connections: new WeakMap(), pageScopes: new WeakMap() };''','''        index.raw = raw;
        cached.index = index;''')
a=engine.index('    async function indexFonts(');b=engine.index('    function prepareSource(',a)
engine=engine[:a]+'''    async function indexFonts(pdf, source, signal) {
      const index = await indexDocument(pdf);
      if (!index || signal?.aborted) return null;
      const ranges = source?.connections.get(index);
      await Promise.all(index.pages.filter(page => !source || ranges?.some(hit => hit.targetStart < page.end
        && hit.targetEnd > page.start)).map(page => page.fontTask));
      return !signal?.aborted && environment.isCurrent(pdf) ? index : null;
    }
'''+engine[b:]
p.write_text(engine,encoding='utf-8')
print('Merged engine:',len(engine.splitlines()),'lines')
