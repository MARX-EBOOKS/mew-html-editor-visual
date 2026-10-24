import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { chromium } from 'playwright';

const path = new URL('../public/pdfdiff/pdf-selection.js', import.meta.url);
const enginePath = new URL('./source-index-before-diff.js', import.meta.url);
const fullReviewSource = await readFile(new URL('./source-index-before-provider.js', import.meta.url), 'utf8');
const popupSource = await readFile(new URL('../public/pdfdiff/replacement-review.js', import.meta.url), 'utf8');
const selectionFile = await readFile(new URL('../public/pdfdiff/pdf-selection.js', import.meta.url), 'utf8');
const selectionMapping = selectionFile.slice(selectionFile.indexOf('  function findLocations('),
  selectionFile.indexOf('  function nativeBoxes('))
  .replace('visiblePages().map(number => ({ number, index: layerIndex(viewer.getPageView(number - 1)?.div) }))',
    'environment.getVisiblePages?.() || []')
  .replace('viewer?.pdfDocument', 'environment.getPdf?.()');
const mappingSource = '(() => {\nconst toolbox = window.PdfSelectionDiff;\nconst { textDiff, significantText } = toolbox;\n' + fullReviewSource.split('// Source/PDF mapping and candidate generation.')[1].split('// Shared popup and session initialization.')[0] + '\nwindow.PdfReviewProvider = { PdfLocator, PdfSourceIndex, reviewCandidates };\n})();';
// Attach the private selection helpers while retaining the production locator class.
const selectionMappingSource = mappingSource.replace('window.PdfReviewProvider =', `class SelectionLocator extends PdfLocator {
  constructor(options = {}, environment = {}) {
    super(options, environment);
    const locator = this;
    ${selectionMapping}
    Object.assign(this, { findLocations, locateSource, locateLayer });
  }
}
window.PdfReviewProvider =`).replace('{ PdfLocator, PdfSourceIndex,', '{ PdfLocator: SelectionLocator, PdfSourceIndex,');
const engineSource = await readFile(enginePath, 'utf8') + '\n' + selectionMappingSource;
const countedEngineSource = engineSource.replace('const toolbox = window.PdfSelectionDiff;',
  'const originalTextDiff = window.PdfSelectionDiff.textDiff; window.PdfSelectionDiff.textDiff = (...args) => { window.diffCalls = (window.diffCalls || 0) + 1; return originalTextDiff(...args); }; const toolbox = window.PdfSelectionDiff;');
function locator(options = {}, environment = {}, script = engineSource, globals = {}) {
  const window = { document: { createElement: () => ({}) } };
  vm.runInNewContext(script, { window, ...globals });
  return new window.PdfReviewProvider.PdfLocator(options, environment);
}
const providerSource = popupSource + '\n' + fullReviewSource;
const source = providerSource + `
window.lastNotice = null;
window.addEventListener('pdf-selection-difference', event => { window.lastNotice = event.detail; });
window.addEventListener('pdf-selection-highlight-status', event => { if (event.detail.mode === null) window.lastNotice = null; });
` + await readFile(path, 'utf8');
const testLocator = locator();
const normalized = testLocator.normalized.bind(testLocator);
const engineWindow = {};
vm.runInNewContext(engineSource, { window: engineWindow });
const PdfReviewProvider = engineWindow.PdfReviewProvider;
const { textDiff } = engineWindow.PdfSelectionDiff;
// ME34-014 / PDF page 38: the empty A27 anchor corresponds to an OCR note marker.
const germanSelection = 'daß er wiederholt solche Kritik verlangt und wir jahrelang (denn die Geschichte beginnt seit meiner ersten Rückreise von Karlsbad) dies als eine zu subalterne Arbeit abgelehnt. Die Sache, wie er weiß und wie seine Briefe an uns beweisen, schien erst der Mühe wert, als er';
const germanPdfSelection = germanSelection.replace('wiederholt', 'wieder-\nholt').replace('Karlsbad)', "Karlsbad'271)").replace('beweisen', 'be-\nweisen');
const germanBefore = 'die Pflicht, diesen Burschen zu erklären, ', germanAfter = ' durch wiederholte Zusendung von Knotenbriefen';
const chineseSelection = '这是连续中文文本中的一段选区用来验证格式标签和注释不会打断字符之间的对应关系。'.repeat(5);

test('source edits rebuild mappings before either selection direction consumes them', () => {
  const pdf = {};
  let value = 'Alpha middle Beta', version = 1;
  const model = { getValue: () => value, getVersionId: () => version };
  const diff = locator({}, { document: { createElement: () => ({}) }, getPdf: () => pdf });
  const target = diff.sourceIndex('Alpha Beta');
  let index = diff.editorSourceIndex(model);
  index.rememberConnection(13, 17, target, { start: 6, end: 10 });
  value = '<i>Alpha</i> <b>Beta</b>'; version++;
  index = diff.editorSourceIndex(model);
  assert.equal(index.connections.get(target), undefined);
  assert.equal(index.pageScopes.get(target), undefined);
  diff.prepareSource(index, [target], pdf);
  assert.equal(index.connectedRange(target, 6, 10).start, 6);
  assert.equal(index.connectedRange(target, 6, 10, true).start, 6);
  assert.equal(index.starts[6], value.indexOf('Beta'));
  assert.equal(index.formats[6].bold, true);
  assert.equal(diff.editorSourceIndex(model), index);
  assert.notEqual(diff.editorSourceIndex({ ...model }), index);
});

test('context distinguishes repeated words and rejects ties or conflicting context', () => {
  const raw = 'An unrelated passage contains work. The workers finish their work before returning home.';
  assert.equal(new PdfReviewProvider.PdfSourceIndex(testLocator, { raw: raw }).locate({ text: 'work', before: 'The workers finish their ', after: ' before returning home.' }).start, raw.lastIndexOf('work'));
  assert.equal(new PdfReviewProvider.PdfSourceIndex(testLocator, { raw: 'work and work' }).locate({ text: 'work', before: '', after: '' }), null);
  assert.equal(new PdfReviewProvider.PdfSourceIndex(testLocator, { raw: raw }).locate({ text: 'work', before: 'Completely different context ', after: ' an unrelated ending' }), null);
});

test('empty PDF counterparts retain their insertion position without a rendered-layer connection', () => {
  const before = 'Händen der verschied', after = 'nen Bürgerwehren. Man konnte mindestens verlangen, daß die Privatwaffen abgegeben würden.';
  const raw = before + after, at = before.length;
  const index = new PdfReviewProvider.PdfSourceIndex(new PdfReviewProvider.PdfLocator(), { raw, normalized: normalized(raw) });
  const target = { text: '', before, after, difference: { html: 'e', pdf: '' } };
  const hit = new PdfReviewProvider.PdfSourceIndex(testLocator, { raw: raw }).locate(target);
  assert.ok(hit, 'an empty PDF target is located through its surrounding text');
  assert.equal(hit.start, at); assert.equal(hit.end, at);
  const result = locator().locateLayer(index, [], [target]);
  assert.equal(result.hits.length, 1);
  assert.equal(result.hits[0].start, at); assert.equal(result.hits[0].end, at);
  assert.equal(new PdfReviewProvider.PdfSourceIndex(testLocator, { raw: raw + ' ' + raw }).locate(target), null, 'ambiguous positions are rejected');
  assert.equal(new PdfReviewProvider.PdfSourceIndex(testLocator, { raw: raw }).locate({ ...target, before: 'Unrelated preceding passage' }), null);
  assert.equal(new PdfReviewProvider.PdfSourceIndex(testLocator, { raw: raw }).locate({ text: '', before: '', after: '' }), null);
});

test('normalization preserves source offsets through ligatures and line hyphenation', () => {
  const raw = 'The Straße has a long inter-\nnational history.';
  const hit = new PdfReviewProvider.PdfSourceIndex(testLocator, { raw: raw }).locate({ text: 'international', before: 'The Strasse has a long ', after: ' history.' });
  assert.equal(raw.slice(hit.start, hit.end), 'inter-\nnational');
  assert.equal(new PdfReviewProvider.PdfSourceIndex(testLocator, { raw: 'working work work' }).matches(['work']).length, 3);
});

test('incremental normalization preserves whitespace and Unicode offsets across complete lines', () => {
  const pieces = ['Die Straße enthält eine ﬃ-Ligatur.\n\n', ' 𠀀 中文ſchrift und inter-\nnational.\n', '\n Letzte Zeile.'];
  const expected = normalized(pieces.join(''));
  const actual = { text: '', starts: [], ends: [] };
  let base = 0;
  for (const piece of pieces) { normalized(piece, actual, base); base += piece.length; }
  assert.equal(actual.text, expected.text);
  assert.deepEqual([...actual.starts], [...expected.starts]);
  assert.deepEqual([...actual.ends], [...expected.ends]);
});

test('partial words retain precise offsets and context resolves overlapping occurrences', () => {
  for (const text of ['work', 'ork', 'king', 'rking toget']) {
    const raw = 'We are working together.';
    const start = raw.indexOf(text);
    const hit = new PdfReviewProvider.PdfSourceIndex(testLocator, { raw: raw }).locate({ text, before: raw.slice(0, start), after: raw.slice(start + text.length) });
    assert.equal(hit.start, start);
    assert.equal(raw.slice(hit.start, hit.end), text);
  }
  assert.equal(new PdfReviewProvider.PdfSourceIndex(testLocator, { raw: 'banana' }).matches(['ana']).length, 2);
  assert.equal(new PdfReviewProvider.PdfSourceIndex(testLocator, { raw: 'banana' }).locate({ text: 'ana', before: 'ban', after: '' }).start, 3);
  const wholeWords = (raw, queries) => new PdfReviewProvider.PdfSourceIndex(locator({ wholeWords: true }), { raw }).matches(queries);
  assert.equal(wholeWords('working work work', ['work']).length, 2);
});

test('Chinese selections match inside continuous text with UTF-16 offsets', () => {
  const chinese = '这是中国文字的例子。';
  for (const text of ['国', '国文', '国文字的例']) {
    const start = chinese.indexOf(text);
    const hit = new PdfReviewProvider.PdfSourceIndex(testLocator, { raw: chinese }).locate({ text, before: chinese.slice(0, start), after: chinese.slice(start + text.length) });
    assert.equal(hit.start, start);
    assert.equal(chinese.slice(hit.start, hit.end), text);
  }
  const raw = '甲𠀀乙丙';
  const hit = new PdfReviewProvider.PdfSourceIndex(testLocator, { raw: raw }).locate({ text: '𠀀乙', before: '甲', after: '丙' });
  assert.equal(hit.start, 1);
  assert.equal(hit.end, 4);
  assert.equal(new PdfReviewProvider.PdfSourceIndex(testLocator, { raw: '中国 文字' }).matches(['国文']).length, 0, 'Actual spaces are preserved');
  assert.equal(new PdfReviewProvider.PdfSourceIndex(testLocator, { raw: 'some words' }).matches(['somewords']).length, 0, 'Latin word spaces remain significant');
});

test('context locates small differences in either direction, including partial words', () => {
  for (const [html, pdf] of [
    ['schöpliche', 'schöpfliche'], ['schöpfliche', 'schöpliche'],
    ['schöpliche', 'schöbliche'], ['öpliche', 'öpfliche'],
    ['中国文字', '中国文宇']
  ]) {
    const before = 'Das Gespräch drehte sich um die schier uner', after = ' Streit- und Parteifrage.';
    const raw = before + pdf + after;
    const hit = new PdfReviewProvider.PdfSourceIndex(testLocator, { raw: raw }).locate({ text: html, before, after });
    assert.ok(hit?.approximate, `${html} -> ${pdf}`);
    assert.equal(raw.slice(hit.start, hit.end), pdf);
    assert.equal(hit.distance, 1);
    const diff = textDiff(html, pdf, true);
    assert.equal(diff.distance, 1);
    assert.equal(diff.parts.map(part => part.html).join(''), html);
    assert.equal(diff.parts.map(part => part.pdf).join(''), pdf);
    assert.ok(diff.parts.some(part => part.changed));
  }
  const raw = 'Elsewhere schöpliche appears. The schier unerschöpfliche Streit- und Parteifrage.';
  const hit = new PdfReviewProvider.PdfSourceIndex(testLocator, { raw: raw }).locate({ text: 'schöpliche', before: 'The schier uner', after: ' Streit- und Parteifrage.' });
  assert.equal(raw.slice(hit.start, hit.end), 'schöpfliche', 'conflicting exact occurrences do not block contextual tolerance');
});

