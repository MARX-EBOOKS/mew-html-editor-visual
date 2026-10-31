import assert from 'node:assert/strict';
import { launchBrowser, startServer, stopServer } from './support/browser.mjs';

const port = 17049;
const server = await startServer('reader-server.js', port);
let browser;
try {
  browser = await launchBrowser();
  for (const [entry, value] of ['?mode=source', 'index.html?readerSession=scale-test'].flatMap(entry => [1.3, undefined, null, ''].map(value => [entry, value]))) {
    const context = await browser.newContext();
    const page = await context.newPage();
    let settings = { brightness: 115, ...(value === undefined ? {} : { editorScale: value, tagScale: value }) };
    const writes = [];
    await page.addInitScript(() => {
      for (const key of ['readerDockPanels.v1', 'mewMonacoTagPanel.v1']) localStorage.setItem(key, JSON.stringify({ editorScale: 1.5, scale: 1.5 }));
      localStorage.setItem('readerPdfSettings.v1', JSON.stringify({ brightness: 80 }));
    });
    await page.route('**/api/reader/settings', route => {
      if (route.request().method() === 'PUT') {
        const patch = route.request().postDataJSON();
        writes.push(patch);
        settings = { ...settings, ...patch };
      }
      return route.fulfill({ json: settings });
    });
    await page.goto(`http://127.0.0.1:${port}/${entry}`);
    const expected = value === 1.3 ? 1.3 : 1;
    await page.waitForFunction(scale => (window.ReaderUI || window.MewEditorUI)?.editorScale() === scale, expected);
    if (entry.startsWith('?')) assert.equal(await page.locator('#brightness').inputValue(), '115', 'server display settings override stale browser settings');
    for (const target of ['editor', 'tag']) {
      const input = page.locator(`[data-scale-input="${target}"]`);
      assert.equal(await input.inputValue(), `${Math.round(expected * 100)}%`);
      assert.equal(writes.filter(patch => `${target}Scale` in patch).length, 0, 'loading must not overwrite the server preference');
      await input.fill('120%');
      const saved = page.waitForResponse(response => response.url().endsWith('/api/reader/settings') && response.request().method() === 'PUT');
      await input.press('Enter');
      await saved;
      assert.equal(settings[`${target}Scale`], 1.2);
    }
    await page.reload();
    await page.waitForFunction(() => (window.ReaderUI || window.MewEditorUI)?.editorScale() === 1.2);
    for (const target of ['editor', 'tag']) assert.equal(await page.locator(`[data-scale-input="${target}"]`).inputValue(), '120%');
    await context.close();
  }
  console.log('Combined and divided window scales: server restore, missing/invalid fallback, save and reload passed; server display settings override browser storage.');
} finally {
  await browser?.close();
  await stopServer(server);
}
