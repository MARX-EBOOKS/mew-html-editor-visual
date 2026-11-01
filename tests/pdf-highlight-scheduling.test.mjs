import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';
import { engine, locator } from './support/pdf-harness.mjs';

const source = await readFile(new URL('../public/pdfdiff/pdf-selection.js', import.meta.url), 'utf8');
const start = source.indexOf('  function queueWarm('), end = source.indexOf('  function warm(', start);
assert.ok(start >= 0 && end > start);
function scheduler(interaction = 0, edit = -Infinity) {
  const state = { now: 1000, calls: [], tasks: [], stopped: false, diffHighlight: true, sourceDiffHighlight: true, selectionHighlight: true,
    lastInteraction: interaction, lastEdit: edit, editIdleDelay: 350, preparationPages: new Set(), preparationTask: null,
    contexts: [], reviewPointer: null, visiblePages: () => [2,3], schedule() {},
    performance: { now: () => state.now }, warm: numbers => state.calls.push(numbers),
    setTimeout: (run, delay) => { state.tasks.push({ run, delay }); return state.tasks.length; } };
  vm.runInNewContext(source.slice(start, end), state);
  return state;
}

test('idle highlight preparation runs on the next task and coalesces pages', () => {
  const state = scheduler();
  state.queueWarm(); state.queueWarm(4); state.queueWarm(4);
  assert.equal(state.tasks.length, 1);
  assert.equal(state.tasks[0].delay, 0);
  state.tasks[0].run();
  assert.deepEqual(Array.from(state.calls[0]), [4,2,3]);
});

test('highlight preparation retains interaction and editing idle guards', () => {
  for (const [interaction, edit, delay] of [[980,-Infinity,80],[0,900,250],[980,990,340]]) {
    const state = scheduler(interaction, edit);
    state.queueWarm(2);
    assert.equal(state.tasks[0].delay, delay);
    state.now += delay - 1; state.tasks[0].run();
    assert.equal(state.calls.length, 0, 'never prepare before idle');
    state.now++; state.tasks[1].run();
    assert.deepEqual(Array.from(state.calls[0]), [2]);
  }
});

test('stopped and fully disabled highlight preparation does not schedule work', () => {
  for (const flags of [{ stopped:true }, { diffHighlight:false, sourceDiffHighlight:false, selectionHighlight:false }]) {
    const state = Object.assign(scheduler(), flags);
    state.queueWarm(2);
    assert.equal(state.tasks.length, 0);
  }
});

test('disabled selection linkage suppresses source highlighting preparation', () => {
  const state = Object.assign(scheduler(), { diffHighlight: false, selectionHighlight: false });
  state.queueWarm(2);
  assert.equal(state.tasks.length, 0);
});

test('queued preparation stops when selection linkage is disabled', () => {
  const state = scheduler();
  state.queueWarm(2);
  state.selectionHighlight = false;
  state.tasks[0].run();
  assert.equal(state.calls.length, 0);
});

test('PDF and source highlight switches persist independently and clear only PDF pointers', () => {
  const state = { diffHighlight: true, sourceDiffHighlight: true, defaultPointer: {}, diffButton: null,
    reviewPointer: null, review: { clearHighlights() { state.cleared++; } },
    writes: [], cleared: 0, published: [], savePreference(key, value) { state.writes.push([key, value]); },
    publishSources() { state.published.push([state.diffHighlight, state.sourceDiffHighlight]); }, queueWarm() {} };
  vm.runInNewContext(`this.api = { clearReviewPointer() { cleared++; },
    ${section('    setDiffHighlight(', '    setSelectionHighlight(')}
  };`, state);
  state.api.setDiffHighlight(false, 'source');
  assert.equal(state.cleared, 0);
  assert.ok(state.defaultPointer);
  state.api.setDiffHighlight(false);
  assert.equal(state.cleared, 1);
  assert.equal(state.defaultPointer, null);
  state.api.setDiffHighlight(true, 'source');
  assert.deepEqual(state.published, [[true, false], [false, false], [false, true]]);
  assert.deepEqual(state.writes, [['sourceDiffHighlight', false], ['diffHighlight', false], ['sourceDiffHighlight', true]]);
});

