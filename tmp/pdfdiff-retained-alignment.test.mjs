import assert from 'node:assert/strict';import { readFile } from 'node:fs/promises';import vm from 'node:vm';import test from 'node:test';
const diffSource=await readFile(new URL('../public/pdfdiff/pdf-selection-diff.js',import.meta.url),'utf8');
function engine(){const window={};vm.runInNewContext(diffSource,{window});return window.PdfSelectionDiff;}
function reviewProvider(api){return api;}
test('prepared page reuse invalidates when connections or target pages change', () => {
  const locator = engine().createLocator({}, { document: { createElement: () => ({}) } });
  const source = locator.sourceIndex('Alpha Beta Gamma Delta');
  const page = locator.sourceIndex(source.raw), pdf = {};
  locator.prepareSource(source, [page], pdf);
  const initial = source.connections.get(page);
  let scopeReads = 0;
  const scopes = source.pageScopes;
  source.pageScopes = { get(target) { scopeReads++; return scopes.get(target); }, set: (target, value) => scopes.set(target, value) };
  for (let i = 0; i < 20; i++) locator.prepareSource(source, [page], pdf);
  assert.equal(scopeReads, 0, 'unchanged mappings bypass preparation entirely');
  assert.equal(source.connections.get(page), initial);
  locator.rememberConnection(source, 0, 5, page, { start: 0, end: 5 });
  locator.prepareSource(source, [page], pdf);
  assert.ok(scopeReads > 0, 'new selection mappings invalidate preparation');
  const rebuilt = locator.sourceIndex(source.raw);
  locator.prepareSource(source, [rebuilt], pdf);
  assert.ok(source.connections.get(rebuilt)?.length, 'rebuilt text layers receive fresh mappings');
});

test('long multi-page passages retain OCR mappings beyond the whole-range edit limit', () => {
  const api = engine(), locator = api.createLocator();
  let seed = 29;
  const raw = Array.from({ length: 20000 }, () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return String.fromCharCode(97 + seed % 26);
  }).join('');
  const positions = Array.from({ length: 300 }, (_, i) => i * 64 + 48);
  const changed = [...raw]; for (const at of positions) changed[at] = '7';
  const index = raw => ({ raw, normalized: locator.normalized(raw), pageScopes: new WeakMap(), connections: new WeakMap() });
  const source = index(raw), target = index(changed.join(''));
  locator.sourcePageScope(source, target, true);
  assert.ok(source.connections.get(target).length > 1, 'bounded groups survive more than 128 total OCR edits');
  for (const at of positions) {
    const hit = locator.connectedRange(source, target, at, at + 1);
    assert.ok(hit, `missing mapping at ${at}`);
    assert.equal(target.raw.slice(hit.start, hit.end), '7');
    const reverse = locator.connectedRange(source, target, hit.start, hit.end, true);
    assert.equal(reverse.start, at); assert.equal(reverse.end, at + 1);
  }
});

test('local highlight hunks separate OCR boundary spaces', () => {
  const api = engine();
  const locator = api.createLocator({}, { document: { createElement: () => ({}) } });
  const source = 'aft der\n' + 'x'.repeat(100), target = { raw: 'äft  der\n' + 'y'.repeat(100) };
  const index = locator.sourceIndex(source);
  const connection = { start: 0, end: source.length, targetStart: 0, targetEnd: target.raw.length };
  index.connections.set(target, [connection]);
  const parts = api.connectionDiff(index, target, connection).parts;
  assert.deepEqual(Array.from(parts.slice(0, 4), part => [part.html, part.pdf, part.changed]),
    [['a', 'ä', true], ['ft ', 'ft ', false], ['', ' ', true], ['der\n', 'der\n', false]]);
  const items = api.reviewCandidates(index, [target]);
  assert.deepEqual({ ...items[0].comparison }, { html: 'a', pdf: 'ä' });
  assert.equal(api.previewEdits(source, items[0].options[0].edits), source.replace('aft', 'äft'));
  const hit = locator.connectedRange(index, target, 0, 3, false, connection, true);
  assert.equal(target.raw.slice(hit.start, hit.end), 'äft', 'click excludes the following space insertion');
});

