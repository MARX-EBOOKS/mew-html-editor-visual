import assert from 'node:assert/strict';
import { launchBrowser, startServer, stopServer } from './support/browser.mjs';

const server = await startServer('reader-server.js', 17061);
let browser;
try {
  browser = await launchBrowser();
  for (const number of [153, 155]) {
    const page = await browser.newPage({ viewport: { width: 1800, height: 1100 } });
    await page.route('**/api/reader/settings', route => route.fulfill({ json: {
      diffHighlight: true, sourceDiffHighlight: true, selectionHighlight: true,
      italicDetection: true, boldDetection: true
    } }));
    await page.goto(`http://127.0.0.1:17061/?volume=32&page=${number}&mode=source`);
    await page.waitForFunction(() => window.readerMonaco?.editor && window.PdfSelection
      && document.querySelector('.textLayer span') && document.querySelector('.mew-pdf-review-pointer'),
    null, { timeout: 60000 });
    await page.waitForTimeout(5000);
    await page.evaluate(() => {
      const editor = readerMonaco.editor, locator = PdfSelection.locator;
      window.samples = [];
      for (const name of ['diff']) {
        const original = PdfSelectionDiff.PdfSourceIndex.prototype[name];
        PdfSelectionDiff.PdfSourceIndex.prototype[name] = function (...args) {
          const start = performance.now();
          try { return original.apply(this, args); }
          finally { samples.push([name, performance.now() - start]); }
        };
      }
      const proto = PdfSelectionDiff.PdfSourceIndex.prototype;
      for (const name of ['sourceDecorations', 'reviewCandidates', 'rememberConnection', 'sourcePageScope']) {
        const original = proto[name];
        proto[name] = function (...args) {
          const start = performance.now();
          try { return original.apply(this, args); }
          finally { samples.push([name, performance.now() - start]); }
        };
      }
      window.marks = () => JSON.stringify(editor.getModel().getAllDecorations()
        .filter(mark => /PDF.*difference/.test(mark.options.description)).map(mark => [mark.range, mark.options.inlineClassName]));
      window.initialMarks = marks();
      window.markChanges = 0;
      editor.getModel().onDidChangeDecorations(() => { if (marks() !== initialMarks) markChanges++; });
    });
    const items = await page.evaluate(() => {
      const editor = readerMonaco.editor, index = PdfSelection.locator.editorSourceIndex(editor.getModel());
      return index.reviewCandidates(null, false, true, true, PdfSelection.locator.environment.getTargets()).slice(0, 5)
        .map(item => ({ start: item.sourceStart, end: item.sourceEnd, html: item.comparison.html }));
    });
    for (const item of items) {
      await page.evaluate(item => {
        const editor = readerMonaco.editor, index = PdfSelection.locator.editorSourceIndex(editor.getModel());
        const range = window.PdfSelectionDiff.rangeAt(editor.getModel(), index.starts[item.start] ?? index.source.length,
          (item.end > item.start ? index.ends[(item.end) - 1] : index.starts[item.start]) ?? index.source.length);
        editor.revealRangeInCenter(range);
      }, item);
      const box = await page.evaluate(item => {
        const editor = readerMonaco.editor, index = PdfSelection.locator.editorSourceIndex(editor.getModel());
        const range = window.PdfSelectionDiff.rangeAt(editor.getModel(), index.starts[item.start] ?? index.source.length,
          (item.end > item.start ? index.ends[(item.end) - 1] : index.starts[item.start]) ?? index.source.length);
        const at = editor.getScrolledVisiblePosition({ lineNumber: range.startLineNumber, column: range.startColumn }), rect = editor.getDomNode().getBoundingClientRect();
        return { x: rect.left + at.left + 1, y: rect.top + at.top + at.height / 2 };
      }, item);
      await page.mouse.click(box.x, box.y);
      await page.waitForTimeout(350);
      await page.evaluate(() => ReplacementReview.close());
    }
    const result = await page.evaluate(() => ({ markChanges, stable: marks() === initialMarks,
      costs: Object.fromEntries([...new Set(samples.map(s => s[0]))].map(name => {
        const times = samples.filter(s => s[0] === name).map(s => s[1]);
        return [name, { count: times.length, max: Math.max(...times), total: times.reduce((a,b) => a+b, 0) }];
      })) }));
    console.log(number, items, result);
    assert.equal(result.markChanges, 0, `ME32-${number}: clicks preserve all source marks`);
    assert.equal(result.costs.sourceDecorations, undefined, 'clicks reuse the prepared decorations');
    const drag = await page.evaluate(() => {
      const editor = readerMonaco.editor, locator = PdfSelection.locator;
      const source = locator.editorSourceIndex(editor.getModel());
      for (const target of locator.environment.getTargets().filter(target => target.layer)) {
        for (const part of target.parts) {
          const length = Math.min(16, part.node.length - 1);
          if (length < 4 || !source.connectedRange(target, part.start + 1, part.start + length, true)) continue;
          const range = document.createRange();
          range.setStart(part.node, 1); range.setEnd(part.node, length);
          const rect = range.getBoundingClientRect();
          if (rect.top < 100 || rect.bottom > innerHeight - 30 || rect.width < 20) continue;
          return { x: rect.left + 1, y: rect.top + rect.height / 2, end: rect.right - 1 };
        }
      }
    });
    assert.ok(drag, 'a visible mapped PDF passage is available');
    await page.mouse.move(drag.x, drag.y);
    await page.mouse.down();
    await page.mouse.move(drag.end, drag.y, { steps: 12 });
    await page.mouse.up();
    await page.waitForFunction(() => PdfSelection.status.mode === 'pdf-selection'
      && !readerMonaco.editor.getSelection().isEmpty());
    assert.equal(await page.evaluate(() => marks() === initialMarks), true, 'PDF dragging preserves source marks');
    await page.close();
  }
} finally {
  await browser?.close();
  await stopServer(server);
}



