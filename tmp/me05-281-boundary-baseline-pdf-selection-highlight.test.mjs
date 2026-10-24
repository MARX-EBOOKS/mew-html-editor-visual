import assert from 'node:assert/strict';

import vm from 'node:vm';
import test from 'node:test';
import { engineSource, highlightSelectionSource as source, locator } from './me05-281-boundary-baseline-harness.mjs';
const testLocator = locator();
const engineWindow = {};
vm.runInNewContext(engineSource, { window: engineWindow });
const PdfReviewProvider = engineWindow.PdfReviewProvider;
const normalized = engineWindow.PdfSelectionDiff.normalized;
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

