import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';
import { engineSource, source, engine, reviewProvider } from './support/pdf-harness.mjs';
const pdfApi = engine();

test('page scope closes independently and reuses exact matches when preparing connections', () => {
  const api = engine(), locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
  for (const [raw, expected] of [['prefix Alpha omega suffix', true], ['Alpha omega and Alpha omega', false]]) {
    const index = new api.PdfSourceIndex(locator, { raw }), page = new api.PdfSourceIndex(locator, { raw: 'Alpha omega' });
    const matches = index.matches;
    let calls = 0;
    index.matches = function (...args) { calls++; return matches.apply(this, args); };
    index.locate = () => assert.fail('page preparation must not enter selection lookup');
    assert.equal(!!index.sourcePageScope(page), expected);
    assert.equal(calls, 1);
    assert.equal(!!index.sourcePageScope(page, true), expected);
    assert.equal(calls, 1, 'preparation reuses both unique and ambiguous exact matches');
    assert.equal(!!index.connections.get(page)?.length, expected);
  }
});

test('page preparation shares its connection and normalized scope', () => {
  const api = engine(), locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
  const index = locator.sourceIndex('<p>Alpha wrong omega</p>');
  const target = new api.PdfSourceIndex(locator, { raw: index.raw.replace('wrong', 'right'), layer: {} });
  const scope = index.sourcePageScope(target, true);
  assert.equal(scope, index.connections.get(target)[0]);
  assert.equal(scope.normalized.text, api.normalized(index.raw).text);
  assert.equal(scope.normalized, index.normalized, 'full-source scope reuses the normalized index');
  assert.equal(index.sourcePageScope(target, true), scope);
});

test('matching stages stop after a usable result and keep anchor uniqueness separate', () => {
  const api = engine(), locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
  const text = 'Alpha starts here. Beta continues with a different sentence. Gamma supplies another unique passage. Delta closes the final paragraph.';
  const index = new api.PdfSourceIndex(locator, { raw: text }), matches = index.matches, stages = [];
  index.matches = function (queries, haystack, options = {}) {
    stages.push(options.sample || (options.fuzzy ? 'fuzzy' : 'exact'));
    return matches.call(this, queries, haystack, options);
  };
  assert.ok(index.locate({ text: 'Beta', before: '', after: '' }));
  assert.deepEqual(stages, ['exact'], 'an exact selection skips fuzzy matching');
  stages.length = 0;
  assert.ok(index.locate({ text: 'Beto', before: 'Alpha starts here. ', after: ' continues with a different sentence.' }));
  assert.deepEqual(stages, ['exact', 'fuzzy']);
  stages.length = 0;
  const page = new api.PdfSourceIndex(locator, { raw: text.replace('Gamma', 'Gomma') });
  assert.ok(index.sourcePageScope(page, true));
  assert.ok(stages.includes(24), 'page preparation samples overlapping anchors');
  assert.ok(!stages.includes(96), 'confirmed preparation skips fallback sampling');
  stages.length = 0;
  assert.equal(index.sourcePageScope(new api.PdfSourceIndex(locator, { raw: 'Z'.repeat(140) }), true), null);
  assert.deepEqual(stages.filter(stage => typeof stage === 'number'), [24, 96], 'failed preparation advances to fallback sampling');
  stages.length = 0;
  const absent = new api.PdfSourceIndex(locator, { raw: 'Y'.repeat(140) });
  assert.equal(index.sourcePageScope(absent), null);
  assert.equal(index.sourcePageScope(absent, true), null);
  assert.deepEqual(stages.filter(stage => typeof stage === 'number'), [96, 24], 'upgrading preparation reuses its completed fallback stage');
  const repeated = new api.PdfSourceIndex(locator, { raw: 'Alpha '.repeat(20) });
  assert.equal(repeated.matches(['Alpha '.repeat(5)], repeated.normalized, { sample: 24, step: 8 }).length, 0,
    'repeated anchors cannot become unique by pooling their hits');
});

test('confirmed page anchors resolve repetitions without treating changed spans as exact anchors', () => {
  const api = engine(), locator = new api.PdfLocator();
  const text = 'Alpha starts a unique passage. Beta continues with several different words. Gamma closes the final paragraph.';
  for (const changed of [false, true]) {
    const index = new api.PdfSourceIndex(locator, { raw: text + '\n' + text });
    const page = new api.PdfSourceIndex(locator, { raw: changed ? text.replace('starts', 'storts') : text });
    const offset = text.length + 1, searches = [], positions = index.matchPositions;
    index.rememberConnection(offset, offset + 64, page, { start: 0, end: 64 });
    index.matchPositions = function* (needle, ...args) { searches.push(needle); yield* positions.call(this, needle, ...args); };
    const anchors = index.matches([page.normalized.text], index.normalized, { sample: 24, step: 8, page });
    assert.ok(anchors.length, 'confirmed context resolves anchors repeated elsewhere');
    assert.ok(anchors.every(anchor => index.normalized.starts[anchor.start] >= offset));
    assert.equal(searches.includes(page.normalized.text.slice(0, 24)), changed,
      'only unchanged mapped anchors bypass searching');
    assert.equal(anchors.some(anchor => anchor.at === 0), !changed,
      'a changed span cannot supply an exact anchor');
  }
});

test('review, styles and bidirectional selections reuse ranges at nonzero offsets', () => {
  const api = engine(), locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
  const html = '<p>prefix Alpha <i>wrong</i> omega suffix</p>', index = locator.sourceIndex(html);
  const raw = 'noise\nAlpha right omega\nrest';
  const target = new api.PdfSourceIndex(locator, { raw, parts: [
    { start: 0, end: raw.length, font: { italic: false, bold: false } }
  ] });
  const start = index.raw.indexOf('Alpha'), end = index.raw.indexOf(' suffix');
  const connection = index.rememberConnection(start, end, target, { start: 6, end: raw.indexOf('\nrest') });
  const diff = index.connectionDiff(target, connection), ranges = diff.ranges;
  Object.defineProperty(diff, 'parts', { get() { assert.fail('consumers must reuse the mapped ranges'); } });
  const pairs = [[connection, target]], items = index.reviewCandidates(null, false, true, true, [target], pairs);
  assert.equal(api.applyTextEdits(html, items.flatMap(item => item.options[0].edits)), html.replace('wrong', 'right'));
  const fonts = index.formatDifferences([], ['italic', 'bold'], true, pairs);
  assert.equal(fonts.length, 1);
  assert.equal(api.applyTextEdits(html, fonts[0].options[0].edits), html.replace('<i>wrong</i>', 'wrong'));
  const model = { getPositionAt: offset => ({ lineNumber: 1, column: offset + 1 }) };
  assert.ok(index.sourceDecorations(index.reviewCandidates(null, true, false, true, [], pairs), true, true, undefined, model).length);
  for (const range of ranges) for (const key of ['html', 'pdf'])
    Object.defineProperty(range[4], key, { get() { assert.fail('selection must reuse prepared boundary checks'); } });
  const at = index.raw.indexOf('wrong'), hit = index.connectedRange(target, at, at + 5);
  assert.equal(raw.slice(hit.start, hit.end), 'right');
  const reverse = index.connectedRange(target, hit.start, hit.end, true);
  assert.equal(index.raw.slice(reverse.start, reverse.end), 'wrong');
  assert.equal(diff.ranges, ranges);
  assert.equal(connection.editorDiff, diff, 'selection projection reads the diff owned by the connection');
});

test('review candidate switches skip disabled text work and keep font styles independent', () => {
  const api = engine(), locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
  const index = locator.sourceIndex('Alpha wrong Omega');
  const target = new api.PdfSourceIndex(locator, { raw: 'Alpha right Omega', parts: [
    { start: 0, end: 17, font: { italic: true, bold: true } }
  ] });
  index.rememberConnection(0, index.raw.length, target, { start: 0, end: target.raw.length });
  index.diff([target]);
  const connections = index.preparation.pairs;
  assert.ok(index.reviewCandidates(null, false, true, true, [target], connections).some(item => item.comparison.pdf === 'right'));
  const comparisonParts = locator.comparisonParts;
  locator.comparisonParts = () => assert.fail('a cold font-only build must not build the full cache');
  assert.equal(index.reviewCandidates(null, ['bold'], false, false, [target], connections).length, 1);
  assert.equal(index.preparation.differences, undefined, 'filtered builds do not populate the full cache');
  locator.comparisonParts = comparisonParts;
  const snapshot = JSON.stringify(index.differences.items);
  locator.comparisonParts = () => assert.fail('font-only builds must skip text previews');
  index.textEdits = () => assert.fail('font-only builds must skip text edits');
  for (const fonts of [true, ['italic'], ['bold'], [], false]) {
    const items = index.reviewCandidates(null, fonts, false, false, [target], [...connections]);
    assert.ok(items.every(item => item.font && !item.options.length));
    assert.equal(items.length, fonts === false || Array.isArray(fonts) && !fonts.length ? 0 : 1);
    if (Array.isArray(fonts) && fonts.length === 1) assert.equal(items[0].font[fonts[0] === 'bold' ? 'italic' : 'bold'], null);
  }
  assert.equal(JSON.stringify(index.differences.items), snapshot, 'filtered builds leave the shared collection unchanged');
});

test('shared differences refresh on replaced font data and published font versions', () => {
  const api = engine(), locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
  const index = locator.sourceIndex('Alpha'), target = new api.PdfSourceIndex(locator, { raw: 'Alpha', parts: [
    { start: 0, end: 5, font: { italic: false, bold: false } }
  ] });
  index.targets = [target];
  const original = index.differences;
  assert.equal(original.items.filter(item => item.font).length, 0);
  target.parts = [{ start: 0, end: 5, font: { italic: false, bold: true } }];
  const refreshed = index.differences;
  assert.notEqual(refreshed, original);
  assert.equal(refreshed.items.filter(item => item.font).length, 1);
  assert.equal(index.differences, refreshed, 'unchanged data keeps its shared results');
  target.parts[0].font.bold = false;
  target.fontVersion = 1;
  assert.equal(index.differences.items.filter(item => item.font).length, 0);
});

test('ME08-432 joined derZuver retains der and maps the final sentence across anchor groups', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/pdf-selection-me08-432.json', import.meta.url), 'utf8'));
  for (const newline of ['\r\n', '\n']) for (const raw of [fixture.pdf, fixture.layerRaw]) {
    const api = engine(), locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
    const html = fixture.source.replace(/\r?\n/g, newline), index = locator.sourceIndex(html);
    const target = new api.PdfSourceIndex(locator, { raw, parts: [] });
    index?.diff([target]);
    const candidates = index.reviewCandidates(null, false, true, true, [target]);
    const der = index.raw.lastIndexOf('der Zuverlässigkeit');
    assert.ok(!candidates.some(c => c.sourceStart >= der && c.sourceStart <= der + 4 && c.comparison.pdf.trim() === 'der'),
      'the same der cannot be counted again in the following passage');
    const sentence = 'Beweise der Wahrheit und Beweise der Zuverlässigkeit!';
    const at = index.raw.indexOf(sentence);
    const hit = index.connectedRange(target, at, at + sentence.length, false, undefined, true);
    assert.ok(hit, 'one confirmed mapping must cover the sentence across the former seam');
    assert.equal(api.significantText(raw.slice(hit.start, hit.end)), 'BeweisederWahrhaftigkeitundBeweisederZuverlassigkeit!');
    assert.ok(hit.start > raw.lastIndexOf('Mitteilungen'), 'mapping stays in the last paragraph');
    const item = candidates.find(c => c.sourceStart >= at && c.sourceStart < der && c.comparison.pdf === 'aftigk');
    assert.ok(item, 'the actual Wahrheit/Wahrhaftigkeit difference remains reviewable');
    const inserted = index.connectedRange(target, item.sourceStart, item.sourceEnd, false, undefined, true);
    assert.equal(raw.slice(inserted.start, inserted.end), 'aftigk');
    assert.ok(inserted.start >= hit.start && inserted.end <= hit.end);
    assert.ok(api.applyTextEdits(html, item.options[0].edits).includes('Beweise der Wahrhaftigkeit und Beweise der'));
  }
});

test('ME08-412 OCR spacing preserves des and prepares the complete footnote dash difference', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/pdf-selection-me08-412.json', import.meta.url), 'utf8'));
  for (const newline of ['\r\n', '\n']) for (const space of [' ', '  ']) for (const dash of ['–', '—']) {
    const api = engine(), locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
    const html = fixture.source.replace(/\r?\n/g, newline).replace('597–601', `597${dash}601`);
    const index = locator.sourceIndex(html);
    const target = new api.PdfSourceIndex(locator, { raw: fixture.pdf.replace('Gestalt des.', `Gestalt${space}des.`), parts: [] });
    index?.diff([target]);
    const candidates = index.reviewCandidates(null, false, true, true, [target]);
    const des = index.raw.indexOf('des deutschen'), missing = des + 4;
    const word = candidates.filter(c => c.sourceStart < missing + 9 && c.sourceEnd > des);
    assert.equal(word.length, 1);
    assert.equal(word[0].comparison.html.trim(), 'deutschen', 'matching des cannot be borrowed from deutschen');
    assert.ok(word[0].sourceStart >= des + 3);
    assert.match(api.applyTextEdits(html, word[0].options[0].edits), /Gestalt des\s*\.\s*Proletariats/);
    const at = index.raw.indexOf(`597${dash}601`) + 3;
    const item = candidates.find(c => c.sourceStart === at && c.sourceEnd === at + 1);
    assert.ok(item, 'dash is a replacement on first preparation, not a missing -601 insertion');
    assert.deepEqual({ ...item.comparison }, { html: dash, pdf: '-' });
    const hit = index.connectedRange(target, at, at + 1, false, undefined, true);
    assert.equal(target.raw.slice(hit.start, hit.end), '-');
    assert.ok(api.applyTextEdits(html, item.options[0].edits).includes('597-601'));
    const marks = index.sourceDecorations(index.reviewCandidates(null, true, false, true, [], index.connectionPairs([target])), true, true, undefined, { getPositionAt: offset => ({ lineNumber: 1, column: offset + 1 }) });
    assert.ok(marks.some(m => m.range.startColumn === index.starts[at] + 1 && m.range.endColumn === index.ends[at] + 1));
    assert.ok(!marks.some(m => m.range.startColumn <= index.starts[des + 2] + 1 && m.range.endColumn > index.starts[des] + 1));
    for (const [connection] of index.connectionPairs([target])) {
      const diff = index.connectionDiff(target, connection);
      assert.equal(diff.parts.map(p => p.html).join(''), index.raw.slice(connection.start, connection.end));
      assert.equal(diff.parts.map(p => p.pdf).join(''), target.raw.slice(connection.targetStart, connection.targetEnd));
    }
  }
});

test('ME08-411 page text owns overlapping document highlights and hover messages', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/pdf-selection-me08-411.json', import.meta.url), 'utf8'));
  const api = engine(), locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
  const index = locator.sourceIndex(fixture.source);
  const page = new api.PdfSourceIndex(locator, { raw: fixture.pdf, parts: [] });
  index?.diff([page]);
  const document = new api.PdfSourceIndex(locator, { raw: fixture.pdf, pages: [] });
  const pageConnection = index.connections.get(page)[0];
  const connection = index.rememberConnection(pageConnection.start, pageConnection.end, document,
    { start: pageConnection.targetStart, end: pageConnection.targetEnd });
  // Both alignments are valid: the larger scope deletes the earlier repeated re.
  const parts = index.connectionDiff(page, pageConnection).parts.map(part => ({ ...part }));
  const re = parts.findIndex(part => part.changed && part.html === 're' && !part.pdf);
  assert.ok(re > 0);
  for (const key of ['html', 'pdf']) {
    parts[re - 1][key] = parts[re - 1][key].slice(0, -2);
    parts[re + 1][key] = 're' + parts[re + 1][key];
  }
  connection.editorDiff = { distance: 50, parts };
  assert.equal(parts.map(part => part.html).join(''), index.raw.slice(connection.start, connection.end));
  assert.equal(parts.map(part => part.pdf).join(''), document.raw.slice(connection.targetStart, connection.targetEnd));
  // The real rendered page ends before the document mapping does.
  const pageEnd = index.raw.indexOf('noch eine Vorbemerkung');
  const mapped = index.connectedRange(page, pageConnection.start, pageEnd, false, pageConnection, true);
  pageConnection.end = pageEnd;
  pageConnection.targetEnd = mapped.end;
  delete pageConnection.editorDiff;
  const model = { getPositionAt: offset => ({ lineNumber: 1, column: offset + 1 }) };
  const expected = index.sourceDecorations(index.reviewCandidates(null, true, false, true, [], index.connectionPairs([page])), true, true, undefined, model);
  const candidates = index.reviewCandidates(null, false, true, true, [page]).map(({ preview, ...item }) => item);
  const rendered = new api.PdfSourceIndex(locator, { raw: fixture.pdf, parts: [], layer: {} });
  index.connections.set(rendered, [pageConnection]);
  for (const targets of [[document, page], [page, document], [document, page, rendered], [document, page]]) {
    assert.deepEqual(index.sourceDecorations(index.reviewCandidates(null, true, false, true, [], index.connectionPairs(targets)), true, true, undefined, model)
      .filter(mark => mark.range.startColumn - 1 < index.starts[pageEnd]), expected);
    assert.deepEqual(index.reviewCandidates(null, false, true, true, targets).filter(item => item.sourceStart < pageEnd)
      .map(({ preview, ...item }) => item), candidates);
    assert.ok(index.reviewCandidates(null, false, true, true, targets).some(item => item.sourceStart >= pageEnd), 'document-only differences remain available');
    const at = index.raw.indexOf('Prahlerereien');
    const repeated = index.reviewCandidates(null, false, true, true, targets).filter(item => item.sourceStart >= at && item.sourceStart < at + 12);
    assert.equal(repeated.length, 1);
    const [item] = repeated;
    const hit = index.connectedRange(page, item.sourceStart, item.sourceEnd, false, undefined, true);
    assert.equal(page.raw.slice(hit.start, hit.end), '');
    assert.deepEqual({ ...item.comparison }, { html: 're', pdf: '' });
    assert.ok(api.applyTextEdits(fixture.source, item.options[0].edits).includes('durch Prahlereien mit'));
  }
});

test('ME08-423 marked OCR errors reuse confirmed document mappings beyond page connections', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/pdf-selection-me08-423.json', import.meta.url), 'utf8'));
  const api = engine(), locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
  const source = locator.sourceIndex(fixture.source);
  const page = new api.PdfSourceIndex(locator, { raw: fixture.pdf, parts: [] });
  const full = new api.PdfSourceIndex(locator, { raw: fixture.pdf,
    pages: [{ number: 445, start: 0, end: fixture.pdf.length, parts: [] }] });
  locator.getDocumentIndex = () => full;
  locator.environment.getVisiblePages = () => [{ number: 445, index: page }];
  source?.diff([page], {});
  locator.indexDocument = () => { throw new Error('marker lookup must not load offscreen text'); };
  full.locate = () => { throw new Error('marker lookup must reuse a confirmed connection'); };
  for (const [word, pdf] of [['weißen', '\nÎ^'], ['ab', '»h']]) {
    const start = source.raw.lastIndexOf(word === 'ab' ? 'abnahm' : word), end = start + word.length;
    const mapped = source.connectedRange(page, start, end, false, undefined, true);
    if (mapped) assert.equal(page.raw.slice(mapped.start, mapped.end).trim(), pdf.trim());
    const [location] = locator.findLocations({}, [{ index: source, start, end, marked: true,
      text: source.raw.slice(start, end) }], true);
    assert.equal(location.targets.length, 1);
    const target = location.targets[0];
    assert.equal(target.pageNumber, 445);
    assert.equal(target.difference.html, word);
    assert.equal(target.difference.pdf, pdf);
    assert.equal(target.source.index, source);
  }
});