test('tolerance rejects missing context, large differences, short selections and ambiguous locations', () => {
  assert.equal(new PdfReviewProvider.PdfSourceIndex(testLocator, { raw: 'schöpfliche' }).locate({ text: 'schöpliche', before: '', after: '' }), null);
  assert.equal(new PdfReviewProvider.PdfSourceIndex(testLocator, { raw: 'Before completelydifferent after.' }).locate({ text: 'schöpliche', before: 'Before ', after: ' after.' }), null);
  assert.equal(new PdfReviewProvider.PdfSourceIndex(testLocator, { raw: 'Before ax after.' }).locate({ text: 'ab', before: 'Before ', after: ' after.' }), null);
  assert.equal(new PdfReviewProvider.PdfSourceIndex(testLocator, { raw: 'Before schöpfliche after. Before schöpfliche after.' }).locate({ text: 'schöpliche', before: 'Before ', after: ' after.' }), null);
});

test('bounded distance agrees with full alignment for Unicode, insertions and deletions', () => {
  const words = ['', 'a', 'b', '𠀀'];
  for (let length = 2; length <= 3; length++) {
    const previous = words.filter(word => [...word].length === length - 1);
    for (const word of previous) for (const char of ['a', 'b', '𠀀']) words.push(word + char);
  }
  for (const left of words) for (const right of words) {
    const distance = textDiff(left, right, true).distance;
    assert.equal(textDiff(left, right).distance, distance);
    for (const limit of [0, 1, 2, 3]) {
      assert.equal(textDiff(left, right, false, limit).distance, Math.min(limit + 1, distance), `${left} / ${right}: ${limit}`);
      assert.equal(textDiff('prefix' + left + 'suffix', 'prefix' + right + 'suffix', false, limit).distance, Math.min(limit + 1, distance));
    }
  }
});

test('compact traceback agrees with an independent edit-distance oracle across wider bands', () => {
  const html = 'a'.repeat(15000), pdf = 'b'.repeat(15000), rejected = textDiff(html, pdf, true);
  assert.equal(rejected.distance, 129, 'divergent detailed comparisons stop at 128 edits');
  assert.equal(rejected.parts.map(part => part.html).join(''), html);
  assert.equal(rejected.parts.map(part => part.pdf).join(''), pdf);
  assert.equal(new PdfReviewProvider.PdfSourceIndex(testLocator, { raw: html }).rememberConnection(0, html.length, new PdfReviewProvider.PdfSourceIndex(testLocator, { raw: pdf }), { start: 0, end: pdf.length }), null, 'rejected diffs must not create character mappings');
  const oracle = (left, right) => {
    const a = [...left], b = [...right];
    let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      const row = [i];
      for (let j = 1; j <= b.length; j++) row[j] = Math.min(previous[j] + 1, row[j - 1] + 1, previous[j - 1] + (a[i - 1] !== b[j - 1]));
      previous = row;
    }
    return previous[b.length];
  };
  let seed = 42;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  const alphabet = ['a', 'b', 'c', '甲', '𠀀'];
  for (let trial = 0; trial < 250; trial++) {
    const left = Array.from({ length: random() % 80 }, () => alphabet[random() % alphabet.length]).join('');
    const right = Array.from({ length: random() % 80 }, () => alphabet[random() % alphabet.length]).join('');
    const distance = oracle(left, right), diff = textDiff(left, right, true);
    assert.equal(diff.distance, distance);
    assert.equal(diff.parts.map(part => part.html).join(''), left);
    assert.equal(diff.parts.map(part => part.pdf).join(''), right);
    for (const part of diff.parts) if (!part.changed) assert.equal(part.html, part.pdf);
    for (const bound of [0, 3, 12, 32]) assert.equal(textDiff(left, right, false, bound).distance, Math.min(bound + 1, distance));
  }
});

test('long German and unspaced Chinese selections align internal note markers with both boundaries', () => {
  for (const [text, pdf, before, after] of [
    [germanSelection, germanPdfSelection, germanBefore, germanAfter],
    [chineseSelection, chineseSelection.slice(0, 80) + '[27]' + chineseSelection.slice(80), '选区之前的上下文必须完整保留', '选区之后的上下文必须完整保留']
  ]) {
    const entry = { text, before, after }, raw = before + pdf + after;
    const hit = new PdfReviewProvider.PdfSourceIndex(testLocator, { raw: raw }).locate(entry);
    assert.ok(hit?.approximate);
    assert.equal(raw.slice(hit.start, hit.end), pdf);
    assert.equal(hit.distance, 4);
    assert.equal(new PdfReviewProvider.PdfSourceIndex(testLocator, { raw: raw }).locate({ ...entry, after: '' }), null, 'both boundaries required');
    assert.equal(new PdfReviewProvider.PdfSourceIndex(testLocator, { raw: raw + raw }).locate(entry), null, 'identical boundary pairs remain ambiguous');
    assert.equal(new PdfReviewProvider.PdfSourceIndex(testLocator, { raw: before + 'unrelated passage '.repeat(20) + after }).locate(entry), null, 'context cannot admit substantially different text');
    const reverse = new PdfReviewProvider.PdfSourceIndex(testLocator, { raw: before + text + after }).locate({ text: pdf, before, after });
    assert.equal((before + text + after).slice(reverse.start, reverse.end), text);
  }
});

test('confirmed diffs map inner selections both ways, including changed runs and deleted characters', () => {
  for (const [html, pdf, selected, expected] of [
    ['Before Knoten-Strebern after.', 'Before Knoten-5/refiern after.', 'Strebern', '5/refiern'],
    ['甲𠀀乙丙', '甲𠀀乙[27]丙', '𠀀乙丙', '𠀀乙[27]丙'],
    ['Before Straße after.', 'Before Strasse after.', 'Straße', 'Strasse'],
    ['甲𠀀乙丁丙', '甲𠀀乙丙', '𠀀乙', '𠀀乙']
  ]) {
    const source = new PdfReviewProvider.PdfSourceIndex(new PdfReviewProvider.PdfLocator(), { raw: html, connections: new WeakMap() }), target = new PdfReviewProvider.PdfSourceIndex(new PdfReviewProvider.PdfLocator(), { raw: pdf });
    source.rememberConnection(0, html.length, target, { start: 0, end: pdf.length });
    const hit = source.connectedRange(target, html.indexOf(selected), html.indexOf(selected) + selected.length);
    assert.equal(pdf.slice(hit.start, hit.end), expected);
    const reverse = source.connectedRange(target, hit.start, hit.end, true);
    assert.equal(html.slice(reverse.start, reverse.end), selected);
    assert.equal(source.connectedRange({ raw: pdf }, 0, selected.length), null, 'different PDF indexes do not inherit connections');
  }
  const source = new PdfReviewProvider.PdfSourceIndex(new PdfReviewProvider.PdfLocator(), { raw: '甲乙丁丙', connections: new WeakMap() }), target = new PdfReviewProvider.PdfSourceIndex(new PdfReviewProvider.PdfLocator(), { raw: '甲乙丙' });
  source.rememberConnection(0, 4, target, { start: 0, end: 3 });
  const anchor = source.connectedRange(target, 2, 3);
  assert.equal(anchor.start, 2, 'surplus HTML maps to its PDF insertion point');
  assert.equal(anchor.end, 2);
  assert.equal(anchor.approximate, true);
  for (const [html, start, expected] of [['丁甲乙丙', 0, 0], ['甲乙丙丁', 3, 3]]) {
    const source = new PdfReviewProvider.PdfSourceIndex(new PdfReviewProvider.PdfLocator(), { raw: html, connections: new WeakMap() });
    source.rememberConnection(0, html.length, target, { start: 0, end: target.raw.length });
    const hit = source.connectedRange(target, start, start + 1);
    assert.equal(hit.start, expected, 'surplus text at passage boundaries keeps an insertion anchor');
    assert.equal(hit.end, expected);
  }
});

test('startup alignment maps a single damaged Chinese character without spaces or a prior selection', () => {
  const raw = Array.from({ length: 20 }, (_, i) => `第${i}段劳动者共同讨论文字校对以及格式标记中的连续中文对应关系。`).join('').replace('第7段劳动者', '第7段劳動者');
  const html = new PdfReviewProvider.PdfSourceIndex(new PdfReviewProvider.PdfLocator(), { raw, normalized: normalized(raw), connections: new WeakMap(), pageScopes: new WeakMap() });
  const pdfText = raw.replace('動', '劫'), pdf = new PdfReviewProvider.PdfSourceIndex(new PdfReviewProvider.PdfLocator(), { raw: pdfText, normalized: normalized(pdfText), pageScopes: new WeakMap() });
  const at = raw.indexOf('動');
  assert.equal(new PdfReviewProvider.PdfSourceIndex(testLocator, { raw: pdfText }).locate({ text: '動', before: raw.slice(at - 160, at), after: raw.slice(at + 1, at + 161) }), null);
  html.sourcePageScope(pdf, true);
  const hit = html.connectedRange(pdf, at, at + 1);
  assert.equal(pdfText.slice(hit.start, hit.end), '劫');
  const reverse = html.connectedRange(pdf, hit.start, hit.end, true);
  assert.equal(raw.slice(reverse.start, reverse.end), '動');
  const cached = html.connections.get(pdf);
  html.sourcePageScope(pdf, true);
  assert.equal(html.connections.get(pdf), cached, 'prepared scope reuses its existing mappings');
});

test('connections reuse whole-text indexes and alignments while respecting partial-range boundaries', () => {
  const raw = 'alpha-\nbeta and a ligature ﬃ';
  const html = new PdfReviewProvider.PdfSourceIndex(new PdfReviewProvider.PdfLocator(), { raw, normalized: normalized(raw), connections: new WeakMap() });
  const pdf = new PdfReviewProvider.PdfSourceIndex(new PdfReviewProvider.PdfLocator(), { raw, normalized: normalized(raw) });
  const hit = { start: 0, end: raw.length };
  const connection = html.rememberConnection(0, raw.length, pdf, hit);
  assert.equal(connection.left, html.normalized);
  assert.equal(connection.right, pdf.normalized);
  assert.equal(html.rememberConnection(0, raw.length, pdf, hit), connection);
  assert.equal(html.connections.get(pdf).length, 1, 'the same alignment is not stored twice');

  const partial = html.rememberConnection(0, 6, pdf, { start: 0, end: 6 });
  assert.equal(partial.left.text, 'alpha-', 'a selection ending before the newline retains its hyphen');
  assert.notEqual(partial.left, html.normalized);
  const changedTarget = html.rememberConnection(0, 6, pdf, { start: 7, end: 11 });
  assert.notEqual(changedTarget, partial, 'a different target interval needs a different alignment');
  assert.equal(changedTarget.right.text, 'beta');
});

test('page preparation reuses retained anchor mappings without repeating comparisons', () => {
  const comparisons = [];
  const countedLocator = locator({}, {}, engineSource.replace(
    'function textDiff(left, right, details = false, limit = Infinity) {',
    'function textDiff(left, right, details = false, limit = Infinity) { countComparison(left, right, details);'
  ), { countComparison: (left, right, details) => comparisons.push({ left, right, details }) });
  const index = raw => countedLocator.sourceIndex(raw);
  let seed = 17;
  const text = Array.from({ length: 4096 }, () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return String.fromCharCode(97 + seed % 26);
  }).join('');
  const html = index(text), pdf = index(text.slice(0, 2000) + '7' + text.slice(2001));
  html.sourcePageScope(pdf, true);
  const connections = html.connections.get(pdf);
  assert.ok(connections?.length, 'OCR differences prepare anchor mappings');
  assert.ok(comparisons.some(item => !item.details), 'initial preparation validates uncached gaps');
  // An edit elsewhere can invalidate the page scope while retaining this passage's mappings.
  const revised = index(text + ' added text outside the mapped passage');
  revised.connections.set(pdf, connections);
  comparisons.length = 0;
  revised.sourcePageScope(pdf, true);
  assert.equal(comparisons.length, 0, 'retained mappings skip both validation and detailed diffs');
  assert.equal(revised.connections.get(pdf), connections, 'preparation retains the original mapping objects');

  const changed = index(text.slice(0, 1200) + '8' + text.slice(1201));
  comparisons.length = 0;
  changed.sourcePageScope(pdf, true);
  assert.ok(comparisons.some(item => !item.details), 'edited passages still require fresh validation');
});

test('failed page preparation is cached until the source or PDF layer changes', () => {
  let searches = 0;
  // Count page preparation, including the longer-anchor fallback.
  const countedLocator = locator({}, {}, engineSource.replace(
    '    let scope = this.locate(', '    countSearch(); let scope = this.locate('
  ), { countSearch: () => searches++ });
  const index = raw => countedLocator.sourceIndex(raw);
  const html = index('Completely revised unsaved HTML with no shared text.'), pdf = index('Original PDF passage whose wording is unrelated.');
  assert.equal(html.sourcePageScope(pdf, true), null);
  const initial = searches;
  for (let i = 0; i < 20; i++) assert.equal(html.sourcePageScope(pdf, true), null);
  assert.equal(searches, initial, 'failed preparation must not repeat on every selection');
  index(html.raw + ' More edits.').sourcePageScope(pdf, true);
  assert.ok(searches > initial, 'new source index retries preparation');
  const changed = searches;
  html.sourcePageScope(index(pdf.raw), true);
  assert.ok(searches > changed, 'rebuilt PDF layer retries preparation');
});

