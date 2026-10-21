from pathlib import Path
p=Path('public/pdfdiff/pdf-selection-diff.js');s=p.read_text(encoding='utf-8')
# Retain the current model/PDF snapshot only, rather than every previously opened pair.
s=s.replace('const documents = new WeakMap(), sourceIndexes = new WeakMap(), noPdf = {};','const documents = new WeakMap(), sourceIndexes = new WeakMap();')
s=s.replace('''      let pairs = sourceIndexes.get(model);
      if (!pairs) sourceIndexes.set(model, pairs = new WeakMap());
      const pdf = environment.getPdf?.() || noPdf;
      const previous = pairs.get(pdf), version = model.getVersionId?.();''','''      const pdf = environment.getPdf?.(), version = model.getVersionId?.();
      const saved = sourceIndexes.get(model), previous = saved?.pdf === pdf ? saved?.index : null;''')
s=s.replace('      pairs.set(pdf, index);','      sourceIndexes.set(model, { pdf, index });')
s=s.replace('.slice(0, Math.max(16, Math.ceil(source.raw.length / 64)))','.slice(0, 128)')
# Binary lookup avoids allocating/scanning every part of a complete volume for each connection.
a=s.index('  function fontRuns(');b=s.index('  function fontSummary(',a)
s=s[:a]+'''  function fontRuns(index, start = 0, end = index.raw.length) {
    const runs = [], { lowerBound } = window.PdfLocalTextDiff.createMatcher({}, textDiff);
    const pages = index.parts ? [index] : index.pages || [];
    for (let page = lowerBound(pages, start + 1, page => page.end ?? index.raw.length);
      page < pages.length && (pages[page].start ?? 0) < end; page++) {
      const parts = pages[page].parts;
      for (let i = lowerBound(parts, start + 1, part => part.end); i < parts.length && parts[i].start < end; i++) {
        const part = parts[i], a = Math.max(start, part.start), b = Math.min(end, part.end);
        if (a >= b || !index.raw.slice(a, b).trim()) continue;
        const style = part.font || { name: '', italic: null, bold: null }, last = runs.at(-1);
        if (last && last.italic === style.italic && last.bold === style.bold && last.name === style.name
          && !index.raw.slice(last.end, a).trim()) last.end = b;
        else runs.push({ ...style, start: a, end: b });
      }
    }
    return runs;
  }
'''+s[b:]
# Font metadata publishes styles by font id. Text-item identity lookup needs no JSON key per glyph.
s=s.replace("    return fonts?.get(JSON.stringify([item.fontName, item.str, item.transform, item.width])) || fonts?.get(item.fontName);", "    return fonts?.get(item) || fonts?.get(item.fontName);")
# One cache record shares pending document indexing and retries a cancelled/failed build.
a=s.index('    async function indexDocument(');b=s.index('    function findLocations(',a)
block=s[a:b]
block=block.replace('''      const index = await cached.task;
      if (!index) documents.delete(pdf);
      return index;''','''      return cached.task;''')
block=block.replace('''      })().catch(error => {
        documents.delete(pdf);
        throw error;
      });''','''      })().then(index => {
        if (!index) documents.delete(pdf);
        return index;
      }, error => { documents.delete(pdf); throw error; });''')
s=s[:a]+block+s[b:]
p.write_text(s,encoding='utf-8')
# Bound page DOM and measurement caches where they are actually owned.
p=Path('public/pdfdiff/pdf-selection.js');s=p.read_text(encoding='utf-8')
s=s.replace('  const layers = new Map();','  const layers = new Map();\n  const maxLayerCache = 24, maxPageResults = 8;')
s=s.replace('for (const div of layers.keys()) if (!div.isConnected) clearLayer(div);','for (const [div, index] of layers) if (!div.isConnected || !index.layer.isConnected) clearLayer(div);')
old='''    if (cached?.layer === layer && cached.pdf === viewer?.pdfDocument && cached.width === div.clientWidth && cached.height === div.clientHeight && !cached.observer.takeRecords().length) return cached;'''
new='''    if (cached?.layer === layer && cached.pdf === viewer?.pdfDocument && cached.width === div.clientWidth
      && cached.height === div.clientHeight && !cached.observer.takeRecords().length) {
      layers.delete(div);
      layers.set(div, cached);
      return cached;
    }'''
assert old in s;s=s.replace(old,new)
s=s.replace('    layers.set(div, index);\n    return index;','''    layers.set(div, index);
    while (layers.size > maxLayerCache) clearLayer(layers.keys().next().value);
    return index;''')
s=s.replace('if (cached.results.size > 32)', 'if (cached.results.size > maxPageResults)')
p.write_text(s,encoding='utf-8')
print('engine lines',len(Path('public/pdfdiff/pdf-selection-diff.js').read_text(encoding='utf-8').splitlines()))
