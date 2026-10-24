import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
const paths=['public/pdfdiff/pdf-review-provider.js','public/pdfdiff/pdf-selection.js','public/pdfdiff/replacement-review.js',...fs.readdirSync('tests').filter(n=>/\.(mjs|js)$/.test(n)).map(n=>'tests/'+n)];
let count=0;
for(const path of paths) {
 const code=fs.readFileSync(path,'utf8');
 if(!code.includes('PdfSourceIndex')&&!path.startsWith('public/')&&!path.endsWith('review-highlights.test.mjs'))continue;
 const result=spawnSync(process.execPath,['--check',path],{encoding:'utf8'});
 if(result.status) throw new Error(path+'\n'+result.stderr);
 count++;
}
console.log('Syntax checks passed:',count,'files');
