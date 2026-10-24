import {readFile,writeFile} from 'node:fs/promises';
const f=JSON.parse(await readFile('tmp/me05-281-small-fixture.json','utf8'));
f.source=f.source.slice(0,f.source.indexOf('<p>Folgt'))+'</body>\n</html>';
f.pdf=f.pdf.slice(0,f.pdf.indexOf('Folgt'));
await writeFile('tests/fixtures/pdf-selection-me05-281.json',JSON.stringify(f,null,2)+'\n');
let harness=await readFile('tests/support/pdf-harness.mjs','utf8');
harness=harness.replaceAll('../../public/','../public/').replace("const diffSource = await readFile(new URL('../public/pdfdiff/pdf-selection-diff.js', import.meta.url), 'utf8');","const diffSource = (await readFile(new URL('../public/pdfdiff/pdf-selection-diff.js', import.meta.url), 'utf8')).replace('previous.end + size >= range.start && previous.hit.end + size >= range.hit.start', 'previous.end >= range.start && previous.hit.end >= range.hit.start');");
await writeFile('tmp/me05-281-baseline-harness.mjs',harness);
for(const name of ['pdf-selection-diff','pdf-selection-highlight','pdf-review-pattern']){
let s=await readFile('tests/'+name+'.test.mjs','utf8');s=s.replace('./support/pdf-harness.mjs','./me05-281-baseline-harness.mjs').replaceAll('./fixtures/','../tests/fixtures/');await writeFile('tmp/me05-281-baseline-'+name+'.test.mjs',s);
}