test('last fallback searches all patched words without changing substrings or trusting conflicting patches', () => {
  const source = new PdfReviewProvider.PdfSourceIndex(new PdfReviewProvider.PdfLocator(), { raw: 'Before Wage and Strebern after.', connections: new WeakMap() });
  const target = new PdfReviewProvider.PdfSourceIndex(new PdfReviewProvider.PdfLocator(), { raw: 'Before lVage and 5/refiern after.' });
  source.rememberConnection(0, source.raw.length, target, { start: 0, end: target.raw.length });
  const entry = { index: source, text: 'Wage and Strebern wagework' };
  assert.deepEqual([...entry.index.patchedWords(entry.text, target)], ['lvage', 'and', '5/refiern', 'wagework']);
  source.connections.get(target).push({ patches: [['wage', 'other']] });
  assert.deepEqual([...entry.index.patchedWords(entry.text, target)], ['wage', 'and', '5/refiern', 'wagework']);
});

test('browser draws selected ranges and nearby diffs for tolerant matches', async () => {
  const browser = await chromium.launch({ executablePath: process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: true });
  try {
    for (const fixture of [
      { html: '<span>We are working together.</span>', text: 'work' },
      { html: '<span>We are working together.</span>', text: 'ork' },
      { html: '<span>We are working together.</span>', text: 'king' },
      { html: '<span>这是中国文字的例子。</span>', text: '国' },
      { html: '<span>这是中</span><span>国</span><span>文字的例子。</span>', text: '国文' },
      { html: '<span>甲𠀀乙丙</span>', text: '𠀀乙' },
      { html: '<span>We are working together.</span>', text: 'work', source: '<p>We are <b>working</b> together.</p>' },
      { html: '<span>We are working together.</span>', text: 'working', source: '<p>We are <b>working</b> together.</p>', sourceSelection: '<b>working</b>' },
      { html: '<span>We are working together.</span>', text: 'working together', source: '<p>We are work<b>ing</b> together.</p>', sourceSelection: 'work<b>ing</b> together' },
      { html: '<span>Before work & rest after.</span>', text: 'work & rest', source: '<p>Before <i title="a > b">work</i> &amp; rest after.</p>', sourceSelection: 'a > b">work</i> &amp; rest' },
      { html: '<span>Before work & rest after.</span>', text: '& rest', source: '<p>Before work &amp; rest after.</p>', sourceSelection: 'amp; rest' },
      { html: '<span>We are working together.</span>', text: 'working', source: '<root>We are <term data-note="not PDF text">working</term> together.</root>', sourceSelection: '<term data-note="not PDF text">working</term>' },
      { html: '<span>We are working together.</span>', text: 'working', source: '<head><title>wrong context</title></head><p>We are <!--wrong context--><b>working</b> together.</p>', sourceSelection: '<!--wrong context--><b>working</b>' },
      { html: '<span>Before &lt;work&gt; after.</span>', text: '<work>', source: '<p>Before &lt;work&gt; after.</p>', sourceSelection: '&lt;work&gt;' },
      { html: `<span>${germanBefore + germanPdfSelection + germanAfter}</span>`, text: germanPdfSelection, selection: germanSelection,
        source: `<p>${germanBefore + germanSelection.replace('Karlsbad)', 'Karlsbad<a id="A27"></a>)') + germanAfter}</p>`,
        sourceSelection: germanSelection.replace('Karlsbad)', 'Karlsbad<a id="A27"></a>)') },
      { html: `<span>选区之前的上下文必须完整保留${chineseSelection.slice(0, 80)}[27]${chineseSelection.slice(80)}选区之后的上下文必须完整保留</span>`,
        text: chineseSelection.slice(0, 80) + '[27]' + chineseSelection.slice(80), selection: chineseSelection,
        source: `<p>选区之前的上下文必须完整保留${chineseSelection.slice(0, 80)}<a id="note"></a><i>${chineseSelection.slice(80)}</i>选区之后的上下文必须完整保留</p>`,
        sourceSelection: chineseSelection.slice(0, 80) + '<a id="note"></a><i>' + chineseSelection.slice(80) + '</i>' },
      { html: '<span>Die schier unerschöpfliche Streit- und Parteifrage.</span>', text: 'schöpfliche', selection: 'schöpliche' },
      { html: '<span>Die schier unerschöpfliche Streit- und Parteifrage.</span>', text: 'schöpfliche', selection: 'schöpliche', source: '<p>Die schier uner<i>schöpliche</i> Streit- und Parteifrage.</p>', sourceSelection: '<i>schöpliche</i>' },
      { html: '<span>Die schier unerschöpliche Streit- und Parteifrage.</span>', text: 'schöpliche', selection: 'schöpfliche' },
      { html: '<span>Die schier unerschöbliche Streit- und Parteifrage.</span>', text: 'schöbliche', selection: 'schöpliche' },
      { html: '<span>这里所讲的是中国文宇之间的差异。</span>', text: '中国文宇', selection: '中国文字' }
    ]) {
      const page = await browser.newPage();
      await page.setContent(`<div id="stage" style="height:300px;width:700px;overflow:auto"><div class="pdfViewer"><div class="page" style="height:400px;position:relative"><div class="textLayer" style="font:24px sans-serif">${fixture.html}</div></div></div></div>`);
      await page.addScriptTag({ content: engineSource });
      await page.addScriptTag({ content: source });
      const expected = await page.evaluate(({ text, selection = text, source: markup, sourceSelection }) => {
        const div = document.querySelector('.page'), spans = [...div.querySelectorAll('span')];
        const source = spans.map(span => span.textContent).join('');
        const start = source.indexOf(text), end = start + text.length, boxes = [];
        const htmlSource = markup ?? source.slice(0, start) + selection + source.slice(end);
        const selectedSource = sourceSelection ?? selection;
        const sourceStart = htmlSource.indexOf(selectedSource);
        let offset = 0;
        for (const span of spans) {
          const length = span.textContent.length;
          if (offset < end && offset + length > start) {
            const range = document.createRange();
            range.setStart(span.firstChild, Math.max(0, start - offset));
            range.setEnd(span.firstChild, Math.min(length, end - offset));
            boxes.push(...[...range.getClientRects()].map(box => ({ left: box.left, top: box.top, width: box.width, height: box.height })));
          }
          offset += length;
        }
        PdfSelection.attachViewer({
          container: document.getElementById('stage'), viewer: document.querySelector('.pdfViewer'), currentPageNumber: 1,
          _getVisiblePages: () => ({ views: [{ id: 1 }] }), getPageView: () => ({ div }),
          eventBus: { on() {}, off() {} },
          pdfDocument: { numPages: 1, async getPage() { return {
            async getTextContent() { return { items: [{ str: source, transform: [1, 0, 0, 1, 0, 500], width: 500, height: 24 }] }; }
          }; } }
        });
        let currentSource = htmlSource, version = 1, a = sourceStart, b = sourceStart + selectedSource.length;
        window.sourceReads = 0;
        const model = { getValue: () => { sourceReads++; return currentSource; }, getVersionId: () => version, getOffsetAt: position => position };
        PdfSelection.attachEditor({
          onDidChangeCursorSelection(callback) {
            window.selectSource = (start, end, source) => {
              a = start; b = end;
              if (source !== undefined) { currentSource = source; version++; }
              callback();
            };
            return { dispose() {} };
          },
          getModel: () => model,
          getSelections: () => [{ getStartPosition: () => a, getEndPosition: () => b }], hasTextFocus: () => true
        });
        // A continuous selection can be drawn as one rectangle per visual line.
        const lines = [];
        for (const box of boxes) {
          const line = lines.at(-1);
          if (line && Math.abs(line.top - box.top) < .5 && Math.abs(line.height - box.height) < .5
            && Math.abs(line.left + line.width - box.left) < .5) line.width += box.width;
          else lines.push({ ...box });
        }
        return lines;
      }, fixture);
      await page.waitForFunction(() => PdfSelection.status.state === 'idle' && PdfSelection.status.mode === 'exact');
      assert.equal(await page.evaluate(() => PdfSelection.status.matches), 1);
      const actual = await page.locator('.mew-pdf-selection-highlight > div').evaluateAll(marks => marks.map(mark => {
        const box = mark.getBoundingClientRect();
        return { left: box.left, top: box.top, width: box.width, height: box.height };
      }));
      assert.equal(actual.length, expected.length);
      for (let i = 0; i < expected.length; i++) for (const key of ['left', 'top', 'width', 'height']) {
        assert.ok(Math.abs(actual[i][key] - expected[i][key]) < 1, `${fixture.text}: ${key} must follow the selected characters`);
      }
      if (fixture.selection) {
        try { await page.waitForFunction(() => window.lastNotice, null, { timeout: 4000 }); }
        catch (error) { console.log('Missing difference event', fixture, await page.evaluate(() => ({ status: PdfSelection.status, notice: !!window.lastNotice }))); throw error; }
        const notice = await page.evaluate(() => ({ html: lastNotice.notices[0].html, pdf: lastNotice.notices[0].pdf, anchor: lastNotice.anchor }));
        assert.equal(notice.html, fixture.selection);
        assert.equal(notice.pdf, fixture.text);
        assert.ok(notice.anchor.top <= Math.max(...expected.map(box => box.top + box.height)));
        assert.equal(await page.locator('.mew-pdf-selection-difference').count(), 0, 'selection module publishes data without constructing UI');
        await page.evaluate(() => PdfSelection.clear());
        assert.equal(await page.evaluate(() => window.lastNotice), null, 'clearing selection invalidates the published difference');
      }
      if (fixture.source) {
        await page.evaluate(fixture => {
          const selected = fixture.sourceSelection ?? fixture.text, at = fixture.source.indexOf(selected);
          selectSource(at, at + selected.length);
        }, fixture);
        await page.waitForFunction(() => PdfSelection.status.state === 'idle' && PdfSelection.status.matches === 1);
        assert.equal(await page.evaluate(() => sourceReads), 1, 'forward selections reuse the full source index');
        await page.evaluate(fixture => selectSource(0, fixture.source.indexOf('>') + 1), fixture);
        assert.equal(await page.locator('.mew-pdf-selection-highlight').count(), 0, 'markup-only selection clears highlights');
        await page.evaluate(() => selectSource(0, 0));
        assert.equal(await page.locator('.mew-pdf-selection-highlight').count(), 0, 'collapsed selection stays empty');
        const updated = '<p>' + fixture.text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</p>';
        await page.evaluate(updated => selectSource(3, updated.length - 4, updated), updated);
        await page.waitForFunction(() => PdfSelection.status.state === 'idle' && PdfSelection.status.matches === 1);
        assert.equal(await page.evaluate(() => sourceReads), 2, 'changed model version refreshes the source index');
      }
      await page.evaluate(() => PdfSelection.stop());
      await page.close();
    }
  } finally { await browser.close(); }
});