test('ME08-364 initial selection stays in the article when contents has a stronger word match', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/pdf-selection-me08-364.json', import.meta.url), 'utf8'));
  for (const ready of [false, true]) {
    const api = engine(), locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
    const index = locator.sourceIndex(fixture.source), raw = fixture.pdf + '\n' + fixture.contents;
    const full = new api.PdfSourceIndex(locator, { raw, pages: [
      { number: 387, start: 0, end: fixture.pdf.length, parts: [] },
      { number: 778, start: fixture.pdf.length + 1, end: raw.length, parts: [] }
    ] });
    let available = ready;
    locator.getDocumentIndex = () => available ? full : undefined;
    locator.indexDocument = async () => { available = true; return full; };
    // The first word can lie outside a retained connection while page preparation finishes.
    full.sourcePageScope(index, true);
    index.preparation = { document: full };
    const body = index.raw.indexOf('Die folgenden');
    index.rememberConnection(body, index.raw.length, full, { start: raw.indexOf('Die folgenden'), end: fixture.pdf.length });
    const start = index.raw.indexOf('Kossuths'), end = start + 'Kossuths'.length;
    const entry = { index, start, end, text: index.raw.slice(start, end),
      before: index.raw.slice(Math.max(0, start - 160), start), after: index.raw.slice(end, end + 160) };
    const mapped = index.connectedRange(full, start, end);
    assert.equal(full.raw.slice(mapped.start, mapped.end), 'Kossuths');
    assert.ok(mapped.end <= fixture.pdf.length, 'on-demand preparation stays in the article');
    assert.ok(full.locate(entry).start > fixture.pdf.length, 'unrestricted search prefers the contents entry');
    full.sourcePageScope = () => { throw new Error('selection must reuse its prepared page scope'); };
    const [location] = await locator.findLocations({}, [entry]);
    assert.equal(location.targets.length, 1);
    assert.equal(location.targets[0].pageNumber, 387, 'selection must stay on printed page 364');
    assert.equal(location.targets[0].text, 'Kossuths');
  }
});

test('ME08-364 wrapped title compounds keep both sides of the anchor boundary', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/pdf-selection-me08-364.json', import.meta.url), 'utf8'));
  for (const full of [false, true]) for (const hyphen of ['-', '\u2010', '\u2011']) {
    const api = engine(), locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
    const source = fixture.source.replaceAll('Kossuths-Bündnis', `Kossuths${hyphen}Bündnis`);
    const raw = fixture.pdf.replace('Kossuths-\n', `Kossuths${hyphen}\n`);
    const target = new api.PdfSourceIndex(locator, { raw });
    if (full) locator.getDocumentIndex = () => target;
    const index = locator.sourceIndex(source);
    index?.diff([target], {});
    const start = index.raw.indexOf('Kossuths'), end = start + 'Kossuths-Bündnis'.length;
    for (const marked of [false, true]) {
      const hit = index.connectedRange(target, start, end, false, undefined, marked);
      assert.ok(hit, 'the title is inside the confirmed connection');
      assert.equal(raw.slice(hit.start, hit.end), `Kossuths${hyphen}\nBündnis`);
      const reverse = index.connectedRange(target, hit.start, hit.end, true);
      assert.equal(index.raw.slice(reverse.start, reverse.end), `Kossuths${hyphen}Bündnis`);
    }
    const candidates = index.reviewCandidates(null, false, true, true, [target]);
    assert.ok(candidates.length, 'unrelated real OCR differences remain reviewable');
    assert.ok(candidates.every(item => item.sourceStart >= end), 'no false title insertion');
    const corrected = api.applyTextEdits(source, candidates.flatMap(item => item.options[0].edits));
    assert.equal(corrected.split(`Kossuths${hyphen}`).length, 3, 'title and heading each retain one occurrence');
    assert.ok(corrected.endsWith(source.slice(source.indexOf('<aside>'))), 'footnote and file ending stay intact');
  }
});

test('ME05-486 joined PDF words retain matching text at passage edges', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/pdf-selection-me05-486.json', import.meta.url), 'utf8'));
  for (const missing of [false, true]) {
    const api = engine(), locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
    const source = missing ? fixture.source.replace('Unsre ', '') : fixture.source;
    const index = locator.sourceIndex(source), target = new api.PdfSourceIndex(locator, { raw: fixture.pdf });
    index?.diff([target]);
    const candidates = index.reviewCandidates(null, false, true, true, [target]);
    assert.deepEqual(Array.from(candidates, item => ({ ...item.comparison })), missing
      ? [{ html: '×', pdf: 'X' }, { html: '', pdf: 'Unsre' }] : []);
    if (missing) {
      const corrected = api.applyTextEdits(source, candidates.find(item => item.comparison.pdf === 'Unsre').options[0].edits);
      assert.equal(corrected.replace('UnsreVerwickelungen', 'Unsre Verwickelungen'), fixture.source);
    } else {
      const start = index.raw.indexOf('Unsre'), hit = index.connectedRange(target, start, start + 5);
      assert.ok(hit);
      assert.equal(target.raw.slice(hit.start, hit.end), 'Unsre');
    }
  }
});

test('ME05-284 wrapped words and dash variants do not create text highlights', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/pdf-selection-me05-284.json', import.meta.url), 'utf8'));
  for (const source of [fixture.source, fixture.source.replace(/\r\n/g, '\n')]) {
    const api = engine(), locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
    const target = new api.PdfSourceIndex(locator, { raw: fixture.pdf,
      pages: [{ start: 0, end: fixture.pdf.length }], parts: [{ start: 0, end: fixture.pdf.length }] });
    locator.getDocumentIndex = () => target;
    const pdf = {}, index = locator.sourceIndex(source);
    index?.diff([target], pdf);
    const candidates = index.reviewCandidates(null, false, true, true, [target]);
    assert.ok(candidates.length, 'real OCR errors remain reviewable');
    for (const item of candidates) {
      assert.ok(!/Wo|ist|dem|–/.test(item.comparison.html + item.comparison.pdf),
        JSON.stringify(item.comparison));
    }
    const corrected = api.applyTextEdits(source, candidates.flatMap(item => item.options[0].edits));
    const model = { getValue: () => corrected, getVersionId: () => 2,
      getPositionAt: offset => ({ lineNumber: 1, column: offset + 1 }) };
    const revised = locator.editorSourceIndex(model, [target]);
    revised?.diff([target], pdf);
    assert.equal(revised.reviewCandidates(null, false, true, true, [target]).length, 0, 'replaced text stays corrected after remapping');
    assert.equal(revised.sourceDecorations(revised.reviewCandidates(null, true, false, true, [], revised.connectionPairs([target])), true, true, undefined, model).length, 0);
  }
});

test('ME05-284 a real missing letter disappears from review after replacement', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/pdf-selection-me05-284.json', import.meta.url), 'utf8'));
  const api = engine(), locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
  const target = new api.PdfSourceIndex(locator, { raw: fixture.pdf });
  locator.getDocumentIndex = () => target;
  let source = fixture.source.replace('Kölnischen Zeitung', 'Kölnische Zeitung'), version = 1;
  const model = { getValue: () => source, getVersionId: () => version };
  const pdf = {}, index = locator.editorSourceIndex(model, [target]);
  index?.diff([target], pdf);
  const missing = index.reviewCandidates(null, false, true, true, [target]).find(item => item.comparison.pdf === 'n');
  assert.ok(missing, 'a real missing letter must still be detected');
  source = api.applyTextEdits(source, missing.options[0].edits); version++;
  assert.ok(source.includes('Kölnischen Zeitung'));
  const revised = locator.editorSourceIndex(model, [target]);
  revised?.diff([target], pdf);
  assert.equal(revised.reviewCandidates(null, false, true, true, [target]).some(item => item.comparison.pdf === 'n'), false);
});

test('ME05-389 OCR error near the final anchor retains the complete font correction', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/pdf-selection-me05-389.json', import.meta.url), 'utf8'));
  const api = engine(), locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
  const index = locator.sourceIndex(fixture.source), target = new api.PdfSourceIndex(locator, { raw: fixture.pdf, parts: fixture.parts });
  locator.getDocumentIndex = () => target;
  index?.diff([target], {});
  const text = 'Geschrieben von Friedrich Engels.', start = index.raw.indexOf(text), end = start + text.length;
  const hit = index.connectedRange(target, start, end, false, undefined, true);
  assert.ok(hit, 'the final attribution stays in the confirmed alignment');
  assert.equal(target.raw.slice(hit.start, hit.end), 'Geschrieben vyn Friedrich Engels.');
  const item = index.formatDifferences([], ['italic', 'bold'], true, index.connectionPairs([target])).find(item => item.sourceStart === start);
  assert.equal(item?.text, text, 'surplus bold is detected across the OCR error and matching suffix');
  const corrected = api.applyTextEdits(fixture.source, item.options[0].edits);
  assert.equal(corrected, fixture.source.replace(`<b>${text}</b>`, text), 'only formatting changes');
  assert.ok(index.reviewCandidates(null, false, true, true, [target]).some(item => item.comparison.html === 'o' && item.comparison.pdf === 'y'));
  const model = { getPositionAt: offset => ({ lineNumber: 1, column: offset + 1 }) };
  const marks = index.sourceDecorations(index.reviewCandidates(null, true, false, true, [], index.connectionPairs([target])), true, true, undefined, model);
  assert.ok(marks.some(mark => mark.options.description === 'PDF font difference'
    && fixture.source.slice(mark.range.startColumn - 1, mark.range.endColumn - 1) === text));
  assert.ok(marks.some(mark => mark.options.description === 'PDF OCR text difference'
    && fixture.source.slice(mark.range.startColumn - 1, mark.range.endColumn - 1) === 'o'));
});

test('ME05-398 missing word prefix shares the highlight, click mapping and replacement', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/pdf-selection-me05-398.json', import.meta.url), 'utf8'));
  for (const source of [fixture.source, fixture.source.replace(/\r\n/g, '\n')]) {
    const api = engine(), locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
    const index = locator.sourceIndex(source), target = new api.PdfSourceIndex(locator, { raw: fixture.pdf });
    locator.getDocumentIndex = () => target;
    index?.diff([target], {});
    const at = index.raw.indexOf('versammlung'), item = index.reviewCandidates(null, false, true, true, [target]).find(item => item.sourceStart === at);
    assert.equal(item?.comparison.html, '');
    assert.equal(item?.comparison.pdf, 'Vereinbarungs');
    assert.equal(item.sourceEnd, at);
    const hit = index.connectedRange(target, at, at, false, undefined, true);
    assert.equal(target.raw.slice(hit.start, hit.end), 'Vereinbarungs');
    const model = { getPositionAt: offset => ({ lineNumber: 1, column: offset + 1 }) };
    const marks = index.sourceDecorations(index.reviewCandidates(null, true, false, true, [], index.connectionPairs([target])), true, true, undefined, model);
    const mark = marks.find(mark => mark.options.before?.inlineClassName === 'mew-ocr-diff-insert'
      && mark.range.startColumn - 1 === source.indexOf('versammlung') && mark.range.endColumn - 1 === source.indexOf('versammlung'));
    assert.ok(mark, 'the missing prefix has its own clickable insertion caret');
    const range = { start: api.lowerBound(index.ends, mark.range.startColumn),
      end: api.lowerBound(index.starts, mark.range.endColumn - 1) };
    const clicked = index.connectedRange(target, range.start, range.end, false, undefined, true);
    assert.equal(target.raw.slice(clicked.start, clicked.end).trim(), 'Vereinbarungs');
    const corrected = api.applyTextEdits(source, item.options[0].edits);
    assert.equal(corrected, source.replace('Auflösung der versammlung', 'Auflösung der Vereinbarungsversammlung'));
    const revised = locator.sourceIndex(corrected);
    revised?.diff([target], {});
    assert.ok(!revised.reviewCandidates(null, false, true, true, [target]).some(item => item.comparison.pdf.includes('Vereinbarungs')));
  }
});

test('ME05-281 repeated anchors across a broken word preserve the complete passage', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/pdf-selection-me05-281.json', import.meta.url), 'utf8'));
  const api = engine(), locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
  const index = locator.sourceIndex(fixture.source), target = new api.PdfSourceIndex(locator, { raw: fixture.pdf });
  locator.getDocumentIndex = () => target;
  index?.diff([target], {});
  const start = index.raw.lastIndexOf('Anforderungen'), end = start + 'Anforderungen'.length;
  const hit = index.connectedRange(target, start, end, false, undefined, true);
  assert.ok(hit);
  assert.equal(api.significantText(target.raw.slice(hit.start, hit.end)), 'Anforderungen');
  const candidates = index.reviewCandidates(null, false, true, true, [target]);
  assert.equal(candidates.some(item => item.sourceStart < end && item.sourceEnd > start), false);
  assert.deepEqual(Array.from(candidates, item => ({ ...item.comparison })), [{ html: 'h', pdf: 'b' }, { html: 'lb', pdf: 'ih' }]);
});

test('ME05-281 trailing whitespace cannot become a replacement from the next page header', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/pdf-selection-me05-281-boundary.json', import.meta.url), 'utf8'));
  for (const lf of [false, true]) {
    const api = engine(), locator = new api.PdfLocator({}, { document: { createElement: () => ({}) },
      isCurrent: () => true, waitForIdle: async () => {} });
    const index = locator.sourceIndex(lf ? fixture.source.replace(/\r\n/g, '\n') : fixture.source);
    const page = locator.sourceIndex(fixture.pages[0]), pdf = { numPages: 2, getPage: async number => ({
      getTextContent: async () => ({ items: [{ str: fixture.pages[number - 1],
        transform: [1, 0, 0, 1, 0, 100], width: 100, height: 10 }] })
    }) };
    index?.diff([page], pdf);
    const before = Array.from(index.reviewCandidates(null, false, true, true, [page]), item => ({ ...item.comparison }));
    const full = await locator.indexDocument(pdf);
    index?.diff([page, full], pdf);
    assert.deepEqual(Array.from(index.reviewCandidates(null, false, true, true, [page, full]), item => ({ ...item.comparison })), before);
    for (const connection of index.connections.get(full) || [])
      assert.equal(full.raw.slice(full.pages[0].end, connection.targetEnd).trim(), '', 'next page text stays outside the confirmed connection');
    const edits = index.reviewCandidates(null, false, true, true, [full]).flatMap(item => item.options[0].edits);
    assert.ok(!api.applyTextEdits(index.source, edits).includes('Karl'), 'batch replacement cannot append the next header');
  }
});

test('source index initializes empty, page-backed and explicit text parts', () => {
  const { PdfSourceIndex, PdfLocator } = engine(), locator = new PdfLocator();
  const empty = new PdfSourceIndex(locator);
  assert.equal(empty.locator, locator);
  assert.equal(empty.raw, '');
  assert.equal(empty.normalized.text, '');
  assert.deepEqual(Array.from(empty.parts), []);
  assert.deepEqual(Array.from(empty.fontRuns()), []);
  const first = { start: 0, end: 1, font: { bold: true, italic: false } };
  const second = { start: 2, end: 3, font: { bold: false, italic: true } };
  const pages = [{ parts: [first] }, { parts: [second] }];
  const full = new PdfSourceIndex(locator, { raw: 'A B', pages });
  assert.deepEqual(Array.from(full.parts), [first, second]);
  assert.deepEqual(Array.from(full.fontRuns(), run => run.bold), [true, false]);
  const parts = [first];
  assert.equal(new PdfSourceIndex(locator, { raw: 'A', pages, parts }).parts, parts);
});

test('concurrent font indexing shares page work while cancellation stays caller-local', async () => {
  const api = engine();
  let pageReads = 0, operators = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const page = {
    commonObjs: new Map([['f', { name: 'Times', bold: false, italic: false }]]),
    getTextContent: async () => ({ items: [{ str: 'Text', fontName: 'f', transform: [1, 0, 0, 1, 0, 10], height: 10, width: 20 }] }),
    getOperatorList: async () => { operators++; await gate; return { fnArray: [], argsArray: [] }; }
  };
  const pdf = { numPages: 1, getPage: async () => { pageReads++; return page; } };
  const locator = new api.PdfLocator({}, { isCurrent: () => true, waitForIdle: async () => {} });
  const index = await locator.indexDocument(pdf);
  const controller = new AbortController();
  const first = locator.indexFonts(pdf, null, controller.signal), second = locator.indexFonts(pdf);
  await Promise.resolve();
  controller.abort(); release();
  assert.equal(await first, null);
  assert.equal(await second, index);
  assert.equal(pageReads, 1, 'text indexing and font detection use the same PDF page read');
  assert.equal(operators, 1);
  assert.equal(index.fontVersion, 1, 'one metadata publication per page');
});

test('prepared page reuse invalidates when connections or target pages change', () => {
  const locator = new (engine().PdfLocator)({}, { document: { createElement: () => ({}) } });
  const source = locator.sourceIndex('Alpha Beta Gamma Delta');
  const page = locator.sourceIndex(source.raw), pdf = {};
  source?.diff([page], pdf);
  const initial = source.connections.get(page);
  let scopeReads = 0;
  const scopes = source.pageScopes;
  source.pageScopes = { get(target) { scopeReads++; return scopes.get(target); }, set: (target, value) => scopes.set(target, value) };
  for (let i = 0; i < 20; i++) source?.diff([page], pdf);
  assert.equal(scopeReads, 0, 'unchanged mappings bypass preparation entirely');
  assert.equal(source.connections.get(page), initial);
  source.rememberConnection(0, 5, page, { start: 0, end: 5 });
  source?.diff([page], pdf);
  assert.ok(scopeReads > 0, 'new selection mappings invalidate preparation');
  const rebuilt = locator.sourceIndex(source.raw);
  source?.diff([rebuilt], pdf);
  assert.ok(source.connections.get(rebuilt)?.length, 'rebuilt text layers receive fresh mappings');
});

