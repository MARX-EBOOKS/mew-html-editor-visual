import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const fixture = await mkdtemp(path.join(tmpdir(), 'mew-review-'));
const original = '<p>WRONG</p>';
const servers = [];
let browser;
async function start(script, port, args) {
  const child = spawn(process.execPath, [script, '-p', String(port), ...args], { windowsHide: true, stdio: 'pipe' });
  servers.push(child);
  let output = ''; child.stdout.on('data', d => output += d); child.stderr.on('data', d => output += d);
  for (let i = 0; i < 80; i++) {
    if (child.exitCode !== null) throw new Error(output);
    try { if ((await fetch(`http://127.0.0.1:${port}/`)).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(output);
}
try {
  await writeFile(path.join(fixture, 'a.html'), original);
  await start('server.js', 41881, ['-r', fixture]);
  browser = await chromium.launch({ executablePath: process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: true });
  const errors = [];
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  page.on('pageerror', error => { errors.push(error.message); console.error(error.stack); });
  page.on('console', event => { if (event.type() === 'error') console.error(event.text()); });
  await page.route('**/api/reader/settings', route => route.fulfill({ json: { diffHighlight: true, selectionHighlight: false } }));
  await page.route('**/pdfdiff/pdf-review-provider.js', async route => route.fulfill({ contentType: 'text/javascript', body: await readFile('tmp/pdf-provider-trim-before.js', 'utf8') }));
  await page.goto('http://127.0.0.1:41881/?file=a.html');
  await page.waitForFunction(() => (window.mewWorkbench || window.readerMonaco)?.editor.getValue().includes('WRONG'));
  await page.evaluate(() => {
    window.testEditor = (window.mewWorkbench || window.readerMonaco).editor;
  });
  const popup = page.locator('.replacement-review');
  // Attach the real PDF integration to a controlled native-text layer.
  await page.evaluate(() => {
    const passage = 'A lengthy introductory passage establishes the source location with unique words. The reading has an X character in the middle. A second lengthy passage completes the unique context for this comparison. The ending contains a Q character for another comparison.';
    testEditor.getModel().setValue('<p>' + passage + '</p>');
    const stage = document.createElement('div'); stage.id = 'testStage';
    stage.style.cssText = 'position:fixed;right:10px;top:400px;width:400px;height:300px;overflow:auto';
    stage.innerHTML = '<div class="pdfViewer"><div class="page" style="position:relative;width:400px;height:300px"><div class="textLayer"><span></span></div></div></div>';
    stage.querySelector('span').textContent = passage.replace('an X', 'an YYYYY').replace('a Q', 'a Z');
    document.body.append(stage);
    const div = stage.querySelector('.page'), text = div.textContent;
    window.mockViewer = { container: stage, viewer: stage.firstChild, currentPageNumber: 1,
      scrollPageIntoView() {}, _getVisiblePages: () => ({ views: [{ id: 1 }] }), getPageView: () => ({ div }), eventBus: { on() {}, off() {} },
      pdfDocument: { numPages: 1, async getPage() { return { async getTextContent() { return { items: [{ str: text, transform: [1,0,0,1,0,500], width: 400, height: 20 }] }; } }; } } };
    window.ReaderUI = { getPdfViewer: () => mockViewer };
  });
  await page.addScriptTag({ url: '/pdfdiff/pdf-selection.js' });
  await page.waitForFunction(() => window.PdfSelection);
  await page.evaluate(() => { PdfSelection.attachViewer(mockViewer); PdfSelection.attachEditor(testEditor); });
  await page.waitForSelector('.mew-ocr-diff-text', {timeout:7000});
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
} finally { await browser?.close(); servers.forEach(server => server.kill()); await rm(fixture, {recursive:true, force:true}); }

