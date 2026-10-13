// Isolated VS Code integration benchmark. Does not install into the user's profile.
// node test/pdf-vscode.mjs <absolute PDF path>
import { _electron } from "playwright";
import { mkdtemp, readFile, writeFile, symlink, mkdir, copyFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const root = fileURLToPath(new URL("..", import.meta.url));
const fixture = await mkdtemp(path.join(tmpdir(), "mew-pdf-vscode-"));
const dev = path.join(fixture, "extension");
await mkdir(dev);
for (const file of ["package.json", "reader-core.cjs", "reader-pdf.css", "pdf-source.mjs", "pdf-worker.mjs"]) await copyFile(path.join(root, file), path.join(dev, file));
for (const dir of ["vendor", "media"]) await symlink(path.join(root, dir), path.join(dev, dir), "junction");
const testManifest = JSON.parse(await readFile(path.join(dev, 'package.json'), 'utf8'));
testManifest.contributes.keybindings.push({ key: 'f8', command: 'mewTest.reload' }, { key: 'f9', command: 'mewTest.restartHost' });
await writeFile(path.join(dev, 'package.json'), JSON.stringify(testManifest));
let extension = await readFile(path.join(root, "extension.cjs"), "utf8");
extension = extension.replace('function activate(context) {', `function activate(context) {
  context.subscriptions.push(vscode.commands.registerCommand('mewTest.reload', () => vscode.commands.executeCommand('workbench.action.reloadWindow')));
  context.subscriptions.push(vscode.commands.registerCommand('mewTest.restartHost', () => vscode.commands.executeCommand('workbench.action.restartExtensionHost')));
  if (!context.globalState.get('test.opened')) {
    context.globalState.update('test.opened', true);
    setTimeout(() => vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(${JSON.stringify(path.resolve(process.argv[2]))}), 'mewReader.pdf').then(() => ${process.env.PDF_AUX ? "vscode.commands.executeCommand('workbench.action.moveEditorToNewWindow')" : 'undefined'}), 800);
  }`);
extension = extension.replace('pageLabel: "1"', 'pageLabel: "300"');
await writeFile(path.join(dev, "extension.cjs"), extension);
let script = await readFile(path.join(root, process.env.PDF_BASELINE ? "test/artifacts/reader-pdf-before.js" : "reader-pdf.js"), "utf8");
script = script.replace("const eventBus = new pdfview.EventBus();", `const eventBus = new pdfview.EventBus();
  window.__renders = [];
  eventBus.on('pagerendered', e => window.__renders.push({ page: e.pageNumber, ms: performance.now(), error: e.error?.message }));`);
script += "\nwindow.__reader = { get viewer() { return viewer; }, get worker() { return config.pdfWorker?.port; }, loadPdf, get pending() { return pending; } };";
script = script.replace('const vscode = acquireVsCodeApi();', 'window.__generation = Math.random(); window.__timings = { script: performance.now() }; const vscode = acquireVsCodeApi();')
  .replace('async function loadPdf(message) {', 'async function loadPdf(message) { window.__handshakes = (window.__handshakes || 0) + 1; window.__timings.load = performance.now();')
  .replace('loadingTask = config.pdfjs.getDocument({', 'window.__timings.source = performance.now(); loadingTask = config.pdfjs.getDocument({')
  .replace('const document = await loadingTask.promise;', 'const document = await loadingTask.promise; window.__timings.document = performance.now();')
  .replace('vscode.postMessage({ type: "ready", document: stored.document });', 'window.__timings.ready = performance.now(); vscode.postMessage({ type: "ready", document: stored.document });');
await writeFile(path.join(dev, "reader-pdf.js"), script);
await mkdir(path.join(fixture, "user", "User"), { recursive: true });
await writeFile(path.join(fixture, "user", "User", "settings.json"), JSON.stringify({
  "workbench.startupEditor": "none", "window.restoreWindows": "none", "update.mode": "none",
  "security.workspace.trust.enabled": false, "telemetry.telemetryLevel": "off"
}));
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const app = await _electron.launch({ executablePath: process.env.VSCODE_EXE || "D:\\Program Files\\Microsoft VS Code\\Code.exe", env,
  args: ["--no-sandbox", "--skip-welcome", "--skip-release-notes", "--disable-workspace-trust",
    `--user-data-dir=${path.join(fixture, 'user')}`, `--extensions-dir=${path.join(fixture, 'extensions')}`, `--extensionDevelopmentPath=${dev}`],
  timeout: 60000 });
try {
  let win = await app.firstWindow();
  win.on('console', message => { if (/fake worker|ICCBased|wasm|Worker|fetch/i.test(message.text())) console.log(message.type(), message.text()); });
  let frame;
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    frame = win.frames().find(f => f.url().includes("vscode-webview") && !f.url().includes("fake.html"));
    // The HTML itself is in an inner iframe, under the webview preload frame.
    for (const page of app.windows()) for (const candidate of page.frames()) {
      if (await candidate.evaluate(() => !!window.__reader).catch(() => false)) { win = page; frame = candidate; break; }
    }
    if (frame && await frame.evaluate(() => !!window.__reader).catch(() => false)) break;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert.ok(frame, "PDF webview frame opened");
  await frame.waitForFunction(() => {
    const v = window.__reader?.viewer;
    return v?.pdfDocument && document.querySelector("#pageNumber").value === "300" && window.__renders.some(e => e.page === v.currentPageNumber);
  }, null, { timeout: 60000 });
  const result = await frame.evaluate(() => {
    const v = window.__reader.viewer;
    return { pages: v.pagesCount, page: v.currentPageNumber, label: document.querySelector("#pageNumber").value,
      startupToTargetMs: Math.round(window.__renders.find(e => e.page === v.currentPageNumber).ms),
      loadedPages: v._pages.filter(p => p.pdfPage).length,
      realWorker: window.__reader.worker instanceof Worker,
      timings: window.__timings,
      slowResources: performance.getEntriesByType('resource').filter(r => r.duration > 500).map(r => ({ url: r.name, ms: Math.round(r.duration) })),
      errors: window.__renders.filter(e => e.error) };
  });
  assert.deepEqual(result.errors, []);
  if (!process.env.PDF_BASELINE) {
    assert.equal(result.realWorker, true);
    assert.ok(result.startupToTargetMs < 5000, `Target page took ${result.startupToTargetMs} ms`);
    assert.ok(result.loadedPages < 20);
  }
  console.log(JSON.stringify({ file: process.argv[2], mode: process.env.PDF_BASELINE ? "before" : "after", ...result, fixture }));
  if (await frame.locator('#copyImage').count()) {
    await frame.locator('#copyImage').click();
    await frame.waitForFunction(() => !document.querySelector('#copyImage').disabled);
    assert.equal(await frame.locator('#copyImage').textContent(), '已复制');
    const size = await app.evaluate(({ clipboard }) => clipboard.readImage().getSize());
    assert.ok(size.width > 0 && size.height > 0);
    console.log(JSON.stringify({ clipboardImage: size }));
    const original = await app.evaluate(({ clipboard }) => clipboard.readImage().toPNG().toString('base64'));
    await frame.locator('#zoom').fill('50%'); await frame.locator('#zoom').press('Enter');
    await frame.locator('#settings').click();
    await frame.locator('#invert').check();
    await frame.locator('#settingsDialog button[aria-label="关闭"]').click();
    await frame.locator('#copyImage').click();
    await frame.waitForFunction(() => !document.querySelector('#copyImage').disabled);
    assert.equal(await frame.locator('#copyImage').textContent(), '已复制');
    assert.equal(await app.evaluate(({ clipboard }) => clipboard.readImage().toPNG().toString('base64')), original,
      'embedded image pixels are unchanged by zoom and display inversion');
    await frame.locator('#zoom').fill('页宽'); await frame.locator('#zoom').press('Enter');
  }
  await win.screenshot({ path: path.join(root, "test", "artifacts", `vscode-${path.basename(process.argv[2])}-${process.env.PDF_BASELINE ? 'before' : 'after'}.png`) });
  const start = Date.now();
  await frame.locator("#next").click();
  await frame.waitForFunction(n => window.__renders.some(e => e.page === n), result.page + 1);
  console.log(`Next page: ${Date.now() - start} ms`);
  await frame.evaluate(() => {
    const document = window.__reader.viewer.pdfDocument;
    window.__oldDocument = document;
    window.__reader.loadPdf({ ...window.__reader.pending, pageLabel: '300' });
  });
  await frame.waitForFunction(() => document.querySelector('#pageNumber').value === '300');
  assert.equal(await frame.evaluate(() => window.__reader.viewer.pdfDocument === window.__oldDocument), true);
  await frame.locator("#zoom").fill("100%"); await frame.locator("#zoom").press("Enter");
  await frame.waitForFunction(() => window.__reader.viewer.currentScale === 1);
  assert.equal(await frame.locator("#zoom").inputValue(), "100%", "PDF.js scale 1 is displayed as 100%");
  await frame.locator("#direction").click();
  await frame.waitForFunction(() => window.__reader.viewer.scrollMode === 1);
  await frame.locator('#settings').click();
  await frame.locator('#invert').check();
  assert.equal(await frame.locator('#invert').isChecked(), true);
  await frame.locator('#settingsDialog button[aria-label="关闭"]').click();
  await frame.locator('#next').click();
  await frame.waitForFunction(() => document.querySelector('#pageNumber').value === '301');
  const restored = frame;
  const previousHost = await restored.evaluate(() => ({ count: window.__handshakes, generation: window.__generation }));
  await win.keyboard.press('F9');
  const hostStart = Date.now();
  let hostRestored;
  while (Date.now() - hostStart < 30000) {
    for (const candidate of win.frames()) {
      const ready = await candidate.evaluate(() => ({ count: window.__handshakes || 0, generation: window.__generation,
        rendered: !!window.__reader?.viewer?.pdfDocument && window.__renders.some(e => e.page === window.__reader.viewer.currentPageNumber) })).catch(() => null);
      if (ready?.rendered && (candidate !== restored || ready.generation !== previousHost.generation || ready.count > previousHost.count)) { hostRestored = candidate; break; }
    }
    if (hostRestored) break;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  if (!hostRestored) for (const candidate of win.frames()) console.log(await candidate.evaluate(() => ({ url: location.href, status: document.querySelector('#status')?.textContent, handshakes: window.__handshakes, timings: window.__timings, generation: window.__generation, previousHost: null })).catch(() => null));
  assert.ok(hostRestored, 'PDF reconnects after Restart Extension Host without reopening');
  assert.equal(await hostRestored.locator('#invert').isChecked(), true);
  assert.equal(await hostRestored.locator('#pageNumber').inputValue(), '301');
  assert.equal(await hostRestored.locator('#zoom').inputValue(), '100%');
  assert.equal(await hostRestored.evaluate(() => window.__reader.viewer.scrollMode), 1);
  console.log(JSON.stringify({ auxiliary: !!process.env.PDF_AUX, restartExtensionHostMs: Date.now() - hostStart }));
  await writeFile(path.join(root, 'test', 'artifacts', `vscode-${path.basename(process.argv[2])}-${process.env.PDF_BASELINE ? 'before' : 'after'}.json`), JSON.stringify(result, null, 2));
} finally { await app.close(); }
