import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function engine(directory, before) {
  const window = { document: { createElement: () => ({}) } };
  const diff = readFileSync(`${directory}/pdf-selection-diff.js`, 'utf8');
  const provider = readFileSync(`${directory}/pdf-review-provider.js`, 'utf8');
  const mapping = provider.split('// Source/PDF mapping and candidate generation.')[1]
    .split('// Shared popup and session initialization.')[0];
  vm.runInNewContext(diff + '\n(() => { const toolbox = window.PdfSelectionDiff;'
    + 'const { textDiff, significantText } = toolbox;' + mapping
    + `window.locator = new PdfLocator(); ${before ? 'window.candidates = reviewCandidates;' : ''} })();`, { window });
  return window;
}
const before = engine('tmp/class-cleanup-before', true), after = engine('public/pdfdiff', false);
let seed = 7103;
const random = n => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) % n;
const words = ['Alpha', 'Beta', 'Γάμμα', '劳动', '𠀀', 'Straße', 'fließend', '123'];
function results(api, markup, pdf) {
  const index = api.locator.sourceIndex(markup);
  const target = new api.PdfSelectionDiff.PdfSourceIndex(api.locator, { raw: pdf,
    parts: [{ start: 0, end: pdf.length, font: { bold: true, italic: false, name: 'Test' } }] });
  const pair = index.rememberConnection(0, index.raw.length, target, { start: 0, end: pdf.length });
  const pairs = pair ? [[pair, target]] : [];
  const model = { getPositionAt: offset => ({ lineNumber: 1, column: offset + 1 }) };
  const candidates = api.candidates ? api.candidates(index, [target, target, null]) : index.reviewCandidates([target, target, null]);
  const notice = { html: index.raw, pdf, source: { start: 0, end: index.raw.length } };
  const selected = api.candidates ? api.candidates(index, [], notice) : index.reviewCandidates([], notice);
  return JSON.parse(JSON.stringify({ candidates, selected,
    formats: index.formatDifferences(pairs), decorations: index.sourceDecorations(pairs, model),
    rows: candidates.map(item => api.locator.comparisonRows(item.preview)),
    edited: api.PdfSelectionDiff.previewEdits(markup, candidates.flatMap(item => item.options[0].edits)) }));
}
for (let i = 0; i < 1500; i++) {
  const text = Array.from({ length: 2 + random(15) }, () => words[random(words.length)]).join(i % 3 ? ' ' : '\n');
  const at = random(text.length + 1), stop = Math.min(text.length, at + random(5));
  const pdf = text.slice(0, at) + ['', 'RIGHT', '𠀀', '\n', ' '][random(5)] + text.slice(stop) + '\n';
  const markup = `<p>${i % 2 ? '<i>' + text + '</i>' : text}</p>`;
  assert.deepEqual(results(after, markup, pdf), results(before, markup, pdf), `case ${i}`);
}
console.log('1500 before/after candidate, selection, font, decoration, preview and edit comparisons passed.');
