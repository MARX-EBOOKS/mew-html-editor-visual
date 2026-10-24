import { launchBrowser } from '../tests/support/browser.mjs';
const browser=await launchBrowser();
try {
 const page=await browser.newPage({viewport:{width:1700,height:1050}});
 page.on('pageerror',e=>console.log('ERROR',e.message));
 await page.goto('http://127.0.0.1:17000/?volume=5&page=281&mode=source');
 await page.waitForFunction(()=>window.readerMonaco?.editor && window.PdfSelection?.locator?.getDocumentIndex(PdfSelection.viewer?.pdfDocument),null,{timeout:60000});
 await page.waitForTimeout(1500);
 console.log('BEFORE',JSON.stringify(await page.evaluate(()=>{
  window.notices=[];addEventListener('pdf-selection-difference',e=>notices.push(e.detail.notices.map(n=>({html:n.html,pdf:n.pdf,source:n.source&&[n.source.start,n.source.end],target:n.target&&[n.target.start,n.target.end]}))));
  const ed=readerMonaco.editor,m=ed.getModel(),ix=PdfSelection.locator.editorSourceIndex(m);
  const at=ix.raw.indexOf('Anforderungen',ix.raw.indexOf('Anforderungen')+1);
  const marks=m.getAllDecorations().filter(d=>(d.options.inlineClassName||'').includes('mew-ocr')).map(d=>({text:m.getValueInRange(d.range),range:d.range}));
  ed.revealPositionInCenter(m.getPositionAt(ix.starts[at]));
  return {at,marks,connections:ix.connectionPairs(PdfSelection.locator.environment.getTargets()).map(([c,t])=>({start:c.start,end:c.end,targetStart:c.targetStart,targetEnd:c.targetEnd,raw:t.raw.slice(380,480)}))};
 })));
 await page.waitForTimeout(300);
 const point=await page.evaluate(()=>{const ed=readerMonaco.editor,m=ed.getModel(),at=m.getValue().lastIndexOf('Anforderungen'),p=ed.getScrolledVisiblePosition(m.getPositionAt(at+1)),r=ed.getDomNode().getBoundingClientRect();return{x:r.left+p.left,y:r.top+p.top+p.height/2}});
 await page.mouse.click(point.x,point.y);
 await page.waitForTimeout(1800);
 console.log('AFTER',JSON.stringify(await page.evaluate(()=>({notices,selected:readerMonaco.editor.getSelection().toString(),status:PdfSelection.status,popup:[...document.querySelectorAll('.replacement-review')].map(n=>({hidden:n.hidden,text:n.innerText}))}))));
 await page.screenshot({path:'tmp/me05-281-click.png'});
}finally{await browser.close()}


