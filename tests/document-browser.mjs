// Run with PLAYWRIGHT_MODULE pointing to an installed playwright module.
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('..', import.meta.url));
const fixture = await mkdtemp(path.join(tmpdir(), 'mew-doc-browser-'));
const html = label => `<!doctype html>\n<html><head><title>Test</title></head><body><p>${label}</p></body></html>`;
const base = html('original'), second = html('second');
const servers = [];
let browser;
async function start(script, port, args) {
  const child = spawn(process.execPath, [script, '-p', String(port), ...args], { cwd: root, windowsHide: true, stdio: 'pipe' });
  servers.push(child);
  let output = ''; child.stdout.on('data', d => { output += d; }); child.stderr.on('data', d => { output += d; });
  for (let i = 0; i < 80; i++) {
    if (child.exitCode != null) throw new Error(output);
    try { const r = await fetch(`http://127.0.0.1:${port}/`); if (r.ok) return; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`Server timeout: ${output}`);
}
async function diskEquals(file, expected) {
  for (let i = 0; i < 80; i++) {
    if (await readFile(file, 'utf8') === expected) return;
    await new Promise(r => setTimeout(r, 100));
  }
  assert.equal(await readFile(file, 'utf8'), expected);
}
async function valueEquals(page, value) {
  await page.waitForFunction(v => document.querySelector('#editor').value === v, value);
}
async function click(page, id) {
  const button = page.locator(`#${id}`);
  if (!await button.isVisible()) await page.locator('#fileMenu > summary').click();
  if (await button.isEnabled()) await button.click();
}
async function type(page, value) {
  await page.locator('#editor').fill(value);
}
try {
  const folder = path.join(fixture, '1'); await mkdir(folder);
  const editorFile = path.join(fixture, 'a.html');
  const readerFile = path.join(folder, 'ME01-001.html');
  await writeFile(editorFile, base); await writeFile(path.join(fixture, 'b.html'), second);
  await writeFile(readerFile, base); await writeFile(path.join(folder, 'ME01-002.html'), second);
  await writeFile(path.join(fixture, 'config.mjs'), 'export default { htmlRoot: ".", volumes: [{id:"1"}] };');
  await start('server.js', 41871, ['-r', fixture]);
  await start('reader-server.js', 41872, ['-c', path.join(fixture, 'config.mjs')]);
  browser = await chromium.launch({ executablePath: process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: true });
  const context = await browser.newContext();
  // Real textareas normalize line endings; opening/switching/saving must not
  // treat that or the visual DOM's HTML serialization as a user edit.
  for (const reader of [false, true]) {
    const page = await context.newPage(); page.setDefaultTimeout(10000);
    const file = reader ? readerFile : editorFile;
    const url = reader ? 'http://127.0.0.1:41872/?volume=1&page=1&mode=source' : 'http://127.0.0.1:41871/?file=a.html';
    const dirty = () => page.evaluate(isReader => isReader
      ? document.querySelector('#saveBtn').classList.contains('dirty')
      : document.querySelector('#fileName').textContent.endsWith(' *'), reader);
    for (const original of [base, base.replaceAll('\n', '\r\n'), base.replaceAll('\n', '\r'), '<P title=\'x\'>A &amp; B</P>\r\n<p>second</p>\n']) {
      await writeFile(file, original);
      await page.goto(url); await valueEquals(page, original.replace(/\r\n?/g, '\n'));
      assert.equal(await dirty(), false, 'opening untouched source stays clean');
      await click(page, 'saveBtn');
      if (reader) {
        await page.locator('#modeBtn').click();
        await page.frameLocator('#visualEditor').locator('body[contenteditable]').waitFor();
        await click(page, 'saveBtn');
        assert.equal(await dirty(), false, 'untouched visual save stays clean');
        await page.locator('#modeBtn').click();
        assert.equal(await dirty(), false, 'source / visual round trip stays clean');
      } else {
        await page.locator('.item[data-path="b.html"]').click(); await valueEquals(page, second);
        await page.locator('.tab[data-path="a.html"]').click();
        assert.equal(await dirty(), false, 'tab round trip stays clean');
      }
      assert.equal(await readFile(file, 'utf8'), original, 'untouched save preserves exact source');
      await type(page, original + 'edit'); assert.equal(await dirty(), true);
      await click(page, 'undoBtn'); assert.equal(await dirty(), false, 'undo returns to clean original');
      await click(page, 'redoBtn'); assert.equal(await dirty(), true);
      await type(page, original); assert.equal(await dirty(), false, 'manually restoring original stays clean');
    }
    await page.close(); await writeFile(file, base);
    console.log(`${reader ? 'reader' : 'editor'}: untouched LF / CRLF / CR / mixed source, exact save, mode or tab switch, undo / redo passed`);
  }
  for (const reader of [false, true]) {
    const page = await context.newPage(); page.setDefaultTimeout(10000);
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    page.on('dialog', dialog => dialog.accept());
    const url = reader ? 'http://127.0.0.1:41872/?volume=1&page=1&mode=source' : 'http://127.0.0.1:41871/?file=./a.html';
    const file = reader ? readerFile : editorFile;
    await page.goto(url); await valueEquals(page, base);
    const changed = html('edited');
    await type(page, changed);
    await click(page, 'undoBtn'); await valueEquals(page, base);
    await click(page, 'redoBtn'); await valueEquals(page, changed);
    await click(page, 'saveBtn'); await diskEquals(file, changed);
    await click(page, 'undoBtn'); await valueEquals(page, base);
    await click(page, 'redoBtn'); await valueEquals(page, changed);
    console.log(`${reader ? 'reader' : 'editor'}: edit / undo / redo / real disk save passed`);

    // Hold the first save before it reaches the real server; edit again in flight.
    let release, entered;
    const gate = new Promise(r => { release = r; });
    const started = new Promise(r => { entered = r; });
    const endpoint = reader ? '**/api/reader/page/1/1' : '**/api/save';
    let held = false;
    await page.route(endpoint, async route => {
      if (['PUT', 'POST'].includes(route.request().method()) && !held) {
        held = true; entered(); await gate;
      }
      await route.continue();
    });
    const snapshot = html('snapshot'), newer = html('newer');
    await type(page, snapshot); await click(page, 'saveBtn'); await started;
    await type(page, newer); release();
    await diskEquals(file, reader ? newer : snapshot);
    await valueEquals(page, newer);
    if (!reader) { await click(page, 'saveBtn'); await diskEquals(file, newer); }
    await page.unroute(endpoint);
    console.log(`${reader ? 'reader' : 'editor'}: edits during save retained`);

    const external = html('external'); await writeFile(file, external);
    await valueEquals(page, external);
    await click(page, 'undoBtn');
    await valueEquals(page, external);
    const local = html('local unsaved'), disk = html('disk conflict');
    await type(page, local); await writeFile(file, disk);
    await page.waitForFunction(() => /External update|外部修改/.test(document.querySelector('#status').textContent));
    await valueEquals(page, local);
    await click(page, 'saveBtn');
    await page.waitForFunction(() => /changed on disk|保存失败/.test(document.querySelector('#status').textContent));
    assert.equal(await readFile(file, 'utf8'), disk);
    console.log(`${reader ? 'reader' : 'editor'}: external refresh / history reset / conflict protection passed`);

    await page.reload(); await valueEquals(page, disk);
    if (reader) {
      const navigationText = html('save before navigation'); await type(page, navigationText);
      await page.locator('#nextPageBtn').click(); await valueEquals(page, second);
      await diskEquals(file, navigationText);
      await page.locator('#prevBtn').click(); await valueEquals(page, navigationText);
      await page.locator('#modeBtn').click();
      const body = page.frameLocator('#visualEditor').locator('body');
      await body.waitFor(); await body.fill('visual edit');
      await click(page, 'undoBtn'); await body.locator('p').filter({ hasText: 'save before navigation' }).waitFor();
      await click(page, 'redoBtn'); assert.equal(await body.textContent(), 'visual edit');
      await page.locator('#modeBtn').click();
      assert.match(await page.locator('#editor').inputValue(), /visual edit/);
      await click(page, 'saveBtn');
      await diskEquals(file, await page.locator('#editor').inputValue());
      console.log('reader: navigation save / source-visual switching / visual undo-redo passed');
      let releaseRead, enterRead;
      const readGate = new Promise(r => { releaseRead = r; });
      const readStarted = new Promise(r => { enterRead = r; });
      let firstRead = true;
      await page.route('**/api/reader/page/1/2', async route => {
        if (firstRead) { firstRead = false; enterRead(); await readGate; }
        await route.continue();
      });
      await page.locator('#nextPageBtn').click(); await readStarted;
      const duringNavigation = html('edited while loading another page');
      await type(page, duringNavigation); releaseRead();
      await valueEquals(page, second); await diskEquals(file, duringNavigation);
      await page.unroute('**/api/reader/page/1/2');
      await page.locator('#prevBtn').click(); await valueEquals(page, duringNavigation);
      await page.locator('#modeBtn').click();
      await body.locator('p').filter({ hasText: 'edited while loading another page' }).waitFor();
      await writeFile(file, html('external visual refresh'));
      await body.locator('p').filter({ hasText: 'external visual refresh' }).waitFor();
      console.log('reader: edits during navigation / external refresh in visual mode passed');
    } else {
      await type(page, html('tab a'));
      await page.locator('.item[data-path="b.html"]').click(); await valueEquals(page, second);
      await type(page, html('tab b'));
      await page.locator('#fileMenu > summary').click(); await page.locator('#saveAllBtn').click();
      await diskEquals(file, html('tab a')); await diskEquals(path.join(fixture, 'b.html'), html('tab b'));
      await page.locator('.tab[data-path="a.html"]').click(); await valueEquals(page, html('tab a'));
      await page.locator('[data-close="a.html"]').click(); await valueEquals(page, html('tab b'));
      console.log('editor: tabs / save all / close passed');
    }
    assert.deepEqual(errors, []); await page.close();
  }
} finally {
  await browser?.close();
  await Promise.all(servers.map(child => new Promise(resolve => {
    if (child.exitCode != null) return resolve();
    child.once('exit', resolve); child.kill();
  })));
  // Only the unique temporary directory created above is removed.
  if (path.dirname(fixture) === path.resolve(tmpdir()) && path.basename(fixture).startsWith('mew-doc-browser-')) await rm(fixture, { recursive: true, force: true });
}
