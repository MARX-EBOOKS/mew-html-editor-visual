import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

async function engine(prefix) {
  const diff = await readFile(new URL(prefix + 'pdf-selection-diff.js', import.meta.url), 'utf8');
  const provider = await readFile(new URL(prefix + 'pdf-review-provider.js', import.meta.url), 'utf8');
  const mapping = provider.slice(provider.indexOf('// Source/PDF mapping and candidate generation.'),
    provider.indexOf('// Shared popup and session initialization.'));
  const window = { document: { createElement: () => ({}) } };
  vm.runInNewContext(diff + `\n(() => {
    const toolbox = window.PdfSelectionDiff;
    const { textDiff, significantText${prefix ? '' : ', PdfLocator, PdfSourceIndex'} } = toolbox;
    ${mapping}
    window.mapping = { PdfLocator, PdfSourceIndex, reviewCandidates };
  })();`, { window });
  return Object.assign(window.PdfSelectionDiff, window.mapping);
}
const before = await engine('baseline/'), after = await engine('');
const plain = value => JSON.parse(JSON.stringify(value));
let seed = 1307, checks = 0;
const random = max => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) % max);
const words = ['alpha', 'beta', 'Straße', 'ﬁne', '中文𠀀', 'gamma'];
for (let trial = 0; trial < 500; trial++) {
  const raw = Array.from({ length: 6 + random(16) }, () => words[random(words.length)]).join(' ');
  const at = random(raw.length), end = Math.min(raw.length, at + random(10));
  const replacement = random(2) ? 'new𠀁' : '';
  function run(api) {
    const locator = new api.PdfLocator({ wholeWords: trial % 2 === 0 });
    let text = raw, version = 1;
    const model = { getValue: () => text, getVersionId: () => version };
    const index = locator.editorSourceIndex(model), target = locator.sourceIndex(raw);
    const hit = { start: 0, end: raw.length };
    index.rememberConnection(0, raw.length, target, hit);
    target.rememberConnection(0, raw.length, index, hit);
    index.pageScopes.set(target, { scope: { start: 0, end: raw.length }, prepared: true });
    target.pageScopes.set(index, { scope: { start: 0, end: raw.length }, prepared: true });
    // Also exercise shifted and retained connections on either side of an edit.
    for (const [a, b] of [[0, at], [end, raw.length]]) if (a < b)
      index.rememberConnection(a, b, target, { start: a, end: b });
    text = raw.slice(0, at) + replacement + raw.slice(end); version++;
    const next = locator.editorSourceIndex(model, [target]);
    const entry = { text: raw.slice(at, end), before: raw.slice(0, at), after: raw.slice(end) };
    return {
      normalized: locator.normalized(text),
      located: target.locate(entry),
      forward: next.connections.get(target), reverse: target.connections.get(next),
      scope: next.pageScopes.get(target), reverseScope: target.pageScopes.get(next),
      candidates: api.reviewCandidates(next, [target]),
      rows: locator.comparisonRows({ html: raw, pdf: text })
    };
  }
  assert.deepEqual(plain(run(after)), plain(run(before)), `trial ${trial}`);
  checks++;
}
for (const name of ['pdf-selection-diff.js', 'pdf-review-provider.js']) {
  const snapshot = await readFile(new URL('baseline/' + name, import.meta.url), 'utf8');
  const production = await readFile(new URL('../../public/pdfdiff/' + name, import.meta.url), 'utf8');
  assert.equal(production, snapshot, `${name}: production changed`);
}
console.log(`${checks} parity scenarios passed; production source matches the saved baseline.`);
