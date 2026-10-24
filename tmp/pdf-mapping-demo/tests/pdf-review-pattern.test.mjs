import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const diffSource = await readFile(new URL('../pdf-selection-diff.js', import.meta.url), 'utf8');
const fullReviewSource = await readFile(new URL('../pdf-review-provider.js', import.meta.url), 'utf8');
const mappingSource = '(() => {\nconst toolbox = window.PdfSelectionDiff;\nconst { textDiff, significantText, PdfLocator, PdfSourceIndex } = toolbox;\n' + fullReviewSource.split('// Source/PDF mapping and candidate generation.')[1]
  .split('// Shared popup and session initialization.')[0] + '\nwindow.PdfReviewProvider = { PdfLocator, PdfSourceIndex, reviewCandidates };\n})();';
const highlightSource = (await readFile(new URL('../replacement-review.js', import.meta.url), 'utf8'))
  .split('// Shared review popup, session, navigation and saving.')[0];
const providerSource = highlightSource + '\n(() => {\nconst { reviewCandidates } = window.PdfReviewProvider;\n' + fullReviewSource
  .split('// PDF comparison is one review provider. Selection synchronization remains independent.')[1]
  .replace("window.PdfReviewReady = (async () => {", '(() => {')
  .replace(/  (?:if \(!window\.PdfSelectionDiff\)|await window\.PdfSelectionDiff\.loadMonaco|if \(!window\.ReplacementReview).*\r?\n/g, '') + '\n})();';

for (const kind of ['text', 'insertion', 'deletion', 'newline', 'format', 'word', 'term']) {
  test(`same-pattern ${kind} replacement matches the word across different paragraphs`, () => {
    const window = { addEventListener() {}, removeEventListener() {} };
    vm.runInNewContext(diffSource + '\n' + mappingSource, { window });
    const api = Object.assign(window.PdfReviewProvider, window.PdfSelectionDiff), providers = new Map();
    const PdfReviewProvider = api;
    const locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
    api.PdfLocator = window.PdfSelectionDiff.PdfLocator = class { constructor() { return locator; } };
    const format = kind === 'format', whole = kind === 'word' || kind === 'term';
    const old = kind === 'insertion' ? '' : whole ? kind === 'word' ? 'WRONG' : 'wrong term' : 'W';
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
        ...(format ? { text: old, font, htmlFont: index.formats[a] }
          : { comparison: { html: old, pdf: text } }),
        options: [{ id: 'pdf', edits: format ? api.fontEdits(index, a, b, font)
          : kind === 'term' ? [{ start: index.starts[a], end: index.ends[b - 1], expected: old, text }]
            : api.textEdits(index, a, b, text) }] });
      start += paragraph.length + 1;
    }
    locator.prepareSource = current => current.rememberConnection(0, current.raw.length, target, { start: 0, end: target.raw.length });
    locator.prepareSource(index);
    // Candidate discovery after applying edits is outside this matching regression.
    api.reviewCandidates = () => [];
    const editor = { getModel: () => model, getOption: () => false, pushUndoStop() { undoStops++; },
      executeEdits(origin, edits) {
        applications++;
        for (const edit of [...edits].reverse()) source = source.slice(0, edit.range.startColumn - 1)
          + edit.text + source.slice(edit.range.endColumn - 1);
        version++; return true;
      } };
    let highlighted;
    window.PdfSelection = { showReviewPointer(targetEditor, matches) { highlighted = matches; } };
    window.ReplacementReview = { register(provider) { providers.set(provider.id, provider); return () => {}; } };
    vm.runInNewContext(providerSource, { window, document: {}, setInterval: () => 0, clearInterval() {} });
    const provider = providers.get('pdf-ocr'), context = { model, index, targets: [target] };
    provider.onSelect(items[1], context, items);
    assert.deepEqual(Array.from(highlighted, item => item.id), matching.map(String));
    provider.onSelect(items[5], context, items);
    assert.deepEqual(Array.from(highlighted, item => item.id), whole ? matching.map(String) : ['5'],
      'whole words propagate; bare characters do not');
    provider.onSelect(items[1], { editor }, items);
    assert.deepEqual(Array.from(highlighted, item => item.id), ['1'], 'missing context disables propagation');
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