test('file diff updates shared state and retains unchanged sequence diffs', () => {
  const api = engine(), locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
  const source = locator.sourceIndex('Alpha wrong Omega');
  const target = locator.sourceIndex('Alpha right Omega'), pdf = {};
  target.sourcePages = [1];
  source.diff([target], pdf);
  const pairs = source.preparation.pairs;
  assert.ok(pairs.length);
  assert.equal(source.preparation.pairs, pairs);
  source.diff([target], pdf);
  assert.equal(source.preparation.pairs, pairs, 'unchanged file diff reuses its state');
  const diffs = new Map(pairs.map(([connection]) => [connection, connection.editorDiff]));
  for (const pair of pairs) {
    const [connection, index] = pair;
    assert.equal(pair.length, 2, 'prepared pairs do not duplicate the connection-owned diff');
    assert.ok(connection.editorDiff, 'file preparation still prepares sequence diffs eagerly');
    assert.equal(source.connectionDiff(index, connection), diffs.get(connection), 'sequence and global handlers share the same result');
  }
  assert.equal(api.applyTextEdits(source.source, source.reviewCandidates(null, false, true, true, [target], pairs)
    .flatMap(item => item.options[0].edits)), 'Alpha right Omega');
  const extra = locator.sourceIndex('Alpha wrong Omega');
  source.diff([target, extra], pdf);
  const updated = source.preparation.pairs;
  assert.notEqual(updated, pairs, 'changing targets updates the overall diff');
  assert.ok(updated.some(([, index]) => index === extra));
  for (const [connection, index] of pairs)
    assert.equal(updated.find(([item, page]) => item === connection && page === index)?.[0].editorDiff, diffs.get(connection),
      'unchanged sequences survive a global update');
  source.diff([target], {});
  assert.notEqual(source.preparation.pairs, updated, 'PDF replacement refreshes shared state');
});

test('shared differences refresh source, target and font changes without manual preparation', () => {
  const api = engine(), pdf = {};
  let source = 'Alpha wrong Omega', version = 1, targets = [];
  const model = { getValue: () => source, getVersionId: () => version,
    getPositionAt: offset => ({ lineNumber: 1, column: offset + 1 }) };
  const locator = new api.PdfLocator({}, { document: { createElement: () => ({}) },
    getPdf: () => pdf, getTargets: () => targets });
  const page = raw => new api.PdfSourceIndex(locator, { raw, sourcePages: [1], fontVersion: 0,
    parts: [{ start: 0, end: raw.length, font: { bold: false, italic: false } }] });
  targets = [page('Alpha right Omega')];
  const index = locator.editorSourceIndex(model), first = index.differences;
  assert.equal(index.differences, first, 'unchanged consumers reuse the whole classified result');
  assert.ok(first.items.filter(item => !item.font).some(item => item.comparison.pdf === 'right'));
  assert.equal(first.items.filter(item => item.font).length, 0);
  const alignment = first.connections[0][2];
  index.rememberConnection(0, 5, targets[0], { start: 0, end: 5 });
  assert.notEqual(index.differences, first, 'new mappings invalidate the overall result automatically');
  assert.deepEqual(index.differences.items.filter(item => !item.font), first.items.filter(item => !item.font), 'selection mappings preserve the prepared file diff');
  targets[0].parts[0].font.italic = true;
  targets[0].fontVersion++;
  const styled = index.differences;
  assert.notEqual(styled, first);
  assert.ok(styled.items.filter(item => item.font).length, 'font publication refreshes the shared classification');
  assert.equal(styled.connections[0][2], alignment, 'font updates preserve the text alignment');
  const snapshot = JSON.stringify(styled.items);
  Object.freeze(styled.items);
  const buildText = index.textEdits;
  index.textEdits = () => assert.fail('highlight filters must reuse the shared text candidates');
  for (const fonts of [true, false, [], ['bold'], ['italic']]) for (const text of [true, false]) {
    const marks = index.sourceDecorations(index.reviewCandidates(null, fonts, false, text, [], styled.connections), fonts, text, undefined, model);
    if (!text) assert.ok(marks.every(mark => mark.options.description === 'PDF font difference'));
    if (fonts === false || Array.isArray(fonts) && !fonts.length)
      assert.ok(marks.every(mark => mark.options.description === 'PDF OCR text difference'));
    assert.equal(index.differences.items, styled.items, 'toggles keep the shared collection');
  }
  index.textEdits = buildText;
  index.reviewCandidates({ html: 'wrong', pdf: 'right', source: { index, start: 6, end: 11 } }, false, true, true, []);
  assert.equal(index.differences.items, styled.items, 'explicit selections keep their candidates temporary');
  assert.equal(JSON.stringify(styled.items), snapshot, 'views do not mutate the shared candidates');
  source = 'Alpha right Omega'; version++;
  const edited = index.differences;
  assert.equal(edited.index.source, source, 'an older handler follows its current editor snapshot');
  assert.equal(edited.items.filter(item => !item.font).length, 0, 'editor changes update the diff without prepare or refresh calls');
  source = '<i>Alpha right Omega</i>'; version++;
  assert.equal(index.differences.items.filter(item => item.font).length, 0, 'markup edits refresh HTML formatting with unchanged visible text');
  targets = [page('Alpha RIGHT Omega')];
  const replaced = index.differences;
  assert.ok(replaced.items.filter(item => !item.font).length, 'replacing targets updates the current editor diff');
  assert.ok(replaced.connections.every(([, target]) => target === targets[0]), 'disposed targets leave the shared state');
  assert.equal(index.differences, replaced);
});

test('candidate interval lookup retains overlap and insertion boundary rules', () => {
  const api = engine(), locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
  const index = locator.sourceIndex('abcdefghijklmnopqrstuv');
  const intervals = [[5, 8], [0, 2], [2, 5], [8, 8], [7, 10], [8, 11], [11, 14], [14, 14], [13, 15]];
  const targets = intervals.map(([start, end]) => {
    const target = new pdfApi.PdfSourceIndex(new pdfApi.PdfLocator(), { raw: 'XYZ' });
    index.connections.set(target, [{ start, end, targetStart: 0, targetEnd: 3,
      editorDiff: { parts: [{ html: index.raw.slice(start, end), pdf: target.raw, changed: true }] } }]);
    return target;
  });
  assert.deepEqual(Array.from(index.reviewCandidates(null, false, true, true, targets), item => item.id),
    ['0:2', '2:5', '5:8', '8:8', '11:14', '14:14']);
});

test('large selected passages share one comparison between replacement edits and popup rendering', async () => {
  const api = engine(), providers = new Map(), pdf = {};
  const diff = api.textDiff;
  let comparisons = 0;
  api.textDiff = (...args) => { comparisons++; return diff(...args); };
  const locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
  const html = 'A long selected passage with surrounding context. '.repeat(320);
  const index = locator.sourceIndex(html), changed = html.indexOf('selected') + 3;
  const reading = html.slice(0, changed) + 'X' + html.slice(changed + 1);
  const notice = { html, pdf: reading, source: { index, start: 0, end: html.length } };
  const model = { getValue: () => html, getPositionAt: offset => ({ lineNumber: 1, column: offset + 1 }) };
  const editor = { getModel: () => model };
  reviewProvider(api, providers, { viewer: { pdfDocument: pdf }, locator, editor });
  const provider = providers.get('pdf-ocr');
  const items = (await provider.locator.reviewItems({ source: html, model, request: { pdf, notice }, signal: new AbortController().signal })).items;
  assert.equal(items.length, 1);
  const item = items[0], state = { model, items, choices: new Map([[item.id, 'pdf']]) };
  const content = provider.content(state, item);
  provider.content(state, item);
  assert.equal(comparisons, 1, 'opening and rendering the same selection must not repeat its character diff');
  assert.equal(api.applyTextEdits(html, item.options[0].edits), reading, 'cached parts preserve the exact replacement');
  assert.equal(content.comparison[0].parts.map(part => part.text).join(''), html);
  assert.equal(content.comparison[1].parts.map(part => part.text).join(''), reading);
  notice.pdf = reading + '!';
  provider.content(state, item);
  assert.equal(comparisons, 2, 'a changed PDF reading invalidates the comparison');
});

test('review navigation reuses comparison diffs and invalidates changed readings', () => {
  const api = engine(), providers = new Map(), diff = api.textDiff;
  let calls = 0;
  api.textDiff = (...args) => { calls++; return diff(...args); };
  reviewProvider(api, providers);
  const item = { id: 'item', comparison: { html: 'before WRONG after', pdf: 'before RIGHT after' },
    options: [{ id: 'pdf', edits: [] }] };
  const state = { choices: new Map([['item', 'pdf']]), items: [item] };
  const provider = providers.get('pdf-ocr');
  const first = provider.content(state, item);
  for (let i = 0; i < 20; i++) assert.deepEqual(provider.content(state, item).comparison, first.comparison);
  assert.equal(calls, 1);
  item.comparison.pdf = 'before NEW after';
  provider.content(state, item);
  assert.equal(calls, 2, 'changed text must not reuse the preceding diff');
});

test('popup anchor reuses mappings and text geometry while following scrolling and changed connections', () => {
  const window = {};
  vm.runInNewContext(engineSource.replace(
    '  connectedRange(target, start, end, reverse = false, connection, marked = false) {',
    '$& window.mappingCalls = (window.mappingCalls || 0) + 1;'
  ), { window });
  let top = 20, scale = 1, visible, measurements = 0;
  const locator = new window.PdfReviewProvider.PdfLocator({}, {
    getVisiblePages: () => [{ index: visible }],
    document: { createElement: () => ({}), createRange: () => ({ setStart() {}, setEnd() {},
      getClientRects: () => { measurements++; return [
        { left: 10, top, bottom: top + 12, width: 20, height: 12 },
        { left: 0, top: top + 16, bottom: top + 28, width: 0, height: 12 }
      ]; } }) }
  });
  const source = locator.sourceIndex('Alpha Beta');
  visible = locator.sourceIndex('Alpha Beta');
  visible.layer = { isConnected: true, getBoundingClientRect: () => ({ left: 0, top: top - 20, width: 600 * scale, height: 800 * scale }) };
  visible.parts = [{ start: 0, end: visible.raw.length, node: { length: visible.raw.length } }];
  source.rememberConnection(0, source.raw.length, visible, { start: 0, end: visible.raw.length });
  const item = { sourceStart: 6, sourceEnd: 10, pdfSource: { index: source, start: 6, end: 10 } };
  assert.equal(locator.reviewAnchor(item, source).top, 20);
  assert.equal(locator.reviewAnchor(item, source).left, 10, 'a collapsed next-line rect must not pull a text anchor to the left');
  assert.equal(locator.reviewAnchor(item, source).bottom, 32, 'a collapsed next-line rect must not extend a text anchor downwards');
  const initial = window.mappingCalls;
  top = 50;
  assert.equal(locator.reviewAnchor(item, source).top, 50, 'scrolling follows the current layer position');
  assert.equal(measurements, 1, 'scrolling does not remeasure selected text');
  assert.equal(window.mappingCalls, initial, 'scrolling reuses the confirmed mapping');
  scale = 2;
  assert.equal(locator.reviewAnchor(item, source).bottom, 94, 'cached coordinates follow the layer scale');
  assert.equal(measurements, 1, 'scaling existing geometry needs no text measurement');
  scale = 1;
  source.connections.set(visible, [...source.connections.get(visible)]);
  locator.reviewAnchor(item, source);
  assert.ok(window.mappingCalls > initial, 'changed connections invalidate the mapping');
  assert.equal(measurements, 2, 'changed connections invalidate text geometry');
  visible.layer.isConnected = false;
  assert.equal(locator.reviewAnchor(item, source), null, 'detached layers never anchor a popup');
});

test('PDF newline differences use a caret without highlighting adjacent letters', () => {
  for (const newline of ['\n', '\r\n', '\r']) {
    const endpoints = [];
    const provider = reviewProvider(engine(), new Map(), undefined, { createRange: () => ({
      setStart(node, offset) { endpoints.push([node, offset]); },
      setEnd(node, offset) { endpoints.push([node, offset]); },
      getBoundingClientRect: () => ({ left: 20, right: 20, top: 20, width: 0, height: 10 }),
      getClientRects: () => [{ left: 20, right: 20, top: 20, width: 0, height: 10 }]
    }) });
    const next = { length: 4 }, raw = 'alpha' + newline + 'beta';
    const index = new pdfApi.PdfSourceIndex(new pdfApi.PdfLocator(), { raw, parts: [
      { node: { length: 5 }, start: 0, end: 5 },
      { node: next, start: 5 + newline.length, end: raw.length }
    ] });
    const div = { clientLeft: 0, clientTop: 0, clientWidth: 100, clientHeight: 100,
      offsetWidth: 100, offsetHeight: 100, getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }) };
    const hit = { start: 5, end: 5 + newline.length, difference: { html: 's', pdf: newline } };
    const result = provider.highlights.measureHighlights(div, index, [hit], hit);
    assert.deepEqual(endpoints, [[next, 0], [next, 0]], 'both PDF range endpoints stay at the insertion point');
    assert.equal(result.boxes.length, 1);
    assert.equal(result.boxes[0].caret, true);
    assert.equal(result.boxes[0].w, .02);
    assert.equal(result.notices[0].pdf, newline, 'replacement retains the actual line break');
  }
});

test('font detection preserves unknown attributes and merges only compatible UTF-16 runs', () => {
  const api = engine();
  assert.equal(new api.PdfLocator().fontStyle(null, 'g_d0_f1').italic, null);
  assert.equal(new api.PdfLocator().fontStyle(null, 'serif', { fontWeight: '400', fontStyle: 'normal' }).bold, null);
  const italic = new api.PdfLocator().fontStyle({ name: 'ABCDEF+Times-Italic', italic: true, bold: false });
  const bold = new api.PdfLocator().fontStyle({ name: 'Helvetica-Bold', italic: false, bold: true });
  assert.equal(italic.italic, true);
  assert.equal(italic.bold, false);
  assert.equal(new api.PdfLocator().fontStyle({ name: 'Blackadder', bold: false }).bold, false, 'explicit metadata takes priority over name hints');
  assert.equal(new api.PdfLocator().fontStyle(null, 'Times-BoldOblique').bold, true);
  assert.equal(new api.PdfLocator().fontStyle(null, '', { fontStyle: 'oblique 12deg' }).italic, true);
  const index = new pdfApi.PdfSourceIndex(new pdfApi.PdfLocator(), { raw: '𠀀a b c', parts: [
    { start: 0, end: 3, font: italic }, { start: 4, end: 5, font: italic }, { start: 6, end: 7, font: bold }
  ] });
  const runs = index.fontRuns(2, 7);
  assert.equal(runs.length, 2);
  assert.equal(index.raw.slice(runs[0].start, runs[0].end), 'a b');
  const hover = formats => reviewProvider(api).locator.sourceHover({ font: {}, formats }, {}).value;
  assert.match(hover(runs.map(run => ({ htmlFont: run, font: run }))), /斜体：混合；粗体：混合/);
  assert.match(hover([]), /未知/);
});

test('independent text differences stay separate across tags while format runs retain their grouping', () => {
  const api = engine();
  const locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
  const source = '<p><i>liebe</i>“ …</p>\n<p>later <b>abc</b>.</p>';
  const model = { getValue: () => source, getVersionId: () => 1 };
  const index = locator.editorSourceIndex(model);
  const target = new pdfApi.PdfSourceIndex(new pdfApi.PdfLocator(), { raw: index.raw.replace('liebe“ …', 'Liebe" ...').replace('abc', 'xyz') });
  index.rememberConnection(0, index.raw.length, target, { start: 0, end: target.raw.length });
  const items = index.reviewCandidates(null, false, true, true, [target]);
  assert.deepEqual(Array.from(items, item => [item.comparison.html, item.comparison.pdf]),
    [['l', 'L'], ['“', '"'], ['…', '...'], ['abc', 'xyz']]);
  const updated = api.applyTextEdits(source, items.flatMap(item => item.options[0].edits));
  assert.equal(updated, '<p><i>Liebe</i>" ...</p>\n<p>later <b>xyz</b>.</p>', 'merged edits preserve inline tags');

  const formatted = '<p><i>a</i><b>b</b> <i>c</i><b>d</b></p>\n<p><i>E</i><b>F</b></p>';
  const formatIndex = locator.editorSourceIndex({ getValue: () => formatted, getVersionId: () => 1 });
  const regular = new pdfApi.PdfSourceIndex(new pdfApi.PdfLocator(), { raw: formatIndex.raw, parts: [{ start: 0, end: formatIndex.raw.length, font: { italic: false, bold: false } }] });
  const connection = formatIndex.rememberConnection(0, formatIndex.raw.length, regular, { start: 0, end: regular.raw.length });
  const formats = formatIndex.formatDifferences([], ['italic', 'bold'], true, [[connection, regular]]);
  assert.deepEqual(Array.from(formats, item => item.text), ['ab cd', 'EF']);
  assert.equal(formats[0].formats.length, 4, 'both bold and italic details survive grouping');
});

test('OCR text indexing starts shared font detection and retains unavailable metadata as unknown', async () => {
  const api = engine();
  let operators = 0;
  const objects = new Map();
  const pdf = { numPages: 1, getPage: async () => ({
    commonObjs: objects,
    getOperatorList: async () => { operators++; objects.set('f1', { name: 'Times-BoldItalic', italic: true, bold: true }); },
    getTextContent: async () => ({ items: ['f1', 'missing'].map((fontName, i) => ({
      str: i ? 'unknown' : 'styled', fontName, transform: [1, 0, 0, 1, 0, 100 - i * 20], height: 12, width: 40
    })) })
  }) };
  const locator = new api.PdfLocator({}, { isCurrent: () => true, waitForIdle: async () => {} });
  const text = await locator.indexDocument(pdf);
  assert.equal(operators, 1, 'the OCR page read starts font detection without a separate review pass');
  const full = await locator.indexFonts(pdf);
  assert.equal(full, text, 'font data enriches the existing text index');
  const runs = full.fontRuns();
  assert.equal(runs[0].italic, true);
  assert.equal(runs[0].bold, true);
  assert.equal(runs[1].italic, null);
  assert.equal(await locator.indexFonts(pdf), full);
  assert.equal(operators, 1);
});

test('page-uniform styles become unknown independently of other pages', async () => {
  for (const styles of [
    [[true, false], [true, true]],
    [[false, true], [true, true]],
    [[true, true], [true, true]],
    [[true, false], [true, false]],
    [[false, true], [false, true]],
    [[false, false], [true, true]],
    [[true, true], [null, null]]
  ]) {
    const api = engine();
    const pages = styles.map(([bold, italic], i) => ({
      commonObjs: new Map([['f', { name: `Face${i}`, bold, italic }]]),
      getOperatorList: async () => ({ fnArray: [37, 38, 44], argsArray: [['f', 12], [3], []] }),
      getTextContent: async () => ({ items: [{ str: `Page${i}`, fontName: 'f', transform: [1, 0, 0, 1, 0, 100], height: 12, width: 40 }] })
    }));
    const pdf = { numPages: pages.length, getPage: async number => pages[number - 1] };
    const locator = new api.PdfLocator({}, { isCurrent: () => true, waitForIdle: async () => {} });
    const full = await locator.indexFonts(pdf);
    for (let i = 0; i < styles.length; i++) {
      const font = full.pages[i].parts[0].font;
      for (const [column, key] of ['bold', 'italic'].entries()) {
        const uniform = styles[i][column] === true;
        assert.equal(font[key], uniform ? null : styles[i][column]);
        if (uniform) assert.match(font.reason, /均为/);
      }
    }
    assert.equal(await locator.indexFonts(pdf), full);
    if (styles.every(style => style[0] === styles[0][0] && style[1] === styles[0][1])) {
      // Unknown attributes must produce neither missing nor surplus style marks.
      for (const htmlStyle of [false, true]) {
        const index = new pdfApi.PdfSourceIndex(new pdfApi.PdfLocator(), { raw: full.raw, formats: Array.from(full.raw, () => ({ bold: htmlStyle, italic: htmlStyle })) });
        const connection = { start: 0, end: full.raw.length, targetStart: 0, targetEnd: full.raw.length };
        const items = index.formatDifferences([], ['italic', 'bold'], true, [[connection, full]]);
        const knownMismatch = styles[0].some(value => value === false && htmlStyle);
        assert.equal(items.length > 0, knownMismatch);
      }
    }
  }
});