test('an over-budget page comparison does not highlight or replace the whole passage', () => {
  const api = engine();
  const locator = api.createLocator({}, { document: { createElement: () => ({}) } });
  const lines = Array.from({ length: 150 }, (_, i) => `Passage ${i} contains matching words.`);
  const index = locator.sourceIndex(lines.join(' '));
  const target = { raw: lines.join('\n').replace('Passage 5', 'Passage X') };
  const broad = locator.rememberConnection(index, 0, index.raw.length, target, { start: 0, end: target.raw.length });
  assert.ok(broad, 'normalized text still confirms the page mapping');
  const end = index.raw.indexOf('Passage 10'), targetEnd = target.raw.indexOf('Passage 10');
  const local = locator.rememberConnection(index, 0, end, target, { start: 0, end: targetEnd });
  assert.ok(api.connectionDiff(index, target, local).text.length, 'confirmed local changes remain available');
  assert.equal(api.connectionDiff(index, target, broad).text.length, 0, 'failed traceback supplies no discrepancy spans');
  assert.equal(locator.connectedRange(index, target, 0, index.raw.length, false, broad, true), null,
    'failed traceback cannot map a discrepancy to the entire PDF page');
  const items = api.reviewCandidates(index, [target]);
  assert.deepEqual(Array.from(items, item => [item.comparison.html, item.comparison.pdf]), [['5', 'X']]);
});

test('ME04-117 case-only differences survive selection mapping in both directions', () => {
  const html = '<p>Ein sozialer Vorteil, gleich 400, stellt für das Individuum, wenn die Gesellschaft nur aus einer Million Menschen besteht, <sup>4</sup>/<sub>10000</sub> dar.</p>';
  const api = engine();
  const locator = api.createLocator({}, { document: { createElement: () => ({}) } });
  const index = { source: html, ...locator.sourceIndex(html) };
  const start = index.raw.indexOf('Gesellschaft nur') + 'Gesellsc'.length;
  const target = locator.sourceIndex(index.raw.slice(0, start) + 'H' + index.raw.slice(start + 1));
  locator.rememberConnection(index, 0, index.raw.length, target, { start: 0, end: target.raw.length });
  for (const reverse of [false, true]) {
    const hit = locator.connectedRange(index, target, start, start + 1, reverse);
    assert.equal(hit.start, start);
    assert.equal(hit.end, start + 1);
    assert.equal(hit.approximate, true, 'case folding for locating must not erase a text difference');
  }
  const { difference } = locator.locateSource(index, [{ index: target, start, end: start + 1 }]);
  assert.equal(difference.html, 'h');
  assert.equal(difference.pdf, 'H');
});

test('ME07-073 and ME07-074 alignment excludes neighboring pages and preserves the final punctuation', async () => {
  const fixtures = JSON.parse(await readFile(new URL('../tests/fixtures/pdf-selection-me07-073-074.json', import.meta.url), 'utf8'));
  for (const fixture of fixtures) for (const lf of [false, true]) {
    const api = engine();
    const locator = api.createLocator({}, { document: { createElement: () => ({}) },
      isCurrent: () => true, waitForIdle: async () => {} });
    const pdf = { numPages: fixture.pages.length, getPage: async n => ({
      getTextContent: async () => ({ items: [{ str: fixture.pages[n - 1],
        transform: [1, 0, 0, 1, 0, 100], width: 100, height: 10 }] })
    }) };
    const html = lf ? fixture.html.replace(/\r\n/g, '\n') : fixture.html;
    const index = locator.sourceIndex(html), pages = fixture.pages.map(raw => locator.sourceIndex(raw));
    locator.prepareSource(index, pages, pdf);
    const before = api.reviewCandidates(index, pages).map(item => item.comparison);
    const full = await locator.indexDocument(pdf);
    locator.prepareSource(index, pages, pdf);
    const after = api.reviewCandidates(index, [...pages, full]).map(item => item.comparison);
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
    const hit = locator.connectedRange(index, full, start, start + word.length, false, undefined, true);
    assert.ok(hit);
    assert.equal(full.raw.slice(hit.start, hit.end), word, 'final footnote punctuation survives alignment');
    const reverse = locator.connectedRange(index, full, hit.start, hit.end, true);
    assert.equal(index.raw.slice(reverse.start, reverse.end), word, 'reverse selection uses the same boundary');
  }
});

