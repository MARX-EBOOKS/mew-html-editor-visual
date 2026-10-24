import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try { for (const size of [{width:1100,height:800},{width:1280,height:720},{width:1920,height:1080}]) { console.log(size);
  const page = await browser.newPage({ viewport: size });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://127.0.0.1:17000/?volume=7&page=153&mode=source');
  await page.waitForFunction(() => window.readerMonaco?.editor.getModel().getAllDecorations().some(d => d.options.description === 'PDF OCR text difference'));
  console.log('PASS: ME07-153 Monaco differences appear on opening, before any click');
  await page.waitForTimeout(4000);
  const point = await page.evaluate(() => {
    const editor = readerMonaco.editor, model = editor.getModel();
    const offset = model.getValue().indexOf('verschiedenen') + 'verschied'.length;
    const position = model.getPositionAt(offset);
    editor.revealPositionInCenter(position);
    const at = editor.getScrolledVisiblePosition(position), rect = editor.getDomNode().getBoundingClientRect();
    return { x: rect.left + at.left + 2, y: rect.top + at.top + at.height / 2 };
  });
  await page.mouse.click(point.x, point.y);
  await page.waitForSelector('.replacement-review:not([hidden])');
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
await page.close(); } } finally { await browser.close(); }

