import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { launchBrowser } from '../../tests/support/browser.mjs';

// Exercise the extension's real dismissal handler and provider guard with native
// browser event ordering; no VS Code host or PDF rendering is needed here.
const popupSource = await readFile(new URL('../pdfdiff/replacement-review.js', import.meta.url), 'utf8');
const providerSource = await readFile(new URL('../pdfdiff/pdf-review-provider.js', import.meta.url), 'utf8');
const selectionSource = await readFile(new URL('../pdfdiff/pdf-selection.js', import.meta.url), 'utf8');
const start = popupSource.indexOf("  document.addEventListener('pointerdown', event => {");
const end = popupSource.indexOf('  new ResizeObserver', start);
assert.ok(start >= 0 && end > start);
const handler = popupSource.slice(start, end);
const prepare = providerSource.slice(providerSource.indexOf('  prepareReview(context = {}) {'), providerSource.indexOf('  reviewItems(context = this.reviewRequest || {}) {'));
const increment = selectionSource.match(/listen\(viewer.container, 'pointerdown', .*?;\n/)[0];
const browser = await launchBrowser();
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setContent('<div id="viewer"><div id="passage">PDF passage</div></div><section id="panel"><button>Popup action</button></section>');
  await page.evaluate(({ handler, prepare, increment }) => {
    const panel = document.getElementById('panel'), viewer = { container: document.getElementById('viewer') };
    let returningToWindow = false, interactionId = 0, opens = 0;
    const model = { getVersionId: () => 1 }, editor = { getModel: () => model, getSelection: () => ({ toString: () => 'same passage' }) };
    const selection = () => ({ interactionId });
    const host = { isOpenFor: () => !panel.hidden, openForSelection: () => { opens++; panel.hidden = false; } };
    const listeningWindow = { ReplacementReview: host }, nativeEditor = false;
    const locator = new (eval('(class {' + prepare + '})'))();
    locator.textEnabled = true;
    locator.reviewItems = function () {
      this.reviewRequest.notice = { source: {} };
      return { items: [], selection: { id: 'same-difference' } };
    };
    function close() {
      panel.hidden = true;
      locator.prepareReview({ type: 'replacement-review-closed', detail: { id: 'pdf-ocr', editor, model } });
    }
    eval(handler);
    const listen = (target, type, listener, options) => target.addEventListener(type, listener, options);
    eval(increment);
    // The real selection path publishes a clicked notice after pointerup.
    viewer.container.addEventListener('pointerup', () => locator.prepareReview({ type: 'pdf-selection-difference', detail: { editor, side: 'pdf', interactionId } }));
    window.fixture = {
      state: () => ({ hidden: panel.hidden, opens, interactionId }),
      returning: () => { returningToWindow = true; },
      reopen: () => { panel.hidden = false; locator.dismissed = null; }
    };
  }, { handler, prepare, increment });
  await page.locator('#panel button').click();
  assert.equal((await page.evaluate(() => fixture.state())).hidden, false, 'popup controls stay open');
  await page.evaluate(() => fixture.returning());
  // The webview can still report no document focus after leaving a native Hover.
  await page.evaluate(() => { document.hasFocus = () => false; });
  await page.locator('#passage').click();
  assert.equal((await page.evaluate(() => fixture.state())).hidden, true, 'first outside click returning to PDF dismisses the popup');
  await page.evaluate(() => fixture.reopen());
  await page.locator('#passage').click();
  assert.equal((await page.evaluate(() => fixture.state())).hidden, true, 'second click on the same highlighted passage stays dismissed after pointerup');
  await page.locator('#passage').click();
  assert.equal((await page.evaluate(() => fixture.state())).hidden, false, 'a later intentional click can open the difference again');
  assert.deepEqual(errors, []);
  console.log('PDF popup dismissal: controls, return dismissal, same-passage dismissal and later reopening passed');
} finally {
  await browser.close();
}
