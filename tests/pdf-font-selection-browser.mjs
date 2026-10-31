import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchBrowser, startServer, stopServer } from './support/browser.mjs';

const fixture = await mkdtemp(path.join(tmpdir(), 'mew-font-selection-'));
let server, browser;
try {
  await writeFile(path.join(fixture, 'a.html'), '<p>Before the selected passage <i>Word</i> after the selected passage. Another WRONG reading followed by enough unique context to confirm the text fault.</p>');
  server = await startServer('server.js', 41883, ['-r', fixture]);
  browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  let settings = { diffHighlight: true, sourceDiffHighlight: true, selectionHighlight: true,
    italicDetection: true, boldDetection: true };
  await page.context().route('**/api/reader/settings', route => {
    if (route.request().method() === 'PUT') settings = { ...settings, ...route.request().postDataJSON() };
    return route.fulfill({ json: settings });
  });
  await page.goto('http://127.0.0.1:41883/?file=a.html');
  await page.waitForFunction(() => window.mewWorkbench?.editor.getValue().includes('<i>Word</i>'));
  await page.addScriptTag({ url: '/pdfdiff/pdf-selection.js' });
  await page.waitForFunction(() => window.PdfSelection);
  await page.evaluate(() => {
    window.testEditor = mewWorkbench.editor;
    const stage = document.createElement('div');
    stage.id = 'fontStage';
    stage.style.cssText = 'position:fixed;right:10px;top:650px;width:850px;height:250px;overflow:auto;background:white';
    stage.innerHTML = '<div class="pdfViewer"><div class="page" data-page-number="1" style="position:relative;width:850px;height:250px"><div class="textLayer" style="font:18px monospace"><span role="presentation">Before the selected passage Word after the selected passage. Another RIGHT reading followed by enough unique context to confirm the text fault.</span></div></div></div>';
    document.body.append(stage);
    const div = stage.querySelector('.page'), raw = div.textContent;
    const viewer = { container: stage, viewer: stage.firstChild, currentPageNumber: 1,
      _getVisiblePages: () => ({ views: [{ id: 1 }] }), getPageView: () => ({ div }), eventBus: { on() {}, off() {} },
      pdfDocument: { numPages: 1, async getPage() { return { async getTextContent() {
        return { items: [{ str: raw, transform: [1, 0, 0, 1, 0, 500], width: 800, height: 18 }] };
      } }; } } };
    window.ReaderUI = { getPdfViewer: () => viewer };
    PdfSelection.locator.layerFonts = () => () => ({ italic: false, bold: false });
    PdfSelection.attachViewer(viewer);
    PdfSelection.attachEditor(testEditor);
  });
  await page.waitForSelector('.mew-font-diff-text');
  const style = await page.locator('.mew-font-diff-text').first().evaluate(node => {
    const css = getComputedStyle(node);
    return { background: css.backgroundColor, line: css.textDecorationLine, style: css.textDecorationStyle };
  });
  assert.deepEqual(style, { background: 'rgba(0, 0, 0, 0)', line: 'underline', style: 'wavy' });
  assert.ok(await page.locator('.mew-ocr-diff-text').count(), 'text faults retain their background highlight');
  await page.evaluate(() => {
    const index = PdfSelection.locator.editorSourceIndex(testEditor.getModel());
    const target = PdfSelection.locator.environment.getVisiblePages()[0].index;
    index.rememberConnection(0, index.raw.length, target, { start: 0, end: target.raw.length });
    PdfSelection.refresh();
  });
  await page.evaluate(() => {
    ReplacementReview.close();
    const model = testEditor.getModel();
    testEditor.setPosition(model.getPositionAt(model.getValue().indexOf('Word') + 1));
    testEditor.focus();
    testEditor.trigger('test', 'editor.action.quickFix', {});
  });
  const formatAction = page.locator('.action-widget').getByText(/^替换格式：Word/).first();
  await formatAction.waitFor();
  const formatBox = await formatAction.boundingBox();
  await page.mouse.move(formatBox.x + formatBox.width / 2, formatBox.y + formatBox.height / 2);
  await page.waitForSelector('.mew-review-current');
  assert.ok(await page.evaluate(() => testEditor.getValue().includes('<i>Word</i>')), 'format hover only previews');
  await page.keyboard.press('Control+Enter');
  assert.ok(await page.evaluate(() => testEditor.getValue().includes('<i>Word</i>')), 'native format Preview preserves source');
  await page.evaluate(() => testEditor.trigger('test', 'editor.action.quickFix', {}));
  await formatAction.waitFor();
  const applyFormatBox = await formatAction.boundingBox();
  await page.mouse.move(applyFormatBox.x + applyFormatBox.width / 2, applyFormatBox.y + applyFormatBox.height / 2);
  await formatAction.click();
  await page.waitForFunction(() => !testEditor.getValue().includes('<i>Word</i>'));
  await page.evaluate(() => testEditor.trigger('test', 'undo', {}));
  await page.waitForFunction(() => testEditor.getValue().includes('<i>Word</i>'));
  const selected = await page.evaluate(() => {
    const model = testEditor.getModel(), source = model.getValue();
    const start = source.indexOf('selected passage'), end = source.indexOf(' passage.');
    let searches = 0;
    const onStatus = event => { if (event.detail.state === 'searching') searches++; };
    window.addEventListener('pdf-selection-highlight-status', onStatus);
    for (let at = start + 1; at < end; at++)
      testEditor.setSelection(monaco.Range.fromPositions(model.getPositionAt(start), model.getPositionAt(at)));
    testEditor.setSelection(monaco.Range.fromPositions(model.getPositionAt(start), model.getPositionAt(end)));
    window.removeEventListener('pdf-selection-highlight-status', onStatus);
    return { text: model.getValueInRange(testEditor.getSelection()), searches };
  });
  assert.equal(selected.searches, 0, 'rapid Monaco selection updates return before PDF mapping starts');
  const popup = page.locator('.replacement-review');
  await popup.waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelector('.replacement-review [data-status]')?.textContent.includes('斜体不一致'));
  assert.equal(await page.evaluate(() => testEditor.getModel().getValueInRange(testEditor.getSelection())), selected.text);
  await page.waitForFunction(() => !document.querySelector('.mew-pdf-review-pointer'));
  const geometry = await page.evaluate(() => {
    const div = document.querySelector('#fontStage .page'), node = div.querySelector('.textLayer span').firstChild;
    const raw = node.textContent, range = document.createRange();
    range.setStart(node, raw.indexOf('selected passage'));
    range.setEnd(node, raw.indexOf(' passage.'));
    const expected = range.getBoundingClientRect();
    const overlay = div.querySelector('.mew-pdf-selection-highlight:not(.mew-pdf-review-pointer)');
    const actual = overlay.firstChild.getBoundingClientRect();
    const index = PdfSelection.locator.editorSourceIndex(testEditor.getModel());
    const item = index.formatDifferences([], ['italic', 'bold'], true, index.connectionPairs(PdfSelection.locator.environment.getTargets()))[0];
    item.pdfSource = { index, start: item.sourceStart, end: item.sourceEnd };
    return { visible: getComputedStyle(overlay).visibility, actual: [actual.left, actual.right], expected: [expected.left, expected.right],
      anchor: PdfSelection.locator.reviewAnchor(item, index), popup: document.querySelector('.replacement-review').getBoundingClientRect().toJSON() };
  });
  assert.equal(geometry.visible, 'visible', 'a font pointer must keep the complete passage visible');
  geometry.actual.forEach((value, at) => assert.ok(Math.abs(value - geometry.expected[at]) < 1));
  assert.ok(geometry.anchor, 'the popup has an anchor on the font fault');
  assert.ok(Math.abs(geometry.popup.left - geometry.anchor.left) < 30, 'the popup starts at the font difference');
  await page.evaluate(() => ReplacementReview.close());
  await page.waitForSelector('.mew-pdf-review-pointer.mew-pdf-default-highlight');
  const boldToggle = page.locator('input[aria-label="启用PDF 粗体探测"]');
  const toggle = page.locator('input[aria-label="启用PDF 斜体探测"]');
  await boldToggle.evaluate(input => input.click());
  assert.deepEqual(await page.evaluate(() => [...PdfReviewProvider.locator.fontStyles]), ['italic']);
  await page.waitForSelector('.mew-font-diff-text');
  await boldToggle.evaluate(input => input.click());
  await toggle.evaluate(input => input.click());
  await page.waitForFunction(() => !PdfReviewProvider.locator.fontStyles.includes('italic') && !document.querySelector('.mew-font-diff-text'));
  await page.waitForFunction(() => {
    const div = document.querySelector('#fontStage .page');
    const notices = PdfReviewProvider.highlights.getHighlight(div, true)?.notices || [];
    return notices.length && notices.every(notice => !notice.source.index.raw.slice(notice.source.start, notice.source.end).includes('Word'));
  });
  assert.deepEqual(await page.evaluate(() => [...PdfReviewProvider.locator.fontStyles]), ['bold']);
  assert.ok(await page.locator('.mew-ocr-diff-text').count(), 'text differences remain highlighted');
  await toggle.evaluate(input => input.click());
  await page.waitForSelector('.mew-font-diff-text');
  await page.waitForFunction(() => PdfReviewProvider.highlights.getHighlight(document.querySelector('#fontStage .page'), true)?.notices.some(notice =>
    notice.source.index.raw.slice(notice.source.start, notice.source.end) === 'Word'));
  await toggle.evaluate(input => input.click());
  await page.waitForResponse(response => response.url().endsWith('/api/reader/settings')
    && response.request().postDataJSON()?.italicDetection === false);
  assert.equal(settings.italicDetection, false);
  assert.equal(settings.boldDetection, true);
  await page.evaluate(() => localStorage.setItem('mew.pdf-review.italic-enabled', 'true'));
  await page.reload();
  await page.waitForFunction(() => window.mewWorkbench?.editor);
  await page.addScriptTag({ url: '/pdfdiff/pdf-selection.js' });
  await page.waitForFunction(() => window.PdfSelection);
  assert.deepEqual(await page.evaluate(() => [...PdfReviewProvider.locator.fontStyles]), ['bold'],
    'reader settings restore each detector independently and override old local storage');
  await toggle.evaluate(input => input.click());
  await boldToggle.evaluate(input => input.click());
  await page.waitForResponse(response => response.url().endsWith('/api/reader/settings')
    && response.request().postDataJSON()?.boldDetection === false);
  assert.equal(settings.italicDetection, true);
  assert.equal(settings.boldDetection, false);
  assert.deepEqual(await page.evaluate(() => [...PdfReviewProvider.locator.fontStyles]), ['italic']);
  await page.evaluate(() => { window.ReaderUI = { getPdfViewer: () => null }; });
  const opened = page.waitForEvent('popup');
  await page.evaluate(() => window.open('/?file=a.html&readerSession=font-test', 'font-toggle-editor'));
  const editor = await opened;
  editor.on('pageerror', error => errors.push(error.message));
  await editor.waitForFunction(() => window.mewWorkbench?.editor && window.PdfReviewProvider);
  const fontToggle = (target, key) => target.locator(`input[aria-label="启用PDF ${key === 'italic' ? '斜体' : '粗体'}探测"]`);
  assert.deepEqual(await editor.evaluate(() => [...PdfReviewProvider.locator.fontStyles]), ['italic']);
  for (const [key, value] of [['italic', false], ['bold', true], ['bold', false]]) {
    await Promise.all([
      page.waitForResponse(response => response.url().endsWith('/api/reader/settings')
        && response.request().method() === 'PUT' && response.request().postDataJSON()?.[`${key}Detection`] === value),
      fontToggle(editor, key).evaluate(input => input.click())
    ]);
    assert.equal(settings[`${key}Detection`], value);
    for (const target of [page, editor]) {
      assert.equal(await target.evaluate(key => PdfReviewProvider.locator.fontStyles.includes(key), key), value);
      await target.waitForFunction(({ key, value }) => document.querySelector(`input[aria-label="启用PDF ${key === 'italic' ? '斜体' : '粗体'}探测"]`)?.checked === value, { key, value });
    }
  }
  await fontToggle(page, 'italic').evaluate(input => input.click());
  await editor.waitForFunction(() => document.querySelector('input[aria-label="启用PDF 斜体探测"]')?.checked === true);
  await fontToggle(page, 'italic').evaluate(input => input.click());
  await editor.reload();
  await editor.waitForFunction(() => window.PdfReviewProvider?.locator.fontStyles.length === 0);
  assert.equal(await fontToggle(editor, 'italic').isChecked(), false);
  assert.equal(await fontToggle(editor, 'bold').isChecked(), false);
  assert.deepEqual(errors, []);
  console.log('Independent font toggles, style highlights, settings persistence, and divided-window toggles passed.');
} finally {
  await browser?.close();
  await stopServer(server);
  await rm(fixture, { recursive: true, force: true });
}
