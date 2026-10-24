import {readFile,writeFile} from 'node:fs/promises';import{engine}from'../tests/support/pdf-harness.mjs';
const f=JSON.parse(await readFile('tmp/me05-284-live.json','utf8')),original=JSON.parse(await readFile('tmp/me05-284-fixture.json','utf8')).source;
const page=f.pages.find(p=>f.pdf.slice(p.start,p.end).includes('„Wo ist in England'));
const fixture={source:original,pdf:f.pdf.slice(page.start,page.end)};await writeFile('tests/fixtures/pdf-selection-me05-284.json',JSON.stringify(fixture,null,2)+'\n');
const api=engine(),l=new api.PdfLocator({}, {document:{createElement:()=>({})}}),i=l.sourceIndex(original),t=new api.PdfSourceIndex(l,{raw:fixture.pdf,pages:[{start:0,end:fixture.pdf.length}]});l.getDocumentIndex=()=>t;l.prepareSource(i,[t],{});console.log(i.reviewCandidates([t]).map(c=>c.comparison));
