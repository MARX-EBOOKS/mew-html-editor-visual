import assert from 'node:assert/strict';
import { launchBrowser, startServer, stopServer } from './support/browser.mjs';

const server = await startServer('reader-server.js', 17064);
let browser;
try {
  browser = await launchBrowser();
  for (const split of [false, true]) {
    const context = await browser.newContext({ viewport: { width: 1800, height: 1100 } });
    const errors = [];
    context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
    await context.route('**/api/reader/settings', route => route.fulfill({ json: {
      scale: '0.75', diffHighlight: false, sourceDiffHighlight: true, selectionHighlight: !split,
      italicDetection: true, boldDetection: false
    } }));
    const reader = await context.newPage();
    await reader.goto(`http://127.0.0.1:17064/?volume=32&page=259&mode=source${split ? '&view=reader&sync=hover-link' : ''}`);
    let source = reader;
    if (split) {
      const popup = reader.waitForEvent('popup');
      await reader.evaluate(() => window.open('/index.html?readerSession=hover-link&file=32/ME32-259.html', 'mew-editor-hover-link'));
      source = await popup;
    }
    await source.waitForFunction(() => document.querySelector('.mew-ocr-diff-text'), null, { timeout: 60000 });
    await reader.evaluate(() => {
      window.linkEvents = [];
      addEventListener('pdf-selection-difference', event => { if (event.detail.candidateId) linkEvents.push(event.detail); });
    });
    for (const kind of ['text', 'font']) {
      await reader.evaluate(() => { ReplacementReview.close(); linkEvents.length = 0; });
      await source.bringToFront();
      await source.mouse.move(0, 0);
      await source.keyboard.press('Escape');
      const href = await source.evaluate(kind => {
        const editor = window.readerMonaco?.editor || mewWorkbench.editor, model = editor.getModel();
        window.sourceBeforeLink = model.getValue();
        const mark = model.getAllDecorations().find(mark => kind === 'text'
          ? mark.options.hoverMessage?.value.includes('erste Erw') : mark.options.inlineClassName === 'mew-font-diff-text'
            && model.getValueInRange(mark.range).trim().length > 2);
        if (!mark) throw Error(`ME32-259 fixture must include the ${kind} difference`);
        window.linkRange = mark.range;
        editor.setPosition({ lineNumber: 1, column: 1 });
        editor.revealRangeInCenter(mark.range);
        return mark.options.hoverMessage.value.match(/\((command:[^)]+)\)/)[1];
      }, kind);
      await source.waitForTimeout(150);
      const box = await source.evaluate(() => {
        const editor = window.readerMonaco?.editor || mewWorkbench.editor;
        const position = editor.getScrolledVisiblePosition(linkRange.getStartPosition());
        const rect = editor.getDomNode().getBoundingClientRect();
        return { x: rect.left + position.left + 2, y: rect.top + position.top + position.height / 2 };
      });
      await source.mouse.move(box.x, box.y);
      const link = source.locator(`.monaco-hover a[data-href="${href}"]`).first();
      await link.click({ timeout: 5000 });
      await reader.waitForFunction(kind => linkEvents.at(-1)?.kind === kind
        && ReplacementReview.isOpenFor('pdf-ocr', PdfSelection.editor)
        && document.querySelector('.replacement-review:not([hidden])[data-side="pdf"]')
        && document.querySelector('.mew-pdf-selection-highlight>div'), kind);
      if (kind === 'text') assert.match(await reader.locator('.replacement-review [data-comparison]').textContent(), /erste Erw/);
      else assert.match(await reader.locator('.replacement-review [data-status]').textContent(), /斜体不一致/);
      assert.equal(await source.evaluate(() => (window.readerMonaco?.editor || mewWorkbench.editor).getValue() === sourceBeforeLink), true);
      assert.equal(await reader.evaluate(() => linkEvents[0].side), 'pdf');
      if (split) assert.equal(await reader.evaluate(() => document.hasFocus()), true, 'the PDF window gains focus');
      assert.deepEqual(errors, []);
      console.log(`PASS ME32-259 ${kind} native hover PDF link (${split ? 'split, selection sync disabled' : 'combined'}): exact candidate, PDF popup and highlights`);
    }
    await context.close();
  }
} finally {
  await browser?.close();
  await stopServer(server);
}
