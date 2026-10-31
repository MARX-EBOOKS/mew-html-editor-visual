import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { launchBrowser, startServer, stopServer } from './support/browser.mjs';

const fixtures = JSON.parse(await readFile(new URL('./fixtures/pdf-normalization-me08-pages.json', import.meta.url), 'utf8'));
const opening = fixtures.find(fixture => fixture.number === 449);
const pdfStart = opening.raw.indexOf('^ o Stieber');
fixtures.push(...['Wie', 'Stieber', 'weiß', 'Hypothesen'].map(to => ({ ...opening, selection: {
  from: 'Wie', to, pdfStart, pdfEnd: to === 'Wie' ? pdfStart + 3 : opening.raw.indexOf(to, pdfStart) + to.length
} })));
for (const [number, from, to, pdfStart, pdfEnd] of [
  [432, 'Man verstehe', 'Man', 2231, 2234],
  [432, 'Man verstehe', 'Beweise', 2231, 2263],
  [432, 'Man verstehe', 'Beweise?', 2231, 2375],
  [247, 'Komödieneffekte', 'Komödieneffekte', 463, 474],
  [247, 'Komödieneffekte', 'neue', 463, 482],
  [457, 'Roten', 'Roten', 410, 415],
  [457, 'Roten', 'hochtönend', 410, 437]
]) fixtures.push({ ...fixtures.find(fixture => fixture.number === number), selection: { from, to, pdfStart, pdfEnd } });
const server = await startServer('reader-server.js', 17059);
let browser;
try {
  browser = await launchBrowser();
  for (const fixture of fixtures) {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/reader/settings', route => route.fulfill({ json: {
      diffHighlight: false, sourceDiffHighlight: true, selectionHighlight: true
    } }));
    await page.goto(`http://127.0.0.1:17059/?volume=8&page=${fixture.number}&mode=source`);
    await page.waitForFunction(() => window.readerMonaco?.editor && window.PdfSelection?.locator.environment.getTargets().some(t => t.layer), null, { timeout: 30000 });
    const expected = await page.evaluate(fixture => {
      const editor = readerMonaco.editor, model = editor.getModel(), locator = PdfSelection.locator;
      const index = locator.editorSourceIndex(model), visible = locator.environment.getVisiblePages().find(p => p.index?.layer);
      if (!visible) throw new Error('No rendered page');
      const target = visible.index, div = ReaderUI.getPdfViewer().getPageView(visible.number - 1).div;
      index?.diff([target], ReaderUI.getPdfViewer().pdfDocument);
      const start = index.raw.indexOf(fixture.selection.from), end = index.raw.indexOf(fixture.selection.to, start) + fixture.selection.to.length;
      const hit = index.connectedRange(target, start, end, false, undefined, true);
      if (!hit) throw new Error('No forward selection alignment');
      const measured = target.raw.slice(hit.start, hit.end), expected = fixture.raw.slice(fixture.selection.pdfStart, fixture.selection.pdfEnd);
      const reading = PdfSelectionDiff.significantText(measured), reference = PdfSelectionDiff.significantText(expected);
      if (reading !== reference)
        throw new Error('Wrong PDF selection: ' + JSON.stringify(measured));
      const range = window.PdfSelectionDiff.rangeAt(model, index.starts[start] ?? index.source.length,
        (end > start ? index.ends[(end) - 1] : index.starts[start]) ?? index.source.length);
      window.pageSelection = { index, target, div, hit, range, source: model.getValue() };
      return { start: model.getOffsetAt({ lineNumber: range.startLineNumber, column: range.startColumn }),
        end: model.getOffsetAt({ lineNumber: range.endLineNumber, column: range.endColumn }) };
    }, fixture);
    await page.evaluate(() => {
      const { target, hit } = pageSelection, first = target.parts.find(p => p.end > hit.start), last = target.parts.find(p => p.end >= hit.end);
      const range = document.createRange();
      range.setStart(first.node, hit.start - first.start);
      range.setEnd(last.node, hit.end - last.start);
      // Test reverse selection before any editor selection can seed a larger connection.
      readerMonaco.editor.setPosition({ lineNumber: 1, column: 1 });
      const selection = document.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    });
    await page.waitForFunction(expected => {
      const model = readerMonaco.editor.getModel(), range = readerMonaco.editor.getSelection();
      return model.getOffsetAt(range.getStartPosition()) === expected.start && model.getOffsetAt(range.getEndPosition()) === expected.end;
    }, expected, { timeout: 5000 });
    await page.evaluate(() => {
      document.getSelection().removeAllRanges();
      PdfSelection.clear();
      readerMonaco.editor.setPosition({ lineNumber: 1, column: 1 });
      readerMonaco.editor.setSelection(pageSelection.range);
    });
    await page.waitForFunction(() => PdfSelection.status.state === 'idle' && PdfSelection.status.matches === 1 && PdfReviewProvider.highlights.getHighlight(pageSelection.div));
    const painted = await page.evaluate(() => {
      const { div, target, hit } = pageSelection, actual = PdfReviewProvider.highlights.getHighlight(div);
      const expected = PdfReviewProvider.highlights.measureHighlights(div, target, [hit]).boxes;
      return { actual: actual.boxes, expected };
    });
    assert.deepEqual(painted.actual, painted.expected, `ME08-${fixture.number}: highlights cover the exact mapped range`);
    assert.equal(await page.evaluate(() => readerMonaco.editor.getValue() === pageSelection.source), true);
    assert.deepEqual(errors, []);
    console.log(`ME08-${fixture.number} ${fixture.selection.from} … ${fixture.selection.to}: exact forward highlight and native PDF-to-HTML selection passed`);
    await page.close();
  }
} finally {
  await browser?.close();
  await stopServer(server);
}