function section(from, to) {
  const start = source.indexOf(from), end = source.indexOf(to, start);
  assert.ok(start >= 0 && end > start);
  return source.slice(start, end);
}
test('PDF selection chrome keeps the OCR index while content and font changes invalidate it', () => {
  const layer = { textContent: 'OCR' }, sentinel = { textContent: '' }, span = { textContent: 'word' }, div = {};
  const state = { layers: new Map() };
  vm.runInNewContext(section('  function clearLayer(div,', '  function currentPointer('), state);
  const invalidate = records => {
    state.layers.set(div, { layer, observer: { disconnect() {} } });
    return state.clearLayer(div, records);
  };
  const change = (target, addedNodes = [], removedNodes = []) => ({ type: 'childList', target, addedNodes, removedNodes });
  assert.equal(invalidate([change(layer, [sentinel], [sentinel]),
    { type: 'attributes', target: layer }, { type: 'attributes', target: sentinel }]), false);
  for (const record of [change(layer, [span]), change(layer, [], [span]),
    { type: 'characterData', target: { textContent: '' } }, { type: 'attributes', target: span }])
    assert.equal(invalidate([record]), true);
});
function pointers(items = [{ sourceStart: 0, sourceEnd: 1 }]) {
  const model = { getVersionId: () => 1 }, editor = { getModel: () => model }, pdf = {};
  const index = { raw: 'abcdef', connectionPairs: () => [], reviewCandidates: () => items, formatDifferences: () => [] };
  const state = {
    ...scheduler(), viewer: { pdfDocument: pdf }, activeEditor: editor, layers: new Map(),
    defaultPointer: null, reviewPointer: null, revision: 0, timer: null,
    contexts: [{}], locationSearch: { pdf, locations: [] }, visiblePages: () => [],
    locator: { getDocumentIndex: () => null, editorSourceIndex: () => index, environment: { getTargets: () => [] } },
    review: { clearHighlights() {} }, window: { dispatchEvent() {} }, CustomEvent: class {},
    clearTimeout() {}, report() {},
    findLocations(pdf, entries, visibleOnly) { state.painted = entries; state.visibleOnly = visibleOnly; return []; }
  };
  vm.runInNewContext(`const api = {
    ${section('    showReviewPointer(', '    setDiffHighlight(')}
  }; this.api = api;
  ${section('  function currentPointer(', '  function resetPdf(')}
  ${section('  function schedule(', '  function attachEditor(')}
  ${section('  function publishSources(', '  async function discoverPdf(')}
  ${section('  async function refreshReviewPointer(', '  function publishDifferences(')}
  ${section('  async function refresh(run)', '\n})().catch')}`, state);
  return state;
}

test('source publication caches populated and empty pointers before deferred refresh', async () => {
  for (const items of [[{ sourceStart: 0, sourceEnd: 1 }], []]) {
    const state = pointers(items);
    state.publishSources();
    assert.equal(state.tasks.length, 1, 'publication must not synchronously re-enter refresh');
    assert.equal(state.defaultPointer.entries.length, items.length);
    await state.tasks[0].run();
    assert.equal(state.tasks.length, 1, 'unchanged publication must not keep scheduling itself');
  }
});

