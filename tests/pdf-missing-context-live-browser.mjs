import assert from 'node:assert/strict';
import { launchBrowser, startServer, stopServer } from './support/browser.mjs';

const server = await startServer('reader-server.js', 17060);
const browser = await launchBrowser();
try {
  for (const number of [327, 380, 452, 453, 457, 465, 466, 467, 468, 469, 470]) {
    const page = await browser.newPage({ viewport: { width: 1800, height: 1100 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/reader/settings', route => route.fulfill({ json: {
      diffHighlight: true, sourceDiffHighlight: true, selectionHighlight: true
    } }));
    await page.goto(`http://127.0.0.1:17060/?volume=8&page=${number}&mode=source`);
    await page.waitForFunction(() => {
      const editor = window.readerMonaco?.editor, locator = window.PdfSelection?.locator;
      const viewer = window.ReaderUI?.getPdfViewer();
      const target = locator?.getDocumentIndex(viewer?.pdfDocument, ReaderUI.getPdfSourcePages());
      return editor && document.querySelector('.textLayer span') && target
        && locator.editorSourceIndex(editor.getModel()).pageScopes.get(target)?.prepared;
    });
    await page.evaluate(() => {
      PdfReviewProvider.setFontEnabled(false);
      window.markState = marks => JSON.stringify(marks.filter(mark => /text.*difference/.test(mark.options.description))
        .map(({ range, options }) => { const r = readerMonaco.editor.getModel().validateRange(range);
          return [r.startLineNumber, r.startColumn, r.endLineNumber, r.endColumn, options.inlineClassName, options.before?.inlineClassName]; }).sort());
      window.htmlMarks = () => markState(readerMonaco.editor.getModel().getAllDecorations());
      addEventListener('pdf-selection-difference', event => { window.caretNotices = event.detail.notices; });
      window.expectedMarks = () => {
        const locator = PdfSelection.locator, editor = readerMonaco.editor, index = locator.editorSourceIndex(editor.getModel()), targets = locator.environment.getTargets();
        return markState(index.sourceDecorations(index.reviewCandidates(null, false, false, true, targets, index.connectionPairs(targets, true)), false, true, undefined, editor.getModel()));
      };
    });
    await page.waitForFunction(() => htmlMarks() === expectedMarks());
    const before = await page.evaluate(() => htmlMarks());
    const cases = await page.evaluate(() => {
      const locator = PdfSelection.locator, index = locator.editorSourceIndex(readerMonaco.editor.getModel());
      return index.reviewCandidates(null, false, true, true, locator.environment.getTargets()).map(item => ({
        start: item.sourceStart, end: item.sourceEnd, missing: !!item.missing,
        html: item.comparison.html, pdf: item.comparison.pdf
      }));
    });
    if ([453, 465, 466, 467, 468, 469].includes(number))
      assert.ok(cases.every(item => !item.missing), `ME08-${number}: normal diff takes priority over missing OCR`);
    if (number === 457) assert.equal(cases.filter(item => item.missing).length, 1, 'only the unresolved tail needs missing OCR reminders');
    if (number === 452) {
      const selectedText = await page.evaluate(() => {
        ReplacementReview.close(); window.caretNotices = [];
        const editor = readerMonaco.editor, index = PdfSelection.locator.editorSourceIndex(editor.getModel());
        const start = index.raw.indexOf('Dronke und Imandt begaben');
        const end = start + index.raw.slice(start, index.raw.indexOf('„An die Redaktion', start)).trimEnd().length;
        editor.setSelection(window.PdfSelectionDiff.rangeAt(editor.getModel(), index.starts[start] ?? index.source.length,
          (end > start ? index.ends[(end) - 1] : index.starts[start]) ?? index.source.length));
        return index.raw.slice(start, end);
      });
      const popup = page.locator('.replacement-review:visible');
      await popup.waitFor({ timeout: 5000 });
      assert.match(await popup.locator('[data-status]').textContent(), /PDF OCR.*文字/u);
      assert.equal(await popup.locator('[data-comparison] > div').first().textContent(), 'HTML: ' + selectedText,
        'ME08-452 popup preserves the exact partial selection');
      await page.waitForFunction(() => window.caretNotices?.some(notice => notice.missing && notice.target?.end > notice.target?.start));
      assert.ok(await page.evaluate(() => [...document.querySelectorAll('.page')].some(div =>
        PdfReviewProvider.highlights.getHighlight(div)?.boxes?.some(box => !box.caret))), 'ME08-452 selection highlights remaining OCR text');
      await popup.locator('[data-close]').click();
    }
    if (number === 453) {
      await page.evaluate(() => {
        const editor = readerMonaco.editor, index = PdfSelection.locator.editorSourceIndex(editor.getModel());
        const text = 'gemacht, die in Beziehung zu de', start = index.raw.indexOf(text);
        window.caretNotices = [];
        editor.setSelection(window.PdfSelectionDiff.rangeAt(editor.getModel(), index.starts[start] ?? index.source.length,
          (start + text.length > start ? index.ends[(start + text.length) - 1] : index.starts[start]) ?? index.source.length));
      });
      await page.waitForFunction(() => window.caretNotices?.length);
      assert.ok(await page.evaluate(() => caretNotices.every(notice => !notice.missing)), 'ME08-453 selection keeps the normal diff');
      assert.match(await page.locator('.replacement-review:visible [data-status]').textContent(), /文字不一致/u);
      await page.evaluate(() => ReplacementReview.close());
      await page.locator('.mew-ocr-diff-text').filter({ hasText: 'gemacht' }).first().click();
      await page.locator('.replacement-review:visible').waitFor();
      assert.match(await page.locator('.replacement-review:visible [data-status]').textContent(), /文字不一致/u);
      await page.evaluate(() => ReplacementReview.close());
      const point = await page.evaluate(() => {
        document.getSelection().removeAllRanges();
        for (const div of document.querySelectorAll('.pdfViewer .page')) {
          const notice = PdfReviewProvider.highlights.getHighlight(div, true)?.notices?.find(notice => notice.source
            && notice.source.index.raw.slice(notice.source.start, notice.source.end).includes('gemacht'));
          if (!notice) continue;
          const rect = div.getBoundingClientRect(), box = notice.box;
          return { x: rect.left + (box.x + box.w / 2) * rect.width, y: rect.top + (box.y + box.h / 2) * rect.height };
        }
      });
      assert.ok(point, 'ME08-453 has a normal PDF difference marker');
      await page.mouse.click(point.x, point.y);
      await page.locator('.replacement-review:visible').waitFor();
      assert.match(await page.locator('.replacement-review:visible [data-status]').textContent(), /文字不一致/u);
      await page.evaluate(() => ReplacementReview.close());
    }
    for (const item of cases) for (const [start, end] of item.missing
      ? [[item.start, item.start], [item.end, item.end], [item.start + 1, item.end - 1]]
      : [[item.start, item.end]]) {
      await page.evaluate(([start, end]) => {
        ReplacementReview.close();
        const editor = readerMonaco.editor, index = PdfSelection.locator.editorSourceIndex(editor.getModel());
        editor.setSelection(window.PdfSelectionDiff.rangeAt(editor.getModel(), index.starts[start] ?? index.source.length,
          (Math.max(start, end) > start ? index.ends[(Math.max(start, end)) - 1] : index.starts[start]) ?? index.source.length));
      }, [start, end]);
      await page.waitForTimeout(120);
      assert.equal(await page.evaluate(() => htmlMarks()), before, `ME08-${number}: stable marks at ${start}:${end}`);
    }
    for (const item of cases.filter(item => item.missing)) {
      const point = await page.evaluate(item => {
        ReplacementReview.close(); window.caretNotices = [];
        const editor = readerMonaco.editor, index = PdfSelection.locator.editorSourceIndex(editor.getModel());
        const position = editor.getModel().getPositionAt(index.starts[Math.floor((item.start + item.end) / 2)]);
        editor.revealPositionInCenter(position); editor.render(true);
        const rect = editor.getDomNode().getBoundingClientRect(), visible = editor.getScrolledVisiblePosition(position);
        return visible && { x: rect.left + visible.left + 2, y: rect.top + visible.top + visible.height / 2 };
      }, item);
      assert.ok(point, `ME08-${number}: visible addition`);
      await page.mouse.click(point.x, point.y);
      await page.waitForFunction(item => window.caretNotices?.some(notice => notice.missing
        && notice.source.start >= item.start && notice.source.end <= item.end), item, { timeout: 3000 });
      assert.equal(await page.evaluate(() => htmlMarks()), before, `ME08-${number}: clicking additions keeps marks fixed`);
      assert.match(await page.locator('.replacement-review:visible [data-comparison]').textContent(), /HTML:.*PDF:/s);
    }
    console.log(`ME08-${number}: ${cases.length} candidates; selections and ${cases.filter(item => item.missing).length} additions passed`);
    assert.deepEqual(errors, [], `ME08-${number}`);
    await page.close();
  }
} finally {
  await browser.close();
  await stopServer(server);
}
