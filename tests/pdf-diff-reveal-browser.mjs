import assert from 'node:assert/strict';
import { launchBrowser, startServer, stopServer } from './support/browser.mjs';

const port = 17043;
const server = await startServer('reader-server.js', port);
let browser;
try {
  browser = await launchBrowser();
  for (const [number, physicalPage] of [[376], [429], [429, 452]]) {
    const context = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/reader/settings', route => route.fulfill({ json: { diffHighlight: true, selectionHighlight: true } }));
    await page.goto(`http://127.0.0.1:${port}/?volume=8&page=${number}&mode=source`);
    await page.waitForFunction(() => window.readerMonaco?.editor && document.querySelector('.mew-ocr-diff-text')
      && document.querySelector('.mew-pdf-review-pointer'), null, { timeout: 20000 });
    const original = await page.evaluate(() => readerMonaco.editor.getValue());
    if (physicalPage) {
      await page.evaluate(pageNumber => ReaderUI.getPdfViewer().scrollPageIntoView({pageNumber}),physicalPage);
      await page.waitForFunction(pageNumber => ReaderUI.getPdfViewer().currentPageNumber===pageNumber
        && document.querySelector(`.page[data-page-number="${pageNumber}"] .mew-pdf-review-pointer`),physicalPage);
    }
    const before = await page.evaluate(() => {
      const editor = readerMonaco.editor, viewer = ReaderUI.getPdfViewer();
      const mark = editor.getModel().getAllDecorations().filter(d => d.options.inlineClassName?.includes('mew-ocr-diff')).at(-1);
      window.testRange = mark.range;
      viewer.container.style.height = '240px'; viewer.container.style.flex = 'none';
      viewer.container.scrollTop = viewer.getPageView(viewer.currentPageNumber - 1).div.offsetTop;
      editor.revealRangeInCenter(mark.range);
      window.lastDifference = null;
      addEventListener('pdf-selection-difference', e => { window.lastDifference = e.detail; });
      return { page: viewer.currentPageNumber, text: editor.getModel().getValueInRange(mark.range), source: editor.getValue(), top: viewer.container.scrollTop };
    });
    await page.waitForTimeout(250);
    const click = await page.evaluate(() => {
      const editor = readerMonaco.editor, box = editor.getDomNode().getBoundingClientRect();
      const position = editor.getScrolledVisiblePosition({lineNumber:testRange.startLineNumber,column:testRange.startColumn});
      return {x:box.left+position.left+2,y:box.top+position.top+position.height/2};
    });
    await page.mouse.click(click.x,click.y);
    await page.waitForFunction(() => lastDifference && PdfSelection.status.mode === 'exact');
    const after = await page.evaluate(() => {
      const viewer = ReaderUI.getPdfViewer(), rect = viewer.container.getBoundingClientRect();
      return {page:viewer.currentPageNumber, source:readerMonaco.editor.getValue(), top:viewer.container.scrollTop, rect:{top:rect.top,bottom:rect.bottom},
        marks:[...document.querySelectorAll('.mew-pdf-selection-highlight:not(.mew-pdf-review-pointer) > div')].map(n=>{const b=n.getBoundingClientRect();return {left:b.left,right:b.right,top:b.top,bottom:b.bottom};})};
    });
    assert.equal(after.source,before.source);
    assert.equal(before.source,original,'both physical pages belong to the same HTML file');
    assert.ok(after.top>before.top,'the PDF target started outside the viewport');
    assert.ok(after.marks.some(b=>b.top>=after.rect.top && b.bottom<=after.rect.bottom),'clicked difference is revealed in the PDF viewport');
    const manualTop = await page.evaluate(() => {
      const container = ReaderUI.getPdfViewer().container;
      container.scrollTop -= 50; return container.scrollTop;
    });
    await page.waitForTimeout(150);
    assert.equal(await page.evaluate(() => ReaderUI.getPdfViewer().container.scrollTop),manualTop,'later manual scrolling stays free');
    await page.evaluate(() => {
      ReplacementReview.close(); readerMonaco.editor.setScrollTop(0);
      ReaderUI.getPdfViewer().container.scrollTop += 50;
    });
    await page.waitForTimeout(150);
    const pdfClick = await page.evaluate(() => {
      const editor = readerMonaco.editor, viewer = ReaderUI.getPdfViewer();
      const index = PdfSelection.locator.editorSourceIndex(editor.getModel());
      const range = index.rawRange(editor.getModel().getOffsetAt({lineNumber:testRange.startLineNumber,column:testRange.startColumn}),
        editor.getModel().getOffsetAt({lineNumber:testRange.endLineNumber,column:testRange.endColumn}));
      const div = viewer.getPageView(viewer.currentPageNumber-1).div, page = div.getBoundingClientRect();
      const notice = PdfReviewProvider.getHighlight(div,true).notices.find(n=>n.source && n.source.start<range.end && n.source.end>range.start);
      if (!notice) throw new Error('No PDF pointer for selected source difference');
      const box = notice.box;
      return {x:page.left+(box.x+box.w/2)*page.width,y:page.top+(box.y+box.h/2)*page.height};
    });
    await page.mouse.click(pdfClick.x,pdfClick.y);
    await page.waitForFunction(() => readerMonaco.editor.getScrollTop()>0, null, { timeout: 5000 });
    const html = await page.evaluate(() => {
      const editor = readerMonaco.editor, position = editor.getScrolledVisiblePosition({lineNumber:testRange.startLineNumber,column:testRange.startColumn});
      return {top:position.top,bottom:position.top+position.height,height:editor.getLayoutInfo().height,source:editor.getValue()};
    });
    assert.ok(html.top>=0 && html.bottom<=html.height,'PDF marker reveals its exact HTML position');
    assert.equal(html.source,before.source,'review navigation preserves HTML content');
    assert.deepEqual(errors,[]);
    console.log(`ME08-${number}, PDF ${before.page} → ${after.page}: offscreen PDF and HTML diff positions revealed; manual scrolling and content preserved`);
    await context.close();
  }
} finally {
  await browser?.close(); await stopServer(server);
}
