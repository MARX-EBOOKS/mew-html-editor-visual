import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { performance } from 'node:perf_hooks';

const before = await readFile(new URL('./pdf-provider-simplify-before.js', import.meta.url), 'utf8');
const after = await readFile(new URL('../public/pdfdiff/pdf-review-provider.js', import.meta.url), 'utf8');
const diff = await readFile(new URL('../public/pdfdiff/pdf-selection-diff.js', import.meta.url), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
function locator(code, options = {}, environment = {}) {
  const window = {};
  vm.runInNewContext(diff + '\n(() => {' + code.split('  // Source/PDF mapping and candidate generation.')[1]
    .split('  // Shared popup and session initialization.')[0] + '})();', { window });
  return window.PdfReviewProvider.createLocator(options, { document: { createElement: () => ({}) }, ...environment });
}
let seed = 5381;
const random = n => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) % n);
const words = ['alpha', 'beta', 'gamma', 'delta', '𠀀', 'Straße', 'ﬁne'];
let comparisons = 0;
for (const wholeWords of [false, true]) {
  const old = locator(before, { wholeWords }), current = locator(after, { wholeWords });
  for (let i = 0; i < 1200; i++) {
    const raw = Array.from({ length: 5 + random(40) }, () => words[random(words.length)]).join(' ');
    const start = random(raw.length), end = Math.min(raw.length, start + 3 + random(20));
    const entry = { text: raw.slice(start, end), before: raw.slice(Math.max(0, start - random(35)), start), after: raw.slice(end, end + random(35)) };
    if (i % 3 === 0) entry.text = entry.text.slice(0, 2) + 'x' + entry.text.slice(3);
    assert.deepEqual(plain(current.locate(raw, entry)), plain(old.locate(raw, entry)));
    comparisons++;
  }
}
for (let i = 0; i < 200; i++) {
  const boxes = Array.from({ length: random(30) }, () => {
    const top = random(300), height = random(20);
    return { left: random(500), top, bottom: top + height, height };
  });
  function anchor(code) {
    let visible;
    const api = locator(code, {}, { getVisiblePages: () => [{ index: visible }], document: {
      createElement: () => ({}), createRange: () => ({ setStart() {}, setEnd() {}, getClientRects: () => boxes })
    } });
    const source = api.sourceIndex('Alpha Beta');
    visible = api.sourceIndex('Alpha Beta');
    visible.layer = { isConnected: true, getBoundingClientRect: () => ({ left: 5, top: 10, width: 600, height: 800 }) };
    visible.parts = i % 7 ? [{ start: 0, end: 10, node: { length: 10 } }] : [];
    api.rememberConnection(source, 0, 10, visible, { start: 0, end: 10 });
    const item = { sourceStart: 6, sourceEnd: 10, pdfSource: { index: source, start: 6, end: 10 } };
    return [api.reviewAnchor(item, source), api.reviewAnchor(item, source)];
  }
  assert.deepEqual(plain(anchor(after)), plain(anchor(before)));
  comparisons++;
}
function privateFunction(code, name, next) {
  return code.slice(code.indexOf('  function ' + name + '('), code.indexOf('  function ' + next + '('));
}
for (let i = 0; i < 200; i++) {
  const text = Array.from({ length: random(15) }, (_, j) => ({ id: 't' + j, sourceStart: j * 5, sourceEnd: j * 5 + random(5) }));
  const formats = Array.from({ length: random(15) }, (_, j) => ({ id: 'f' + j, font: {}, sourceStart: j * 3, sourceEnd: j * 3 + random(5) }));
  function items(code) {
    const index = { starts: Array.from({ length: 100 }, (_, j) => j + 3), ends: Array.from({ length: 100 }, (_, j) => j + 4) };
    const fn = vm.runInNewContext('(' + privateFunction(code, 'reviewItems', 'selectionCandidate') + ')', {
      enabled: true, mapping: { reviewCandidates: () => structuredClone(text) }, selectionCandidate: () => null,
      formatItems: () => structuredClone(formats), toolbox: { rangeAt: (_, start, end) => ({ start, end }) }
    });
    return fn(index, [], null, {});
  }
  assert.deepEqual(plain(items(after)), plain(items(before)));
  comparisons++;
}
for (let i = 0; i < 200; i++) {
  const items = Array.from({ length: 1 + random(12) }, (_, j) => ({ id: String(j), key: random(3), sourceStart: j * 5,
    sourceEnd: j * 5 + 2, ...(random(2) ? { font: {} } : {}), options: [{ edits: [{ start: j * 5, end: j * 5 + 2, text: 'x'.repeat(random(5)) }] }] }));
  const all = !!random(2), position = random(items.length);
  function apply(code) {
    let source = 'a'.repeat(80), applied;
    const fn = vm.runInNewContext('(' + code.slice(code.indexOf('  function apply(state, all)'), code.indexOf('  const review =')) + ')', {
      getLocator: () => ({ prepareSource() {} }), pattern: value => value.key,
      formatItems: () => structuredClone(items.filter(item => item.font)),
      toolbox: { validateEdits: (_, edits) => edits.sort((a, b) => a.start - b.start), applyEdits: (_, model, version, oldSource, edits) => {
        applied = edits;
        for (const edit of [...edits].reverse()) source = source.slice(0, edit.start) + edit.text + source.slice(edit.end);
      } }, refreshCandidates: (context, offset) => ({ offset })
    });
    const context = { index: { starts: Array.from({ length: 80 }, (_, j) => j) }, targets: [] };
    const result = fn({ items: structuredClone(items), position, source, context, model: { getValue: () => source } }, all);
    return { applied, source, offset: result.offset };
  }
  assert.deepEqual(plain(apply(after)), plain(apply(before)));
  comparisons++;
}
for (let i = 0; i < 100; i++) {
  const patches = Array.from({ length: random(20) }, () => ({ patches: [[words[random(words.length)], words[random(words.length)]]] }));
  function patched(code) {
    const api = locator(code), target = {}, index = api.sourceIndex('');
    index.connections.set(target, patches);
    return api.patchedWords({ index, text: words.join(' ') }, target);
  }
  assert.deepEqual(plain(patched(after)), plain(patched(before)));
  comparisons++;
}
let oldReads = 0, newReads = 0;
for (const hasSource of [false, true]) for (const hasModel of [false, true])
  for (const changed of [false, true]) for (const stale of [false, true]) for (const font of [false, true]) {
    function difference(code) {
      const calls = [], pdf = {};
      let reads = 0;
      const host = { isOpenFor: () => true, openForSelection: (...args) => calls.push(['open', args[0], args[2]]), showNotice: () => calls.push(['notice']) };
      const model = hasModel ? { getValue() { reads++; return 'source'; } } : null;
      const editor = { getModel: () => model };
      const notice = { html: 'a', pdf: changed ? 'b' : 'a', ...(hasSource ? { source: { index: { source: stale ? 'stale' : 'source' }, start: 0, end: 1 } } : {}) };
      const fn = vm.runInNewContext('(' + privateFunction(code, 'onDifference', 'bind') + ')', {
        enabled: true, fontEnabled: true, listeningWindow: { ReplacementReview: host }, host, viewer: () => ({ pdfDocument: pdf }),
        dismissed: null, comparisonParts: value => [{ changed: value.html !== value.pdf }], comparisonCache: new WeakMap(),
        formatItems: () => font ? [{ id: 'font:0:1', sourceStart: 0, sourceEnd: 1 }] : [], comparisonRows: () => [], presentation: () => ({})
      });
      fn({ detail: { editor, pdf, notices: [notice] } });
      return { calls, reads };
    }
    const a = difference(before), b = difference(after);
    assert.deepEqual(plain(a.calls), plain(b.calls));
    assert.ok(b.reads <= a.reads);
    oldReads += a.reads; newReads += b.reads;
    comparisons++;
  }
