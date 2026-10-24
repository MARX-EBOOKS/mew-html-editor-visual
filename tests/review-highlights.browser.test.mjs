import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { launchBrowser } from './support/browser.mjs';

const source = await readFile(new URL('../public/pdfdiff/replacement-review.js', import.meta.url), 'utf8');

test('highlight tool works without PDF modules and keeps consumers and decoration caches independent', async () => {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.setContent('<div id="text" style="position:relative;width:300px;height:40px"><span>Alpha beta</span></div>');
    await page.addScriptTag({ content: source });
    const result = await page.evaluate(() => {
      const div = document.getElementById('text'), node = div.firstElementChild.firstChild;
      const first = ReviewHighlights.create({ document });
      const second = ReviewHighlights.create({ document, classes: { selection: 'other-highlight' } });
      const index = { raw: node.data, parts: [{ node, start: 0, end: node.length }], partsInRange() { return this.parts; } };
      const hit = { start: 6, end: 10 }, measured = first.measureHighlights(div, index, [hit], hit);
      const caret = first.measureHighlights(div, index, [{ start: 5, end: 5 }]);
      const painted = first.paintHighlight(div, measured.boxes, 'orange');
      const reused = first.paintHighlight(div, measured.boxes, 'orange') === painted;
      second.paintHighlight(div, caret.boxes, 'blue');
      let updates = 0, clears = 0, subscriptions = 0, builds = 0, modelChanged;
      const mark = { containsPosition: () => true };
      const collection = { set() { updates++; }, clear() { clears++; }, length: 1, getRange: () => mark };
      const editor = {
        getDomNode: () => div, createDecorationsCollection: () => collection,
        onDidChangeModel(callback) { modelChanged = callback; return { dispose() { subscriptions++; } }; }
      };
      const key = [index], decorations = () => { builds++; return []; };
      first.updateSource(editor, key, decorations, '.marker{color:red}');
      first.updateSource(editor, key, decorations, '.marker{color:red}');
      const cacheReused = updates === 1 && builds === 1;
      modelChanged();
      first.updateSource(editor, key, decorations, '.marker{color:red}');
      const range = { isEmpty: () => true, getStartPosition: () => ({ lineNumber: 1, column: 2 }) };
      const selectsMark = first.selectionRange(editor, {}, range) === mark;
      const dragKept = first.selectionRange(editor, {}, { isEmpty: () => false }) === null;
      first.dispose();
      const independent = !painted.node.isConnected && second.getHighlight(div).node.isConnected;
      const noInsertedText = div.textContent === 'Alpha beta';
      second.dispose();
      return { noPdfModules: !window.PdfSelectionDiff && !window.PdfReviewProvider,
        measured: measured.boxes.length > 0 && measured.focus.w > 0,
        caret: caret.boxes.length > 0 && caret.boxes.every(box => box.caret && box.w > 0),
        reused, cacheReused, invalidated: updates === 2 && builds === 2,
        selectsMark, dragKept, independent, noInsertedText,
        disposed: clears === 2 && subscriptions === 1 && !document.querySelector('style,.review-highlight,.other-highlight') };
    });
    for (const [check, passed] of Object.entries(result)) assert.equal(passed, true, check);
  } finally { await browser.close(); }
});
