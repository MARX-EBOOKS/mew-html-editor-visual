import assert from 'node:assert/strict';
import { launchBrowser, startServer, stopServer } from './support/browser.mjs';

const server = await startServer('reader-server.js', 17064);
let browser;
try {
  browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1800, height: 1100 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/reader/settings', route => route.fulfill({ json: {
    scale: '1', diffHighlight: true, sourceDiffHighlight: true, selectionHighlight: true
  } }));
  await page.goto('http://127.0.0.1:17064/?volume=32&page=169&mode=source');
  await page.waitForFunction(() => window.readerMonaco?.editor && window.PdfSelection
    && document.querySelector('.mew-ocr-diff-insert'), null, { timeout: 60000 });
  const source = await page.evaluate(() => readerMonaco.editor.getValue());
  for (const diffHighlight of [true, false]) {
    await page.evaluate(diffHighlight => PdfSelection.setDiffHighlight(diffHighlight), diffHighlight);
    const point = await page.evaluate(() => {
      ReplacementReview.close(); PdfSelection.clear();
      const editor = readerMonaco.editor, model = editor.getModel();
      const index = PdfSelection.locator.editorSourceIndex(model), at = index.raw.indexOf('gewähren.') + 'gewähren.'.length;
      const range = window.PdfSelectionDiff.rangeAt(model, index.starts[at] ?? index.source.length,
        index.starts[at] ?? index.source.length);
      editor.revealRangeInCenter(range);
      return { lineNumber: range.startLineNumber, column: range.startColumn };
    });
    await page.waitForTimeout(200);
    const click = await page.evaluate(point => {
      const editor = readerMonaco.editor, rect = editor.getDomNode().getBoundingClientRect();
      const position = editor.getScrolledVisiblePosition(point);
      return { x: rect.left + position.left + 1, y: rect.top + position.top + position.height / 2 };
    }, point);
    await page.mouse.click(click.x, click.y);
    await page.waitForFunction(() => PdfSelection.status.differences.some(item => /,\s*, </u.test(item.pdf)));
    assert.ok(await page.locator('.mew-pdf-selection-highlight:not(.mew-pdf-review-pointer)>div').count() > 0,
      'clicking the word-ending insertion paints its PDF counterpart');
    assert.equal(await page.evaluate(() => readerMonaco.editor.getValue()), source);
  }
  assert.deepEqual(errors, []);
  console.log('ME32-169 word-ending noise highlights on the PDF side with default highlights on and off');
} finally { await browser?.close(); await stopServer(server); }