test('ME07-066 missing page-end text maps before whole-document indexing', async () => {
  const fixture = JSON.parse(await readFile(new URL('../tests/fixtures/pdf-selection-me07-066.json', import.meta.url), 'utf8'));
  for (const html of [fixture.html, fixture.html.replace(/\r\n/g, '\n')]) {
    const api = engine();
    const locator = api.createLocator({}, { document: { createElement: () => ({}) } });
    const index = locator.sourceIndex(html), target = locator.sourceIndex(fixture.layerRaw);
    const pdf = {};
    locator.prepareSource(index, [target], pdf);
    assert.equal(locator.getDocumentIndex(pdf), undefined, 'only the visible page is available');
    const item = api.reviewCandidates(index, [target]).find(item => item.comparison.pdf.includes('Delegierten'));
    assert.ok(item, 'the missing word is highlighted without waiting for the full PDF');
    assert.equal(item.sourceStart, item.sourceEnd, 'HTML has an insertion point, not selectable text');
    assert.equal(item.comparison.html, '');
    const hit = locator.connectedRange(index, target, item.sourceStart, item.sourceEnd, false, undefined, true);
    assert.ok(hit, 'the same page mapping supplies the popup anchor');
    assert.equal(target.raw.slice(hit.start, hit.end).trim(), 'Delegierten');
    const edit = item.options[0].edits[0];
    assert.equal(edit.start, edit.end);
    assert.match(api.previewEdits(html, [edit]), /Montagne und Delegierten\s+der geheimen/);
  }
});

test('ME04-117 adjacent-page quotations cannot override a complete page mapping', async () => {
  const fixture = JSON.parse(await readFile(new URL('../tests/fixtures/pdf-selection-me04-117.json', import.meta.url), 'utf8'));
  const api = engine();
  const locator = api.createLocator({}, { document: { createElement: () => ({}) }, getTargets: () => pages });
  const index = { source: fixture.html, ...locator.sourceIndex(fixture.html) };
  const pages = fixture.pages.map(page => locator.sourceIndex(page.raw));
  locator.prepareSource(index, pages, {});
  // Font metadata can rebuild just the adjacent layer after the first preparation.
  pages[1] = locator.sourceIndex(fixture.pages[1].raw);
  locator.prepareSource(index, [pages[1]], {});
  const connections = pages.flatMap(page => (index.connections.get(page) || []).map(connection => [connection, page]));
  const model = { getPositionAt: offset => ({ lineNumber: 1, column: offset + 1 }) };
  const marks = reviewProvider(api).sourceDecorations(index, connections, model);
  const at = fixture.html.indexOf('Gesellschaft nur') + 8;
  assert.ok(!marks.some(({ range }) => range.startColumn - 1 <= at && range.endColumn - 1 > at),
    'the uppercase H in the next page quotation is not a difference in this page');
  assert.ok(marks.some(({ options }) => /ooo/.test(options.hoverMessage?.value)), 'actual OCR differences remain reviewable');
});

test('ME04-037 keeps the matching heading out of deletion/reinsertion markers', async () => {
  const fixture = JSON.parse(await readFile(new URL('../tests/fixtures/pdf-selection-me04-037.json', import.meta.url), 'utf8'));
  const api = engine();
  const locator = api.createLocator({}, { document: { createElement: () => ({}) } });
  for (const html of [fixture.html, fixture.html.replace(/\r\n/g, '\n')]) {
    const index = { source: html, ...locator.sourceIndex(html) }, target = locator.sourceIndex(fixture.layerRaw);
    locator.sourcePageScope(index, target, true);
    const connections = (index.connections.get(target) || []).map(connection => [connection, target]);
    assert.ok(connections.length);
    const model = { getPositionAt: offset => ({ lineNumber: 1, column: offset + 1 }) };
    const marks = reviewProvider(api).sourceDecorations(index, connections, model);
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
    const hit = locator.connectedRange(index, target, at, at + 'Erklärung'.length, false, connection, true);
    assert.equal(target.raw.slice(hit.start, hit.end), 'Erklärung', 'click mapping shares the refined alignment');
  }
});