test('uniform page styles are unknown even while later pages are pending', async () => {
  const api = engine();
  let finish, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { finish = resolve; });
  const pages = [1, 2].map(number => ({
    commonObjs: new Map([['f', { name: 'Times-BoldItalic', bold: true, italic: true }]]),
    getTextContent: async () => ({ items: [{ str: `Page${number}`, fontName: 'f', transform: [1, 0, 0, 1, 0, 100], height: 12, width: 40 }] }),
    async getOperatorList() { if (number === 2) { entered(); await gate; } return { fnArray: [], argsArray: [] }; }
  }));
  const pdf = { numPages: 2, getPage: async number => pages[number - 1] };
  const locator = new api.PdfLocator({}, { isCurrent: () => true, waitForIdle: async () => {} });
  const full = await locator.indexDocument(pdf);
  const pending = locator.indexFonts(pdf);
  await waiting;
  assert.ok(full.fontRuns().every(run => run.bold === null && run.italic === null));
  finish();
  await pending;
  assert.ok(full.fontRuns().every(run => run.bold === null && run.italic === null));
});

test('text and font differences coexist across changed text with uniform PDF fonts', () => {
  const api = engine(), locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
  for (const [html, pdf] of [['WRONG', 'RIGHT'], ['longer', 'x'], ['x', 'longer']]) {
    const index = locator.sourceIndex(html);
    const target = new api.PdfSourceIndex(locator, { raw: pdf,
      parts: [{ start: 0, end: pdf.length, font: { bold: true, italic: false } }] });
    const connection = index.rememberConnection(0, html.length, target, { start: 0, end: pdf.length });
    const diff = { parts: [{ html, pdf, changed: true }] };
    connection.editorDiff = diff;
    const fonts = index.formatDifferences([], ['italic', 'bold'], true, [[connection, target]]);
    assert.deepEqual(Array.from(fonts, item => item.text), [html]);
    assert.ok(index.reviewCandidates(null, false, true, true, [target]).length, 'font detection retains the text candidate');
    assert.equal(api.applyTextEdits(html, fonts[0].options[0].edits), `<b>${html}</b>`);
    target.parts = [{ start: 0, end: 1, font: { bold: true } },
      { start: 1, end: pdf.length, font: { bold: false } }];
    if (pdf.length > 1) assert.equal(index.formatDifferences([], ['italic', 'bold'], true, [[connection, target]]).length, 0,
      'unaligned text spanning conflicting PDF fonts has no inferred format edit');
  }
});

test('wrong OCR readings retain eligible styles across font names and HTML-only characters', () => {
  const api = engine(), locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
  for (const [text, pdf] of [['Neue Rheinische Zeitung', 'Neüe Rheinische Zeitung'],
    ['Neue Rheinische Zeitung', 'Nue Rheinische Zeitung'], ['WRONG', 'RIGHT']]) {
    const html = `<b>${text}</b>`, index = locator.sourceIndex(html);
    const target = new api.PdfSourceIndex(locator, { raw: pdf, parts: Array.from(pdf, (_, i) => ({
      start: i, end: i + 1, font: { name: `Face${i % 2}`, bold: false, italic: false }
    })) });
    const connection = index.rememberConnection(0, text.length, target, { start: 0, end: pdf.length });
    const items = index.formatDifferences([], ['italic', 'bold'], true, [[connection, target]]);
    assert.equal(items.length, 1);
    assert.equal(items[0].text, text, 'the correction covers the complete HTML bold span');
    assert.equal(api.applyTextEdits(html, items[0].options[0].edits), text, 'format correction preserves the HTML reading');
    assert.ok(index.reviewCandidates(null, false, true, true, [target]).length, 'OCR text remains separately reviewable');
  }
  const index = locator.sourceIndex('<b>AxB</b>');
  const target = new api.PdfSourceIndex(locator, { raw: 'AB', parts: [
    { start: 0, end: 1, font: { bold: false, italic: false } },
    { start: 1, end: 2, font: { bold: true, italic: false } }
  ] });
  const connection = index.rememberConnection(0, 3, target, { start: 0, end: 2 });
  assert.deepEqual(Array.from(index.formatDifferences([], ['italic', 'bold'], true, [[connection, target]]), item => item.text), ['A'],
    'an HTML-only character between conflicting styles has no inferred bold correction');
  const mixed = locator.sourceIndex('<b><i>WRONG</i></b>');
  target.raw = 'RIGHT';
  target.parts = [
    { start: 0, end: 2, font: { bold: false, italic: false } },
    { start: 2, end: 5, font: { bold: false, italic: true } }
  ];
  const changed = { start: 0, end: 5, targetStart: 0, targetEnd: 5,
    editorDiff: { parts: [{ html: 'WRONG', pdf: 'RIGHT', changed: true }] } };
  const eligible = mixed.formatDifferences([], ['italic', 'bold'], true, [[changed, target]]);
  assert.equal(api.applyTextEdits(mixed.source, eligible[0].options[0].edits), '<i>WRONG</i>',
    'uniform bold is corrected while mixed italic stays unchanged');
  target.parts[1].font.bold = null;
  target.fontVersion = (target.fontVersion || 0) + 1;
  assert.equal(mixed.formatDifferences([], ['italic', 'bold'], true, [[changed, target]]).length, 0, 'unknown bold prevents an inferred edit');
});

test('non-bold OCR metadata survives a page containing normal and italic text', async () => {
  const api = engine(), locator = new api.PdfLocator();
  const items = [{ str: 'Neüe Rheinische Zeitung', fontName: 'regular' }, { str: 'Köln', fontName: 'italic' }];
  const page = { commonObjs: new Map([
    ['regular', { name: 'TimesNewRomanPSMT', bold: false, italic: false }],
    ['italic', { name: 'TimesNewRomanPS-ItalicMT', bold: false, italic: true }]
  ]), getOperatorList: async () => ({ fnArray: [37, 38, 44, 37, 44],
    argsArray: [['regular', 12], [3], [], ['italic', 12], []] }) };
  const fonts = await locator.readPageFonts(page, items);
  assert.equal(fonts.get('regular').bold, false);
  assert.equal(fonts.get('regular').italic, false);
  assert.equal(fonts.get('italic').bold, false);
  assert.equal(fonts.get('italic').italic, true);
});

test('text and font highlights keep independent ranges across tags and adjacent changes', () => {
  const api = engine(), provider = reviewProvider(api);
  const locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
  const model = { getPositionAt: offset => ({ lineNumber: 1, column: offset + 1 }) };
  for (const [markup, pdf, text, fonts] of [
    ['<i>keinen</i>', 'keinem', ['n'], ['keinen']],
    ['h<i>eine</i>X', 'keineY', ['h', 'X'], ['eine']],
    ['<i>h<b>ein</b>e</i>', 'keine', ['h'], ['h', 'ein', 'e']],
    ['<i>heine Worte</i>', 'keine Worte', ['h'], ['heine Worte']]
  ]) {
    const index = locator.sourceIndex(markup);
    const target = new api.PdfSourceIndex(locator, { raw: pdf,
      parts: [{ start: 0, end: pdf.length, font: { italic: false, bold: false } }] });
    const connection = index.rememberConnection(0, index.raw.length, target, { start: 0, end: pdf.length });
    index.fontEdits = () => assert.fail('Highlighting must not build format replacement edits');
    const marks = index.sourceDecorations(index.reviewCandidates(null, true, false, true, [target], [[connection, target], [connection, target]]), true, true, item => provider.locator.sourceHover(item, model), model);
    for (const [className, expected] of [['mew-ocr-diff-text', text], ['mew-font-diff-text', fonts]]) {
      assert.deepEqual(Array.from(marks.filter(mark => mark.options.inlineClassName === className),
        mark => markup.slice(mark.range.startColumn - 1, mark.range.endColumn - 1)), expected);
    }
    for (const { options } of marks) {
      const font = options.inlineClassName === 'mew-font-diff-text';
      assert.equal(options.description, font ? 'PDF font difference' : 'PDF OCR text difference');
      assert.match(options.hoverMessage.value, font ? /PDF: 斜体/ : /PDF:/);
    }
  }
  const index = locator.sourceIndex('<i>word</i> gap WRONG');
  const target = new api.PdfSourceIndex(locator, { raw: 'word gap RIGHT',
    parts: [{ start: 0, end: 14, font: { italic: false, bold: false } }] });
  const connection = index.rememberConnection(0, index.raw.length, target, { start: 0, end: target.raw.length });
  assert.deepEqual(Array.from(index.sourceDecorations(index.reviewCandidates(null, true, false, true, [], [[connection, target]]), true, true, undefined, model), mark => mark.options.description),
    ['PDF font difference', 'PDF OCR text difference'], 'unchanged gaps keep unrelated differences separate');
});

test('independent bold and italic detection limits highlights and applied styles', () => {
  const api = engine(), locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
  const html = '<p>Word</p>', index = locator.sourceIndex(html);
  const target = new api.PdfSourceIndex(locator, { raw: index.raw,
    parts: [{ start: 0, end: index.raw.length, font: { italic: true, bold: true } }] });
  const connection = index.rememberConnection(0, index.raw.length, target, { start: 0, end: target.raw.length });
  const pairs = [[connection, target]], model = { getPositionAt: at => ({ lineNumber: 1, column: at + 1 }) };
  for (const key of ['bold', 'italic']) {
    const items = index.formatDifferences([], [key], true, pairs);
    assert.equal(items.length, 1);
    const result = locator.sourceIndex(api.applyTextEdits(html, items[0].options[0].edits));
    assert.equal(result.formats[0][key], true);
    assert.equal(result.formats[0][key === 'bold' ? 'italic' : 'bold'], false, 'disabled style is never applied');
    assert.equal(index.sourceDecorations(index.reviewCandidates(null, [key], false, false, [], pairs), [key], false, undefined, model).length, 1);
    assert.equal(index.formatDifferences([], ['italic', 'bold'], true, pairs)[0].font[key === 'bold' ? 'italic' : 'bold'], true,
      'filtering preserves the cached PDF font');
  }
  assert.equal(index.formatDifferences([], [], true, pairs).length, 0);
  assert.equal(index.sourceDecorations(index.reviewCandidates(null, [], false, false, [], pairs), [], false, undefined, model).length, 0);
  const italic = locator.sourceIndex('<p><i>Word</i></p>');
  const same = italic.rememberConnection(0, italic.raw.length, target, { start: 0, end: target.raw.length });
  assert.equal(italic.formatDifferences([], ['italic'], true, [[same, target]]).length, 0,
    'a bold-only fault disappears when bold detection is disabled');
  const item = italic.formatDifferences([], ['bold'], true, [[same, target]])[0];
  const updated = locator.sourceIndex(api.applyTextEdits(italic.source, item.options[0].edits));
  assert.equal(updated.formats[0].bold, true);
  assert.equal(updated.formats[0].italic, true, 'adding bold preserves existing italic markup');
});

test('format differences include missing, surplus and partially marked bold italic', () => {
  const api = engine();
  const locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
  for (let level = 1; level <= 6; level++) {
    const heading = locator.sourceIndex(`<h${level}>2<br>Engels an Marx<br>in London</h${level}>`);
    const target = new pdfApi.PdfSourceIndex(new pdfApi.PdfLocator(), { raw: heading.raw, parts: [{ start: 0, end: heading.raw.length, font: { bold: false, italic: false } }] });
    const connection = heading.rememberConnection(0, heading.raw.length, target, { start: 0, end: target.raw.length });
    assert.equal(heading.formatDifferences([], ['italic', 'bold'], true, [[connection, target]]).length, 0, 'a heading alone does not declare bold');
    for (const markup of ['<b>Title</b>', '<strong>Title</strong>', '<span style="font-weight:700">Title</span>']) {
      const explicit = locator.sourceIndex(`<h${level}>${markup}</h${level}>`);
      assert.equal(explicit.formats[0].bold, true, 'explicit bold inside a heading is retained');
    }
  }
  const html = '<p><i>A</i> <b>B</b> <b><i>C</i></b> <strong>D</strong> <em>E</em> <b style="font-weight:normal">F</b> <i style="font-style:normal">G</i> 𠀀</p>';
  const index = locator.sourceIndex(html);
  const styles = [
    ['A', true, true], ['B', true, true], ['C', false, false], ['D', false, true],
    ['E', true, false], ['F', false, false], ['G', false, false], ['𠀀', true, null]
  ];
  const target = new pdfApi.PdfSourceIndex(new pdfApi.PdfLocator(), { raw: index.raw, parts: styles.map(([text, italic, bold]) => ({
    start: index.raw.indexOf(text), end: index.raw.indexOf(text) + text.length, font: { italic, bold, name: 'fixture' }
  })) });
  const connection = index.rememberConnection(0, index.raw.length, target, { start: 0, end: target.raw.length });
  const items = index.formatDifferences([], ['italic', 'bold'], true, [[connection, target], [connection, target]]);
  assert.deepEqual(Array.from(items, item => item.text), ['A B C', '𠀀']);
  assert.equal(items[0].htmlFont.bold, false, 'italic alone misses the bold half');
  assert.equal(items[0].formats[1].htmlFont.italic, false, 'bold alone misses the italic half');
  assert.equal(items[0].formats[2].font.bold, false, 'surplus HTML formatting is also flagged');
  const revised = api.applyTextEdits(html, items.flatMap(item => item.options[0].edits));
  const corrected = locator.sourceIndex(revised);
  assert.equal(corrected.raw, index.raw, 'format replacement preserves all visible text and UTF-16 characters');
  const confirmed = corrected.rememberConnection(0, corrected.raw.length, target, { start: 0, end: target.raw.length });
  assert.equal(corrected.formatDifferences([], ['italic', 'bold'], true, [[confirmed, target, api.textDiff(corrected, target, confirmed)]]).length, 0, 'missing, surplus and mixed bold/italic are corrected together');
  assert.ok(revised.includes('<strong>D</strong> <em>E</em>'), 'already correct formatting stays unchanged');
  const model = { getPositionAt: at => ({ lineNumber: 1, column: at + 1 }) };
  const marks = index.sourceDecorations(index.reviewCandidates(null, true, false, true, [], [[connection, target]]), true, true, undefined, model);
  assert.ok(marks.length >= 4);
  assert.ok(marks.every(mark => !html.slice(mark.range.startColumn - 1, mark.range.endColumn - 1).includes('<')), 'decorations exclude markup');
});

