import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';

import { diffSource, mappingSource, providerSource } from './support/pdf-harness.mjs';

test('font replacement retains overlapping faults and batch validation stays atomic', () => {
  for (const all of [false, true]) for (const conflict of [false, true]) {
    const window = { addEventListener() {}, removeEventListener() {} }, providers = new Map();
    vm.runInNewContext(diffSource + '\n' + mappingSource, { window });
    const locator = new window.PdfReviewProvider.PdfLocator({}, { document: { createElement: () => ({}) } });
    let source = '<p>abc def</p>', applications = 0, undoStops = 0;
    const model = { getValue: () => source, getVersionId: () => 1,
      getPositionAt: offset => ({ lineNumber: 1, column: offset + 1 }) };
    locator.editorSourceIndex(model);
    const editor = { getModel: () => model, getOption: () => false, pushUndoStop() { undoStops++; },
      executeEdits(origin, edits) {
        applications++;
        for (const edit of [...edits].reverse()) source = source.slice(0, edit.range.startColumn - 1)
          + edit.text + source.slice(edit.range.endColumn - 1);
        return true;
      } };
    window.PdfSelection = { locator, editor };
    window.ReplacementReview = { register(provider) { providers.set(provider.id, provider); return () => {}; } };
    vm.runInNewContext(providerSource, { window, document: {}, setInterval: () => 0, clearInterval() {} });
    const items = [[0, 3, 3, 'A'], [1, 3, conflict ? 3 : 4, 'B'], [4, 7, 7, 'D']].map(([start, end, at, text], i) => ({
      id: String(i), sourceStart: start, sourceEnd: end, font: {},
      options: [{ id: 'format', edits: [{ start: at, end: at + 1, expected: source[at], text }] }]
    }));
    const group = { items: [items[0]] };
    locator.reviewLists.set(items, { groups: new Map([[items[0], group]]), index: locator.index,
      edits: items.flatMap(item => item.options[0].edits) });
    const apply = () => providers.get('pdf-ocr').apply({ context: { editor, model, source, version: 1 }, items, position: 0 }, all);
    if (conflict) {
      assert.throws(apply, /替换范围重叠/);
      assert.equal(source, '<p>abc def</p>');
      assert.equal(applications, 0);
      assert.equal(undoStops, 0);
    } else {
      assert.equal(apply().offset, 3);
      assert.equal(source, all ? '<p>ABc Def</p>' : '<p>ABc def</p>');
      assert.equal(applications, 1);
      assert.equal(undoStops, 2);
    }
  }
});

