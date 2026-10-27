import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { launchBrowser } from './support/browser.mjs';
import { engineSource, reviewFile } from './support/pdf-harness.mjs';

test('ME08-432 paints both missing word endings on first preparation without selection', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/pdf-selection-me08-432.json', import.meta.url), 'utf8'));
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.route('http://endings.test/**', async route => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<div id="editor" style="width:900px;height:600px"></div>' });
      if (!pathname.startsWith('/monaco/') || pathname.includes('..')) return route.abort();
      return route.fulfill({ contentType: pathname.endsWith('.css') ? 'text/css' : 'text/javascript',
        body: await readFile(new URL('../node_modules/monaco-editor/' + pathname.slice(8), import.meta.url)) });
    });
    await page.goto('http://endings.test/');
    await page.addScriptTag({ url: '/monaco/min/vs/loader.js' });
    await page.evaluate(() => new Promise(resolve => {
      require.config({ paths: { vs: '/monaco/min/vs' } }); require(['vs/editor/editor.main'], resolve);
    }));
    await page.addScriptTag({ content: engineSource });
    await page.addStyleTag({ content: reviewFile.match(/'(\.mew-ocr-diff-line\{[^']+)'/)[1] });
    const result = await page.evaluate(async fixture => {
      await PdfSelectionDiff.loadMonaco();
      const locator = new PdfReviewProvider.PdfLocator({}, { document });
      const index = locator.sourceIndex(fixture.source), target = new PdfSelectionDiff.PdfSourceIndex(locator, { raw: fixture.pdf });
      locator.prepareSource(index, [target]);
      const editor = monaco.editor.create(document.getElementById('editor'), { value: fixture.source, wordWrap: 'on' });
      const marks = index.sourceDecorations(index.connectionPairs([target]), editor.getModel());
      editor.createDecorationsCollection(marks); editor.render(true);
      const candidates = index.reviewCandidates([target]), endings = [];
      for (const [word, letter] of [['sag', 't'], ['Stiebe', 'r']]) {
        const at = index.raw.indexOf('sag Stiebe') + (word === 'sag' ? 3 : 10);
        const candidate = candidates.find(c => c.sourceStart === at && c.sourceEnd === at && c.comparison.pdf === letter);
        const offset = index.starts[at];
        const mark = marks.find(m => editor.getModel().getOffsetAt({ lineNumber: m.range.startLineNumber, column: m.range.startColumn }) === offset && m.options.before);
        const hit = index.connectedRange(target, at, at, false, undefined, true);
        endings.push({ word, letter, candidate: !!candidate, marked: !!mark,
          collapsed: mark && mark.range.startColumn === mark.range.endColumn,
          mapped: hit && target.raw.slice(hit.start, hit.end),
          corrected: candidate && PdfSelectionDiff.previewEdits(fixture.source, candidate.options[0].edits).includes(word + letter) });
      }
      return { endings, selection: editor.getSelection().isEmpty() };
    }, fixture);
    assert.equal(result.selection, true);
    for (const ending of result.endings) assert.deepEqual(ending,
      { word: ending.word, letter: ending.letter, candidate: true, marked: true, collapsed: true, mapped: ending.letter, corrected: true });
    const markers = page.locator('.mew-ocr-diff-insert');
    assert.ok(await markers.count() >= 2);
    for (const node of await markers.all()) {
      const box = await node.boundingBox();
      assert.ok(box.width > 0 && box.height > 0, 'insertion markers occupy visible pixels');
    }
  } finally { await browser.close(); }
});
