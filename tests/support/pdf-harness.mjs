import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const reviewFile = await readFile(new URL('../../public/pdfdiff/pdf-review-provider.js', import.meta.url), 'utf8');
// Fail at setup when production boundaries move instead of evaluating an empty adapter.
function section(source, start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, `PDF test adapter needs updated boundaries: ${start}`);
  return source.slice(a, b);
}
const preparationEntry = section(reviewFile, '  prepareReview(context = {}) {', '  reviewItems(context = this.reviewRequest || {}) {').trim();
const reviewEntry = section(reviewFile, '  reviewItems(context = this.reviewRequest || {}) {', '  comparisonParts(value, parts) {').trim();
const mappingSection = section(reviewFile, '// Source/PDF mapping and candidate generation.',
  '// Shared popup and session initialization.').replace(preparationEntry, '').replace(reviewEntry, '');
const selectionFile = await readFile(new URL('../../public/pdfdiff/pdf-selection.js', import.meta.url), 'utf8');
const selectionMapping = section(selectionFile, '  function findLocations(', '  function nativeBoxes(')
  .replace('visiblePages().map(number => ({ number, index: layerIndex(viewer.getPageView(number - 1)?.div) }))',
    'environment.getVisiblePages?.() || []')
  .replace('viewer?.pdfDocument', 'environment.getPdf?.()')
  .replaceAll('review.locator', 'locator');
const mappingSource = '(() => {\n' + mappingSection + '\nwindow.PdfReviewProvider = { PdfLocator };\n})();';
// Attach the private selection helpers while retaining the production locator class.
const selectionMappingSource = mappingSource.replace('window.PdfReviewProvider =', `class SelectionLocator extends PdfLocator {
  constructor(options = {}, environment = {}) {
    super(options, environment);
    const locator = this;
    ${selectionMapping}
    Object.assign(this, { findLocations, locateSource, locateLayer });
  }
}
window.PdfReviewProvider =`).replace('{ PdfLocator };', '{ PdfLocator: SelectionLocator };');
const popupSource = await readFile(new URL('../../public/pdfdiff/replacement-review.js', import.meta.url), 'utf8');
const fullReviewSource = popupSource + '\n' + reviewFile;
const textEditFixture = `
window.PdfSelectionDiff.applyTextEdits = function(source, edits) {
  return this.validateEdits(source, edits).reduceRight((text, edit) => text.slice(0, edit.start) + edit.text + text.slice(edit.end), source);
};`;
const diffSource = await readFile(new URL('../../public/pdfdiff/pdf-selection-diff.js', import.meta.url), 'utf8') + textEditFixture;
const engineSource = diffSource + '\n' + selectionMappingSource;
const highlightSource = popupSource.split('// Shared review popup, session, navigation and saving.')[0];
const providerSource = highlightSource + '\n(() => {\nconst { PdfLocator } = window.PdfReviewProvider;\n' + reviewFile
  .split('// PDF comparison is one review provider. Selection synchronization remains independent.')[1]
  .replace('function presentation(context, item) {', `PdfLocator.prototype.prepareReview ||= function ${preparationEntry};\nPdfLocator.prototype.reviewItems ||= function ${reviewEntry};\nfunction presentation(context, item) {`)
  .replace("window.PdfReviewReady = (async () => {", '(() => {')
  .replace(/  (?:if \(!window\.PdfSelectionDiff\)|await window\.PdfSelectionDiff\.ready|if \(!window\.ReplacementReview).*\r?\n/g, '') + '\n})();';
const selectionSource = `
window.lastNotice = null;
window.addEventListener('pdf-selection-difference', event => { window.lastNotice = event.detail; });
window.addEventListener('pdf-selection-highlight-status', event => { if (event.detail.mode === null) window.lastNotice = null; });
` + selectionFile;
const source = `if (!window.PdfReviewProvider?.highlights) { ${fullReviewSource} }` + selectionSource;
const highlightSelectionSource = fullReviewSource + selectionSource;
const readerMenu = (await readFile(new URL('../../public/reader.html', import.meta.url), 'utf8')).match(/<button id="diffHighlightBtn".*?<\/button>/)[0];
function engine() {
  const window = {};
  vm.runInNewContext(engineSource, { window });
  return Object.assign(window.PdfSelectionDiff, window.PdfReviewProvider);
}
function reviewProvider(api, providers = new Map(), selection, document = {}) {
  const window = { PdfSelection: selection, PdfSelectionDiff: api, PdfReviewProvider: api, ReplacementReview: { register: provider => { providers.set(provider.id, provider); return () => {}; } },
    addEventListener() {}, removeEventListener() {} };
  vm.runInNewContext(providerSource, { window, document, setInterval: () => 0, clearInterval() {} });
  return window.PdfReviewProvider;
}

const countedEngineSource = engineSource.replace('function textDiff(left, right, details = false, limit = Infinity) {',
  '$& window.diffCalls = (window.diffCalls || 0) + 1;');
function locator(options = {}, environment = {}, script = engineSource, globals = {}) {
  const window = { document: { createElement: () => ({}) } };
  vm.runInNewContext(script, { window, ...globals });
  return new window.PdfReviewProvider.PdfLocator(options, environment);
}
export { textEditFixture, reviewFile, popupSource, diffSource, mappingSource, engineSource, highlightSource,
  providerSource, fullReviewSource, fullReviewSource as fullProviderSource, source, readerMenu,
  countedEngineSource, engine, locator, reviewProvider, highlightSelectionSource };
