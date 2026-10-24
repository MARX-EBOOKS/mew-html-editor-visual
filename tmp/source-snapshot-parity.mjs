import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const diff=fs.readFileSync('public/pdfdiff/pdf-selection-diff.js','utf8');
function load(path) {
 const source=fs.readFileSync(path,'utf8'),window={};
 const section=source.slice(source.indexOf('// Source/PDF mapping and candidate generation.'),source.indexOf('// Shared popup and session initialization.'));
 vm.runInNewContext(diff+'\n(()=>{const toolbox=window.PdfSelectionDiff;'+section+';window.Reader=PdfLocator;window.Index=typeof PdfSourceIndex==="undefined"?null:PdfSourceIndex;})();',{window});
 const document={createElement(){return {content:{textContent:''},set innerHTML(text){this.content.textContent=text.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&#(\d+);/g,(_,n)=>String.fromCodePoint(+n));}};}};
 const reader=new window.Reader({}, {document,isCurrent:()=>true,waitForIdle:async()=>{}});
 return {window,reader,raw:raw=>window.Index?new window.Index(reader,{raw}):{raw,normalized:reader.normalized(raw),connections:new WeakMap(),pageScopes:new WeakMap()}};
}
const old=load('tmp/snapshot-before-pdf-review-provider.js'),current=load('public/pdfdiff/pdf-review-provider.js');
const clean=value=>JSON.parse(JSON.stringify(value));
const samples=['<p>Alpha <b>beta</b> gamma.</p>','<p>甲乙<i>𠀀丙</i>丁。</p>','<p>A&amp;B &#223; &lt;work&gt;.</p>','<p>Die Straße mit inter-\nnationaler Geschichte.</p>'];
for(const markup of samples) {
 const a=old.reader.sourceIndex(markup),b=current.reader.sourceIndex(markup);
 for(const key of ['source','raw','starts','ends','formats','normalized']) assert.deepEqual(clean(b[key]),clean(a[key]),key);
 assert.ok(b instanceof current.window.Index);
}
for(let i=0;i<80;i++) {
 const raw=`Before passage ${i} with unique working words and 𠀀 characters after.`,at=raw.indexOf('working');
 const changed=raw.slice(0,at)+(i%3===0?'work':i%3===1?'working nicely':'WORKING')+raw.slice(at+7);
 const a=old.raw(raw),b=old.raw(changed),c=current.raw(raw),d=current.raw(changed);
 const one=old.reader.rememberConnection(a,0,raw.length,b,{start:0,end:changed.length});
 const two=c.rememberConnection(0,raw.length,d,{start:0,end:changed.length});
 assert.deepEqual(clean(two),clean(one));
 for(const [start,end,reverse,marked] of [[at,at+7,false,false],[at,at,false,true],[at,at+4,true,false]]) {
  assert.deepEqual(clean(c.connectedRange(d,start,end,reverse,undefined,marked)),clean(old.reader.connectedRange(a,b,start,end,reverse,undefined,marked)));
 }
 assert.deepEqual(clean(c.sourcePageScope(d,true)),clean(old.reader.sourcePageScope(a,b,true)));
 const entry={text:'working',before:raw.slice(0,at),after:raw.slice(at+7)};
 assert.deepEqual(clean(c.locate(entry)),clean(old.reader.locate(raw,entry)));
 const offset=7,end=raw.length-7,scope={start:offset,end};
 const local=old.reader.locate(raw.slice(offset,end),entry);
 if(local){local.start+=offset;local.end+=offset;}
 assert.deepEqual(clean(c.locate(entry,scope)),clean(local));
}
// Collapsed-range browsers with no client rects already produce no overlay before this refactor.
for(const [path,currentVersion] of [['tmp/snapshot-before-replacement-review.js',false],['public/pdfdiff/replacement-review.js',true]]) {
 const window={},source=fs.readFileSync(path,'utf8').split('// Shared review popup, session, navigation and saving.')[0];
 vm.runInNewContext(source,{window});
 const part={node:{length:3},start:0,end:3},index={raw:'abc',parts:[part],partsInRange:()=>[part]};
 const document={createRange:()=>({setStart(){},setEnd(){},getClientRects:()=>[]})};
 const highlights=window.ReviewHighlights.create({document,lowerBound:old.reader.lowerBound});
 const div={clientWidth:10,clientHeight:10,offsetWidth:10,offsetHeight:10,clientLeft:0,clientTop:0,getBoundingClientRect:()=>({left:0,top:0,width:10,height:10})};
 assert.equal(highlights.measureHighlights(div,index,[{start:1,end:1}]).boxes.length,0);
 console.log(currentVersion?'Current empty collapsed-range geometry: unchanged':'Baseline empty collapsed-range geometry: no overlay');
}
console.log('PASS: 4 HTML/Unicode snapshots and 80 old/new connection, scope, forward/reverse and scoped-location parity cases.');
