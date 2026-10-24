import assert from 'node:assert/strict';
import { launchBrowser } from '../tests/support/browser.mjs';
const browser = await launchBrowser();
try {
  for (const baseline of [true, false]) {
    const page = await browser.newPage();
    if (baseline) await page.route('**/reader-app.js', async route => {
      const response = await route.fetch();
      const body = (await response.text()).replace(/    if \(!volume\) return;\r?\n    const index = volume.pages/, '    const index = volume.pages');
      await route.fulfill({ response, body });
    });
    let release, configs = 0;
    const gate = new Promise(resolve => { release = resolve; });
    await page.route('**/api/reader/page/**', async route => { await gate; await route.continue(); });
    const refresh = page.waitForResponse(response => response.url().endsWith('/api/reader/config') && ++configs === 2);
    await page.goto('http://localhost:17000/reader.html?volume=5&page=281&mode=source');
    await refresh;
    await page.waitForTimeout(300);
    const before = await page.locator('.statusbar').innerText();
    assert.equal(before.includes("reading 'pages'"), baseline, before);
    release();
    await page.waitForFunction(() => document.querySelector('.statusbar')?.textContent.includes('ME05-281.html'));
    if (!baseline) {
      const result = await page.evaluate(async () => {
        await window.PdfReviewReady;
        const index = new window.PdfReviewProvider.PdfSourceIndex(new window.PdfReviewProvider.PdfLocator());
        return [index.raw, index.normalized.text, index.parts.length, index.fontRuns().length];
      });
      assert.deepEqual(result, ['', '', 0, 0]);
    }
    console.log(baseline ? 'BASELINE reproduces pages error' : 'FIX passes startup race and empty index');
    await page.close();
  }
} finally { await browser.close(); }
