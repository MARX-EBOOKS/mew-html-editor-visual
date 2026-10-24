import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {engineSource} from '../tests/support/pdf-harness.mjs';
const fixture=JSON.parse(await readFile('tmp/me05-281-alignment-fixture.json','utf8'));
for(const mode of ['baseline','merge']){
 const window={};let code=engineSource;
 if(mode==='merge') code=code.replace('previous.end >= range.start && previous.hit.end >= range.hit.start','previous.end + size >= range.start && previous.hit.end + size >= range.hit.start');
 code=code.replace('if (anchors.length < 2) continue;', "if (anchors.length < 2) continue; console.log('ANCHORS',JSON.stringify(anchors.filter(a=>a.at>300&&a.at<460).map(a=>({...a,text:text.slice(a.at,a.at+size)}))));");
 code=code.replace('} else confirmed.push({ ...range, distance });',`} else { console.log('SPLIT',JSON.stringify({left:length=left.length, range,previous:previous&&{start:previous.start,end:previous.end,hit:previous.hit,distance:previous.distance},distance})); confirmed.push({ ...range, distance }); }`.replace('length=left.length','left.length'));
 vm.runInNewContext(code,{window,console});const api={...window.PdfSelectionDiff,...window.PdfReviewProvider},loc=new api.PdfLocator({}, {document:{createElement:()=>({})}}),source=loc.sourceIndex(fixture.source),target=new api.PdfSourceIndex(loc,{raw:fixture.pdf,pages:fixture.pages});
 target.sourcePageScope(source,true);
 for(const c of target.connections.get(source)||[])source.rememberConnection(c.targetStart,c.targetEnd,target,{start:c.start,end:c.end});
 console.log(mode,JSON.stringify({connections:source.connectionPairs([target]).map(([c])=>({start:c.start,end:c.end,targetStart:c.targetStart,targetEnd:c.targetEnd,distance:c.distance})),candidates:source.reviewCandidates([target]).map(c=>({start:c.sourceStart,end:c.sourceEnd,comparison:c.comparison}))}));
}