test('review highlights all supplied occurrences across PDF pages and clears them together', async () => {
  const browser = await chromium.launch({ executablePath: process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: true });
  try {
    const page = await browser.newPage();
    const passages = ['First distinct passage contains Word followed by enough context to identify its page.',
      'Second independent passage also contains Word and has different surrounding words.'];
    await page.setContent('<div id="stage"><div class="pdfViewer">' + passages.map((text, i) =>
      `<div class="page" data-page-number="${i + 1}" style="position:relative;height:150px;width:700px"><div class="textLayer"><span role="presentation">${text}</span></div></div>`).join('') + '</div></div>');
    await page.addScriptTag({ content: engineSource });
    await page.addScriptTag({ content: source });
    await page.waitForFunction(() => window.PdfSelection);
    await page.evaluate(passages => {
      const pages = [...document.querySelectorAll('.page')];
      window.events = new Map();
      PdfSelection.attachViewer({ container: document.getElementById('stage'), viewer: document.querySelector('.pdfViewer'),
        _getVisiblePages: () => ({ views: pages.map((_, i) => ({ id: i + 1 })) }),
        getPageView: i => ({ div: pages[i] }), eventBus: { on(name, fn) { events.set(name, fn); }, off() {} },
        pdfDocument: { numPages: 2, async getPage(number) { return {
          async getTextContent() { return { items: [{ str: passages[number - 1], transform: [1, 0, 0, 1, 0, 100], width: 600, height: 20 }] }; }
        }; } } });
      const markup = passages.map(text => `<p>${text}</p>`).join('');
      const model = { getValue: () => markup, getVersionId: () => 1 };
      window.pointerEditor = { getModel: () => model };
      const index = PdfSelection.locator.editorSourceIndex(model);
      const items = [...index.raw.matchAll(/Word/g)].map(match => ({ sourceStart: match.index, sourceEnd: match.index + 4 }));
      PdfSelection.showReviewPointer(pointerEditor, items);
    }, passages);
    await page.waitForFunction(() => document.querySelectorAll('.mew-pdf-review-pointer > div').length === 2, null, { timeout: 5000 });
    for (const div of await page.locator('.page').all()) {
      const mark = await div.locator('.mew-pdf-review-pointer > div').boundingBox();
      const expected = await div.locator('span').evaluate(span => {
        const start = span.textContent.indexOf('Word'), range = document.createRange();
        range.setStart(span.firstChild, start); range.setEnd(span.firstChild, start + 4);
        const box = range.getBoundingClientRect(); return { x: box.x, width: box.width };
      });
      assert.ok(Math.abs(mark.x - expected.x) < 1 && Math.abs(mark.width - expected.width) < 1);
    }
    await page.evaluate(() => { document.querySelectorAll('.textLayer span')[1].replaceChildren(document.createTextNode(document.querySelectorAll('.textLayer span')[1].textContent)); events.get('textlayerrendered')({ pageNumber: 2 }); });
    await page.waitForFunction(() => document.querySelectorAll('.mew-pdf-review-pointer > div').length === 2);
    await page.evaluate(() => PdfSelection.clearReviewPointer(pointerEditor));
    assert.equal(await page.locator('.mew-pdf-review-pointer').count(), 0);
  } finally { await browser.close(); }
});

test('browser draws HTML-only text as a visible PDF caret between text spans', async () => {
  const browser = await chromium.launch({ executablePath: process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: true });
  try {
    for (const placement of ['middle', 'start', 'end']) {
      const page = await browser.newPage();
      await page.setContent('<div id="stage" style="width:900px;height:600px;overflow:auto"><div class="pdfViewer"><div class="page" style="position:relative;width:800px;height:500px;border:9px solid transparent;transform:scale(.9);transform-origin:top left"><div class="textLayer" style="font:24px sans-serif"><span></span><span></span></div></div></div></div>');
      await page.addScriptTag({ content: engineSource });
      await page.addScriptTag({ content: source });
      const expected = await page.evaluate(placement => {
        const before = 'The workers finish their work before returning home. ', after = 'Together they discuss the events of the day and prepare for tomorrow.';
        const prefix = 'An introduction provides enough unique context to locate the following passage. ';
        const suffix = ' This closing sentence provides the unique context following the passage.';
        const raw = prefix + before + after + suffix;
        const at = prefix.length + (placement === 'start' ? 0 : placement === 'end' ? before.length + after.length : before.length);
        const surplus = 'EXTRA', html = '<p>' + raw.slice(0, at) + surplus + raw.slice(at) + '</p>';
        const spans = document.querySelectorAll('span'); spans[0].textContent = raw.slice(0, at); spans[1].textContent = raw.slice(at);
        const range = document.createRange(); range.setStart(spans[1].firstChild, 0); range.collapse(true);
        const box = range.getBoundingClientRect(), div = document.querySelector('.page');
        const originalRects = Range.prototype.getClientRects;
        Range.prototype.getClientRects = function () { return this.collapsed ? [] : originalRects.call(this); };
        const model = { getValue: () => html, getVersionId: () => 1, getOffsetAt: value => value };
        PdfSelection.attachViewer({
          container: document.getElementById('stage'), viewer: document.querySelector('.pdfViewer'), currentPageNumber: 1,
          _getVisiblePages: () => ({ views: [{ id: 1 }] }), getPageView: () => ({ div }), eventBus: { on() {}, off() {} },
          pdfDocument: { numPages: 1, async getPage() { return { async getTextContent() { return { items: [{ str: raw, transform: [1, 0, 0, 1, 0, 500], width: 800, height: 24 }] }; } }; } }
        });
        PdfSelection.attachEditor({
          getModel: () => model, hasTextFocus: () => true,
          getSelections: () => [{ getStartPosition: () => at + 3, getEndPosition: () => at + 3 + surplus.length }],
          onDidChangeCursorSelection() { return { dispose() {} }; }
        });
        return { left: box.left, top: box.top, height: box.height };
      }, placement);
      await page.waitForFunction(() => document.querySelector('.mew-pdf-selection-caret'), null, { timeout: 3000 }).catch(async error => {
        console.log('Caret fixture', placement, await page.evaluate(() => PdfSelection.status)); throw error;
      });
      const actual = await page.locator('.mew-pdf-selection-caret').evaluate(mark => {
        const box = mark.getBoundingClientRect(); return { left: box.left, top: box.top, height: box.height, width: box.width, color: mark.style.background };
      });
      for (const key of ['left', 'top', 'height']) assert.ok(Math.abs(expected[key] - actual[key]) < 1, `${placement}: caret ${key}`);
      assert.ok(actual.width >= 1.9 && actual.width <= 2.1, `${placement}: caret stays visible under scaling`);
      assert.equal(actual.color, 'rgb(213, 139, 36)');
      const reported = await page.evaluate(() => PdfSelection.highlightRects()[0]);
      for (const key of ['left', 'top']) assert.ok(Math.abs(reported[key] - actual[key]) < 1, `${placement}: reported marker bounds include the PDF page border`);
      await page.waitForFunction(() => window.lastNotice?.notices[0]?.html === 'EXTRA');
      assert.equal(await page.evaluate(() => lastNotice.notices[0].pdf), '');
      await page.close();
    }
  } finally { await browser.close(); }
});

test('Monaco decorations appear on open and on cached PDF page changes without a selection', async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<div id="stage"><div class="pdfViewer"></div></div>');
    await page.addScriptTag({ content: engineSource });
    await page.addScriptTag({ content: source });
    await page.waitForFunction(() => window.PdfSelection);
    await page.evaluate(() => {
      const passages = [
        'A unique introductory passage describes the workers returning home. They discuss X before preparing for the following morning.',
        'Another distinct passage describes the citizens gathering their weapons. They discuss Q before returning to their individual houses.'
      ];
      const root = document.querySelector('.pdfViewer');
      const pages = passages.map((text, i) => {
        const div = document.createElement('div'); div.className = 'page'; div.dataset.pageNumber = i + 1;
        div.innerHTML = '<div class="textLayer"><span role="presentation"></span></div>';
        div.querySelector('span').textContent = text.replace(' X ', ' Y ').replace(' Q ', ' Z ');
        root.append(div); return div;
      });
      window.pageEvents = new Map();
      window.visiblePage = 1;
      window.mockViewer = {
        container: document.getElementById('stage'), currentPageNumber: 1,
        getPageView: i => ({ div: pages[i] }), _getVisiblePages: () => ({ views: [{ id: visiblePage }] }),
        eventBus: { on(name, callback) { pageEvents.set(name, callback); }, off() {} },
        // Page-local highlights must not wait for the full volume index.
        pdfDocument: { numPages: 2, getPage: () => new Promise(() => {}) }
      };
      let value = passages.map(text => `<p>${text}</p>`).join(''), version = 1;
      const model = { getValue: () => value, getVersionId: () => version,
        getPositionAt: offset => ({ lineNumber: 1, column: offset + 1 }) };
      window.currentDecorations = [];
      const editor = {
        getDomNode: () => root, getModel: () => model, hasTextFocus: () => false, getSelections: () => [],
        onDidChangeCursorSelection() { return { dispose() {} }; },
        onDidChangeModel() { return { dispose() {} }; },
        onDidChangeModelContent(callback) { window.contentChanged = callback; return { dispose() {} }; },
        createDecorationsCollection: () => ({ set(values) { currentDecorations = values; }, clear() { currentDecorations = []; } })
      };
      window.changeSource = () => { value = value.replace(' Q ', ' Z '); version++; contentChanged({ changes: [{}] }); };
      PdfSelection.attachViewer(mockViewer); PdfSelection.attachEditor(editor);
    });
    await page.waitForFunction(() => currentDecorations.some(mark => mark.options.hoverMessage?.value.includes('"X"')));
    assert.equal(await page.evaluate(() => !!PdfSelection.locator.getDocumentIndex(mockViewer.pdfDocument)), false);
    await page.evaluate(() => { visiblePage = 2; mockViewer.currentPageNumber = 2; pageEvents.get('pagechanging')({ pageNumber: 2 }); });
    await page.waitForFunction(() => currentDecorations.some(mark => mark.options.hoverMessage?.value.includes('"Q"')), null, { timeout: 3000 });
    await page.evaluate(() => changeSource());
    await page.waitForFunction(() => !currentDecorations.some(mark => mark.options.hoverMessage?.value.includes('"Q"')), null, { timeout: 3000 });
    assert.equal(await page.locator('.mew-pdf-selection-highlight').count(), 0);
  } finally { await browser.close(); }
});

