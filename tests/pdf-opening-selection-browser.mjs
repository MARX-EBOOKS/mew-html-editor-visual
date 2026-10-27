import assert from 'node:assert/strict';
import { launchBrowser, startServer, stopServer } from './support/browser.mjs';

const server = await startServer('reader-server.js', 17051);
let browser;
try {
  browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  await page.route('**/api/reader/settings', route => route.fulfill({ json: {
    diffHighlight: true, sourceDiffHighlight: true, selectionHighlight: true
  } }));
  await page.goto('http://127.0.0.1:17051/?volume=8&page=432&mode=source');
  // Start as soon as selection is available, without preparing mappings in the test.
  await page.waitForFunction(() => window.readerMonaco?.editor.getValue().includes('Man verstehe wohl!')
    && window.PdfSelection?.viewer?.pdfDocument);
  const points = await page.evaluate(() => {
    window.openingFallbacks = [];
    window.dragNotice = null;
    const prototype = PdfSelectionDiff.PdfSourceIndex.prototype;
    const locate = prototype.locate, matches = prototype.matches;
    prototype.locate = function (entry, ...args) {
      if (entry.text === 'Man verstehe wohl!') openingFallbacks.push('locate');
      return locate.call(this, entry, ...args);
    };
    prototype.matches = function (queries, ...args) {
      if (!this.source && queries.some(q => ['Man verstehe wohl!', 'man', 'verstehe', 'wohl'].includes(q)))
        openingFallbacks.push('word search');
      return matches.call(this, queries, ...args);
    };
    addEventListener('pdf-selection-difference', event => {
      const notice = event.detail.notices?.find(n => n.html === 'Man verstehe wohl!');
      if (notice) window.dragNotice = notice;
    });
    const editor = readerMonaco.editor, model = editor.getModel(), text = 'Man verstehe wohl!';
    const start = model.getValue().indexOf(text), a = model.getPositionAt(start), b = model.getPositionAt(start + text.length);
    editor.revealRangeInCenter({ startLineNumber: a.lineNumber, startColumn: a.column, endLineNumber: b.lineNumber, endColumn: b.column });
    editor.render(true);
    const box = editor.getDomNode().getBoundingClientRect();
    return [a, b].map(position => {
      const point = editor.getScrolledVisiblePosition(position);
      return { x: box.left + point.left, y: box.top + point.top + point.height / 2 };
    });
  });
  await page.mouse.move(points[0].x, points[0].y);
  await page.mouse.down();
  await page.mouse.move(points[1].x, points[1].y, { steps: 12 });
  await page.mouse.up();
  await page.waitForFunction(() => window.dragNotice && PdfSelection.status.state === 'idle', null, { timeout: 10000 });
  const result = await page.evaluate(() => ({
    fallbacks: openingFallbacks, mode: PdfSelection.status.mode,
    pdf: dragNotice.pdf, painted: dragNotice.target.index.raw.slice(dragNotice.target.start, dragNotice.target.end)
  }));
  assert.deepEqual(result.fallbacks, [], 'a physical drag must not use passage lookup or word search');
  assert.equal(result.mode, 'exact');
  assert.equal(result.pdf, 'Ma?  ^rsteke wohl!');
  assert.equal(result.painted, result.pdf);
  console.log('ME08-432 cold physical drag: exact mapping, zero passage/word-search fallbacks');
} finally { await browser?.close(); await stopServer(server); }
