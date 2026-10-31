const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const core = require('../reader-core.cjs');
const source = fs.readFileSync(require.resolve('../extension.cjs'), 'utf8');
const start = source.indexOf('class ReaderController {');
// The controller is the last declaration in the extension.
const Controller = vm.runInNewContext(source.slice(start, source.indexOf('module.exports', start)) + '\nReaderController;', {
  ...core, console, setTimeout, clearTimeout,
  require: require("node:module").createRequire(require.resolve("../extension.cjs")),
  sameUri: (a, b) => a?.toString() === b?.toString(),
  vscode: { FileType: { Directory: 2 }, Uri: { joinPath: (base, name) => name },
    workspace: { fs: { readDirectory: async () => entries } } }
});
let entries;
test('directory additions and deletions rematch the actual PDF label without moving the PDF', async () => {
  const reader = new Controller({ subscriptions: [] });
  const volume = { directoryUri: 'pages', pattern: '^(?<page>\\d+)\\.html$', explicitPages: [], pages: [1], files: new Map([[1, '1.html']]) };
  reader.current = { page: 1, volume };
  reader.panel = {};
  reader.pdfPageLabel = '7a';
  const opened = [];
  reader.openHtmlPage = async (current, page, preserveFocus) => {
    assert.equal(preserveFocus, true, "automatic rematching keeps focus");
    opened.push(page);
    assert.equal(reader.pdfNavigationTarget, `${page}.html`);
    reader.current = { ...current, page };
  };
  entries = [['1.html', 1], ['7.html', 1], ['9.html', 1]];
  await reader.refreshVolume();
  assert.deepEqual(opened, [7]);
  entries = [['1.html', 1], ['9.html', 1]];
  await reader.refreshVolume();
  assert.deepEqual(opened, [7, 1]);
  assert.equal(reader.pdfPageLabel, '7a');
  entries = [];
  await reader.refreshVolume();
  assert.deepEqual(opened, [7, 1]);
  entries = [['5.html', 1]];
  await reader.refreshVolume();
  assert.deepEqual(opened, [7, 1, 5]);
});


test('background navigation keeps focus and drops superseded file opens', async () => {
  const pending = new Map(), shown = [], synced = [];
  const current = { page: 1, volume: { files: new Map([[2, '2.html'], [3, '3.html']]) } };
  const Reader = vm.runInNewContext(source.slice(start, source.indexOf('module.exports', start)) + '\nReaderController;', {
    ...core, console, setTimeout, clearTimeout,
    require: require("node:module").createRequire(require.resolve("../extension.cjs")),
    sameUri: (a, b) => a?.toString() === b?.toString(),
    targetEditor: () => ({ viewColumn: 1 }),
    vscode: {
      ViewColumn: { Active: -1 },
      workspace: { openTextDocument: uri => new Promise(resolve => pending.set(uri, resolve)) },
      window: { showTextDocument: async (document, options) => shown.push({ document, options }) }
    }
  });
  const reader = new Reader({ subscriptions: [] });
  reader.current = current;
  reader.sync = async uri => synced.push(uri);
  const older = reader.openHtmlPage(current, 2, true);
  const newer = reader.openHtmlPage(current, 3, true);
  pending.get('3.html')('third');
  await newer;
  pending.get('2.html')('second');
  await older;
  assert.equal(shown.length, 1);
  assert.equal(shown[0].document, 'third');
  assert.equal(shown[0].options.preserveFocus, true);
  assert.deepEqual(synced, ['3.html']);
});

test('PDF page changes do not force the HTML editor window to the foreground', async () => {
  const reader = new Controller({ subscriptions: [] });
  const target = '2.html';
  const current = { page: 1, volume: { pages: [1, 2], files: new Map([[1, '1.html'], [2, target]]) } };
  reader.current = current;
  let call;
  reader.openHtmlPage = async (...args) => { call = args; };

  await reader.onPdfPage({ pageLabel: '2' });

  assert.deepEqual(call, [current, 2, true], 'preserve PDF focus while updating the HTML tab');
  assert.equal(reader.pdfNavigationTarget, null);
});
