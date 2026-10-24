import { chromium } from 'playwright';
const browser = await chromium.launch({channel:'msedge',headless:true});
try {
 const page = await browser.newPage({viewport:{width:1838,height:850}});
 page.on('pageerror',e=>console.log('ERROR',e.message));
 await page.goto('http://127.0.0.1:17000/?volume=7&page=438&mode=source'); console.log('LOADED',await page.title());
 await page.waitForFunction(()=>window.readerMonaco?.editor.getModel().getAllDecorations().some(d=>d.options.description==='PDF OCR text difference'),{timeout:90000});
 console.log('INITIAL',JSON.stringify(await page.evaluate(()=>{
  const editor=readerMonaco.editor, model=editor.getModel(), locator=PdfSelection.locator, index=locator.editorSourceIndex(model);
  window.trace=[];addEventListener('pdf-selection-difference',e=>trace.push(e.detail.notices.map(n=>({html:n.html,pdf:n.pdf,source:n.source&&[n.source.start,n.source.end]}))));
  return {decorations:model.getAllDecorations().filter(d=>d.options.description==='PDF OCR text difference').map(d=>({text:model.getValueInRange(d.range),range:d.range,hover:d.options.hoverMessage})),local:PdfSelectionDiff.textDiff('Österreichs','Ostreichs',true),connections:PdfSelection.viewer.currentPageNumber};
 })));
 await page.evaluate(()=>{
  window.mappingTrace=[];
  const l=PdfSelection.locator, old=l.connectedRange;
  l.connectedRange=function(s,t,a,b,...rest){const h=old.call(this,s,t,a,b,...rest);if(b-a<20)mappingTrace.push({html:s.raw.slice(a,b),targetLength:t.raw.length,layer:!!t.layer,connections:(s.connections.get(t)||[]).map(c=>[c.start,c.end,c.targetStart,c.targetEnd]),source:[a,b],hit:h&&[h.start,h.end],context:h&&t.raw.slice(h.start-10,h.end+10)});return h;};
  const measure=PdfReviewProvider.measureHighlights;
  PdfReviewProvider.measureHighlights=function(div,index,hits,focus){const result=measure(div,index,hits,focus);mappingTrace.push({measure:hits.map(h=>[h.start,h.end]),result:{count:result.count,boxes:result.boxes,notices:result.notices.length}});return result;};
 });
 for(const word of ['i','er']) {
  await page.evaluate(word=>{
   ReplacementReview.close(false);window.trace=[];window.mappingTrace=[];
   const e=readerMonaco.editor,m=e.getModel(), d=m.getAllDecorations().find(d=>d.options.description==='PDF OCR text difference'&&m.getValueInRange(d.range)===word),pos=d?d.range.getStartPosition():m.getPositionAt(m.getValue().indexOf(word));
   window.clickPos=pos;
   e.revealPositionInCenter(pos);e.setPosition({lineNumber:1,column:1});
  },word);
  await page.waitForTimeout(300);
  const point=await page.evaluate(()=>{const e=readerMonaco.editor,p=e.getScrolledVisiblePosition(clickPos),r=e.getDomNode().getBoundingClientRect();return {x:r.left+p.left+3,y:r.top+p.top+p.height/2};});
  await page.mouse.click(point.x,point.y);await page.waitForTimeout(1500);
  console.log('CLICK',word,JSON.stringify(await page.evaluate(()=>({trace,status:PdfSelection.status,popup:[...document.querySelectorAll('.replacement-review')].map(p=>({hidden:p.hidden,text:p.textContent}))}))));
  if (!(await page.locator('.replacement-review:not([hidden])').count())) throw new Error('Popup did not open: '+word); console.log('MAPTRACE',JSON.stringify(await page.evaluate(()=>mappingTrace)));
  console.log('DETAIL',JSON.stringify(await page.evaluate(()=>{
   const l=PdfSelection.locator,s=l.editorSourceIndex(readerMonaco.editor.getModel()),t=l.getDocumentIndex(PdfSelection.viewer.pdfDocument),pos=readerMonaco.editor.getModel().getOffsetAt(clickPos),a=l.lowerBound(s.ends,pos+1),b=a+1;
   const hit=l.connectedRange(s,t,a,b,false,undefined,true);
   return {a,b,html:s.raw.slice(a,b),hit:hit&&{start:hit.start,end:hit.end,context:t.raw.slice(hit.start-30,hit.end+30)},selection:readerMonaco.editor.getSelection(),candidates:PdfReviewProvider.reviewCandidates(s,[t]).filter(c=>Math.abs(c.sourceStart-a)<25)};
  })));
 }
 await page.evaluate(()=>{ReplacementReview.close(false);const e=readerMonaco.editor,m=e.getModel(),a=m.getValue().indexOf('Österreichs'),s=m.getPositionAt(a),t=m.getPositionAt(a+11);e.setSelection({startLineNumber:s.lineNumber,startColumn:s.column,endLineNumber:t.lineNumber,endColumn:t.column});});
 await page.waitForTimeout(1200);
 console.log('WORD',JSON.stringify(await page.evaluate(()=>({comparison:document.querySelector('[data-comparison]').innerHTML,trace}))));
 console.log('MAPPINGS',JSON.stringify(await page.evaluate(()=>{
  const l=PdfSelection.locator,s=l.editorSourceIndex(readerMonaco.editor.getModel()),t=l.getDocumentIndex(PdfSelection.viewer.pdfDocument);
  return (s.connections.get(t)||[]).map(c=>({range:[c.start,c.end],parts:PdfReviewProvider.connectionDiff(s,t,c).parts.filter(p=>p.changed)}));
 })));
}finally{await browser.close();}