test('ME32-150 clicking a highlighted footnote digit opens its exact empty OCR counterpart', async () => {
  const listeners = new Map(), providers = new Map(), pdf = {};
  const window = { addEventListener(name, fn) { listeners.set(name, fn); }, removeEventListener() {} };
  vm.runInNewContext(diffSource + '\n' + mappingSource, { window });
  const api = Object.assign(window.PdfReviewProvider, window.PdfSelectionDiff);
  const locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
  const source = '<p><a id="F9" href="#ZF9">9</a> starkem Druck</p>';
  const index = locator.sourceIndex(source), target = new api.PdfSourceIndex(locator, { raw: 'kem Druck\n', parts: [] });
  index.rememberConnection(0, index.raw.length, target, { start: 0, end: target.raw.length });
  const model = { getValue: () => source, getVersionId: () => 1,
    getPositionAt: offset => ({ lineNumber: 1, column: offset + 1 }) };
  const editor = { getModel: () => model, getDomNode: () => ({ ownerDocument: { defaultView: window } }) };
  let opened;
  window.ReaderUI = { getPdfViewer: () => ({ pdfDocument: pdf }) };
  window.PdfSelection = { locator, editor };
  window.ReplacementReview = { register(provider) { providers.set(provider.id, provider); return () => {}; },
    isOpenFor: () => false, openForSelection(...args) { opened = args; } };
  vm.runInNewContext(providerSource, { window, document: {}, setInterval: () => 0, clearInterval() {} });
  const notice = { html: '9', pdf: '', source: { index, start: 0, end: 1 } };
  const reviewItems = locator.reviewItems;
  let listenerRequest;
  locator.reviewItems = function(context) {
    if (context === undefined) listenerRequest = this.reviewRequest;
    return reviewItems.apply(this, arguments);
  };
  listeners.get('pdf-selection-difference')({ type: 'pdf-selection-difference', detail: { editor, model, pdf, notices: [notice], targets: [target] } });
  assert.ok(opened, 'the footnote filter must not discard an explicit digit click');
  assert.equal(listenerRequest.notices[0], notice, 'candidate initialization reads the listener input from its locator');
  assert.equal(locator.reviewRequest, undefined, 'listener input is consumed rather than retained as a second session');
  assert.equal(opened[2], '0:1');
  assert.equal(locator.review.selection.id, opened[2], 'the focused selection is initialized with the cached candidates');
  const items = (await providers.get('pdf-ocr').locator.reviewItems({ model, source, request: opened[3] })).items;
  const selected = items.find(item => item.id === '0:1');
  assert.equal(selected.comparison.html, '9');
  assert.equal(selected.comparison.pdf, '');
  assert.equal(api.applyTextEdits(source, selected.options[0].edits), source.replace('>9</a>', '></a>'));
  const onlyDigit = locator.sourceIndex(source.replace(' starkem', 'kem'));
  onlyDigit.rememberConnection(0, onlyDigit.raw.length, target, { start: 0, end: target.raw.length });
  assert.equal(onlyDigit.reviewCandidates(null, false, true, true, [target]).length, 0, 'default footnote filtering stays unchanged');
});

