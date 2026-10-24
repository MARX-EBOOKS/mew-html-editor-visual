import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {engineSource} from '../tests/support/pdf-harness.mjs';
const f=JSON.parse(await readFile('tmp/me05-281-alignment-fixture.json','utf8'));
for(const mode of ['before','after']){
 let code=engineSource;
 if(mode==='after') for(const [position,text] of [['a','from'],['x','to'],['b','from'],['y','to']]){
  const side=['a','x'].includes(position)?position+' - 1':position;
  code=code.replace('/\\p{L}/u.test('+text+'.text['+side+'])','/\\p{L}{2}/u.test('+text+'.text.slice('+position+' - 1, '+position+' + 1))');
 }
 const window={};vm.runInNewContext(code,{window});const api={...window.PdfSelectionDiff,...window.PdfReviewProvider},loc=new api.PdfLocator({}, {document:{createElement:()=>({})}}),source=loc.sourceIndex(f.source),target=new api.PdfSourceIndex(loc,{raw:f.pdf,pages:f.pages});loc.getDocumentIndex=()=>target;loc.prepareSource(source,[target],{});
 const page=f.pages[297];console.log(mode,JSON.stringify({page,connections:source.connectionPairs([target]).map(([c])=>({start:c.start,end:c.end,targetStart:c.targetStart,targetEnd:c.targetEnd,tail:target.raw.slice(c.targetEnd-90,c.targetEnd)})),candidates:source.reviewCandidates([target]).map(c=>({start:c.sourceStart,end:c.sourceEnd,comparison:c.comparison}))}));
}
