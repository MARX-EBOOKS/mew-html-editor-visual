import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';
import { chromium } from 'playwright';

const baseline = process.argv.includes('--baseline');
const reviewFile = await readFile(new URL(baseline ? './pdf-review-provider.js.carry-before' : '../public/pdfdiff/pdf-review-provider.js', import.meta.url), 'utf8');
const mappingSection = reviewFile.slice(reviewFile.indexOf('// Source/PDF mapping and candidate generation.'),
  reviewFile.indexOf('// Shared popup and session initialization.'));
const selectionFile = await readFile(new URL('../public/pdfdiff/pdf-selection.js', import.meta.url), 'utf8');
const selectionMapping = selectionFile.slice(selectionFile.indexOf('  function findLocations('),
  selectionFile.indexOf('  function nativeBoxes('))
  .replace('visiblePages().map(number => ({ number, index: layerIndex(viewer.getPageView(number - 1)?.div) }))',
    'environment.getVisiblePages?.() || []')
  .replace('viewer?.pdfDocument', 'environment.getPdf?.()');
const mappingSource = '(() => {\nconst toolbox = window.PdfSelectionDiff;\nconst { textDiff, significantText } = toolbox;\n' + mappingSection + '\nwindow.PdfReviewProvider = { PdfLocator, PdfSourceIndex, reviewCandidates };\n})();';
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
const popupSource = await readFile(new URL('../public/pdfdiff/replacement-review.js', import.meta.url), 'utf8');
const fullReviewSource = popupSource + '\n' + reviewFile;
const fullProviderSource = fullReviewSource;
const diffSource = await readFile(new URL('../public/pdfdiff/pdf-selection-diff.js', import.meta.url), 'utf8');
const engineSource = diffSource + '\n' + selectionMappingSource;
const highlightSource = popupSource.split('// Shared review popup, session, navigation and saving.')[0];
const providerSource = highlightSource + '\n(() => {\nconst { PdfLocator, PdfSourceIndex, reviewCandidates } = window.PdfReviewProvider;\n' + reviewFile
  .split('// PDF comparison is one review provider. Selection synchronization remains independent.')[1]
  .replace('    PdfLocator, PdfSourceIndex,', '    PdfLocator, PdfSourceIndex, sourceDecorations,')
  .replace("window.PdfReviewReady = (async () => {", '(() => {')
  .replace(/  (?:if \(!window\.PdfSelectionDiff\)|await window\.PdfSelectionDiff\.loadMonaco|if \(!window\.ReplacementReview).*\r?\n/g, '') + '\n})();';
const source = `if (!window.PdfReviewProvider?.measureHighlights) { ${fullReviewSource} }` + `
window.lastNotice = null;
window.addEventListener('pdf-selection-difference', event => { window.lastNotice = event.detail; });
window.addEventListener('pdf-selection-highlight-status', event => { if (event.detail.mode === null) window.lastNotice = null; });
` + await readFile(new URL('../public/pdfdiff/pdf-selection.js', import.meta.url), 'utf8');
const readerMenu = (await readFile(new URL('../public/reader.html', import.meta.url), 'utf8')).match(/<button id="diffHighlightBtn".*?<\/button>/)[0];
function engine() {
  const window = {};
  vm.runInNewContext(engineSource, { window });
  return Object.assign(window.PdfSelectionDiff, window.PdfReviewProvider);
}
const PdfReviewProvider = engine();
function reviewProvider(api, providers = new Map(), selection, document = {}) {
  const window = { PdfSelection: selection, PdfSelectionDiff: api, PdfReviewProvider: api, ReplacementReview: { register: provider => { providers.set(provider.id, provider); return () => {}; } },
    addEventListener() {}, removeEventListener() {} };
  vm.runInNewContext(providerSource, { window, document, setInterval: () => 0, clearInterval() {} });
  return window.PdfReviewProvider;
}


const api = engine(), original = api.textDiff;
let calls = 0;
api.textDiff = (...args) => { calls++; return original(...args); };
const locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
let previewCalls = 0, candidates = 0;
for (const [html, pdf] of [['before WRONG after', 'before RIGHT after'], ['prefix extra suffix', 'prefix suffix'], ['prefix suffix', 'prefix new suffix'], ['A𠀀B C', 'A𠀁B C'], ['one WRONG middle BAD end', 'one RIGHT middle GOOD end']]) {
  const source = locator.sourceIndex(html), target = locator.sourceIndex(pdf);
  source.rememberConnection(0, source.raw.length, target, { start: 0, end: target.raw.length });
  const items = api.reviewCandidates(source, [target]);
  assert.ok(items.length);
  for (const item of items) {
    const before = calls;
    const rows = locator.comparisonRows(item.preview, false);
    assert.equal(rows[0].parts.map(part => part.text).join(''), item.preview.html);
    assert.equal(rows[1].parts.map(part => part.text).join(''), item.preview.pdf);
    previewCalls += calls - before; candidates++;
  }
}
const value = { html: 'WRONG', pdf: 'RIGHT' };
const before = calls;
const parts = locator.comparisonParts(value);
for (let i = 0; i < 100; i++) assert.deepEqual(locator.comparisonParts({ ...value }), parts);
const copyCalls = calls - before;
value.html = 'NEW'; locator.comparisonParts(value);
value.pdf = 'OTHER'; locator.comparisonParts(value);
assert.equal(calls - before, copyCalls + 2, 'both readings invalidate cached parts');
console.log(JSON.stringify({ baseline, candidates, previewDiffCalls: previewCalls, noticeCopyDiffCalls: copyCalls }));
if (!baseline) { assert.equal(previewCalls, 0); assert.equal(copyCalls, 1); }
