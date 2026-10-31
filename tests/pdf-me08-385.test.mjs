import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { engine, engineSource } from './support/pdf-harness.mjs';
import vm from 'node:vm';

const fixture = JSON.parse(await readFile(new URL('./fixtures/pdf-selection-me08-385.json', import.meta.url), 'utf8'));

test('Monaco highlights locatable differences and missing additions as text', () => {
  const api = engine(), locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
  const source = locator.sourceIndex('<p>A corrupted passage here.</p>');
  const target = new api.PdfSourceIndex(locator, { raw: 'A wrong reading here.', parts: [] });
  source.rememberConnection(0, source.raw.length, target, { start: 0, end: target.raw.length });
  const model = { getPositionAt: at => ({ lineNumber: 1, column: at + 1 }) };
  const marks = source.sourceDecorations(source.reviewCandidates(null, false, false, true, [], source.connectionPairs([target])), false, true, undefined, model);
  assert.ok(marks.length);
  for (const mark of marks) {
    assert.equal(mark.options.inlineClassName, 'mew-ocr-diff-text');
    assert.equal(mark.options.before, undefined);
    assert.ok(mark.range.endColumn > mark.range.startColumn);
  }
  const absent = new api.PdfSourceIndex(locator, { raw: '', sourcePages: [1] });
  const missing = source.sourceDecorations(source.reviewCandidates(null, false, false, true, [absent], []), false, true, undefined, model);
  assert.equal(missing.length, 0, 'unprepared OCR cannot establish missing text');
  const partial = new api.PdfSourceIndex(locator, { raw: 'A wrong', sourcePages: [1] });
  source.rememberConnection(0, source.raw.indexOf(' passage'), partial, { start: 0, end: partial.raw.length });
  const mixed = source.sourceDecorations(source.reviewCandidates(null, false, false, true, [], source.connectionPairs([partial])), false, true, undefined, model);
  assert.ok(mixed.some(mark => mark.options.inlineClassName === 'mew-ocr-diff-text'), 'the locatable part keeps normal highlights');
  assert.equal(mixed.filter(mark => mark.options.before).length, 0, 'missing HTML uses text highlights');
});

test('rendered OCR recovers a word between damaged runs before selection and keeps HTML marks fixed', () => {
  const api = engine(), visible = [], targets = [], locator = new api.PdfLocator({}, {
    document: { createElement: () => ({}) }, getVisiblePages: () => visible, getTargets: () => targets
  });
  const first = 'The opening anchor has enough unique words for a stable correspondence. ';
  const last = ' The closing anchor also has enough distinct words to confirm the ending.';
  const source = locator.sourceIndex('<p>' + first + 'a'.repeat(150) + ' same patchable ' + 'b'.repeat(150) + last + '</p>');
  const rendered = new api.PdfSourceIndex(locator, { raw: first + 'x'.repeat(150) + ' same patchab1e ' + 'y'.repeat(150) + last, layer: {}, parts: [] });
  targets.push(rendered, new api.PdfSourceIndex(locator, { raw: '', sourcePages: [1] }));
  visible.push({ number: 1, index: rendered });
  source?.diff(targets);
  const items = source.reviewCandidates(null, false, true, true, targets), gaps = items.filter(item => item.missing);
  const patch = items.find(item => item.comparison.html === 'l' && item.comparison.pdf === '1');
  assert.ok(patch, 'the locatable word uses rendered OCR as its replacement source');
  assert.equal(gaps.length, 2);
  const model = { getPositionAt: at => ({ lineNumber: 1, column: at + 1 }) };
  const marks = () => source.sourceDecorations(source.reviewCandidates(null, false, false, true, targets, source.connectionPairs(targets, true)), false, true, undefined, model);
  const initial = JSON.stringify(marks());
  assert.ok(marks().some(mark => mark.options.inlineClassName === 'mew-ocr-diff-text'));
  assert.equal(marks().filter(mark => mark.options.before).length, 0);
  for (const gap of gaps) for (const at of [gap.sourceStart, gap.sourceEnd]) {
    const location = locator.findLocations({}, [{ index: source, start: at, end: at, text: '', marked: true }], true)[0];
    assert.equal(location.notice.missing, true);
    assert.equal(location.notice.source.start, gap.sourceStart);
    assert.equal(location.notice.source.end, gap.sourceEnd);
    assert.equal(JSON.stringify(marks()), initial);
  }
  for (const phrase of ['same', 'patchable']) {
    const start = source.raw.indexOf(phrase), end = start + phrase.length;
    locator.findLocations({}, [{ index: source, start, end, text: phrase, before: '', after: '' }], true);
    assert.equal(JSON.stringify(marks()), initial, 'selection cannot move or remove prepared HTML marks');
  }
  for (let end = 2; end < first.length; end++) source.rememberConnection(0, end, rendered, { start: 0, end });
  assert.equal(JSON.stringify(marks()), initial, 'transient selection mappings cannot evict the prepared HTML highlights');
  assert.equal(source.sourceDecorations(source.reviewCandidates(null, false, false, false, targets, source.connectionPairs(targets)), false, false, undefined, model).length, 0);
  assert.ok(api.applyTextEdits(source.source, patch.options[0].edits).includes('same patchab1e'));
});

