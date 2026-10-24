import assert from 'node:assert/strict';
import {launchBrowser} from '../tests/support/browser.mjs';
const browser=await launchBrowser();
try{
 const page=await browser.newPage({viewport:{width:1700,height:1050}}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:17000/?volume=5&page=281&mode=source');
 await page.waitForFunction(()=>window.readerMonaco?.editor&&window.PdfSelection?.locator?.getDocumentIndex(PdfSelection.viewer?.pdfDocument),null,{timeout:60000});
 await page.waitForTimeout(500);
 const marks=await page.evaluate(()=>{const m=readerMonaco.editor.getModel();return m.getAllDecorations().filter(d=>(d.options.inlineClassName||'').includes('mew-ocr')).map(d=>m.getValueInRange(d.range))});
 console.log('marks',JSON.stringify(marks));assert(!marks.some(x=>/Anforder/.test(x)));
 const point=await page.evaluate(()=>{const ed=readerMonaco.editor,m=ed.getModel(),d=m.getAllDecorations().find(d=>(d.options.inlineClassName||'').includes('mew-ocr')&&m.getValueInRange(d.range)==='h');ed.revealPositionInCenter(d.range.getStartPosition());return {lineNumber:d.range.startLineNumber,column:d.range.startColumn}});
 await page.waitForTimeout(200);
 const box=await page.evaluate(pos=>{const ed=readerMonaco.editor,p=ed.getScrolledVisiblePosition(pos),r=ed.getDomNode().getBoundingClientRect();return{x:r.left+p.left+2,y:r.top+p.top+p.height/2}},point);
 await page.mouse.click(box.x,box.y);
 await page.locator('.replacement-review').waitFor({state:'visible',timeout:7000});
 console.log('popup',JSON.stringify(await page.locator('.replacement-review [data-comparison] mark').allTextContents()));
 assert.deepEqual(await page.locator('.replacement-review [data-comparison] mark').allTextContents(),['h','b']);
 await page.evaluate(()=>ReplacementReview.close());
 await page.evaluate(()=>PdfSelection.viewer.scrollPageIntoView({pageNumber:299}));await page.waitForTimeout(1700);
 await page.evaluate(()=>PdfSelection.viewer.scrollPageIntoView({pageNumber:298}));await page.waitForTimeout(1700);
 const back=await page.evaluate(()=>{const m=readerMonaco.editor.getModel();return m.getAllDecorations().filter(d=>(d.options.inlineClassName||'').includes('mew-ocr')).map(d=>m.getValueInRange(d.range))});
 console.log('back',JSON.stringify(back));assert(!back.some(x=>/Anforder/.test(x)));assert.deepEqual(errors,[]);
 await page.screenshot({path:'tmp/me05-281-fixed.png'});console.log('PASS: real page popup and scroll return');
}finally{await browser.close()}
