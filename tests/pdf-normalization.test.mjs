import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { engine } from './support/pdf-harness.mjs';

const pages = JSON.parse(await readFile(new URL('./fixtures/pdf-normalization-me08-pages.json', import.meta.url), 'utf8'));
for (const page of pages) test(`ME08-${page.number} ordered OCR passages keep patch coordinates and page boundaries`, () => {
  const api = engine(), locator = new api.PdfLocator({}, { document: { createElement: () => ({
    set innerHTML(text) { this.content = { textContent: text.replace(/&(amp|lt|gt);/g,
      (_, name) => ({ amp: '&', lt: '<', gt: '>' })[name]) }; }
  }) } });
  const index = locator.sourceIndex(page.source), target = new api.PdfSourceIndex(locator, { raw: page.raw });
  index?.diff([target]);
  const connections = index.connections.get(target) || [], items = index.reviewCandidates(null, false, true, true, [target]);
  const covered = new Set(connections.flatMap(c => Array.from({ length: c.end - c.start }, (_, i) => c.start + i))).size;
  const minimum = { 241: 2579, 247: 2054, 432: 2294, 446: 2684, 447: 2917, 448: 2609,
    449: 2674, 450: 2675, 451: 2542, 452: 1836, 453: 2213, 454: 1787, 455: 1743, 456: 2348, 457: 113 };
  assert.ok(covered >= minimum[page.number], 'damaged passages between confirmed anchors remain mapped');
  for (const connection of connections) {
    const diff = index.connectionDiff(target, connection);
    assert.ok(diff);
    assert.equal(diff.parts.map(p => p.html).join(''), index.raw.slice(connection.start, connection.end));
    assert.equal(diff.parts.map(p => p.pdf).join(''), target.raw.slice(connection.targetStart, connection.targetEnd));
  }
  for (const item of items) {
    assert.equal(index.raw.slice(item.sourceStart, item.sourceEnd), item.comparison.html);
    const patched = api.applyTextEdits(page.source, item.options[0].edits);
    assert.equal(api.significantText(locator.sourceIndex(patched).raw), api.significantText(api.applyTextEdits(index.raw, [{
      start: item.sourceStart, end: item.sourceEnd, text: item.comparison.pdf
    }])));
    assert.ok(!item.comparison.pdf.includes('Karl Marx') && !item.comparison.pdf.includes('Männer des Exils'),
      'running headers cannot be patched into the article');
  }
  api.validateEdits(page.source, items.flatMap(item => item.options[0].edits));
});

for (const page of pages) test(`ME08-${page.number} selections align both ways across the page's OCR passages`, () => {
  const api = engine(), visible = [];
  const locator = new api.PdfLocator({}, { document: { createElement: () => ({}) }, getVisiblePages: () => visible });
  const index = locator.sourceIndex(page.source), target = new api.PdfSourceIndex(locator, { raw: page.raw, parts: [] });
  visible.push({ number: 1, index: target });
  index?.diff([target]);
  const start = index.raw.indexOf(page.selection.from), end = index.raw.indexOf(page.selection.to, start) + page.selection.to.length;
  assert.ok(start >= 0 && end > start);
  const forward = index.connectedRange(target, start, end, false, undefined, true);
  assert.ok(forward, 'a selection spanning confirmed groups must not fall back to isolated word searches');
  assert.deepEqual([forward.start, forward.end], [page.selection.pdfStart, page.selection.pdfEnd]);
  const reverse = locator.locateSource(index, [{ index: target, start: forward.start, end: forward.end }]).hit;
  assert.deepEqual([reverse?.start, reverse?.end], [start, end]);
  const locations = locator.findLocations({}, [{ index, start, end, text: index.raw.slice(start, end), before: '', after: '' }]);
  const rendered = locator.locateLayer(target, [], locations[0].targets).focusHit;
  assert.deepEqual([rendered?.start, rendered?.end], [forward.start, forward.end]);
  assert.equal(index.connectedRange(target, 0, forward.end, true, undefined, true), null,
    'a selection starting in an unmapped running header must not enter the article');
});

