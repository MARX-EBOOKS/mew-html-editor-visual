import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';
const diffSource=await readFile(new URL('../public/pdfdiff/pdf-selection-diff.js',import.meta.url),'utf8');
function engine(){const window={}; vm.runInNewContext(diffSource,{window}); return window.PdfSelectionDiff;}
test('ME04-608 wrapped prose stays aligned across blank-line anchors', () => {
  const api = engine();
  const locator = api.createLocator({}, { document: { createElement: () => ({}) } });
  const paragraph = "<p><i>Born</i> stattet Bericht ab über die Versammlung im Café l'Europe; ebenso <i>Sterbitzki</i>. Mit großer Mehrzahl beschlossen, nicht in dieses Café zu gehn, wo Decker und Venedey eine Versammlung halten.</p>";
  const pdf = "Born stattet Bericht ab über die Versammlung im Cafe l'Europe; ebenso\n\nSterhitzki' Mit großer Mehrzahl beschlossen, nicht in dieses Cafe zu gehn,\nwo Decker und Venedey eine Versammlung halten.\nEngler, Buchfink und Vogler (Weitlingianer) aufgenommen einstimmig.\n";
  for (const newline of ['\r\n', '\n']) {
    const html = paragraph + newline + '<p>Engler, Buchfink und Vogler (Weitlingianer) aufgenommen einstimmig.</p>';
    const index = locator.editorSourceIndex({ getValue: () => html, getVersionId: () => 1 });
    const target = { raw: pdf };
    locator.rememberConnection(index, 0, index.raw.length, target, { start: 0, end: pdf.length });
    const items = api.reviewCandidates(index, [target]);
    assert.deepEqual(Array.from(items, item => [item.comparison.html, item.comparison.pdf]),
      [['é', 'e'], ['b', 'h'], ['.', "'"], ['é', 'e']]);
    assert.equal(api.previewEdits(html, items.flatMap(item => item.options[0].edits)),
      html.replaceAll('Café', 'Cafe').replace('Sterbitzki</i>.', "Sterhitzki</i>'"));
  }
});

test('bounded local anchor checks reject impossible lengths and count Unicode code points', () => {
  const api = engine();
  const left = 'a'.repeat(80), right = 'b'.repeat(577854);
  assert.equal(api.textDiff(left, right, false, 12).distance, 13);
  const rejected = api.textDiff(right, left, true, 12);
  assert.equal(rejected.distance, 13);
  assert.deepEqual(Array.from(rejected.parts, part => [part.html, part.pdf, part.changed]), [[right, left, true]]);
  assert.equal(api.textDiff('a', 'a𠀀', false, 1).distance, 1);
  assert.equal(api.textDiff('a', 'ab', false, 1).distance, 1);
  const unbounded = api.textDiff('a', 'abc', true);
  assert.equal(unbounded.parts.map(part => part.pdf).join(''), 'abc');
});

test('local diff preserves complete Unicode readings and maps source positions in both directions', () => {
  const api = engine();
  for (const [left, right] of [
    ['First line\nwork together\n中文𠀀 last', 'First line\nworks together\n中文𠀀 last'],
    ['a𠀀b', 'a𠀁b'], ['before\nend', 'before\nextra\nend'], ['', 'added'], ['deleted', ''],
    ['Die Straße', 'Die Strasse'], ['line\r\nnext', 'line\r\nnew next']
  ]) {
    const diff = api.textDiff(left, right, true);
    assert.equal(diff.parts.map(part => part.html).join(''), left);
    assert.equal(diff.parts.map(part => part.pdf).join(''), right);
    assert.equal(diff.distance, api.textDiff(left, right).distance);
    for (const part of diff.parts) if (!part.changed) assert.equal(part.html, part.pdf);
  }
  const { normalized, rememberConnection, connectedRange } = api.createLocator();
  const index = raw => ({ raw, normalized: normalized(raw), connections: new WeakMap() });
  const left = index('Before working together after.'), right = index('Before working nicely together after.');
  rememberConnection(left, 0, left.raw.length, right, { start: 0, end: right.raw.length });
  const word = left.raw.indexOf('together'), mapped = connectedRange(left, right, word, word + 8);
  assert.equal(right.raw.slice(mapped.start, mapped.end), 'together');
  const reverse = connectedRange(left, right, mapped.start, mapped.end, true);
  assert.equal(left.raw.slice(reverse.start, reverse.end), 'together');
});

