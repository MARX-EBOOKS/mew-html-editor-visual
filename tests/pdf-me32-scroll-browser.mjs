import assert from 'node:assert/strict';
import { launchBrowser, startServer, stopServer } from './support/browser.mjs';

const server = await startServer('reader-server.js', 17062);
let browser;
try {
  browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1800, height: 1100 } });
  await page.route('**/api/reader/settings', route => route.fulfill({ json: {
    diffHighlight: true, sourceDiffHighlight: true, selectionHighlight: true,
    italicDetection: true, boldDetection: true
  } }));
  await page.goto('http://127.0.0.1:17062/?volume=32&page=152&mode=source');
  await page.waitForFunction(() => window.PdfSelection?.viewer && window.readerMonaco?.editor
    && document.querySelector('.mew-pdf-review-pointer'), null, { timeout: 60000 });
  const first = await page.evaluate(() => PdfSelection.viewer.currentPageNumber);
  const snapshots = [];
  for (const offset of [0, 1, 2, 1, 0, 1]) {
    const scroll = await page.evaluate(number => {
      const viewer = PdfSelection.viewer, rect = viewer.container.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2,
        delta: viewer.getPageView(number - 1).div.getBoundingClientRect().top - rect.top };
    }, first + offset);
    await page.mouse.move(scroll.x, scroll.y);
    await page.mouse.wheel(0, scroll.delta);
    await page.waitForFunction(number => PdfSelection.viewer.currentPageNumber === number, first + offset);
    await page.waitForTimeout(5000);
    const snapshot = await page.evaluate(() => {
      const editor = readerMonaco.editor, locator = PdfSelection.locator, index = locator.editorSourceIndex(editor.getModel());
      const targets = locator.environment.getTargets();
      const items = index.reviewCandidates(null, false, true, true, targets);
      return { page: PdfSelection.viewer.currentPageNumber,
        marks: editor.getModel().getAllDecorations().filter(mark => /PDF.*difference/.test(mark.options.description))
          .map(mark => [mark.options.description, mark.range, mark.options.inlineClassName]),
        items: items.map(item => [item.sourceStart, item.sourceEnd, item.comparison.html, item.comparison.pdf]) };
    });
    snapshots.push(snapshot);
    console.log(JSON.stringify({ offset, page: snapshot.page, marks: snapshot.marks.length, items: snapshot.items.length }));
  }
  const visits = snapshots.filter(snapshot => snapshot.page === first + 1);
  for (const visit of visits.slice(1)) {
    assert.deepEqual(visit.items, visits[0].items, 'returning to ME32-153 keeps its prepared text differences');
    assert.deepEqual(visit.marks, visits[0].marks, 'returning to ME32-153 keeps its source highlights');
  }
} finally {
  await browser?.close();
  await stopServer(server);
}
