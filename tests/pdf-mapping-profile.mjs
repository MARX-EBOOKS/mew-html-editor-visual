// Extracted from tmp/highlight-latency.mjs; method costs include nested calls.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { cpus } from 'node:os';
import { engine } from './support/pdf-harness.mjs';

const iterations = Number(process.env.BENCH_ITERATIONS || 30);
assert.ok(Number.isInteger(iterations) && iterations >= 5, 'BENCH_ITERATIONS must be an integer >= 5');
const fixture = JSON.parse(await readFile(process.argv[2] || new URL('./fixtures/pdf-selection-me23.json', import.meta.url), 'utf8'));
assert.equal(typeof fixture.html, 'string', 'The profile needs an HTML/pages fixture');
assert.ok(fixture.pages?.length, 'The profile needs recorded PDF pages');
const api = engine(), methods = {}, samples = [];
let measuring = false;
for (const [proto, names] of [
  [api.PdfSourceIndex.prototype, ['diff', 'sourcePageScope', 'rememberConnection', 'connectionDiff', 'sourceDecorations', 'formatDifferences', 'matches', 'reviewCandidates']],
  [api.PdfLocator.prototype, ['sourceIndex']]
]) for (const name of names) {
  const original = proto[name];
  assert.equal(typeof original, 'function', `Profile method moved: ${name}`);
  proto[name] = function (...args) {
    if (!measuring) return original.apply(this, args);
    const start = performance.now();
    try { return original.apply(this, args); }
    finally {
      const row = methods[name] ||= { calls: 0, ms: 0 };
      row.calls++; row.ms += performance.now() - start;
    }
  };
}
let counts;
for (let iteration = -3; iteration < iterations; iteration++) {
  const locator = new api.PdfLocator({}, { document: { createElement: () => ({}) },
    isCurrent: () => true, waitForIdle: async () => {} });
  const full = await locator.indexDocument({ numPages: fixture.pages.length, async getPage(n) {
    const page = fixture.pages[n - 1];
    const items = page.items || [{ str: typeof page === 'string' ? page : page.raw,
      transform: [1, 0, 0, 1, 0, 10], width: 500, height: 10 }];
    return { getTextContent: async () => ({ items }) };
  } });
  const targets = full.pages.map(page => new api.PdfSourceIndex(locator, {
    raw: full.raw.slice(page.start, page.end),
    parts: page.parts.map(part => ({ ...part, start: part.start - page.start, end: part.end - page.start }))
  }));
  measuring = iteration >= 0;
  const start = performance.now(), index = locator.sourceIndex(fixture.html);
  index?.diff(targets, {});
  const pairs = index.connectionPairs(targets);
  const marks = index.sourceDecorations(index.reviewCandidates(null, true, false, true, [], pairs), true, true, undefined, { getPositionAt: offset => ({ lineNumber: 1, column: offset + 1 }) });
  const candidates = index.reviewCandidates(null, false, true, true, targets);
  const elapsed = performance.now() - start;
  measuring = false;
  assert.ok(pairs.length && marks.length && candidates.length, 'Profile must exercise mapped differences');
  for (const [connection, target] of pairs) {
    const diff = index.connectionDiff(target, connection);
    assert.ok(diff, 'Mapped passage exceeds the comparison budget');
    assert.equal(diff.parts.map(part => part.html).join(''), index.raw.slice(connection.start, connection.end));
    assert.equal(diff.parts.map(part => part.pdf).join(''), target.raw.slice(connection.targetStart, connection.targetEnd));
  }
  counts = { marks: marks.length, pairs: pairs.length, candidates: candidates.length };
  if (iteration >= 0) samples.push(elapsed);
}
samples.sort((a, b) => a - b);
const report = { node: process.version, platform: process.platform, cpu: cpus()[0]?.model,
  fixture: fixture.name || process.argv[2], iterations, warmup: 3, htmlBytes: Buffer.byteLength(fixture.html), ...counts,
  p50Ms: samples[Math.floor(samples.length * 0.5)], p95Ms: samples[Math.ceil(samples.length * 0.95) - 1],
  maxMs: samples.at(-1), methods };
console.log(JSON.stringify(report, null, 2));
if (process.argv[3]) await writeFile(process.argv[3], JSON.stringify(report, null, 2) + '\n');
