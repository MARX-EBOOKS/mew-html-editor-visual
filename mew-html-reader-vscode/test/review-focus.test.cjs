const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function fixture() {
  const commands = new Map(), messages = [], calls = [], listeners = {};
  const disposable = { dispose() {} };
  const range = { contains: () => true, intersection: () => range, union: () => range };
  const document = { uri: 'source.html', version: 1 };
  const editor = { document, viewColumn: 2, selection: { isEmpty: true, active: {} } };
  const panel = {
    active: true,
    reveal() { panel.active = true; calls.push('pdf'); },
    onDidDispose() {},
    webview: {
      onDidReceiveMessage(callback) { listeners.message = callback; return disposable; },
      async postMessage(message) { messages.push(message); return true; }
    }
  };
  const reader = { panel, focusRevision: 0, report(error) { throw error; } };
  const source = {
    async document() { return document; },
    editors: () => [editor], range: () => range,
    async publish() {}, async snapshot() { return { layout: { sourceViewColumn: 2 } }; }
  };
  const vscode = {
    MarkdownString: class { constructor(value) { this.value = value; } },
    CodeActionKind: { QuickFix: 'quickfix' },
    TextEditorSelectionChangeKind: { Mouse: 1, Keyboard: 2, Command: 3 },
    workspace: { registerTextDocumentContentProvider: () => disposable },
    languages: {
      registerHoverProvider: () => disposable,
      registerCodeActionsProvider: () => disposable,
      registerCompletionItemProvider: () => disposable
    },
    commands: {
      registerCommand(id, callback) { commands.set(id, callback); return disposable; },
      async executeCommand(id, options) { calls.push([id, options]); }
    },
    window: {
      activeTextEditor: editor,
      onDidChangeActiveTextEditor: () => disposable,
      onDidChangeTextEditorSelection(callback) { listeners.selection = callback; return disposable; },
      async showTextDocument(doc, options) {
        assert.equal(doc, document);
        assert.equal(options.viewColumn, 2);
        panel.active = false; calls.push('html'); return editor;
      }
    }
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(require.resolve('../pdfdiff/replacement-review.js'), 'utf8'), {
    module, require: name => name === 'vscode' ? vscode : require('../reader-core.cjs')
  });
  module.exports.attach(reader, panel, source, async () => { calls.push('window'); });
  return { reader, panel, source, editor, vscode, calls, messages,
    hover: focus => listeners.message({ type: 'reviewHover', uri: 'source.html', version: 1, range: {}, hover: ['PDF:'], focus }),
    pdf: save => commands.get('mewReader:mew.pdf-difference')({ model: 'source.html', version: 1, save }),
    selection: kind => listeners.selection({ textEditor: editor, kind }) };
}

test('HTML handoff shows its hover; PDF handoff focuses before dispatching popup work', async () => {
  const f = fixture();
  f.hover(true); await tick();
  assert.equal(f.calls[0], 'html');
  assert.equal(f.calls[1][1].focus, 'autoFocusImmediately');
  f.calls.length = 0;
  f.panel.webview.postMessage = async message => {
    assert.deepEqual(f.calls, ['pdf', 'window']); f.messages.push(message); return true;
  };
  await f.pdf(false);
  assert.equal(f.messages.at(-1).type, 'reviewSourceAction');
  f.hover(false); await tick();
  assert.deepEqual(f.calls, ['pdf', 'window'], 'background hover cannot refocus HTML');
});

test('pending HTML handoff cannot override a later PDF command', async () => {
  const f = fixture(), wait = deferred();
  let reads = 0;
  f.source.document = async () => { if (++reads === 1) await wait.promise; return f.editor.document; };
  f.hover(true);
  await f.pdf(false);
  wait.resolve(); await tick();
  assert.deepEqual(f.calls, ['pdf', 'window']);
});

test('pending PDF command cannot override a later HTML handoff', async () => {
  const f = fixture(), wait = deferred();
  let reads = 0;
  f.source.document = async () => { if (++reads === 1) await wait.promise; return f.editor.document; };
  const pending = f.pdf(false);
  f.hover(true); await tick();
  wait.resolve(); await pending;
  assert.equal(f.calls[0], 'html');
  assert.equal(f.calls.some(value => value === 'pdf'), false);
  assert.equal(f.messages.length, 0);
});

test('PDF pointer focus invalidates HTML handoff while it is awaiting the document', async () => {
  const f = fixture(), wait = deferred();
  f.source.document = async () => { await wait.promise; return f.editor.document; };
  f.hover(true);
  // ReaderController handles the trusted pointer/wheel focus message this way.
  ++f.reader.focusRevision; f.panel.reveal();
  wait.resolve(); await tick();
  assert.deepEqual(f.calls, ['pdf']);
});

test('programmatic source selection cannot summon a hover over PDF; save keeps focus', async () => {
  const f = fixture();
  f.selection(f.vscode.TextEditorSelectionChangeKind.Command);
  f.selection(f.vscode.TextEditorSelectionChangeKind.Keyboard);
  await f.pdf(true);
  assert.deepEqual(f.calls, []);
  assert.equal(f.reader.focusRevision, 0);
  assert.equal(f.messages.at(-1).request.save, true);
});
