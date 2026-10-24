import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1704, height: 500 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://127.0.0.1:17000/?volume=7&page=153&mode=source');
  await page.waitForFunction(() => window.readerMonaco?.editor.getModel().getAllDecorations().some(d => d.options.description === 'PDF OCR text difference'));
  console.log('PASS: ME07-153 Monaco differences appear on opening, before any click');
  await page.evaluate(() => { const e=readerMonaco.editor; e.revealPositionInCenter(e.getModel().getPositionAt(e.getValue().indexOf('verschiedenen')+9)); });
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    window.trace = [];
    addEventListener('pdf-selection-difference', e => trace.push({event:'difference',notices:e.detail.notices.map(n=>({html:n.html,pdf:n.pdf,source:n.source&&[n.source.start,n.source.end]}))}));
    const select = PdfSelection.showReviewPointer;
    PdfSelection.showReviewPointer = function(e,item) { trace.push({event:'pointer',comparison:item?.comparison,range:[item?.sourceStart,item?.sourceEnd]}); return select.call(this,e,item); };
    const open = ReplacementReview.openForSelection;
    ReplacementReview.openForSelection = function(...args) {trace.push({event:'open', id:args[0]}); return open.apply(this,args);};
  });
  const point = await page.evaluate(() => {
    const editor = readerMonaco.editor, model = editor.getModel();
    const offset = model.getValue().indexOf('verschiedenen') + 'verschied'.length;
    const position = model.getPositionAt(offset);
    editor.revealPositionInCenter(position);
    const at = editor.getScrolledVisiblePosition(position), rect = editor.getDomNode().getBoundingClientRect();
    return { x: rect.left + at.left + 2, y: rect.top + at.top + at.height / 2 };
  });
  await page.locator('.mew-ocr-diff-text').filter({hasText:/^e$/}).first().click();
  await page.waitForTimeout(1200); console.log(JSON.stringify(await page.evaluate(()=>({trace, status:PdfSelection.status, selection:readerMonaco.editor.getSelection().toString(),pdf:PdfSelection.viewer.currentPageNumber,caret:!!document.querySelector('.mew-pdf-selection-caret'),model:readerMonaco.editor.getModel().getValueInRange(readerMonaco.editor.getSelection())})),null,2)); console.log('ERRORS',errors); await page.screenshot({path:'tmp/me07-153-click-debug.png'});
  await page.waitForSelector('.replacement-review:not([hidden])',{timeout:3000});
  await page.waitForSelector('.mew-pdf-selection-caret');
  for (const scroll of [0, 30, -15]) {
    await page.evaluate(scroll => PdfSelection.viewer.container.scrollBy(0, scroll), scroll);
    await page.waitForTimeout(150);
    const bounds = await page.evaluate(() => {
      const mark = document.querySelector('.mew-pdf-selection-caret'), r = mark.getBoundingClientRect();
      const popup = document.querySelector('.replacement-review').getBoundingClientRect();
      return { actual: { left: r.left, top: r.top, right: r.right, bottom: r.bottom }, reported: PdfSelection.highlightRects()[0],
        popup: { left: popup.left, top: popup.top, right: popup.right, bottom: popup.bottom },
        comparison: document.querySelector('[data-comparison]').textContent, empty: mark.textContent === '' };
    });
    for (const key of ['left', 'top', 'right', 'bottom']) assert.ok(Math.abs(bounds.actual[key] - bounds.reported[key]) < 1, key);
    const a = bounds.actual, p = bounds.popup;
    assert.ok(p.bottom <= a.top || p.top >= a.bottom || p.right <= a.left || p.left >= a.right);
    assert.ok(bounds.empty);
    assert.match(bounds.comparison, /HTML: e/);
  }
  await page.screenshot({ path: 'tmp/me07-153-missing-highlight-verified.png' });
  assert.deepEqual(errors, []);
  console.log('PASS: real click on the missing e opens review; empty PDF caret stays aligned and clear of the popup after scrolling');
} finally { await browser.close(); }


