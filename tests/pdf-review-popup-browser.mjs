import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchBrowser, startServer, stopServer } from './support/browser.mjs';

for (const newline of [true, false]) {
const fixture = await mkdtemp(path.join(tmpdir(), 'mew-review-'));
const original = '<p>WRONG</p>';
const servers = [];
let browser;
async function start(script, port, args) {
  servers.push(await startServer(script, port, args));
}
try {
  await writeFile(path.join(fixture, 'a.html'), original);
  await start('server.js', 41881, ['-r', fixture]);
  browser = await launchBrowser();
  const errors = [];
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  page.on('pageerror', error => { errors.push(error.message); console.error(error.stack); });
  page.on('console', event => { if (event.type() === 'error') console.error(event.text()); });
  await page.route('**/api/reader/settings', route => route.fulfill({ json: { diffHighlight: true, selectionHighlight: false } }));
  await page.goto('http://127.0.0.1:41881/?file=a.html');
  await page.waitForFunction(() => (window.mewWorkbench || window.readerMonaco)?.editor.getValue().includes('WRONG'));
  await page.evaluate(() => {
    window.testEditor = (window.mewWorkbench || window.readerMonaco).editor;
  });
  const popup = page.locator('.replacement-review');
  // Attach the real PDF integration to a controlled native-text layer.
  await page.evaluate(newline => {
    const passage = 'A lengthy introductory passage establishes the source location with unique words. The reading has an X character in the middle. A second lengthy passage completes the unique context for this comparison. The ending contains a Q character for another comparison.';
    testEditor.getModel().setValue('<p>' + passage + '</p>');
    const stage = document.createElement('div'); stage.id = 'testStage';
    stage.style.cssText = 'position:fixed;right:10px;top:400px;width:400px;height:300px;overflow:auto';
    stage.innerHTML = '<div class="pdfViewer"><div class="page" style="position:relative;width:400px;height:300px"><div class="textLayer"><span></span></div></div></div>';
    stage.querySelector('span').textContent = newline ? 'Unrelated rendered OCR text.' : passage.replace('an X', 'an YYYYY').replace('a Q', 'a Z');
    document.body.append(stage);
    const div = stage.querySelector('.page'), text = newline ? passage.replace('an X', 'an \n') : div.textContent;
    window.mockViewer = { container: stage, viewer: stage.firstChild, currentPageNumber: 1,
      scrollPageIntoView() {}, _getVisiblePages: () => ({ views: [{ id: 1 }] }), getPageView: () => ({ div, viewport: { width: 400, height: 300, scale: 1, convertToViewportPoint: () => [40, 150] } }), eventBus: { on() {}, off() {} },
      pdfDocument: { numPages: 1, async getPage() { return { async getTextContent() { return { items: [{ str: text, transform: [1,0,0,1,0,500], width: 400, height: 20 }] }; } }; } } };
    window.ReaderUI = { getPdfViewer: () => mockViewer };
  }, newline);
  await page.addScriptTag({ url: '/pdfdiff/pdf-selection.js' });
  await page.waitForFunction(() => window.PdfSelection);
  await page.evaluate(() => { PdfSelection.attachViewer(mockViewer); PdfSelection.attachEditor(testEditor); });
  await page.waitForSelector('.mew-ocr-diff-text', {timeout:7000});
  if (newline) {
    await page.evaluate(() => PdfSelection.setSelectionHighlight(true));
    await page.locator('.mew-ocr-diff-text').first().click();
    await popup.waitFor({state: 'visible', timeout: 5000});
    assert.deepEqual(await popup.locator('[data-comparison] mark').allTextContents(), ['X', '']);
    assert.equal(await page.locator('.mew-pdf-selection-highlight').count(), 0,
      'a confirmed change opens even without a measurable PDF counterpart');
    const before = await page.evaluate(() => testEditor.getValue());
    await popup.locator('[data-apply]').click();
    assert.equal((await page.evaluate(() => testEditor.getValue())).replace(/\r\n/g, '\n'), before.replace(/\r\n/g, '\n').replace('an X', 'an \n'),
      'replacement preserves the PDF line break');
    await page.evaluate(() => testEditor.trigger('test', 'undo', null));
    assert.equal(await page.evaluate(() => testEditor.getValue()), before);
    console.log('newline counterpart: highlight click, popup, replacement and undo passed');
    assert.deepEqual(errors, []);
    continue;
  }
  for (const linked of [true, false]) {
    await page.evaluate(linked => { ReplacementReview.close(); PdfSelection.setSelectionHighlight(linked); }, linked);
    await page.locator('.mew-ocr-diff-text').first().click();
    await popup.waitFor({state:'visible', timeout:5000});
    assert.deepEqual(await popup.locator('[data-comparison] mark').allTextContents(), ['X', 'YYYYY']);
    await page.evaluate(() => { ReplacementReview.close(); testEditor.setPosition({lineNumber:1,column:1}); });
    const drag = await page.evaluate(() => {
      const model = testEditor.getModel(), at = model.getValue().indexOf('an X') + 3;
      const box = testEditor.getDomNode().getBoundingClientRect();
      const point = offset => { const pos = testEditor.getScrolledVisiblePosition(model.getPositionAt(offset));
        return {x:box.left+pos.left,y:box.top+pos.top+pos.height/2}; };
      return {start:point(at-12),end:point(at+12),text:model.getValue().slice(at-12,at+12)};
    });
    const start = linked ? drag.start : drag.end, end = linked ? drag.end : drag.start;
    await page.mouse.move(start.x,start.y); await page.mouse.down();
    await page.mouse.move(end.x,end.y,{steps:12});
    await page.waitForTimeout(150);
    assert.equal(await popup.isHidden(),true,'review must wait until drag release');
    await page.mouse.up();
    await popup.waitFor({state:'visible',timeout:5000});
    assert.equal(await page.evaluate(() => testEditor.getModel().getValueInRange(testEditor.getSelection())),drag.text);
    assert.deepEqual(await popup.locator('[data-comparison] mark').allTextContents(),['X','YYYYY']);
    if (!linked) assert.equal(await page.locator('.mew-pdf-selection-highlight').count(),0,'disabled linking stays disabled');
    console.log(`highlight click and discrepancy drag: linking ${linked ? 'on' : 'off'} passed`);
  }
  await page.keyboard.press('Escape');
  assert.equal(await popup.isHidden(), true, 'Escape closes review from the source editor');
  const popupSetting = page.locator('input[aria-label="启用选中文字时自动显示差异"]');
  assert.equal(await popupSetting.isChecked(), true, 'selection popups default to enabled');
  await popupSetting.evaluate(input => input.click());
  await page.evaluate(() => {
    testEditor.setPosition({ lineNumber: 1, column: 1 });
    const model = testEditor.getModel(), at = model.getValue().indexOf('an X') + 3;
    testEditor.setSelection(monaco.Range.fromPositions(model.getPositionAt(at - 12), model.getPositionAt(at + 12)));
  });
  await page.waitForTimeout(500);
  assert.equal(await popup.isHidden(), true, 'automatic selection popups can be disabled');
  await page.locator('.mew-ocr-diff-text').first().click();
  await popup.waitFor({ state: 'visible', timeout: 5000 });
  const selectedBeforeEscape = await page.evaluate(() => testEditor.getSelection().toString());
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  assert.equal(await popup.isHidden(), true);
  assert.equal(await page.evaluate(() => testEditor.getSelection().toString()), selectedBeforeEscape,
    'Escape preserves the editor selection');
  assert.equal(await page.evaluate(() => localStorage.getItem('mew.pdf-review.selection-popup')), 'false');
  await popupSetting.evaluate(input => input.click());
  console.log('selection popup preference, explicit highlight clicks and editor Escape passed');
  for (const linked of [true, false]) {
    for (const [at, expected] of [[3, ['Q', 'Z']], [0, ['X', 'YYYYY']]]) {
      await page.evaluate(async linked => {
        ReplacementReview.close(); PdfSelection.setSelectionHighlight(linked);
        const locator = PdfSelection.locator, index = locator.editorSourceIndex(testEditor.getModel());
        const target = await locator.indexDocument(mockViewer.pdfDocument);
        const notice = { html: index.raw, pdf: target.raw, source: { index, start: 0, end: index.raw.length }, target: { index: target, start: 0, end: target.raw.length } };
        await ReplacementReview.open('pdf-ocr', testEditor, `0:${index.raw.length}`, 0, { pdf: mockViewer.pdfDocument, notice, targets: [target], interactionId: 1, anchor: { left: 950, top: 100, bottom: 120 } });
      }, linked);
      await popup.waitFor({ state: 'visible', timeout: 5000 });
      assert.deepEqual(await popup.locator('[data-comparison] mark').allTextContents(), ['X', 'Q', 'YYYYY', 'Z']);
      const before = await page.evaluate(() => testEditor.getValue());
      await popup.locator('[data-comparison] mark').nth(at).click();
      await page.waitForFunction(expected => JSON.stringify([...document.querySelectorAll('[data-comparison] mark')].map(mark => mark.textContent)) === JSON.stringify(expected), expected);
      assert.equal(await page.evaluate(() => testEditor.getValue()), before, 'popup highlight selects a fault without editing');
      assert.equal(await page.evaluate(() => testEditor.getModel().getValueInRange(testEditor.getSelection())), expected[0], 'only the clicked fault is selected in Monaco');
    }
  }
  console.log('multiple diffs: HTML/PDF popup highlights select individual faults with linking on/off');
  await page.evaluate(() => {
    ReplacementReview.close();
    const stage = document.getElementById('testStage');
    stage.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
    const text = stage.querySelector('span').firstChild, at = text.textContent.indexOf('an Y') + 3;
    const range = document.createRange(); range.setStart(text, at - 12); range.setEnd(text, at + 16);
    const selected = document.getSelection(); selected.removeAllRanges(); selected.addRange(range);
    stage.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 }));
  });
  await popup.waitFor({ state: 'visible', timeout: 5000 });
  assert.deepEqual(await popup.locator('[data-comparison] mark').allTextContents(), ['X', 'YYYYY']);
  assert.equal(await page.locator('.mew-pdf-selection-highlight').count(), 0);
  console.log('native PDF selection with linking off passed');
  await page.evaluate(async () => {
    document.getSelection().removeAllRanges();
    ReplacementReview.close(); PdfSelection.setSelectionHighlight(true);
    await PdfSelection.locator.indexDocument(mockViewer.pdfDocument);
    document.querySelector('#testStage .textLayer').remove();
    testEditor.setPosition({lineNumber:1,column:1});
  });
  await page.waitForTimeout(400);
  await page.locator('.mew-ocr-diff-text').first().click();
  await popup.waitFor({state:'visible',timeout:5000});
  assert.deepEqual(await popup.locator('[data-comparison] mark').allTextContents(),['X','YYYYY']);
  console.log('highlight click without rendered PDF text layer passed');
  await page.evaluate(async () => {
    ReplacementReview.close();
    const before = 'Die Privatwaffen waren in den Händen der verschied', after = 'nen Bürgerwehren. Man konnte mindestens verlangen, daß die Privatwaffen abgegeben würden.';
    const raw = before + after, markup = '<p>' + before + 'e' + after + '</p>', at = before.length;
    testEditor.getModel().setValue(markup);
    const div = document.querySelector('#testStage .page');
    div.innerHTML = '<div class="textLayer"><span role="presentation"></span></div>';
    div.querySelector('span').textContent = raw;
    const locator = PdfSelection.locator, source = locator.sourceIndex(markup), target = locator.sourceIndex(raw);
    const notice = { html: 'e', pdf: '', source: { index: source, start: at, end: at + 1 }, target: { index: target, start: at, end: at } };
    const original = locator.findLocations;
    // A full-document mapping can survive while the native text layer is rebuilt.
    // Its empty PDF counterpart must work without a cached source/layer connection.
    locator.findLocations = (pdf, entries) => entries[0]?.index === source ? entries.map(entry => ({ entry, targets: [{
      pageNumber: 1, index: source, start: at, end: at + 1, marked: true,
      text: '', before, after, difference: { html: 'e', pdf: '' }, source: notice.source, target: notice.target
    }] })) : original(pdf, entries);
    await ReplacementReview.open('pdf-ocr', testEditor, `${at}:${at + 1}`, 0,
      { pdf: mockViewer.pdfDocument, notice, targets: [target] });
    window.emptyTargetItem = { pdfSource: { index: source, start: at, end: at + 1 }, sourceStart: at, sourceEnd: at + 1 };
  });
  await page.waitForSelector('.mew-pdf-review-pointer .mew-pdf-selection-caret', { timeout: 4000 });
  await page.waitForFunction(() => {
    const anchor = PdfSelection.locator.reviewAnchor(emptyTargetItem);
    const mark = document.querySelector('.mew-pdf-review-pointer .mew-pdf-selection-caret')?.getBoundingClientRect();
    return anchor && mark && Math.abs(anchor.left - mark.left) < 1 && Math.abs(anchor.top - mark.top) < 1;
  }, null, { timeout: 4000 });
  assert.deepEqual(await popup.locator('[data-comparison] mark').allTextContents(), ['e', '']);
  console.log('empty PDF counterpart after layer rebuild: caret and popup anchor passed');
  await page.close();
  assert.deepEqual(errors,[]);
} finally { await browser?.close(); await Promise.all(servers.map(stopServer)); await rm(fixture, {recursive:true, force:true}); }

}
