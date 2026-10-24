import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const fixture = await mkdtemp(path.join(tmpdir(), 'mew-monaco-'));
  const original = '<!doctype html>\r\n<html><head><style>a{background:rgb(1,2,3)}</style></head><body><p style="color:#0f0">Alpha</p><a href="#F10">10</a></body></html>\r\n';
  await writeFile(path.join(fixture, 'a.html'), original);
  await writeFile(path.join(fixture, 'b.html'), '<p>Beta</p>');
  await writeFile(path.join(fixture, 'theme.css'), 'a { color: #f10; }');
  await writeFile(path.join(fixture, 'logic.js'), 'export const answer = 42;');
  await writeFile(path.join(fixture, 'data.json'), '{"answer":42}');
  await writeFile(path.join(fixture, 'README'), 'plain text');
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
  const editorScaleInput = page.locator('#editorScaleInput');
  await editorScaleInput.fill('120'); await editorScaleInput.press('Enter');
  assert.equal(await page.evaluate(() => mewWorkbench.editor.getOption(monaco.editor.EditorOption.fontSize)), 16.8, 'editor zoom input changes Monaco font size');
  await page.locator('#monacoEditor').hover(); await page.keyboard.down('Control'); await page.mouse.wheel(0, -100); await page.keyboard.up('Control');
  assert.equal(await editorScaleInput.inputValue(), '130%', 'Ctrl+wheel over index editor changes editor zoom');
  await page.evaluate(() => mewWorkbench.editor.focus()); await page.keyboard.press('Control+-');
  assert.equal(await editorScaleInput.inputValue(), '120%', 'Ctrl+- changes index editor zoom');
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('mew-editor-layout-v1')).editorScale), 1.2, 'index editor zoom is persisted with layout');
  await editorScaleInput.fill('100'); await editorScaleInput.press('Enter');
  assert.equal(await page.locator('#preview').isVisible(), true, 'opening a file displays the preview iframe');
  const value = () => page.evaluate(() => mewWorkbench.editor.getValue());
  await page.waitForFunction(() => document.querySelector('#fileName').textContent === 'a.html');
  assert.deepEqual(await page.evaluate(() => ({
    language: mewWorkbench.editor.getModel().getLanguageId(),
    decorators: mewWorkbench.editor.getOption(monaco.editor.EditorOption.colorDecorators),
    defaultDecorators: mewWorkbench.editor.getOption(monaco.editor.EditorOption.defaultColorDecorators),
    status: document.querySelector('#languageInfo').textContent
  })), { language: 'html', decorators: true, defaultDecorators: 'never', status: 'HTML · UTF-8' });
  await page.waitForFunction(() => document.querySelectorAll('#monacoEditor .colorpicker-color-decoration').length === 2);
  assert.equal(await page.locator('#monacoEditor .colorpicker-color-decoration').count(), 2, 'only style attribute and style block colors are decorated; href is ignored');
  for (const [file, language] of [['theme.css', 'css'], ['logic.js', 'javascript'], ['data.json', 'json'], ['README', 'plaintext']]) {
    await page.evaluate(file => mewWorkbench.openFile(file), file);
    await page.waitForFunction(([file, language]) => document.querySelector('#fileName').textContent === file
      && mewWorkbench.editor.getModel().getLanguageId() === language, [file, language]);
  }
  assert.equal(await page.evaluate(() => mewWorkbench.editor.getOption(monaco.editor.EditorOption.colorDecorators)), false, 'plain text has no color decorators');
  await page.evaluate(() => mewWorkbench.openFile('theme.css'));
  await page.waitForFunction(() => mewWorkbench.editor.getModel().getLanguageId() === 'css');
  assert.equal(await page.evaluate(() => mewWorkbench.editor.getOption(monaco.editor.EditorOption.colorDecorators)), true, 'CSS keeps useful color decorators');
  await page.evaluate(() => mewWorkbench.openFile('a.html'));
  await page.waitForFunction(() => mewWorkbench.editor.getModel().getLanguageId() === 'html');
  for (const file of ['theme.css', 'logic.js', 'data.json', 'README']) {
    await page.locator(`#tabs [data-close="${file}"]`).click();
    await page.waitForFunction(file => !mewWorkbench.documents.has(file), file);
  }
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
  await page.evaluate(() => mewWorkbench.openFile('b.html'));
  await page.waitForFunction(() => mewWorkbench.editor.getModel()?.uri.path === '/b.html');
  await page.evaluate(() => mewWorkbench.editor.executeEdits('save-all-chord', [{ range: mewWorkbench.editor.getModel().getFullModelRange(), text: '<p>Beta saved by chord</p>' }]));
  await page.evaluate(() => mewWorkbench.openFile('a.html'));
  await page.waitForFunction(() => mewWorkbench.editor.getModel()?.uri.path === '/a.html');
  await page.evaluate(() => mewWorkbench.editor.executeEdits('save-all-chord', [{ range: new monaco.Range(1, 1, 1, 1), text: '<!-- saved by chord -->' }]));
  await page.keyboard.press('Control+k'); await page.keyboard.press('s');
  await page.waitForFunction(() => [...mewWorkbench.documents.values()].every(document => !document.dirty));
  assert.match(await readFile(path.join(fixture, 'a.html'), 'utf8'), /saved by chord/);
  assert.match(await readFile(path.join(fixture, 'b.html'), 'utf8'), /saved by chord/);
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
  await page.locator('#findBtn').click();
  await page.waitForFunction(() => !document.querySelector('.find-widget')?.classList.contains('visible'));
  assert.deepEqual(await findLayout(), closedLayout, 'second button click closes find without reserved rows');
  // Find action tooltips may escape above the editor instead of covering their
  // buttons. The close tooltip is no longer suppressed as a special case.
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.locator('#findBtn').click();
    const closeFind = page.locator('.find-widget .codicon-widget-close');
    await closeFind.hover();
    await page.waitForTimeout(900);
    const closeTooltip = page.locator('.monaco-hover.workbench-hover:visible');
    assert.equal(await closeTooltip.count(), 1, 'close tooltip remains available');
    const tooltipRect = await closeTooltip.boundingBox();
    const rect = await closeFind.boundingBox();
    const editorTop = await page.locator('.editorWrap').evaluate(node => node.getBoundingClientRect().top);
    assert.ok(tooltipRect.y < editorTop, 'tooltip may overflow upward into the editor header/chrome');
    assert.ok(tooltipRect.y + tooltipRect.height <= rect.y,
      'close tooltip is placed above and does not cover its button');
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
