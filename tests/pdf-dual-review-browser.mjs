import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchBrowser, startServer, stopServer } from './support/browser.mjs';

const fixture = await mkdtemp(path.join(tmpdir(), 'mew-dual-review-'));
let server, browser;
// Headless Chromium reports every page focused; supply native focus states explicitly.
async function windowFocus(page, focused) {
  await page.evaluate(focused => {
    Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => focused });
    dispatchEvent(new Event(focused ? 'focus' : 'blur'));
  }, focused);
}
try {
  const passage = 'A lengthy introductory passage establishes the source location with unique words. The reading has an X character in the middle. A second lengthy passage completes the unique context for this comparison. The ending contains a Q character for another comparison.';
  await writeFile(path.join(fixture, 'a.html'), '<p>' + passage + '</p>');
  server = await startServer('server.js', 41884, ['-r', fixture]);
  browser = await launchBrowser();
  const context = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
  const errors = [];
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  await context.route('**/api/reader/settings', route => route.fulfill({ json: { diffHighlight: false, selectionHighlight: false } }));
  const reader = await context.newPage();
  await reader.goto('http://127.0.0.1:41884/?file=a.html');
  await reader.waitForFunction(() => window.mewWorkbench?.editor.getValue().includes('an X'));
  await reader.evaluate(text => {
    const stage = document.createElement('div');
    stage.style.cssText = 'position:fixed;left:500px;top:400px;width:700px;height:400px;background:white';
    stage.innerHTML = '<div class="pdfViewer"><div class="page" style="position:relative;width:700px;height:400px"><div class="textLayer"><span></span></div></div></div>';
    stage.querySelector('span').textContent = text.replace('an X', 'an YYYYY').replace('a Q', 'a Z');
    document.body.append(stage);
    const div = stage.querySelector('.page');
    window.mockViewer = { container: stage, viewer: stage.firstChild, currentPageNumber: 1,
      scrollPageIntoView() {}, _getVisiblePages: () => ({ views: [{ id: 1 }] }),
      getPageView: () => ({ div }), eventBus: { on() {}, off() {} },
      pdfDocument: { numPages: 1, async getPage() { return { async getTextContent() {
        return { items: [{ str: div.textContent, transform: [1,0,0,1,0,500], width: 700, height: 20 }] };
      } }; } } };
    window.ReaderUI = { getPdfViewer: () => mockViewer };
  }, passage);
  const opened = reader.waitForEvent('popup');
  await reader.evaluate(() => window.open('/?file=a.html', 'dual-review-editor'));
  const editor = await opened;
  await editor.waitForFunction(() => window.mewWorkbench?.editor.getValue().includes('an X') && window.PdfReviewProvider);
  await reader.addScriptTag({ url: '/pdfdiff/pdf-selection.js' });
  await reader.waitForFunction(() => window.PdfSelection);
  await reader.evaluate(() => { PdfSelection.attachViewer(mockViewer); PdfSelection.attachEditor(window.open('', 'dual-review-editor').mewWorkbench.editor); });
  await editor.waitForSelector('.mew-ocr-diff-text');
  await reader.waitForSelector('.mew-pdf-review-pointer');
  const sourceColors = () => editor.locator('.mew-ocr-diff-text').evaluateAll(nodes => nodes.map(node => getComputedStyle(node).backgroundColor));
  assert.ok((await sourceColors()).every(color => color === 'rgba(255, 166, 40, 0.3)'), 'normal differences stay gold');
  await reader.evaluate(() => {
    const original = PdfSelection.locator.reviewAnchor;
    PdfSelection.locator.reviewAnchor = function (item, index) {
      const anchor = original.call(this, item, index);
      window.activePopupAnchor = anchor && { ...anchor, sourceStart: item.sourceStart };
      return anchor;
    };
    PdfSelection.popupPlacement = () => { throw new Error('Popup must not choose among all preview highlights'); };
  });
  await editor.locator('#reviewBtn').click();
  const left = editor.locator('.replacement-review'), right = reader.locator('.replacement-review');
  await left.waitFor({ state: 'visible' });
  await right.waitFor({ state: 'visible' });
  assert.equal(await left.locator('[data-switch]').textContent(), '查看PDF');
  assert.equal(await right.locator('[data-switch]').textContent(), '查看HTML');
  await left.locator('[data-switch]').click();
  assert.equal(await right.locator('[data-switch]').evaluate(node => node === document.activeElement), true,
    '查看PDF transfers focus to the PDF review control');
  await right.locator('[data-switch]').click();
  assert.equal(await left.locator('[data-switch]').evaluate(node => node === document.activeElement), true,
    '查看HTML transfers focus to the HTML review control');
  assert.equal(context.pages().length, 2, 'switching reuses both existing windows');
  const besideCurrent = async () => {
    await reader.waitForFunction(() => {
      const popup = document.querySelector('.replacement-review'), box = popup?.getBoundingClientRect();
      const anchor = window.activePopupAnchor;
      return box && anchor
        && (Math.abs(box.bottom + 8 - anchor.top) < 2 || Math.abs(box.top - 8 - anchor.bottom) < 2);
    });
  };
  await besideCurrent();
  assert.deepEqual(await left.locator('[data-comparison]').allTextContents(), await right.locator('[data-comparison]').allTextContents());
  assert.equal(await left.locator('[data-apply]').getAttribute('aria-pressed'), 'false');
  assert.equal(await editor.locator('.mew-review-proposed').count(), 0);
  assert.ok((await sourceColors()).every(color => color === 'rgba(255, 166, 40, 0.3)'), 'opening a popup preserves gold');
  await left.locator('[data-apply]').click();
  await editor.waitForSelector('.mew-review-proposed');
  assert.ok((await sourceColors()).length >= 2, 'fixture contains multiple differences');
  assert.ok((await sourceColors()).every(color => color === 'rgba(235, 65, 65, 0.28)'), 'preview makes all source differences red');
  await reader.waitForSelector('.mew-pdf-review-pointer.mew-review-preview');
  await besideCurrent();
  const firstAnchor = await reader.evaluate(() => activePopupAnchor.sourceStart);
  await reader.evaluate(() => { mockViewer.container.style.height = '80px'; dispatchEvent(new Event('resize')); });
  await reader.waitForFunction(() => {
    const box = document.querySelector('.replacement-review').getBoundingClientRect();
    return box.bottom <= mockViewer.container.getBoundingClientRect().bottom + .5
      && box.top >= activePopupAnchor.bottom + 7;
  });
  await reader.evaluate(() => { mockViewer.container.style.height = '400px'; dispatchEvent(new Event('resize')); });
  assert.ok((await reader.locator('.mew-pdf-review-pointer > div').evaluateAll(nodes => nodes.map(node => getComputedStyle(node).backgroundColor)))
    .every(color => color === 'rgba(235, 65, 65, 0.28)'), 'preview makes PDF differences red');
  await reader.waitForTimeout(400);
  await reader.evaluate(() => {
    window.previewPreparations = 0;
    const prepare = PdfSelection.locator.prepareSource;
    PdfSelection.locator.prepareSource = function (...args) { ++window.previewPreparations; return prepare.apply(this, args); };
  });
  assert.notEqual(await editor.locator('.mew-review-proposed').first().evaluate(node => getComputedStyle(node).backgroundColor), 'rgba(0, 0, 0, 0)');
  assert.notEqual(await editor.locator('.mew-review-current').first().evaluate(node => getComputedStyle(node).backgroundColor), 'rgba(0, 0, 0, 0)');
  assert.equal(await editor.evaluate(() => mewWorkbench.editor.getModel().getAllDecorations().some(d => d.options.isWholeLine)), false);
  const unchanged = await editor.evaluate(() => mewWorkbench.editor.getValue());
  for (const [popup, enabled] of [[left, false], [right, true]]) {
    assert.equal(await popup.locator('[data-apply]').textContent(), '预览');
    await popup.locator('[data-apply]').click();
    assert.equal(await left.locator('[data-apply]').getAttribute('aria-pressed'), String(enabled));
    assert.equal(await right.locator('[data-apply]').getAttribute('aria-pressed'), String(enabled));
    await editor.waitForFunction(enabled => !!document.querySelector('.mew-review-proposed') === enabled, enabled);
    await reader.waitForSelector('.mew-pdf-review-pointer');
    assert.ok((await sourceColors()).every(color => color === (enabled ? 'rgba(235, 65, 65, 0.28)' : 'rgba(255, 166, 40, 0.3)')));
    await reader.waitForFunction(enabled => document.querySelector('.mew-pdf-review-pointer')?.classList.contains('mew-review-preview') === enabled, enabled);
    assert.equal(await editor.evaluate(() => mewWorkbench.editor.getValue()), unchanged, 'preview never applies the proposed replacement');
    const prepared = await reader.evaluate(() => previewPreparations);
    await reader.waitForTimeout(200);
    assert.equal(await reader.evaluate(() => previewPreparations), prepared, 'preview toggles do not schedule PDF preparation');
  }
  const other = await context.newPage();
  const openStoredPreview = async () => {
    await other.waitForFunction(() => window.mewWorkbench?.editor && window.ReplacementReview);
    await other.evaluate(async () => {
      ReplacementReview.register({ id: 'stored-preview', label: 'Stored preview',
        provide: () => [{ id: 'one', options: [{ id: 'keep', edits: [] }] }] });
      await ReplacementReview.open('stored-preview', mewWorkbench.editor);
    });
    await other.locator('.replacement-review').waitFor({ state: 'visible' });
    assert.equal(await other.locator('[data-apply]').getAttribute('aria-pressed'), 'true', 'a new window restores the global preview setting');
  };
  await other.goto('http://127.0.0.1:41884/?file=a.html');
  await openStoredPreview();
  await other.locator('[data-apply]').click();
  await editor.waitForFunction(() => document.querySelector('[data-apply]').getAttribute('aria-pressed') === 'false');
  await reader.waitForFunction(() => document.querySelector('[data-apply]').getAttribute('aria-pressed') === 'false');
  await other.locator('[data-apply]').click();
  await editor.waitForFunction(() => document.querySelector('[data-apply]').getAttribute('aria-pressed') === 'true');
  await reader.waitForFunction(() => document.querySelector('[data-apply]').getAttribute('aria-pressed') === 'true');
  await other.reload();
  await openStoredPreview();
  await other.close();
  await editor.evaluate(() => {
    const e = mewWorkbench.editor, m = e.getModel();
    e.setPosition(m.getPositionAt(m.getValue().indexOf('an X') + 3)); e.focus();
  });
  await editor.keyboard.type('k');
  await editor.waitForTimeout(700);
  assert.equal(await left.isVisible(), true);
  assert.equal(await right.isVisible(), true);
  assert.equal(await editor.evaluate(() => mewWorkbench.editor.getPosition().column), unchanged.indexOf('an X') + 5);
  assert.match(await editor.evaluate(() => mewWorkbench.editor.getValue()), /an kX/);
  await right.locator('[data-next]').click();
  assert.equal(await left.locator('[data-position]').textContent(), await right.locator('[data-position]').textContent());
  await besideCurrent();
  assert.ok(await reader.evaluate(start => activePopupAnchor.sourceStart > start, firstAnchor), 'navigation moves the popup to the next difference');
  await right.locator('[data-apply]').click();
  await editor.waitForTimeout(500);
  await reader.waitForSelector('.mew-pdf-review-pointer');
  assert.match(await editor.evaluate(() => mewWorkbench.editor.getValue()), /a Q/, 'preview leaves the next candidate unchanged');
  assert.deepEqual(await left.locator('[data-comparison]').allTextContents(), await right.locator('[data-comparison]').allTextContents());
  await editor.evaluate(() => {
    const e = mewWorkbench.editor, node = e.getDomNode(), box = node.getBoundingClientRect();
    node.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: box.right - 5, clientY: box.bottom - 5 }));
  });
  assert.equal(await left.isHidden(), true, 'clicking elsewhere inside the editor closes the popup');
  assert.equal(await right.isHidden(), true);
  assert.ok((await sourceColors()).every(color => color === 'rgba(255, 166, 40, 0.3)'), 'closing preview restores gold');
  await reader.waitForFunction(() => !document.querySelector('.mew-pdf-review-pointer.mew-review-preview'));
  await reader.locator('#reviewBtn').click();
  await left.waitFor({ state: 'visible' });
  await right.waitFor({ state: 'visible' });
  await left.locator('[data-close]').click();
  await reader.evaluate(() => PdfSelection.setSelectionHighlight(true));
  for (const dismiss of ['outside', 'source-outside', 'pointer-before-focus', 'iframe-focus', 'keyboard-return', 'html-close', 'pdf-close']) {
    await windowFocus(editor, true);
    await windowFocus(reader, dismiss !== 'outside');
    const word = await editor.evaluate(() => {
      localStorage.setItem('mew-review-preview', 'true');
      const e = mewWorkbench.editor, m = e.getModel(), at = m.getValue().indexOf('kX');
      e.setPosition(m.getPositionAt(0));
      e.revealPositionInCenter(m.getPositionAt(at));
      const p = e.getScrolledVisiblePosition(m.getPositionAt(at + 1)), box = e.getDomNode().getBoundingClientRect();
      return { x: box.left + p.left, y: box.top + p.top + p.height / 2 };
    });
    await editor.mouse.dblclick(word.x, word.y);
    await left.waitFor({ state: 'visible' });
    await right.waitFor({ state: 'visible' });
    assert.equal(await editor.evaluate(() => mewWorkbench.editor.getModel().getValueInRange(mewWorkbench.editor.getSelection())), 'kX');
    assert.equal(await left.locator('[data-apply]').getAttribute('aria-pressed'), 'true');
    if (dismiss === 'outside') {
      await windowFocus(reader, true);
      await reader.evaluate(() => dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', altKey: true })));
      await reader.mouse.click(1490, 990);
      assert.equal(await left.isVisible(), true, 'returning to the PDF window keeps the source popup');
      assert.equal(await right.isVisible(), true, 'the first outside click back in the PDF window keeps its popup');
      await reader.mouse.click(1490, 990);
    }
    else if (dismiss === 'source-outside') {
      const elsewhere = await editor.evaluate(() => {
        const e = mewWorkbench.editor, offset = e.getValue().indexOf('kX') - 5;
        const p = e.getScrolledVisiblePosition(e.getModel().getPositionAt(offset));
        const box = e.getDomNode().getBoundingClientRect();
        return { x: box.left + p.left, y: box.top + p.top + p.height / 2, offset };
      });
      await windowFocus(editor, false);
      await windowFocus(editor, true);
      await editor.mouse.click(elsewhere.x, elsewhere.y);
      assert.equal(await left.isVisible(), true, 'the first outside click back in the editor keeps its popup');
      assert.equal(await right.isVisible(), true, 'returning to the editor keeps the PDF popup');
      await editor.mouse.click(elsewhere.x, elsewhere.y);
      assert.equal(await editor.evaluate(() => mewWorkbench.editor.getModel().getOffsetAt(mewWorkbench.editor.getPosition())), elsewhere.offset,
        'outside dismissal preserves the newly clicked caret');
    }
    else if (dismiss === 'pointer-before-focus') {
      await windowFocus(reader, false);
      await reader.mouse.click(1490, 990);
      await windowFocus(reader, true);
      assert.equal(await left.isVisible(), true, 'pointer before focus preserves both popups');
      assert.equal(await right.isVisible(), true, 'late focus does not dismiss the PDF popup');
      await reader.mouse.click(1490, 990);
    }
    else if (dismiss === 'iframe-focus') {
      await right.dispatchEvent('pointerdown');
      await reader.evaluate(() => {
        const frame = document.createElement('iframe');
        document.body.append(frame); frame.contentWindow.focus();
        frame.remove();
      });
      await reader.mouse.click(1490, 990);
    }
    else if (dismiss === 'keyboard-return') {
      await windowFocus(reader, false);
      await windowFocus(reader, true);
      await reader.keyboard.press('ArrowRight');
      await reader.mouse.click(1490, 990);
    }
    else {
      await windowFocus(dismiss === 'html-close' ? editor : reader, false);
      await windowFocus(dismiss === 'html-close' ? editor : reader, true);
      await (dismiss === 'html-close' ? left : right).locator('[data-close]').click();
    }
    await editor.waitForTimeout(400);
    assert.equal(await left.isHidden(), true, `${dismiss}: source popup stays dismissed`);
    assert.equal(await right.isHidden(), true, `${dismiss}: PDF popup stays dismissed`);
    assert.equal(await editor.evaluate(() => mewWorkbench.editor.getSelection().isEmpty()), true,
      `${dismiss}: dismissing whole-word preview clears the source selection`);
    assert.equal(await reader.locator('.mew-pdf-selection-highlight:not(.mew-pdf-review-pointer)').count(), 0,
      `${dismiss}: dismissing preview clears the linked PDF selection`);
  }
  await reader.evaluate(() => PdfSelection.stop());
  await editor.evaluate(async () => {
    const e = mewWorkbench.editor, source = e.getValue();
    const items = ['kX', 'Q'].map((text, i) => ({ id: String(i), options: [
      { id: 'replace', label: 'Replace', edits: [{ start: source.indexOf(text), end: source.indexOf(text) + text.length, text: `REVIEW_${i}` }] },
      { id: 'keep', label: 'Keep', edits: [] }
    ] }));
    const provider = { id: 'preview-default', label: 'Preview default', provide: () => items,
      content: (_, item) => ({ options: item?.options || [] }) };
    ReplacementReview.register(provider);
    ReplacementReview.register({ ...provider, id: 'preview-custom',
      preview: () => ({ before: source, after: 'CUSTOM_PREVIEW' }) });
    await ReplacementReview.open('preview-default', e);
  });
  if (await left.locator('[data-apply]').getAttribute('aria-pressed') !== 'true') await left.locator('[data-apply]').click();
  await editor.waitForFunction(() => document.querySelector('.mew-review-proposed')?.textContent === 'REVIEW_0');
  await left.locator('[data-expanded] > summary').click();
  await editor.waitForFunction(() => monaco.editor.getModels().some(m => m.getValue().includes('REVIEW_0')));
  await left.locator('[data-file]').check();
  await editor.waitForFunction(() => monaco.editor.getModels().some(m => m.getValue().includes('REVIEW_0') && m.getValue().includes('REVIEW_1')));
  await left.locator('[data-next]').click();
  await left.getByText('Keep', { exact: true }).click();
  await editor.waitForFunction(() => !document.querySelector('.mew-review-proposed')
    && monaco.editor.getModels().some(m => m.getValue().includes('REVIEW_0') && !m.getValue().includes('REVIEW_1')));
  await editor.evaluate(() => ReplacementReview.open('preview-custom', mewWorkbench.editor));
  await editor.waitForFunction(() => monaco.editor.getModels().some(m => m.getValue() === 'CUSTOM_PREVIEW'));
  assert.equal(await editor.evaluate(() => mewWorkbench.editor.getValue()), unchanged.replace('an X', 'an kX'));
  assert.deepEqual(errors, []);
  console.log('dual review: synchronized non-mutating previews, independent PDF highlights, no background preparation on toggle, caret-preserving typing, whole-word preview dismissal, shared selected-edit previews and custom diff override passed');
} finally {
  await browser?.close(); await stopServer(server); await rm(fixture, { recursive: true, force: true });
}
