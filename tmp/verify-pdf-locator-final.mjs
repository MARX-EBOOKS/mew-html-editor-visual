import fs from 'node:fs';
const path = 'tmp/pdf-locator-class-check.mjs';
let source=fs.readFileSync(path,'utf8');
source=source.replace('let reads=0, fontReads=0;', 'let reads=0, fontReads=0, pageReads=0;').replace('getPage:async()=>page', 'getPage:async()=>{pageReads++;return page;}').replace('assert.equal(a.fontVersion,1);', "assert.equal(a.fontVersion,1); assert.equal(pageReads,2); console.log(engine===old ? 'Baseline page reads: 2' : 'Class page reads: 2');");
fs.writeFileSync(path,source);
// Use normal constructor syntax except when the owner is a function result.
for (const name of fs.readdirSync('tests').filter(n=>/\.(mjs|js)$/.test(n))) {
 const path='tests/'+name;
 const before=fs.readFileSync(path,'utf8');
 const after=before.replace(/new \(([\w.]+\.PdfLocator)\)/g,'new $1');
 if(after!==before) fs.writeFileSync(path,after);
}
