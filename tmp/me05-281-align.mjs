import {readFile,writeFile} from 'node:fs/promises';
import {getDocument} from '../node_modules/pdfjs-dist/legacy/build/pdf.mjs';
import {engine} from '../tests/support/pdf-harness.mjs';
const api=engine(),task=getDocument({data:new Uint8Array(await readFile('../马恩全集德文/mew_band05.pdf')),useSystemFonts:true}),pdf=await task.promise;
try{
const loc=new api.PdfLocator({}, {document:{createElement:()=>({})},isCurrent:()=>true,waitForIdle:async()=>{}}),doc={numPages:pdf.numPages,getPage:n=>pdf.getPage(n)};
const full=await loc.indexDocument(doc),source=loc.sourceIndex(await readFile('../MEW_BRIEF/5/ME05-281.html','utf8'));
loc.prepareSource(source,[full],doc);
console.log(JSON.stringify({raw:full.raw.slice(350,570),connections:source.connectionPairs([full]).map(([c,t])=>({start:c.start,end:c.end,targetStart:c.targetStart,targetEnd:c.targetEnd,source:source.raw.slice(c.start,c.end).slice(-50),target:t.raw.slice(c.targetStart,c.targetEnd).slice(-50),targetHead:t.raw.slice(c.targetStart,c.targetStart+80)})),candidates:source.reviewCandidates([full]).map(i=>({start:i.sourceStart,end:i.sourceEnd,comparison:i.comparison}))},null,2));
await writeFile('tmp/me05-281-alignment-fixture.json',JSON.stringify({source:source.source,pdf:full.raw,pages:full.pages.map(p=>({number:p.number,start:p.start,end:p.end}))}));
}finally{await task.destroy()}


