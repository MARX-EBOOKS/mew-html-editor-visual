const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('PDF handshake retries a lost ready and answers a restarted host without reopening', () => {
  const source = fs.readFileSync(require.resolve('../reader-pdf.js'), 'utf8');
  const start = source.indexOf('  const ready = () =>');
  const end = source.indexOf('\n}', start);
  const listeners = new Map(), posted = [], loaded = [];
  let retry, cleared = 0;
  const document = { pdfUri: 'file:///book.pdf', pageLabel: '317' };
  vm.runInNewContext(source.slice(start, end), {
    vscode: { postMessage: message => posted.push(message) },
    pending: undefined, stored: { document },
    setInterval(callback) { retry = callback; return 1; },
    clearInterval(id) { assert.equal(id, 1); cleared++; },
    window: { addEventListener(type, callback) { listeners.set(type, callback); } },
    loadPdf(message) { loaded.push(message); }
  });
  assert.equal(posted.length, 1);
  retry(); // The first ready was lost during extension-host restart.
  assert.equal(posted.length, 2);
  assert.equal(posted[1].document, document);
  listeners.get('message')({ data: { type: 'showPdf', ...document } });
  assert.equal(cleared, 1);
  assert.equal(loaded.length, 1);
  listeners.get('message')({ data: { type: 'requestReady' } });
  assert.equal(posted.length, 3, 'retained webview answers new host after its retry timer stopped');
  assert.equal(loaded.length, 1, 'probe alone does not reload PDF');
  listeners.get('pagehide')();
  assert.equal(cleared, 2);
});

test('host recovery replaces only orphaned PDF tabs and keeps their editor group alive', async () => {
  const source = fs.readFileSync(require.resolve('../extension.cjs'), 'utf8');
  for (const mode of ['orphan', 'resolving', 'attached', 'closed']) {
    const events = [];
    const tab = { input: { viewType: 'mewReader.pdf', uri: 'book.pdf' } };
    const group = { viewColumn: 3, tabs: [tab] };
    let recover;
    const vscode = {
      window: {
        tabGroups: { all: [group], async close(value, preserveFocus) {
          assert.equal(value, tab); assert.equal(preserveFocus, true);
          assert.equal(events[0], 'holder'); events.push('close'); return true;
        } },
        createWebviewPanel(type, title, options) {
          assert.equal(options.viewColumn, 3); assert.equal(options.preserveFocus, true);
          events.push('holder');
          return { viewColumn: 3, dispose() { events.push('dispose-holder'); } };
        }
      },
      commands: { async executeCommand(command, uri, type, options) {
        assert.equal(command, 'vscode.openWith'); assert.equal(uri, 'book.pdf');
        assert.equal(type, 'mewReader.pdf'); assert.equal(options.viewColumn, 3);
        events.push('open');
      } }
    };
    const sandbox = { require: () => vscode, module: { exports: {} },
      setTimeout(callback) { recover = callback; return 1; }, clearTimeout() {} };
    vm.runInNewContext(source, sandbox);
    const reader = { report(error) { throw error; } };
    sandbox.module.exports.restorePdfTabs({ subscriptions: [] }, reader);
    if (mode === 'resolving') reader.resolvingPdf = true;
    if (mode === 'attached') reader.panel = {};
    if (mode === 'closed') group.tabs = [];
    await recover();
    assert.deepEqual(events, mode === 'orphan' ? ['holder', 'close', 'open', 'dispose-holder'] : []);
  }
});
