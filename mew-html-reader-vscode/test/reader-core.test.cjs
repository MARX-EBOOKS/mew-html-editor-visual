const test = require("node:test");
const assert = require("node:assert/strict");
const { formatPattern, pageFromName, pageFromPdfLabel, adjacentPage, pageAtOrBefore, normalizedVolumes } = require("../reader-core.cjs");

test("patterns and labels follow reader.html semantics", () => {
  assert.equal(formatPattern("ME{volume:02}-{page:03}.html", 7, 4), "ME04-007.html");
  assert.equal(pageFromName("ME04-007.html", "^ME04-(?<page>\\d+)\\.html$"), 7);
  assert.equal(pageFromPdfLabel("17a"), 17);
  assert.equal(pageFromPdfLabel("iv"), null);
});

test("adjacent navigation uses actual configured pages and does not wrap", () => {
  assert.equal(adjacentPage([3, 4, 8], 4, 1), 8);
  assert.equal(adjacentPage([3, 4, 8], 3, -1), null);
  assert.equal(adjacentPage([3, 4, 8], 8, 1), null);
  assert.equal(pageAtOrBefore([3, 4, 8], 7), 4);
  assert.equal(pageAtOrBefore([3, 4, 8], 2), null);
});

test("single-volume JSON is normalized", () => {
  const [volume] = normalizedVolumes({ title: "Band 4", htmlRoot: "pages", pdf: "book.pdf", pagePattern: "(\\d+)" });
  assert.equal(volume.title, "Band 4");
  assert.equal(volume.directory, "pages");
  assert.equal(volume.pdf, "book.pdf");
});


test("native review edits reject stale expected text and overlapping ranges", () => {
  const { validateReviewEdits } = require('../reader-core.cjs');
  assert.throws(() => validateReviewEdits('abc', [{start:0,end:2,text:''},{start:1,end:3,text:''}]));
  assert.throws(() => validateReviewEdits('abc', [{start:0,end:1,text:'x',expected:'z'}]));
  assert.deepEqual(validateReviewEdits('abc', [{start:0,end:1,text:'x',expected:'a'}]), [{start:0,end:1,text:'x',expected:'a'}]);
});


test("review snapshots preserve reversed selection and page boundaries", () => {
  const { reviewSourceSnapshot } = require('../reader-core.cjs');
  const start = {line: 1, character: 2}, end = {line: 3, character: 4};
  const snapshot = reviewSourceSnapshot({uri:{toString:()=> 'file:///a'},getText:()=> 'text',version:7,isDirty:true},
    {page:3,volume:{pages:[3,8]}}, [{start,end,anchor:end,active:start}]);
  assert.equal(snapshot.pageEnd,8);
  assert.equal(snapshot.version,7);
  assert.deepEqual(snapshot.selections[0], {startLineNumber:2,startColumn:3,endLineNumber:4,endColumn:5,
    selectionStartLineNumber:4,selectionStartColumn:5,positionLineNumber:2,positionColumn:3});
});

test("decoration grouping normalizes hover messages and clears absent classes", () => {
  const { reviewDecorationGroups } = require('../reader-core.cjs');
  const range = {startLineNumber:1,startColumn:1,endLineNumber:1,endColumn:2};
  const groups = reviewDecorationGroups([{className:'a',range,hoverMessage:{value:'first'}},
    {className:'a',range,hoverMessage:['second',{value:'third'}]}, {className:'b',range}, {range}]);
  assert.deepEqual(groups.get('a').map(mark=>mark.hover), [['first'],['second','third']]);
  assert.deepEqual(groups.get('b')[0].hover, []);
  assert.equal(reviewDecorationGroups([]).size,0);
});


test("native source snapshots preserve CRLF offsets and send decorations without mutating text", async () => {
  const fs = require("node:fs"), vm = require("node:vm");
  const window = {}, sent = [];
  vm.runInNewContext(fs.readFileSync(require.resolve("../editor-core.js"), "utf8"), { window });
  const editor = new window.MewEditorCore.VSCodeController((type, data) => sent.push(structuredClone({ type, data })), async (type, data) => { sent.push(structuredClone({ type, data })); return true; });
  const snapshot = { uri: "file:///test.html", version: 7, text: "a\r\nb\nc", readOnly: false,
    selections: [{ startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 2 }] };
  editor.receive(snapshot);
  const model = editor.getModel();
  assert.equal(model.getOffsetAt({ lineNumber: 2, column: 1 }), 3);
  assert.equal(model.getPositionAt(3).lineNumber, 2);
  assert.equal(model.getValueInRange(editor.getSelection()), "b");
  editor.setSelection(editor.getSelection());
  assert.deepEqual(sent.at(-1).data.selections, snapshot.selections);
  editor.receive({ ...snapshot, layout: { splitView: true } });
  const fields = Object.fromEntries(['title', 'position', 'status', 'comparison', 'prev', 'next', 'apply', 'advance', 'all', 'save', 'preview-diff', 'close'].map(name =>
    [name, { textContent: name, children: [], hidden: false, disabled: false, getAttribute: () => null }]));
  editor.showReviewPopup({ hidden: false, querySelector: selector => fields[selector.slice(6, -1)] }, editor.getSelection(), true);
  assert.equal(sent.at(-1).type, 'reviewPopup');
  assert.deepEqual(sent.at(-1).data.popup.range, snapshot.selections[0]);
  await editor.applyReviewEdits([{ start: 3, end: 4, text: "B" }], snapshot.text);
  assert.equal(sent.at(-1).type, "reviewApply");
  assert.equal(model.getValue(), snapshot.text);
  editor.receive({ ...snapshot, version: 8, text: "a\r\nB\nc" });
  assert.equal(editor.getModel(), model);
  assert.equal(model.getVersionId(), 8);
  const collection = editor.createDecorationsCollection();
  collection.set([{ range: editor.getSelection(), options: { inlineClassName: "mew-ocr-diff-text" } }]);
  assert.equal(sent.at(-1).type, "reviewDecorations");
  assert.equal(sent.at(-1).data.decorations[0].className, "mew-ocr-diff-text");
  collection.clear();
  assert.equal(sent.at(-1).data.decorations.length, 0);
});
