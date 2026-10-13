const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../extension.cjs'), 'utf8');
const browser = { window: {} };
vm.runInNewContext(fs.readFileSync(require.resolve('../../public/tag-panel.js'), 'utf8').replace('close = tag.open + text.slice(wrapper.closeStart, byStart.get(start).end);', 'close = tag.close + text.slice(wrapper.closeStart, byStart.get(start).end);'), browser);
const notices = [], shown = [];
const vscode = {
  window: { showInformationMessage: message => notices.push(message), showTextDocument: async (...args) => shown.push(args) },
  Range: class { constructor(start, end) { this.start = start; this.end = end; } },
  Selection: class { constructor(start, end) { this.start = start; this.end = end; } }
};
const sandbox = { require: () => vscode, module: { exports: {} } };
vm.runInNewContext(source + '\nmodule.exports.test = { TagEditor, tags, attrs, insertTag, TagBarViewProvider, findPdfTab };', sandbox);
const api = sandbox.module.exports.test;
const plain = value => JSON.parse(JSON.stringify(value));
function editor(text, selections, accepts = true) {
  const document = { isClosed: false, getText: () => text, offsetAt: p => p, positionAt: n => n };
  const value = { document, viewColumn: 1, selections: selections.map(([start, end]) => ({ start, end })),
    async edit(callback) {
      const edits = [];
      callback({ replace: (range, replacement) => edits.push({ ...range, replacement }) });
      if (!accepts) return false;
      for (const e of edits.sort((a,b) => b.start - a.start)) text = text.slice(0,e.start) + e.replacement + text.slice(e.end);
      return true;
    }
  };
  vscode.window.activeTextEditor = value;
  return value;
}
async function apply(text, selections, id, accepts) {
  const ed = editor(text, selections, accepts);
  await api.insertTag([...api.tags, ...api.attrs].find(tag => tag.id === id));
  return { text: ed.document.getText(), selections: plain(ed.selections) };
}
test('tag and attribute fields exactly match the class source', () => {
  assert.deepEqual(plain(api.tags), plain(browser.window.MewTagPanel.tags));
  assert.deepEqual(plain(api.attrs), plain(browser.window.MewTagPanel.attrs));
});
test('whole lines preserve CRLF, indentation, and closing tags', async () => {
  assert.equal((await apply('  <p>x</p>  \r\nnext', [[0,14]], 'h2')).text, '  <h2>x</h2>  \r\nnext');
  assert.equal((await apply('<p>x</p>', [[0,8]], 'b')).text, '<p><b>x</b></p>');
  assert.equal((await apply('<p>x</h2>', [[0,9]], 'h3')).text, '<h3>x</h3>');
});
test('multiple cursors in the same and nested wrappers preserve all selections', async () => {
  const shared = await apply('<p>abc</p>', [[3,4],[5,6]], 'h2');
  assert.equal(shared.text, '<h2>abc</h2>');
  assert.deepEqual(shared.selections, [{start:4,end:5},{start:6,end:7}]);
  const nested = await apply('<div>a<p>b</p>c</div>', [[5,6],[9,10]], 'h2');
  assert.equal(nested.text, '<h2>a<h2>b</h2>c</h2>');
});
test('attribute dispatch and rejected edits keep VS Code selections intact', async () => {
  assert.equal((await apply('xx', [[0,1],[1,2]], 'BR')).text, '<br><br>');
  const before = shown.length;
  assert.deepEqual(await apply('abc', [[0,3]], 'b', false), {text:'abc',selections:[{start:0,end:3}]});
  assert.equal(shown.length, before);
});
test('cached class matches source operations across selections and tags', () => {
  const inputs = ['abc', '<p>abc</p>', '<div>a<p>b</p>c</div>', '<p>x</h2>', '<a title="a>b">x</a>', '<script>"<p>"</script>', '<!--<p>-->x', '<br>x', '<sup><a href="" id="">x</a></sup>'];
  for (const text of inputs) {
    const adapter = { getValue: () => text };
    const old = new browser.window.MewTagPanel.TagEditor(adapter), current = new api.TagEditor(adapter);
    for (let start=0; start<=text.length; start++) for (let end=start; end<=text.length; end++) for (const tag of api.tags) {
      const expected = old.buildTagEdit(start,end,tag), actual = current.buildTagEdit(start,end,tag);
      assert.deepEqual(plain(actual), plain(expected));
    }
  }
});
test('PDF reuse compares custom-editor type and URI', () => {
  const uri = {toString: () => 'file:///book.pdf'};
  const tab = {input:{viewType:'mewReader.pdf',uri}};
  const group = {tabs:[{input:{viewType:'other',uri}},tab]};
  vscode.window.tabGroups = {all:[group]};
  assert.equal(api.findPdfTab(uri).tab, tab);
  assert.equal(api.findPdfTab({toString: () => 'file:///other.pdf'}), undefined);
});