for (const splitMarkup of [false, true]) for (const query of ['WR', 'W', 'eWRr', 'WRrm\nhere.', 'WR+', 'W xx W']) {
  test(`selection popup matches any exact sequence ${JSON.stringify(query)}${splitMarkup ? ' across inline tags' : ''}`, async () => {
    const providers = new Map(), pdf = {};
    const window = { addEventListener() {}, removeEventListener() {} };
    vm.runInNewContext(diffSource + '\n' + mappingSource, { window });
    const api = Object.assign(window.PdfReviewProvider, window.PdfSelectionDiff);
    const locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
    const paragraphs = [`First te${query}rm here.`, `Other te${query}rm there.`,
      `ot${query}rm te${query}rd ${query}`, `correct ${query}`, `different ${query}`, query.toLowerCase()];
    const markup = text => splitMarkup ? text.replaceAll('W', '<i>W</i>') : text;
    let source = '\r\n' + paragraphs.map(text => `<p>${markup(text)}</p>`).join('');
    let version = 1;
    const model = { getValue: () => source, getVersionId: () => version,
      getPositionAt: offset => ({ lineNumber: 1, column: offset + 1 }) };
    const index = locator.editorSourceIndex(model);
    const pdfText = paragraphs.map((text, at) => at === 3 ? text : text.replaceAll('W', at === 4 ? 'Q' : 'V')).join('\n') + '\n';
    const target = new api.PdfSourceIndex(locator, { raw: pdfText, parts: [] });
    locator.indexDocument = locator.indexFonts = async () => target;
    index.rememberConnection(0, index.raw.length, target, { start: 0, end: target.raw.length });
    const start = index.raw.indexOf(query);
    const notice = { html: query, pdf: query.replaceAll('W', 'V'), source: { index, start, end: start + query.length } };
    window.ReaderUI = { getPdfViewer: () => ({ pdfDocument: pdf }) };
    const editor = { getModel: () => model, getOption: () => false,
      getDomNode: () => ({ ownerDocument: { defaultView: window }, classList: { toggle() {} } }), pushUndoStop() {},
      executeEdits(origin, edits) {
        for (const edit of [...edits].reverse()) source = source.slice(0, edit.range.startColumn - 1)
          + edit.text + source.slice(edit.range.endColumn - 1);
        version++; return true;
      } };
    let highlighted;
    window.PdfSelection = { locator, editor, showReviewPointer(editor, items) { highlighted = items; } };
    window.ReplacementReview = { register(provider) { providers.set(provider.id, provider); return () => {}; } };
    vm.runInNewContext(providerSource, { window, document: {}, setInterval: () => 0, clearInterval() {} });
    const provider = providers.get('pdf-ocr'), context = { editor, model, source, request: { pdf, notice, targets: [target] } };
    const items = (await provider.locator.reviewItems(context)).items;
    const selections = items.filter(item => item.selection);
    const prepared = locator.reviewLists.get(items);
    assert.deepEqual(Array.from(prepared.entries), Array.from(items, item => item.pdfSource),
      'review entries follow the final source-index candidate order');
    for (const item of items.filter(item => item.font)) {
      const nearby = items.find(value => !value.font && value.sourceEnd >= item.sourceStart);
      assert.equal(item.reviewStart, nearby && nearby.sourceStart <= item.sourceEnd ? nearby.sourceStart : item.sourceStart,
        'source-index ordering uses the expanded selection rather than the original fault');
      if (nearby && nearby.sourceStart <= item.sourceEnd) assert.ok(items.indexOf(nearby) < items.indexOf(item),
        'the expanded text selection precedes its overlapping format fault');
    }
    const expected = [];
    for (let at = start; at < index.raw.indexOf('correct '); at = index.raw.indexOf(query, at + query.length)) expected.push(at);
    assert.deepEqual(Array.from(selections, item => item.sourceStart), expected,
      'matches include other word prefixes, suffixes and standalone sequences, excluding correct text and different replacements');
    assert.deepEqual(Array.from(provider.matchingItems(selections[0], context, items), item => item.id),
      Array.from(selections, item => item.id), 'popup, preview and replacement share the group');
    const foreign = { ...selections[0], pdfSource: { index: target, start, end: start + 2 } };
    assert.deepEqual(Array.from(provider.matchingItems(selections[0], context, [...items, foreign]), item => item.id),
      Array.from(selections, item => item.id), 'another source index cannot join the group');
    provider.onSelect(selections[0], context, items);
    assert.deepEqual(Array.from(highlighted, item => item.id), Array.from(selections, item => item.id),
      'selecting a term highlights every matching candidate');
    const refreshed = provider.apply({ items, position: items.indexOf(selections[0]), context: { ...context, version } }, false);
    assert.ok(Number.isInteger(refreshed.offset), 'replacement returns the resume offset to the shared review session');
    const refreshedContext = { ...context, source, version, request: {} };
    await provider.locator.reviewItems(refreshedContext);
    assert.equal(locator.index.source, source, 'provide rebuilds review data from the current model');
    source = source.replace('First', 'First longer'); version++;
    const manual = { ...refreshedContext, source, version };
    await provider.locator.reviewItems(manual);
    assert.equal(locator.index.source, source, 'manual edits use the same provider entry');
    assert.equal(provider.refreshAfterEdit, undefined, 'refresh lifecycle belongs to the shared review session');
    assert.equal(source.replace('First longer', 'First'), '\r\n' + paragraphs.map((text, at) => `<p>${at < 3
      ? markup(text).replaceAll('W', 'V') : markup(text)}</p>`).join(''),
      'replacement applies exactly the highlighted group and preserves markup and other replacement patterns');
  });
}

