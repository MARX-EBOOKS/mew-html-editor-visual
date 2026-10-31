import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchBrowser, startServer, stopServer } from './support/browser.mjs';
import { engineSource, highlightSource } from './support/pdf-harness.mjs';

test('single-character highlights and ME08-427 insertions open review from both halves and replace exactly', async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), 'mew-space-highlight-'));
  let server, browser;
  try {
    const before = 'A unique opening passage establishes the comparison and its reliable surrounding context. ';
    const after = ' wie Marx dem spiritus familiaris, dem Polizeiagenten Stiebers mitteilen konnte.';
    await writeFile(path.join(fixture, 'a.html'), '<p>ready</p>');
    server = await startServer('server.js', 41881, ['-r', fixture]);
    browser = await launchBrowser();
    const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } }), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/reader/settings', route => route.fulfill({ json: { diffHighlight: true, selectionHighlight: true } }));
    await page.goto('http://127.0.0.1:41881/?file=a.html');
    await page.waitForFunction(() => window.mewWorkbench?.editor && window.PdfReviewProvider);
    await page.evaluate(() => {
      window.testEditor = mewWorkbench.editor;
      testEditor.updateOptions({ wordWrap: 'on' });
      testEditor.layout({ width: 700, height: 500 });
      const stage = document.createElement('div');
      stage.style.cssText = 'position:fixed;right:0;top:600px;width:700px;height:300px;background:white';
      stage.innerHTML = '<div class="pdfViewer"><div class="page" style="position:relative;width:700px;height:300px"><div class="textLayer" style="font:16px monospace;white-space:pre-wrap"><span></span></div></div></div>';
      document.body.append(stage);
      const div = stage.querySelector('.page');
      window.mockViewer = { container: stage, viewer: stage.firstChild, currentPageNumber: 1,
        _getVisiblePages: () => ({ views: [{ id: 1 }] }), getPageView: () => ({ div }),
        eventBus: { on() {}, off() {} } };
      window.ReaderUI = { getPdfViewer: () => mockViewer };
    });
    await page.addScriptTag({ url: '/pdfdiff/pdf-selection.js' });
    await page.waitForFunction(() => window.PdfSelection);
    for (const [html, pdf, expected] of [
      ['So wenig', 'So’wenig', '’'], ['So wenig', 'SoX wenig', 'X'],
      ['So wenig', 'So Xwenig', 'X'], ['So awenig', 'So bwenig', 'b']
    ]) {
      const source = '<p>' + before + html + after + '</p>', raw = before + pdf + after;
      await page.evaluate(({ source, raw }) => {
        ReplacementReview.close(); testEditor.setValue(source);
        mockViewer.getPageView(0).div.querySelector('span').textContent = raw;
        mockViewer.pdfDocument = { numPages: 1, async getPage() { return { async getTextContent() {
          return { items: [{ str: raw, transform: [1, 0, 0, 1, 0, 200], width: 700, height: 16 }] };
        } }; } };
        PdfSelection.attachViewer(mockViewer); PdfSelection.attachEditor(testEditor);
      }, { source, raw });
      const mark = pdf === 'SoX wenig' || pdf === 'So Xwenig' ? page.locator('.mew-ocr-diff-insert').first()
        : page.locator('.mew-ocr-diff-text').filter({ hasText: html === 'So awenig' ? /^a$/u : /^[ \u00a0]+$/u }).first();
      await page.evaluate(() => {
        const model = testEditor.getModel(), at = model.getValue().indexOf('So ') + 2;
        testEditor.revealPositionInCenter(model.getPositionAt(at));
      });
      const popup = page.locator('.replacement-review:visible');
      for (const fraction of [0.25, 0.75]) {
        await page.evaluate(() => ReplacementReview.close());
        await mark.waitFor({ state: 'visible', timeout: 5000 });
        const box = await mark.boundingBox({ timeout: 5000 });
        await page.mouse.click(box.x + box.width * fraction, box.y + box.height / 2);
        await popup.waitFor({ timeout: 3000 });
      }
      assert.ok((await popup.locator('[data-comparison] mark').allTextContents()).includes(expected));
      assert.equal(await page.evaluate(() => testEditor.getValue()), source, 'clicking the space only opens review');
      await popup.locator('[data-save]').click({ timeout: 3000 });
      await page.waitForFunction(expected => testEditor.getValue() === expected, '<p>' + raw + '</p>', { timeout: 3000 });
      assert.equal(await page.evaluate(() => testEditor.getValue()), '<p>' + raw + '</p>');
      await page.evaluate(() => testEditor.trigger('test', 'undo', null));
      assert.equal(await page.evaluate(() => testEditor.getValue()), source);
    }
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await stopServer(server); await rm(fixture, { recursive: true, force: true }); }
});

