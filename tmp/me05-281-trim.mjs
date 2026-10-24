import {readFile,writeFile} from 'node:fs/promises';
import {engine} from '../tests/support/pdf-harness.mjs';
const f=JSON.parse(await readFile('tmp/me05-281-alignment-fixture.json','utf8')),api=engine(),n=api.normalized(f.pdf),at=n.starts[675178];
console.log(JSON.stringify({at,text:f.pdf.slice(at-100,at+100),page:f.pages.find(p=>at>=p.start&&at<p.end)}));
const begin=f.pages[297].start,end=f.pages[298].end;
for(const [name,raw] of [['two',f.pdf.slice(begin,end)],['repeat',f.pdf.slice(at,at+33)+'\n'+f.pdf.slice(begin,end)]]){
const loc=new api.PdfLocator({}, {document:{createElement:()=>({})}}),source=loc.sourceIndex(f.source),target=new api.PdfSourceIndex(loc,{raw});
target.sourcePageScope(source,true);
for(const c of target.connections.get(source)||[])source.rememberConnection(c.targetStart,c.targetEnd,target,{start:c.start,end:c.end});
console.log(name,JSON.stringify(source.connectionPairs([target]).map(([c])=>({start:c.start,end:c.end,targetStart:c.targetStart,targetEnd:c.targetEnd}))),JSON.stringify(source.reviewCandidates([target]).filter(c=>c.sourceStart>400&&c.sourceStart<425).map(c=>c.comparison)));
if(name==='repeat')await writeFile('tmp/me05-281-small-fixture.json',JSON.stringify({source:f.source,pdf:raw}));
}
