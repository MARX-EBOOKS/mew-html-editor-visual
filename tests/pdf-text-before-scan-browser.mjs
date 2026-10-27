import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { launchBrowser, startServer, stopServer } from './support/browser.mjs';

const port = 17042;
const server = await startServer('reader-server.js', port);
let browser;
try {
  browser = await launchBrowser();
  for (const [volume, number] of [[8, 376], [8, 307], [23, 316]]) {
    const context = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/reader/settings', route => route.fulfill({ json: { diffHighlight: true, selectionHighlight: true } }));
    await page.addInitScript(() => {
      window.scanGate = new Promise(resolve => { window.releaseScan = resolve; });
      window.scanStarts = 0;
      window.volumeReads = 0;
      window.textReady = [];
    });
    await page.route('**/reader-ui.js', async route => {
      const body = (await readFile('public/reader-ui.js', 'utf8')).replace(
        'return drawCanvas.apply(this, args);',
        'window.textReady.push({ page: this.id, at: performance.now() }); await window.scanGate; window.scanStarts++; return drawCanvas.apply(this, args);');
      await route.fulfill({ body, contentType: 'text/javascript' });
    });
    await page.route('**/pdfdiff/pdf-review-provider.js', async route => {
      const body = (await readFile('public/pdfdiff/pdf-review-provider.js', 'utf8')).replace(
        'async indexDocument(pdf, numbers) {', 'async indexDocument(pdf, numbers) { if (!numbers) window.volumeReads++;');
      await route.fulfill({ body, contentType: 'text/javascript' });
    });
    await page.goto(`http://127.0.0.1:${port}/?volume=${volume}&page=${number}&mode=source`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.textReady.length && document.querySelector('.mew-pdf-review-pointer')
      && document.querySelector('.mew-ocr-diff-text'), null, { timeout: 15000 });
    const early = await page.evaluate(() => ({
      ms: performance.now(), text: textReady[0], scans: scanStarts, reads: volumeReads,
      source: readerMonaco.editor.getModel().getAllDecorations().filter(d => d.options.inlineClassName?.includes('mew-ocr-diff'))
        .map(d => ({ range: d.range, className: d.options.inlineClassName })),
      pointers: document.querySelectorAll('.mew-pdf-review-pointer').length
    }));
    assert.equal(early.scans, 0, 'PDF and source highlights must exist before scan rendering starts');
    assert.equal(early.reads, 0, 'default highlights must not extract the entire volume');
    assert.ok(early.source.length);
    await page.evaluate(() => releaseScan());
    await page.waitForFunction(() => ReaderUI.getPdfViewer().getPageView(ReaderUI.getPdfViewer().currentPageNumber - 1)?.renderingState === 3);
    await page.waitForFunction(() => document.querySelector('.mew-pdf-review-pointer'));
    const beforeClick = await page.evaluate(() => {
      const viewer = ReaderUI.getPdfViewer(), scroll = viewer.scrollPageIntoView.bind(viewer);
      window.highlightJumps = 0;
      window.linkedSelectionEvents = [];
      viewer.scrollPageIntoView = (...args) => { highlightJumps++; return scroll(...args); };
      addEventListener('pdf-selection-highlight-status', event => {
        if (event.detail.mode) linkedSelectionEvents.push(event.detail.mode);
      });
      return { page: viewer.currentPageNumber, reads: volumeReads };
    });
    await page.locator('.mew-ocr-diff-text').first().click();
    await page.waitForFunction(() => linkedSelectionEvents.length);
    const afterClick = await page.evaluate(() => ({
      page: ReaderUI.getPdfViewer().currentPageNumber, reads: volumeReads, jumps: highlightJumps
    }));
    assert.equal(afterClick.page, beforeClick.page, 'clicking a default diff mark preserves the current PDF page');
    assert.equal(afterClick.jumps, 0);
    assert.equal(afterClick.reads, beforeClick.reads, 'a marked click does not start whole-volume lookup');
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ volume, page: number, highlightMs: early.ms, textMs: early.text.at,
      sourceMarks: early.source.length, pointers: early.pointers, volumeReads: early.reads }));
    await context.close();
  }
} finally {
  await browser?.close();
  await stopServer(server);
}
