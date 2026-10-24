import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { cpus } from 'node:os';
import { engine } from './support/pdf-harness.mjs';

const iterations = Number(process.env.BENCH_ITERATIONS || 30);
assert.ok(Number.isInteger(iterations) && iterations >= 5, 'BENCH_ITERATIONS must be an integer >= 5');
const api = engine();
const rows = [];
for (const name of (await readdir(new URL('./fixtures/', import.meta.url))).sort()) {
  if (!name.endsWith('.json')) continue;
  const data = JSON.parse(await readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
  for (const [at, fixture] of (Array.isArray(data) ? data : [data]).entries()) {
    assert.equal(typeof fixture.html, 'string', `${name}: missing source HTML`);
    assert.ok(typeof fixture.layerRaw === 'string' || fixture.pages?.length, `${name}: missing OCR data`);
    const samples = [];
    let hunks = 0, ocrBytes = 0;
    // Warm up the actual source-index and OCR mapping path, then measure fresh indexes.
    for (let iteration = -3; iteration < iterations; iteration++) {
      const locator = new api.PdfLocator({}, { document: { createElement: () => ({}) },
        isCurrent: () => true, waitForIdle: async () => {} });
      const start = performance.now();
      const source = locator.sourceIndex(fixture.html);
      const target = typeof fixture.layerRaw === 'string' ? locator.sourceIndex(fixture.layerRaw)
        : await locator.indexDocument({ numPages: fixture.pages.length, async getPage(n) {
          const page = fixture.pages[n - 1];
          const items = page.items || [{ str: typeof page === 'string' ? page : page.raw,
            transform: [1, 0, 0, 1, 0, 10], width: 500, height: 10 }];
          return { getTextContent: async () => ({ items }) };
        } });
      source.sourcePageScope(target, true);
      const pairs = (source.connections.get(target) || []).map(connection => [connection, target]);
      const marks = source.sourceDecorations(pairs, { getPositionAt: offset => ({ lineNumber: 1, column: offset + 1 }) });
      const elapsed = performance.now() - start;
      assert.ok(pairs.length, `${name}: no source/PDF mappings`);
      for (const [connection] of pairs) {
        const diff = source.connectionDiff(target, connection);
        assert.ok(diff, `${name}: mapped passage exceeds the comparison budget`);
        assert.equal(diff.parts.map(part => part.html).join(''), source.raw.slice(connection.start, connection.end));
        assert.equal(diff.parts.map(part => part.pdf).join(''), target.raw.slice(connection.targetStart, connection.targetEnd));
      }
      hunks = marks.length; ocrBytes = Buffer.byteLength(target.raw);
      if (iteration >= 0) samples.push(elapsed);
    }
    samples.sort((a, b) => a - b);
    rows.push({ fixture: name.replace('.json', '') + (Array.isArray(data) ? `/${at + 1}` : ''),
      htmlBytes: Buffer.byteLength(fixture.html), ocrBytes, hunks,
      p50Ms: +samples[Math.floor(samples.length * 0.5)].toFixed(3),
      p95Ms: +samples[Math.ceil(samples.length * 0.95) - 1].toFixed(3),
      maxMs: +samples.at(-1).toFixed(3) });
  }
}
assert.ok(rows.length, 'No real OCR fixtures were benchmarked');
console.table(rows);
const report = { node: process.version, platform: process.platform, cpu: cpus()[0]?.model, iterations, warmup: 3, rows };
const output = process.argv[2];
if (output) await writeFile(output, JSON.stringify(report, null, 2) + '\n');
