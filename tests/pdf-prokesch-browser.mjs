import assert from 'node:assert/strict';
import { launchBrowser, startServer, stopServer } from './support/browser.mjs';
const server = await startServer('reader-server.js', 17065);
let browser;
try {
  browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1800, height: 1100 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/reader/settings', route => route.fulfill({ json: {
    scale: '1', diffHighlight: true, sourceDiffHighlight: true, selectionHighlight: true,
    italicDetection: false, boldDetection: false
  } }));
  for (const [number, word, pdf, changed] of [
    [18, 'Prokesch-Osten', 'Pro-\nkesch-Osten', false],
    [188, 'hineinzuziehen', 'hin-,\neinzuziehen', true],
    [198, 'Revolutions-Agitations-', 'Revolutions-\nAgitations-', false]
  ]) {
  await page.goto(`http://127.0.0.1:17065/?volume=32&page=${number}&mode=source`);
  await page.waitForFunction(word => window.readerMonaco?.editor && window.PdfSelection
    && document.querySelector('.mew-ocr-diff-text') && readerMonaco.editor.getValue().includes(word), word, { timeout: 60000 });
  const source = await page.evaluate(() => readerMonaco.editor.getValue());
  for (const diffHighlight of [true, false]) {
    await page.evaluate(value => PdfSelection.setDiffHighlight(value), diffHighlight);
    const range = await page.evaluate(word => {
      ReplacementReview.close(); PdfSelection.clear();
      const editor = readerMonaco.editor, model = editor.getModel();
      const index = PdfSelection.locator.editorSourceIndex(model), start = index.raw.indexOf(word);
      const range = PdfSelectionDiff.rangeAt(model, start, start + word.length, index);
      const decorations = model.getDecorationsInRange(range).filter(d =>
        /mew-ocr-diff-(text|insert)/.test((d.options.inlineClassName || '') + (d.options.before?.inlineClassName || '')));
      if (decorations.some(d => d.range.startLineNumber !== d.range.endLineNumber || d.range.startColumn !== d.range.endColumn))
        throw new Error('The unchanged letters have OCR difference markers');
      editor.setPosition({ lineNumber: range.startLineNumber, column: range.startColumn });
      editor.revealRangeInCenter(range); return range;
    }, word);
    await page.waitForTimeout(200);
    const points = await page.evaluate(range => {
      const editor = readerMonaco.editor, rect = editor.getDomNode().getBoundingClientRect();
      return [{ lineNumber: range.startLineNumber, column: range.startColumn },
        { lineNumber: range.endLineNumber, column: range.endColumn }].map(position => {
        const p = editor.getScrolledVisiblePosition(position);
        return { x: rect.left + p.left + .1, y: rect.top + p.top + p.height / 2 };
      });
    }, range);
    await page.mouse.move(points[0].x, points[0].y); await page.mouse.down();
    await page.mouse.move(points[1].x, points[1].y, { steps: 15 }); await page.mouse.up();
    await page.waitForFunction(word => PdfSelection.status.matches > 0
      && PdfSelection.status.differences.some(d => d.html === word)
      && document.querySelector('.mew-pdf-selection-highlight:not(.mew-pdf-review-pointer)>div'), word, { timeout: 10000 });
    const result = await page.evaluate(() => ({
      text: readerMonaco.editor.getModel().getValueInRange(readerMonaco.editor.getSelection()),
      source: readerMonaco.editor.getValue(), popup: !!document.querySelector('.replacement-review:not([hidden])'),
      differences: PdfSelection.status.differences.map(d => ({ html: d.html, pdf: d.pdf }))
    }));
    assert.equal(result.text, word);
    assert.equal(result.source, source);
    assert.equal(result.popup, changed, 'only real OCR changes need a replacement popup');
    assert.ok(result.differences.some(d => d.html === word && d.pdf.replace(/\s/g, '') === pdf.replace(/\s/g, '')));
    const click = await page.evaluate(range => {
      ReplacementReview.close(); PdfSelection.clear();
      const editor = readerMonaco.editor, rect = editor.getDomNode().getBoundingClientRect();
      const p = editor.getScrolledVisiblePosition({ lineNumber: range.startLineNumber, column: range.startColumn + 4 });
      return { x: rect.left + p.left + 1, y: rect.top + p.top + p.height / 2 };
    }, range);
    await page.mouse.click(click.x, click.y); await page.waitForTimeout(300);
    assert.equal(await page.locator('.replacement-review:not([hidden])').count(), 0,
      'clicking unchanged letters cannot offer a false replacement');
  }
  }
  assert.deepEqual(errors, []);
  console.log('ME32-018/188/198: whole-word PDF highlighting, punctuation-only review and no false letter replacements with default highlights on and off');
} finally { await browser?.close(); await stopServer(server); }