for (const [pdfWord, preparedOnly, unmapped] of [['Ge-\nsinnung'], ['Gesin nung'], ['Ge-\nsinnnng'], ['Ge-\nsinnung', true], ['Gesinnung', false, true]]) {
  test(`ME08-284 opens the clicked italic fault, with text taking priority only for real changes: ${JSON.stringify(pdfWord)}${preparedOnly ? ' (prepared mapping only, ME17-463 regression)' : unmapped ? ' (before background mapping)' : ''}`, async () => {
    const listeners = new Map(), providers = new Map(), pdf = {};
    const window = { addEventListener(name, callback) { listeners.set(name, callback); }, removeEventListener() {} };
    vm.runInNewContext(diffSource + '\n' + mappingSource, { window });
    const api = Object.assign(window.PdfReviewProvider, window.PdfSelectionDiff);
    const locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
    const source = '<p><i>Gesinnung</i> haben, aus schlechter Absicht und purem boshafen Willen.</p>';
    const index = locator.sourceIndex(source), wordEnd = 'Gesinnung'.length;
    const target = new api.PdfSourceIndex(locator, {
      raw: index.raw.replace('Gesinnung', pdfWord).replace('boshafen', 'boshaften'),
      parts: [{ start: 0, end: pdfWord.length, font: { italic: false, bold: false } }]
    });
    if (!unmapped) index.rememberConnection(0, index.raw.length, target, { start: 0, end: target.raw.length });
    if (preparedOnly) {
      index.pageScopes.set(target, { connections: index.connections.get(target) });
      index.connections.set(target, []);
    }
    const model = { getValue: () => source, getVersionId: () => 1,
      getPositionAt: offset => ({ lineNumber: 1, column: offset + 1 }) };
    const editor = { getModel: () => model, getDomNode: () => ({ ownerDocument: { defaultView: window } }) };
    let opened;
    window.ReaderUI = { getPdfViewer: () => ({ pdfDocument: pdf }) };
    window.PdfSelection = { locator, editor };
    window.ReplacementReview = {
      register(provider) { providers.set(provider.id, provider); return () => {}; },
      isOpenFor: () => false,
      openForSelection(...args) { opened = args; }
    };
    vm.runInNewContext(providerSource, { window, document: {}, setInterval: () => 0, clearInterval() {} });
    const notice = { html: 'Gesinnung', pdf: pdfWord, source: { index, start: 0, end: wordEnd },
      target: { index: target, start: 0, end: pdfWord.length } };
    listeners.get('pdf-selection-difference')({ type: 'pdf-selection-difference', detail: { editor, model, pdf, notices: [notice], targets: [target] } });
    assert.ok(opened);
    const [id, , focusId, request] = opened, realTextChange = pdfWord.includes('sinnnng');
    assert.equal(id, 'pdf-ocr');
    assert.equal(focusId, realTextChange ? `0:${wordEnd}` : `font:0:${wordEnd}`);
    assert.equal(request.kind, realTextChange ? undefined : 'font');
    const prepared = locator.review?.items;
    if (!realTextChange) assert.equal(locator.review.focus.id, focusId, 'font focus is cached with its candidate list');
    const items = (await providers.get(id).locator.reviewItems({ model, source, request })).items;
    if (!realTextChange) assert.equal(items, prepared, 'opening the popup reuses the list prepared for the format click');
    const selected = items.find(item => item.id === focusId);
    assert.ok(selected, 'clicked candidate must exist instead of falling forward to boshafen');
    assert.equal(!!selected.font, !realTextChange);
    assert.ok(items.some(item => item.comparison?.pdf.includes('t')), 'later text fault remains available');
    const firstFont = items.findIndex(item => item.font);
    const laterText = items.findIndex(item => item.comparison?.pdf.includes('t'));
    assert.ok(firstFont >= 0 && firstFont < laterText,
      'navigation keeps an earlier font fault before later text differences');
    if (realTextChange) assert.ok(items.indexOf(selected) < firstFont,
      'overlapping text differences precede their font differences');
    index.version = 0;
    index.reviewCandidates = () => { throw new Error('an outdated notice must be rejected before candidate generation'); };
    opened = null;
    listeners.get('pdf-selection-difference')({ type: 'pdf-selection-difference', detail: { editor, model, pdf, notices: [notice], targets: [target] } });
    assert.equal(opened, null);
  });
}

