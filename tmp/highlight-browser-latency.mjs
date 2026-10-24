import { readFile } from 'node:fs/promises';
import { engineSource } from '../tests/support/pdf-harness.mjs';
import { launchBrowser, startServer, stopServer } from '../tests/support/browser.mjs';
const server = await startServer('reader-server.js', 41892, ['-c', '../MEW_BRIEF/.mew-reader.json']);
const browser = await launchBrowser();
try {
  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:41892/monaco/min/vs/loader.js');
  await page.setContent('<div id="editor" style="height:800px;width:1000px"></div>');
  await page.addScriptTag({ url: '/monaco/min/vs/loader.js' });
  await page.evaluate(() => new Promise(resolve => { require.config({ paths: { vs: '/monaco/min/vs' } }); require(['vs/editor/editor.main'], resolve); }));
  await page.addScriptTag({ content: engineSource });
  for (const file of ['tmp/me23-011-fixture.json', 'tests/fixtures/pdf-selection-me23.json']) {
    const fixture = JSON.parse(await readFile(file, 'utf8'));
    console.log(file, JSON.stringify(await page.evaluate(async fixture => {
      const { PdfLocator, PdfSourceIndex } = PdfReviewProvider;
      const costs = {};
      for (const [proto, names] of [[PdfSourceIndex.prototype, ['sourcePageScope', 'rememberConnection', 'normalizedRange', 'connectionDiff', 'sourceDecorations', 'formatDifferences', 'matches']], [PdfLocator.prototype, ['sourceIndex', 'prepareSource']]])
        for (const name of names) {
          const original = proto[name];
          proto[name] = function (...args) { const start = performance.now(); try { return original.apply(this, args); } finally { costs[name] = (costs[name] || 0) + performance.now() - start; } };
        }
      const samples = [], editor = monaco.editor.create(document.getElementById('editor'), { value: fixture.html, language: 'html', automaticLayout: false });
      const collection = editor.createDecorationsCollection(), model = editor.getModel();
      let count, first;
      for (let iteration = 0; iteration < 35; iteration++) {
        const locator = new PdfLocator({}, { document, isCurrent: () => true, waitForIdle: async () => {} });
        const full = await locator.indexDocument({ numPages: fixture.pages.length, getPage: async n => ({ getTextContent: async () => ({ items: fixture.pages[n-1].items || [{ str: fixture.pages[n-1], transform: [1,0,0,1,0,10], width: 500, height: 10 }] }) }) });
        const targets = full.pages.map(p => new PdfSourceIndex(locator, { raw: full.raw.slice(p.start, p.end) }));
        // The PDF text is ready; include fresh HTML indexing, all mappings and Monaco application.
        const start = performance.now(), index = locator.sourceIndex(fixture.html);
        locator.prepareSource(index, targets, {});
        const marks = index.sourceDecorations(index.connectionPairs(targets), model);
        collection.set(marks);
        editor.render(true);
        const ms = performance.now() - start;
        count = marks.length;
        if (!iteration) first = ms;
        samples.push(ms);
        await new Promise(requestAnimationFrame);
      }
      editor.dispose(); model.dispose();
      samples.sort((a,b) => a-b);
      return { first, p50: samples[17], p95: samples[33], max: samples[34], count, htmlBytes: new TextEncoder().encode(fixture.html).length, costs };
    }, fixture)));
  }
} finally { await browser.close(); await stopServer(server); }