test('ellipsis variants normalize equally on either side and keep replacement coordinates', () => {
  const api = engine(), locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
  const variants = ['…', '...', '. . .', '.\n.\n.'];
  for (const html of variants) for (const pdf of variants) {
    assert.equal(api.normalized(html).text, api.normalized(pdf).text);
    const source = `Viele Untersuchungen erfordern ${html} Nicht daß etwa. Tail wrong\n`;
    const index = locator.sourceIndex(source), target = new api.PdfSourceIndex(locator, {
      raw: `Viele Untersuchungen erfordern ${pdf} Nicht daß etwa. Tail right;\n`
    });
    const connection = index.rememberConnection(0, index.raw.length, target, { start: 0, end: target.raw.length });
    assert.ok(connection);
    const diff = index.connectionDiff(target, connection);
    assert.equal(diff.parts.map(p => p.html).join(''), source);
    assert.equal(diff.parts.map(p => p.pdf).join(''), target.raw);
    const items = index.reviewCandidates(null, false, true, true, [target]);
    assert.ok(items.length);
    api.validateEdits(source, items.flatMap(item => item.options[0].edits));
  }
});

test('expanded glyphs split by OCR changes never duplicate raw text', () => {
  const api = engine(), locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
  for (const [html, pdf] of [['…', '.x. .'], ['ß', 'sxs'], ['ﬃ', 'fxfi']]) {
    for (const [a, b] of [[html, pdf], [pdf, html]]) {
      const source = `Before ${a} after wrong\n`, index = locator.sourceIndex(source);
      const target = new api.PdfSourceIndex(locator, { raw: `Before ${b} after right;\n` });
      const connection = index.rememberConnection(0, index.raw.length, target, { start: 0, end: target.raw.length });
      assert.ok(connection);
      const diff = index.connectionDiff(target, connection);
      assert.equal(diff.parts.map(p => p.html).join(''), source);
      assert.equal(diff.parts.map(p => p.pdf).join(''), target.raw);
      api.validateEdits(source, index.reviewCandidates(null, false, true, true, [target]).flatMap(item => item.options[0].edits));
    }
  }
});

test('ASCII runs preserve Unicode normalization and raw UTF-16 highlight offsets', () => {
  const { normalized } = engine();
  const input = 'ABC ſß ﬃ ＡK\t😀\u00adwort-\nende';
  const result = normalized(input);
  assert.equal(result.text, 'abc sss ffi ak 😀wortende');
  assert.deepEqual(Array.from(result.starts), [0,1,2,3,4,5,5,6,7,7,7,8,9,10,11,12,12,15,16,17,18,21,22,23,24]);
  assert.deepEqual(Array.from(result.ends), [1,2,3,4,5,6,6,7,8,8,8,9,10,11,12,14,14,16,17,18,19,22,23,24,25]);
  const appended = normalized(input, normalized('prefix '), 7);
  assert.equal(appended.text, 'prefix ' + result.text);
  assert.deepEqual(Array.from(appended.starts.slice(7)), Array.from(result.starts, offset => offset + 7));
  assert.deepEqual(Array.from(appended.ends.slice(7)), Array.from(result.ends, offset => offset + 7));
});

test('selections recover a gap by diffing between confirmed context in either direction', () => {
  for (const [reverseFirst, innerFirst] of [[false, false], [true, false], [false, true], [true, true]]) {
    const api = engine(), locator = new api.PdfLocator();
    const source = new api.PdfSourceIndex(locator, { raw: 'First context. Lost passage. Last context.' });
    const target = new api.PdfSourceIndex(locator, { raw: 'First context. Corrupt longer text. Last context.' });
    const end = source.raw.indexOf(' Last'), targetEnd = target.raw.indexOf(' Last');
    const first = source.rememberConnection(0, 14, target, { start: 0, end: 14 });
    source.rememberConnection(end, source.raw.length, target, { start: targetEnd, end: target.raw.length });
    assert.equal(source.connectedRange(target, 0, source.raw.length, false, first), null,
      'an explicit connection must cover the complete selection too');
    source.locate = target.locate = () => { throw new Error('fallback must reuse confirmed context'); };
    const initial = source.connectedRange(target, innerFirst ? 14 : 0,
      innerFirst ? reverseFirst ? targetEnd : end : reverseFirst ? target.raw.length : source.raw.length, reverseFirst);
    assert.deepEqual([initial?.start, initial?.end], [innerFirst ? 14 : 0,
      innerFirst ? reverseFirst ? end : targetEnd : reverseFirst ? source.raw.length : target.raw.length]);
    const forward = source.connectedRange(target, 0, source.raw.length);
    assert.deepEqual([forward?.start, forward?.end], [0, target.raw.length]);
    const reverse = source.connectedRange(target, 0, target.raw.length, true);
    assert.deepEqual([reverse?.start, reverse?.end], [0, source.raw.length]);
    const connections = source.connections.get(target);
    source.connectedRange(target, 14, end);
    assert.equal(source.connections.get(target), connections, 'the recovered diff is reused');
  }
});

