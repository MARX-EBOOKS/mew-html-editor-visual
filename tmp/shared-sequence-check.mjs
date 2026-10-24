import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { performance } from 'node:perf_hooks';
import { engine } from '../tests/support/pdf-harness.mjs';
const api = engine(), window = {};
vm.runInNewContext(await readFile(new URL('./shared-sequence-before/pdf-selection-diff.js', import.meta.url), 'utf8'), { window });
const pages = [], styles = [false, true, null].map(bold => ({ name: 'Times', bold, italic: false }));
let raw = '';
for (let p = 0; p < 200; p++) {
  const start = raw.length, parts = [];
  for (let i = 0; i < 100; i++) {
    const start = raw.length;
    raw += 'word𠀀 ';
    parts.push({ start, end: raw.length - 1, item: { str: 'word𠀀' }, font: styles[i % 3] });
  }
  pages.push({ start, end: raw.length, parts });
  raw += '\n';
}
const before = new window.PdfSelectionDiff.PdfSourceIndex(null, { raw, pages });
const after = new api.PdfSourceIndex(null, { raw, pages });
assert.equal(after.parts[100], pages[1].parts[0]);
for (let i = 0; i < 300; i++) {
  const start = (i * 173) % raw.length, end = Math.min(raw.length, start + i % 70);
  assert.equal(JSON.stringify(after.fontRuns(start, end)), JSON.stringify(before.fontRuns(start, end)));
}
pages[1].parts[0].font = { name: 'Updated', bold: true, italic: true };
assert.equal(after.fontRuns(pages[1].start, pages[1].parts[0].end)[0].name, 'Updated');
assert.equal(new api.PdfSourceIndex(null, { raw: '' }).fontRuns().length, 0);
const measure = index => {
  const start = performance.now();
  for (let i = 0; i < 2000; i++) index.fontRuns(70001 + i % 100, 70090 + i % 100);
  return performance.now() - start;
};
measure(before); measure(after);
const oldMs = measure(before), newMs = measure(after);
console.log(JSON.stringify({ rangeParity: 300, sharesParts: true, lateFontsVisible: true, syntheticRangeLookup: { beforeMs: oldMs, afterMs: newMs } }));
const baseline = await readFile(new URL('./shared-sequence-baseline.tap', import.meta.url), 'utf8');
const current = await readFile(new URL('./shared-sequence-after.tap', import.meta.url), 'utf8');
const failures = text => new Set([...text.matchAll(/^✖ (.*?) \([\d.]+ms\)/gm)].map(match => match[1]));
const oldFailures = failures(baseline), newFailures = failures(current);
assert.ok(oldFailures.size > 0 && newFailures.size > 0);
assert.deepEqual([...newFailures].filter(name => !oldFailures.has(name)), []);
console.log(JSON.stringify({ baselineFailures: oldFailures.size, currentFailures: newFailures.size, fixed: [...oldFailures].filter(name => !newFailures.has(name)) }));
