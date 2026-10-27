import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchBrowser, startServer, stopServer } from './support/browser.mjs';

const fixture = await mkdtemp(path.join(tmpdir(), 'mew-font-selection-'));
let server, browser;
try {
  await writeFile(path.join(fixture, 'a.html'), '<p>Before the selected passage <i>Word</i> after the selected passage. Another WRONG reading followed by enough unique context to confirm the text fault.</p>');
  server = await startServer('server.js', 41883, ['-r', fixture]);
  browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/reader/settings', route => route.fulfill({ json: { diffHighlight: true, sourceDiffHighlight: true, selectionHighlight: true } }));
  await page.goto('http://127.0.0.1:41883/?file=a.html');
  await page.waitForFunction(() => window.mewWorkbench?.editor.getValue().includes('<i>Word</i>'));
  await page.addScriptTag({ url: '/pdfdiff/pdf-selection.js' });
  await page.waitForFunction(() => window.PdfSelection);
  await page.evaluate(() => {
    window.testEditor = mewWorkbench.editor;
    const stage = document.createElement('div');
    stage.id = 'fontStage';
    stage.style.cssText = 'position:fixed;right:10px;top:650px;width:850px;height:250px;overflow:auto;background:white';
    stage.innerHTML = '<div class="pdfViewer"><div class="page" data-page-number="1" style="position:relative;width:850px;height:250px"><div class="textLayer" style="font:18px monospace"><span role="presentation">Before the selected passage Word after the selected passage. Another RIGHT reading followed by enough unique context to confirm the text fault.</span></div></div></div>';
    document.body.append(stage);
    const div = stage.querySelector('.page'), raw = div.textContent;
    const viewer = { container: stage, viewer: stage.firstChild, currentPageNumber: 1,
      _getVisiblePages: () => ({ views: [{ id: 1 }] }), getPageView: () => ({ div }), eventBus: { on() {}, off() {} },
      pdfDocument: { numPages: 1, async getPage() { return { async getTextContent() {
        return { items: [{ str: raw, transform: [1, 0, 0, 1, 0, 500], width: 800, height: 18 }] };
      } }; } } };
    window.ReaderUI = { getPdfViewer: () => viewer };
    PdfSelection.locator.layerFonts = () => () => ({ italic: false, bold: false });
    PdfSelection.attachViewer(viewer);
    PdfSelection.attachEditor(testEditor);
  });
  await page.waitForSelector('.mew-font-diff-text');
  await page.evaluate(() => {
    const index = PdfSelection.locator.editorSourceIndex(testEditor.getModel());
    const target = PdfSelection.locator.environment.getVisiblePages()[0].index;
    index.rememberConnection(0, index.raw.length, target, { start: 0, end: target.raw.length });
    PdfSelection.refresh();
  });
  const selected = await page.evaluate(() => {
    const model = testEditor.getModel(), source = model.getValue();
    const start = source.indexOf('selected passage'), end = source.indexOf(' passage.');
    testEditor.setSelection(monaco.Range.fromPositions(model.getPositionAt(start), model.getPositionAt(end)));
    return { text: model.getValueInRange(testEditor.getSelection()) };
  });
  const popup = page.locator('.replacement-review');
  await popup.waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelector('.replacement-review [data-status]')?.textContent.includes('斜体不一致'));
  assert.equal(await page.evaluate(() => testEditor.getModel().getValueInRange(testEditor.getSelection())), selected.text);
  const geometry = await page.evaluate(() => {
    const div = document.querySelector('#fontStage .page'), node = div.querySelector('.textLayer span').firstChild;
    const raw = node.textContent, range = document.createRange();
    range.setStart(node, raw.indexOf('selected passage'));
    range.setEnd(node, raw.indexOf(' passage.'));
    const expected = range.getBoundingClientRect();
    const overlay = div.querySelector('.mew-pdf-selection-highlight:not(.mew-pdf-review-pointer)');
    const actual = overlay.firstChild.getBoundingClientRect();
    const index = PdfSelection.locator.editorSourceIndex(testEditor.getModel());
    const item = index.formatDifferences(index.connectionPairs(PdfSelection.locator.environment.getTargets()))[0];
    item.pdfSource = { index, start: item.sourceStart, end: item.sourceEnd };
    return { visible: getComputedStyle(overlay).visibility, actual: [actual.left, actual.right], expected: [expected.left, expected.right],
      anchor: PdfSelection.locator.reviewAnchor(item, index), popup: document.querySelector('.replacement-review').getBoundingClientRect().toJSON() };
  });
  assert.equal(geometry.visible, 'visible', 'a font pointer must keep the complete passage visible');
  geometry.actual.forEach((value, at) => assert.ok(Math.abs(value - geometry.expected[at]) < 1));
  assert.ok(geometry.anchor, 'the popup has an anchor on the font fault');
  assert.ok(Math.abs(geometry.popup.left - geometry.anchor.left) < 30, 'the popup starts at the font difference');
  await page.evaluate(() => ReplacementReview.close());
  const toggle = page.locator('input[aria-label="启用PDF 斜体／粗体探测"]');
  await toggle.evaluate(input => input.click());
  await page.waitForFunction(() => !PdfReviewProvider.fontEnabled && !document.querySelector('.mew-font-diff-text'));
  await page.waitForFunction(() => {
    const div = document.querySelector('#fontStage .page');
    const notices = PdfReviewProvider.getHighlight(div, true)?.notices || [];
    return notices.length && notices.every(notice => !notice.source.index.raw.slice(notice.source.start, notice.source.end).includes('Word'));
  });
  assert.ok(await page.locator('.mew-ocr-diff-text').count(), 'text differences remain highlighted');
  await toggle.evaluate(input => input.click());
  await page.waitForSelector('.mew-font-diff-text');
  await page.waitForFunction(() => PdfReviewProvider.getHighlight(document.querySelector('#fontStage .page'), true)?.notices.some(notice =>
    notice.source.index.raw.slice(notice.source.start, notice.source.end) === 'Word'));
  assert.deepEqual(errors, []);
  console.log('Full passage selection, font popup anchor, and font highlight off/on passed.');
} finally {
  await browser?.close();
  await stopServer(server);
  await rm(fixture, { recursive: true, force: true });
}