test('normalized exact selections compare the actual OCR text', () => {
  const api = engine(), visible = [], locator = new api.PdfLocator({}, {
    document: { createElement: () => ({}) }, getVisiblePages: () => visible
  });
  const source = locator.sourceIndex('<p>A known Word in a confirmed passage.</p>');
  const target = new api.PdfSourceIndex(locator, { raw: 'A known word in a confirmed passage.', layer: {}, parts: [] });
  visible.push({ number: 1, index: target });
  source?.diff([target]);
  const start = source.raw.indexOf('Word');
  const location = locator.findLocations({}, [{ index: source, start, end: start + 4, text: 'Word' }], true)[0];
  assert.equal(location.targets[0].difference.html, 'Word');
  assert.equal(location.targets[0].difference.pdf, 'word');
});
test('ME08-385 corrupted selections highlight remaining OCR ranges without inventing mappings', () => {
  const api = engine(), visible = [], locator = new api.PdfLocator({}, {
    document: { createElement: () => ({}) }, getVisiblePages: () => visible
  });
  const source = locator.sourceIndex(fixture.source);
  const extracted = new api.PdfSourceIndex(locator, { raw: fixture.raw, sourcePages: [408] });
  const rendered = new api.PdfSourceIndex(locator, { raw: fixture.layerRaw, layer: {}, parts: [] });
  visible.push({ number: 408, index: rendered });
  locator.getDocumentIndex = () => extracted;
  source?.diff([rendered, extracted]);
  const start = source.raw.indexOf('Das einzige'), end = source.raw.indexOf('unter-', start) + 6;
  const connections = source.connections.get(rendered);
  for (const from of [start, source.raw.indexOf('Rivalität', start)]) {
    const location = locator.findLocations({}, [{ index: source, start: from, end,
      text: source.raw.slice(from, end), before: '', after: '' }])[0];
    assert.equal(location.notice.missing, true);
    const hit = locator.locateLayer(rendered, [], location.targets).focusHit;
    assert.ok(hit.end > hit.start, 'remaining OCR words receive a range instead of a caret');
    assert.ok(rendered.raw.slice(hit.start, hit.end).includes('Schrecken vor der Leere'));
    if (from === start) assert.ok(rendered.raw.slice(hit.start, hit.end).startsWith('Das einzige'));
  }
  assert.equal(source.connections.get(rendered), connections, 'unreliable OCR ranges cannot become replacement mappings');
});

test('missing OCR ranges exclude text confirmed in a rendered layer', () => {
  const api = engine(), locator = new api.PdfLocator();
  const source = new api.PdfSourceIndex(locator, { raw: 'First passage. Last passage. Missing.' });
  const extracted = new api.PdfSourceIndex(locator, { raw: 'First passage.', sourcePages: [1] });
  const rendered = new api.PdfSourceIndex(locator, { raw: 'First passage. Last passage.', layer: {} });
  source.rememberConnection(0, 14, extracted, { start: 0, end: 14 });
  source.rememberConnection(0, 28, rendered, { start: 0, end: 28 });
  source.connections.get(extracted)[0].recovered = true;
  const items = source.reviewCandidates(null, false, true, true, [rendered, extracted]).filter(item => item.missing);
  assert.equal(items.length, 1);
  assert.equal(items[0].sourceStart, 28);
  assert.equal(source.rememberConnection(28, 14, rendered, { start: 0, end: 14 }), null);
});