test('explicit review pointers override the default and closing restores it', async () => {
  const state = pointers();
  state.publishSources();
  const fallback = state.defaultPointer;
  state.api.showReviewPointer(state.activeEditor, [{ sourceStart: 3, sourceEnd: 5 }]);
  await state.refreshReviewPointer();
  assert.equal(state.painted[0].text, 'de');
  assert.equal(state.visibleOnly, false, 'explicit pointers retain whole-document lookup');
  assert.equal(state.defaultPointer, fallback);
  state.api.clearReviewPointer(state.activeEditor);
  await state.refreshReviewPointer();
  assert.equal(state.painted[0].text, 'a');
  assert.equal(state.visibleOnly, true, 'default pointers must not wait for offscreen pages');
  state.viewer = { pdfDocument: {} };
  await state.refreshReviewPointer();
  assert.equal(state.defaultPointer, null, 'a pointer for the previous PDF must be discarded');
  assert.equal(state.reviewPointer, null);
});

test('visible-only pointers return available locations without extracting the volume', async () => {
  const pdf = {}, diff = locator({}, { getVisiblePages: () => [] });
  let reads = 0;
  diff.indexDocument = async () => { reads++; return null; };
  const entries = [{ text: 'offscreen passage', before: '', after: '' }];
  const locations = diff.findLocations(pdf, entries, true);
  assert.ok(Array.isArray(locations), 'painting visible pointers stays synchronous');
  assert.equal(locations[0].targets.length, 0);
  assert.equal(reads, 0);
  await diff.findLocations(pdf, entries);
  assert.equal(reads, 1, 'explicit searches retain full-document fallback');
  diff.getDocumentIndex = () => ({ locate() { throw new Error('visible-only lookup searched offscreen text'); } });
  assert.equal(diff.findLocations(pdf, entries, true)[0].targets.length, 0,
    'an already indexed volume must not redirect a default highlight');
});

test('clicking a diff mark stays on the current PDF page while ordinary selections can navigate', async () => {
  for (const marked of [true, false]) {
    const state = {
      contexts: [{ marked }], viewer: { pdfDocument: {}, getPageView: () => null,
        scrollPageIntoView: () => { state.jumps++; } },
      stopped: false, revision: 1, locationSearch: null, positioned: false, scrolled: false, jumps: 0,
      report() {}, publishSources() {}, visiblePages: () => [], review: { clearHighlights() {} },
      findLocations(pdf, entries, visibleOnly) {
        state.visibleOnly = visibleOnly;
        return [{ targets: [{ pageNumber: 999 }] }];
      }
    };
    vm.runInNewContext(section('  async function refresh(run)', '\n})().catch'), state);
    await state.refresh(1);
    assert.equal(state.visibleOnly, marked);
    assert.equal(state.jumps, marked ? 0 : 1);
  }
});

test('highlight preparation and visible-page lookup tolerate an unattached PDF', () => {
  for (const viewer of [null, { pdfDocument: null }]) {
    const state = Object.assign(pointers(), { viewer });
    vm.runInNewContext(section('  function visiblePages(', '  function layerIndex(')
      + section('  function warm(', '  function publishSources('), state);
    assert.equal(state.visiblePages().length, 0);
    assert.doesNotThrow(() => state.warm());
    assert.doesNotThrow(() => state.warm([1]));
    state.publishSources();
    state.api.showReviewPointer(state.activeEditor, [{ sourceStart: 0, sourceEnd: 1 }]);
    assert.equal(state.tasks.length, 0, 'an editor without a PDF must not start pointer mapping');
  }
});

test('empty source ranges remain collapsed across tags and at document boundaries', () => {
  const index = locator().sourceIndex('<p>one</p><p>two</p>');
  const model = { getPositionAt: offset => ({ lineNumber: 1, column: offset + 1 }) };
  for (let at = 0; at <= index.raw.length; at++) {
    const range = engine().rangeAt(model, index.starts[at] ?? index.source.length,
      index.starts[at] ?? index.source.length);
    assert.equal(range.startColumn, range.endColumn);
  }
  const range = engine().rangeAt(model, index.starts[4] ?? index.source.length,
    (7 > 4 ? index.ends[(7) - 1] : index.starts[4]) ?? index.source.length);
  assert.equal(range.startColumn, 14);
  assert.equal(range.endColumn, 17);
});
