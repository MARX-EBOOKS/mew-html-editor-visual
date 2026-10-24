import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { chromium } from 'playwright';
import { getDocument } from '../node_modules/pdfjs-dist/legacy/build/pdf.mjs';
import { DefaultLinesDiffComputer } from '../node_modules/monaco-editor/esm/vs/editor/common/diff/defaultLinesDiffComputer/defaultLinesDiffComputer.js';
const window={};
const engine=await readFile('public/pdfdiff/local-text-diff.js','utf8')+await readFile('public/pdfdiff/pdf-selection-diff.js','utf8');
vm.runInNewContext(engine,{window});const api=window.PdfSelectionDiff;api.useMonaco(new DefaultLinesDiffComputer());
const loc=api.createLocator({}, {document:{createElement:()=>({})},isCurrent:()=>true,waitForIdle:async()=>{}});
const task=getDocument({data:new Uint8Array(await readFile('../马恩全集德文/mew_band07.pdf')),useSystemFonts:true});
const pdf=await task.promise;const page=await pdf.getPage(93);const content=await page.getTextContent();
const full=await loc.indexDocument({numPages:1,getPage:()=>page});
const html=await readFile('../MEW_BRIEF/7/ME07-069.html','utf8');
function check(locator,api,index,target,label){
 locator.prepareSource(index,[target],{});
 for(const word of ['Anklagezustand','Kunst- und Gewerbemuseum']){
  const start=index.raw.indexOf(word), hit=locator.connectedRange(index,target,start,start+word.length,false,undefined,true);
  assert.ok(hit, label+': '+word);assert.equal(target.raw.slice(hit.start,hit.end),word,label+': '+word);
  const reverse=locator.connectedRange(index,target,hit.start,hit.end,true);
  assert.equal(index.raw.slice(reverse.start,reverse.end),word);
 }
 const items=api.reviewCandidates(index,[target]);
 assert.ok(!items.some(i=>i.comparison.html.includes('Anklagezustand')||i.comparison.html.includes('Gewerbemuseum')));
 console.log(label, 'forward/reverse mapping and review candidates PASS',items.length);
}
for(const monaco of [true])for(const text of [html,html.replace(/\r\n/g,'\n')]){
 api.useMonaco(monaco?new DefaultLinesDiffComputer():null);
 check(loc,api,loc.sourceIndex(text),loc.sourceIndex(full.raw),`background ${monaco?'Monaco':'local'} ${text===html?'CRLF':'LF'}`);
}
const browser=await chromium.launch({channel:'msedge',headless:true});
try{
 const tab=await browser.newPage();await tab.route('http://probe.test/**',async route=>{const path=new URL(route.request().url()).pathname;if(path.startsWith('/api/'))return route.abort();if(path==='/')return route.fulfill({contentType:'text/html',body:'<!doctype html>'});return route.fulfill({contentType:'text/javascript',body:await readFile(path.startsWith('/monaco/')?'node_modules/monaco-editor/'+path.slice(8):'node_modules/pdfjs-dist/build/'+path.slice(1))});});await tab.goto('http://probe.test/');await tab.addStyleTag({path:'node_modules/pdfjs-dist/web/pdf_viewer.css'});await tab.setContent('<div id="stage"><div class="pdfViewer"><div class="page" data-page-number="1" style="position:relative;width:800px;height:1000px"><div class="textLayer"></div></div></div></div>');
 await tab.addStyleTag({path:'node_modules/pdfjs-dist/web/pdf_viewer.css'});await tab.addScriptTag({content:engine});await tab.addScriptTag({content:await readFile('public/pdfdiff/pdf-review-provider.js','utf8')});
 await tab.evaluate(async()=>{await PdfReviewReady;const create=PdfReviewProvider.createLocator;PdfReviewProvider.createLocator=(o,e)=>{window.probeEnv=e;return create(o,e);};});
 await tab.addScriptTag({content:await readFile('public/pdfdiff/pdf-selection.js','utf8')});await tab.waitForFunction(()=>window.PdfSelection);
 await tab.addStyleTag({content:'.textLayer{position:absolute;inset:0;line-height:1}.textLayer span{position:absolute;white-space:pre;font-family:serif;font-size:calc(var(--total-scale-factor)*var(--font-height));transform:scaleX(var(--scale-x,1));transform-origin:0 0}'});const result=await tab.evaluate(async ({content,html,viewport})=>{
  const layer=document.querySelector('.textLayer');
  const lib=await import('http://probe.test/pdf.mjs');layer.parentElement.style.setProperty('--total-scale-factor','1');await new lib.TextLayer({textContentSource:content,container:layer,viewport}).render();
  const div=document.querySelector('.page');PdfSelection.attachViewer({container:document.querySelector('#stage'),viewer:document.querySelector('.pdfViewer'),currentPageNumber:1,_getVisiblePages:()=>({views:[{id:1}]}),getPageView:()=>({div}),eventBus:{on(){},off(){}},pdfDocument:{numPages:1,getPage:()=>new Promise(()=>{})}});
  const target=probeEnv.getVisiblePages()[0].index;const loc=PdfSelection.locator;const index=loc.sourceIndex(html);loc.prepareSource(index,[target],{});
  const words=['Anklagezustand','Kunst- und Gewerbemuseum'].map(word=>{const start=index.raw.indexOf(word),hit=loc.connectedRange(index,target,start,start+word.length,false,undefined,true),back=hit&&loc.connectedRange(index,target,hit.start,hit.end,true);return {word,mapped:hit&&target.raw.slice(hit.start,hit.end),reverse:back&&index.raw.slice(back.start,back.end)};});
  const start=index.raw.indexOf('Linientruppen'),end=index.raw.indexOf('Anklagezustand')+'Anklagezustand'.length;const hit=loc.connectedRange(index,target,start,end,false,undefined,true);const measured=PdfReviewProvider.measureHighlights(div,target,[hit],hit);const anchor=loc.reviewAnchor({pdfSource:{index,start,end}},index);const noteTop=[...layer.querySelectorAll('span')].find(n=>n.textContent==='Kunst-').getBoundingClientRect().top;const pageBox=div.getBoundingClientRect();const highlightBottom=Math.max(...measured.boxes.map(b=>pageBox.top+(b.y+b.h)*pageBox.height));
  return {words,highlightBottom,anchorBottom:anchor?.bottom,noteTop,rects:[...layer.querySelectorAll('span')].filter(n=>/Kunst|Wenn|Anklage/.test(n.textContent)).map(n=>({text:n.textContent,css:n.style.cssText,rect:n.getBoundingClientRect().toJSON()})),noteContext:target.raw.slice(target.raw.indexOf('Kunst-')-50,target.raw.indexOf('Kunst-')+90),tail:target.raw.slice(-100),bad:PdfSelectionDiff.reviewCandidates(index,[target]).filter(i=>i.comparison.html.includes('Anklagezustand')||i.comparison.html.includes('Gewerbemuseum')).length};
 },{content,html,viewport:{scale:1,rotation:0,rawDims:page.getViewport({scale:1}).rawDims}});
 console.log(JSON.stringify(result));for(const row of result.words){assert.equal(row.mapped,row.word);assert.equal(row.reverse,row.word);}assert.equal(result.bad,0);assert.ok(result.highlightBottom<result.noteTop,'body highlight excludes displaced footnote');assert.ok(result.anchorBottom<result.noteTop,'popup anchor excludes displaced footnote');console.log('visible layer PASS',JSON.stringify(result));
}finally{await browser.close();await task.destroy();}

