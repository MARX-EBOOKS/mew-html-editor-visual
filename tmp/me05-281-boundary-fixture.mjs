import {readFile,writeFile} from 'node:fs/promises';
const f=JSON.parse(await readFile('tmp/me05-281-alignment-fixture.json','utf8'));
await writeFile('tests/fixtures/pdf-selection-me05-281-boundary.json',JSON.stringify({source:f.source,pages:[f.pdf.slice(f.pages[297].start,f.pages[297].end),f.pdf.slice(f.pages[298].start,f.pages[298].start+180)]},null,2)+'\n');
