const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const fs = require("node:fs/promises");
const path = require("node:path");
const { tmpdir } = require("node:os");
const { pathToFileURL, fileURLToPath } = require("node:url");
const manifest = require("../package.json");

test("extension activates, registers commands, and resolves a restored PDF custom editor", async () => {
  const registered = new Set();
  let provider;
  let tagProvider;
  const disposable = { dispose() {} };
  const uri = value => ({
    scheme: value.split(":")[0],
    path: value.replace(/^file:\/\//, ""),
    fsPath: /^file:\/\/\/[a-z]:/i.test(value) ? fileURLToPath(value) : value.replace(/^file:\/\//, ""),
    toString() { return value; }
  });
  const vscode = {
    ViewColumn: { Active: -1, Beside: -2 },
    Uri: {
      parse: uri,
      joinPath(base, ...parts) { return uri(`${base.toString()}/${parts.join("/")}`); }
    },
    window: {
      activeTextEditor: undefined,
      tabGroups: { all: [{ tabs: [{ input: undefined }] }] },
      onDidChangeActiveTextEditor() { return disposable; },
      registerWebviewViewProvider() { return disposable; },
      registerWebviewPanelSerializer(viewType, value) {
        tagProvider = value;
        assert.equal(viewType, "mewReader.floatingBar");
        assert.equal(typeof value.deserializeWebviewPanel, "function");
        return disposable;
      },
      registerCustomEditorProvider(viewType, value, options) {
        assert.equal(viewType, "mewReader.pdf");
        assert.equal(typeof value.openCustomDocument, "function");
        assert.equal(typeof value.resolveCustomEditor, "function");
        assert.equal(options.supportsMultipleEditorsPerDocument, false);
        provider = value;
        return disposable;
      },
      showErrorMessage() {}, showInformationMessage() {}
    },
    workspace: { onDidSaveTextDocument() { return disposable; },
      getConfiguration() { return { get: (_key, fallback) => fallback }; } },
    commands: {
      registerCommand(id) { registered.add(id); return disposable; },
      executeCommand() { return Promise.resolve(); }
    }
  };
  const original = Module._load;
  Module._load = function (request, parent, isMain) {
    return request === "vscode" ? vscode : original.call(this, request, parent, isMain);
  };
  try {
    const extension = require("../extension.cjs");
    extension.activate({
      subscriptions: [],
      extensionUri: uri("file:///extension"),
      globalState: { get() { return {}; }, update() { return Promise.resolve(); } }
    });
  } finally {
    Module._load = original;
  }
  const contributed = manifest.contributes.commands.map(item => item.command);
  assert.deepEqual(contributed.filter(id => !registered.has(id)), []);
  assert.deepEqual(manifest.contributes.keybindings.filter(binding => binding.command === "mewReader.showBar"), [{
    command: "mewReader.showBar",
    key: "ctrl+alt+t"
  }]);
  assert.deepEqual(manifest.contributes.customEditors, [{
    viewType: "mewReader.pdf",
    displayName: "MEW Synchronized PDF",
    selector: [{ filenamePattern: "*.pdf" }],
    priority: "option"
  }]);

  let receiveMessage;
  const posted = [];
  const panel = {
    webview: {
      cspSource: "vscode-webview:",
      asWebviewUri(value) { return value; },
      onDidReceiveMessage(callback) { receiveMessage = callback; return disposable; },
      postMessage(message) { posted.push(message); return Promise.resolve(true); }
    },
    onDidDispose() { return disposable; },
    dispose() {}
  };
  const pdfUri = uri("file:///books/mew.pdf");
  const document = provider.openCustomDocument(pdfUri);
  provider.resolveCustomEditor(document, panel);
  receiveMessage({ type: "ready", document: {
    pdfUri: "file:///books/mew.pdf",
    fileName: "mew.pdf",
    pageLabel: "317"
  } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(panel.title, "mew.pdf");
  assert.equal(posted.filter(message => message.type === "showPdf").at(-1).type, "showPdf");
  assert.equal(posted.filter(message => message.type === "showPdf").at(-1).pageLabel, "317");
  assert.match(posted.filter(message => message.type === "showPdf").at(-1).url, /mew\.pdf$/);
  assert.equal(posted.filter(message => message.type === "showPdf").at(-1).nativeData, true);

  const fixture = await fs.mkdtemp(path.join(tmpdir(), "mew-pdf-data-"));
  try {
    const file = path.join(fixture, "book.pdf");
    const bytes = Buffer.from("%PDF-binary-test\x00\xff");
    await fs.writeFile(file, bytes);
    provider.resolveCustomEditor(provider.openCustomDocument(uri(pathToFileURL(file).href)), panel);
    receiveMessage({ type: "pdfDataRequest", id: 41, path: "unauthorized.pdf" });
    for (let i = 0; i < 100 && !posted.some(m => m.id === 41); i++) await new Promise(resolve => setTimeout(resolve, 5));
    const response = posted.find(m => m.id === 41);
    assert.equal(response.type, "pdfData");
    assert.ok(response.data instanceof Uint8Array);
    assert.deepEqual(Buffer.from(response.data), bytes, "reads only the editor-bound path");
    await fs.unlink(file);
    receiveMessage({ type: "pdfDataRequest", id: 42 });
    for (let i = 0; i < 100 && !posted.some(m => m.id === 42); i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.match(posted.find(m => m.id === 42).error, /ENOENT/);
  } finally {
    assert.equal(path.dirname(path.resolve(fixture)), path.resolve(tmpdir()));
    await fs.rm(fixture, { recursive: true, force: true });
  }

  // A restored PDF tab must block creation/moving before its resolver runs.
  const commands = [];
  vscode.commands.executeCommand = async (...args) => { commands.push(args); };
  let tagRevealed;
  tagProvider.panels.add({ reveal(...args) { tagRevealed = args; } });
  tagProvider.findFloating = () => { throw new Error("Attached tag bar must not traverse PDF groups"); };
  await tagProvider.show();
  assert.deepEqual(tagRevealed, [undefined, false]);
  assert.deepEqual(commands.map(args => args[0]), [
    "workbench.action.focusWindow", "workbench.action.enableCompactAuxiliaryWindow"
  ]);
  commands.length = 0;
  let pdfRevealed;
  panel.reveal = (...args) => { pdfRevealed = args; };
  receiveMessage({ type: "focusPdf" });
  assert.deepEqual(pdfRevealed, [undefined, false]);
  assert.deepEqual(commands.map(args => args[0]), ["workbench.action.focusWindow"]);
  commands.length = 0;
  const savedTab = { input: { viewType: "mewReader.pdf", uri: pdfUri } };
  const savedGroup = { tabs: [savedTab], activeTab: savedTab };
  vscode.window.tabGroups = { all: [savedGroup], activeTabGroup: savedGroup };
  provider.panel = null;
  await provider.createPanel({ uri: uri("file:///books/317.html"), volume: { pdfUri } });
  assert.deepEqual(commands, [], "reuse unresolved saved tab without openWith or moving it");
  vscode.window.activeTextEditor = { document: { uri: uri("file:///books/317.html") } };
  const originalSync = provider.sync;
  provider.sync = async () => {
    provider.current = { volume: { pdfUri } };
    return true;
  };
  await provider.open();
  assert.deepEqual(commands.map(args => args[0]), [
    "workbench.action.focusWindow"
  ], "toolbar focuses the saved window without changing its mode");
  commands.length = 0;
  let revealed;
  provider.panel = { reveal(...args) { revealed = args; } };
  provider.panelPdfUri = pdfUri;
  await provider.open();
  assert.deepEqual(revealed, [undefined, false], "keep the restored panel in its own window");
  provider.sync = originalSync;
  vscode.window.tabGroups.all = [];

  // Restart: openWith finishes while the restored custom editor is still pending.
  provider.panel = null;
  provider.ready = false;
  const current = { uri: uri("file:///books/317.html"), page: 317,
    volume: { pdfUri, pageLabel: "{page}" } };
  provider.resolvePage = async () => current;
  provider.watchVolume = () => {};
  const before = posted.length;
  assert.equal(await provider.sync(current.uri), true);
  assert.equal(posted.length, before, "wait for restored webview readiness");
  const oldReceive = receiveMessage;
  let disposed;
  const restoredPanel = {
    webview: {
      ...panel.webview,
      set html(value) {
        assert.match(value, /reader-config/);
        receiveMessage({ type: "ready" });
      }
    },
    onDidDispose(callback) { disposed = callback; return disposable; },
    dispose() { disposed?.(); }
  };
  provider.resolveCustomEditor(provider.openCustomDocument(pdfUri), restoredPanel);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(restoredPanel.title, "mew.pdf");
  assert.equal(posted.filter(message => message.type === "showPdf").at(-1).type, "showPdf");
  assert.equal(posted.filter(message => message.type === "showPdf").at(-1).pageLabel, "317");
  receiveMessage({ type: "ready", document: {
    pdfUri: pdfUri.toString(true), htmlUri: current.uri.toString(true), pageLabel: "318"
  } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(posted.filter(message => message.type === "showPdf").at(-1).pageLabel, "318",
    "restore later PDF progress for the same active HTML file");
  provider.ready = false;
  oldReceive({ type: "ready" });
  assert.equal(provider.ready, false, "obsolete panel cannot mark its replacement ready");
  restoredPanel.dispose();
  assert.equal(await provider.sync(current.uri), true, "closed panel does not cause a null-title error");
});
