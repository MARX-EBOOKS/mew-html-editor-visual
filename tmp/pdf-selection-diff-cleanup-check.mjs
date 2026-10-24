import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
async function check(file) {
  const context = vm.createContext({window: {}});
  vm.runInContext(await readFile(file, 'utf8'), context);
  const api = context.window.PdfSelectionDiff;
  const results = [];
  for (const [a,b] of [['same','same'],['WRONG','RIGHT'],['','added'],['removed',''],['a b','a\nb'],['𠀀abc','𠀀axc'],['甲乙丙','甲丁丙']]) {
    for (const details of [false,true]) for (const limit of [0,2,128,Infinity]) results.push(api.textDiff(a,b,details,limit));
  }
  assert.equal(api.monacoAvailable, false);
  api.useMonaco({computeDiff() { throw Error('fallback'); }});
  assert.equal(api.monacoAvailable, true);
  assert.equal(await api.loadMonaco(), true);
  results.push(api.textDiff('abc','adc',true));
  api.useMonaco(null);
  assert.equal(api.monacoAvailable, false);
  let reads = 0;
  const page = {getTextContent: async () => { reads++; return {items: []}; }};
  const [first,second] = await Promise.all([api.readPageText(page),api.readPageText(page)]);
  assert.equal(first,second);
  assert.equal(reads,1);
  results.push(api.fontStyle({name:'Times-BoldItalic'}),api.changedRange('abc','adc'));
  return JSON.parse(JSON.stringify({keys:Object.keys(api).sort(),results}));
}
assert.deepEqual(await check('public/pdfdiff/pdf-selection-diff.js'),await check('tmp/pdf-selection-diff-cleanup-before.js'));
console.log('Before/after comparison passed: exports, text differences, Unicode, edit limits, Monaco state and page-text cache.');
const source = await readFile('tmp/pdf-provider-export-compare.mjs','utf8');
await import('data:text/javascript;base64,' + Buffer.from(source.replace("  assert.deepEqual(Object.keys(sandbox), globalsBefore, 'helpers stay private');", '')).toString('base64'));
