import { chromium } from 'playwright';
const browser=await chromium.launch({channel:'msedge',headless:true});
try {
 const page=await browser.newPage({viewport:{width:1704,height:500}});
 page.on('pageerror', e=>console.log('PAGEERROR',e.message));
 await page.goto('http://127.0.0.1:17000/?volume=7&page=153&mode=source');
 await page.waitForFunction(()=>window.readerMonaco?.editor && window.PdfSelection?.viewer?.getPageView(PdfSelection.viewer.currentPageNumber-1)?.div.querySelector('.textLayer span'),null,{timeout:60000});
 console.log(JSON.stringify(await page.evaluate(async()=>{
  const s=PdfSelection, loc=s.locator,editor=readerMonaco.editor, index=loc.editorSourceIndex(editor.getModel());
  const div=s.viewer.getPageView(s.viewer.currentPageNumber-1).div;
  const targets=[...loc.getDocumentIndex(s.viewer.pdfDocument)?[loc.getDocumentIndex(s.viewer.pdfDocument)]:[]];
  console.log(div.textContent.slice(0,100));
  const start=index.raw.indexOf('verschiedenen')+'verschied'.length;
  const entry={index,start,end:start+1,marked:true,text:'e',before:index.raw.slice(start-160,start),after:index.raw.slice(start+1,start+161)};
  const locations=await loc.findLocations(s.viewer.pdfDocument,[entry]);
  const item={sourceStart:start,sourceEnd:start+1,comparison:{html:'e',pdf:''},pdfSource:{index,start,end:start+1}};
  await ReplacementReview.open('pdf-ocr',editor,String(start)+':'+String(start+1),0,{pdf:s.viewer.pdfDocument,notice:{source:{index,start,end:start+1},target:locations[0].targets[0].target,html:'e',pdf:''}});
  await new Promise(r=>setTimeout(r,400));
  return {page:s.viewer.currentPageNumber,word:index.raw.slice(start-15,start+20),locations:locations.map(x=>x.targets.map(t=>({page:t.pageNumber,text:t.text,range:t.range,start:t.start,end:t.end,target:t.target&&{start:t.target.start,end:t.target.end,text:t.target.index.raw.slice(t.target.start-35,t.target.end+35)}}))),marks:s.highlightRects(),popup:document.querySelector('.replacement-review').getBoundingClientRect().toJSON(),scrollY:window.scrollY,spans:[...div.querySelectorAll('.textLayer span')].filter(x=>x.textContent.includes('verschied')).map(x=>({text:x.textContent,rect:x.getBoundingClientRect().toJSON()}))};
 }),null,2));
 await page.screenshot({path:'tmp/me07-153-caret-popup-after.png'});
} finally {await browser.close();}




