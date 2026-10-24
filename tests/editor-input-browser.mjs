import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchBrowser, startServer, stopServer } from './support/browser.mjs';

const fixture = await mkdtemp(path.join(tmpdir(), 'mew-input-'));
const original = '<p>Typing preserves the current document and its undo history.</p>\r\n'.repeat(2000);
await writeFile(path.join(fixture, 'a.html'), original);
let server, browser;
try {
  server = await startServer('server.js', 41879, ['-r', fixture]);
  browser = await launchBrowser();
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://127.0.0.1:41879/?file=a.html');
  await page.waitForFunction(() => window.mewWorkbench?.editor.getModel());
  await page.evaluate(() => {
    const editor = mewWorkbench.editor;
    editor.setPosition({ lineNumber: 1, column: 4 }); editor.focus();
  });
  await page.keyboard.type('x');
  await page.waitForFunction(() => document.querySelector('#fileName').textContent.endsWith(' *'));
  await page.evaluate(() => { window.typingTab = document.querySelector('#tabs .tab.active'); });
  await page.keyboard.type('abcdef', { delay: 140 });
  assert.equal(await page.evaluate(() => typingTab === document.querySelector('#tabs .tab.active')), true, 'continued typing retains tab DOM and scroll position');
  await page.keyboard.press('Control+s');
  await page.waitForFunction(() => !document.querySelector('#fileName').textContent.endsWith(' *'));
  assert.match(await readFile(path.join(fixture, 'a.html'), 'utf8'), /xabcdef/);
  await page.evaluate(() => mewWorkbench.editor.pushUndoStop());
  await page.keyboard.type('z');
  await page.waitForFunction(() => document.querySelector('#fileName').textContent.endsWith(' *'));
  await page.keyboard.press('Control+z');
  await page.waitForFunction(() => !document.querySelector('#fileName').textContent.endsWith(' *'));
  assert.deepEqual(errors, []);
  console.log(`Real Monaco: paced typing retains tabs; dirty state, save and undo passed (${Buffer.byteLength(original)} bytes HTML).`);
} finally {
  await browser?.close();
  await stopServer(server);
  await rm(fixture, { recursive: true, force: true });
}
