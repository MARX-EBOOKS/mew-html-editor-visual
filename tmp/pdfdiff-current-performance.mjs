import { chromium } from 'playwright';
import { spawn, execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
const names = ['pdf-selection.js', 'pdf-selection-diff.js', 'pdf-review-provider.js', 'replacement-review.js'];
const refs = process.argv.slice(2).length ? process.argv.slice(2) : ['HEAD~2', 'HEAD', 'working'];
const versions = {};
for (const ref of new Set(refs)) versions[ref] = Object.fromEntries(await Promise.all(names.map(async name => [name, ref === 'working' ? await readFile(`public/pdfdiff/${name}`, 'utf8') : execFileSync('git', ['show', `${ref}:public/pdfdiff/${name}`], { encoding: 'utf8' })])));
const server = spawn(process.execPath, ['reader-server.js', '-p', '41891', '-c', '../MEW_BRIEF/.mew-reader.json'], { windowsHide: true, stdio: 'pipe' });
let browser;
try {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch('http://127.0.0.1:41891/api/reader/config')).ok) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  for (const ref of refs) {
    const context = await browser.newContext();
    const page = await context.newPage();
    const settings = JSON.parse(await readFile('reader.settings.json', 'utf8'));
    await page.route('**/api/reader/settings', route => route.fulfill({ json: settings }));
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.route('**/pdfdiff/*.js', route => {
      const source = versions[ref][new URL(route.request().url()).pathname.split('/').at(-1)];
      return source ? route.fulfill({ body: source, contentType: 'text/javascript' }) : route.continue();
    });
    await page.addInitScript(() => {
      window.sourceEvents = [];
      window.markEvents = [];
      const wrapped = new WeakSet();
      addEventListener('pdf-selection-sources', e => {
        window.lastSources = e.detail;
        if (e.detail.index && e.detail.targets.length) sourceEvents.push(performance.now());
        const editor = e.detail.editor;
        if (!editor?.createDecorationsCollection || wrapped.has(editor)) return;
        wrapped.add(editor);
        const create = editor.createDecorationsCollection.bind(editor);
        editor.createDecorationsCollection = (...args) => {
          const collection = create(...args), set = collection.set.bind(collection);
          collection.set = marks => { const result = set(marks); markEvents.push({ ms: performance.now(), count: marks.length }); return result; };
          return collection;
        };
      });
    });
    await page.goto('http://127.0.0.1:41891/?volume=7&page=129&mode=source');
    await page.waitForFunction(() => window.lastSources?.targets?.length && window.PdfSelection?.locator.getDocumentIndex(ReaderUI.getPdfViewer()?.pdfDocument), null, { timeout: 90000 });
    await page.waitForTimeout(500);
    const result = await page.evaluate(() => {
      const { index, targets, editor } = lastSources;
      const connections = targets.flatMap(target => (index.connections.get(target) || []).map(c => [c, target]));
      const bench = fn => { const times = []; let count; for (let i = 0; i < 30; i++) { const t = performance.now(); count = fn().length; times.push(performance.now() - t); } times.sort((a,b) => a-b); return { medianMs: times[15], count }; };
      return { readyMs: sourceEvents[0], firstAppliedMs: markEvents.find(e => e.count)?.ms, chars: index.raw.length, connections: connections.length,
        decorations: bench(() => PdfReviewProvider.sourceDecorations(index, connections, editor.getModel())),
        candidates: bench(() => PdfReviewProvider.reviewCandidates(index, targets)),
        fonts: bench(() => PdfSelectionDiff.formatDifferences(index, connections.map(([c,t]) => [c,t,PdfSelectionDiff.textDiff(index.raw.slice(c.start,c.end), t.raw.slice(c.targetStart,c.targetEnd),true)]))) };
    });
    console.log(JSON.stringify({ ref, ...result, errors }));
    await context.close();
  }
} finally { await browser?.close(); server.kill(); }
