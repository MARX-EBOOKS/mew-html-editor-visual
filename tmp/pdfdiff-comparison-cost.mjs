import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';
const expected = new Map();
for (const ref of ['HEAD~2', 'HEAD', 'working']) {
  const read = async name => ref === 'working' ? readFile(`public/pdfdiff/${name}`, 'utf8') : execFileSync('git', ['show', `${ref}:public/pdfdiff/${name}`], { encoding: 'utf8' });
  const provider = await read('pdf-review-provider.js'), window = {};
  vm.runInNewContext(await read('pdf-selection-diff.js'), { window });
  vm.runInNewContext(`(() => { const toolbox = window.PdfSelectionDiff; const {textDiff, significantText} = toolbox;
    ${provider.slice(provider.indexOf('// Source/PDF mapping'), provider.indexOf('// Shared popup'))}
    ${provider.slice(provider.indexOf('function sourceDecorations('), provider.indexOf('function onSources('))}
    window.api = {PdfLocator, reviewCandidates, sourceDecorations}; })();`, { window });
  const locator = new window.api.PdfLocator({}, { document: { createElement: () => ({}) } });
  for (const size of [40, 400, 2000]) {
    const source = locator.sourceIndex(Array.from({length:size}, (_, i) => `<span>${i % 2 ? 'b' : 'a'}</span>`).join(''));
    const target = { raw: 'c'.repeat(size), parts: [{start:0,end:size,font:{bold:false,italic:false}}] };
    const connection = {start:0,end:size,targetStart:0,targetEnd:size,editorDiff:{parts:[{html:source.raw,pdf:target.raw,changed:true}]}};
    source.connections.set(target,[connection]);
    const model = {getPositionAt: n => ({lineNumber:1,column:n+1})};
    const times = [];
    let count;
    for (let i=0;i<20;i++) {const start=performance.now(); count=window.api.sourceDecorations(source,[[connection,target]],model).length;times.push(performance.now()-start);}
    times.sort((a,b)=>a-b);
    const marks = JSON.parse(JSON.stringify(window.api.sourceDecorations(source, [[connection,target]], model)));
    if (ref === 'HEAD~2') expected.set(size, marks);
    if (ref === 'working') assert.deepEqual(marks, expected.get(size), 'highlight ranges, styles and hover text stay identical');
    console.log(JSON.stringify({ref,size,decorations:count,medianMs:times[10]}));
  }
}