test('browser prepares diffs before selection and rebuilds mappings after source or PDF changes', async () => {
  const browser = await chromium.launch({ executablePath: process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<div id="stage" style="height:500px;width:800px;overflow:auto"><div class="pdfViewer"><div class="page" style="position:relative"><div class="textLayer" style="font:24px sans-serif"><span></span></div></div></div></div>');
    await page.addScriptTag({ content: countedEngineSource.replace(
      'function rememberConnection(source, start, end, target, hit, alignment) {',
      'function rememberConnection(source, start, end, target, hit, alignment) { window.preparedDiffs = (window.preparedDiffs || 0) + 1;') });
    await page.addScriptTag({ content: source });
    await page.evaluate(() => {
      const before = 'Meine Ansicht ist, daß ohne alle ', after = ' rechneten auf Liebknechts ihnen wohlbekannte Schwäche.';
      const passage = 'Rücksicht Dühring kritisiert wird. Er hat offenbar unter den ihm zugetanen literarischen Knoten-Strebern gewühlt, um solche Kritik zu verhindern; sie ihrerseits';
      window.pdfText = before + passage.replace('Strebern', '5/refiern') + after;
      window.htmlText = '<p>' + before + passage.replace('Strebern', '<i>Strebern</i>') + after + '</p>';
      let version = 1, a = 0, b = 0;
      window.editorTargets = [];
      window.sourceReads = 0;
      const callbacks = [], model = {
        getValue: () => { sourceReads++; return htmlText; }, getVersionId: () => version, getOffsetAt: position => position,
        getPositionAt: offset => ({ lineNumber: 1, column: offset + 1 })
      };
      window.selectHtml = (text, replacement) => {
        if (replacement) { htmlText = htmlText.replace(text, replacement); version++; text = replacement; }
        a = htmlText.indexOf(text); b = a + text.length; callbacks.forEach(callback => callback());
      };
      window.editHtml = () => {
        htmlText = '<!-- unsaved revision -->' + htmlText; version++;
        contentChanged({ changes: [{ text: '<!-- unsaved revision -->' }] });
        a = htmlText.indexOf('ABCDEFGHIJ'); b = a + 10;
        callbacks.forEach(callback => callback());
      };
      const div = document.querySelector('.page'); div.querySelector('span').textContent = pdfText;
      window.makePdf = () => ({ numPages: 1, async getPage() { return {
        async getTextContent() { return { items: [{ str: pdfText, transform: [1, 0, 0, 1, 0, 500], width: 800, height: 24 }] }; }
      }; } });
      window.mockViewer = {
        container: document.getElementById('stage'), viewer: document.querySelector('.pdfViewer'), currentPageNumber: 1,
        _getVisiblePages: () => ({ views: [{ id: 1 }] }), getPageView: () => ({ div }),
        eventBus: { on() {}, off() {} }, pdfDocument: makePdf()
      };
      window.originalPdf = mockViewer.pdfDocument;
      PdfSelection.attachViewer(mockViewer);
      PdfSelection.attachEditor({
        onDidChangeCursorSelection(callback) { callbacks.push(callback); return { dispose() {} }; },
        onDidChangeModelContent(callback) { window.contentChanged = callback; return { dispose() {} }; },
        getModel: () => model, getSelections: () => [{ getStartPosition: () => a, getEndPosition: () => b }], hasTextFocus: () => false, getDomNode: () => div,
        setSelection(range) { editorTargets.push(htmlText.slice(range.startColumn - 1, range.endColumn - 1)); callbacks.forEach(callback => callback()); }
      });
    });
    await page.waitForFunction(() => window.preparedDiffs >= 1);
    assert.equal(await page.locator('.mew-pdf-selection-highlight > div').count(), 0, 'maps are built with no initial selection');
    const initialDiffs = await page.evaluate(() => preparedDiffs);
    await page.evaluate(() => {
      const range = document.createRange(), node = document.querySelector('.textLayer span').firstChild, start = pdfText.indexOf('5/refiern');
      range.setStart(node, start); range.setEnd(node, start + '5/refiern'.length);
      const selection = document.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    });
    await page.waitForFunction(() => editorTargets.length > 0);
    assert.equal(await page.evaluate(() => editorTargets.at(-1)), 'Strebern', 'reverse selection works before any forward selection');
    await page.evaluate(() => document.getSelection().removeAllRanges());
    await page.evaluate(() => selectHtml('Strebern'));
    await page.waitForFunction(() => PdfSelection.status.state === 'idle' && PdfSelection.status.mode === 'exact');
    assert.deepEqual(await page.evaluate(() => PdfSelection.status.differences.map(({ html, pdf }) => ({ html, pdf }))), [{ html: 'Strebern', pdf: '5/refiern' }]);
    assert.equal(await page.evaluate(() => preparedDiffs), initialDiffs, 'first selection reuses the startup alignment');
    await page.waitForFunction(() => window.lastNotice?.notices[0]?.pdf === '5/refiern');
    const compared = await page.evaluate(() => diffCalls);
    await page.evaluate(() => selectHtml('Meine'));
    assert.equal(await page.locator('.mew-pdf-selection-difference').count(), 0);
    await page.evaluate(() => selectHtml('Strebern'));
    await page.waitForFunction(() => window.lastNotice?.notices[0]?.pdf === '5/refiern');
    assert.equal(await page.evaluate(() => diffCalls), compared, 'returning to a cached selection reuses its popup comparison');
    const boxes = await page.evaluate(() => {
      const range = document.createRange(), node = document.querySelector('.textLayer span').firstChild, start = pdfText.indexOf('5/refiern');
      range.setStart(node, start); range.setEnd(node, start + '5/refiern'.length);
      return { expected: [...range.getClientRects()].map(box => ({ x: box.x, y: box.y, width: box.width })),
        actual: [...document.querySelectorAll('.mew-pdf-selection-highlight > div')].map(mark => { const box = mark.getBoundingClientRect(); return { x: box.x, y: box.y, width: box.width }; }) };
    });
    assert.equal(boxes.actual.length, boxes.expected.length);
    for (let i = 0; i < boxes.expected.length; i++) for (const key of ['x', 'y', 'width']) assert.ok(Math.abs(boxes.expected[i][key] - boxes.actual[i][key]) < 1, JSON.stringify(boxes));
    await page.evaluate(() => { document.getSelection().removeAllRanges(); pdfText = pdfText.replace('5/refiern', 'CORRUPTED'); document.querySelector('.textLayer span').textContent = pdfText; mockViewer.pdfDocument = makePdf(); selectHtml('Strebern'); });
    await page.waitForFunction(() => PdfSelection.status.state === 'idle' && PdfSelection.status.differences[0]?.pdf === 'CORRUPTED');
    assert.equal(await page.evaluate(() => PdfSelection.status.differences[0]?.pdf), 'CORRUPTED', 'new PDF uses a fresh alignment');
    await page.evaluate(() => selectHtml('Strebern', 'ABCDEFGHIJ'));
    await page.waitForFunction(() => PdfSelection.status.state === 'idle' && PdfSelection.status.differences[0]?.html === 'ABCDEFGHIJ');
    assert.equal(await page.evaluate(() => PdfSelection.status.differences[0]?.html), 'ABCDEFGHIJ', 'source edit replaces the previous alignment');
    const readsBeforeTyping = await page.evaluate(() => {
      const reads = sourceReads;
      for (let i = 0; i < 20; i++) editHtml();
      return { reads, after: sourceReads, prepared: preparedDiffs, overlays: document.querySelectorAll('.mew-pdf-selection-highlight').length };
    });
    assert.equal(readsBeforeTyping.after, readsBeforeTyping.reads, 'typing and its cursor events defer source parsing');
    assert.equal(readsBeforeTyping.overlays, 0, 'edits clear highlights from the previous source version');
    await page.waitForFunction(() => PdfSelection.status.mode === 'exact' && PdfSelection.status.differences[0]?.html === 'ABCDEFGHIJ');
    assert.equal(await page.evaluate(() => sourceReads), readsBeforeTyping.reads + 1, 'the edit burst rebuilds only the latest source version');
    assert.equal(await page.evaluate(() => preparedDiffs), readsBeforeTyping.prepared, 'comment-only edits reuse the unchanged text alignment');
    const reverseSelections = await page.evaluate(() => editorTargets.length);
    await page.evaluate(() => {
      const range = document.createRange(), node = document.querySelector('.textLayer span').firstChild, start = pdfText.indexOf('CORRUPTED');
      range.setStart(node, start); range.setEnd(node, start + 'CORRUPTED'.length);
      const selection = document.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    });
    await page.waitForFunction(count => editorTargets.length > count, reverseSelections);
    assert.equal(await page.evaluate(() => editorTargets.at(-1)), 'ABCDEFGHIJ', 'retained alignment maps to the source after comments shift its offsets');
    await page.evaluate(() => document.getSelection().removeAllRanges());
    const pacedReads = await page.evaluate(() => sourceReads);
    for (let i = 0; i < 4; i++) {
      await page.evaluate(() => editHtml());
      await page.waitForTimeout(140);
      assert.equal(await page.evaluate(() => sourceReads), pacedReads, 'normal typing pauses must not start source parsing');
    }
    await page.waitForFunction(reads => sourceReads === reads + 1, pacedReads);
    await page.evaluate(() => { editHtml(); PdfSelection.stop(); });
    await page.waitForTimeout(150);
    assert.equal(await page.evaluate(() => sourceReads), pacedReads + 1, 'stopping cancels deferred edit processing');
  } finally { await browser.close(); }
});

test('browser reveals a bottom-of-page selection without exposing the next page', async () => {
  const browser = await chromium.launch({ executablePath: process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<div id="stage" style="height:300px;width:700px;overflow:auto;position:relative"><div class="pdfViewer">
      <div class="page" data-page-number="1" style="height:700px;position:relative"><div class="textLayer" style="padding-top:675px"><span>A unique passage with a bottom word to reveal.</span></div></div>
      <div class="page" data-page-number="2" style="height:700px;position:relative"></div>
    </div></div>`);
    await page.addScriptTag({ content: engineSource });
    await page.addScriptTag({ content: source });
    await page.evaluate(() => {
      const container = document.getElementById('stage'), div = container.querySelector('.page');
      const text = div.textContent, selected = text.indexOf('bottom');
      window.mockViewer = {
        container, viewer: container.firstElementChild, currentPageNumber: 1,
        eventBus: { on() {}, off() {} }, getPageView: index => ({ div: container.querySelectorAll('.page')[index] }),
        pdfDocument: { numPages: 1, async getPage() {
          return { async getTextContent() { return { items: [{ str: text, transform: [1,0,0,1,0,10], width: 500, height: 18 }] }; } };
        } }
      };
      PdfSelection.attachViewer(mockViewer);
      PdfSelection.attachEditor({
        onDidChangeCursorSelection() { return { dispose() {} }; },
        getModel: () => ({ getValue: () => text, getValueInRange: () => 'bottom', getOffsetAt: position => position }),
        getSelections: () => [{ getStartPosition: () => selected, getEndPosition: () => selected + 6 }],
        hasTextFocus: () => true
      });
    });
    await page.waitForFunction(() => PdfSelection.status.state === 'idle' && PdfSelection.status.mode === 'exact');
    const result = await page.evaluate(() => {
      const container = mockViewer.container, rect = container.getBoundingClientRect();
      const mark = document.querySelector('.mew-pdf-selection-highlight > div').getBoundingClientRect();
      return { scroll: container.scrollTop, top: mark.top, bottom: mark.bottom,
        viewportTop: rect.top, viewportBottom: rect.top + container.clientHeight,
        nextPageTop: container.querySelectorAll('.page')[1].getBoundingClientRect().top };
    });
    assert.ok(result.scroll > 0, 'offscreen selection is revealed');
    assert.ok(result.top >= result.viewportTop && result.bottom <= result.viewportBottom + 1, 'selection stays visible');
    assert.ok(result.nextPageTop >= result.viewportBottom - 1, 'automatic reveal keeps the next page outside the viewport');
  } finally { await browser.close(); }
});

test('browser selects one contextual occurrence, scrolls offscreen, and retains ambiguous fallback', async () => {
  const browser = await chromium.launch({ executablePath: process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<div id="stage" style="height:300px;width:700px;overflow:auto;position:relative"><div class="pdfViewer">
      <div class="page" data-page-number="1" style="height:700px;position:relative"><div class="textLayer"><span>Other work appears here; more work appears here.</span></div></div>
      <div class="page" data-page-number="2" style="height:700px;position:relative"><div class="textLayer" style="padding-top:180px"><span>The workers finish their work before returning home.</span></div></div>
    </div></div>`);
    await page.addScriptTag({ content: engineSource });
    await page.addScriptTag({ content: source });
    await page.evaluate(() => {
      const pages = [...document.querySelectorAll('.page')];
      const text = pages.map(div => div.querySelector('span').textContent);
      const listeners = new Map();
      const container = document.getElementById('stage');
      window.scrolls = [];
      window.moves = [];
      const scrollBy = container.scrollBy.bind(container);
      container.scrollBy = options => { window.moves.push(options); scrollBy(options); };
      window.walks = 0;
      const walker = document.createTreeWalker.bind(document);
      document.createTreeWalker = (...args) => { window.walks++; return walker(...args); };
      window.mockViewer = {
        container, viewer: container.firstElementChild, currentPageNumber: 1,
        eventBus: { on(name, callback) { listeners.set(name, callback); }, off() {} },
        getPageView: index => ({ div: pages[index] }),
        pdfDocument: { numPages: 2, async getPage(number) {
          return { async getTextContent() { return { items: [{ str: text[number - 1], transform: [1, 0, 0, 1, 0, 520], width: 500, height: 18 }] }; } };
        } },
        scrollPageIntoView(destination) {
          window.scrolls.push(destination); this.currentPageNumber = destination.pageNumber;
          container.scrollTop = pages[destination.pageNumber - 1].offsetTop;
          listeners.get('updateviewarea')?.();
        }
      };
      container.addEventListener('scroll', () => listeners.get('updateviewarea')?.());
      window.callbacks = [];
      const selected = text[1].indexOf('work before');
      window.mockEditor = {
        onDidChangeCursorSelection(callback) { window.callbacks.push(callback); return { dispose() {} }; },
        getModel: () => ({ getValue: () => text[1], getValueInRange: () => 'work', getOffsetAt: position => position }),
        getSelections: () => [{ getStartPosition: () => selected, getEndPosition: () => selected + 4 }],
        hasTextFocus: () => true
      };
      PdfSelection.attachViewer(window.mockViewer);
      PdfSelection.attachEditor(window.mockEditor);
    });
    await page.waitForFunction(() => PdfSelection.status.state === 'idle' && PdfSelection.status.mode === 'exact');
    let result = await page.evaluate(() => ({ status: PdfSelection.status, scrolls: window.scrolls, moves: window.moves.length, top: document.querySelector('.mew-pdf-selection-highlight > div').getBoundingClientRect().top }));
    assert.equal(result.status.matches, 1);
    assert.equal(result.scrolls.length, 0);
    assert.equal(result.moves, 1);
    assert.ok(Math.abs(result.top - 56) < 3);
    await page.evaluate(() => { callbacks[0](); });
    await page.waitForFunction(() => PdfSelection.status.state === 'idle');
    assert.equal(await page.evaluate(() => window.moves.length), 1, 'visible selection must not scroll');
    const walks = await page.evaluate(() => {
      window.overlay = document.querySelector('.mew-pdf-selection-highlight');
      mockViewer.container.scrollTop -= 20;
      return window.walks;
    });
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate(() => window.walks), walks, 'scroll reuses text coordinates');
    assert.equal(await page.evaluate(() => window.overlay === document.querySelector('.mew-pdf-selection-highlight')), true, 'scroll reuses overlay');
    await page.evaluate(() => { mockViewer.container.scrollTop = 1100; });
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate(() => window.moves.length), 1, 'manual scrolling must not pull the PDF back');
    await page.evaluate(() => { callbacks[0](); });
    await page.waitForFunction(() => PdfSelection.status.state === 'idle');
    assert.equal(await page.evaluate(() => window.moves.length), 2, 'offscreen word on a visible page must scroll');
    await page.evaluate(() => {
      document.querySelector('.page[data-page-number="2"] span').textContent = 'Changed OCR context. work then a different ending.';
      callbacks[0]();
    });
    await page.waitForFunction(() => PdfSelection.status.state === 'idle');
    assert.equal(await page.locator('.mew-pdf-selection-highlight > div').count(), 1);
    await page.evaluate(() => {
      mockViewer.container.scrollTop = 0; mockViewer.currentPageNumber = 1;
      PdfSelection.highlight('work');
    });
    await page.waitForFunction(() => PdfSelection.status.state === 'idle' && PdfSelection.status.mode === 'fallback');
    result = await page.evaluate(() => ({ status: PdfSelection.status, scrolls: window.scrolls.length }));
    assert.equal(result.status.matches, 2);
    assert.equal(result.scrolls, 0);
    assert.equal(await page.evaluate(() => window.moves.length), 2);
    await page.evaluate(() => {
      callbacks[0](); PdfSelection.clear();
    });
    await page.waitForTimeout(350);
    assert.equal(await page.locator('.mew-pdf-selection-highlight').count(), 0);
    await page.evaluate(() => {
      mockViewer.pdfDocument = { numPages: 1, async getPage() {
        window.started = true;
        await new Promise(resolve => { window.release = resolve; });
        return { async getTextContent() { return { items: [{ str: 'unique', transform: [1, 0, 0, 1, 0, 520], width: 50, height: 18 }] }; } };
      } };
      PdfSelection.highlight('work');
    });
    await page.waitForFunction(() => window.started);
    // Highlights must remain available while document text is still loading.
    assert.equal(await page.locator('.mew-pdf-selection-highlight > div').count(), 2);
    await page.evaluate(() => { PdfSelection.clear(); window.release(); });
    await page.waitForTimeout(350);
    assert.equal(await page.evaluate(() => window.scrolls.length), 0);
    assert.equal(await page.locator('.mew-pdf-selection-highlight').count(), 0);
    await page.evaluate(() => {
      mockViewer.pdfDocument = { numPages: 1, async getPage() { throw new Error('Unavailable page text'); } };
      PdfSelection.highlight('work');
    });
    await page.waitForFunction(() => PdfSelection.status.state === 'idle' && PdfSelection.status.mode === 'fallback');
    assert.equal(await page.locator('.mew-pdf-selection-highlight > div').count(), 2);
    await page.evaluate(() => PdfSelection.stop());
  } finally { await browser.close(); }
});


