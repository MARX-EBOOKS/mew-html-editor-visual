import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';

import { diffSource, mappingSource, providerSource } from './support/pdf-harness.mjs';

test('selection popup candidates keep matching fragments inside the same word context', async () => {
  const providers = new Map(), pdf = {};
  const window = { addEventListener() {}, removeEventListener() {} };
  vm.runInNewContext(diffSource + '\n' + mappingSource, { window });
  const api = Object.assign(window.PdfReviewProvider, window.PdfSelectionDiff);
  const locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
  const source = '<p>First teWRrm here.</p><p>Other teWRrm there.</p><p>otWRrm teWRrd WR</p>';
  const model = { getValue: () => source, getVersionId: () => 1,
    getPositionAt: offset => ({ lineNumber: 1, column: offset + 1 }),
    getOffsetAt: position => position.column - 1,
    getValueInRange: range => source.slice(range.startColumn - 1, range.endColumn - 1),
    findMatches: query => [...source.matchAll(new RegExp(query, 'g'))].map(match => ({
      range: api.rangeAt(model, match.index, match.index + query.length)
    })) };
  const index = locator.editorSourceIndex(model);
  const target = new api.PdfSourceIndex(locator, { raw: index.raw.replaceAll('WR', 'R'), parts: [] });
  index.rememberConnection(0, index.raw.length, target, { start: 0, end: target.raw.length });
  const start = index.raw.indexOf('WR');
  const notice = { html: 'WR', pdf: 'R', source: { index, start, end: start + 2 } };
  window.ReaderUI = { getPdfViewer: () => ({ pdfDocument: pdf }) };
  window.PdfSelection = { locator };
  window.ReplacementReview = { register(provider) { providers.set(provider.id, provider); return () => {}; } };
  vm.runInNewContext(providerSource, { window, document: {}, setInterval: () => 0, clearInterval() {} });
  const provider = providers.get('pdf-ocr'), context = { model, source, request: { pdf, notice, targets: [target] } };
  const items = await provider.provide(context);
  const selections = items.filter(item => item.selection);
  assert.deepEqual(Array.from(selections, item => item.sourceStart), [start, index.raw.indexOf('WR', start + 2)],
    'popup selection expansion excludes other prefixes, suffixes and standalone fragments');
  assert.deepEqual(Array.from(provider.matchingItems(selections[0], context, items), item => item.id),
    Array.from(selections, item => item.id), 'popup, preview and replacement share the group');
  const foreign = { ...selections[0], pdfSource: { index: target, start, end: start + 2 } };
  assert.deepEqual(Array.from(provider.matchingItems(selections[0], context, [...items, foreign]), item => item.id),
    Array.from(selections, item => item.id), 'another source index cannot join the group');
});

for (const pdfWord of ['Ge-\nsinnung', 'Gesin nung', 'Ge-\nsinnnng']) {
  test(`ME08-284 opens the clicked italic fault, with text taking priority only for real changes: ${JSON.stringify(pdfWord)}`, async () => {
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
    index.rememberConnection(0, index.raw.length, target, { start: 0, end: target.raw.length });
    const model = { getValue: () => source, getVersionId: () => 1,
      getPositionAt: offset => ({ lineNumber: 1, column: offset + 1 }) };
    const editor = { getModel: () => model, getDomNode: () => ({ ownerDocument: { defaultView: window } }) };
    let opened;
    window.ReaderUI = { getPdfViewer: () => ({ pdfDocument: pdf }) };
    window.PdfSelection = { locator };
    window.ReplacementReview = {
      register(provider) { providers.set(provider.id, provider); return () => {}; },
      isOpenFor: () => false,
      openForSelection(...args) { opened = args; }
    };
    vm.runInNewContext(providerSource, { window, document: {}, setInterval: () => 0, clearInterval() {} });
    const notice = { html: 'Gesinnung', pdf: pdfWord, source: { index, start: 0, end: wordEnd },
      target: { index: target, start: 0, end: pdfWord.length } };
    listeners.get('pdf-selection-difference')({ detail: { editor, model, pdf, notices: [notice], targets: [target] } });
    assert.ok(opened);
    const [id, , focusId, request] = opened, realTextChange = pdfWord.includes('sinnnng');
    assert.equal(id, 'pdf-ocr');
    assert.equal(focusId, realTextChange ? `0:${wordEnd}` : `font:0:${wordEnd}`);
    assert.equal(request.kind, realTextChange ? undefined : 'font');
    const items = await providers.get(id).provide({ model, source, request });
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
  });
}

for (const kind of ['text', 'insertion', 'deletion', 'newline', 'format', 'word', 'term', 'selection']) {
  test(`same-pattern ${kind} replacement matches the word across different paragraphs`, () => {
    const window = { addEventListener() {}, removeEventListener() {} };
    vm.runInNewContext(diffSource + '\n' + mappingSource, { window });
    const api = Object.assign(window.PdfReviewProvider, window.PdfSelectionDiff), providers = new Map();
    const PdfReviewProvider = api;
    const locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
    api.PdfLocator = class { constructor() { return locator; } };
    const format = kind === 'format', whole = kind === 'word' || kind === 'term';
    const old = kind === 'insertion' ? '' : whole ? kind === 'word' ? 'WRONG' : 'wrong term' : kind === 'selection' ? 'WR' : 'W';
    const replacement = kind === 'deletion' ? '' : kind === 'newline' ? '\n' : kind === 'term' ? 'right term' : 'R';
    const prefix = whole ? '' : 'te', suffix = whole ? '' : 'rm';
    const tokens = [prefix + old + suffix, prefix + old + suffix, 'ot' + old + suffix,
      prefix + old + 'rd', prefix + old + suffix, old, old];
    const paragraphs = tokens.map((token, at) => at < 5
      ? `${at === 1 ? 'Different' : 'Before𠀀'} ${token} ${at === 1 ? 'elsewhere.' : 'after.'}` : token);
    const matching = whole ? [0, 1, 5, 6] : [0, 1];
    let source = paragraphs.map(text => `<p>${text}</p>`).join(''), version = 1, applications = 0, undoStops = 0;
    const model = { getValue: () => source, getVersionId: () => version,
      getPositionAt: offset => ({ lineNumber: 1, column: offset + 1 }) };
    const index = locator.editorSourceIndex(model), target = new PdfReviewProvider.PdfSourceIndex(new PdfReviewProvider.PdfLocator(), { raw: index.raw, parts: [] });
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
    locator.prepareSource = current => current.rememberConnection(0, current.raw.length, target, { start: 0, end: target.raw.length });
    locator.prepareSource(index);
    // Candidate discovery after applying edits is outside this matching regression.
    api.PdfSourceIndex.prototype.reviewCandidates = () => [];
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
    window.PdfSelection = { showReviewPointer(targetEditor, matches) { highlighted = matches; },
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
    provider.apply({ editor, model, source, version, items, position: 1, context,
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
