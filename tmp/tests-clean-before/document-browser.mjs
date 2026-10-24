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
const root = fileURLToPath(new URL('../..', import.meta.url));
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
  try {
    await page.waitForFunction(v => window.readerMonaco
      ? readerMonaco.editor.getValue().replace(/\r\n?/g, '\n') === v.replace(/\r\n?/g, '\n')
      : document.querySelector('#editor')?.value === v, value);
  } catch (error) {
    const state = await page.evaluate(() => ({ value: window.readerMonaco?.editor.getValue(), status: document.querySelector('#status')?.textContent, body: document.body.innerText.slice(0, 300) }));
    throw new Error(`${error.message}: ${JSON.stringify(state)}`);
  }
}
async function click(page, id) {
  const button = page.locator(`#${id}`);
  if (!await button.isVisible()) await page.locator('#fileMenu > summary').click();
  if (await button.isEnabled()) await button.click();
}
async function type(page, value) {
  if (await page.evaluate(() => Boolean(window.readerMonaco))) {
    await page.evaluate(text => {
      const { editor, model } = readerMonaco;
      editor.pushUndoStop();
      editor.executeEdits('browser-test', [{ range: model.getFullModelRange(), text }]);
      editor.pushUndoStop();
    }, value);
  } else await page.locator('#editor').fill(value);
}
async function sourceValue(page) {
  return page.evaluate(() => window.readerMonaco
    ? readerMonaco.editor.getValue()
    : document.querySelector('#editor').value);
}
try {
  const folder = path.join(fixture, '1'); await mkdir(folder);
  const editorFile = path.join(fixture, 'a.html');
  const readerFile = path.join(folder, 'ME01-001.html');
  await writeFile(editorFile, base); await writeFile(path.join(fixture, 'b.html'), second);
  const tabFiles = Array.from({ length: 12 }, (_, index) => `legacy-long-tab-name-${String(index + 1).padStart(2, '0')}.html`);
  for (const file of tabFiles) await writeFile(path.join(fixture, file), html(file));
  await writeFile(readerFile, base); await writeFile(path.join(folder, 'ME01-002.html'), second);
  await writeFile(path.join(fixture, 'config.json'), JSON.stringify({ volumes: [{ id: '1', pages: { directory: '1', pattern: '^ME01-([0-9]+)[.]html$' }, pdf: 'missing.pdf' }] }));
  await start('server.js', 41871, ['-r', fixture]);
  await start('reader-server.js', 41872, ['-c', path.join(fixture, 'config.json')]);
  browser = await chromium.launch({ executablePath: process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: true });
  const context = await browser.newContext();
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'http://127.0.0.1:41872' });
  const readerVariants = process.env.READER_ONLY ? [true] : [false, true];
  // Real textareas normalize line endings; opening/switching/saving must not
  // treat that or the visual DOM's HTML serialization as a user edit.
  for (const reader of readerVariants) {
    const page = await context.newPage(); page.setDefaultTimeout(10000);
    const file = reader ? readerFile : editorFile;
    const url = reader ? 'http://127.0.0.1:41872/?volume=1&page=1&mode=source' : 'http://127.0.0.1:41871/legacy.html?file=a.html';
    const dirty = () => page.evaluate(isReader => isReader
      ? document.querySelector('#saveBtn').classList.contains('dirty')
      : document.querySelector('#fileName').textContent.endsWith(' *'), reader);
    for (const original of [base, base.replaceAll('\n', '\r\n'), base.replaceAll('\n', '\r'), '<P title=\'x\'>A &amp; B</P>\r\n<p>second</p>\n']) {
      await writeFile(file, original);
      await page.goto(url); await valueEquals(page, original.replace(/\r\n?/g, '\n'));
      assert.equal(await dirty(), false, 'opening untouched source stays clean');
      if (reader && original === base) {
        const panel = page.locator('.float-panel[data-panel="tagBar"]');
        const editorScaleInput = panel.locator('[data-scale-input="editor"]');
        const tagScaleInput = panel.locator('[data-scale-input="tag"]');
        assert.equal(await panel.evaluate(node => {
          const editor = node.querySelector('[data-scale-input="editor"]');
          const tag = node.querySelector('[data-scale-input="tag"]');
          return Boolean(editor.compareDocumentPosition(tag) & Node.DOCUMENT_POSITION_FOLLOWING);
        }), true, 'editor zoom controls precede tag zoom controls');
        const before = await panel.evaluate(node => ({ dock: node.className, scroll: document.scrollingElement.scrollTop }));
        await tagScaleInput.fill('100'); await tagScaleInput.press('Enter');
        const scaleButton = panel.locator('[data-scale-target="tag"] [data-scale-action="larger"]');
        const scaleButtonBox = await scaleButton.boundingBox();
        await page.mouse.move(scaleButtonBox.x + scaleButtonBox.width / 2, scaleButtonBox.y + scaleButtonBox.height / 2);
        await page.mouse.down();
        assert.deepEqual(await panel.locator('.fp-actions').evaluate(actions => {
          const style = getComputedStyle(actions);
          const border = parseFloat(style.borderLeftWidth) + parseFloat(style.borderRightWidth);
          return { overflowY: style.overflowY, scrollbarWidth: Math.round(actions.offsetWidth - actions.clientWidth - border) };
        }), { overflowY: 'hidden', scrollbarWidth: 0 }, 'pressed plugin controls do not create a vertical scrollbar');
        await page.mouse.up();
        assert.equal(await tagScaleInput.inputValue(), '110%', 'one click enlarges tag buttons');
        assert.equal(await panel.locator('.tag-bar').evaluate(bar => bar.scrollHeight > bar.clientHeight + 1), false, 'reader tag zoom does not create a vertical scrollbar');
        const after = await panel.evaluate(node => ({ dock: node.className, scroll: document.scrollingElement.scrollTop }));
        assert.equal(after.dock, before.dock, 'size click does not start panel dragging');
        assert.equal(after.scroll, before.scroll, 'size click does not scroll the page');
        await tagScaleInput.fill('125%'); await tagScaleInput.press('Enter');
        assert.equal(await panel.evaluate(node => node.style.getPropertyValue('--fp-scale')), '1.25', 'tag zoom accepts numeric input');
        await panel.locator('.tag-bar').hover(); await page.keyboard.down('Control'); await page.mouse.wheel(0, -100); await page.keyboard.up('Control');
        assert.equal(await tagScaleInput.inputValue(), '135%', 'Ctrl+wheel over tag bar changes tag zoom');
        await tagScaleInput.fill('150'); await tagScaleInput.press('Enter');
        const tagButton = panel.locator('.tag-bar button').first();
        const tagGeometry = () => panel.locator('.tag-bar').evaluate(bar => ({
          buttons: [...bar.querySelectorAll('button')].map(button => {
            const rect = button.getBoundingClientRect();
            return [rect.x, rect.y, rect.width, rect.height];
          }),
          overflowY: getComputedStyle(bar).overflowY,
          scrollTop: bar.scrollTop,
          verticalScrollbar: bar.offsetWidth - bar.clientWidth
        }));
        const tagsBeforePress = await tagGeometry();
        const tagButtonBox = await tagButton.boundingBox();
        await page.mouse.move(tagButtonBox.x + tagButtonBox.width / 2, tagButtonBox.y + tagButtonBox.height / 2);
        await page.mouse.down();
        assert.deepEqual(await tagGeometry(), tagsBeforePress, 'pressed tag button keeps every button at the same size and position');
        await page.mouse.up();
        const tagsAfterPress = await tagGeometry();
        assert.deepEqual(tagsAfterPress.buttons, tagsBeforePress.buttons, 'tag click does not rewrap or move buttons');
        assert.equal(tagsAfterPress.overflowY, 'hidden', 'tag bar permanently disables vertical scrolling');
        assert.equal(tagsAfterPress.verticalScrollbar, 0, 'tag bar has no vertical scrollbar');
        assert.equal(tagsAfterPress.scrollTop, 0, 'tag click does not vertically scroll the tag bar');
        await tagScaleInput.fill('100'); await tagScaleInput.press('Enter');
        await editorScaleInput.fill('120'); await editorScaleInput.press('Enter');
        assert.equal(await page.evaluate(() => readerMonaco.editor.getOption(monaco.editor.EditorOption.fontSize)), 16.8, 'editor zoom input changes Monaco font size');
        await page.evaluate(() => readerMonaco.editor.focus()); await page.keyboard.press('Control+-');
        assert.equal(await editorScaleInput.inputValue(), '110%', 'Ctrl+- changes editor zoom');
        await page.locator('#monacoEditor').hover(); await page.keyboard.down('Control'); await page.mouse.wheel(0, -100); await page.keyboard.up('Control');
        assert.equal(await editorScaleInput.inputValue(), '120%', 'Ctrl+wheel over editor changes editor zoom');
        await editorScaleInput.fill('100'); await editorScaleInput.press('Enter');
        const colorFixture = '<p style="color:#0f0">styled</p><a href="#F10">linked</a>';
        await page.evaluate(text => readerMonaco.model.setValue(text), colorFixture);
        await page.waitForFunction(() => document.querySelectorAll('#monacoEditor .colorpicker-color-decoration').length === 1);
        assert.equal(await page.locator('#monacoEditor .colorpicker-color-decoration').count(), 1, 'reader decorates style color but not href');
        await page.evaluate(text => readerMonaco.model.setValue(text), original.replace(/\r\n?/g, '\n'));
        await page.waitForFunction(() => !document.querySelector('#saveBtn').classList.contains('dirty'));
      }
      await click(page, 'saveBtn');
      if (reader) {
        if (original === base) {
          const input = page.locator('[data-scale-input="editor"]');
          await input.fill('130'); await input.press('Enter');
          assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('readerDockPanels.v1'))._editorScale), 1.3, 'editor zoom is persisted with panel layout');
        }
        await page.locator('#modeBtn').click();
        const visualBody = page.frameLocator('#visualEditor').locator('body[contenteditable]');
        await visualBody.waitFor();
        if (original === base) {
          assert.equal(await page.locator('#visualEditor').evaluate(frame => frame.contentDocument.documentElement.style.zoom), '1.3', 'editor zoom applies to visual editing');
          await visualBody.click(); await page.keyboard.press('Control+Equal');
          assert.equal(await page.locator('[data-scale-input="editor"]').inputValue(), '140%', 'Ctrl++ changes visual editor zoom');
          const input = page.locator('[data-scale-input="editor"]');
          await input.fill('100'); await input.press('Enter');
        }
        await click(page, 'saveBtn');
        assert.equal(await dirty(), false, `untouched visual save stays clean: ${JSON.stringify(await sourceValue(page))}`);
        await page.locator('#modeBtn').click();
        assert.equal(await dirty(), false, 'source / visual round trip stays clean');
      } else {
        await page.locator('.item[data-path="b.html"]').click(); await valueEquals(page, second);
        await page.locator('.tab[data-path="a.html"]').click();
        assert.equal(await dirty(), false, 'tab round trip stays clean');
      }
      assert.equal(await readFile(file, 'utf8'), original, 'untouched save preserves exact source');
      await type(page, original + 'edit');
      await page.waitForFunction(isReader => isReader
        ? document.querySelector('#saveBtn').classList.contains('dirty')
        : document.querySelector('#fileName').textContent.endsWith(' *'), reader);
      assert.equal(await dirty(), true);
      await click(page, 'undoBtn'); assert.equal(await dirty(), false, 'undo returns to clean original');
      await click(page, 'redoBtn'); assert.equal(await dirty(), true);
      await type(page, original);
      await page.waitForFunction(isReader => isReader
        ? !document.querySelector('#saveBtn').classList.contains('dirty')
        : !document.querySelector('#fileName').textContent.endsWith(' *'), reader);
      assert.equal(await dirty(), false, 'manually restoring original stays clean');
    }
    await page.close(); await writeFile(file, base);
    console.log(`${reader ? 'reader' : 'editor'}: untouched LF / CRLF / CR / mixed source, exact save, mode or tab switch, undo / redo passed`);
  }
  for (const reader of readerVariants) {
    const page = await context.newPage(); page.setDefaultTimeout(10000);
    if (reader) await page.addInitScript(() => {
      let ui;
      Object.defineProperty(window, 'ReaderUI', {
        configurable: true,
        get: () => ui,
        set: value => {
          ui = value;
          const init = value.init.bind(value);
          value.init = handlers => { window.__readerHandlers = handlers; return init(handlers); };
        }
      });
    });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    page.on('dialog', dialog => dialog.accept());
    const url = reader ? 'http://127.0.0.1:41872/?volume=1&page=1&mode=source' : 'http://127.0.0.1:41871/legacy.html?file=./a.html';
    const file = reader ? readerFile : editorFile;
    await page.goto(url); await valueEquals(page, base);
    const changed = html('edited');
    await type(page, changed);
    if (reader) {
      await page.evaluate(() => __readerHandlers.pdfPageChange({ pageNumber: 2, pageLabel: '2' }));
      await page.waitForTimeout(150);
      await valueEquals(page, changed);
      assert.equal(await readFile(file, 'utf8'), base, 'PDF scrolling does not auto-save a dirty web page');
      await page.evaluate(() => __readerHandlers.pdfPageChange({ pageNumber: 1, pageLabel: '1' }));
    }
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
      await page.evaluate(() => {
        const { editor, model } = readerMonaco;
        const start = model.getValue().indexOf('disk conflict');
        editor.setSelection(monaco.Selection.fromPositions(model.getPositionAt(start), model.getPositionAt(start + 13)));
      });
      await page.locator('#tagBar [data-tag="0"]').click();
      await page.waitForFunction(() => readerMonaco.editor.getValue().includes('<b>disk conflict</b>'));
      await click(page, 'undoBtn'); await valueEquals(page, disk);
      await click(page, 'redoBtn');
      await page.waitForFunction(() => readerMonaco.editor.getValue().includes('<b>disk conflict</b>'));
      await click(page, 'undoBtn'); await valueEquals(page, disk);
      await page.evaluate(() => navigator.clipboard.writeText('clipboard search text'));
      await page.locator('#findBtn').click();
      await page.waitForFunction(() => document.querySelector('.find-widget')?.classList.contains('visible'));
      await page.waitForFunction(() => document.querySelector('.find-widget .input')?.value === 'clipboard search text');
      await page.locator('#findBtn').click();
      await page.waitForFunction(() => !document.querySelector('.find-widget')?.classList.contains('visible'));
      await page.evaluate(() => readerMonaco.editor.focus());
      await page.keyboard.press('Control+H');
      await page.waitForFunction(() => document.querySelector('.find-widget')?.classList.contains('visible'));
      await page.keyboard.press('Escape');
      const shortcutText = html('shortcut save');
      await type(page, shortcutText);
      await page.evaluate(() => readerMonaco.editor.focus());
      await page.keyboard.press('Control+S');
      await diskEquals(file, shortcutText);
      console.log('reader: Monaco tag edit / native undo-redo / native find-replace / Ctrl+S passed');
      const navigationText = html('save before navigation'); await type(page, navigationText);
      assert.equal(await page.locator('.text-pane footer #languageInfo').textContent(), 'HTML · UTF-8');
      await page.evaluate(() => readerMonaco.editor.setPosition({ lineNumber: 2, column: 3 }));
      assert.equal(await page.locator('#positionInfo').textContent(), 'Ln 2, Col 3');
      assert.equal(await page.locator('#prevFileBtn').isDisabled(), true);
      await page.locator('#nextFileBtn').click(); await valueEquals(page, second);
      await diskEquals(file, navigationText);
      assert.equal(await page.locator('#nextFileBtn').isDisabled(), true);
      await page.locator('#prevFileBtn').click(); await valueEquals(page, navigationText);
      await page.locator('#modeBtn').click();
      const body = page.frameLocator('#visualEditor').locator('body');
      await body.waitFor(); await body.fill('visual edit');
      await click(page, 'undoBtn'); await body.locator('p').filter({ hasText: 'save before navigation' }).waitFor();
      await click(page, 'redoBtn'); assert.equal(await body.textContent(), 'visual edit');
      await page.locator('#modeBtn').click();
      assert.match(await sourceValue(page), /visual edit/);
      await click(page, 'saveBtn');
      await diskEquals(file, await sourceValue(page));
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
      for (const tabFile of tabFiles) {
        await page.locator(`.item[data-path="${tabFile}"]`).click();
        await valueEquals(page, html(tabFile));
      }
      assert.equal(await page.evaluate(() => {
        const tabs = document.querySelector('#tabs').getBoundingClientRect();
        const active = document.querySelector('#tabs .tab.active').getBoundingClientRect();
        return active.left >= tabs.left && active.right <= tabs.right;
      }), true, 'legacy newly active tab is visible');
      await page.locator('.tab[data-path="b.html"]').click();
      assert.equal(await page.evaluate(() => {
        const tabs = document.querySelector('#tabs').getBoundingClientRect();
        const active = document.querySelector('#tabs .tab.active').getBoundingClientRect();
        return active.left >= tabs.left && active.right <= tabs.right;
      }), true, 'legacy previously opened active tab is brought back into view');
      await page.locator('#darkBtn').click();
      assert.equal(await page.evaluate(() => document.body.classList.contains('dark')), true);
      await page.locator('#closeAllBtn').click();
      await page.waitForFunction(() => document.querySelectorAll('#tabs .tab').length === 0);
      assert.equal(await page.locator('#preview').isHidden(), true, 'legacy close all reveals the preview pane background');
      await page.screenshot({ path: path.join(tmpdir(), 'mew-legacy-empty-preview.png') });
      console.log('editor: tabs / save all / close passed');
    }
    assert.deepEqual(errors, []); await page.close();
  }

  // A PDF turn made while the HTML is dirty is remembered. Once the user
  // explicitly saves, the reader must immediately catch up to that PDF page.
  await writeFile(readerFile, base);
  await writeFile(path.join(folder, 'ME01-002.html'), second);
  const pdfSyncPage = await context.newPage(); pdfSyncPage.setDefaultTimeout(10000);
  await pdfSyncPage.addInitScript(() => {
    let ui;
    Object.defineProperty(window, 'ReaderUI', {
      configurable: true,
      get: () => ui,
      set: value => {
        ui = value;
        const init = value.init.bind(value);
        value.init = handlers => { window.__readerHandlers = handlers; return init(handlers); };
      }
    });
  });
  const pdfSyncErrors = []; pdfSyncPage.on('pageerror', error => pdfSyncErrors.push(error.message));
  await pdfSyncPage.goto('http://127.0.0.1:41872/?volume=1&page=1&mode=source');
  const savedBeforePdfSync = html('save then follow PDF');
  await type(pdfSyncPage, savedBeforePdfSync);
  await pdfSyncPage.evaluate(() => __readerHandlers.pdfPageChange({ pageNumber: 2, pageLabel: '2' }));
  await valueEquals(pdfSyncPage, savedBeforePdfSync);
  assert.equal(await readFile(readerFile, 'utf8'), base, 'dirty PDF turn still does not auto-save');
  await click(pdfSyncPage, 'saveBtn');
  await diskEquals(readerFile, savedBeforePdfSync);
  await valueEquals(pdfSyncPage, second);
  await pdfSyncPage.waitForFunction(() => new URL(location.href).searchParams.get('page') === '2');
  assert.deepEqual(pdfSyncErrors, []);
  await pdfSyncPage.close();
  console.log('reader: saved HTML immediately follows the pending PDF page');

  // Split mode keeps the PDF window read-only and lets index.html retain all
  // working copies and save/conflict behavior. Page changes travel both ways.
  await writeFile(readerFile, base);
  await writeFile(path.join(folder, 'ME01-002.html'), second);
  const session = `browser-${Date.now()}`;
  const pureReader = await context.newPage(); pureReader.setDefaultTimeout(10000);
  await pureReader.addInitScript(() => {
    let ui;
    Object.defineProperty(window, 'ReaderUI', {
      configurable: true,
      get: () => ui,
      set: value => {
        ui = value;
        const init = value.init.bind(value);
        value.init = handlers => { window.__readerHandlers = handlers; return init(handlers); };
      }
    });
  });
  await pureReader.goto(`http://127.0.0.1:41872/?view=reader&sync=${session}&volume=1&page=1`);
  await pureReader.waitForFunction(() => document.body.classList.contains('reader-only') && new URL(location.href).searchParams.get('page') === '1');
  assert.equal(await pureReader.evaluate(() => Boolean(window.readerMonaco)), false, 'pure reader does not initialize its internal Monaco editor');
  assert.equal(await pureReader.locator('.text-pane').isHidden(), true);
  assert.equal(await pureReader.locator('#saveBtn').isHidden(), true);
  assert.equal(await pureReader.evaluate(() => document.querySelector('.scan-pane').getBoundingClientRect().width >= innerWidth - 1), true, 'PDF pane occupies the pure-reader window');
  await pureReader.setViewportSize({ width: 1244, height: 900 });
  assert.deepEqual(await pureReader.locator('.actions').evaluate(actions => ({
    horizontalOverflow: actions.scrollWidth > actions.clientWidth,
    verticalOverflow: actions.scrollHeight > actions.clientHeight
  })), { horizontalOverflow: false, verticalOverflow: false }, 'split reader header does not grow a scrollbar at app-window width');

  const pairedEditor = await context.newPage(); pairedEditor.setDefaultTimeout(10000);
  await pairedEditor.goto(`http://127.0.0.1:41872/index.html?readerSession=${session}&file=1/ME01-001.html`);
  await pairedEditor.waitForFunction(() => mewWorkbench?.documents?.has('1/ME01-001.html'));
  assert.equal(await pairedEditor.locator('#pdfFrame').count(), 0, 'paired window is index.html, not another combined reader');
  const pairedDirty = html('paired dirty working copy');
  await pairedEditor.evaluate(text => {
    const model = mewWorkbench.editor.getModel();
    mewWorkbench.editor.executeEdits('paired-test', [{ range: model.getFullModelRange(), text }]);
  }, pairedDirty);
  await pureReader.evaluate(() => __readerHandlers.pdfPageChange({ pageNumber: 2, pageLabel: '2' }));
  await pairedEditor.waitForFunction(() => mewWorkbench.editor.getModel()?.uri.path === '/1/ME01-002.html');
  assert.equal(await readFile(readerFile, 'utf8'), base, 'split reader navigation never saves the editor working copy');
  assert.equal(await pairedEditor.evaluate(() => mewWorkbench.documents.get('1/ME01-001.html').dirty), true, 'index.html retains the dirty tab');
  await pairedEditor.evaluate(() => mewWorkbench.openFile('1/ME01-001.html'));
  await pureReader.waitForFunction(() => new URL(location.href).searchParams.get('page') === '1');
  await click(pairedEditor, 'saveBtn');
  await diskEquals(readerFile, pairedDirty);
  await pairedEditor.evaluate(() => mewWorkbench.openFile('1/ME01-002.html'));
  await pureReader.waitForFunction(() => new URL(location.href).searchParams.get('page') === '2');
  await pairedEditor.close(); await pureReader.close();
  console.log('reader: split PDF / index.html page sync and save ownership passed');

  const modePage = await context.newPage(); modePage.setDefaultTimeout(10000);
  await modePage.addInitScript(() => {
    const nativeOpen = window.open.bind(window);
    window.open = (url, target, features) => {
      const seen = JSON.parse(sessionStorage.getItem('__openFeatures') || '[]');
      seen.push(features || '');
      sessionStorage.setItem('__openFeatures', JSON.stringify(seen));
      return nativeOpen(url, target, features);
    };
  });
  await modePage.goto('http://127.0.0.1:41872/?volume=1&page=1&mode=source');
  await modePage.waitForFunction(() => Boolean(window.readerMonaco));
  const [openedEditor] = await Promise.all([
    modePage.waitForEvent('popup'),
    modePage.locator('#splitViewBtn').click()
  ]);
  assert.equal(await modePage.evaluate(() => JSON.parse(sessionStorage.getItem('__openFeatures') || '[]').at(-1)), 'popup=yes', 'Chromium split editor requests an app-style popup window');
  await modePage.waitForFunction(() => document.body.classList.contains('reader-only') && !window.readerMonaco);
  await openedEditor.waitForFunction(() => Boolean(window.mewWorkbench?.documents?.has('1/ME01-001.html')));
  await modePage.locator('#combinedViewBtn').click();
  await modePage.waitForFunction(() => !document.body.classList.contains('reader-only') && Boolean(window.readerMonaco));
  assert.equal(await modePage.locator('.text-pane').isVisible(), true, 'combined reader mode can be restored');
  await openedEditor.close(); await modePage.close();
  console.log('reader: split button and combined-mode restoration passed');
} finally {
  await browser?.close();
  await Promise.all(servers.map(child => new Promise(resolve => {
    if (child.exitCode != null) return resolve();
    child.once('exit', resolve); child.kill();
  })));
  // Only the unique temporary directory created above is removed.
  if (path.dirname(fixture) === path.resolve(tmpdir()) && path.basename(fixture).startsWith('mew-doc-browser-')) await rm(fixture, { recursive: true, force: true });
}