test('PDF selection reveals matching Monaco source without stealing focus or feeding back', async () => {
  const browser = await chromium.launch({ executablePath: process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: true });
  try {
    const shared = 'Common surrounding words. '.repeat(9) + 'work' + ' Identical following words.'.repeat(9);
    const first = 'First page introduction. '.repeat(10) + shared + ' First page conclusion.'.repeat(10);
    const second = 'Second page introduction. '.repeat(10) + shared + ' Second page conclusion.'.repeat(10);
    for (const fixture of [
      { source: '<head><title>working</title></head><p>We are <b>working</b> together.</p>', pages: ['We are working together.'], text: 'ork', expected: 'ork' },
      { source: '<p>Before <i title="a > b">work</i> &amp; rest after.</p>', pages: ['Before work & rest after.'], text: 'work & rest', expected: 'work</i> &amp; rest' },
      { source: '<!--国文--><p>这是中<b>国</b>文字的例子。</p>', pages: ['这是中国文字的例子。'], text: '国文', expected: '国</b>文' },
      { source: '<p>甲&#x20000;乙丙</p>', pages: ['甲𠀀乙丙'], text: '𠀀乙', expected: '&#x20000;乙' },
      { source: '<p>Other work appears here.</p>\r\n<p>The workers finish their <b>work</b> before returning home.</p>', pages: ['The workers finish their work before returning home.'], text: 'work', at: 25, expected: 'work', split: true },
      { source: '<p>Die schier unerschöpliche Streit- und Parteifrage.</p>', pages: ['Die schier unerschöpfliche Streit- und Parteifrage.'], text: 'schöpfliche', expected: 'schöpliche' },
      { source: '<p>' + germanBefore + germanSelection.replace('wiederholt', 'vérités') + germanAfter + '</p>', pages: [germanBefore + germanSelection.replace('wiederholt', 'verites') + germanAfter], text: 'verites', expected: 'vérités', differs: true },
      { source: '<p>We are working together today.</p>', pages: ['We are work-', 'ing together today.'], text: 'work-\ning together', expected: 'working together' },
      { source: `<p>${germanBefore + germanSelection.replace('Karlsbad)', 'Karlsbad<a id="A27"></a>)') + germanAfter}</p>`,
        pages: [germanBefore + germanPdfSelection + germanAfter], text: germanPdfSelection,
        expected: germanSelection.replace('Karlsbad)', 'Karlsbad<a id="A27"></a>)') },
      { source: `<p>选区之前的上下文必须完整保留${chineseSelection.slice(0, 80)}<a id="note"></a><i>${chineseSelection.slice(80)}</i>选区之后的上下文必须完整保留</p>`,
        pages: ['选区之前的上下文必须完整保留' + chineseSelection.slice(0, 80) + '[27]' + chineseSelection.slice(80) + '选区之后的上下文必须完整保留'],
        text: chineseSelection.slice(0, 80) + '[27]' + chineseSelection.slice(80), expected: chineseSelection.slice(0, 80) + '<a id="note"></a><i>' + chineseSelection.slice(80) },
      { source: `<p>${first}</p><p>${second}</p>`, pages: [first, second], selectPage: 1, text: 'work', expected: 'work' },
      { source: `<p>${first}</p><p>${second}</p>`, pages: [first, second], selectPage: 0, text: 'work', expected: 'work', expectedAt: ('<p>' + first).indexOf('work') },
      { source: `<p>${first}</p><p>${second}</p>`, pages: ['Running header 1. ' + first, 'Running header 2. ' + second], selectPage: 1, text: 'work', expected: 'work' },
      { source: '<p>work</p><p>work</p>', pages: ['work'], text: 'work', expected: null },
      { source: '<p>Unrelated text.</p>', pages: ['Missing passage.'], text: 'Missing', expected: null }
    ]) {
      const page = await browser.newPage();
      await page.setContent('<button id="pdfFocus">PDF focus</button><div id="stage"><div class="pdfViewer"></div></div><p id="outside">Other work appears here.</p>');
      await page.evaluate(fixture => {
        const root = document.querySelector('.pdfViewer');
        for (const text of fixture.pages) {
          const div = document.createElement('div'); div.className = 'page';
          div.innerHTML = '<div class="textLayer"><span></span></div>';
          div.querySelector('span').textContent = text; root.append(div);
        }
      }, fixture);
      await page.addScriptTag({ content: engineSource });
      await page.addScriptTag({ content: source });
      await page.evaluate(fixture => {
        window.targets = []; window.selectionReads = 0; window.reveals = []; window.sourceReads = 0;
        const model = {
          getValue: () => { sourceReads++; return fixture.source; }, getVersionId: () => 1,
          getPositionAt(offset) {
            const lines = fixture.source.slice(0, offset).split(/\r\n|\r|\n/);
            return { lineNumber: lines.length, column: lines.at(-1).length + 1 };
          }
        };
        const callbacks = [];
        window.mockEditor = {
          onDidChangeCursorSelection(callback) { callbacks.push(callback); return { dispose() {} }; },
          hasTextFocus: () => false, getDomNode: () => document.getElementById('stage'), getModel: () => model,
          getSelections() { selectionReads++; return []; },
          setSelection(range) { targets.push(range); callbacks.forEach(callback => callback()); },
          revealRangeInCenterIfOutsideViewport(range) { reveals.push(range); }
        };
        PdfSelection.attachEditor(mockEditor);
        if (fixture.split) {
          window.paired = window.open('', 'mew-editor-test');
          paired.mewWorkbench = { editor: mockEditor };
          // The reader's own hidden editor must not receive the selection.
          PdfSelection.attachEditor({ ...mockEditor, setSelection() { throw new Error('Selected the hidden editor'); } });
        }
        PdfSelection.attachViewer({
          container: document.querySelector('#stage'), viewer: document.querySelector('.pdfViewer'),
          eventBus: { on() {}, off() {} }, getPageView() {}
        });
        document.getElementById('pdfFocus').focus();
        const nodes = [...document.querySelectorAll('.textLayer span')].map(span => span.firstChild);
        const range = document.createRange();
        const selectedPage = fixture.selectPage ?? 0, endPage = fixture.selectPage ?? nodes.length - 1;
        const start = fixture.at ?? fixture.pages[selectedPage].indexOf(fixture.text.split('\n')[0]);
        range.setStart(nodes[selectedPage], start);
        range.setEnd(nodes[endPage], endPage !== selectedPage ? fixture.text.split('\n').at(-1).length : start + fixture.text.length);
        const selection = document.getSelection(); selection.removeAllRanges(); selection.addRange(range);
      }, fixture);
      if (fixture.expected !== null) await page.waitForFunction(() => targets.length > 0).catch(error => { console.log('Reverse fixture:', fixture); throw error; });
      else await page.waitForTimeout(100);
      const result = await page.evaluate(() => ({ targets, reveals, selectionReads, focused: document.activeElement.id, pdf: document.getSelection().toString() }));
      if (fixture.expected === null) assert.equal(result.targets.length, 0);
      else {
        const offset = fixture.expectedAt ?? fixture.source.lastIndexOf(fixture.expected);
        const position = offset => {
          const lines = fixture.source.slice(0, offset).split(/\r\n|\r|\n/);
          return { line: lines.length, column: lines.at(-1).length + 1 };
        };
        const a = position(offset), b = position(offset + fixture.expected.length);
        assert.deepEqual(result.targets.at(-1), { startLineNumber: a.line, startColumn: a.column, endLineNumber: b.line, endColumn: b.column }, JSON.stringify(fixture));
        assert.deepEqual(result.reveals, result.targets);
        await page.evaluate(() => document.dispatchEvent(new Event('selectionchange')));
        assert.equal(await page.evaluate(() => sourceReads), 1, 'unchanged multi-page HTML reuses its source index');
        result.targets = await page.evaluate(() => targets);
      }
      assert.equal(result.selectionReads, 0, 'programmatic selection must not trigger forward sync');
      assert.equal(result.focused, 'pdfFocus', 'focus stays in the PDF');
      assert.ok(result.pdf.length, 'native PDF selection remains intact');
      const differs = fixture.differs || fixture.text === 'schöpfliche' || fixture.text === germanPdfSelection || fixture.text.includes('[27]');
      if (fixture.expected === null || differs) {
        await page.waitForFunction(() => window.lastNotice);
        const notice = await page.evaluate(() => lastNotice.notices[0]);
        if (fixture.expected === null) assert.match(notice.message, /No reliable HTML match/);
        if (differs) assert.equal(typeof notice.html, 'string');
      } else assert.equal(await page.evaluate(() => PdfSelection.status.differences.length), 0);
      await page.evaluate(() => document.getSelection().removeAllRanges());
      await page.waitForFunction(() => !window.lastNotice);

      await page.evaluate(() => {
        const range = document.createRange(); range.selectNodeContents(document.querySelector('#outside'));
        document.getSelection().removeAllRanges(); document.getSelection().addRange(range);
      });
      await page.waitForTimeout(30);
      assert.equal(await page.evaluate(() => targets.length), result.targets.length, 'selections outside PDF are ignored');
      await page.evaluate(() => { PdfSelection.stop(); document.dispatchEvent(new Event('selectionchange')); window.paired?.close(); });
      assert.equal(await page.evaluate(() => targets.length), result.targets.length, 'stop removes reverse listener');
      await page.close();
    }
  } finally { await browser.close(); }
});