test('font edits move nearby bold and italic boundaries instead of duplicating wrappers', () => {
  const api = engine();
  const locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
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
    const revised = api.applyTextEdits(html, index.fontEdits(start, start + 1, font));
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

test('font edits move touching tags and remove all selected bold and italic wrappers for plain text', () => {
  const api = engine();
  const locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
  for (const [html, selected, font, expected] of [
    ['<p><i>A</i>B</p>', 'B', { italic: true }, '<p><i>AB</i></p>'],
    ['<p>B<em>C</em></p>', 'B', { italic: true }, '<p><em>BC</em></p>'],
    ['<p><strong>A</strong>B<strong>C</strong></p>', 'B', { bold: true }, '<p><strong>ABC</strong></p>'],
    ['<p><b><i>ABC</i></b></p>', 'ABC', { bold: false, italic: false }, '<p>ABC</p>'],
    ['<p><b>A<i>B</i>C</b></p>', 'ABC', { bold: false, italic: false }, '<p>ABC</p>'],
    ['<p><i style="font-style:normal">ABC</i></p>', 'ABC', { italic: false }, '<p>ABC</p>'],
    ['<p><b><i>ABC</i></b></p>', 'B', { bold: false, italic: false }, '<p><b><i>A</i></b>B<b><i>C</i></b></p>']
  ]) {
    const index = locator.sourceIndex(html), start = index.raw.indexOf(selected);
    const revised = api.applyTextEdits(html, index.fontEdits(start, start + selected.length, font));
    assert.equal(revised, expected);
    assert.equal(locator.sourceIndex(revised).raw, index.raw);
  }
});

test('font edits reuse source coordinates and preserve entities, attributes and inline structure', () => {
  const api = engine();
  const document = { createElement: () => ({ set innerHTML(text) { this.content = { textContent: text === '&amp;' ? '&' : text }; } }) };
  const locator = new api.PdfLocator({}, { document });
  const html = '<p id="keep"><i>A&amp;<a href="/keep">𠀀B</a>C</i></p>';
  const index = locator.sourceIndex(html);
  document.createElement = () => { throw new Error('must reuse the existing source index'); };
  const edits = index.fontEdits(1, 5, { italic: false, bold: true });
  const revised = api.applyTextEdits(html, edits);
  assert.equal(revised, '<p id="keep"><i>A</i><span style="font-weight:bold">&amp;</span><a href="/keep"><span style="font-weight:bold">𠀀B</span></a><i>C</i></p>');
  assert.equal(index.fontEdits(0, 1, { italic: null, bold: null }).length, 0, 'unknown PDF styles never produce automatic edits');
  assert.throws(() => api.applyTextEdits(html.replace('𠀀B', 'changed'), edits), /原文已变化/);
});

test('normal PDF formatting removes surplus tags and preserves formatting outside a partial correction', () => {
  const api = engine();
  const locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
  for (const [html, expected] of [
    ['<p><i>Vorträge über die Grundlagen</i></p>', '<p>Vorträge über die Grundlagen</p>'],
    ['<p><b><em>Vorträge über die Grundlagen</em></b></p>', '<p>Vorträge über die Grundlagen</p>'],
    ['<p><span style="font-style:italic;color:red">Vorträge über die Grundlagen</span></p>', '<p><span style="color:red">Vorträge über die Grundlagen</span></p>'],
    ['<p><i id="keep">Vorträge über die Grundlagen</i></p>', '<p><span id="keep">Vorträge über die Grundlagen</span></p>']
  ]) {
    const index = locator.sourceIndex(html), end = index.raw.trimEnd().length;
    assert.equal(api.applyTextEdits(html, index.fontEdits(0, end, { italic: false, bold: false })), expected);
  }
  const html = '<p><i>A<a href="/keep">BC</a>D</i></p>', index = locator.sourceIndex(html);
  const edits = index.fontEdits([
    { sourceStart: 1, sourceEnd: 2, font: { italic: false, bold: null } },
    { sourceStart: 3, sourceEnd: 4, font: { italic: false, bold: null } }
  ]);
  const revised = api.applyTextEdits(html, edits);
  assert.equal(revised, '<p><i>A</i><a href="/keep">B<i>C</i></a>D</p>');
  const corrected = locator.sourceIndex(revised);
  assert.equal(corrected.raw, index.raw);
  assert.deepEqual(Array.from(corrected.formats.slice(0, 4), font => font.italic), [true, false, true, false]);
});

test('retained OCR font declarations participate in style comparison even when invisible or not embedded', async () => {
  const api = engine();
  const objects = new Map([
    ['hidden', { name: 'TimesNewRomanPS-BoldMT', italic: false, bold: true, missingFile: true }],
    ['hiddenItalic', { name: 'TimesNewRomanPS-BoldItalicMT', italic: true, bold: true, missingFile: false }],
    ['visible', { name: 'Helvetica-Bold', italic: false, bold: true, missingFile: true }],
    ['regular', { name: 'Helvetica', italic: false, bold: false }]
  ]);
  const items = [...objects.keys()].map(fontName => ({ fontName, str: fontName }));
  let calls = 0;
  const page = { commonObjs: objects, getOperatorList: async () => {
    calls++;
    return { fnArray: [10, 38, 37, 44, 37, 44, 11, 37, 44],
      argsArray: [[], [3], ['hidden', 8.5], [], ['hiddenItalic', 8.5], [], [], ['visible', 12], []] };
  } };
  const fonts = await new api.PdfLocator().readPageFonts(page, items);
  assert.equal(fonts.get('hidden').bold, true);
  assert.equal(fonts.get('hidden').declaredBold, true);
  assert.match(fonts.get('hidden').reason, /OCR 字体/);
  assert.equal(fonts.get('hiddenItalic').italic, true);
  assert.equal(fonts.get('hiddenItalic').declaredItalic, true);
  assert.equal(fonts.get('hiddenItalic').bold, true);
  assert.equal(fonts.get('visible').bold, true);
  assert.equal(await new api.PdfLocator().readPageFonts(page, items), fonts);
  assert.equal(calls, 1);
});

test('mixed visibility retains font declarations but failed inspection remains unknown', async () => {
  const api = engine(), commonObjs = new Map([['f', { name: 'Helvetica-Bold', bold: true, italic: false }]]);
  for (const [i, getOperatorList] of [
    async () => ({ fnArray: [37, 44, 38, 44], argsArray: [['f', 12], [], [7], []] }),
    async () => { throw new Error('unavailable operators'); }
  ].entries()) {
    const fonts = await new api.PdfLocator().readPageFonts({ commonObjs, getOperatorList }, [{ fontName: 'f', str: 'Word' }]);
    assert.equal(fonts.get('f').bold, null, 'uniform bold is unknown regardless of visibility');
    assert.equal(fonts.get('f').italic, i === 0 ? false : null);
    assert.ok(fonts.get('f').reason);
  }
});

test('review font loading uses metadata without reading scan pixels', async () => {
  for (const uniform of [false, true]) {
    const api = engine(), width = 600, height = 600, data = new Uint8Array(width * height / 8).fill(255);
    const items = Array.from({ length: 12 }, (_, i) => ({ str: 'abcdefghijklmnopqrst', fontName: i === 11 ? 'regular' : 'bold',
      transform: [24, 0, 0, 24, 50, 550 - i * 40], height: 24, width: 400 }));
    for (const [i, item] of items.entries()) {
      const thickness = uniform || i === 2 ? 5 : 2, top = height - item.transform[5] - 18;
      for (let glyph = 0; glyph < 20; glyph++) for (let y = top; y < top + 18; y++)
        for (let x = 55 + glyph * 18; x < 55 + glyph * 18 + thickness; x++)
          data[y * (width / 8) + (x >> 3)] &= ~(128 >> (x & 7));
    }
    const page = { commonObjs: new Map([['bold', { name: 'Same-Bold', bold: true, italic: false }],
      ['regular', { name: 'Same-Regular', bold: false, italic: false }]]),
      objs: { get: (id, resolve) => resolve({ data, width, height, kind: 1 }) },
      getOperatorList: async () => ({ fnArray: [10, 12, 85, 11, 37, 38, 44],
        argsArray: [[], [600, 0, 0, 600, 0, 0], ['scan'], [], ['bold', 24], [3], []] }),
      getTextContent: async () => ({ items }) };
    let scanReads = 0;
    page.objs.get = () => { scanReads++; throw new Error('Review must not read scan pixels'); };
    const pdf = { numPages: 1, getPage: async () => page };
    const baseFonts = await new api.PdfLocator().readPageFonts(page, items);
    assert.equal(new api.PdfLocator().textItemFont(baseFonts, items[2]).bold, null, 'PDF loading alone never detects scan bold');
    const locator = new api.PdfLocator({}, { isCurrent: () => true, waitForIdle: async () => {} });
    const readPageFonts = locator.readPageFonts.bind(locator);
    const index = await locator.indexFonts(pdf), fonts = await readPageFonts(page, items);
    assert.equal(await readPageFonts(page, structuredClone(items)), fonts, 'provider shares cached PDF metadata');
    assert.equal(new api.PdfLocator().textItemFont(baseFonts, items[2]).bold, null, 'review retains unknown bold metadata');
    assert.equal(fonts.get('bold').bold, null, 'character-weighted dominant declaration is not trusted');
    assert.equal(index.pages[0].parts[0].font.bold, null, 'baseline text is not guessed regular');
    assert.equal(index.pages[0].parts[11].font.bold, false, 'minority regular metadata survives');
    const spans = items.map(item => ({ textContent: item.str, ownerDocument: { defaultView: {
      getComputedStyle: () => ({ fontFamily: 'Same', fontStyle: 'normal', fontWeight: '400' })
    } } }));
    const view = { pdfPage: page, _textHighlighter: { textDivs: spans } };
    await new Promise(resolve => locator.layerFonts(view, {}, resolve));
    const fontAt = locator.layerFonts(view, {}, () => {});
    assert.deepEqual(Array.from(fontAt.spans), spans, 'selection reuses the font lookup span list');
    assert.equal(fontAt(spans[2]).bold, null, 'selection uses PDF metadata without scan estimates');
    assert.equal(new api.PdfLocator().textItemFont(fonts, structuredClone(items[2])).bold, null);
    assert.equal(index.pages[0].parts[2].font.bold, null);
    assert.equal(scanReads, 0, 'review indexing and selection never access scan image data');
  }
});

test('Tesseract placeholder fonts remain unknown and cannot produce surplus HTML style differences', async () => {
  const api = engine();
  for (const name of ['GlyphLessFont', 'ABCDEF+GlyphLessFont']) {
    const style = new api.PdfLocator().fontStyle({ name, bold: false, italic: false }, '', { fontWeight: '700', fontStyle: 'italic' });
    assert.equal(style.bold, null);
    assert.equal(style.italic, null);
    assert.match(style.reason, /占位字体/);
    const locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
    const html = '<p><b><i>Word</i></b></p>';
    const index = locator.sourceIndex(html);
    const target = new pdfApi.PdfSourceIndex(new pdfApi.PdfLocator(), { raw: index.raw, parts: [{ start: 0, end: index.raw.length, font: style }] });
    const connection = index.rememberConnection(0, index.raw.length, target, { start: 0, end: target.raw.length });
    assert.equal(index.formatDifferences([], ['italic', 'bold'], true, [[connection, target]]).length, 0);
  }
});

test('locator returns page targets and rendered/source ranges without the highlight script', async () => {
  const api = engine();
  const texts = ['First page heading. Repeated words end here.', 'Second page heading. Repeated words end here.'];
  let reads = 0, indexed = 0;
  const pdf = { numPages: 2, async getPage(number) {
    reads++;
    return { async getTextContent() { return { items: [{ str: texts[number - 1],
      transform: [1, 0, 0, 1, 0, 500], width: 800, height: 24 }] }; } };
  } };
  const locator = new api.PdfLocator({}, {
    document: { createElement: () => ({}) }, isCurrent: current => current === pdf,
    waitForIdle: async () => {}, onIndexed: () => indexed++
  });
  const source = locator.sourceIndex('<p>' + texts.join('</p><p>') + '</p>');
  const start = source.raw.lastIndexOf('Repeated'), end = start + 'Repeated words'.length;
  const entry = { index: source, start, end, text: source.raw.slice(start, end),
    before: 'Second page heading. ', after: ' end here.' };
  const [location] = await locator.findLocations(pdf, [entry]);
  assert.equal(location.targets.length, 1);
  assert.equal(location.targets[0].pageNumber, 2);
  const page = locator.sourceIndex(texts[1]);
  const { hits, focusHit } = locator.locateLayer(page, [], location.targets);
  assert.equal(hits.length, 1);
  assert.equal(page.raw.slice(focusHit.start, focusHit.end), entry.text);
  const { hit, difference } = locator.locateSource(source, [{ index: page, start: focusHit.start, end: focusHit.end }]);
  assert.equal(hit.start, start, 'reverse search respects the second page scope');
  assert.equal(hit.end, end);
  assert.equal(difference, null);
  assert.ok(Array.isArray(locator.findLocations(pdf, [entry])), 'prepared locations are synchronous');
  assert.equal(reads, 2, 'the PDF index is reused');
  assert.equal(indexed, 1);
});

test('ME32-007 reverse selections reuse OCR alignment around Gewißheit', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/pdf-selection-me32.json', import.meta.url), 'utf8'));
  const api = engine();
  const pdf = { numPages: 1, async getPage() {
    return { getTextContent: async () => ({ items: fixture.pages[0].items }) };
  } };
  const locator = new api.PdfLocator({}, { document: { createElement: () => ({}) },
    isCurrent: () => true, waitForIdle: async () => {} });
  const source = locator.sourceIndex(fixture.html), full = await locator.indexDocument(pdf);
  const page = locator.sourceIndex(full.raw.trim());
  source?.diff([page], pdf);
  for (const [word, expected] of [['hatte', 'hatte'], ['ihn', 'ihn'], ['GewiBheit', 'Gewißheit'], ['abzunehmen', 'abzunehmen']]) {
    const start = page.raw.indexOf(word, page.raw.indexOf('GewiBheit'));
    assert.ok(start >= 0);
    const { hit, difference } = locator.locateSource(source, [{ index: page, start, end: start + word.length }]);
    assert.ok(hit, `reverse selection of ${word} must survive neighbouring OCR errors`);
    assert.equal(source.raw.slice(hit.start, hit.end), expected);
    assert.equal(!!difference, word === 'GewiBheit');
    const forward = source.connectedRange(page, hit.start, hit.end);
    assert.equal(forward.start, start);
    assert.equal(forward.end, start + word.length);
  }
});

test('background document mapping retains page font highlights alongside text differences', async () => {
  const api = engine();
  const text = 'Und endlich kommt er doch. Wie Kinder unter dem großen Himmelssaal.';
  const later = 'Another independent passage follows on the next page with enough context.';
  const pdf = { numPages: 2, getPage: async number => ({ getTextContent: async () => ({ items: [{
    str: number === 1 ? text : later, transform: [1, 0, 0, 1, 0, 100], height: 12, width: 400
  }] }) }) };
  const locator = new api.PdfLocator({}, { document: { createElement: () => ({}) },
    isCurrent: () => true, waitForIdle: async () => {} });
  const index = locator.sourceIndex('<p>' + text.replace('Kinder', '<i>Kinder</i>').replace('endlich', '<b>endlich</b>').replace('unter', 'untex')
    + '</p><p>' + later + '</p>');
  const page = locator.sourceIndex(text);
  page.parts = [{ start: 0, end: page.raw.length, font: { italic: false, bold: false } }];
  index.rememberConnection(0, text.length, page, { start: 0, end: page.raw.length });
  const model = { getPositionAt: at => ({ lineNumber: 1, column: at + 1 }) };
  const marks = targets => index.sourceDecorations(index.reviewCandidates(null, true, false, true, [], targets.flatMap(target =>
    (index.connections.get(target) || []).map(connection => [connection, target]))), true, true, undefined, model);
  assert.equal(marks([page]).filter(mark => mark.options.description === 'PDF font difference').length, 2);
  const full = await locator.indexDocument(pdf);
  for (let refresh = 0; refresh < 2; refresh++) {
    index?.diff([page, full], pdf);
    const refreshed = marks([page, full]);
    assert.ok(refreshed.some(mark => mark.options.description === 'PDF OCR text difference'));
    assert.equal(refreshed.filter(mark => mark.options.description === 'PDF font difference').length, 2,
      'the text-only document mapping must not discard the page font mapping');
  }
});

test('locator cancels obsolete extraction and keeps document caches per reader', async () => {
  const api = engine();
  let current = true, reads = 0;
  const pdf = { numPages: 1, async getPage() {
    reads++;
    return { async getTextContent() { return { items: [] }; } };
  } };
  const locator = new api.PdfLocator({}, {
    isCurrent: () => current, waitForIdle: async () => { current = false; }
  });
  assert.equal(await locator.indexDocument(pdf), null);
  assert.equal(reads, 0, 'a replaced PDF is not extracted after the idle wait');
  assert.equal(locator.getDocumentIndex(pdf), undefined);
  current = true;
  const other = new api.PdfLocator({}, { isCurrent: () => current, waitForIdle: async () => {} });
  const full = await other.indexDocument(pdf);
  assert.ok(full);
  assert.equal(full, other.getDocumentIndex(pdf), 'document extraction returns the published class cache');
  assert.equal(await other.indexDocument(pdf), full, 'cache hits return the same document index');
  assert.equal(reads, 1);
  assert.equal(locator.getDocumentIndex(pdf), undefined, 'another reader cannot populate this cache');
});

test('source/PDF pairs reuse one snapshot and rebuild all mappings after edits', () => {
  const api = engine();
  const firstPdf = {}, secondPdf = {};
  let pdf = firstPdf, source = '<p>First independent passage with enough unchanged words for mapping.</p>', version = 1;
  const locator = new api.PdfLocator({}, { document: { createElement: () => ({}) }, getPdf: () => pdf });
  const model = { getValue: () => source, getVersionId: () => version };
  const target = locator.sourceIndex('First independent passage with enough unchanged words for mapping.');
  const before = locator.editorSourceIndex(model);
  assert.ok(before instanceof api.PdfSourceIndex);
  assert.equal(before.source, source);
  before?.diff([target], pdf);
  assert.ok(before.connections.get(target).length);
  assert.equal(locator.editorSourceIndex(model), before);
  pdf = secondPdf;
  assert.notEqual(locator.editorSourceIndex(model), before, 'PDF switches have independent owners');
  pdf = firstPdf;
  assert.equal(locator.editorSourceIndex(model), before);
  source = source.replace('<p>', '<p><b>').replace('</p>', '</b></p>'); version++;
  const after = locator.editorSourceIndex(model);
  assert.notEqual(after, before);
  assert.equal(after.connections.get(target), undefined, 'markup edits invalidate mappings too');
  after?.diff([target], pdf);
  assert.ok(after.connections.get(target).length);
  assert.equal(after.formats[0].bold, true);
  assert.equal(locator.editorSourceIndex(model), after, 'all consumers share the rebuilt snapshot');
});

test('MEW_BRIEF/23/ME23-316 prepares reusable mappings across five actual OCR pages', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/pdf-selection-me23.json', import.meta.url), 'utf8'));
  const api = engine();
  const pdf = { numPages: fixture.pages.length, async getPage(n) {
    return { getTextContent: async () => ({ items: fixture.pages[n - 1].items }) };
  } };
  const locator = new api.PdfLocator({}, { document: { createElement: () => ({}) },
    isCurrent: () => true, waitForIdle: async () => {} });
  const source = locator.sourceIndex(fixture.html), full = await locator.indexDocument(pdf);
  for (const page of full.pages) for (const part of page.parts)
    assert.equal(full.raw.slice(part.start, part.end), part.item.str, 'page-local construction keeps global item offsets');
  source?.diff([], pdf);
  const connections = source.connections.get(full);
  assert.ok(connections.length >= 8, 'footnote ordering must not discard independently validated passages');
  source?.diff([full], pdf);
  assert.deepEqual(source.connections.get(full), connections, 'review initialization must reuse inverse mappings without scanning the whole volume again');
  const touchedPages = new Set();
  let changed = 0, probes = 0;
  for (const item of connections) {
    const ranges = source.connectionDiff(full, item).ranges;
    for (const [position, [a, b, , , span]] of ranges.entries()) {
      if (span.html.length && span.pdf.length) {
        const start = item.start + (span.changed ? a : a + Math.floor(span.html.length / 2));
        const end = span.changed ? item.start + b : start + 1;
        const hit = source.connectedRange(full, start, end, false, item);
        assert.ok(hit);
        const before = start === item.start + a && ranges[position - 1]?.[4], after = end === item.start + b && ranges[position + 1]?.[4];
        const missing = part => part && !part.html && api.significantText(part.pdf) ? part.pdf : '';
        assert.equal(full.raw.slice(hit.start, hit.end),
          missing(before) + (span.changed ? span.pdf : source.raw.slice(start, end)) + missing(after));
        const reverse = source.connectedRange(full, hit.start, hit.end, true, item);
        assert.ok(reverse.start <= start && reverse.end >= end, 'reverse selections include touching HTML-only text');
        const roundTrip = source.connectedRange(full, reverse.start, reverse.end, false, item);
        assert.equal(roundTrip.start, hit.start); assert.equal(roundTrip.end, hit.end);
        for (const page of full.pages) if (hit.start < page.end && hit.end > page.start) touchedPages.add(fixture.pages[page.number - 1].number);
        changed += Number(span.changed); probes++;
      }
    }
  }
  assert.equal(touchedPages.size, 5); assert.ok(changed > 0); assert.ok(probes > 20);
});

test('long multi-page passages retain OCR mappings beyond the whole-range edit limit', () => {
  const api = engine(), locator = new api.PdfLocator();
  let seed = 29;
  const raw = Array.from({ length: 20000 }, () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return String.fromCharCode(97 + seed % 26);
  }).join('');
  const positions = Array.from({ length: 300 }, (_, i) => i * 64 + 48);
  const changed = [...raw]; for (const at of positions) changed[at] = '7';
  const index = raw => (new pdfApi.PdfSourceIndex(new pdfApi.PdfLocator(), { raw, normalized: api.normalized(raw), pageScopes: new WeakMap(), connections: new WeakMap() }));
  const source = index(raw), target = index(changed.join(''));
  source.sourcePageScope(target, true);
  assert.ok(source.connections.get(target).length > 1, 'bounded groups survive more than 128 total OCR edits');
  for (const at of positions) {
    const hit = source.connectedRange(target, at, at + 1);
    assert.ok(hit, `missing mapping at ${at}`);
    assert.equal(target.raw.slice(hit.start, hit.end), '7');
    const reverse = source.connectedRange(target, hit.start, hit.end, true);
    assert.equal(reverse.start, at); assert.equal(reverse.end, at + 1);
  }
});

test('local highlight hunks separate OCR boundary spaces', () => {
  const api = engine();
  const locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
  const source = 'aft der\n' + 'x'.repeat(100), target = new pdfApi.PdfSourceIndex(new pdfApi.PdfLocator(), { raw: 'äft  der\n' + 'y'.repeat(100) });
  const index = locator.sourceIndex(source);
  const connection = { start: 0, end: source.length, targetStart: 0, targetEnd: target.raw.length };
  index.connections.set(target, [connection]);
  const parts = index.connectionDiff(target, connection).parts;
  assert.deepEqual(Array.from(parts.slice(0, 4), part => [part.html, part.pdf, part.changed]),
    [['a', 'ä', true], ['ft ', 'ft ', false], ['', ' ', true], ['der\n', 'der\n', false]]);
  const items = index.reviewCandidates(null, false, true, true, [target]);
  assert.deepEqual({ ...items[0].comparison }, { html: 'a', pdf: 'ä' });
  assert.equal(api.applyTextEdits(source, items[0].options[0].edits), source.replace('aft', 'äft'));
  const hit = index.connectedRange(target, 0, 3, false, connection, true);
  assert.equal(target.raw.slice(hit.start, hit.end), 'äft', 'click excludes the following space insertion');
});