for (const revealedBy of [null, 'updateviewarea', 'pagechanging']) {
test(`first open highlights both sides without selecting or opening review${revealedBy ? ' after late layout: ' + revealedBy : ''}`, async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), 'mew-first-highlight-'));
  let server, browser;
  try {
    const before = 'The opening passage supplies enough unique words to establish a reliable comparison. ';
    const after = 'The closing passage also contains unique words so the missing text is mapped reliably.';
    const html = '<p>' + before + 'EXTRA ' + after + '</p>';
    await writeFile(path.join(fixture, 'a.html'), html);
    server = await startServer('server.js', 41881, ['-r', fixture]);
    browser = await launchBrowser();
    const page = await browser.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/reader/settings', route => route.fulfill({ json: { diffHighlight: true, selectionHighlight: true } }));
    await page.goto('http://127.0.0.1:41881/?file=a.html');
    await page.waitForFunction(() => window.mewWorkbench?.editor.getValue().includes('EXTRA') && window.PdfReviewProvider);
    await page.evaluate(({ raw, revealedBy }) => {
      const stage = document.createElement('div');
      stage.style.cssText = 'position:fixed;right:0;top:300px;width:700px;height:300px;background:white';
      stage.innerHTML = '<div class="pdfViewer"><div class="page" style="position:relative;width:700px;height:300px"><div class="textLayer"><span></span></div></div></div>';
      stage.querySelector('span').textContent = raw;
      if (revealedBy) {
        stage.style.display = 'none';
        window.pendingTextLayer = stage.querySelector('.textLayer');
        pendingTextLayer.remove();
      }
      document.body.append(stage);
      const div = stage.querySelector('.page');
      const listeners = new Map();
      window.mockViewer = { container: stage, viewer: stage.firstChild, currentPageNumber: 1,
        _getVisiblePages: () => ({ views: [{ id: 1 }] }), getPageView: () => ({ div }),
        eventBus: { on(name, fn) { listeners.set(name, fn); }, off(name) { listeners.delete(name); },
          dispatch(name, data) { listeners.get(name)?.(data); } },
        pdfDocument: { numPages: 1, async getPage() { return { async getTextContent() {
          return { items: [{ str: raw, transform: [1, 0, 0, 1, 0, 200], width: 700, height: 20 }] };
        } }; } } };
      window.ReaderUI = { getPdfViewer: () => mockViewer };
      window.sourceUpdates = 0;
      addEventListener('pdf-selection-sources', () => sourceUpdates++);
    }, { raw: before + after, revealedBy });
    await page.addScriptTag({ url: '/pdfdiff/pdf-selection.js' });
    await page.waitForFunction(() => window.PdfSelection);
    if (revealedBy) {
      await page.waitForFunction(() => sourceUpdates > 0);
      assert.equal(await page.locator('.mew-pdf-review-pointer').count(), 0);
      await page.evaluate(event => {
        mockViewer.getPageView(0).div.append(pendingTextLayer);
        mockViewer.container.style.display = '';
        mockViewer.eventBus.dispatch(event, { pageNumber: 1 });
      }, revealedBy);
    }
    await page.waitForSelector('.mew-ocr-diff-text', { timeout: 3000 });
    await page.waitForSelector('.mew-pdf-review-pointer .mew-pdf-selection-caret', { timeout: 3000 });
    await page.waitForFunction(() => [...document.querySelectorAll('.mew-ocr-diff-text')]
      .some(node => getComputedStyle(node).backgroundColor === 'rgba(255, 166, 40, 0.3)'), null, { timeout: 3000 });
    assert.equal(await page.locator('.mew-pdf-review-pointer').evaluate(node => getComputedStyle(node).zIndex), '20');
    assert.equal(await page.evaluate(() => mewWorkbench.editor.getSelection().isEmpty()), true);
    assert.equal(await page.locator('.replacement-review:visible').count(), 0);
    await page.evaluate(() => PdfSelection.setDiffHighlight(false));
    assert.equal(await page.locator('.mew-pdf-review-pointer').count(), 0);
    await page.evaluate(() => PdfSelection.setDiffHighlight(true));
    await page.waitForSelector('.mew-pdf-review-pointer .mew-pdf-selection-caret');
    // Programmatic page loading also emits cursor changes; neither is a user edit.
    const loaded = await page.evaluate(async () => {
      const editor = mewWorkbench.editor, start = performance.now();
      editor.setValue(editor.getValue().replace('EXTRA ', 'SURPLUS '));
      editor.setPosition({ lineNumber: 1, column: 1 });
      while (performance.now() - start < 200) {
        if ([...document.querySelectorAll('.mew-ocr-diff-text')].some(e => e.textContent === 'SURPLUS'))
          return { marked: true, collapsed: editor.getSelection().isEmpty() };
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      return { marked: false };
    });
    assert.deepEqual(loaded, { marked: true, collapsed: true }, 'a page load paints before the 350 ms typing debounce');
    if (!revealedBy) {
      await page.evaluate(() => {
        window.highlightClicks = [];
        addEventListener('pdf-selection-difference', event => highlightClicks.push(event.detail));
        PdfSelection.setSelectionHighlight(false);
      });
      await page.mouse.click(690, 580);
      assert.equal(await page.evaluate(() => highlightClicks.length), 0, 'clicking outside a marker does not open review');
      const mark = await page.locator('.mew-pdf-review-pointer > div').first().boundingBox();
      await page.mouse.click(mark.x + mark.width / 2, mark.y + mark.height / 2);
      await page.waitForSelector('.replacement-review:visible', { timeout: 3000 });
      assert.equal(await page.evaluate(() => highlightClicks.length), 1, 'default marker uses the existing difference event even with selection sync disabled');
      assert.equal(await page.evaluate(() => highlightClicks[0].notices[0].source.index.raw.slice(
        highlightClicks[0].notices[0].source.start, highlightClicks[0].notices[0].source.end)), 'SURPLUS ');
      await page.evaluate(() => ReplacementReview.close());
      await page.mouse.click(mark.x + mark.width / 2, mark.y + mark.height / 2);
      await page.waitForSelector('.replacement-review:visible', { timeout: 3000 });
      assert.equal(await page.evaluate(() => highlightClicks.length), 2, 'a dismissed marker can be clicked again');
    }
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await stopServer(server); await rm(fixture, { recursive: true, force: true }); }
});
}

