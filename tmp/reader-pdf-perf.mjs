import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const label = process.argv[2] || 'baseline';
const server = spawn(process.execPath, ['reader-server.js', '-p', '41885', '-c', '../MEW_BRIEF/.mew-reader.json'], { windowsHide: true, stdio: 'pipe' });
let browser;
try {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch('http://127.0.0.1:41885/api/reader/config')).ok) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  if (label === 'baseline') {
    const originalUi = execFileSync('git', ['show', 'HEAD:public/reader-ui.js'], { encoding: 'utf8' });
    await page.route('**/reader-ui.js', route => route.fulfill({ body: originalUi, contentType: 'text/javascript' }));
  }
  const settings = JSON.parse(await readFile('reader.settings.json', 'utf8'));
  await page.route('**/api/reader/settings', route => route.fulfill({ json: settings }));
  await page.addInitScript(() => {
    window.perfLongTasks = [];
    new PerformanceObserver(list => perfLongTasks.push(...list.getEntries().map(e => ({ start: e.startTime, duration: e.duration })))).observe({ type: 'longtask', buffered: true });
    window.perfGaps = [];
    let last = performance.now();
    setInterval(() => { const now = performance.now(); perfGaps.push(now - last); last = now; }, 20);
  });
  const session = await page.context().newCDPSession(page);
  await session.send('Performance.enable');
  const start = Date.now();
  await page.goto('http://127.0.0.1:41885/?volume=7&page=129&mode=source');
  await page.waitForFunction(() => readerMonaco?.editor && ReaderUI.getPdfViewer()?.getPageView(ReaderUI.getPdfViewer().currentPageNumber - 1)?.renderingState === 3 && PdfSelection?.viewer, null, { timeout: 60000 });
  const readyMs = Date.now() - start;
  await page.evaluate(() => {
    const e = readerMonaco.editor;
    // A long unsaved working copy exercises real Monaco scrolling without writing HTML.
    e.setValue(Array(12).fill(e.getValue()).join('\n'));
    e.setScrollTop(0);
  });
  await page.waitForTimeout(8000);
  const snapshot = async () => ({
    ...(await page.evaluate(() => {
      const v = ReaderUI.getPdfViewer();
      return { pages: v.pagesCount, current: v.currentPageNumber, cached: v.getCachedPageViews().size,
        canvasMB: [...document.querySelectorAll('#viewer canvas')].reduce((s, c) => s + c.width * c.height * 4, 0) / 1048576,
        textLayers: document.querySelectorAll('#viewer .textLayer').length,
        indexReady: !!PdfSelection.locator.getDocumentIndex(v.pdfDocument),
        longTasks: perfLongTasks.slice(), gaps: perfGaps.slice(), selectionStatus: PdfSelection.status.state };
    })),
    metrics: (await session.send('Performance.getMetrics')).metrics.filter(m => ['TaskDuration', 'JSHeapUsedSize', 'Nodes', 'LayoutCount'].includes(m.name))
  });
  const before = await snapshot();
  await page.evaluate(() => { perfLongTasks.length = 0; perfGaps.length = 0; });
  // Select a real paragraph so PDF comparison and linked highlights are active.
  await page.evaluate(() => {
    const e = readerMonaco.editor, m = e.getModel();
    const line = m.getLinesContent().findIndex(text => text.length > 180) + 1;
    e.setSelection({ startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: m.getLineMaxColumn(line) });
  });
  const editor = page.locator('#sourcePane .monaco-editor').first();
  for (let i = 0; i < 24; i++) {
    await editor.hover();
    await page.mouse.wheel(0, i % 12 < 6 ? 350 : -350);
    await page.waitForTimeout(70);
    await page.locator('#stage').hover();
    await page.mouse.wheel(0, i % 12 < 6 ? 560 : -560);
    await page.waitForTimeout(70);
  }
  await page.waitForTimeout(1500);
  const after = await snapshot();
  assert.equal(after.pages > 700, true);
  const editorHeight = await page.evaluate(() => ({ content: readerMonaco.editor.getScrollHeight(), viewport: readerMonaco.editor.getLayoutInfo().height }));
  assert.equal(editorHeight.content > editorHeight.viewport + 500, true, 'benchmark uses a scrollable Monaco working copy');
  if (label !== 'baseline') {
    await page.evaluate(() => {
      window.pdfReports = [];
      ReaderUI.init({ pdfPageChange: value => pdfReports.push(value.pageNumber) });
    });
    for (const number of [155, 160, 165]) {
      await page.evaluate(number => { ReaderUI.getPdfViewer().currentPageNumber = number; }, number);
      await page.waitForTimeout(40);
    }
    await page.waitForTimeout(500);
    assert.deepEqual(await page.evaluate(() => pdfReports), [165], 'rapid page changes only report the settled page');
    await page.evaluate(() => { ReaderUI.getPdfViewer().currentPageNumber = 152; });
    await page.waitForFunction(() => {
      const view = ReaderUI.getPdfViewer().getPageView(151);
      return view.renderingState === 3 && view.div.querySelector('.textLayer')?.textContent.length > 20;
    }, null, { timeout: 20000 });
    await page.evaluate(() => {
      const v = ReaderUI.getPdfViewer(), view = v.getPageView(151);
      const text = view.div.querySelector('.textLayer span').textContent;
      PdfSelection.highlight(text);
    });
    await page.waitForFunction(() => PdfSelection.status.matches > 0, null, { timeout: 20000 });
    await page.evaluate(() => PdfSelection.clear());
    await editor.hover();
    const oldTop = await page.evaluate(() => readerMonaco.editor.getScrollTop());
    await page.mouse.wheel(0, oldTop > 500 ? -500 : 500);
    await page.waitForTimeout(200);
    assert.notEqual(await page.evaluate(() => readerMonaco.editor.getScrollTop()), oldTop, 'Monaco still scrolls after PDF revisit and highlighting');
  }
  assert.deepEqual(errors, []);
  const summarize = s => ({ ...s, longTasks: { count: s.longTasks.length, total: s.longTasks.reduce((n,t) => n+t.duration,0), max: Math.max(0,...s.longTasks.map(t=>t.duration)) }, gaps: { max: Math.max(0,...s.gaps), over100: s.gaps.filter(g=>g>100).length } });
  const result = { label, readyMs, before: summarize(before), after: summarize(after), errors };
  await writeFile(`tmp/reader-pdf-${label}.json`, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally { await browser?.close(); server.kill(); }
