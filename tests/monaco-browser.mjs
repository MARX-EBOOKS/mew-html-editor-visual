import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const fixture = await mkdtemp(path.join(tmpdir(), 'mew-monaco-'));
const original = '<!doctype html>\r\n<html><body><p>Alpha</p></body></html>\r\n';
await writeFile(path.join(fixture, 'a.html'), original);
await writeFile(path.join(fixture, 'b.html'), '<p>Beta</p>');
const tabFiles = Array.from({ length: 12 }, (_, index) => `long-tab-name-${String(index + 1).padStart(2, '0')}.html`);
for (const file of tabFiles) await writeFile(path.join(fixture, file), `<p>${file}</p>`);
const server = spawn(process.execPath, ['server.js', '-p', '41874', '-r', fixture], { windowsHide: true, stdio: 'pipe' });
let browser;
try {
  for (let n = 0; n < 80; n++) {
    try { if ((await fetch('http://127.0.0.1:41874/')).ok) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  browser = await chromium.launch({ executablePath: process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: true });
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  const errors = [];
  page.on('pageerror', error => { errors.push(error.message); console.error(error.stack); });
  page.on('console', message => { if (message.type() === 'error') console.error(message.text()); });
  page.on('response', response => { if (response.status() >= 400) console.error(response.status(), response.url()); });
  await page.goto('http://127.0.0.1:41874/');
  await page.waitForFunction(() => window.mewWorkbench?.editor);
  assert.equal(await page.locator('#preview').isHidden(), true, 'no blank iframe covers the empty preview pane');
  await page.goto('http://127.0.0.1:41874/?file=a.html');
  await page.waitForFunction(() => window.mewWorkbench?.editor.getModel());
  assert.equal(await page.locator('#preview').isVisible(), true, 'opening a file displays the preview iframe');
  const value = () => page.evaluate(() => mewWorkbench.editor.getValue());
  await page.waitForFunction(() => document.querySelector('#fileName').textContent === 'a.html');
  await page.keyboard.press('Control+s');
  await page.waitForTimeout(250);
  assert.equal(await readFile(path.join(fixture, 'a.html'), 'utf8'), original, 'opening and saving preserves CRLF');
  await page.evaluate(() => {
    const e = mewWorkbench.editor, model = e.getModel(), start = model.getValue().indexOf('Alpha');
    e.setSelection(monaco.Selection.fromPositions(model.getPositionAt(start), model.getPositionAt(start + 5)));
  });
  await page.locator('#tagBar [data-i="0"]').click();
  assert.match(await value(), /<b>Alpha<\/b>/);
  await page.keyboard.press('Control+z');
  assert.doesNotMatch(await value(), /<b>/);
  await page.keyboard.press('Control+y');
  assert.match(await value(), /<b>Alpha<\/b>/);
  await page.locator('#tree .item[data-path="b.html"]').click();
  await page.waitForFunction(() => mewWorkbench.editor.getValue().includes('Beta'));
  await page.locator('#tabs [data-path="a.html"]').click();
  assert.match(await value(), /<b>Alpha<\/b>/, 'model survives switching');
  await page.keyboard.press('Control+z');
  assert.doesNotMatch(await value(), /<b>/, 'undo survives switching');
  await page.keyboard.press('Control+y');
  await page.keyboard.press('Control+s');
  await page.waitForFunction(() => document.querySelector('#fileName').textContent === 'a.html');
  assert.match(await readFile(path.join(fixture, 'a.html'), 'utf8'), /<b>Alpha<\/b>/);
  const findLayout = () => page.evaluate(() => {
    const rect = document.querySelector('.editorWrap').getBoundingClientRect();
    return { top: rect.top, height: rect.height, firstLine: mewWorkbench.editor.getTopForLineNumber(1) };
  });
  assert.equal(await page.locator('header #findBtn').count(), 1);
  assert.equal(await page.locator('footer #positionInfo').count(), 1);
  assert.equal(await page.locator('.editorPane > .bar').count(), 0, 'no dedicated find toolbar row');
  const closedLayout = await findLayout();
  await page.locator('#findBtn').click();
  await page.waitForFunction(() => document.querySelector('.find-widget')?.classList.contains('visible'));
  assert.deepEqual(await findLayout(), closedLayout, 'opening find adds no editor space');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('.find-widget')?.classList.contains('visible'));
  assert.deepEqual(await findLayout(), closedLayout, 'closing find leaves no reserved rows');
  // Reproduce the reported mouse-close path, including the delayed tooltip.
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.locator('#findBtn').click();
    const closeFind = page.locator('.find-widget .codicon-widget-close');
    await closeFind.hover();
    await page.waitForTimeout(900);
    assert.equal(await page.locator('.monaco-hover.workbench-hover:visible').count(), 0, 'close tooltip must not pop up');
    const rect = await closeFind.boundingBox();
    await page.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2);
    await page.waitForFunction(() => !document.querySelector('.find-widget')?.classList.contains('visible'));
  }
  await page.locator('#darkBtn').click();
  assert.equal(await page.evaluate(() => document.body.classList.contains('dark')), true);
  await page.waitForFunction(() => document.querySelector('#preview').srcdoc.includes('<b>Alpha</b>'));
  await writeFile(path.join(fixture, 'b.html'), '<p>Externally updated Beta</p>');
  await page.waitForFunction(() => mewWorkbench.documents.get('b.html').model.getValue().includes('Externally updated'));
  await page.locator('#tree .item[data-path="b.html"]').click();
  assert.match(await value(), /Externally updated/);
  await page.keyboard.press('Control+End'); await page.keyboard.type('local edit');
  await writeFile(path.join(fixture, 'b.html'), '<p>Conflicting external edit</p>');
  await page.waitForTimeout(400);
  await page.keyboard.press('Control+s');
  await page.waitForFunction(() => document.querySelector('#status').textContent.includes('changed on disk'));
  assert.match(await value(), /local edit/);
  assert.equal(await readFile(path.join(fixture, 'b.html'), 'utf8'), '<p>Conflicting external edit</p>');
  await page.locator('#tabs [data-close="b.html"]').click();
  await page.locator('#closeDialog [value="cancel"]').click();
  assert.equal(await page.evaluate(() => mewWorkbench.documents.has('b.html')), true);
  await page.locator('#tabs [data-close="b.html"]').click();
  await page.locator('#closeDialog [value="discard"]').click();
  await page.waitForFunction(() => !mewWorkbench.documents.has('b.html'));
  await writeFile(path.join(fixture, 'new.html'), '<p>New</p>');
  await page.locator('#tree .item[data-path="new.html"]').waitFor();
  await page.locator('#tree .item[data-path="new.html"]').click();
  await page.waitForFunction(() => mewWorkbench.editor.getValue().includes('New'));
  await page.keyboard.press('Control+End'); await page.keyboard.type(' saved on close');
  await page.route('**/api/save', async route => {
    await new Promise(resolve => setTimeout(resolve, 200));
    await route.continue();
  });
  await page.locator('#tabs [data-close="new.html"]').click();
  await page.locator('#closeDialog [value="save"]').click();
  await page.waitForFunction(() => !mewWorkbench.documents.has('new.html'));
  assert.match(await readFile(path.join(fixture, 'new.html'), 'utf8'), /saved on close/);
  await page.unroute('**/api/save');
  // A slow earlier open must not replace the user's newer selection.
  await page.route('**/api/file?path=new.html', async route => {
    await new Promise(resolve => setTimeout(resolve, 250)); await route.continue();
  });
  await page.evaluate(() => { mewWorkbench.openFile('new.html'); mewWorkbench.openFile('a.html'); });
  await page.waitForTimeout(400);
  assert.equal(await page.evaluate(() => mewWorkbench.editor.getModel().uri.path), '/a.html');
  for (const file of tabFiles) await page.evaluate(file => mewWorkbench.openFile(file), file);
  assert.equal(await page.evaluate(() => {
    const tabs = document.querySelector('#tabs').getBoundingClientRect();
    const active = document.querySelector('#tabs .tab.active').getBoundingClientRect();
    return active.left >= tabs.left && active.right <= tabs.right;
  }), true, 'newly active tab is visible');
  await page.locator('#tabs [data-path="a.html"]').click();
  assert.equal(await page.evaluate(() => {
    const tabs = document.querySelector('#tabs').getBoundingClientRect();
    const active = document.querySelector('#tabs .tab.active').getBoundingClientRect();
    return active.left >= tabs.left && active.right <= tabs.right;
  }), true, 'previously opened active tab is brought back into view');
  await page.screenshot({ path: path.join(tmpdir(), 'mew-monaco-workbench.png') });
  await page.locator('#closeAllBtn').click();
  await page.waitForFunction(() => mewWorkbench.documents.size === 0);
  assert.equal(await page.locator('#preview').isHidden(), true, 'closing the final file reveals the preview pane background');
  await page.screenshot({ path: path.join(tmpdir(), 'mew-monaco-empty-preview.png') });
  assert.deepEqual(errors, []);
  console.log('PASS: Monaco, tag undo/redo, per-file models, CRLF/save, native find, theme/preview, external reload/conflict, close cancel/discard, tree events.');
} finally {
  await browser?.close();
  server.kill();
  await new Promise(resolve => server.exitCode !== null ? resolve() : server.once('exit', resolve));
  await rm(fixture, { recursive: true, force: true });
}
