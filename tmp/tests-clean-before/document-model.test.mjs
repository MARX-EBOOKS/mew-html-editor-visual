import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';

const sources = await Promise.all(['app.js', 'reader-app.js'].map(async name => {
  const source = (await readFile(new URL(`../public/${name}`, import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
  const match = source.match(/^( *)class DocumentModel \{[\s\S]*?\n\1\}/m);
  return match[0].split('\n').map(line => line.slice(match[1].length)).join('\n');
}));
// The reader copy is nested two spaces deeper; compare normalized lines.
test('both independent scripts embed the same class', () => {
  assert.equal(sources[0], sources[1]);
});
const Model = vm.runInNewContext(`${sources[0]}; DocumentModel`);
const defer = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test('undo/redo preserves snapshots and dirty follows the saved text', async () => {
  const d = new Model({ text: 'a', write: async () => ({ mtime: 2 }) });
  d.remember({ text: 'a', start: 1, end: 1, scroll: { top: 42 } });
  d.update('ab');
  assert.equal(d.dirty, true);
  assert.equal(d.undo({ text: 'ab', start: 2, end: 2 }).scroll.top, 42);
  assert.equal(d.content, 'a');
  assert.equal(d.dirty, false);
  d.redo({ text: 'a', start: 1, end: 1 });
  await d.save();
  d.undo({ text: 'ab', start: 2, end: 2 });
  assert.equal(d.dirty, true);
  d.remember({ text: 'a', start: 1, end: 1 });
  d.update('ac');
  assert.equal(d.redoStack.length, 0);
});

test('queued saves use the latest acknowledged mtime and preserve newer edits', async () => {
  const gate = defer(), started = defer(), writes = [];
  const d = new Model({ text: 'a', mtime: 1, write: async snapshot => {
    writes.push(snapshot); started.resolve();
    if (writes.length === 1) await gate.promise;
    return { mtime: writes.length + 1 };
  } });
  d.update('b'); const first = d.save(); await started.promise;
  d.update('c'); const second = d.save(); d.update('d');
  gate.resolve(); await Promise.all([first, second]);
  assert.deepEqual(writes.map(s => [s.text, s.mtime]), [['b', 1], ['c', 2]]);
  assert.equal(d.savedContent, 'c'); assert.equal(d.content, 'd'); assert.equal(d.dirty, true);
  await d.saveUntilClean(); assert.equal(d.savedContent, 'd'); assert.equal(d.dirty, false);
});

test('saveUntilClean drains edits made during a save, failed requests can retry', async () => {
  const gate = defer(), started = defer(); let count = 0;
  const d = new Model({ text: 'a', write: async () => {
    count++; if (count === 1) { started.resolve(); await gate.promise; }
    if (count === 3) throw new Error('409 conflict');
    return { mtime: count };
  } });
  d.update('b'); const saving = d.saveUntilClean(); await started.promise;
  d.update('c'); gate.resolve(); await saving;
  assert.equal(count, 2); assert.equal(d.dirty, false);
  d.update('d'); await assert.rejects(d.save(), /409/);
  assert.equal(d.savedContent, 'c'); assert.equal(d.dirty, true);
  await d.save(); assert.equal(d.dirty, false);
});

test('disk refresh preserves local edits and conflict version; clean reload clears history', async () => {
  let disk = { text: 'external', mtime: 2 };
  const d = new Model({ text: 'a', mtime: 1, read: async () => disk });
  d.remember({ text: 'a' }); d.update('local');
  assert.equal(await d.refresh(), 'conflict');
  assert.equal(d.content, 'local'); assert.equal(d.mtime, 1); assert.equal(d.undoStack.length, 1);
  d.update('a'); assert.equal(await d.refresh(), 'updated');
  assert.equal(d.content, 'external'); assert.equal(d.undoStack.length, 0);
  d.update('same'); disk = { text: 'same', mtime: 3 };
  assert.equal(await d.refresh(), 'saved'); assert.equal(d.dirty, false);
  disk = { text: 'same', mtime: 4 }; d.update('new local');
  assert.equal(await d.refresh(), 'unchanged'); assert.equal(d.dirty, true); assert.equal(d.mtime, 4);
});

test('editing during a pending read is retained; read-only writes reject', async () => {
  const gate = defer(), started = defer();
  const d = new Model({ text: 'a', read: async () => { started.resolve(); return gate.promise; } });
  const refreshing = d.refresh(); await started.promise;
  d.update('local'); gate.resolve({ text: 'disk', mtime: 2 });
  assert.equal(await refreshing, 'conflict'); assert.equal(d.content, 'local');
  const remote = new Model({ text: 'remote', editable: false }); remote.update('edit');
  await assert.rejects(remote.saveUntilClean(), /read-only/);
});

test('a save queued behind a reload cannot overwrite the newly read disk content', async () => {
  const gate = defer(), started = defer(); let writes = 0;
  const d = new Model({ text: 'old', mtime: 1,
    read: async () => { started.resolve(); return gate.promise; },
    write: async () => { writes++; return { mtime: 3 }; }
  });
  const refreshing = d.refresh(); await started.promise;
  const saving = d.save();
  gate.resolve({ text: 'external', mtime: 2 });
  await refreshing; await assert.rejects(saving, /reloaded/);
  assert.equal(d.content, 'external'); assert.equal(writes, 0);
  await d.save(); assert.equal(writes, 1);
});