for (const kind of ['text', 'insertion', 'deletion', 'newline', 'format', 'word', 'term', 'selection']) {
  test(`same-pattern ${kind} replacement matches the word across different paragraphs`, () => {
    const window = { addEventListener() {}, removeEventListener() {} };
    vm.runInNewContext(diffSource + '\n' + mappingSource, { window });
    const api = Object.assign(window.PdfReviewProvider, window.PdfSelectionDiff), providers = new Map();
    const locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
    const format = kind === 'format', whole = kind === 'word' || kind === 'term';
    const old = kind === 'insertion' ? '' : whole ? kind === 'word' ? 'WRONG' : 'wrong term' : kind === 'selection' ? 'WR' : 'W';
    const replacement = kind === 'deletion' ? '' : kind === 'newline' ? '\n' : kind === 'term' ? 'right term' : 'R';
    const prefix = whole ? '' : 'te', suffix = whole ? '' : 'rm';
    const tokens = [prefix + old + suffix, prefix + old + suffix, 'ot' + old + suffix,
      prefix + old + 'rd', prefix + old + suffix, old, old];
    const paragraphs = tokens.map((token, at) => at < 5
      ? `${at === 1 ? 'Different' : 'Before𠀀'} ${token} ${at === 1 ? 'elsewhere.' : 'after.'}` : token);
    const matching = kind === 'selection' ? [0, 1, 2, 3, 5, 6] : whole ? [0, 1, 5, 6] : [0, 1];
    let source = paragraphs.map(text => `<p>${text}</p>`).join(''), version = 1, applications = 0, undoStops = 0;
    const model = { getValue: () => source, getVersionId: () => version,
      getPositionAt: offset => ({ lineNumber: 1, column: offset + 1 }) };
    const index = locator.editorSourceIndex(model), target = new api.PdfSourceIndex(new api.PdfLocator(), { raw: index.raw, parts: [] });
    const items = [];
    let start = 0;
    for (const [at, paragraph] of paragraphs.entries()) {
      const a = start + (at < 5 ? paragraph.indexOf(' ') + 1 + (at === 2 ? 2 : prefix.length) : 0);
      const b = a + old.length;
      const font = { bold: true, italic: at === 4 };
      if (format) target.parts.push({ start: a, end: b, font });
      const text = at === 4 ? 'OTHER' : replacement;
      items.push({ id: String(at), sourceStart: a, sourceEnd: b,
        selection: kind === 'selection',
        ...(format ? { text: old, font, htmlFont: index.formats[a] }
          : { comparison: { html: old, pdf: text } }),
        options: [{ id: 'pdf', edits: format ? index.fontEdits(a, b, font)
          : kind === 'term' ? [{ start: index.starts[a], end: index.ends[b - 1], expected: old, text }]
            : index.textEdits(a, b, text) }] });
      start += paragraph.length + 1;
    }
    index.rememberConnection(0, index.raw.length, target, { start: 0, end: target.raw.length });
    // Replacement reuses prepared edits without another comparison.
    api.PdfSourceIndex.prototype.reviewCandidates = () => { throw new Error('replacement must reuse prepared candidates'); };
    const classes = new Set(), node = { ownerDocument: { defaultView: window }, classList: {
      toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); },
      remove(name) { classes.delete(name); }
    } };
    const editor = { getDomNode: () => node, getModel: () => model, getOption: () => false, pushUndoStop() { undoStops++; },
      executeEdits(origin, edits) {
        applications++;
        for (const edit of [...edits].reverse()) source = source.slice(0, edit.range.startColumn - 1)
          + edit.text + source.slice(edit.range.endColumn - 1);
        version++; return true;
      } };
    let highlighted;
    window.PdfSelection = { locator, editor, showReviewPointer(targetEditor, matches) { highlighted = matches; },
      clearReviewPointer() { highlighted = null; } };
    window.ReplacementReview = { register(provider) { providers.set(provider.id, provider); return () => {}; } };
    vm.runInNewContext(providerSource, { window, document: {}, setInterval: () => 0, clearInterval() {} });
    const provider = providers.get('pdf-ocr'), context = { editor, model, index, targets: [target] };
    provider.onSelect(items[1], context, items);
    assert.deepEqual(Array.from(highlighted, item => item.id), matching.map(String), 'matching faults are highlighted with preview off');
    assert.equal(classes.has('mew-review-preview'), false);
    provider.onSelect(items[1], context, items, true);
    assert.deepEqual(Array.from(highlighted, item => item.id), matching.map(String), 'preview uses the same replacement group');
    assert.equal(classes.has('mew-review-preview'), true);
    provider.onClose(context);
    assert.equal(highlighted, null);
    assert.equal(classes.has('mew-review-preview'), false);
    provider.apply({ items, position: 1, context: { ...context, source, version },
      choices: new Map(items.map(item => [item.id, 'pdf'])) }, false);
    assert.equal(source, paragraphs.map((text, at) => {
      const a = at < 5 ? text.indexOf(' ') + 1 + prefix.length : 0;
      return `<p>${matching.includes(at) ? text.slice(0, a) + (format ? '<b>W</b>' : replacement)
        + text.slice(a + old.length) : text}</p>`;
    }).join(''));
    assert.equal(applications, 1);
    assert.equal(undoStops, 2, 'matching replacements share one undo group');
  });
}

