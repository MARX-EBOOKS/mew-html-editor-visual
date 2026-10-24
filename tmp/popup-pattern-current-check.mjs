import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { chromium } from 'playwright';
const fullReviewSource = await readFile('public/pdfdiff/pdf-review-provider.js', 'utf8');
const engineSource = await readFile('public/pdfdiff/pdf-selection-diff.js', 'utf8');
const providerSource = fullReviewSource.split('// PDF comparison is one review provider. Selection synchronization remains independent.')[1].replace(/\r?\n\}\)\(\);\s*$/, '');
function engine() { const window = {}; vm.runInNewContext(engineSource, { window }); return window.PdfSelectionDiff; }
function reviewProvider(api, providers, selection) {
 const window = { PdfSelection: selection, PdfSelectionDiff: api, ReplacementReview: { register(provider) { providers.set(provider.id, provider); return () => {}; } }, addEventListener() {}, removeEventListener() {} };
 vm.runInNewContext(providerSource, { window, document: {}, setInterval: () => 0, clearInterval() {} });
}
const existing = await readFile('tests/pdf-selection-diff.test.mjs', 'utf8');
let batching = existing.slice(existing.indexOf("test('PDF replacement batches"), existing.indexOf("test('compact review keeps"));
batching = batching.replace(/    assert\.deepEqual\(Array\.from\(highlighted[\s\S]*?styles'\);/, '').replace(/    assert\.equal\(result\.items\[0\]\.pdfSource\.index[^\n]*\n/, '');
function test(name, run) { run(); console.log('PASS:', name); }
eval(batching);
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
 const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
 await page.setContent('<div id="pdf" style="position:absolute;left:50px;top:50px;width:800px;height:800px;overflow:auto"><div style="height:2000px"></div></div>');
 await page.addStyleTag({ content: await readFile('public/pdfdiff/replacement-review.css', 'utf8') });
 await page.addScriptTag({ content: engineSource });
 await page.evaluate(() => {
  const node = document.getElementById('pdf');
  const model = { getValue: () => 'Alpha', getVersionId: () => 1, getOffsetAt: p => p.column - 1 };
  window.testEditor = { getModel: () => model, getDomNode: () => node, onDidChangeModel: () => ({ dispose() {} }), onDidChangeModelContent: () => ({ dispose() {} }), onDidScrollChange: () => ({ dispose() {} }), focus() {} };
  window.readerMonaco = { editor: testEditor };
 });
 await page.addScriptTag({ content: fullReviewSource });
 await page.evaluate(async () => {
  await PdfReviewReady;
  window.anchorBox = { left: 80, top: 280, bottom: 300 };
  ReplacementReview.register({ id: 'geometry', label: 'Geometry fixture', compact: true,
   provide: () => [{ id: 'current', options: [{ id: 'pdf', edits: [] }] }],
   presentation: () => ({ side: 'pdf', container: document.getElementById('pdf'), anchor: window.anchorBox }),
   content: () => ({ expanded: false, comparison: [{ label: 'HTML', parts: [{ text: 'Long selected text '.repeat(100), changed: true }] }] })
  });
  await ReplacementReview.open('geometry', testEditor);
 });
 for (const anchor of [{left:80,top:280,bottom:300}, {left:80,top:-500,bottom:1500}, {left:80,top:-600,bottom:1400}, null, {left:80,top:700,bottom:720}]) {
  await page.evaluate(anchor => { window.anchorBox = anchor; const node = document.getElementById('pdf'); node.scrollTop += 50; node.dispatchEvent(new Event('scroll')); }, anchor);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const box = await page.locator('.replacement-review').evaluate(node => { const r = node.getBoundingClientRect(); return { top:r.top,bottom:r.bottom,left:r.left,right:r.right,height:r.height,visibility:getComputedStyle(node).visibility,scroll:node.scrollHeight,client:node.clientHeight }; });
  assert.equal(box.visibility, 'visible'); assert.ok(box.height >= 100); assert.ok(box.top >= 50 && box.bottom <= 851); assert.ok(box.left >= 50 && box.right <= 851);
  if (anchor && anchor.top >= 50 && anchor.bottom <= 850) assert.ok(box.bottom <= anchor.top || box.top >= anchor.bottom, 'popup avoids the highlight when space permits');
 }
 console.log('PASS: real browser short/long selection, scroll, missing-anchor fallback and highlight avoidance');
 const errors = [];
 page.on('pageerror', error => errors.push(error.message));
 await page.evaluate(() => {
  ReplacementReview.close(false);
  window.fixturePdf = {};
  window.ReaderUI = { getPdfViewer: () => ({ pdfDocument: fixturePdf, container: document.getElementById('pdf') }) };
  window.dispatchEvent(new CustomEvent('pdf-selection-difference', { detail: {
   editor: testEditor, model: testEditor.getModel(), pdf: fixturePdf,
   notices: [{ html: 'wrong', pdf: 'right' }], anchor: { left: 80, top: 280, bottom: 300 }
  } }));
 });
 await page.waitForFunction(() => !document.querySelector('.replacement-review').hidden
  && document.querySelector('[data-comparison]').textContent.includes('right'));
 assert.deepEqual(await page.locator('[data-comparison] > div').allTextContents(), ['HTML: wrong', 'PDF: right']);
 assert.equal(await page.locator('.replacement-review').isVisible(), true);
 await page.evaluate(() => {
  ReplacementReview.close(false);
  window.mappedRequest = null;
  ReplacementReview.openForSelection = (...args) => { window.mappedRequest = { id: args[0], focus: args[2] }; };
  window.dispatchEvent(new CustomEvent('pdf-selection-difference', { detail: {
   editor: testEditor, model: testEditor.getModel(), pdf: fixturePdf,
   notices: [{ html: 'Alpha', pdf: 'AlpHa', source: { start: 0, end: 5, index: { source: 'Alpha' } } }]
  } }));
 });
 assert.deepEqual(await page.evaluate(() => mappedRequest), { id: 'pdf-ocr', focus: '0:5' });
 assert.deepEqual(errors, []);
 console.log('PASS: actual selection-difference event opens visible notice and routes mapped text to replacement without uncaught errors');
} finally { await browser.close(); }
