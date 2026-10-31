import assert from 'node:assert/strict';
import { launchBrowser, startServer, stopServer } from './support/browser.mjs';

const server = await startServer('reader-server.js', 17063);
let browser;
try {
  browser = await launchBrowser();
  for (const scale of [1, 1.2]) {
    const page = await browser.newPage({ viewport: { width: 1800, height: 1100 } });
    await page.route('**/api/reader/settings', route => route.fulfill({ json: {
      scale: '0.75', diffHighlight: false, sourceDiffHighlight: true, selectionHighlight: true,
      italicDetection: true, boldDetection: false
    } }));
    await page.goto('http://127.0.0.1:17063/?volume=32&page=168&mode=source');
    await page.waitForFunction(() => window.readerMonaco?.editor && window.PdfSelection
      && document.querySelector('.mew-ocr-diff-text'), null, { timeout: 60000 });
    const source = await page.evaluate(() => readerMonaco.editor.getValue());
    await page.evaluate(scale => {
      const editor = readerMonaco.editor;
      document.documentElement.style.zoom = scale; editor.layout();
      const viewer = PdfSelection.viewer;
      viewer.container.style.height = '240px'; viewer.container.style.flex = 'none';
    }, scale);
    for (const fraction of [.25, .75, .95, 1.25]) {
      const range = await page.evaluate(() => {
        ReplacementReview.close();
        const editor = readerMonaco.editor, model = editor.getModel();
        const index = PdfSelection.locator.editorSourceIndex(model), start = index.raw.indexOf('raison') + 5;
        const range = window.PdfSelectionDiff.rangeAt(model, index.starts[start] ?? index.source.length,
          (start + 1 > start ? index.ends[(start + 1) - 1] : index.starts[start]) ?? index.source.length);
        editor.revealRangeInCenter(range);
        const viewer = PdfSelection.viewer;
        viewer.container.scrollTop = viewer.getPageView(viewer.currentPageNumber - 1).div.offsetTop;
        return range;
      });
      await page.waitForTimeout(150);
      const box = await page.evaluate(({ range, fraction }) => {
        const editor = readerMonaco.editor, rect = editor.getDomNode().getBoundingClientRect();
        const start = editor.getScrolledVisiblePosition({ lineNumber: range.startLineNumber, column: range.startColumn });
        const end = editor.getScrolledVisiblePosition({ lineNumber: range.endLineNumber, column: range.endColumn });
        const scale = rect.width / editor.getDomNode().offsetWidth;
        return { x: rect.left + (start.left + (end.left - start.left) * fraction) * scale,
          y: rect.top + (start.top + start.height / 2) * scale };
      }, { range, fraction });
      await page.mouse.click(box.x, box.y);
      await page.waitForTimeout(400);
      const result = await page.evaluate(() => ({
        differences: PdfSelection.status.differences,
        boxes: document.querySelectorAll('.mew-pdf-selection-highlight:not(.mew-pdf-review-pointer)>div').length,
        popup: !document.querySelector('.replacement-review').hidden,
        source: readerMonaco.editor.getValue()
      }));
      assert.equal(result.source, source, 'clicks preserve the HTML');
      if (fraction < 1) {
        assert.ok(result.differences.some(item => item.html === 'n' && item.pdf === 'ri'), `raison n at ${fraction}`);
        assert.ok(result.boxes > 0, 'the corresponding OCR characters are highlighted');
        assert.ok(await page.evaluate(() => {
          const rect = PdfSelection.viewer.container.getBoundingClientRect();
          return [...document.querySelectorAll('.mew-pdf-selection-highlight:not(.mew-pdf-review-pointer)>div')]
            .some(node => { const box = node.getBoundingClientRect(); return box.top >= rect.top && box.bottom <= rect.bottom; });
        }), `the PDF jumps to the highlighted n at ${scale} zoom, ${fraction} of its width`);
        assert.equal(result.popup, true);
      } else {
        assert.equal(result.boxes, 0, 'a click beyond n does not select its PDF counterpart');
        assert.equal(result.popup, false);
      }
    }
    for (const text of ['raiso', 'raison', 'und raiso', 'und raison']) {
      const range = await page.evaluate(text => {
        ReplacementReview.close(); PdfSelection.clear();
        const editor = readerMonaco.editor, model = editor.getModel();
        const index = PdfSelection.locator.editorSourceIndex(model), start = index.raw.indexOf(text);
        const range = window.PdfSelectionDiff.rangeAt(model, index.starts[start] ?? index.source.length,
          (start + text.length > start ? index.ends[(start + text.length) - 1] : index.starts[start]) ?? index.source.length);
        editor.setPosition({ lineNumber: range.startLineNumber, column: range.startColumn });
        editor.revealRangeInCenter(range);
        const viewer = PdfSelection.viewer;
        viewer.container.scrollTop = viewer.getPageView(viewer.currentPageNumber - 1).div.offsetTop;
        return range;
      }, text);
      await page.waitForTimeout(150);
      const points = await page.evaluate(range => {
        const editor = readerMonaco.editor, node = editor.getDomNode(), rect = node.getBoundingClientRect();
        const scale = rect.width / node.offsetWidth;
        return [{ lineNumber: range.startLineNumber, column: range.startColumn },
          { lineNumber: range.endLineNumber, column: range.endColumn }].map(position => {
          const point = editor.getScrolledVisiblePosition(position);
          return { x: rect.left + (point.left + .1) * scale,
            y: rect.top + (point.top + point.height / 2) * scale };
        });
      }, range);
      await page.mouse.move(points[0].x, points[0].y);
      await page.mouse.down();
      await page.mouse.move(points[1].x, points[1].y, { steps: 15 });
      await page.mouse.up();
      await page.waitForTimeout(500);
      const result = await page.evaluate(() => {
        const editor = readerMonaco.editor, rect = PdfSelection.viewer.container.getBoundingClientRect();
        return { source: editor.getValue(), selection: editor.getModel().getValueInRange(editor.getSelection()),
          visible: [...document.querySelectorAll('.mew-pdf-selection-highlight:not(.mew-pdf-review-pointer)>div')]
            .some(node => { const box = node.getBoundingClientRect(); return box.top >= rect.top && box.bottom <= rect.bottom; }),
          popup: !document.querySelector('.replacement-review').hidden,
          differences: PdfSelection.status.differences };
      });
      assert.equal(result.source, source, 'dragging preserves the HTML');
      assert.equal(result.selection, text, 'review preserves the complete explicit selection');
      assert.ok(result.visible, `${text} highlights its PDF counterpart and scrolls it into view at ${scale} zoom`);
      assert.equal(result.popup, text.endsWith('raison'), 'only a selection containing a difference opens text review');
      if (text.endsWith('raison')) assert.ok(result.differences.some(item => item.html === text && item.pdf === text.replace('raison', 'raisori')));
    }
    await page.evaluate(() => {
      ReplacementReview.close(); PdfSelection.clear();
      const editor = readerMonaco.editor, model = editor.getModel();
      const index = PdfSelection.locator.editorSourceIndex(model), end = index.raw.indexOf('raison') + 6;
      const range = window.PdfSelectionDiff.rangeAt(model, index.starts[end] ?? index.source.length,
        index.starts[end] ?? index.source.length);
      editor.setPosition({ lineNumber: range.startLineNumber, column: range.startColumn + 1 });
      editor.focus();
    });
    await page.keyboard.press('ArrowLeft');
    await page.waitForTimeout(400);
    assert.ok(await page.evaluate(() => PdfSelection.status.differences.some(item => item.html === 'n' && item.pdf === 'ri')),
      'a keyboard caret at the word-ending diff highlights its PDF counterpart');
    assert.ok(await page.locator('.mew-pdf-selection-highlight:not(.mew-pdf-review-pointer)>div').count() > 0);
    for (const olderSelection of [false, true]) {
      const before = await page.evaluate(olderSelection => {
        ReplacementReview.close(); PdfSelection.clear();
        const editor = readerMonaco.editor, model = editor.getModel(), locator = PdfSelection.locator;
        const index = locator.editorSourceIndex(model), start = index.raw.indexOf('raison') + 5;
        window.reviewItem = index.reviewCandidates(null, false, true, true, locator.environment.getTargets()).find(item => item.sourceStart === start);
        if (olderSelection) {
          const previous = index.raw.indexOf('honneur');
          editor.setSelection(window.PdfSelectionDiff.rangeAt(model, index.starts[previous] ?? index.source.length,
            (previous + 7 > previous ? index.ends[(previous + 7) - 1] : index.starts[previous]) ?? index.source.length));
        }
        const viewer = PdfSelection.viewer;
        viewer.container.style.height = '240px'; viewer.container.style.flex = 'none';
        viewer.container.scrollTop = viewer.getPageView(viewer.currentPageNumber - 1).div.offsetTop;
        return viewer.container.scrollTop;
      }, olderSelection);
      await page.waitForTimeout(200);
      await page.evaluate(() => PdfSelection.showReviewPointer(readerMonaco.editor, [reviewItem]));
      await page.waitForFunction(() => {
        const rect = PdfSelection.viewer.container.getBoundingClientRect();
        return [...document.querySelectorAll('.mew-pdf-selection-highlight:not(.mew-pdf-review-pointer)>div')]
          .some(node => { const box = node.getBoundingClientRect(); return box.top >= rect.top && box.bottom <= rect.bottom; });
      });
      assert.ok(await page.evaluate(() => PdfSelection.viewer.container.scrollTop) > before,
        'the active review item scrolls into view even after an older selection');
      assert.ok(await page.evaluate(() => PdfSelection.status.differences.some(item => item.html === 'n' && item.pdf === 'ri')));
      const manual = await page.evaluate(() => { const stage = PdfSelection.viewer.container; stage.scrollTop -= 20; return stage.scrollTop; });
      await page.waitForTimeout(200);
      assert.equal(await page.evaluate(() => PdfSelection.viewer.container.scrollTop), manual, 'manual scrolling remains free');
    }
    // Taller fallback glyphs used to sort show-through OCR into the raison line.
    await page.evaluate(() => document.querySelectorAll('.textLayer span').forEach(node => {
      node.style.scale = '1 1.5'; node.style.transformOrigin = 'top left';
    }));
    await page.waitForTimeout(300);
    for (const text of ['n', 'raiso', 'raison', 'paragraph through raiso']) {
      await page.evaluate(text => {
        ReplacementReview.close(); PdfSelection.clear();
        const editor = readerMonaco.editor, model = editor.getModel();
        const index = PdfSelection.locator.editorSourceIndex(model), word = index.raw.indexOf('raison');
        const start = text.startsWith('paragraph') ? index.raw.indexOf('erlichsten Operationen') : word + (text === 'n' ? 5 : 0);
        const end = word + (text === 'n' || text === 'raison' ? 6 : 5);
        editor.setSelection(window.PdfSelectionDiff.rangeAt(model, index.starts[start] ?? index.source.length,
          (end > start ? index.ends[(end) - 1] : index.starts[start]) ?? index.source.length));
        const viewer = PdfSelection.viewer;
        viewer.container.scrollTop = viewer.getPageView(viewer.currentPageNumber - 1).div.offsetTop;
      }, text);
      await page.waitForTimeout(600);
      const result = await page.evaluate(() => {
        const rect = PdfSelection.viewer.container.getBoundingClientRect();
        const boxes = [...document.querySelectorAll('.mew-pdf-selection-highlight:not(.mew-pdf-review-pointer)>div')];
        return { source: readerMonaco.editor.getValue(), matches: PdfSelection.status.matches, boxes: boxes.length,
          visible: boxes.some(node => { const box = node.getBoundingClientRect(); return box.top >= rect.top && box.bottom <= rect.bottom; }),
          popup: !document.querySelector('.replacement-review').hidden };
      });
      assert.equal(result.source, source);
      assert.ok(result.matches > 0 && result.boxes > 0, `${text} survives interleaved show-through OCR`);
      assert.ok(result.visible, `${text} scrolls its PDF highlight into view despite show-through OCR`);
      assert.equal(result.popup, text !== 'raiso');
    }
    await page.close();
  }
  console.log('ME32-168 raison n: clicks highlight and reveal PDF ri at normal and 120% zoom with default highlights off.');
} finally {
  await browser?.close();
  await stopServer(server);
}
