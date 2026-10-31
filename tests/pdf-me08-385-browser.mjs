import assert from 'node:assert/strict';
import { launchBrowser, startServer, stopServer } from './support/browser.mjs';

const server = await startServer('reader-server.js', 17059);
let browser;
try {
  browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1800, height: 1100 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/reader/settings', route => route.fulfill({ json: {
    diffHighlight: true, sourceDiffHighlight: true, selectionHighlight: true
  } }));
  await page.goto('http://127.0.0.1:17059/?volume=8&page=385&mode=source');
  await page.waitForFunction(() => window.readerMonaco?.editor && window.PdfSelection
    && document.querySelector('.textLayer span') && document.querySelector('.mew-pdf-review-pointer'),
  null, { timeout: 30000 });
  await page.waitForFunction(() => {
    const locator = PdfSelection.locator, editor = readerMonaco.editor;
    const target = locator.getDocumentIndex(ReaderUI.getPdfViewer().pdfDocument, ReaderUI.getPdfSourcePages());
    return target && locator.editorSourceIndex(editor.getModel()).pageScopes.get(target)?.prepared;
  });
  const result = await page.evaluate(() => {
    PdfReviewProvider.setFontEnabled(false);
    const editor = readerMonaco.editor, locator = PdfSelection.locator;
    const index = locator.editorSourceIndex(editor.getModel()), targets = locator.environment.getTargets();
    index?.diff(targets);
    window.markState = marks => JSON.stringify(marks.filter(mark => /text.*difference/.test(mark.options.description))
      .map(({ range, options: o }) => { const r = editor.getModel().validateRange(range);
        return [r.startLineNumber, r.startColumn, r.endLineNumber, r.endColumn, o.inlineClassName, o.before?.inlineClassName]; }).sort());
    window.htmlMarks = () => markState(editor.getModel().getAllDecorations());
    window.expectedMarks = () => markState(index.sourceDecorations(index.reviewCandidates(null, PdfReviewProvider.locator.fontStyles, false, true, locator.environment.getTargets(), index.connectionPairs(locator.environment.getTargets(), true)), PdfReviewProvider.locator.fontStyles, true, undefined, editor.getModel()));
    window.paragraphNotice = null;
    addEventListener('pdf-selection-difference', event => {
      window.paragraphNotice = event.detail.notices?.find(n => n.source && n.target?.end > n.target?.start);
      window.selectionNotice = event.detail.notices?.find(n => n.source && n.target?.end > n.target?.start && n.box);
    });
    return !!targets.find(target => target.layer);
  });
  assert.equal(result, true);
  await page.waitForFunction(() => htmlMarks() === expectedMarks());
  await page.evaluate(() => {
    window.initialHtmlMarks = htmlMarks();
    const editor = readerMonaco.editor, index = PdfSelection.locator.editorSourceIndex(editor.getModel());
    const start = index.raw.indexOf('Das einzige'), end = index.raw.indexOf('unter-', start) + 6;
    editor.setSelection(window.PdfSelectionDiff.rangeAt(editor.getModel(), index.starts[start] ?? index.source.length,
      (end > start ? index.ends[(end) - 1] : index.starts[start]) ?? index.source.length));
  });
  await page.waitForFunction(() => window.paragraphNotice?.box && !window.paragraphNotice.box.caret, null, { timeout: 5000 });
  const highlighted = await page.evaluate(() => {
    const { target } = paragraphNotice;
    return target.index.raw.slice(target.start, target.end);
  });
  assert.ok(highlighted.startsWith('Das einzige'));
  assert.ok(highlighted.includes('Schrecken vor der Leere'));
  async function popupAvoidsHighlight() {
    await page.locator('.replacement-review:visible').waitFor();
    await page.waitForFunction(() => {
      const popup = document.querySelector('.replacement-review').getBoundingClientRect();
      const { target } = paragraphNotice, div = target.index.layer.closest('.page'), rect = div.getBoundingClientRect();
      const painted = PdfReviewProvider.highlights.getHighlight(div);
      return painted.boxes.every(box => popup.bottom <= rect.top + box.y * rect.height
        || popup.top >= rect.top + (box.y + box.h) * rect.height
        || popup.right <= rect.left + box.x * rect.width || popup.left >= rect.left + (box.x + box.w) * rect.width);
    });
  }
  await popupAvoidsHighlight();
  await page.waitForFunction(() => readerMonaco.editor.getModel().getAllDecorations()
    .some(mark => mark.options.description === 'PDF OCR text difference'));
  const normalHighlights = await page.evaluate(() => {
    const editor = readerMonaco.editor, index = PdfSelection.locator.editorSourceIndex(editor.getModel());
    const start = index.raw.indexOf('und fordert empört'), end = index.raw.indexOf('sollen.', start) + 'sollen.'.length;
    const marks = editor.getModel().getAllDecorations().filter(mark => mark.options.description === 'PDF OCR text difference');
    ReplacementReview.close();
    window.selectionNotice = null;
    editor.setSelection(window.PdfSelectionDiff.rangeAt(editor.getModel(), index.starts[start] ?? index.source.length,
      (end > start ? index.ends[(end) - 1] : index.starts[start]) ?? index.source.length));
    return marks.some(mark => mark.options.inlineClassName === 'mew-ocr-diff-text');
  });
  assert.equal(normalHighlights, true, 'locatable text discrepancies retain their normal highlights');
  await page.waitForFunction(() => window.selectionNotice && !window.selectionNotice.box.caret);
  assert.ok(await page.evaluate(() => {
    const { target } = selectionNotice, div = target.index.layer.closest('.page');
    return PdfReviewProvider.highlights.getHighlight(div)?.boxes.some(box => !box.caret);
  }), 'selecting the corrupted Monaco passage paints the PDF word boxes');
  await page.evaluate(() => {
    ReplacementReview.close();
    window.paragraphNotice = null;
    const editor = readerMonaco.editor, index = PdfSelection.locator.editorSourceIndex(editor.getModel());
    const start = index.raw.indexOf('Rivalität');
    editor.setSelection(window.PdfSelectionDiff.rangeAt(editor.getModel(), index.starts[start] ?? index.source.length,
      (start + 'Rivalität'.length > start ? index.ends[(start + 'Rivalität'.length) - 1] : index.starts[start]) ?? index.source.length));
  });
  await page.waitForFunction(() => window.paragraphNotice?.box && !window.paragraphNotice.box.caret, null, { timeout: 5000 });
  assert.ok(await page.evaluate(() => {
    const { target } = paragraphNotice, text = target.index.raw.slice(target.start, target.end);
    const painted = PdfReviewProvider.highlights.getHighlight(target.index.layer.closest('.page'));
    return !text.includes('Das einzige') && text.includes('Schrecken vor der Leere')
      && painted.boxes.some(box => !box.caret);
  }));
  await popupAvoidsHighlight();
  const changedMarks = await page.evaluate(() => {
    const before = JSON.parse(initialHtmlMarks).map(JSON.stringify), after = JSON.parse(htmlMarks()).map(JSON.stringify);
    return { removed: before.filter(mark => !after.includes(mark)), added: after.filter(mark => !before.includes(mark)) };
  });
  assert.deepEqual(changedMarks, { removed: [], added: [] }, 'HTML discrepancy marks stay fixed after selecting damaged OCR passages');
  assert.deepEqual(errors, []);
  console.log('ME08-385: corrupted paragraph selection highlights existing OCR boxes instead of a caret');
} finally {
  await browser?.close();
  await stopServer(server);
}
