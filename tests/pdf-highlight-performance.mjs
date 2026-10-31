// Manual real-page benchmark: node tests/pdf-highlight-performance.mjs [--cold] [--baseline=path] [--report=path]
// HTML snapshots: MEW_BRIEF; PDF text: original mew_band08/23.pdf, PyMuPDF sorted extraction.
// Default: PDF text indexing/model loading precede timing. --cold includes fresh editor/model/PDF text indices.
// Both modes load application scripts first; full reader navigation is a separate measurement.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { launchBrowser } from './support/browser.mjs';
import { engine, engineSource, diffSource, highlightSource } from './support/pdf-harness.mjs';

const fixtures = JSON.parse(await readFile(new URL('./fixtures/pdf-highlight-performance.json', import.meta.url), 'utf8'));
const stress = { ...fixtures.find(f => f.name === 'ME23-316'), name: 'ME23-316 + 220 controlled substitutions' };
// Generate stress input outside every browser realm so it cannot warm the measured code.
const locator = new (engine().PdfLocator)({}, { document: { createElement: () => ({}) } });
const index = locator.sourceIndex(stress.html), chars = stress.html.split('');
let changed = 0;
for (let at = 25; at < index.raw.length && changed < 220; at += 50) {
  while (at < index.raw.length && !/[a-zA-Z]/.test(index.raw[at])) at++;
  if (index.ends[at] - index.starts[at] !== 1) continue;
  chars[index.starts[at]] = index.raw[at] === 'q' ? 'z' : 'q'; changed++;
}
assert.equal(changed, 220);
stress.html = chars.join(''); fixtures.push(stress);
const cold = process.argv.includes('--cold');
const baseline = process.argv.find(a => a.startsWith('--baseline='));
const baselineSource = baseline && await readFile(baseline.slice(11), 'utf8');
const source = baseline ? engineSource.replace(diffSource, () => baselineSource) : engineSource;
const browser = await launchBrowser();
try {
  const results = [];
  for (const batch of cold ? fixtures.map(f => [f]) : [fixtures]) {
    const page = await browser.newPage();
    await page.route('http://highlight.test/**', async route => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<div id="editor" style="width:1000px;height:800px"></div>' });
      if (!pathname.startsWith('/monaco/') || pathname.includes('..')) return route.abort();
      return route.fulfill({ contentType: pathname.endsWith('.css') ? 'text/css' : 'text/javascript',
        body: await readFile(new URL('../node_modules/monaco-editor/' + pathname.slice(8), import.meta.url)) });
    });
    await page.goto('http://highlight.test/');
    await page.addScriptTag({ url: '/monaco/min/vs/loader.js' });
    await page.evaluate(() => new Promise(resolve => {
      require.config({ paths: { vs: '/monaco/min/vs' } }); require(['vs/editor/editor.main'], resolve);
    }));
    await page.addScriptTag({ content: source + '\n' + highlightSource });
    await page.evaluate(() => PdfSelectionDiff.ready);
    const rows = await page.evaluate(async ({ fixtures, cold }) => {
      const opened = performance.now();
      const rows = [], editor = monaco.editor.create(document.getElementById('editor'), {
        value: '', language: 'html', minimap: { enabled: false }, automaticLayout: false
      });
      const highlights = ReviewHighlights.create({ document });
      const create = editor.createDecorationsCollection.bind(editor);
      let collection;
      editor.createDecorationsCollection = (...args) => {
        const created = create(...args); collection ||= created; return created;
      };
      const stats = times => {
        const sorted = times.slice(1).sort((a,b) => a-b);
        return { first: times[0], p50: sorted[15], p95: sorted[28], max: Math.max(...times) };
      };
      for (const f of fixtures) {
        const locator = new PdfReviewProvider.PdfLocator({}, { document });
        const targets = f.pages.map(p => new PdfSelectionDiff.PdfSourceIndex(locator, { raw: p.raw }));
        editor.setValue(f.html); if (!cold) editor.render(true);
        const times = [], renderTimes = [];
        let marks, candidates;
        for (let round = 0; round < 31; round++) {
          const start = cold && !round ? opened : performance.now(), index = locator.sourceIndex(f.html);
          index?.diff(targets, {});
          const prepared = performance.now();
          highlights.updateSource(editor, [index], () => marks = index.sourceDecorations(index.reviewCandidates(null, true, false, true, [], index.connectionPairs(targets)), true, true, undefined, editor.getModel()),
            '.mew-ocr-diff-text{background:rgba(255,166,40,.3);border-bottom:1px solid #d58b24}.mew-ocr-diff-line{border-left:3px solid #d58b24}.mew-ocr-diff-insert{border-left:2px solid #d58b24}');
          editor.render(true);
          const end = performance.now();
          times.push(end-start); renderTimes.push(end-prepared);
          if (collection.length !== marks.length) throw new Error('Not all decorations were applied');
          candidates = index.reviewCandidates(null, false, true, true, targets);
          for (const candidate of candidates) {
            const segments = index.sourceSegments(candidate.sourceStart, candidate.sourceEnd);
            if (!segments.length) {
              const at = index.starts[candidate.sourceStart] ?? index.ends[candidate.sourceStart - 1] ?? 0;
              segments.push({ start: at, end: at });
            }
            for (const segment of segments) {
              const a = editor.getModel().getPositionAt(segment.start), b = editor.getModel().getPositionAt(segment.end);
              if (!marks.some(({range:r}) =>
                (r.startLineNumber < a.lineNumber || r.startLineNumber === a.lineNumber && r.startColumn <= a.column) &&
                (r.endLineNumber > b.lineNumber || r.endLineNumber === b.lineNumber && r.endColumn >= b.column)))
                throw new Error(`Missing highlight for ${f.name}: ${candidate.id}`);
            }
          }
          await new Promise(requestAnimationFrame);
        }
        rows.push({ name: f.name, bytes: new TextEncoder().encode(f.html).length,
          diffs: candidates.length, marks: marks.length, cold, total: stats(times), render: stats(renderTimes), signature: JSON.stringify(marks) });
      }
      highlights.dispose(); editor.dispose(); return rows;
    }, { fixtures:batch, cold });
    results.push(...rows);
    await page.close();
  }
  for (const row of results) {
    row.signature = createHash('sha256').update(row.signature).digest('hex');
  }
  console.log(JSON.stringify(results, null, 2));
  const report = process.argv.find(a => a.startsWith('--report='));
  if (report) await writeFile(report.slice(9), JSON.stringify(results, null, 2) + '\n');
  for (const row of results) {
    assert.ok(row.diffs >= (row.name.includes('controlled') ? 200 : row.bytes > 10000 ? 150 : 20), row.name);
    const measured = cold ? row.total.max : row.total.p95;
    if (!baseline) assert.ok(measured < (row.bytes > 10000 ? 50 : 10), `${row.name}: ${cold ? 'cold maximum' : 'p95'} ${measured} ms`);
  }
} finally { await browser.close(); }
