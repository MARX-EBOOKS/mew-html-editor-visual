import { engine } from '../tests/support/pdf-harness.mjs';
import { readFile, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
const fixture = JSON.parse(await readFile('tests/fixtures/pdf-selection-me23.json', 'utf8'));
const api = engine(), times = {}, samples = [];
for (const [proto, names] of [[api.PdfSourceIndex.prototype, ['sourcePageScope', 'rememberConnection', 'connectionDiff', 'sourceDecorations', 'formatDifferences', 'matches']], [api.PdfLocator.prototype, ['sourceIndex', 'prepareSource']]])
  for (const name of names) {
    const original = proto[name];
    proto[name] = function (...args) { const start = performance.now(); try { return original.apply(this, args); } finally { const row = times[name] ||= { calls: 0, ms: 0 }; row.calls++; row.ms += performance.now() - start; } };
  }
let result;
for (let i = 0; i < 25; i++) {
  const locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
  const targets = fixture.pages.map(page => locator.sourceIndex(typeof page === 'string' ? page : page.raw)), pdf = {};
  const start = performance.now(), index = locator.sourceIndex(fixture.html);
  locator.prepareSource(index, targets, pdf);
  const marks = index.sourceDecorations(index.connectionPairs(targets), { getPositionAt: offset => ({ lineNumber: 1, column: offset + 1 }) });
  samples.push(performance.now() - start);
  result = { marks: marks.length, pairs: index.connectionPairs(targets).length, htmlBytes: Buffer.byteLength(fixture.html), candidates: Array.from(index.reviewCandidates(targets), item => [item.sourceStart, item.sourceEnd, item.comparison]), decorations: JSON.parse(JSON.stringify(marks)) };
}
samples.sort((a,b) => a-b);
console.log(JSON.stringify({ p50: samples[12], p95: samples[23], max: samples[24], marks: result.marks, pairs: result.pairs, htmlBytes: result.htmlBytes, times }, null, 2));
if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify(result));