test('an over-budget page comparison does not highlight or replace the whole passage', () => {
  const api = engine();
  const locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
  const lines = Array.from({ length: 150 }, (_, i) => `Passage ${i} contains matching words.`);
  const index = locator.sourceIndex(lines.join(' '));
  const target = new pdfApi.PdfSourceIndex(new pdfApi.PdfLocator(), { raw: lines.join('\n').replace('Passage 5', 'Passage X') });
  const broad = index.rememberConnection(0, index.raw.length, target, { start: 0, end: target.raw.length });
  assert.ok(broad, 'normalized text still confirms the page mapping');
  const end = index.raw.indexOf('Passage 10'), targetEnd = target.raw.indexOf('Passage 10');
  const local = index.rememberConnection(0, end, target, { start: 0, end: targetEnd });
  assert.ok(api.differences(index, target, local).text.length, 'confirmed local changes remain available');
  assert.equal(api.differences(index, target, broad).text.length, 0, 'failed traceback supplies no discrepancy spans');
  assert.equal(index.connectedRange(target, 0, index.raw.length, false, broad, true), null,
    'failed traceback cannot map a discrepancy to the entire PDF page');
  const items = index.reviewCandidates(null, false, true, true, [target]);
  assert.deepEqual(Array.from(items, item => [item.comparison.html, item.comparison.pdf]), [['5', 'X']]);
});

test('ME04-608 wrapped prose stays aligned across blank-line anchors', () => {
  const api = engine();
  const locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
  const paragraph = "<p><i>Born</i> stattet Bericht ab über die Versammlung im Café l'Europe; ebenso <i>Sterbitzki</i>. Mit großer Mehrzahl beschlossen, nicht in dieses Café zu gehn, wo Decker und Venedey eine Versammlung halten.</p>";
  const pdf = "Born stattet Bericht ab über die Versammlung im Cafe l'Europe; ebenso\n\nSterhitzki' Mit großer Mehrzahl beschlossen, nicht in dieses Cafe zu gehn,\nwo Decker und Venedey eine Versammlung halten.\nEngler, Buchfink und Vogler (Weitlingianer) aufgenommen einstimmig.\n";
  for (const newline of ['\r\n', '\n']) {
    const html = paragraph + newline + '<p>Engler, Buchfink und Vogler (Weitlingianer) aufgenommen einstimmig.</p>';
    const index = locator.editorSourceIndex({ getValue: () => html, getVersionId: () => 1 });
    const target = new pdfApi.PdfSourceIndex(new pdfApi.PdfLocator(), { raw: pdf });
    index.rememberConnection(0, index.raw.length, target, { start: 0, end: pdf.length });
    const items = index.reviewCandidates(null, false, true, true, [target]);
    assert.deepEqual(Array.from(items, item => [item.comparison.html, item.comparison.pdf]),
      [['é', 'e'], ['b', 'h'], ['.', "'"], ['é', 'e']]);
    assert.equal(api.applyTextEdits(html, items.flatMap(item => item.options[0].edits)),
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

test('local wavefront preserves bounded distances and traceback at short sequence edges', () => {
  const window = {};
  vm.runInNewContext(engineSource + '\nwindow.localDiff = localTextDiff;', { window });
  const values = ['', 'a', 'b', '𠀀', 'aa', 'ab', 'ba', 'a𠀀', '𠀀b'];
  for (const left of values) for (const right of values) for (const substitutions of [false, true]) {
    const a = [...left], b = [...right];
    let row = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 0; i < a.length; i++) {
      const next = [i + 1];
      for (let j = 0; j < b.length; j++) next.push(Math.min(next[j] + 1, row[j + 1] + 1,
        row[j] + (a[i] === b[j] ? 0 : substitutions ? 1 : 2)));
      row = next;
    }
    for (const limit of [0, 1, 2, Infinity]) for (const details of [false, true]) {
      const diff = window.localDiff(a, b, details, limit, undefined, substitutions);
      assert.equal(diff.distance, Math.min(row[b.length], Math.min(limit, Math.max(a.length, b.length)) + 1));
      if (!details) continue;
      assert.equal(diff.parts.map(part => part.html).join(''), left);
      assert.equal(diff.parts.map(part => part.pdf).join(''), right);
      assert.ok(diff.parts.every(part => part.changed || part.html === part.pdf));
    }
  }
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
  const normalized = api.normalized;
  const index = raw => (new pdfApi.PdfSourceIndex(new pdfApi.PdfLocator(), { raw, normalized: normalized(raw), connections: new WeakMap() }));
  const left = index('Before working together after.'), right = index('Before working nicely together after.');
  left.rememberConnection(0, left.raw.length, right, { start: 0, end: right.raw.length });
  const word = left.raw.indexOf('together'), mapped = left.connectedRange(right, word, word + 8);
  assert.equal(right.raw.slice(mapped.start, mapped.end), 'nicely together');
  const reverse = left.connectedRange(right, mapped.start, mapped.end, true);
  assert.equal(left.raw.slice(reverse.start, reverse.end), 'together');
});

test('native decorations split changes around tags, map entities, and mark missing HTML text', () => {
  const api = engine(), provider = reviewProvider(api);
  assert.equal(api.textDiff('a', 'b', true).parts[0].changed, true);
  assert.deepEqual([...new api.PdfSourceIndex(new api.PdfLocator(), { raw: '' }).sourceDecorations([], true, true, undefined, {})], []);
  const markup = '<p>a<b>X</b>&amp;𠀀Z</p>', raw = 'aX&𠀀Z';
  const starts = [3, 7, 12, 17, 18, 19], ends = [4, 8, 17, 18, 19, 20];
  const index = new pdfApi.PdfSourceIndex(new pdfApi.PdfLocator(), { raw, starts, ends }), target = new pdfApi.PdfSourceIndex(new pdfApi.PdfLocator(), { raw: 'aY!𠀀Z+' });
  const connection = { start: 0, end: raw.length, targetStart: 0, targetEnd: target.raw.length };
  const model = { getPositionAt: offset => ({ lineNumber: 1, column: offset + 1 }) };
  const hover = item => provider.locator.sourceHover(item, model);
  const decorations = index.sourceDecorations(index.reviewCandidates(null, true, false, true, [target], [[connection, target]]), true, true, hover, model);
  const ranges = decorations.map(({ range }) => markup.slice(range.startColumn - 1, range.endColumn - 1));
  assert.deepEqual([...ranges], ['X', '&amp;', '']);
  assert.ok(decorations.every(item => !('linesDecorationsClassName' in item.options) && !('linesDecorationsTooltip' in item.options)),
    'source decorations omit unused gutter marks at creation');
  assert.equal(decorations.at(-1).options.before?.inlineClassName, 'mew-ocr-diff-insert');
  assert.equal(decorations.at(-1).range.startColumn, 21, 'trailing insertion is anchored before the closing tag');
  assert.match(decorations.at(-1).options.hoverMessage.value, /PDF:.*\+/);
  const saved = connection.editorDiff;
  assert.equal(index.connectionDiff(target, connection), saved, 'direct index comparisons reuse the editor diff');
  index.sourceDecorations(index.reviewCandidates(null, true, false, true, [], [[connection, target]]), true, true, undefined, model);
  assert.equal(connection.editorDiff, saved);
  assert.equal(api.textDiff('a', 'b', true).parts[0].changed, true);
  assert.deepEqual([...index.sourceDecorations(index.reviewCandidates(null, true, false, true, [target], [[{ ...connection, editorDiff: null }, target]]), true, true, hover, model)], [...decorations]);
  assert.deepEqual([...index.sourceDecorations(index.reviewCandidates(null, true, false, true, [target], [[connection, target]]), true, true, hover, model)], [...decorations]);
});

test('ME04-004 quote markers exclude matching paragraphs, PDF wrapping and the footnote', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/pdf-selection-me04.json', import.meta.url), 'utf8'));
  const api = engine();
  const target = new pdfApi.PdfSourceIndex(new pdfApi.PdfLocator(), { raw: fixture.layerRaw, parts: [] }), pdf = {};
  const locator = new api.PdfLocator({}, { document: { createElement: () => ({}) },
    getVisiblePages: () => [{ number: 20, index: target }] });
  Object.assign(target, { normalized: api.normalized(target.raw) });
  const model = { getValue: () => fixture.html, getVersionId: () => 1,
    getPositionAt: offset => ({ lineNumber: 1, column: offset + 1 }) };
  const index = locator.editorSourceIndex(model);
  index.sourcePageScope(target, true);
  const connections = (index.connections.get(target) || []).map(connection => [connection, target]);
  const marks = index.sourceDecorations(index.reviewCandidates(null, true, false, true, [], connections), true, true, undefined, model);
  const quote = fixture.html.indexOf('entwickeln.') + 'entwickeln.'.length;
  const mark = marks.find(({ range }) => range.startColumn - 1 <= quote && range.endColumn - 1 > quote);
  assert.equal(mark, undefined, 'normalized quote shapes are not reported as text differences');
  const start = index.raw.indexOf('entwickeln.') + 'entwickeln.'.length;
  const [location] = locator.findLocations(pdf, [{ index, marked: true, start, end: start + 1,
    text: '“', before: index.raw.slice(start - 160, start), after: index.raw.slice(start + 1, start + 161) }]);
  assert.equal(location.targets.length, 1);
  assert.equal(location.targets[0].difference.html, '“');
  assert.equal(location.targets[0].difference.pdf, '"');
  const { focusHit } = locator.locateLayer(target, [], location.targets);
  assert.equal(target.raw.slice(focusHit.start, focusHit.end), '"');
  for (const { range } of marks) {
    const text = fixture.html.slice(range.startColumn - 1, range.endColumn - 1);
    assert.doesNotMatch(text, /Kinder|Herzen|Gemeinschaft|entwickeln|Haschen|>1</,
      'matching words and the footnote must not receive difference markers');
  }
});

test('ME04-117 case-only differences survive selection mapping in both directions', () => {
  const html = '<p>Ein sozialer Vorteil, gleich 400, stellt für das Individuum, wenn die Gesellschaft nur aus einer Million Menschen besteht, <sup>4</sup>/<sub>10000</sub> dar.</p>';
  const api = engine();
  const locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
  const index = locator.sourceIndex(html);
  const start = index.raw.indexOf('Gesellschaft nur') + 'Gesellsc'.length;
  const target = locator.sourceIndex(index.raw.slice(0, start) + 'H' + index.raw.slice(start + 1));
  index.rememberConnection(0, index.raw.length, target, { start: 0, end: target.raw.length });
  for (const reverse of [false, true]) {
    const hit = index.connectedRange(target, start, start + 1, reverse);
    assert.equal(hit.start, start);
    assert.equal(hit.end, start + 1);
    assert.equal(hit.approximate, true, 'case folding for locating must not erase a text difference');
  }
  const { difference } = locator.locateSource(index, [{ index: target, start, end: start + 1 }]);
  assert.equal(difference.html, 'h');
  assert.equal(difference.pdf, 'H');
});

test('ME07-073 and ME07-074 alignment excludes neighboring pages and preserves the final punctuation', async () => {
  const fixtures = JSON.parse(await readFile(new URL('./fixtures/pdf-selection-me07-073-074.json', import.meta.url), 'utf8'));
  for (const fixture of fixtures) for (const lf of [false, true]) {
    const api = engine();
    const locator = new api.PdfLocator({}, { document: { createElement: () => ({}) },
      isCurrent: () => true, waitForIdle: async () => {} });
    const pdf = { numPages: fixture.pages.length, getPage: async n => ({
      getTextContent: async () => ({ items: [{ str: fixture.pages[n - 1],
        transform: [1, 0, 0, 1, 0, 100], width: 100, height: 10 }] })
    }) };
    const html = lf ? fixture.html.replace(/\r\n/g, '\n') : fixture.html;
    const index = locator.sourceIndex(html), pages = fixture.pages.map(raw => locator.sourceIndex(raw));
    index?.diff(pages, pdf);
    const before = index.reviewCandidates(null, false, true, true, pages).map(item => item.comparison);
    const full = await locator.indexDocument(pdf);
    index?.diff(pages, pdf);
    const after = index.reviewCandidates(null, false, true, true, [...pages, full]).map(item => item.comparison);
    assert.deepEqual(after, before, 'background alignment must not add neighboring text or delete final punctuation');
    const page = full.pages[fixture.number - 72];
    for (const connection of index.connections.get(full) || []) {
      assert.equal(full.raw.slice(connection.targetStart, Math.max(connection.targetStart, page.start)).trim(), '',
        'previous page content stays outside the mapping');
      assert.equal(full.raw.slice(Math.min(connection.targetEnd, page.end), connection.targetEnd).trim(), '',
        'next page content stays outside the mapping');
    }
    const word = fixture.number === 73 ? 'Taten!' : 'Clichy!';
    const start = index.raw.indexOf(word);
    const hit = index.connectedRange(full, start, start + word.length, false, undefined, true);
    assert.ok(hit);
    assert.equal(full.raw.slice(hit.start, hit.end), word, 'final footnote punctuation survives alignment');
    const reverse = index.connectedRange(full, hit.start, hit.end, true);
    assert.equal(index.raw.slice(reverse.start, reverse.end), word, 'reverse selection uses the same boundary');
  }
});

test('ME07-066 missing page-end text maps before whole-document indexing', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/pdf-selection-me07-066.json', import.meta.url), 'utf8'));
  for (const html of [fixture.html, fixture.html.replace(/\r\n/g, '\n')]) {
    const api = engine();
    const locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
    const index = locator.sourceIndex(html), target = locator.sourceIndex(fixture.layerRaw);
    const pdf = {};
    index?.diff([target], pdf);
    assert.equal(locator.getDocumentIndex(pdf), undefined, 'only the visible page is available');
    const item = index.reviewCandidates(null, false, true, true, [target]).find(item => item.comparison.pdf.includes('Delegierten'));
    assert.ok(item, 'the missing word is highlighted without waiting for the full PDF');
    assert.equal(item.sourceStart, item.sourceEnd, 'HTML has an insertion point, not selectable text');
    assert.equal(item.comparison.html, '');
    const hit = index.connectedRange(target, item.sourceStart, item.sourceEnd, false, undefined, true);
    assert.ok(hit, 'the same page mapping supplies the popup anchor');
    assert.equal(target.raw.slice(hit.start, hit.end).trim(), 'Delegierten');
    const edit = item.options[0].edits[0];
    assert.equal(edit.start, edit.end);
    assert.match(api.applyTextEdits(html, [edit]), /Montagne und Delegierten\s+der geheimen/);
  }
});

test('ME04-117 adjacent-page quotations cannot override a complete page mapping', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/pdf-selection-me04-117.json', import.meta.url), 'utf8'));
  const api = engine();
  const locator = new api.PdfLocator({}, { document: { createElement: () => ({}) }, getTargets: () => pages });
  const index = locator.sourceIndex(fixture.html);
  const pages = fixture.pages.map(page => locator.sourceIndex(page.raw));
  index?.diff(pages, {});
  // Font metadata can rebuild just the adjacent layer after the first preparation.
  pages[1] = locator.sourceIndex(fixture.pages[1].raw);
  index?.diff([pages[1]], {});
  const connections = pages.flatMap(page => (index.connections.get(page) || []).map(connection => [connection, page]));
  const model = { getPositionAt: offset => ({ lineNumber: 1, column: offset + 1 }) };
  const marks = index.sourceDecorations(index.reviewCandidates(null, true, false, true, [], connections), true, true, undefined, model);
  const at = fixture.html.indexOf('Gesellschaft nur') + 8;
  assert.ok(!marks.some(({ range }) => range.startColumn - 1 <= at && range.endColumn - 1 > at),
    'the uppercase H in the next page quotation is not a difference in this page');
  assert.ok(index.reviewCandidates(null, false, true, true, pages).some(item => /ooo/.test(item.comparison?.pdf)), 'actual OCR differences remain reviewable');
});

test('ME17-463/464 discard prepared font mappings to a shorter adjacent-page quotation', () => {
  const quote = 'Ein Delegierter oder mehrere Delegierte werden in den Generalrat entsandt';
  for (const italic of [false, true]) {
    const api = engine(), locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
    const index = locator.sourceIndex(`<p>Der Generalrat erklärte seinen Beschluß zu den Statuten.</p><p>${italic ? '<i>' + quote + '</i>' : quote}</p><p>Die Sektion antwortet auf diesen Beschluß.</p>`);
    const page = (raw, italic) => new api.PdfSourceIndex(locator, {
      raw, parts: [{ start: 0, end: raw.length, font: { italic, bold: false } }]
    });
    const adjacent = page(quote, !italic), own = page(index.raw, italic), pdf = {};
    own.parts = index.formats.map((font, start) => ({ start, end: start + 1,
      font: { italic: font.italic, bold: font.bold } }));
    index?.diff([adjacent], pdf);
    assert.ok(index.formatDifferences([], ['italic', 'bold'], true, index.connectionPairs([adjacent], true)).length,
      'the repeated quotation initially maps to the adjacent page with different formatting');
    index.rememberConnection(0, index.raw.length, own, { start: 0, end: own.raw.length });
    index.pageScopes.set(own, { prepared: true, connections: index.connections.get(own) });
    index?.diff([adjacent, own], pdf);
    assert.deepEqual(index.pageScopes.get(adjacent).connections, index.connections.get(adjacent),
      'superseded quotations must also leave the prepared highlight snapshot');
    assert.equal(index.formatDifferences([], ['italic', 'bold'], true, index.connectionPairs([adjacent, own], true)).length, 0);
  }
});

test('ME04-037 keeps the matching heading out of deletion/reinsertion markers', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/pdf-selection-me04-037.json', import.meta.url), 'utf8'));
  const api = engine();
  const locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
  for (const html of [fixture.html, fixture.html.replace(/\r\n/g, '\n')]) {
    const index = locator.sourceIndex(html), target = locator.sourceIndex(fixture.layerRaw);
    index.sourcePageScope(target, true);
    const connections = (index.connections.get(target) || []).map(connection => [connection, target]);
    assert.ok(connections.length);
    const model = { getPositionAt: offset => ({ lineNumber: 1, column: offset + 1 }) };
    const marks = index.sourceDecorations(index.reviewCandidates(null, true, false, true, [], connections), true, true, undefined, model);
    const start = html.indexOf('[Erklärung', html.indexOf('<h1>'));
    const end = start + '[Erklärung gegen Karl Grün'.length;
    assert.ok(marks.length, 'actual OCR differences still receive markers');
    for (const { range } of marks) {
      assert.ok(range.endColumn - 1 <= start || range.startColumn - 1 >= end,
        'the matching heading must not be marked as deleted');
      assert.doesNotMatch(html.slice(range.startColumn - 1, range.endColumn - 1), /<\/?h1>/,
        'the closing heading tag must not be highlighted');
    }
    const connection = connections[0][0];
    assert.equal(connection.editorDiff.parts.map(part => part.html).join(''), index.raw.slice(connection.start, connection.end));
    assert.equal(connection.editorDiff.parts.map(part => part.pdf).join(''), target.raw.slice(connection.targetStart, connection.targetEnd));
    const at = index.raw.indexOf('Erklärung');
    const hit = index.connectedRange(target, at, at + 'Erklärung'.length, false, connection, true);
    assert.equal(target.raw.slice(hit.start, hit.end), 'Erklärung', 'click mapping shares the refined alignment');
  }
});

