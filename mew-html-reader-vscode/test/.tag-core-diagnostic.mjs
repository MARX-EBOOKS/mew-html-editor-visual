import { _electron } from 'playwright';
import { mkdtemp, mkdir, copyFile, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('..', import.meta.url));
const fixture = await mkdtemp(path.join(tmpdir(), 'mew-floating-'));
const dev = path.join(fixture, 'extension');
await mkdir(dev);
for (const file of ['package.json', 'reader-core.cjs']) await copyFile(path.join(root, file), path.join(dev, file));
const resultPath = path.join(fixture, 'result.json');
let source = await readFile(path.join(root, 'extension.cjs'), 'utf8');
source = source.replace('function activate(context) {', `function activate(context) {
  setTimeout(async () => {
    const doc = await vscode.workspace.openTextDocument({ language: 'html', content: 'hello' });
    const editor = await vscode.window.showTextDocument(doc);
    editor.selection = new vscode.Selection(0, 0, 0, 5);
    vscode.workspace.onDidChangeTextDocument(e => {
      if (e.document === doc) require('node:fs').writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify({ text: doc.getText(), dirty: doc.isDirty }));
    });
    await vscode.commands.executeCommand('mewReader.openFloatingBar');
    require('node:fs').writeFileSync(${JSON.stringify(resultPath + '.ready')}, 'ready');
  }, 1500);`);
await writeFile(path.join(dev, 'extension.cjs'), source);
await mkdir(path.join(fixture, 'user', 'User'), { recursive: true });
await writeFile(path.join(fixture, 'user', 'User', 'settings.json'), JSON.stringify({
  'workbench.startupEditor': 'none', 'security.workspace.trust.enabled': false,
  'update.mode': 'none', 'telemetry.telemetryLevel': 'off', 'mewReader.autoOpenPdf': false
}));
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const app = await _electron.launch({ executablePath: 'D:\\Program Files\\Microsoft VS Code\\Code.exe', env,
  args: ['--no-sandbox', '--skip-welcome', '--skip-release-notes', `--user-data-dir=${path.join(fixture, 'user')}`,
    `--extensions-dir=${path.join(fixture, 'extensions')}`, `--extensionDevelopmentPath=${dev}`] });
try {
  let bar, floating;
  const deadline = Date.now() + 45000;
  while (!bar && Date.now() < deadline) {
    for (const win of app.windows()) for (const frame of win.frames()) {
      if (await frame.locator('button[data-id="b"]').count().catch(() => 0)) { bar = frame; floating = win; }
    }
    if (!bar) await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert.ok(bar, 'floating tag bar exists');
  assert.ok(app.windows().length >= 2, 'separate native window exists');
  await floating.waitForFunction(() => {
    const status = document.querySelector('.part.statusbar');
    return status && getComputedStyle(status).display === 'none' && !document.querySelector('.tabs-container .tab');
  });
  for (let i = 0; i < 100; i++) {
    if (await readFile(resultPath + '.ready', 'utf8').catch(() => '') === 'ready') break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(await readFile(resultPath + '.ready', 'utf8'), 'ready');
  const native = await app.browserWindow(floating);
  await floating.waitForFunction(() => document.title.includes('MEW 标签插入栏'));
  assert.equal(await native.evaluate(win => win.isMaximized()), false, 'new bar is a normal restored window');
  await native.evaluate(win => win.setAlwaysOnTop(true));
  await native.evaluate(win => { win.setPosition(150, 180); win.setSize(420, 320); });
  const bounds = await native.evaluate(win => win.getBounds());
  assert.equal(bounds.x, 150);
  assert.equal(bounds.y, 180);
  assert.ok(Math.abs(bounds.width - 420) <= 4, 'narrow window size (native frame rounding)');
  const mainWindow = app.windows().find(win => win !== floating);
  const mainNative = await app.browserWindow(mainWindow);
  await mainNative.evaluate(win => win.focus());
  await mainWindow.locator('.monaco-editor textarea').first().click({ force: true });
  await new Promise(resolve => setTimeout(resolve, 800));
  assert.equal(await mainNative.evaluate(win => win.isFocused()), true, 'pinned bar does not pull focus back');
  await mainNative.evaluate(win => win.focus());
  await mainWindow.locator('.monaco-editor textarea').first().focus();
  await mainWindow.keyboard.press('Control+a');
  await bar.locator('button[data-id="b"]').click();
  let result;
  for (let i = 0; i < 50; i++) {
    result = await readFile(resultPath, 'utf8').then(JSON.parse).catch(() => null);
    if (result) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(result?.text, '<b>hello</b>');
  assert.equal(result.dirty, true);
  await native.evaluate(win => win.setSize(720, 400));
  assert.ok(Math.abs((await native.evaluate(win => win.getBounds())).width - 720) <= 4);
  await bar.locator('button[data-type="showDockedBar"]').click();
  const main = await app.firstWindow();
  let dock;
  for (let i = 0; i < 100 && !dock; i++) {
    for (const frame of main.frames()) {
      if (await frame.locator('button[data-type="openFloatingBar"]').isVisible().catch(() => false)) dock = frame;
    }
    if (!dock) await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(dock, 'return button restores docked bar');
  assert.ok(floating.isClosed(), 'return button closes floating window');
  await dock.locator('button[data-type="openFloatingBar"]').click();
  await new Promise(resolve => setTimeout(resolve, 1200));
  assert.equal(await dock.locator('button[data-id="b"]').isVisible().catch(() => false), false,
    'docked bar is hidden while floating');
  console.log(JSON.stringify({ separateWindow: true, movable: true, resizable: true, compact: true,
    returnToDock: true, mutuallyExclusive: true, foregroundRecall: "not tested in this diagnostic", insertion: result }));
} finally { await app.close(); }
