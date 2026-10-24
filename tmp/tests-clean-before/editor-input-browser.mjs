import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const fixture = await mkdtemp(path.join(tmpdir(), 'mew-input-'));
const original = '<p>Typing preserves the current document and its undo history.</p>\r\n'.repeat(2000);
await writeFile(path.join(fixture, 'a.html'), original);
const server = spawn(process.execPath, ['server.js', '-p', '41879', '-r', fixture], { windowsHide: true, stdio: 'pipe' });
let browser;
try {
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch('http://127.0.0.1:41879/')).ok) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  browser = await chromium.launch({ executablePath: process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: true });
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
  server.kill();
  await new Promise(resolve => server.exitCode !== null ? resolve() : server.once('exit', resolve));
  await rm(fixture, { recursive: true, force: true });
}
