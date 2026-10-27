import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchBrowser, startServer, stopServer } from './support/browser.mjs';

const fixture = await mkdtemp(path.join(tmpdir(), 'mew-file-review-'));
const passage = 'A lengthy introductory passage establishes the source location with unique words. The reading has an X character in the middle. A second lengthy passage completes the unique context for this comparison. The ending contains a Q character for another comparison.';
const original = '<p>' + passage + '</p>';
let server, browser;
try {
  await writeFile(path.join(fixture, 'a.html'), original);
  server = await startServer('server.js', 41885, ['-r', fixture]);
  browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/reader/settings', route => route.fulfill({ json: { diffHighlight: false } }));
  await page.goto('http://127.0.0.1:41885/?file=a.html');
  await page.waitForFunction(() => window.mewWorkbench?.editor.getValue().includes('an X') && window.PdfReviewProvider);
  await page.evaluate(text => {
    const stage = document.createElement('div');
    stage.style.cssText = 'position:fixed;left:500px;top:400px;width:700px;height:400px;background:white';
    stage.innerHTML = '<div class="pdfViewer"><div class="page" style="position:relative;width:700px;height:400px"><div class="textLayer"><span></span></div></div></div>';
    stage.querySelector('span').textContent = text;
    document.body.append(stage);
    const pdf = { numPages: 1, async getPage() { return {
      async getTextContent() { return { items: [{ str: text, transform: [1, 0, 0, 1, 0, 500], width: 700, height: 20 }] }; }
    }; } };
    window.mockViewer = { container: stage, viewer: stage.firstChild, currentPageNumber: 1,
      scrollPageIntoView() {}, _getVisiblePages: () => ({ views: [{ id: 1 }] }),
      getPageView: () => ({ div: stage.querySelector('.page') }), eventBus: { on() {}, off() {} }, pdfDocument: pdf };
    window.ReaderUI = { getPdfViewer: () => mockViewer };
  }, passage.replace('an X', 'an YYYYY').replace('a Q', 'a Z'));
  await page.addScriptTag({ url: '/pdfdiff/pdf-selection.js' });
  await page.waitForFunction(() => window.PdfSelection);
  await page.evaluate(() => { PdfSelection.attachViewer(mockViewer); PdfSelection.attachEditor(mewWorkbench.editor); });
  await page.locator('#reviewBtn').click();
  const popup = page.locator('.replacement-review');
  await popup.waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelector('[data-position]')?.textContent === '1 / 2');
  assert.equal(await popup.locator('[data-file-list], [data-candidates]').count(), 0, 'original compact popup has no filename list');
  assert.deepEqual(await popup.locator('[data-comparison] mark').allTextContents(), ['X', 'YYYYY']);
  await page.evaluate(() => { PdfSelection.setDiffHighlight(true); PdfSelection.setDiffHighlight(true, 'source'); });
  await page.waitForSelector('.mew-ocr-diff-text');
  await popup.locator('[data-apply]').click();
  assert.equal(await page.evaluate(() => mewWorkbench.editor.getValue()), original, 'preview leaves the source unchanged');
  await page.waitForSelector('.mew-review-proposed');
  await popup.locator('[data-apply]').click();
  assert.equal(await page.locator('.mew-review-proposed').count(), 0);
  assert.ok(await page.locator('.mew-ocr-diff-text').count(), 'source differences remain highlighted after preview closes');
  await popup.locator('[data-next]').click();
  assert.equal(await popup.locator('[data-position]').textContent(), '2 / 2');
  assert.deepEqual(await popup.locator('[data-comparison] mark').allTextContents(), ['Q', 'Z']);
  await popup.locator('[data-save]').click();
  const expected = original.replace('a Q', 'a Z');
  await page.waitForFunction(value => mewWorkbench.editor.getValue() === value, expected);
  await page.waitForFunction(() => ![...mewWorkbench.documents.values()].some(doc => doc.dirty));
  assert.equal(await readFile(path.join(fixture, 'a.html'), 'utf8'), expected, 'saving the current candidate leaves a different pattern unchanged');
  await popup.locator('[data-prev]').click();
  assert.deepEqual(await popup.locator('[data-comparison] mark').allTextContents(), ['X', 'YYYYY']);
  await page.evaluate(() => mewWorkbench.editor.trigger('test', 'undo', null));
  assert.equal(await page.evaluate(() => mewWorkbench.editor.getValue()), original);
  assert.deepEqual(errors, []);
  console.log('Original compact popup: navigation, preview, highlights, candidate save and undo passed');
} finally {
  await browser?.close();
  await stopServer(server);
  await rm(fixture, { recursive: true, force: true });
}
