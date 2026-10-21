from pathlib import Path
p=Path('tests/replacement-review-browser.mjs');s=p.read_text(encoding='utf-8')
a=s.index("'PDF selection opens the same native source widget'")
head,tail=s[:a],s[a:]
tail=tail.replace("assert.equal(await page.evaluate(() => testEditor.getSelection().isEmpty()), true, 'opening review preserves the click caret');", "assert.equal(await page.evaluate(() => testEditor.getModel().getValueInRange(testEditor.getSelection())), 'X');",1)
p.write_text(head+tail,encoding='utf-8')
p=Path('tests/pdf-selection-diff.test.mjs');s=p.read_text(encoding='utf-8')
s += r'''

test('text candidates, font candidates and decorations reuse one traversal and refresh font metadata', () => {
  const api = engine(), provider = reviewProvider(api);
  const locator = api.createLocator({}, { document: { createElement: () => ({}) } });
  const index = locator.sourceIndex('Alpha beta gamma');
  const target = { raw: 'Alpha beta GAMMA', fontVersion: 0, parts: [
    { start: 0, end: 6, font: { bold: false, italic: false } },
    { start: 6, end: 10, font: { bold: true, italic: false } },
    { start: 10, end: 16, font: { bold: false, italic: false } }
  ] };
  const connection = locator.rememberConnection(index, 0, index.raw.length, target, { start: 0, end: target.raw.length });
  let reads = 0;
  connection.editorDiff = { parts: [
    { html: 'Alpha beta ', pdf: 'Alpha beta ', changed: false },
    { html: 'gamma', pdf: 'GAMMA', changed: true }
  ].map(part => new Proxy(part, { get(object, key) { reads++; return object[key]; } })) };
  const items = api.reviewCandidates(index, [target]);
  const traversed = reads;
  const fonts = api.formatDifferences(index, [[connection, target]]);
  const model = { getPositionAt: offset => ({ lineNumber: 1, column: offset + 1 }) };
  const marks = provider.sourceDecorations(index, [[connection, target]], model);
  assert.equal(reads, traversed, 'review and highlight consumers share the classified spans');
  assert.deepEqual(Array.from(items, item => item.comparison.pdf), ['GAMMA']);
  assert.deepEqual(Array.from(fonts, item => item.text), ['beta']);
  assert.equal(marks.filter(mark => mark.options.description === 'PDF OCR text difference').length, 1);
  assert.equal(marks.filter(mark => mark.options.description === 'PDF font difference').length, 1);
  target.parts[1].font.bold = false;
  target.fontVersion++;
  assert.equal(api.formatDifferences(index, [[connection, target]]).length, 0);
  assert.ok(reads > traversed, 'new font metadata invalidates classification');
  assert.equal(api.reviewCandidates(index, [target])[0].comparison.pdf, 'GAMMA');
});

test('transient mapping eviction preserves every prepared passage and recent selections', () => {
  const locator = engine().createLocator({}, { document: { createElement: () => ({}) } });
  const index = locator.sourceIndex('a'.repeat(400)), target = locator.sourceIndex(index.raw);
  for (let start = 0; start < 360; start++)
    locator.rememberConnection(index, start, start + 1, target, { start, end: start + 1 }, null, start < 160);
  const retained = index.connections.get(target);
  assert.equal(retained.filter(item => item.prepared).length, 160, 'required mappings are never evicted');
  assert.equal(retained.filter(item => !item.prepared).length, 128, 'selection history has a fixed bound');
  assert.equal(locator.connectedRange(index, target, 0, 1).start, 0);
  assert.equal(locator.connectedRange(index, target, 359, 360).start, 359);
  assert.equal(locator.connectedRange(index, target, 160, 161), null);
});
'''
p.write_text(s,encoding='utf-8')
p=Path('tests/pdf-selection-highlight.test.mjs');s=p.read_text(encoding='utf-8')
s += r'''

test('scrolling across retained PDF pages bounds DOM caches and revisits rebuild current highlights', async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<div id="stage" style="height:500px;overflow:auto"><div class="pdfViewer"></div></div>');
    await page.evaluate(() => {
      for (let number = 1; number <= 70; number++) {
        const div = document.createElement('div');
        div.className = 'page'; div.dataset.pageNumber = number;
        div.style.cssText = 'position:relative;width:600px;height:100px';
        div.innerHTML = `<div class="textLayer"><span>Page ${number} text</span></div>`;
        document.querySelector('.pdfViewer').append(div);
      }
    });
    await page.addScriptTag({ content: engineSource });
    await page.evaluate(() => { PdfSelectionDiff.loadMonaco = async () => true; });
    await page.addScriptTag({ content: source.replace('  const layers = new Map();',
      '  const layers = new Map(); window.cacheProbe = { layerIndex, nativeBoxes, size: () => layers.size, results: div => pageResults.get(div)?.results.size };') });
    await page.waitForFunction(() => !!window.PdfSelection);
    const result = await page.evaluate(() => {
      const pages = [...document.querySelectorAll('.page')];
      PdfSelection.attachViewer({ container: document.getElementById('stage'), viewer: document.querySelector('.pdfViewer'),
        currentPageNumber: 1, _getVisiblePages: () => ({ views: [{ id: 1 }] }),
        getPageView: index => ({ div: pages[index] }), eventBus: { on() {}, off() {} },
        pdfDocument: { numPages: 0 } });
      const first = cacheProbe.layerIndex(pages[0]);
      for (const div of pages) cacheProbe.layerIndex(div);
      const retained = cacheProbe.size();
      const revisited = cacheProbe.layerIndex(pages[0]);
      const rebuilt = first !== revisited;
      const makeSource = () => PdfSelection.locator.sourceIndex(revisited.raw);
      const original = makeSource();
      const target = { index: original, start: 0, end: 4, range: { start: 0, end: 4 } };
      for (let i = 0; i < 80; i++) cacheProbe.nativeBoxes(pages[0], [], [{ ...target, text: String(i) }]);
      const results = cacheProbe.results(pages[0]);
      const refreshed = makeSource();
      const boxes = cacheProbe.nativeBoxes(pages[0], [], [{ ...target, index: refreshed }]);
      const currentSource = boxes.notices[0].source.index === refreshed;
      const reuse = boxes === cacheProbe.nativeBoxes(pages[0], [], [{ ...target, index: refreshed }]);
      PdfSelection.stop();
      return { retained, rebuilt, results, currentSource, reuse, afterStop: cacheProbe.size(), boxes: boxes.boxes.length };
    });
    assert.equal(result.retained, 24);
    assert.equal(result.rebuilt, true, 'evicted pages build a fresh node index when revisited');
    assert.equal(result.results, 32);
    assert.equal(result.currentSource, true, 'cached notices never retain an obsolete source snapshot');
    assert.equal(result.reuse, true, 'unchanged selections reuse measured geometry');
    assert.ok(result.boxes > 0, 'revisited pages still paint the selected text');
    assert.equal(result.afterStop, 0, 'stopping releases retained layer observers');
  } finally { await browser.close(); }
});
'''
p.write_text(s,encoding='utf-8')