test('ME32-169 word-ending noise maps past an overlapping connection ending at its insertion', () => {
  const api = engine(), locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
  const index = locator.sourceIndex('<p>durch ihre Organisation einen Hinterhalt gewähren.</p><p>Dein</p>');
  const target = new api.PdfSourceIndex(locator, { raw: 'durch ihre Organisation einen Hinterhalt gewähren.,  , <\nDein', parts: [] });
  const at = index.raw.indexOf('gewähren.') + 'gewähren.'.length, end = target.raw.indexOf(',  , <');
  index.rememberConnection(0, index.raw.length, target, { start: 0, end: target.raw.length });
  index.rememberConnection(0, at, target, { start: 0, end });
  const item = index.reviewCandidates(null, false, true, true, [target]).find(item => item.sourceStart === at);
  assert.ok(item && item.sourceEnd === at, 'the extra OCR noise has an HTML insertion marker');
  const hit = index.connectedRange(target, at, at, false, undefined, true);
  assert.ok(hit, 'the insertion uses the overlapping connection that contains its diff');
  assert.equal(target.raw.slice(hit.start, hit.end), ',  , <');
  assert.equal(index.connectedRange(target, at, at, false, index.connections.get(target)[0], true), null,
    'an explicitly supplied connection still limits lookup to its own diff');
});

test('ME07-261 missing prefixes use a caret before the term and retain their click mapping', () => {
  const api = engine();
  const locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
  const model = { getPositionAt: offset => ({ lineNumber: 1, column: offset + 1 }) };
  for (const gap of [' ', '\n', '\r\n ', '\t']) {
    const html = `<p>Folgerung${gap}schließt</p>`, pdf = 'Folgerung\nanschließt';
    const index = locator.sourceIndex(html), target = locator.sourceIndex(pdf);
    index.rememberConnection(0, index.raw.length, target, { start: 0, end: target.raw.length });
    const connections = index.connections.get(target).map(connection => [connection, target]);
    const [mark, ...extra] = index.sourceDecorations(index.reviewCandidates(null, true, false, true, [], connections), true, true, undefined, model);
    assert.equal(extra.length, 0);
    assert.ok(mark, 'whitespace-only HTML changes must still mark missing PDF letters');
    const [item] = index.reviewCandidates(null, false, true, true, [target]);
    assert.equal(mark.range.startColumn, html.indexOf('schließt') + 1);
    assert.equal(html.slice(mark.range.startColumn - 1, mark.range.endColumn - 1), '');
    assert.equal(mark.options.before?.inlineClassName, 'mew-ocr-diff-insert');
    assert.equal(mark.options.inlineClassName, undefined);
    const at = index.raw.indexOf('schließt');
    const hit = index.connectedRange(target, at, at, false, undefined, true);
    assert.ok(hit, 'clicking the insertion caret maps back to the missing letters');
    assert.equal(target.raw.slice(hit.start, hit.end).trim(), 'an');
    const anchor = api.lowerBound(index.ends, mark.range.startColumn);
    const end = api.lowerBound(index.starts, mark.range.endColumn - 1);
    const clicked = index.connectedRange(target, anchor, end, false, undefined, true);
    assert.equal(target.raw.slice(clicked.start, clicked.end).trim(), 'an', 'the insertion start maps to the same missing letters');
    if (gap === ' ') assert.equal(index.connectedRange(target, at, at), null,
      'ordinary caret does not select whitespace-adjacent changes');
    const patched = api.applyTextEdits(html, item.options[0].edits);
    assert.equal(patched, '<p>Folgerung\nanschließt</p>', 'replacement consumes the original whitespace exactly once');
  }
});

test('space markers cover only changed spaces while prefixes use carets without changing replacement ranges', () => {
  const api = engine(), locator = new api.PdfLocator({}, { document: { createElement: () => ({
    set innerHTML(text) { this.content = { textContent: text === '&nbsp;' ? '\u00a0' : text }; }
  }) } });
  for (const [html, pdf, space] of [
    ['So wenig', 'So’wenig', 2], ['So wenig', 'SoX wenig', null],
    ['So wenig', 'So Xwenig', null], ['So&nbsp;wenig', 'So’wenig', 2],
    ['Sowenig', 'SoXwenig', null]
  ]) {
    const markup = '<p>' + html + '</p>', index = locator.sourceIndex(markup), target = locator.sourceIndex(pdf);
    index.rememberConnection(0, index.raw.length, target, { start: 0, end: target.raw.length });
    const [mark] = index.sourceDecorations(index.reviewCandidates(null, true, false, true, [], index.connectionPairs([target])), true, true, undefined, { getPositionAt: offset => ({ lineNumber: 1, column: offset + 1 }) });
    const insertion = pdf === 'SoX wenig' ? markup.indexOf(' wenig') : markup.indexOf('wenig');
    assert.equal(mark.range.startColumn - 1, space === null ? insertion : index.starts[space]);
    assert.equal(mark.range.endColumn - 1, space === null ? insertion : index.ends[space]);
    assert.equal(mark.options.before?.inlineClassName, space === null ? 'mew-ocr-diff-insert' : undefined);
    const from = { start: api.lowerBound(index.ends, mark.range.startColumn),
      end: api.lowerBound(index.starts, mark.range.endColumn - 1) };
    const hit = index.connectedRange(target, from.start, from.end, false, undefined, true);
    assert.ok(hit?.approximate, 'the highlighted space still reaches the actual difference');
    const [item] = index.reviewCandidates(null, false, true, true, [target]);
    assert.equal(api.applyTextEdits(markup, item.options[0].edits), '<p>' + pdf + '</p>');
  }
});

test('ME07-316 missing heading text marks the insertion before the closing tag and remains clickable', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/pdf-selection-me07-316.json', import.meta.url), 'utf8'));
  const api = engine();
  const locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
  const index = locator.sourceIndex(fixture.html), target = locator.sourceIndex(fixture.layerRaw);
  index?.diff([target], {});
  const model = { getPositionAt: offset => ({ lineNumber: 1, column: offset + 1 }) };
  const marks = index.sourceDecorations(index.reviewCandidates(null, true, false, true, [], index.connections.get(target).map(connection => [connection, target])), true, true, undefined, model);
  const marker = marks.find(mark => mark.options.before?.inlineClassName === 'mew-ocr-diff-insert');
  const offset = marker.range.startColumn - 1;
  assert.equal(offset, fixture.html.indexOf('</h1>'));
  const at = api.lowerBound(index.ends, offset + 1);
  const hit = index.connectedRange(target, at, at, false, undefined, true);
  assert.equal(target.raw.slice(hit.start, hit.end), '12763');
  const item = index.reviewCandidates(null, false, true, true, [target]).find(item => item.comparison.pdf === '12763');
  assert.equal(item.options[0].edits[0].start, offset);
  assert.equal(api.applyTextEdits(fixture.html, item.options[0].edits), fixture.html.replace('</h1>', '12763</h1>'));
});

test('source decorations ignore whitespace and hyphens while preserving subsequent character offsets', () => {
  const api = engine();
  const model = { getPositionAt: offset => ({ lineNumber: 1, column: offset + 1 }) };
  const decorate = (raw, pdf) => {
    const index = new api.PdfSourceIndex(new api.PdfLocator(), { raw, model,
      starts: Array.from({ length: raw.length }, (_, i) => i),
      ends: Array.from({ length: raw.length }, (_, i) => i + 1) });
    return index.sourceDecorations(index.reviewCandidates(null, true, false, true, [],
      [[{ start: 0, end: raw.length, targetStart: 0, targetEnd: pdf.length }, { raw: pdf }]]));
  };
  for (const [html, pdf] of [
    ['word word', 'wordword'], ['wordword', 'word word'],
    ['word  word', 'word word'], ['word\tword', 'word word'],
    ['word\nword', 'word word'], ['word\u00a0word', 'word word'],
    [' word ', 'word'], ['word-word', 'wordword'], ['wordword', 'word-word'],
    ['word\u2010word', 'word-word'], ['word\u2011word', 'wordword'],
    ['word\u00adword', 'wordword'], ['word-\nword', 'wordword']
  ]) assert.equal(decorate(html, pdf).length, 0, JSON.stringify([html, pdf]));
  const html = 'word  word X end', pdf = 'word word Y end';
  const decorations = decorate(html, pdf);
  assert.deepEqual([...decorations.map(({ range }) => html.slice(range.startColumn - 1, range.endColumn - 1))], ['X']);
  const withHyphen = decorate('word- word X end', 'word word Y end');
  assert.deepEqual([...withHyphen.map(({ range }) => range.startColumn)], [12]);
  for (const [html, pdf, column] of [
    ['wordword', 'word word+', 9], ['wordword', 'word+word', 5],
    ['schöpliche', 'schöpfliche', 6], ['work', 'works', 5],
    ['word', 'sword', 1], ['', 'added', 1], ['a𠀀b', 'a𠀀𠀁b', 4]
  ]) {
    const [mark] = decorate(html, pdf);
    assert.equal(decorate(html, pdf).length, 1, JSON.stringify([html, pdf]));
    assert.equal(mark.range.startColumn, column);
    assert.equal(mark.range.endColumn, column);
    assert.equal(mark.options.before?.inlineClassName, 'mew-ocr-diff-insert');
    assert.equal(mark.options.inlineClassName, undefined);
  }
});

test('selection boundaries include meaningful missing text regardless of character type', () => {
  const api = engine();
  for (const [html, pdf, start, end, expected, at, missing] of [
    ['work', 'works', 0, 4, 'works', 4, 's'],
    ['word', 'sword', 0, 4, 'sword', 0, 's'],
    ['кот', 'коты', 0, 3, 'коты', 3, 'ы'],
    ['cafe', 'cafe\u0301', 0, 4, 'cafe\u0301', 4, '\u0301'],
    ['hello world', 'hello, world', 0, 5, 'hello,', 5, ','],
    ['hello world', 'hello new world', 6, 11, 'new world', 6, 'new '],
    ['中文', '中文字', 0, 2, '中文字', 2, '字'],
    ['work', 'work★', 0, 4, 'work★', 4, '★'],
    ['hello world', 'hello, world', 0, 11, 'hello, world', 5, ','],
    ['中文', '中间文', 0, 2, '中间文', 1, '间']
  ]) {
    const locator = new api.PdfLocator(), index = new api.PdfSourceIndex(locator, { raw: html });
    const target = new api.PdfSourceIndex(locator, { raw: pdf, parts: [] });
    index.rememberConnection(0, html.length, target, { start: 0, end: pdf.length });
    const hit = index.connectedRange(target, start, end);
    assert.equal(pdf.slice(hit.start, hit.end), expected, JSON.stringify([html, pdf]));
    target.rememberConnection(0, pdf.length, index, { start: 0, end: html.length });
    const reverse = target.connectedRange(index, start, end, true);
    assert.equal(pdf.slice(reverse.start, reverse.end), expected, 'reverse selections use the same boundary rule');
    const clicked = index.connectedRange(target, at, at, false, undefined, true);
    assert.equal(pdf.slice(clicked.start, clicked.end), missing, 'direct marker clicks retain every character type');
  }
});

test('source markers locate local diff changes at word boundaries, inside words and beside repeated characters', () => {
  const api = engine();
  for (const [html, pdf, at, missing] of [
    ['work', 'works', 4, 's'], ['word', 'sword', 0, 's'],
    ['Louis-Philippees den', 'Louis-Philippes\nden', 14, 's\n'],
    ['schöpliche', 'schöpfliche', 5, 'f'], ['a𠀀b', 'a𠀀𠀁b', 3, '𠀁']
  ]) {
    const target = new pdfApi.PdfSourceIndex(new pdfApi.PdfLocator(), { raw: pdf, parts: [] }), pdfDocument = {};
    const locator = new api.PdfLocator({}, { getVisiblePages: () => [{ number: 1, index: target }] });
    const index = new pdfApi.PdfSourceIndex(new pdfApi.PdfLocator(), { raw: html, starts: [...Array(html.length).keys()],
      ends: Array.from({ length: html.length }, (_, i) => i + 1),
      normalized: api.normalized(html), connections: new WeakMap(), pageScopes: new WeakMap() });
    target.normalized = api.normalized(pdf);
    index.rememberConnection(0, html.length, target, { start: 0, end: pdf.length });
    const end = html.includes('Philippees') ? at + 3 : at;
    const hit = index.connectedRange(target, at, end, false, undefined, true);
    assert.equal(pdf.slice(hit.start, hit.end), missing);
    const [location] = locator.findLocations(pdfDocument, [{ index, marked: true, start: at, end, text: html.slice(at, end), before: html.slice(0, at), after: html.slice(end) }]);
    assert.equal(location.targets[0].difference.html, html.slice(at, end));
    assert.equal(location.targets[0].difference.pdf, missing);
    const { focusHit } = locator.locateLayer(target, [], location.targets);
    assert.equal(pdf.slice(focusHit.start, focusHit.end), missing);
    assert.equal(index.connectedRange(target, 1, 1), null, 'ordinary carets do not select PDF characters');
  }
});

test('concurrent page extraction is shared across locators and failures can retry', async () => {
  const api = engine();
  let calls = 0;
  const page = { getTextContent: async () => { calls++; return { items: [] }; } };
  const pdf = { numPages: 1, getPage: async () => page };
  const environment = { isCurrent: () => true, waitForIdle: async () => {} };
  await Promise.all([new api.PdfLocator({}, environment).indexDocument(pdf),
    new api.PdfLocator({}, environment).indexDocument(pdf), new api.PdfLocator().readPageText(page)]);
  assert.equal(calls, 1);
  let attempts = 0;
  const broken = { getTextContent: async () => {
    if (++attempts === 1) throw new Error('temporary failure');
    return { items: [] };
  } };
  await assert.rejects(new api.PdfLocator().readPageText(broken), /temporary failure/);
  await new api.PdfLocator().readPageText(broken);
  assert.equal(attempts, 2);
});

test('equal text stays unchanged and batch preview preserves all untouched text', () => {
  const api = engine();
  assert.equal(api.textDiff('same 𠀀', 'same 𠀀', true).parts[0].changed, false);
  const source = 'a𠀀bcdef';
  assert.equal(api.applyTextEdits(source, [{ start: 7, end: 8, text: 'Z' },
    { start: 1, end: 3, text: '&amp;' }, { start: 4, end: 4, text: 'X' }]), 'a&amp;bXcdeZ');
  assert.throws(() => api.applyTextEdits(source, [{ start: 1, end: 4, text: '' },
    { start: 3, end: 5, text: '' }]), /重叠/);
});

test('PDF replacement batches identical patterns and retains different text or formatting targets', () => {
  for (const format of [false, true]) {
    const api = engine(), providers = new Map();
    let source = format ? '<p>Word</p><p>Word</p><p>Word</p><p>Other</p>'
      : '<p>WRONG</p><p>WRONG</p><p>WRONG</p><p>OTHER</p>', version = 1, applications = 0, undoStops = 0;
    const model = { getValue: () => source, getVersionId: () => version,
      getPositionAt: at => ({ lineNumber: 1, column: at + 1 }), getOffsetAt: position => position.column - 1 };
    const locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
    // These candidates already have confirmed mappings from scanning.
    api.PdfLocator = class { constructor() { return locator; } };
    const index = locator.editorSourceIndex(model);
    const target = new pdfApi.PdfSourceIndex(new pdfApi.PdfLocator(), { raw: format ? index.raw : index.raw.replace('WRONG', 'RIGHT𠀀').replace('WRONG', 'RIGHT𠀀')
      .replace('WRONG', 'DIFFERENT').replace('OTHER', 'RIGHT𠀀'), parts: [] });
    const starts = [...index.raw.matchAll(format ? /Word|Other/g : /WRONG|OTHER/g)].map(match => match.index);
    const items = starts.map((start, at) => {
      const end = start + (format ? at === 3 ? 5 : 4 : 5);
      const font = { italic: at === 2, bold: at !== 2 };
      if (format) target.parts.push({ start, end, font });
      return { id: String(at), sourceStart: start, sourceEnd: end,
        ...(format ? { text: index.raw.slice(start, end), font, htmlFont: index.formats[start] }
          : { comparison: { html: index.raw.slice(start, end), pdf: at === 2 ? 'DIFFERENT' : 'RIGHT𠀀' } }),
        options: [{ id: format ? 'format' : 'pdf', edits: format ? index.fontEdits(start, end, font)
          : index.textEdits(start, end, at === 2 ? 'DIFFERENT' : 'RIGHT𠀀') }] };
    });
    index.rememberConnection(0, index.raw.length, target, { start: 0, end: target.raw.length });
    const editor = { getModel: () => model, getOption: () => false, pushUndoStop() { undoStops++; },
      executeEdits(origin, edits) {
        applications++;
        for (const edit of [...edits].reverse()) source = source.slice(0, edit.range.startColumn - 1) + edit.text + source.slice(edit.range.endColumn - 1);
        version++; return true;
      } };
    let highlighted;
    reviewProvider(api, providers, { showReviewPointer(targetEditor, matches) {
      assert.equal(targetEditor, editor); highlighted = matches;
    } });
    providers.get('pdf-ocr').onSelect(items[1], { editor }, items);
    assert.deepEqual(Array.from(highlighted, item => item.id), ['0', '1'],
      'one popup highlights every matching pattern and excludes other corrections or styles');
    api.PdfSourceIndex.prototype.reviewCandidates = () => { throw new Error('incremental replacement must preserve existing candidates'); };
    const result = providers.get('pdf-ocr').apply({ editor, model, source, version, items, position: 1,
      choices: new Map(items.map(item => [item.id, item.options[0].id])), context: { model, index, targets: [target] } }, false);
    assert.equal(source, format ? '<p><b>Word</b></p><p><b>Word</b></p><p>Word</p><p>Other</p>'
      : '<p>RIGHT𠀀</p><p>RIGHT𠀀</p><p>WRONG</p><p>OTHER</p>');
    assert.deepEqual(Array.from(result.items, item => item.comparison?.pdf || item.text),
      format ? ['Word', 'Other'] : ['DIFFERENT', 'RIGHT𠀀']);
    assert.equal(result.items[0].comparison, items[2].comparison, 'original comparison and grouping survive');
    assert.equal(result.items[0].pdfSource.index, result.context.index, 'candidate uses the current source mapping');
    assert.equal(result.position, 0, 'matching candidates before the current item are also removed');
    assert.equal(applications, 1);
    assert.equal(undoStops, 2, 'the entire batch uses one undo group');
    const next = result.items[0].options[0].edits[0];
    assert.equal(source.slice(next.start, next.end), next.expected, 'remaining edits use the current source');
    assert.equal(result.context.index.source, source);
    for (const candidate of result.items) for (const option of candidate.options) api.validateEdits(source, option.edits);
    const nextResult = providers.get('pdf-ocr').apply({ editor, model, source, version, items: result.items,
      position: result.position, choices: result.choices, context: result.context }, false);
    for (const candidate of nextResult.items) for (const option of candidate.options) api.validateEdits(source, option.edits);
    assert.equal(nextResult.context.index.source, source, 'consecutive replacements keep candidates on the current source');
  }
});