test('ready OCR layer highlights partial words through full-file selections within 10 ms without rebuilding text mappings', async () => {
  const browser = await chromium.launch({ executablePath: process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: true });
  try {
    for (const damaged of [false, true]) {
      const page = await browser.newPage();
      await page.setContent('<div id="stage" style="height:500px;width:900px;overflow:auto"><div class="pdfViewer"><div class="page" style="position:relative"><div class="textLayer"></div></div></div></div>');
      await page.evaluate(() => {
        const layer = document.querySelector('.textLayer');
        for (let i = 0; i < 1500; i++) {
          const span = document.createElement('span');
          span.textContent = `Token${String(i).padStart(4, '0')} `; layer.append(span);
        }
      });
      await page.addScriptTag({ content: engineSource });
      await page.addScriptTag({ content: source });
      await page.evaluate(damaged => {
        const div = document.querySelector('.page'), source = div.textContent;
        let selected = 0, length = 9;
        window.walks = 0;
        const walker = document.createTreeWalker.bind(document);
        document.createTreeWalker = (...args) => { walks++; return walker(...args); };
        window.rangeReads = 0;
        const rects = Range.prototype.getClientRects;
        Range.prototype.getClientRects = function () { rangeReads++; return rects.call(this); };
        PdfSelection.attachViewer({
          container: document.getElementById('stage'), viewer: document.querySelector('.pdfViewer'), currentPageNumber: 1,
          _getVisiblePages: () => ({ views: [{ id: 1 }] }), getPageView: () => ({ div }),
          eventBus: { on() {}, off() {} },
          pdfDocument: { numPages: 100, async getPage(number) { return {
            async getTextContent() { return { items: [{ str: number === 1 ? source : `Archive ${number}. ` + 'Other background words. '.repeat(500), transform: [1, 0, 0, 1, 0, 500], width: 900, height: 18 }] }; }
          }; } }
        });
        window.sourceReads = 0;
        const html = damaged ? source.replace(/Token(\d+)/g, (token, number) => Number(number) % 37 === 20 ? token.replace('o', '0') : token) : source;
        const model = { getValue: () => { sourceReads++; return html; }, getVersionId: () => 1, getOffsetAt: position => position };
        PdfSelection.attachEditor({
          onDidChangeCursorSelection(callback) { window.selectWord = (i, size) => { selected = i * 10; length = size; callback(); }; return { dispose() {} }; },
          getModel: () => model,
          getSelections: () => [{ getStartPosition: () => selected, getEndPosition: () => selected + length }], hasTextFocus: () => true
        });
      }, damaged);
      await page.waitForFunction(() => PdfSelection.status.state === 'idle' && PdfSelection.status.mode === 'exact');
      const result = await page.evaluate(async () => {
        const initialWalks = walks, initialRanges = rangeReads, timings = [];
        for (let i = 0; i < 100; i++) {
          // Allow the previous popup to render between user selection events.
          await new Promise(resolve => requestAnimationFrame(resolve));
          document.querySelector('.mew-pdf-selection-difference')?.getBoundingClientRect();
          await new Promise(resolve => {
            const start = performance.now();
            const done = event => {
              if (event.detail.state !== 'idle') return;
              window.removeEventListener('pdf-selection-highlight-status', done);
              const mark = document.querySelector('.mew-pdf-selection-highlight > div');
              if (!mark?.getBoundingClientRect().width) throw new Error('Missing highlight');
              timings.push(performance.now() - start); resolve();
            };
            window.addEventListener('pdf-selection-highlight-status', done);
            const size = [1, 3, 9, 19, 100, 1000, 5000, 12000, 14000, 15000][i % 10];
            selectWord(size === 15000 ? 0 : i % 20, size);
          });
        }
        timings.sort((a, b) => a - b);
        return { p50: timings[50], p95: timings[95], max: timings.at(-1), walks: walks - initialWalks, rangeReads: rangeReads - initialRanges, sourceReads };
      });
      console.log(`Ready-layer selection latency (${damaged ? 'OCR differences' : 'exact'}, 100 selections, 100 pages, 1500 spans, up to 15 KB):`, result);
      assert.equal(result.walks, 0, 'new selections reuse OCR node and normalized-text mappings');
      assert.equal(result.sourceReads, 1, 'ready selections reuse the same Monaco model version');
      assert.ok(result.rangeReads <= 20, 'repeated selections reuse geometry for the 20 distinct ranges');
      assert.ok(result.max < 10, `selection-to-highlight layout took ${result.max.toFixed(2)} ms`);
      if (damaged) {
        await page.evaluate(() => selectWord(0, 14000));
        await page.waitForFunction(() => window.lastNotice);
        const published = await page.evaluate(() => ({
          notice: { html: lastNotice.notices[0].html, pdf: lastNotice.notices[0].pdf },
          difference: PdfSelection.status.differences[0]
        }));
        assert.deepEqual(published.notice, { html: published.difference.html, pdf: published.difference.pdf });
        await page.evaluate(() => PdfSelection.clear());
        assert.equal(await page.evaluate(() => window.lastNotice), null);
        await page.evaluate(async () => {
          selectWord(0, 14000); PdfSelection.clear();
          await new Promise(resolve => setTimeout(resolve, 20));
        });
        assert.equal(await page.evaluate(() => window.lastNotice), null, 'a deferred event cannot revive a cleared selection');
      }
      await page.close();
    }
  } finally { await browser.close(); }
});


test('15 KB character diffs complete within 50 ms with complete Unicode traceback', async () => {
  const browser = await chromium.launch({ executablePath: process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: true });
  try {
    const page = await browser.newPage();
    await page.addScriptTag({ content: engineSource });
    const latin = Array.from({ length: 1500 }, (_, i) => `Token${String(i).padStart(4, '0')} `).join('');
    const phrase = '德文 Straße 中文𠀀 OCR 校对。';
    const unicode = phrase.repeat(Math.floor(15000 / Buffer.byteLength(phrase)));
    const fixtures = [latin, unicode + 'x'.repeat(15000 - Buffer.byteLength(unicode))];
    const result = await page.evaluate(({ fixtures }) => {
      const diff = PdfSelectionDiff.textDiff;
      const results = [];
      for (const left of fixtures) for (const kind of ['substitutions', 'mixed edits']) {
        const chars = [...left];
        let changes = 0;
        for (let i = 40; i < chars.length - 40; i += 173) {
          chars[i] = kind === 'substitutions' || changes % 3 === 0 ? '#' : changes % 3 === 1 ? '' : '#' + chars[i];
          changes++;
        }
        const right = chars.join('');
        const timings = [];
        for (let i = 0; i < 12; i++) {
          const start = performance.now(), actual = diff(left, right, true);
          timings.push(performance.now() - start);
          if (actual.distance !== changes || actual.parts.map(part => part.html).join('') !== left
            || actual.parts.map(part => part.pdf).join('') !== right) throw new Error('Incorrect full-file alignment');
        }
        timings.sort((a, b) => a - b);
        results.push({ kind, bytes: new TextEncoder().encode(left).length, edits: changes, p50: timings[6], max: timings.at(-1) });
      }
      return results;
    }, { fixtures });
    console.log('15 KB complete character diff latency:', result);
    for (const sample of result) assert.ok(sample.max < 50, `15 KB diff took ${sample.max.toFixed(2)} ms`);
  } finally { await browser.close(); }
});

test('ME34-010 and ME34-014 prepared OCR differences highlight before whole-PDF extraction', async () => {
  // Captured from MEW_BRIEF/34 and mew_band34.pdf pages 34, 35, 38 with PDF.js 6.2.108.
  // Positioned OCR spans use real item transforms; the reader and PDF canvas are mocked.
  const fixtures = JSON.parse(await readFile(new URL('../tests/fixtures/pdf-selection-me34.json', import.meta.url), 'utf8'));
  const browser = await chromium.launch({ executablePath: process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: true });
  try {
    for (const fixture of fixtures) {
      const page = await browser.newPage();
      await page.setContent('<div id="stage" style="height:1100px;width:1600px;overflow:auto"><div class="pdfViewer" style="display:flex"></div></div>');
      await page.addScriptTag({ content: countedEngineSource });
      await page.addScriptTag({ content: source });
      await page.evaluate(({ html, pages }) => {
        for (const { number, items } of pages) {
          const div = document.createElement('div'); div.className = 'page'; div.dataset.pageNumber = number;
          div.style.cssText = 'position:relative;width:800px;height:1000px;flex-shrink:0';
          const layer = document.createElement('div'); layer.className = 'textLayer'; div.append(layer);
          for (const item of items) if (item.str) {
            const span = document.createElement('span'); span.textContent = item.str;
            span.style.cssText = `position:absolute;left:${item.transform[4]}px;top:${900-item.transform[5]}px;font:${item.height}px serif;white-space:pre`;
            layer.append(span);
          }
          document.querySelector('.pdfViewer').append(div);
        }
        window.sourceReads = 0; window.extractions = 0; window.reverseTargets = [];
        let a = 0, b = 0;
        const model = { getValue: () => { sourceReads++; return html; }, getVersionId: () => 1,
          getOffsetAt: pos => pos, getPositionAt: offset => ({ lineNumber: 1, column: offset + 1 }) };
        PdfSelection.attachViewer({
          container: document.getElementById('stage'), viewer: document.querySelector('.pdfViewer'), currentPageNumber: pages[0].number,
          _getVisiblePages: () => ({ views: pages.map(({ number: id }) => ({ id })) }),
          getPageView: n => ({ div: document.querySelector(`.page[data-page-number="${n + 1}"]`) }),
          eventBus: { on() {}, off() {} }, scrollPageIntoView() {},
          pdfDocument: { numPages: 38, async getPage() { return new Promise(() => {}); } }
        });
        PdfSelection.attachEditor({
          getModel: () => model, getSelections: () => [{ getStartPosition: () => a, getEndPosition: () => b }],
          hasTextFocus: () => false, getDomNode: () => document.getElementById('stage'),
          setSelection(range) { reverseTargets.push(html.slice(range.startColumn - 1, range.endColumn - 1)); },
          onDidChangeCursorSelection(callback) {
            window.selectWord = (word, partial, last = false) => { a = (last ? html.lastIndexOf(word) : html.indexOf(word)) + (partial ? 2 : 0); b = a + (partial ? 1 : word.length); callback(); };
            return { dispose() {} };
          }
        });
        window.walks = 0;
        const walker = document.createTreeWalker.bind(document);
        document.createTreeWalker = (...args) => { walks++; return walker(...args); };
      }, { ...fixture, html: fixture.html.replace('</body>', '<p>Unrelated context before Wage and Strebern entirely unrelated ending.</p></body>') });
      await page.waitForFunction(() => window.diffCalls > 0);
      await page.evaluate(() => { window.walks = 0; });
      const result = await page.evaluate(async ({ words }) => {
        const samples = [];
        for (let repeat = 0; repeat < 10; repeat++) for (const [word, pdf] of words) for (const partial of [false, true]) {
          await new Promise(resolve => requestAnimationFrame(resolve));
          document.querySelector('.mew-pdf-selection-difference')?.getBoundingClientRect();
          const calls = diffCalls, start = performance.now();
          const sample = await new Promise(resolve => {
            const done = event => {
              if (event.detail.state !== 'idle') return;
              window.removeEventListener('pdf-selection-highlight-status', done);
              const marks = [...document.querySelectorAll('.mew-pdf-selection-highlight > div')];
              const visible = marks.every(mark => mark.getBoundingClientRect().width > 0);
              resolve({ ms: performance.now() - start, word, pdf, partial, marks: marks.length, visible,
                diffCalls: diffCalls - calls, differences: event.detail.differences });
            };
            window.addEventListener('pdf-selection-highlight-status', done); selectWord(word, partial);
          });
          samples.push(sample);
        }
        return { samples, sourceReads, walks };
      }, fixture);
      for (const sample of result.samples) {
        assert.equal(sample.marks, 1, `${fixture.name}: ${sample.word}, partial=${sample.partial}`);
        assert.ok(sample.visible);
        assert.equal(sample.diffCalls, 0, 'selection uses the prepared diff; popup comparison is deferred');
        if (!sample.partial) assert.deepEqual(sample.differences.map(({ html, pdf }) => ({ html, pdf })), [{ html: sample.word, pdf: sample.pdf }]);
      }
      const timings = result.samples.map(sample => sample.ms).sort((a, b) => a - b);
      console.log(`ME34-${fixture.name} ready OCR selection latency (whole-PDF extraction blocked):`,
        { p50: timings[Math.floor(timings.length * .5)], p95: timings[Math.floor(timings.length * .95)], max: timings.at(-1) });
      assert.ok(timings.at(-1) < 10, `${fixture.name}: highlight layout took ${timings.at(-1)} ms`);
      assert.equal(result.sourceReads, 1); assert.equal(result.walks, 0);
      for (const [word, pdf] of fixture.words) {
        await page.evaluate(pdf => {
          const node = [...document.querySelectorAll('.textLayer span')].find(span => span.textContent.includes(pdf)).firstChild;
          const at = node.textContent.indexOf(pdf), range = document.createRange();
          range.setStart(node, at); range.setEnd(node, at + pdf.length);
          const selection = document.getSelection(); selection.removeAllRanges(); selection.addRange(range);
          document.dispatchEvent(new Event('selectionchange'));
        }, pdf);
        assert.equal(await page.evaluate(() => reverseTargets.at(-1)), word, 'reverse selection uses the same prepared diff');
      }
      // This added paragraph has no matching PDF context or covering diff.
      // The last fallback must still highlight its known patched word immediately.
      const fallback = await page.evaluate(word => {
        selectWord(word, false, true);
        return [...document.querySelectorAll('.mew-pdf-selection-highlight > div')].map(mark => mark.getBoundingClientRect().width);
      }, fixture.words.at(-1)[0]);
      assert.equal(fallback.length, 1); assert.ok(fallback[0] > 0);
      await page.evaluate(() => PdfSelection.stop());
      await page.close();
    }
  } finally { await browser.close(); }
});