test('ME08-376 whitespace counterpart remains a visible PDF caret when collapsed client rects are empty', async () => {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.setContent('<div id="page" style="position:relative;width:800px;height:200px"><span>In Lancashire siegten die Tories. In der Grafschaft Middlesex wur  en</span></div>');
    await page.addScriptTag({ content: engineSource + '\n' + highlightSource });
    const result = await page.evaluate(() => {
      const div = document.getElementById('page'), node = div.firstChild.firstChild, raw = node.textContent;
      const index = new PdfSelectionDiff.PdfSourceIndex(null, { raw, parts: [{ node, start: 0, end: raw.length }] });
      const highlights = ReviewHighlights.create({ document });
      const original = Range.prototype.getClientRects;
      Range.prototype.getClientRects = function () { return this.collapsed ? [] : original.call(this); };
      const hits = [
        { start: raw.indexOf('  '), end: raw.indexOf('  ') + 2, difference: { html: 'den', pdf: '  ' } },
        { start: raw.length, end: raw.length, difference: { html: 'EXTRA', pdf: '' } }
      ];
      const measured = highlights.measureHighlights(div, index, hits, hits[0]);
      const overlay = highlights.paintHighlight(div, measured.boxes, 'yellow', true);
      return { boxes: measured.boxes, notices: measured.notices.map(n => ({html:n.html,pdf:n.pdf})),
        widths: [...overlay.node.children].map(e => e.getBoundingClientRect().width), focus: measured.focus };
    });
    assert.equal(result.boxes.length, 2);
    assert.ok(result.boxes.every(b => b.caret && b.h > 0));
    assert.deepEqual(result.widths, [4, 4]);
    assert.deepEqual(result.notices, [{ html: 'den', pdf: '  ' }, { html: 'EXTRA', pdf: '' }]);
    assert.deepEqual(result.focus, result.boxes[0]);
  } finally { await browser.close(); }
});
