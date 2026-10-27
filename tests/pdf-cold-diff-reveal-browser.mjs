import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { launchBrowser, startServer, stopServer } from './support/browser.mjs';

const port = 17044;
const server = await startServer('reader-server.js', port);
let browser;
try {
  browser = await launchBrowser();
  for (const requested of [429, 430]) {
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/reader/settings', route => route.fulfill({ json: { diffHighlight: true, selectionHighlight: true } }));
  await page.route('**/pdfdiff/pdf-review-provider.js', async route => {
    const body = (await readFile('public/pdfdiff/pdf-review-provider.js', 'utf8')).replace(
      'async indexDocument(pdf, numbers) {', 'async indexDocument(pdf, numbers) { if (!numbers) window.volumeReads = (window.volumeReads || 0) + 1;').replace(
      'cached.index = new toolbox.PdfSourceIndex(this, { raw, pages, normalized: mapped });',
      'cached.index = new toolbox.PdfSourceIndex(this, { raw, pages, normalized: mapped }); if (numbers) window.coldIndex = cached.index;');
    await route.fulfill({ body, contentType: 'text/javascript' });
  });
  await page.goto(`http://127.0.0.1:${port}/?volume=8&page=${requested}&mode=source`, { waitUntil: 'domcontentloaded' });
  // Wait only for the offscreen page's source marker, without visiting that PDF page.
  await page.waitForFunction(() => {
    const editor = window.readerMonaco?.editor, viewer = window.ReaderUI?.getPdfViewer();
    if (!editor || !viewer?.pdfDocument || !window.PdfSelection) return false;
    const index = PdfSelection.locator.editorSourceIndex(editor.getModel());
    const target = window.coldIndex;
    if (!target) return false;
    const candidate = index.reviewCandidates([target]).find(item => {
      const hit = index.connectedRange(target, item.sourceStart, item.sourceEnd, false, undefined, true);
      return hit && target.pages.some(p => p.number === 452 && hit.start >= p.start && hit.start < p.end);
    });
    if (!candidate) return false;
    window.coldRange = index.sourceRange(editor.getModel(), candidate.sourceStart, candidate.sourceEnd);
    return true;
  }, null, { timeout: 15000 });
  const before = await page.evaluate(() => {
    const editor = readerMonaco.editor, viewer = ReaderUI.getPdfViewer();
    editor.revealRangeInCenter(coldRange); editor.render(true);
    const position = editor.getScrolledVisiblePosition({ lineNumber: coldRange.startLineNumber, column: coldRange.startColumn });
    const box = editor.getDomNode().getBoundingClientRect();
    return { page: viewer.currentPageNumber, source: editor.getValue(), pages: ReaderUI.getPdfSourcePages(),
      text: editor.getModel().getValueInRange(coldRange), x: box.left + position.left + 1, y: box.top + position.top + position.height / 2 };
  });
  assert.equal(before.page, requested + 22, 'the PDF remains on its cold-open page until the first click');
  assert.deepEqual(before.pages, [451, 452], 'missing ME08-430.html belongs to ME08-429 until ME08-431');
  await page.mouse.click(before.x, before.y);
  await page.waitForFunction(() => ReaderUI.getPdfViewer().currentPageNumber === 452
    && [...document.querySelectorAll('.mew-pdf-selection-highlight:not(.mew-pdf-review-pointer) > div')].some(node => {
      const mark = node.getBoundingClientRect(), viewport = ReaderUI.getPdfViewer().container.getBoundingClientRect();
      return mark.top >= viewport.top && mark.bottom <= viewport.bottom;
    }), null, { timeout: 5000 });
  await page.locator('.replacement-review').waitFor({ state: 'visible', timeout: 5000 });
  assert.equal(await page.evaluate(() => readerMonaco.editor.getValue()), before.source, 'physical page change keeps ME08-429 working copy');
  assert.equal(await page.evaluate(() => window.volumeReads || 0), 0, 'cold click uses the HTML page interval without reading the whole volume');
  assert.deepEqual(errors, []);
  console.log(`Cold PDF ${requested} / ME08-429: first click on ${JSON.stringify(before.text)} reveals PDF page 430 without prior navigation or whole-volume lookup`);
  await page.close();
  }
} finally { await browser?.close(); await stopServer(server); }
