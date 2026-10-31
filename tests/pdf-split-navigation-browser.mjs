import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { launchBrowser, startServer, stopServer } from './support/browser.mjs';

const fixture = await mkdtemp(path.join(tmpdir(), 'mew-split-navigation-'));
let server, browser;
try {
  await mkdir(path.join(fixture, '1'));
  await mkdir(path.join(fixture, '2'));
  await writeFile(path.join(fixture, '2/ME02-001.html'), '<p>Second volume</p>');
  for (const n of [1, 2, 3]) await writeFile(path.join(fixture, `1/ME01-00${n}.html`), `<p>Page ${n}</p>`);
  execFileSync('python', ['-c', 'import pymupdf,sys; d=pymupdf.open(); [d.new_page().insert_text((72,72), "Page " + str(n)) for n in range(1,4)]; d.save(sys.argv[1])', path.join(fixture, 'scan.pdf')]);
  await writeFile(path.join(fixture, 'config.json'), JSON.stringify({ volumes: [
    { id: '1', pdf: 'scan.pdf', pages: { directory: '1', pattern: '^ME01-([0-9]+)[.]html$' } },
    { id: '2', pdf: 'scan.pdf', pages: { directory: '2', pattern: '^ME02-([0-9]+)[.]html$' } }
  ] }));
  server = await startServer('reader-server.js', 41897, ['-c', path.join(fixture, 'config.json')]);
  browser = await launchBrowser();
  const context = await browser.newContext();
  await context.route('**/api/reader/settings', route => route.fulfill({ json: { diffHighlight: false, sourceDiffHighlight: false, selectionHighlight: false } }));
  const reader = await context.newPage();
  await reader.goto('http://127.0.0.1:41897/?volume=1&page=1&mode=source');
  await reader.waitForFunction(() => window.PdfSelection?.viewer?.pdfDocument && window.readerMonaco?.model);
  const popup = reader.waitForEvent('popup');
  await reader.locator('#splitViewBtn').click();
  const editor = await popup;
  await editor.waitForFunction(() => window.mewWorkbench?.editor.getModel());
  await editor.evaluate(() => mewWorkbench.openFile('1/ME01-002.html'));
  await reader.waitForFunction(() => PdfSelection.viewer.currentPageNumber === 2);
  console.log('HTML switch moves the actual PDF');

  // An unchanged PDF report while locate is pending must not cancel the switch.
  let release, entered;
  const held = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  await reader.route('**/api/reader/locate?**', async route => { entered(); await held; await route.continue(); });
  await editor.evaluate(() => mewWorkbench.openFile('1/ME01-003.html'));
  await started;
  await reader.evaluate(() => PdfSelection.viewer.eventBus.dispatch('pagechanging', { pageNumber: 2 }));
  await reader.waitForTimeout(300);
  release();
  await reader.waitForFunction(() => PdfSelection.viewer.currentPageNumber === 3, null, { timeout: 5000 });
  assert.equal(await editor.evaluate(() => mewWorkbench.editor.getModel().uri.path), '/1/ME01-003.html');
  console.log('Unchanged PDF report preserves pending HTML navigation');
  await reader.unroute('**/api/reader/locate?**');
  await reader.evaluate(() => { PdfSelection.viewer.currentPageNumber = 1; });
  await editor.waitForFunction(() => mewWorkbench.editor.getModel().uri.path === '/1/ME01-001.html');
  console.log('PDF navigation opens the corresponding HTML');

  let releaseStale, lookupStarted, lookupFinished;
  const stale = new Promise(resolve => { releaseStale = resolve; });
  const locating = new Promise(resolve => { lookupStarted = resolve; });
  const finished = new Promise(resolve => { lookupFinished = resolve; });
  await reader.route('**/api/reader/locate?**', async route => {
    lookupStarted(); await stale; await route.continue(); lookupFinished();
  });
  await editor.evaluate(() => mewWorkbench.openFile('1/ME01-002.html'));
  await locating;
  await reader.evaluate(() => { PdfSelection.viewer.currentPageNumber = 3; });
  await editor.waitForFunction(() => mewWorkbench.editor.getModel().uri.path === '/1/ME01-003.html');
  releaseStale();
  await finished;
  await reader.waitForTimeout(300);
  assert.equal(await reader.evaluate(() => PdfSelection.viewer.currentPageNumber), 3);
  console.log('Actual PDF navigation cancels the older HTML lookup');
  await reader.unroute('**/api/reader/locate?**');
  await reader.evaluate(() => {
    const task = PdfSelection.viewer.pdfDocument.loadingTask;
    const destroy = task.destroy.bind(task);
    task.destroy = async () => {
      await destroy();
      await new Promise(resolve => { window.releasePdfCleanup = resolve; });
    };
  });
  await editor.evaluate(() => mewWorkbench.openFile('2/ME02-001.html'));
  await reader.waitForFunction(() => new URL(location.href).searchParams.get('volume') === '2'
    && PdfSelection.viewer.currentPageLabel === '1');
  await reader.waitForFunction(() => !!window.releasePdfCleanup);
  await reader.evaluate(() => releasePdfCleanup());
  await editor.evaluate(() => mewWorkbench.openFile('1/ME01-003.html'));
  await reader.waitForFunction(() => new URL(location.href).searchParams.get('volume') === '1'
    && PdfSelection.viewer.currentPageLabel === '3');
  console.log('Cross-volume HTML switches do not wait for old PDF teardown');
} finally {
  await browser?.close();
  await stopServer(server);
  if (path.dirname(fixture) === path.resolve(tmpdir()) && path.basename(fixture).startsWith('mew-split-navigation-')) await rm(fixture, { recursive: true, force: true });
}
