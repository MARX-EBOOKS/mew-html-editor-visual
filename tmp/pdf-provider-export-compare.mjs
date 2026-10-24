import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const diff = await readFile('public/pdfdiff/pdf-selection-diff.js', 'utf8');
const highlights = (await readFile('public/pdfdiff/replacement-review.js', 'utf8')).split('// Shared review popup, session, navigation and saving.')[0];
async function inspect(file) {
  const events = new Map(), providers = new Map(), disposed = [];
  let interval, intervalCleared = false;
  const window = {
    addEventListener(name, callback) { events.set(name, callback); },
    removeEventListener(name, callback) { if (events.get(name) === callback) events.delete(name); },
    ReplacementReview: { register(provider) { providers.set(provider.id, provider); return () => disposed.push(provider.id); } }
  };
  const sandbox = { window, document: { createElement: () => ({}) },
    localStorage: { getItem: () => null, setItem() {} },
    setInterval(callback) { interval = callback; return 42; },
    clearInterval(id) { assert.equal(id, 42); intervalCleared = true; }, setTimeout };
  vm.createContext(sandbox);
  vm.runInContext(diff + '\n' + highlights, sandbox);
  window.PdfSelectionDiff.loadMonaco = async () => {};
  const globalsBefore = Object.keys(sandbox);
  vm.runInContext(await readFile(file, 'utf8'), sandbox);
  const api = await window.PdfReviewReady;
  assert.equal(api, window.PdfReviewProvider);
  assert.deepEqual(Object.keys(sandbox), globalsBefore, 'helpers stay private');
  const locator = api.createLocator({}, { document: sandbox.document });
  const source = '<p>Some WRONG text.</p>', target = locator.sourceIndex('<p>Some RIGHT text.</p>');
  let value = source, version = 1;
  const model = { getValue: () => value, getVersionId: () => version,
    getPositionAt: offset => ({ lineNumber: 1, column: offset + 1 }) };
  const index = locator.editorSourceIndex(model);
  locator.rememberConnection(index, 0, index.raw.length, target, { start: 0, end: target.raw.length });
  const candidates = api.reviewCandidates(index, [target]);
  assert.ok(candidates.length);
  const provider = providers.get('pdf-ocr');
  const editor = { getModel: () => model, getOption: () => false, pushUndoStop() {},
    executeEdits(origin, edits) { for (const edit of [...edits].reverse()) value = value.slice(0, edit.range.startColumn - 1) + edit.text + value.slice(edit.range.endColumn - 1); version++; return true; } };
  const context = { index, model, targets: [target] };
  const state = { editor, model, source, version, items: candidates, position: 0, context };
  const content = provider.content(state, candidates[0]);
  provider.apply(state, false);
  assert.equal(value, '<p>Some RIGHT text.</p>');
  const result = { exports: Object.keys(api).sort(), providers: [...providers.keys()], raw: index.raw,
    candidates, content, value, events: [...events.keys()].sort() };
  interval();
  events.get('pagehide')();
  assert.ok(intervalCleared);
  assert.equal(disposed.length, 4);
  assert.equal(events.size, 1, 'only the once-used pagehide callback remains in the stub');
  return JSON.parse(JSON.stringify(result));
}
assert.deepEqual(await inspect('public/pdfdiff/pdf-review-provider.js'), await inspect('tmp/pdf-provider-export-before.js'));
console.log('Full-script comparison passed: readiness, private scope, exports, provider registration, mapping, candidates, content, replacement and cleanup.');
