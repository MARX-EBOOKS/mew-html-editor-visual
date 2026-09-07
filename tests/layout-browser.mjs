import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const server = spawn(process.execPath, ['server.js', '-p', '41873', '-r', 'public'], { windowsHide: true, stdio: 'ignore' });
let browser;
try {
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch('http://127.0.0.1:41873')).ok) break; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  browser = await chromium.launch({ executablePath: process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('http://127.0.0.1:41873');
  await page.locator('#tagBar button').first().waitFor();
  const width = selector => page.locator(selector).evaluate(e => e.getBoundingClientRect().width);
  for (const [splitter, pane, dx] of [['#treeSplitter', '#explorerPane', 70], ['#previewSplitter', '#previewPane', -80]]) {
    const before = await width(pane);
    const rect = await page.locator(splitter).boundingBox();
    await page.mouse.move(rect.x + 3, rect.y + 100);
    await page.mouse.down();
    await page.mouse.move(rect.x + 3 + dx, rect.y + 100, { steps: 8 });
    await page.mouse.up();
    assert.ok(await width(pane) > before + 50);
  }
  const tree = await width('#explorerPane');
  await page.locator('#toolbarLarger').click();
  assert.equal(await page.locator('#toolbarReset').textContent(), '110%');
  await page.reload();
  assert.equal(await width('#explorerPane'), tree);
  assert.equal(await page.locator('#toolbarReset').textContent(), '110%');
  await page.locator('#treeSplitter').focus();
  await page.keyboard.press('ArrowLeft');
  assert.equal(await width('#explorerPane'), tree - 10);
  await page.locator('#layoutReset').click();
  assert.equal(await width('#explorerPane'), 220);
  assert.equal(await page.locator('#toolbarReset').textContent(), '100%');
  await page.locator('[data-tag-dock="floating"]').click();
  await page.locator('#toolbarLarger').click();
  await page.setViewportSize({ width: 1000, height: 700 });
  await page.waitForTimeout(150);
  assert.ok(await page.locator('#preview').isVisible());
  assert.ok(await width('.editorPane') >= 320);
  await page.locator('[data-tag-dock="top"]').click();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator('#layoutReset').click();
  await page.screenshot({ path: process.env.TEMP + '/mew-layout-light.png' });
  await page.locator('#darkBtn').click();
  await page.screenshot({ path: process.env.TEMP + '/mew-layout-dark.png' });
  assert.deepEqual(errors, []);
  console.log('PASS: pane drag, keyboard resize, toolbar zoom, persisted layout, reset, floating toolbar, responsive preview, light/dark rendering');
} finally {
  await browser?.close();
  server.kill();
}