test('gap fallback requires two ordered context mappings and stays within the diff budget', () => {
  for (const kind of ['one-sided', 'over-budget', 'reversed']) {
    const api = engine(), locator = new api.PdfLocator();
    const source = new api.PdfSourceIndex(locator, { raw: 'Left. ' + 'a'.repeat(140) + 'Right.' });
    const target = new api.PdfSourceIndex(locator, { raw: kind === 'reversed'
      ? 'Right.' + 'b'.repeat(140) + 'Left. ' : 'Left. ' + 'b'.repeat(140) + 'Right.' });
    const end = source.raw.indexOf('Right.');
    source.rememberConnection(0, 6, target, { start: kind === 'reversed' ? end : 0,
      end: kind === 'reversed' ? target.raw.length : 6 });
    if (kind !== 'one-sided') source.rememberConnection(end, source.raw.length, target,
      { start: kind === 'reversed' ? 0 : end, end: kind === 'reversed' ? 6 : target.raw.length });
    assert.equal(source.connectedRange(target, 6, end), null, kind);
    assert.equal(source.connectedRange(target, 6, end, true), null, kind);
  }
});

test('ME08-449 damaged opening word anchors progressively longer selections in both directions', () => {
  const page = pages.find(page => page.number === 449), api = engine();
  const locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
  const index = locator.sourceIndex(page.source), target = new api.PdfSourceIndex(locator, { raw: page.raw });
  index?.diff([target]);
  const start = index.raw.indexOf('Wie');
  for (const last of ['Wie', 'Stieber', 'weiß', 'Hypothesen']) {
    const end = index.raw.indexOf(last, start) + last.length;
    const forward = index.connectedRange(target, start, end, false, undefined, true);
    assert.equal(forward?.start, page.raw.indexOf('^ o Stieber'));
    const reverse = locator.locateSource(index, [{ index: target, start: forward.start, end: forward.end }]).hit;
    assert.deepEqual([reverse?.start, reverse?.end], [start, end]);
  }
  const partial = index.connectedRange(target, start + 1, start + 3, false, undefined, true);
  assert.equal(target.raw.slice(partial.start, partial.end), '^ o');
  assert.equal(index.connectedRange(target, 0, partial.end, true), null, 'running header stays outside the article map');
});

for (const [number, from, to, pdfStart, pdfEnd] of [
  [432, 'Man verstehe', 'Man', 2231, 2234],
  [432, 'Man verstehe', 'Beweise', 2231, 2263],
  [432, 'Man verstehe', 'Beweise?', 2231, 2375],
  [247, 'Komödieneffekte', 'Komödieneffekte', 463, 474],
  [247, 'Komödieneffekte', 'neue', 463, 482],
  [457, 'Roten', 'Roten', 410, 415],
  [457, 'Roten', 'hochtönend', 410, 437]
]) test(`ME08-${number} context locates damaged ${from} … ${to} without searching again`, () => {
  const page = pages.find(page => page.number === number), api = engine();
  const locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
  const index = locator.sourceIndex(page.source), target = new api.PdfSourceIndex(locator, { raw: page.raw });
  index?.diff([target]);
  index.locate = () => { throw new Error('selection must use the contextual diff map'); };
  const start = index.raw.indexOf(from), end = index.raw.indexOf(to, start) + to.length;
  const forward = index.connectedRange(target, start, end, false, undefined, true);
  assert.deepEqual([forward?.start, forward?.end], [pdfStart, pdfEnd]);
  const reverse = locator.locateSource(index, [{ index: target, start: pdfStart, end: pdfEnd }]).hit;
  assert.deepEqual([reverse?.start, reverse?.end], [start, end]);
});

test('whitespace runs keep their full raw range and remain compatible with dehyphenation', () => {
  const { normalized } = engine();
  const result = normalized('A\t \r\n\u00a0\uFEFFB-\r\n C');
  assert.equal(result.text, 'a bc');
  assert.deepEqual(Array.from(result.starts), [0,1,7,12]);
  assert.deepEqual(Array.from(result.ends), [1,7,8,13]);
  const appended = normalized('\t\nB', normalized('A '), 2);
  assert.equal(appended.text, 'a b');
  assert.deepEqual(Array.from(appended.starts), [0,1,4]);
  assert.deepEqual(Array.from(appended.ends), [1,4,5]);
});
