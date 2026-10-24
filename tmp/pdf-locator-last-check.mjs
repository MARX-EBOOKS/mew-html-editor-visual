import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync('tmp/pdf-locator-before-class.js','utf8');
const popup=fs.readFileSync('public/pdfdiff/replacement-review.js','utf8').split('// Shared review popup, session, navigation and saving.')[0];
const harness=popup+'\n(() => {\n'+source.split('// PDF comparison is one review provider. Selection synchronization remains independent.')[1].replace(/\r?\n  return window\.PdfReviewProvider;\r?\n\}\)\(\);\s*$/,'')+'\n})();';
try {new vm.Script(harness); throw new Error('Baseline unexpectedly passed');} catch(error) {if (!(error instanceof SyntaxError)) throw error; console.log('Confirmed pre-existing pattern harness error:',error.message);}
const path='pdf-selection.md';
let doc=fs.readFileSync(path,'utf8');
doc=doc.replace('with reader-local caches. Selection exposes this locator', 'with reader-local caches. Options, environment, document, source/document caches,\nreview anchors, and the no-PDF key belong to each instance; locator methods live\non the prototype. Selection exposes this locator');
fs.writeFileSync(path,doc);
for(const path of ['public/pdfdiff/pdf-review-provider.js','public/pdfdiff/pdf-selection.js',...fs.readdirSync('tests').filter(n=>/\.(mjs|js)$/.test(n)).map(n=>'tests/'+n)]) {
 const code=fs.readFileSync(path,'utf8');
 if(code.includes('PdfLocator')) {
  const {spawnSync}=await import('node:child_process');
  const r=spawnSync(process.execPath,['--check',path],{encoding:'utf8'});
  if(r.status) throw new Error(path+'\n'+r.stderr);
 }
}
console.log('Syntax checks passed for production files and migrated test callers.');