console.log(`${comparisons} before/after comparisons passed (locate, geometry/cache, candidate ordering, mixed replacements, patches, event branches).`);
console.log(`Event source reads across branch matrix: before ${oldReads}, after ${newReads}.`);
const logs = await Promise.all(['baseline', 'after'].map(name => readFile(new URL(`./pdf-provider-simplify-${name}.log`, import.meta.url), 'utf8')));
const failures = logs.map(log => [...log.matchAll(/^✖ ([^\r\n]+?) \(/gm)].map(match => match[1]).sort());
assert.deepEqual(failures[1], failures[0]);
console.log('Existing suite failure names match the baseline exactly.');
const raw = ('alpha beta gamma delta ').repeat(3000), entry = { text: 'alpha', before: '', after: '' };
const old = locator(before), current = locator(after);
const mapped = old.normalized(raw);
for (const api of [old, current]) for (let i = 0; i < 10; i++) api.locate(raw, entry, mapped);
const times = [[], []];
for (let trial = 0; trial < 7; trial++) for (const [j, api] of (trial % 2 ? [[1, current], [0, old]] : [[0, old], [1, current]])) {
  const start = performance.now();
  for (let i = 0; i < 40; i++) api.locate(raw, entry, mapped);
  times[j].push(performance.now() - start);
}
const medians = times.map(values => values.sort((a, b) => a - b)[3]);
console.log(`Repeated-match locate, median of 7 x 40 calls: before ${medians[0].toFixed(1)} ms, after ${medians[1].toFixed(1)} ms.`);
