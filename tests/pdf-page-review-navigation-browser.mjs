import assert from 'node:assert/strict';
import { launchBrowser, startServer, stopServer } from './support/browser.mjs';

const server = await startServer('reader-server.js', 17045);
let browser;
try {
  browser = await launchBrowser();
  for (const number of [432, 433, 434]) {
    const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/reader/settings', route => route.fulfill({ json: {
      diffHighlight: false, sourceDiffHighlight: true, selectionHighlight: true
    } }));
    await page.goto(`http://127.0.0.1:17045/?volume=8&page=${number}&mode=source`);
    await page.waitForSelector('.mew-ocr-diff-text', { timeout: 20000 });
    await page.waitForFunction(() => PdfSelection.locator.getDocumentIndex(
      ReaderUI.getPdfViewer().pdfDocument, ReaderUI.getPdfSourcePages()));
    const original = await page.evaluate(() => readerMonaco.editor.getValue());
    const popup = page.locator('.replacement-review');
    for (const entry of ['highlight', 'toolbar']) {
      await page.evaluate(() => ReplacementReview.close());
      if (entry === 'highlight') await page.locator('.mew-ocr-diff-text').first().click();
      else await page.locator('#reviewBtn').click();
      await popup.waitFor({ state: 'visible' });
      await page.waitForFunction(() => /^1 \/ (?:[2-9]|[1-9]\d+)$/.test(document.querySelector('[data-position]').textContent));
      const total = Number((await popup.locator('[data-position]').textContent()).split('/')[1]);
      const textCount = await page.evaluate(() => {
        const locator = PdfSelection.locator, model = readerMonaco.editor.getModel();
        const target = locator.getDocumentIndex(ReaderUI.getPdfViewer().pdfDocument, ReaderUI.getPdfSourcePages());
        return locator.editorSourceIndex(model).reviewCandidates(null, false, true, true, [target]).length;
      });
      assert.ok(total >= textCount, `${entry} must include the prepared page's text candidates`);
      for (let position = 2; position <= total; position++) {
        await popup.locator('[data-next]').click();
        // Let the synchronized selection feed back into the shared popup.
        await page.waitForTimeout(350);
        assert.equal(await popup.isVisible(), true, `ME08-${number}: candidate ${position} remains reachable without a PDF anchor`);
        assert.equal(await popup.locator('[data-position]').textContent(), `${position} / ${total}`,
          'selection synchronization must preserve the original candidate list, including CRLF candidates');
      }
      assert.equal(await popup.locator('[data-next]').isDisabled(), true);
      await popup.locator('[data-prev]').click();
      await page.waitForTimeout(350);
      assert.equal(await popup.locator('[data-position]').textContent(), `${total - 1} / ${total}`);
      assert.equal(await page.evaluate(() => readerMonaco.editor.getValue()), original);
      assert.deepEqual(errors, []);
      console.log(`ME08-${number} ${entry}: navigated all ${total} candidates and back without hiding, resetting or editing`);
    }
    await page.close();
  }
} finally {
  await browser?.close();
  await stopServer(server);
}