test('prepared review lists share groups, entries and edits across consumers and invalidate with their inputs', async () => {
  const providers = new Map(), listeners = new Map(), pdf = {};
  const window = { addEventListener(name, fn) { listeners.set(name, fn); }, removeEventListener() {} };
  vm.runInNewContext(diffSource + '\n' + mappingSource, { window });
  const api = Object.assign(window.PdfReviewProvider, window.PdfSelectionDiff);
  let target, source = '<p>First teWRrm here.</p><p>Other teWRrm there.</p>', version = 1;
  const locator = new api.PdfLocator({}, { document: { createElement: () => ({}) }, getPdf: () => pdf, getTargets: () => [target] });
  const model = { getValue: () => source, getVersionId: () => version,
    getPositionAt: offset => ({ lineNumber: 1, column: offset + 1 }) };
  const index = locator.editorSourceIndex(model);
  target = new api.PdfSourceIndex(locator, { raw: index.raw.replaceAll('WR', 'R'), parts: [] });
  index.rememberConnection(0, index.raw.length, target, { start: 0, end: target.raw.length });
  locator.indexDocument = async () => target;
  locator.indexFonts = async () => target;
  let pointer;
  window.ReaderUI = { getPdfViewer: () => ({ pdfDocument: pdf }) };
  window.PdfSelection = { locator, showReviewPointer(...args) { pointer = args; }, clearReviewPointer() {}, refresh() {} };
  let suggestionPlans;
  window.ReplacementReview = { register(provider) { providers.set(provider.id, provider); return () => {}; }, invalidate() {},
    bindSuggestions(editor, provide) { suggestionPlans = provide; } };
  vm.runInNewContext(providerSource, { window, document: {}, setInterval: () => 0, clearInterval() {} });
  const provider = providers.get('pdf-ocr');
  const fontProvider = providers.get('pdf-font'), focusItems = [
    { sourceStart: 2, sourceEnd: 2 }, { sourceStart: 4, sourceEnd: 8, font: true }, { sourceStart: 10, sourceEnd: 12 }
  ], focusRequest = { notice: { source: { start: 2, end: 2 } } };
  assert.equal(provider.focusIndex, fontProvider.focusIndex, 'providers share the focus implementation');
  assert.equal(provider.focusIndex(focusItems, focusRequest), 0, 'text review retains insertion candidates');
  assert.equal(fontProvider.focusIndex(focusItems, focusRequest), 1, 'font review skips empty candidates at the boundary');
  focusRequest.notice.source = { start: 5, end: 6 };
  assert.equal(!!provider.containsSelection(focusItems[1], focusRequest), false, 'text selection requires an exact range');
  assert.equal(fontProvider.containsSelection(focusItems[1], focusRequest), true, 'font selection accepts an overlapping range');
  const node = { ownerDocument: { defaultView: window }, classList: { toggle() {}, remove() {} } };
  let marks;
  const editor = { getModel: () => model, getDomNode: () => node,
    createDecorationsCollection: () => ({ set(values) { marks = values; }, clear() {} }) };
  window.PdfSelection.editor = editor;
  const context = { model, source, editor, signal: { aborted: false } };
  assert.ok(provider.locator === locator, 'the host loads the shared class instance directly');
  assert.equal(provider.provide, undefined, 'PDF review has no forwarding adapter');
  assert.ok(locator.model === model, 'the locator owns the current editor model');
  const items = (await provider.locator.reviewItems(context)).items;
  assert.ok(locator.reviewItems().items === items, 'prepared callers use the same synchronous class entry');
  assert.equal(locator.review.items, items, 'the locator owns the final review result');
  assert.equal(locator.reviewLists.get(items), locator.review, 'sessions share the result rather than a copied cache');
  const editorSourceIndex = locator.editorSourceIndex;
  locator.editorSourceIndex = function(...args) { editorSourceIndex.apply(this, args); };
  try {
    assert.equal(locator.reviewItems().items, items, 'review reads the updated class index without relying on the method return');
  } finally { locator.editorSourceIndex = editorSourceIndex; }
  assert.equal((await locator.reviewItems({ model, source, editor, signal: { aborted: true } })).items.length, 0,
    'cancelled initial loads do not publish candidates');
  assert.equal(locator.review.items, items, 'cancelled work leaves the published result intact');
  assert.ok(items.length >= 2);
  assert.equal((await provider.locator.reviewItems(context)).items, items, 'unchanged source reuses the full candidate list');
  assert.equal(context.index, undefined, 'the request does not own the source index');
  assert.equal(context.targets, undefined, 'targets belong to the class-owned source index');
  const group = provider.matchingItems(items[0], context, items);
  assert.equal(group.length, 2);
  let comparisons = 0;
  const comparison = items[0].comparison;
  Object.defineProperty(items[0], 'comparison', { get() { comparisons++; return comparison; }, configurable: true });
  assert.equal(provider.matchingItems(items[0], context, items), group);
  assert.equal(comparisons, 0, 'prepared group lookup does not read or reclassify candidate text');
  const entries = locator.reviewLists.get(group).entries;
  assert.equal(locator.reviewLists.get(group).entries, entries);
  assert.ok(entries[0] === group[0].pdfSource, 'pointer entries are the generated source records');
  const state = { items, position: 0, context };
  assert.equal(provider.content(state, items[0]).edits, provider.content(state, items[0]).edits);
  assert.equal(provider.content(state, items[0]).allEdits, provider.content(state, items[0]).allEdits);
  const applyEdits = window.PdfSelectionDiff.applyEdits, applied = [];
  window.PdfSelectionDiff.applyEdits = (...args) => { applied.push(args[4]); };
  try {
    for (const all of [false, true]) {
      const result = provider.apply({ ...state, context: { ...context, version: model.getVersionId() } }, all);
      assert.equal(applied.at(-1), locator.reviewLists.get(all ? items : group).edits,
        'application reuses the prepared edit list for the selected scope');
      const offset = index.starts[items[0].sourceStart];
      assert.equal(result.offset, offset + applied.at(-1).reduce((delta, edit) => delta
        + (edit.end <= offset ? edit.text.length - (edit.end - edit.start) : 0), 0));
    }
  } finally { window.PdfSelectionDiff.applyEdits = applyEdits; }
  assert.equal(provider.content(state, items[0]).comparison, provider.content(state, items[0]).comparison, 'popup rows are reused through the existing comparison cache');
  provider.onSelect(items[0], context, items);
  assert.equal(pointer[1], group, 'the pointer receives the same group as preview and replacement');
  const publish = () => listeners.get('pdf-selection-sources')({ detail: {
    editor, index: locator.index, targets: [target], enabled: false, diffEnabled: true } });
  publish();
  window.PdfSelection.editor = editor;
  const plans = suggestionPlans(model);
  assert.equal(suggestionPlans(model), plans, 'suggestions reuse the prepared plans');
  assert.equal(plans.length, items.length);
  assert.equal(plans[0], items[0].options[0], 'completion reuses the existing replacement option');
  assert.equal(source.slice(plans[0].range.start, plans[0].range.end), 'teWRrm', 'completion retains the full pattern range');
  assert.equal(api.applyTextEdits(source, plans[0].edits), api.applyTextEdits(source, items[0].options[0].edits), 'pattern replacement preserves the original candidate result');
  assert.equal(pointer[1], items, 'default highlighting consumes the prepared review list');
  const key = pointer[2];
  publish();
  assert.ok(pointer[2] === key, 'unchanged source publication reuses the same pointer identity');
  // The paired window runs another provider closure but shares the locator's prepared records.
  const peerProviders = new Map(), peer = { ...window, PdfReviewProvider: api, addEventListener() {},
    ReplacementReview: { register(value) { peerProviders.set(value.id, value); return () => {}; } } };
  vm.runInNewContext(providerSource, { window: peer, document: {}, setInterval: () => 0, clearInterval() {} });
  assert.equal(peerProviders.get('pdf-ocr').matchingItems(items[0], context, items), group);
  assert.equal(peer.PdfSelection.locator.reviewLists.get(group).entries, entries);
  target.parts = [{ start: 0, end: target.raw.length, font: { bold: true, italic: true } }];
  target.fontVersion = 1;
  const fontUpdated = (await provider.locator.reviewItems(context)).items;
  assert.notEqual(fontUpdated, items, 'font updates replace the prepared candidate view');
  window.PdfReviewProvider.setFontEnabled(false, 'bold', false);
  const stylesUpdated = (await provider.locator.reviewItems(context)).items;
  assert.notEqual(stylesUpdated, fontUpdated, 'style switches invalidate the view');
  const comparable = values => JSON.stringify(Array.from(values, ({ range, options }) => ({
    range, inlineClassName: options.inlineClassName, before: options.before, hoverMessage: options.hoverMessage })));
  for (const textEnabled of [true, false]) for (const styles of [[], ['italic'], ['bold'], ['italic', 'bold']]) {
    provider.setEnabled(textEnabled);
    window.PdfReviewProvider.setFontEnabled(false, undefined, false);
    for (const style of styles) window.PdfReviewProvider.setFontEnabled(true, style, false);
    const prepared = (await provider.locator.reviewItems(context)).items, data = locator.reviewLists.get(prepared);
    const expected = comparable(index.sourceDecorations(index.reviewCandidates(null, styles, false, textEnabled, [target], data.shared.connections), styles, textEnabled, item => window.PdfReviewProvider.locator.sourceHover(item, model), model));
    const reviewCandidates = index.reviewCandidates, formatDifferences = index.formatDifferences;
    index.reviewCandidates = index.formatDifferences = () => { throw new Error('source highlighting rebuilt prepared candidates'); };
    try {
      listeners.get('pdf-selection-sources')({ detail: { editor, index, targets: [target], enabled: true, diffEnabled: true } });
      assert.equal(comparable(marks), expected, 'prepared source marks preserve text, font, caret and hover output');
    } finally { index.reviewCandidates = reviewCandidates; index.formatDifferences = formatDifferences; }
  }
  provider.setEnabled(false);
  const textDisabled = (await provider.locator.reviewItems(context)).items;
  assert.equal(textDisabled.filter(item => !item.font).length, 0);
  provider.setEnabled(true);
  source = source.replaceAll('WR', 'XX'); version++;
  context.source = source;
  await provider.locator.reviewItems(context);
  assert.notEqual(locator.index, index, 'editing selects a new source snapshot');
  assert.notEqual(locator.reviewLists.get(group).entries[0].index, locator.index,
    'old entries remain attached to their original snapshot rather than being mutated');
  // An older font load may finish after the same model has changed again.
  let finishFonts;
  locator.pdf = null;
  locator.indexFonts = () => new Promise(resolve => { finishFonts = resolve; });
  const pending = locator.reviewItems({ ...context });
  await Promise.resolve();
  assert.equal(typeof finishFonts, 'function');
  source = source.replaceAll('XX', 'YY'); version++;
  const current = locator.reviewItems();
  assert.ok(current.index === locator.index, 'a no-argument review refreshes the class-owned index');
  assert.equal(locator.index.source, source);
  assert.deepEqual(Array.from(locator.index.targets), [target], 'model edits retain the prepared PDF targets');
  finishFonts();
  assert.equal((await pending).items.length, 0, 'obsolete async review does not publish candidates');
  assert.ok(locator.index === current.index, 'obsolete async review cannot restore an older shared index');
});