test('font edits move nearby bold and italic boundaries instead of duplicating wrappers', () => {
  const api = engine();
  const locator = api.createLocator({}, { document: { createElement: () => ({}) } });
  for (const [html, font, expected] of [
    ['<p><b>A</b> B</p>', { bold: true }, '<p><b>A B</b></p>'],
    ['<p>B <strong>C</strong></p>', { bold: true }, '<p><strong>B C</strong></p>'],
    ['<p><em>A</em> B <em>C</em></p>', { italic: true }, '<p><em>A B C</em></p>'],
    ['<p><i>A</i>\tB\t<i>C</i></p>', { italic: true }, '<p><i>A\tB\tC</i></p>'],
    ['<p><b>A</b> B <strong>C</strong></p>', { bold: true }, '<p><b>A B</b> <strong>C</strong></p>'],
    ['<p><b>A</b>\nB</p>', { bold: true }, '<p><b>A</b>\n<b>B</b></p>'],
    ['<p><b>A</b> X B</p>', { bold: true }, '<p><b>A</b> X <b>B</b></p>'],
    ['<p><b style="font-weight:normal">A</b> B</p>', { bold: true }, '<p><b style="font-weight:normal">A</b> <b>B</b></p>'],
    ['<p><b>A</b> B <i>C</i></p>', { bold: true, italic: true }, '<p><b>A</b> <b><i>B</i></b> <i>C</i></p>']
  ]) {
    const index = locator.sourceIndex(html), start = index.raw.indexOf('B');
    const revised = api.previewEdits(html, api.fontEdits(index, start, start + 1, font));
    assert.equal(revised, expected);
    const corrected = locator.sourceIndex(revised);
    assert.equal(corrected.raw, index.raw);
    for (const key of ['bold', 'italic']) {
      for (let at = 0; at < index.raw.length; at++) {
        if (/\s/.test(index.raw[at])) continue;
        assert.equal(corrected.formats[at][key], at === start && typeof font[key] === 'boolean' ? font[key] : index.formats[at][key]);
      }
    }
  }
});

test('one comparison caches text and font classification for candidates and decorations', () => {
  const api = engine(), locator = api.createLocator({}, { document: { createElement: () => ({}) } });
  const index = locator.sourceIndex('<p>Alpha beta WRONG</p>');
  const target = { raw: 'Alpha\nbeta RIGHT\n', fontVersion: 0, parts: [
    { start: 0, end: 6, font: { bold: false, italic: false } },
    { start: 6, end: 10, font: { bold: true, italic: true } },
    { start: 10, end: 17, font: { bold: false, italic: false } }
  ] };
  const connection = locator.rememberConnection(index, 0, index.raw.length, target, { start: 0, end: target.raw.length });
  const comparison = api.connectionDiff(index, target, connection);
  const originalParts = target.parts;
  Object.defineProperty(target, 'parts', { configurable: true, get() { throw Error('duplicate classification'); } });
  assert.equal(api.connectionDiff(index, target, connection), comparison);
  assert.deepEqual(Array.from(api.reviewCandidates(index, [target]), item => item.comparison.pdf), ['RIGHT']);
  assert.deepEqual(Array.from(api.formatDifferences(index, [[connection, target]]), item => item.text), ['beta']);
  const model = { getPositionAt: at => ({ lineNumber: 1, column: at + 1 }) };
  assert.equal(api.sourceDecorations(index, [[connection, target]], model).length, 2);
  Object.defineProperty(target, 'parts', { configurable: true, value: originalParts });
  target.parts[1].font = { bold: false, italic: false }; target.fontVersion++;
  const refreshed = api.connectionDiff(index, target, connection);
  assert.equal(refreshed.parts, comparison.parts);
  assert.equal(refreshed.fonts.length, 0);
});
test('the script reads PDF.js text and fonts directly without a generated text backend', async () => {
  const api = engine(); let reads = 0, operators = 0;
  const page = {
    getTextContent: async () => { reads++; return { items: [
      { str: 'Regular', fontName: 'regular', transform: [1, 0, 0, 1, 0, 100], height: 12, width: 50 },
      { str: 'Styled', fontName: 'styled', transform: [1, 0, 0, 1, 0, 80], height: 12, width: 50 }
    ] }; },
    commonObjs: new Map([['regular', { name: 'Times', bold: false, italic: false }], ['styled', { name: 'Times-BoldItalic', bold: true, italic: true }]]),
    getOperatorList: async () => { operators++; return { fnArray: [], argsArray: [] }; }
  };
  const pdf = { numPages: 1, getPage: async () => page };
  const locator = api.createLocator({}, { isCurrent: () => true, waitForIdle: async () => {} });
  const index = await locator.indexDocument(pdf);
  assert.equal(index.raw, 'Regular\nStyled\n');
  assert.equal(await locator.indexFonts(pdf), index);
  assert.equal(await locator.indexFonts(pdf), index);
  assert.equal(reads, 1); assert.equal(operators, 1);
  assert.equal(index.pages[0].parts[1].font.bold, true);
  assert.equal(index.fontVersion, 1);
});
test('unknown styles and attribute-bearing wrappers preserve the source', () => {
  const api = engine(), locator = api.createLocator({}, { document: { createElement: () => ({}) } });
  for (const html of ['<p><i id="keep">Text</i></p>', '<p><span style="color:red;font-style:italic">Text</span></p>']) {
    const index = locator.sourceIndex(html);
    assert.equal(api.fontEdits(index, 0, 4, { italic: false }).length, 0);
    assert.equal(api.fontEdits(index, 0, 4, { italic: null, bold: null }).length, 0);
  }
});