test('transient mapping eviction preserves every prepared passage and recent selections', () => {
  const locator = engine().createLocator({}, { document: { createElement: () => ({}) } });
  const index = locator.sourceIndex('a'.repeat(400)), target = locator.sourceIndex(index.raw);
  for (let start = 0; start < 360; start++)
    locator.rememberConnection(index, start, start + 1, target, { start, end: start + 1 }, null, start < 160);
  const retained = index.connections.get(target);
  assert.equal(retained.filter(item => item.prepared).length, 160, 'required mappings are never evicted');
  assert.equal(retained.filter(item => !item.prepared).length, 128, 'selection history has a fixed bound');
  assert.equal(locator.connectedRange(index, target, 0, 1).start, 0);
  assert.equal(locator.connectedRange(index, target, 359, 360).start, 359);
  assert.equal(locator.connectedRange(index, target, 160, 161), null);
});


test('passage pruning matches pairwise containment and ignores cache recency order', () => {
  const locator = engine().createLocator({}, { document: { createElement: () => ({}) } });
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
    locator.prepareSource(index, pages, pdf);
    pages.forEach((page, i) => assert.deepEqual(index.connections.get(page), expected[i]));
    const preparation = index.preparation;
    locator.prepareSource(index, [...pages].reverse(), pdf);
    assert.equal(index.preparation, preparation, 'LRU recency changes do not invalidate prepared mappings');
  }
});


test('source decorations ignore whitespace and hyphens while preserving subsequent character offsets', () => {
  const api = engine();
  const model = { getPositionAt: offset => ({ lineNumber: 1, column: offset + 1 }) };
  const decorate = (raw, pdf) => reviewProvider(api).sourceDecorations(
    { raw, starts: Array.from({ length: raw.length }, (_, i) => i),
      ends: Array.from({ length: raw.length }, (_, i) => i + 1) },
    [[{ start: 0, end: raw.length, targetStart: 0, targetEnd: pdf.length }, { raw: pdf }]], model);
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
    assert.equal(mark.options.beforeContentClassName, 'mew-ocr-diff-insert');
    assert.equal(mark.options.inlineClassName, undefined);
  }
});

test('source markers locate local diff changes at word boundaries, inside words and beside repeated characters', () => {
  const api = engine();
  for (const [html, pdf, at, missing] of [
    ['work', 'works', 4, 's'], ['word', 'sword', 0, 's'],
    ['Louis-Philippees den', 'Louis-Philippes\nden', 14, 's\n'],
    ['schöpliche', 'schöpfliche', 5, 'f'], ['a𠀀b', 'a𠀀𠀁b', 3, '𠀁']
  ]) {
    const target = { raw: pdf, parts: [] }, pdfDocument = {};
    const locator = api.createLocator({}, { getVisiblePages: () => [{ number: 1, index: target }] });
    const index = { raw: html, starts: [...Array(html.length).keys()],
      ends: Array.from({ length: html.length }, (_, i) => i + 1),
      normalized: locator.normalized(html), connections: new WeakMap(), pageScopes: new WeakMap() };
    target.normalized = locator.normalized(pdf);
    locator.rememberConnection(index, 0, html.length, target, { start: 0, end: pdf.length });
    const end = html.includes('Philippees') ? at + 3 : at;
    const hit = locator.connectedRange(index, target, at, end, false, undefined, true);
    assert.equal(pdf.slice(hit.start, hit.end), missing);
    const [location] = locator.findLocations(pdfDocument, [{ index, marked: true, start: at, end, text: html.slice(at, end), before: html.slice(0, at), after: html.slice(end) }]);
    assert.equal(location.targets[0].difference.html, html.slice(at, end));
    assert.equal(location.targets[0].difference.pdf, missing);
    const { focusHit } = locator.locateLayer(target, [], location.targets);
    assert.equal(pdf.slice(focusHit.start, focusHit.end), missing);
    assert.equal(locator.connectedRange(index, target, 1, 1), null, 'ordinary carets do not select PDF characters');
  }
});