test('compact review keeps distant differences without computing a second diff', () => {
  const api = engine(), providers = new Map();
  let calls = 0;
  const diff = api.textDiff;
  api.textDiff = (...args) => { calls++; return diff(...args); };
  reviewProvider(api, providers);
  const prefix = 'prefix '.repeat(12), middle = ' unchanged '.repeat(20), suffix = ' suffix'.repeat(12);
  const item = { id: 'one', options: [{ id: 'pdf', edits: [] }],
    comparison: { html: prefix + 'WRONG' + middle + 'BAD' + suffix,
      pdf: prefix + 'RIGHT' + middle + 'GOOD' + suffix } };
  const content = providers.get('pdf-ocr').content({ items: [item], choices: new Map([['one', 'pdf']]) }, item);
  const html = content.comparison[0].parts.map(part => part.text).join('');
  const pdf = content.comparison[1].parts.map(part => part.text).join('');
  assert.ok(html.includes('WRONG' + middle + 'BAD'));
  assert.ok(pdf.includes('RIGHT' + middle + 'GOOD'));
  assert.ok(html.startsWith('…') && html.endsWith('…'));
  assert.equal(calls, 1);
  const locator = providers.get('pdf-ocr').locator, value = item.comparison;
  assert.equal(locator.comparisonRows(value), content.comparison, 'compact rows reuse the prepared result');
  const full = locator.comparisonRows(value, false), missing = locator.comparisonRows(value, true, true);
  assert.equal(locator.comparisonRows(value, false), full);
  assert.equal(locator.comparisonRows(value, true, true), missing);
  assert.equal(full[0].parts.map(part => part.text).join(''), value.html);
  assert.ok(missing.every(row => row.parts.every(part => !part.changed)));
  assert.equal(calls, 1, 'different row views share the original comparison');
  value.pdf = value.html;
  const updated = locator.comparisonRows(value);
  assert.notEqual(updated, content.comparison, 'changed input invalidates prepared rows');
  assert.ok(updated.every(row => row.parts.every(part => !part.changed)));
  assert.notEqual(locator.comparisonRows(value, false), full, 'input changes invalidate every row view');
});

test('local textDiff serves review candidates and popup comparisons', () => {
  const api = engine(), providers = new Map();
  reviewProvider(api, providers);
  const locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
  const source = '<p>中文𠀀 wrong end</p>';
  const index = locator.editorSourceIndex({ getValue: () => source, getVersionId: () => 1 });
  const target = new pdfApi.PdfSourceIndex(new pdfApi.PdfLocator(), { raw: index.raw.replace('wrong', 'right') });
  index.rememberConnection(0, index.raw.length, target, { start: 0, end: target.raw.length });
  const localItems = index.reviewCandidates(null, false, true, true, [target]);
  assert.ok(localItems.length);
  const item = { options: [{ id: 'pdf', edits: [] }], comparison: { html: index.raw, pdf: target.raw } };
  const provider = providers.get('pdf-ocr');
  const localRows = provider.content({ items: [item], choices: new Map() }, item).comparison;
  assert.ok(localRows.every(row => row.parts.some(part => part.changed)));
  for (const connection of index.connections.get(target)) delete connection.editorDiff;
  const refreshedItems = index.reviewCandidates(null, false, true, true, [target]);
  for (const items of [localItems, refreshedItems])
    assert.equal(api.applyTextEdits(source, items.flatMap(item => item.options[0].edits)), source.replace('wrong', 'right'));
  const refreshedRows = provider.content({ items: [item], choices: new Map() }, item).comparison;
  for (const rows of [localRows, refreshedRows]) {
    assert.equal(rows[0].parts.map(part => part.text).join(''), index.raw);
    assert.equal(rows[1].parts.map(part => part.text).join(''), target.raw);
    assert.ok(rows.every(row => row.parts.some(part => part.changed)));
  }
});

test('text candidates, font candidates and decorations reuse one traversal and refresh font metadata', () => {
  const api = engine(), provider = reviewProvider(api);
  const locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
  const index = locator.sourceIndex('Alpha beta gamma');
  const target = new pdfApi.PdfSourceIndex(new pdfApi.PdfLocator(), { raw: 'Alpha beta GAMMA', fontVersion: 0, parts: [
    { start: 0, end: 6, font: { bold: false, italic: false } },
    { start: 6, end: 10, font: { bold: true, italic: false } },
    { start: 10, end: 16, font: { bold: false, italic: false } }
  ] });
  const connection = index.rememberConnection(0, index.raw.length, target, { start: 0, end: target.raw.length });
  let reads = 0;
  connection.editorDiff = { parts: [
    { html: 'Alpha beta ', pdf: 'Alpha beta ', changed: false },
    { html: 'gamma', pdf: 'GAMMA', changed: true }
  ].map(part => new Proxy(part, { get(object, key) { reads++; return object[key]; } })) };
  let fontReads = 0;
  const fontRuns = target.fontRuns.bind(target);
  target.fontRuns = (...args) => { fontReads++; return fontRuns(...args); };
  const items = index.reviewCandidates(null, false, true, true, [target]);
  const traversed = reads;
  const { ranges } = connection.editorDiff;
  const fonts = index.formatDifferences([], ['italic', 'bold'], true, [[connection, target]]);
  const model = { getPositionAt: offset => ({ lineNumber: 1, column: offset + 1 }) };
  const marks = index.sourceDecorations(index.reviewCandidates(null, true, false, true, [], [[connection, target]]), true, true, undefined, model);
  assert.equal(reads, traversed, 'review and highlight consumers share the classified spans');
  assert.deepEqual(Array.from(items, item => item.comparison.pdf), ['GAMMA']);
  assert.deepEqual(Array.from(fonts, item => item.text), ['beta']);
  assert.equal(marks.filter(mark => mark.options.description === 'PDF OCR text difference').length, 1);
  assert.equal(marks.filter(mark => mark.options.description === 'PDF font difference').length, 1);
  assert.deepEqual(index.formatDifferences([], ['italic', 'bold'], true, [[connection, target]]), fonts, 'merging output does not mutate cached font data');
  assert.deepEqual(index.reviewCandidates(null, false, true, true, [target]), items, 'candidate generation reuses the same data');
  assert.equal(reads, traversed, 'repeated consumers do not revisit diff parts');
  assert.equal(fontReads, 1, 'font runs are read once across all consumers');
  target.parts[1].font.bold = false;
  target.fontVersion++;
  assert.equal(index.formatDifferences([], ['italic', 'bold'], true, [[connection, target]]).length, 0);
  assert.equal(reads, traversed, 'new font metadata reuses prepared text spans');
  assert.equal(connection.editorDiff.ranges, ranges, 'font refresh preserves mapped ranges');
  assert.equal(index.reviewCandidates(null, false, true, true, [target])[0].comparison.pdf, 'GAMMA');
  assert.equal(fontReads, 2, 'updated font data is shared by subsequent text review');
});

test('transient mapping eviction preserves every prepared passage and recent selections', () => {
  const locator = new (engine().PdfLocator)({}, { document: { createElement: () => ({}) } });
  const index = locator.sourceIndex('a'.repeat(400)), target = locator.sourceIndex(index.raw);
  for (let start = 0; start < 360; start++)
    index.rememberConnection(start, start + 1, target, { start, end: start + 1 }, null, start < 160);
  const retained = index.connections.get(target);
  assert.equal(retained.filter(item => item.prepared).length, 160, 'required mappings are never evicted');
  assert.equal(retained.filter(item => !item.prepared).length, 128, 'selection history has a fixed bound');
  assert.equal(index.connectedRange(target, 0, 1).start, 0);
  assert.equal(index.connectedRange(target, 359, 360).start, 359);
  assert.equal(index.connectedRange(target, 160, 161), null);
});

test('all prepared highlights remain visible together after selection history fills', () => {
  const locator = new (engine().PdfLocator)({}, { document: { createElement: () => ({}) } });
  const index = locator.sourceIndex('a '.repeat(400)), target = locator.sourceIndex('b '.repeat(400));
  for (let i = 0; i < 160; i++) {
    const start = i * 2, hit = { start, end: start + 1 };
    index.rememberConnection(start, start + 1, target, hit);
    index.rememberConnection(start, start + 1, target, hit, null, true);
  }
  for (let i = 160; i < 400; i++)
    index.rememberConnection(i * 2, i * 2 + 1, target, { start: i * 2, end: i * 2 + 1 });
  const model = { getPositionAt: offset => ({ lineNumber: 1, column: offset + 1 }) };
  const marks = index.sourceDecorations(index.reviewCandidates(null, true, false, true, [], index.connectionPairs([target])), true, true, undefined, model);
  const columns = new Set(marks.map(mark => mark.range.startColumn));
  for (let i = 0; i < 160; i++) assert.ok(columns.has(i * 2 + 1), `prepared highlight ${i} remains visible`);
  assert.equal(marks.length, 288);
});

test('passage pruning matches pairwise containment and ignores cache recency order', () => {
  const locator = new (engine().PdfLocator)({}, { document: { createElement: () => ({}) } });
  let seed = 23;
  const random = max => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % max; };
  for (let round = 0; round < 80; round++) {
    const index = locator.sourceIndex('a'.repeat(500)), pdf = {};
    const pages = Array.from({ length: 8 }, () => locator.sourceIndex('Page'));
    for (const page of pages) {
      index.pageScopes.set(page, { prepared: true, scope: null });
      index.connections.set(page, Array.from({ length: 20 }, () => {
        const start = random(400); return { start, end: start + random(100) + 1 };
      }));
    }
    const all = pages.flatMap(page => index.connections.get(page).map(item => ({ page, item })));
    const expected = pages.map(page => index.connections.get(page).filter(item => !all.some(other => other.page !== page
      && other.item.start <= item.start && other.item.end >= item.end
      && other.item.end - other.item.start > item.end - item.start)));
    index?.diff(pages, pdf);
    const ranges = items => items.map(({ start, end }) => [start, end]);
    pages.forEach((page, i) => assert.deepEqual(ranges(index.connections.get(page)), ranges(expected[i])));
    const preparation = index.preparation;
    index?.diff([...pages].reverse(), pdf);
    assert.ok(index.preparation === preparation, 'LRU recency changes do not invalidate prepared mappings');
  }
});

test('OCR page reads publish font styles into the same aligned spans without a separate font pass', async () => {
  const api = engine(), objects = new Map();
  let pageReads = 0, textReads = 0, operatorReads = 0, release, notifications = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const items = ['Regular', 'Styled', 'RIGHT'].map((str, i) => ({ str, fontName: i === 1 ? 'style' : 'regular',
    transform: [1, 0, 0, 1, i * 80, 100], width: 70, height: 12 }));
  const page = { commonObjs: objects,
    async getTextContent() { textReads++; return { items }; },
    async getOperatorList() {
      operatorReads++;
      await gate;
      objects.set('regular', { name: 'Times', bold: false, italic: false });
      objects.set('style', { name: 'Times-BoldItalic', bold: true, italic: true });
      return { fnArray: [37, 38, 44, 37, 44], argsArray: [['regular', 12], [3], [], ['style', 12], []] };
    }
  };
  const pdf = { numPages: 1, async getPage() { pageReads++; return page; } };
  const locator = new api.PdfLocator({}, { document: { createElement: () => ({}) },
    isCurrent: () => true, waitForIdle: async () => {}, onIndexed: () => notifications++ });
  const target = await locator.indexDocument(pdf);
  const source = locator.sourceIndex('<p>Regular Styled WRONG</p>');
  const connection = source.rememberConnection(0, source.raw.length, target, { start: 0, end: target.raw.length });
  const before = api.differences(source, target, connection);
  assert.ok(before.text.length > 0, 'text comparison works while PDF font metadata is pending');
  assert.equal(before.fonts.length, 0, 'pending font data cannot create an automatic format edit');
  assert.equal(operatorReads, 1, 'font detection already started with the OCR page read');
  const alignment = connection.editorDiff;
  release();
  await target.pages[0].fontTask;
  const after = api.differences(source, target, connection);
  assert.equal(connection.editorDiff, alignment, 'font publication reuses the confirmed text alignment');
  assert.equal(after.fonts.length, 1);
  assert.equal(source.raw.slice(after.fonts[0].sourceStart, after.fonts[0].sourceEnd), 'Styled');
  assert.equal(after.fonts[0].font.bold, true);
  assert.equal(after.fonts[0].font.italic, true);
  assert.ok(notifications >= 2, 'late font metadata publishes an index update for existing highlights');
  const content = await new api.PdfLocator().readPageText(page);
  assert.equal(target.pages[0].parts[1].font, content.fonts.get('style'));
  const spans = items.map(item => ({ textContent: item.str,
    ownerDocument: { defaultView: { getComputedStyle: () => ({ fontFamily: 'serif' }) } } }));
  const view = { pdfPage: page, _textHighlighter: { textDivs: spans } };
  await new Promise(resolve => new api.PdfLocator().layerFonts(view, {}, resolve));
  assert.equal(new api.PdfLocator().layerFonts(view, {}, () => {})(spans[1]), target.pages[0].parts[1].font,
    'rendered OCR layers and the document index use the same detected style object');
  const changed = locator.sourceIndex('<p>Regular BADDDD RIGHT</p>');
  const mismatch = changed.rememberConnection(0, changed.raw.length, target, { start: 0, end: target.raw.length });
  assert.equal(changed.formatDifferences([], ['italic', 'bold'], true, [[mismatch, target, api.textDiff(changed, target, mismatch)]]).length, 0,
    'styled PDF text cannot be applied to a different HTML word without aligned characters');
  await locator.indexFonts(pdf);
  assert.deepEqual([pageReads, textReads, operatorReads], [1, 1, 1], 'review and native layers never reread this page');
});

test('saved font sizes and colors load without merging distinct frontend runs', async () => {
  const window = {};
  const fonts = [
    { name: 'Times-Roman', italic: false, bold: false, flags: 4, size: 11, color: 0, alpha: 255, ascender: 1.05, descender: -0.28 },
    { name: 'Times-Roman', italic: false, bold: false, flags: 4, size: 22, color: 0, alpha: 255, ascender: 1.05, descender: -0.28 },
    { name: 'Times-Roman', italic: false, bold: false, flags: 4, size: 22, color: 0xFF0000, alpha: 128, ascender: 1.05, descender: -0.28 }
  ];
  const formatted = fonts.map((font, i) => ({ start: i * 2, end: i * 2 + 1, fontIndex: i, text: 'ABC'[i] }));
  const data = new pdfApi.PdfSourceIndex(new pdfApi.PdfLocator(), { schema: 3, raw: 'A B C', fonts, formatted,
    pages: [{ number: 1, start: 0, end: 5, parts: formatted.map(part => ({ ...part, item: { str: part.text } })) }] });
  vm.runInNewContext(engineSource, { window, fetch: async () => ({ ok: true, json: async () => data }) });
  const index = await window.LocalOcrTextReader.readDocument({ numPages: 1, ocrTextUrl: '/cache' }, { isCurrent: () => true });
  assert.equal(index.pages[0].parts[1].font, fonts[1]);
  const runs = index.fontRuns();
  assert.equal(runs.length, 3, 'same family and bold/italic state must retain size/color boundaries');
  for (let i = 0; i < runs.length; i++) {
    for (const key of Object.keys(fonts[i])) assert.equal(runs[i][key], fonts[i][key]);
  }
  const spans = [{ textContent: 'A' }, { textContent: 'B C' }];
  const lookup = new window.PdfReviewProvider.PdfLocator().layerFonts({ _textHighlighter: { textDivs: spans } }, {}, () => {}, index.pages[0], index);
  assert.equal(lookup(spans[0]).size, 11);
  assert.equal(lookup(spans[1]).italic, null, 'a mixed span cannot inherit only its first font');
});

test('PDF cache stays primary and unavailable or invalid caches use the original text layer', async () => {
  const window = {};
  let response, requests = 0, reads = 0;
  vm.runInNewContext(engineSource, { window, fetch: async () => {
    requests++;
    if (response instanceof Error) throw response;
    return response;
  } });
  const api = Object.assign(window.PdfReviewProvider, window.PdfSelectionDiff);
  const environment = { isCurrent: () => true, waitForIdle: async () => {} };
  const makePdf = () => ({ numPages: 1, ocrTextUrl: '/cache', getPage: async () => {
    reads++;
    return { getTextContent: async () => ({ items: [
      { str: 'Original', transform: [1, 0, 0, 1, 0, 10], height: 10, width: 40 }
    ] }) };
  } });
  response = { ok: true, json: async () => (new pdfApi.PdfSourceIndex(new pdfApi.PdfLocator(), { schema: 3, raw: 'Cached', fonts: [], formatted: [],
    pages: [{ number: 1, start: 0, end: 6, parts: [] }] })) };
  const cached = await new api.PdfLocator({}, environment).indexDocument(makePdf());
  assert.equal(cached.raw, 'Cached');
  assert.equal(reads, 0, 'a valid backend cache never reads PDF.js text');
  for (const failure of [new Error('offline'),
    { ok: false, json: async () => ({ error: 'unavailable' }) },
    { ok: true, json: async () => { throw new SyntaxError('invalid JSON'); } },
    { ok: true, json: async () => (new pdfApi.PdfSourceIndex(new pdfApi.PdfLocator(), { schema: 2, raw: 'Old', fonts: [], formatted: [], pages: [] })) },
    { ok: true, json: async () => ({ schema: 1, pages: [] }) }]) {
    response = failure;
    const pdf = makePdf(), locator = new api.PdfLocator({}, environment);
    const [first, second] = await Promise.all([locator.indexDocument(pdf), locator.indexDocument(pdf)]);
    assert.equal(first, second, 'fallback index work is shared');
    assert.equal(first.raw, 'Original\n');
    assert.equal(first.pages[0].parts[0].start, 0);
    assert.equal(first.pages[0].parts[0].end, 8);
    assert.equal(first.normalized.text, 'original ');
  }
  const pdf = makePdf();
  delete pdf.ocrTextUrl;
  const before = requests;
  assert.equal((await new api.PdfLocator({}, environment).indexDocument(pdf)).raw, 'Original\n');
  assert.equal(requests, before, 'no backend request without a URL');
  assert.equal(reads, 6, 'each fallback reads its page once');
});

test('text-layer fallback stops on document change and failed extraction can retry', async () => {
  const api = engine();
  let current = true, reads = 0;
  const pdf = { numPages: 2, getPage: async () => {
    reads++;
    return { getTextContent: async () => { current = false; return { items: [] }; } };
  } };
  const environment = { isCurrent: () => current, waitForIdle: async () => {} };
  assert.equal(await new api.PdfLocator({}, environment).indexDocument(pdf), null);
  assert.equal(reads, 1);
  current = true;
  let attempts = 0;
  const page = { getTextContent: async () => {
    if (++attempts === 1) throw new Error('temporary text failure');
    return { items: [] };
  } };
  const retryPdf = { numPages: 1, getPage: async () => page };
  const locator = new api.PdfLocator({}, environment);
  await assert.rejects(locator.indexDocument(retryPdf), /temporary text failure/);
  assert.ok(await locator.indexDocument(retryPdf));
  assert.equal(attempts, 2);
});

