import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
const local = await readFile('public/pdfdiff/local-text-diff.js', 'utf8');
const engines = [];
const run = async (name, file) => {
  const window = {};
  vm.runInNewContext(local + await readFile(file, 'utf8'), { window });
  const api = window.PdfSelectionDiff;
  engines.push(api);
  const locator = api.createLocator({}, { document: { createElement: () => ({}) } });
  const raw = 'abcd efgh ijkl mnop qrst uvwx yz.\n'.repeat(200);
  const source = locator.sourceIndex(raw), pdf = {};
  const pages = Array.from({ length: 12 }, () => locator.sourceIndex(raw));
  for (const page of pages) {
    source.pageScopes.set(page, { prepared: true, scope: null });
    source.connections.set(page, Array.from({ length: 60 }, (_, i) => ({ start: i * 40, end: i * 40 + 30 })));
  }
  locator.prepareSource(source, pages, pdf);
  const t0 = performance.now();
  for (let i = 0; i < 100; i++) locator.prepareSource(source, pages, pdf);
  const preparation = performance.now() - t0;
  const text = 'a\n'.repeat(3000), index = locator.sourceIndex(text);
  const parts = Array.from({ length: 3000 }, () => [{ html: 'a', pdf: 'b', changed: true }, { html: '\n', pdf: '\n', changed: false }]).flat();
  const target = { raw: text.replaceAll('a', 'b') };
  index.connections.set(target, [{ start: 0, end: text.length, targetStart: 0, targetEnd: text.length, editorDiff: { parts } }]);
  const t1 = performance.now();
  const items = api.reviewCandidates(index, [target]);
  const candidates = performance.now() - t1;
  assert.equal(items.length, 3000);
  return { name, preparation100Ms: preparation, candidates3000Ms: candidates, items: JSON.parse(JSON.stringify(items)) };
};
const before = await run('before', 'tmp/pdf-selection-diff.before-perf.js');
const after = await run('after', 'public/pdfdiff/pdf-selection-diff.js');
assert.deepEqual(after.items, before.items);
for (const { items, ...result } of [before, after]) console.log(JSON.stringify(result));
let seed = 42;
const random = n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
for (let trial = 0; trial < 200; trial++) {
  const parts = Array.from({ length: 35 }, () => {
    const html = ['abc', '', '𠀀', '\n', ' foo ', 'xyz'][random(6)];
    const pdf = random(3) ? html : ['XYZ', '', '𠀀', '\n', 'bar'][random(5)];
    return { html, pdf, changed: html !== pdf };
  });
  const outputs = engines.map(api => {
    const locator = api.createLocator({}, { document: { createElement: () => ({}) } });
    const index = locator.sourceIndex(parts.map(part => part.html).join(''));
    const target = { raw: parts.map(part => part.pdf).join('') };
    index.connections.set(target, [{ start: 0, end: index.raw.length, targetStart: 0, targetEnd: target.raw.length, editorDiff: { parts } }]);
    return JSON.parse(JSON.stringify(api.reviewCandidates(index, [target])));
  });
  assert.deepEqual(outputs[1], outputs[0], `mixed insertion/deletion/Unicode projection trial ${trial}`);
}
console.log('200 mixed insertion/deletion/Unicode projection comparisons matched.');
