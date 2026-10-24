import {readFile,writeFile} from 'node:fs/promises';
let h=await readFile('tests/support/pdf-harness.mjs','utf8');
h=h.replaceAll('../../public/','../public/');
const line="const diffSource = await readFile(new URL('../public/pdfdiff/pdf-selection-diff.js', import.meta.url), 'utf8');";
let expression="(await readFile(new URL('../public/pdfdiff/pdf-selection-diff.js', import.meta.url), 'utf8'))";
for(const [p,t] of [['a','from'],['x','to'],['b','from'],['y','to']]){
const offset=['a','x'].includes(p)?p+' - 1':p;
expression+='.replace('+JSON.stringify('/\\p{L}{2}/u.test('+t+'.text.slice('+p+' - 1, '+p+' + 1))')+', '+JSON.stringify('/\\p{L}/u.test('+t+'.text['+offset+'])')+')';
}
h=h.replace(line,'const diffSource = '+expression+';');await writeFile('tmp/me05-281-boundary-baseline-harness.mjs',h);
for(const name of ['pdf-selection-diff','pdf-selection-highlight','pdf-review-pattern']){
let s=await readFile('tests/'+name+'.test.mjs','utf8');s=s.replace('./support/pdf-harness.mjs','./me05-281-boundary-baseline-harness.mjs').replaceAll('./fixtures/','../tests/fixtures/');await writeFile('tmp/me05-281-boundary-baseline-'+name+'.test.mjs',s);
}
let browser=await readFile('tmp/me05-281-fixed-browser.mjs','utf8');
browser=browser.replace("console.log('marks',JSON.stringify(marks));",`const candidates=await page.evaluate(()=>{const l=PdfSelection.locator,index=l.editorSourceIndex(readerMonaco.editor.getModel()),target=l.getDocumentIndex(PdfSelection.viewer.pdfDocument);return index.reviewCandidates([target]).map(c=>c.comparison)});
 console.log('candidates',JSON.stringify(candidates));assert(!candidates.some(c=>c.pdf.includes('Karl')));
 console.log('marks',JSON.stringify(marks));`);
await writeFile('tmp/me05-281-boundary-browser.mjs',browser);