test('native PDF and text scrolling stays free and cancels late automatic positioning', async () => {
  const browser = await chromium.launch({ executablePath: process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<div style="display:flex;gap:20px">
      <div id="stage" tabindex="0" style="width:600px;height:260px;overflow:auto">
        <div class="pdfViewer">
          <div class="page" data-page-number="1" style="height:700px;position:relative"><div class="textLayer"><span>Unrelated first page.</span></div></div>
          <div class="page" data-page-number="2" style="height:700px;position:relative"></div>
        </div>
      </div><textarea id="text" style="width:350px;height:260px"></textarea></div>`);
    await page.addScriptTag({ content: countedEngineSource });
    await page.addScriptTag({ content: source.replace(
      '  function warm(numbers = visiblePages()) {',
      '  function warm(numbers = visiblePages()) { window.warmCalls = (window.warmCalls || 0) + 1;') });
    await page.evaluate(() => {
      const container = document.getElementById('stage'), pages = [...document.querySelectorAll('.page')];
      const html = '<p>Die schier unerschöpliche Streit- und Parteifrage.</p>';
      const pdfText = 'Die schier unerschöpfliche Streit- und Parteifrage.';
      document.getElementById('text').value = Array.from({ length: 500 }, (_, i) => `Editor line ${i}`).join('\n');
      window.sourceReads = 0; window.automaticMoves = 0; window.wheelPrevented = [];
      window.events = new Map();
      const scrollBy = container.scrollBy.bind(container);
      container.scrollBy = options => { automaticMoves++; scrollBy(options); };
      const model = { getValue: () => { sourceReads++; return html; }, getVersionId: () => 1, getOffsetAt: pos => pos };
      window.mockViewer = {
        container, viewer: container.firstElementChild, currentPageNumber: 1,
        eventBus: { on(name, callback) { events.set(name, callback); }, off() {} },
        getPageView: n => ({ div: pages[n] }),
        pdfDocument: { numPages: 2, async getPage(number) {
          if (number === 2) { window.extractionStarted = true; await new Promise(resolve => { window.releasePdf = resolve; }); }
          return { async getTextContent() { return { items: [{ str: number === 1 ? 'Unrelated first page.' : pdfText,
            transform: [1, 0, 0, 1, 0, 520], width: 500, height: 18 }] }; } };
        } },
        scrollPageIntoView(destination) { window.lastDestination = destination; automaticMoves++; container.scrollTop = 700; }
      };
      container.addEventListener('scroll', () => events.get('updateviewarea')?.());
      document.addEventListener('wheel', event => wheelPrevented.push(event.defaultPrevented), { passive: true });
      PdfSelection.attachViewer(mockViewer);
      PdfSelection.attachEditor({
        onDidChangeCursorSelection(callback) { window.selectAgain = callback; return { dispose() {} }; },
        getModel: () => model, getSelections: () => [{ getStartPosition: () => html.indexOf('schöpliche'), getEndPosition: () => html.indexOf('schöpliche') + 10 }],
        hasTextFocus: () => true, getDomNode: () => document.getElementById('text')
      });
    });
    await page.waitForFunction(() => window.extractionStarted);
    const pdfBox = await page.locator('#stage').boundingBox();
    await page.mouse.move(pdfBox.x + 200, pdfBox.y + 120);
    await page.mouse.wheel(0, 70);
    await page.waitForFunction(() => mockViewer.container.scrollTop > 0);
    const manualTop = await page.evaluate(() => mockViewer.container.scrollTop);
    await page.evaluate(() => releasePdf());
    await page.waitForFunction(() => PdfSelection.status.state === 'idle');
    assert.equal(await page.evaluate(() => automaticMoves), 0, 'completed indexing must not override manual scrolling');
    assert.equal(await page.evaluate(() => mockViewer.container.scrollTop), manualTop);
    await page.evaluate(() => {
      const div = mockViewer.getPageView(1).div;
      div.innerHTML = '<div class="textLayer" style="padding-top:80px"><span>Die schier unerschöpfliche Streit- und Parteifrage.</span></div>';
      events.get('textlayerrendered')({ pageNumber: 2 });
    });
    await page.waitForTimeout(180);
    assert.equal(await page.evaluate(() => automaticMoves), 0, 'a late text layer must not pull the viewport back');
    await page.mouse.wheel(0, 680);
    await page.waitForFunction(() => PdfSelection.status.matches === 1);
    await page.waitForTimeout(180);
    const initial = await page.evaluate(() => ({ warm: warmCalls, diff: diffCalls || 0, reads: sourceReads, top: mockViewer.container.scrollTop }));
    await page.mouse.wheel(0, 50);
    await page.waitForFunction(top => mockViewer.container.scrollTop > top, initial.top);
    await page.waitForTimeout(80);
    assert.deepEqual(await page.evaluate(() => ({ warm: warmCalls, diff: diffCalls || 0, reads: sourceReads })),
      { warm: initial.warm, diff: initial.diff, reads: initial.reads }, 'ordinary scrolling does no preparation, diff or source rebuild');
    const textBox = await page.locator('#text').boundingBox();
    await page.mouse.move(textBox.x + 100, textBox.y + 100);
    await page.mouse.wheel(0, 160);
    await page.waitForFunction(() => document.getElementById('text').scrollTop > 0);
    await page.locator('#text').focus();
    await page.keyboard.press('Control+Home');
    await page.waitForFunction(() => document.getElementById('text').scrollTop <= 2, null, { timeout: 3000 });
    const textTop = await page.locator('#text').evaluate(node => node.scrollTop);
    await page.keyboard.press('Control+End');
    await page.waitForFunction(top => document.getElementById('text').scrollTop > top, textTop, { timeout: 3000 });
    const endCaret = await page.locator('#text').evaluate(node => node.selectionStart);
    await page.keyboard.press('PageUp');
    assert.ok(await page.locator('#text').evaluate(node => node.selectionStart) < endCaret);
    await page.locator('#stage').focus();
    const beforeKey = await page.evaluate(() => mockViewer.container.scrollTop);
    await page.keyboard.press('PageUp');
    await page.waitForFunction(top => mockViewer.container.scrollTop < top, beforeKey, { timeout: 3000 });
    assert.equal(await page.evaluate(() => automaticMoves), 0);
    assert.ok(await page.evaluate(() => wheelPrevented.length >= 4 && wheelPrevented.every(prevented => !prevented)));
    await page.waitForTimeout(300); // Let the native PageUp animation finish.
    await page.evaluate(() => {
      mockViewer.getPageView(1).div.querySelector('.textLayer').remove();
      mockViewer.container.scrollTop = 700;
      selectAgain();
    });
    await page.waitForFunction(() => automaticMoves === 1);
    assert.equal(await page.evaluate(() => lastDestination.pageNumber), 2, 'a visible page without a text layer still reveals the selected PDF position');
    assert.deepEqual(await page.evaluate(() => lastDestination.destArray), [null, { name: 'XYZ' }, 0, 538, null]);
    await page.mouse.move(pdfBox.x + 200, pdfBox.y + 120);
    await page.mouse.wheel(0, 100);
    await page.waitForFunction(() => mockViewer.container.scrollTop > 700);
    await page.evaluate(() => {
      mockViewer.getPageView(1).div.innerHTML = '<div class="textLayer" style="padding-top:80px"><span>Die schier unerschöpfliche Streit- und Parteifrage.</span></div>';
      events.get('textlayerrendered')({ pageNumber: 2 });
    });
    await page.waitForTimeout(180);
    assert.equal(await page.evaluate(() => automaticMoves), 1, 'manual wheel scrolling cancels positioning when the missing layer arrives');
    const placement = await page.evaluate(() => {
      PdfReviewProvider.clearHighlights(); PdfReviewProvider.clearHighlights(true);
      mockViewer._getVisiblePages = () => ({ views: [{ id: 1 }] });
      let reads = 0, shift = 0, overlaps = 0;
      const boxes = Array.from({ length: 500 }, (_, i) => ({ left: 50 + i % 25 * 30,
        right: 70 + i % 25 * 30, top: 200 + Math.floor(i / 25) * 20, bottom: 212 + Math.floor(i / 25) * 20, height: 12 }));
      const div = mockViewer.getPageView(0).div, width = div.clientWidth, height = div.clientHeight;
      div.getBoundingClientRect = () => { reads++; return { left: 0, top: -shift, width, height }; };
      const painted = PdfReviewProvider.paintHighlight(div, boxes.map(box => ({
        x: box.left / width, y: box.top / height, w: (box.right - box.left) / width, h: box.height / height
      })), 'yellow');
      for (const mark of painted.node.children) mark.getBoundingClientRect = () => { throw new Error('Scrolling must reuse highlight coordinates'); };
      for (let i = 0; i < 20; i++) {
        shift = i * 2;
        const result = PdfSelection.popupPlacement({ left: 50, top: 200 - shift, bottom: 592 - shift },
          { left: 0, right: 1000, top: 0, bottom: 900 }, 280, 120);
        if (!result) throw new Error('The popup must fit above or below this passage');
        overlaps += boxes.filter(box => box.left < result.left + 280 && box.right > result.left
          && box.top - shift < result.top + result.height && box.bottom - shift > result.top).length;
      }
      painted.node.remove();
      return { reads, overlaps };
    });
    assert.equal(placement.overlaps, 0, 'scrolling popup placement avoids every selected word');
    assert.equal(placement.reads, 20, 'scrolling reads one page rectangle per frame, regardless of selection length');
    await page.evaluate(() => PdfSelection.stop());
  } finally { await browser.close(); }
});


test('scrolling across retained PDF pages bounds DOM caches and revisits rebuild current highlights', async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<div id="stage" style="height:500px;overflow:auto"><div class="pdfViewer"></div></div>');
    await page.evaluate(() => {
      for (let number = 1; number <= 70; number++) {
        const div = document.createElement('div');
        div.className = 'page'; div.dataset.pageNumber = number;
        div.style.cssText = 'position:relative;width:600px;height:100px';
        div.innerHTML = `<div class="textLayer"><span>Page ${number} text</span></div>`;
        document.querySelector('.pdfViewer').append(div);
      }
    });
    await page.addScriptTag({ content: engineSource });
    await page.addScriptTag({ content: source.replace('  const layers = new Map();',
      '  const layers = new Map(); window.cacheProbe = { layerIndex, nativeBoxes, size: () => layers.size, results: div => pageResults.get(div)?.results.size };') });
    await page.waitForFunction(() => !!window.PdfSelection);
    const result = await page.evaluate(() => {
      const pages = [...document.querySelectorAll('.page')];
      PdfSelection.attachViewer({ container: document.getElementById('stage'), viewer: document.querySelector('.pdfViewer'),
        currentPageNumber: 1, _getVisiblePages: () => ({ views: [{ id: 1 }] }),
        getPageView: index => ({ div: pages[index] }), eventBus: { on() {}, off() {} },
        pdfDocument: { numPages: 0 } });
      const first = cacheProbe.layerIndex(pages[0]);
      for (const div of pages) cacheProbe.layerIndex(div);
      const retained = cacheProbe.size();
      const revisited = cacheProbe.layerIndex(pages[0]);
      const rebuilt = first !== revisited;
      const makeSource = () => PdfSelection.locator.sourceIndex(revisited.raw);
      const original = makeSource();
      const target = { index: original, start: 0, end: 4, range: { start: 0, end: 4 } };
      for (let i = 0; i < 80; i++) cacheProbe.nativeBoxes(pages[0], [], [{ ...target, text: String(i) }]);
      const results = cacheProbe.results(pages[0]);
      const refreshed = makeSource();
      const boxes = cacheProbe.nativeBoxes(pages[0], [], [{ ...target, index: refreshed }]);
      const currentSource = boxes.notices[0].source.index === refreshed;
      const reuse = boxes === cacheProbe.nativeBoxes(pages[0], [], [{ ...target, index: refreshed }]);
      PdfSelection.stop();
      return { retained, rebuilt, results, currentSource, reuse, afterStop: cacheProbe.size(), boxes: boxes.boxes.length };
    });
    assert.equal(result.retained, 24);
    assert.equal(result.rebuilt, true, 'evicted pages build a fresh node index when revisited');
    assert.equal(result.results, 32);
    assert.equal(result.currentSource, true, 'cached notices never retain an obsolete source snapshot');
    assert.equal(result.reuse, true, 'unchanged selections reuse measured geometry');
    assert.ok(result.boxes > 0, 'revisited pages still paint the selected text');
    assert.equal(result.afterStop, 0, 'stopping releases retained layer observers');
  } finally { await browser.close(); }
});