test('ME08-385 recovered patches preserve shared words throughout the damaged footer', () => {
  const api = engine(), locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
  const source = locator.sourceIndex(fixture.source);
  const target = new api.PdfSourceIndex(locator, { raw: fixture.raw, sourcePages: [408] });
  source?.diff([target]);
  const items = source.reviewCandidates(null, false, true, true, [target]);
  for (const phrase of ['Art, wie man sie 1835 gegen', 'schlagen“, und zwar wegen', 'Schrecken vor der Leere', 'siehe vorl', 'Band, S. 176', '193']) {
    const start = source.raw.indexOf(phrase);
    assert.ok(start >= 0);
    assert.ok(!items.some(item => item.sourceStart < start + phrase.length && item.sourceEnd > start), phrase);
  }
  const edits = items.flatMap(item => item.options[0].edits);
  api.validateEdits(fixture.source, edits);
  assert.ok(edits.length);
});

test('normal mapped selections skip missing-text lookup and normal diffs skip word recovery', () => {
  const window = {};
  vm.runInNewContext(engineSource.replace('      if (!alignment?.recover) return null;',
    '$& window.wordRecoveries = (window.wordRecoveries || 0) + 1;')
    .replace('function textDiff(left, right, details = false, limit = Infinity) {',
      '$& window.diffCalls = (window.diffCalls || 0) + 1;')
    .replace('      const coarse = localTextDiff(words(this.raw.slice(start, end)), words(target.raw.slice(hit.start, hit.end)), true, 128);',
      '$& window.recoveryCalls = (window.recoveryCalls || 0) + 1;'), { window });
  const api = window.PdfSelectionDiff, visible = [];
  const locator = new window.PdfReviewProvider.PdfLocator({}, {
    document: { createElement: () => ({}) }, getVisiblePages: () => visible
  });
  const source = locator.sourceIndex('<p>Normal text has a changed word here.</p>');
  const target = new api.PdfSourceIndex(locator, { raw: 'Normal text has a corrected word here.', sourcePages: [1], parts: [] });
  visible.push({ number: 1, index: target });
  source.rememberConnection(0, source.raw.length, target, { start: 0, end: target.raw.length });
  source?.diff([target]);
  source.reviewCandidates = () => { throw new Error('normal selection entered missing-text fallback'); };
  const start = source.raw.indexOf('changed');
  let initial;
  for (let i = 0; i < 21; i++) {
    const location = locator.findLocations({}, [{ index: source, start, end: start + 7,
      text: 'changed', before: '', after: '' }])[0];
    assert.ok(location.targets.length);
    if (i === 0) initial = window.diffCalls;
  }
  assert.equal(window.diffCalls, initial, 'repeated normal selections add no diff work');
  assert.equal(window.recoveryCalls || 0, 0);
  assert.equal(window.wordRecoveries || 0, 0);
  delete source.reviewCandidates;
  assert.equal(source.reviewCandidates(null, false, true, true, [target]).filter(item => item.missing).length, 0);
});

test('bounded missing-text recovery preserves shared words after the normal diff fails', () => {
  const api = engine(), locator = new api.PdfLocator();
  const left = 'a'.repeat(150) + ' preserved phrase ' + 'b'.repeat(150);
  const right = 'x'.repeat(150) + ' preserved phrase ' + 'y'.repeat(150);
  const source = new api.PdfSourceIndex(locator, { raw: left });
  const target = new api.PdfSourceIndex(locator, { raw: right });
  assert.equal(source.rememberConnection(0, left.length, target, { start: 0, end: right.length }), null);
  assert.equal(source.connections.get(target), undefined, 'normal comparisons do not attempt word recovery');
  source.rememberConnection(0, left.length, target, { start: 0, end: right.length }, { recover: true });
  const start = left.indexOf('preserved phrase'), hit = source.connectedRange(target, start, start + 'preserved phrase'.length);
  assert.equal(target.raw.slice(hit.start, hit.end), 'preserved phrase');
});

test('an unreliable whole-range comparison cannot bypass the missing-text fallback', () => {
  const api = engine(), locator = new api.PdfLocator();
  const source = new api.PdfSourceIndex(locator, { raw: 'a'.repeat(180) });
  const target = new api.PdfSourceIndex(locator, { raw: 'b'.repeat(180), sourcePages: [1] });
  source.connections.set(target, [{ start: 0, end: 180, targetStart: 0, targetEnd: 180,
    recovered: true, editorDiff: { distance: 180, parts: [{ html: source.raw, pdf: target.raw, changed: true }] } }]);
  assert.equal(source.reviewCandidates(null, false, true, true, [target]).filter(item => item.missing).length, 1);
  assert.equal(source.reviewCandidates(null, false, true, true, [target]).filter(item => item.missing).length, 1);
});
