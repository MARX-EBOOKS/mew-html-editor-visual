import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const diffSource = fs.readFileSync('public/pdfdiff/pdf-selection-diff.js', 'utf8');
function engine(path, current) {
  const source = fs.readFileSync(path, 'utf8');
  const mapping = source.slice(source.indexOf('// Source/PDF mapping and candidate generation.'), source.indexOf('// Shared popup and session initialization.'));
  const window = {};
  vm.runInNewContext(diffSource + '\n' + `(() => { const toolbox = window.PdfSelectionDiff; ${mapping}; window.makeLocator = ${current ? '(options, environment) => new PdfLocator(options, environment)' : 'createLocator'}; window.Locator = ${current ? 'PdfLocator' : 'null'}; })();`, {window});
  return window;
}
const old = engine('tmp/pdf-locator-before-class.js', false), current = engine('public/pdfdiff/pdf-review-provider.js', true);
const clean = value => JSON.parse(JSON.stringify(value));
const document = {createElement: () => ({})};
const scenarios = [];
for (const engine of [old, current]) {
  const options = {wholeWords: true}, pdf = {};
  const locator = engine.makeLocator(options, {document, getPdf: () => pdf});
  if (engine === current) {
    assert.ok(locator instanceof engine.Locator);
    assert.equal(Object.hasOwn(locator, 'sourceIndex'), false);
    const second = engine.makeLocator({}, {document});
    for (const key of ['documents', 'sourceIndexes', 'reviewAnchors', 'noPdf']) assert.notEqual(locator[key], second[key]);
  }
  const normalized = locator.normalized('Straße ſoft hy-\nphen ﬃ 𠀀');
  const matches = locator.matches('Cat scatter cat', ['cat']);
  const located = locator.locate('Before wrong after.', {text:'wrong', before:'Before ', after:' after.'});
  const source = locator.sourceIndex('<p>Before <b>working</b> together after.</p>');
  const target = locator.sourceIndex('<p>Before working nicely together after.</p>');
  const connection = locator.rememberConnection(source, 0, source.raw.length, target, {start:0, end:target.raw.length});
  const start = source.raw.indexOf('together');
  const mapped = locator.connectedRange(source, target, start, start+8);
  assert.equal(target.raw.slice(mapped.start, mapped.end), 'together');
  const reversed = locator.connectedRange(source, target, mapped.start, mapped.end, true);
  assert.equal(source.raw.slice(reversed.start, reversed.end), 'together');
  const patches = locator.patchedWords({index:source,text:source.raw}, target);
  locator.prepareSource(source, [target], pdf);
  const preparation = source.preparation;
  locator.prepareSource(source, [target], pdf);
  assert.equal(source.preparation, preparation);
  let text = '<p>Before working together after.</p>', version=1;
  const model = {getValue:()=>text,getVersionId:()=>version};
  const index = locator.editorSourceIndex(model);
  assert.equal(locator.editorSourceIndex(model),index);
  text = '<p>Before <b>working</b> together after.</p>'; version++;
  const updated = locator.editorSourceIndex(model);
  assert.notEqual(updated,index);
  assert.equal(updated.raw,index.raw);
  assert.equal(locator.reviewAnchor(null,index),null);
  scenarios.push(clean({normalized,matches,located,raw:source.raw,starts:source.starts,ends:source.ends,formats:source.formats,mapped:{start:mapped.start,end:mapped.end},distance:connection.distance,patches,scope:locator.sourcePageScope(source,target)}));
}
assert.deepEqual(scenarios[1],scenarios[0]);
for (const engine of [old,current]) {
  let reads=0, fontReads=0, pageReads=0;
  const page={ commonObjs: new Map([['f',{name:'Times',bold:false,italic:false}]]), getTextContent:async()=>{reads++;return {items:[{str:'Before working after.',fontName:'f',transform:[1,0,0,1,0,10],height:10,width:80}]};},getOperatorList:async()=>{fontReads++; return {fnArray:[],argsArray:[]};}};
  const pdf={numPages:1,getPage:async()=>{pageReads++;return page;}};
  const locator=engine.makeLocator({}, {document,isCurrent:()=>true,waitForIdle:async()=>{}});
  const [a,b]=await Promise.all([locator.indexDocument(pdf),locator.indexDocument(pdf)]);
  assert.equal(a,b); assert.equal(reads,1); assert.equal(locator.getDocumentIndex(pdf),a);
  const [c,d]=await Promise.all([locator.indexFonts(pdf),locator.indexFonts(pdf)]);
  assert.equal(c,a); assert.equal(d,a); assert.equal(fontReads,1); assert.equal(a.fontVersion,1); assert.equal(pageReads,2); console.log(engine===old ? 'Baseline page reads: 2' : 'Class page reads: 2');
  let active=false;
  const retry=engine.makeLocator({}, {document,isCurrent:()=>active,waitForIdle:async()=>{}});
  assert.equal(await retry.indexDocument(pdf),null);
  active=true; assert.ok(await retry.indexDocument(pdf));
}
console.log('PASS: prototype methods, isolated instance fields, old/new mapping parity, source cache reuse, document/font concurrency, cancelled-index retry.');
