import {launchBrowser} from '../tests/support/browser.mjs';
const browser=await launchBrowser();
try {
 const p=await browser.newPage({viewport:{width:1700,height:1050}});
 await p.addInitScript(()=>{window.probeEvents=[];addEventListener('pdf-selection-sources',e=>{const d=e.detail;probeEvents.push({at:Math.round(performance.now()),raw:d.index?.raw.length,targets:d.targets.map(t=>({full:!!t.pages,length:t.raw.length})),connections:d.index?.connectionPairs(d.targets).map(([c,t])=>({full:!!t.pages,start:c.start,end:c.end,targetStart:c.targetStart,targetEnd:c.targetEnd}))});if(probeEvents.length>25)probeEvents.shift()})});
 await p.goto('http://127.0.0.1:17000/?volume=5&page=281&mode=source');
 await p.waitForFunction(()=>window.readerMonaco?.editor&&window.PdfSelection?.viewer?.getPageView(297)?.div.querySelector('.textLayer span'),null,{timeout:60000});
 const snapshot=async label=>console.log(label,JSON.stringify(await p.evaluate(()=>{const ed=readerMonaco.editor,m=ed.getModel();return{page:PdfSelection.viewer.currentPageNumber,ready:!!PdfSelection.locator.getDocumentIndex(PdfSelection.viewer.pdfDocument),marks:m.getAllDecorations().filter(d=>(d.options.inlineClassName||'').includes('mew-ocr')).map(d=>({text:m.getValueInRange(d.range),line:d.range.startLineNumber,column:d.range.startColumn})),events:probeEvents.slice(-3)}})));
 await snapshot('initial');await p.waitForTimeout(1200);await snapshot('idle');
 await p.waitForFunction(()=>PdfSelection.locator.getDocumentIndex(PdfSelection.viewer.pdfDocument),null,{timeout:60000});await p.waitForTimeout(300);await snapshot('indexed');
 await p.evaluate(()=>PdfSelection.viewer.scrollPageIntoView({pageNumber:299}));await p.waitForTimeout(1700);await snapshot('away');
 await p.evaluate(()=>PdfSelection.viewer.scrollPageIntoView({pageNumber:298}));await p.waitForTimeout(1700);await snapshot('back');
}finally{await browser.close()}
