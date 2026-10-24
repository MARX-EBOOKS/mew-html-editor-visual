import { chromium } from 'playwright';
import assert from 'node:assert/strict';
const browser=await chromium.launch({headless:true,channel:"msedge"});
try {
 const page=await browser.newPage(); const errors=[],requests=[];
 page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>requests.push(r.url()));
 await page.goto('http://localhost:49317/');
 await page.waitForFunction(()=>window.PdfSelection && window.PdfReviewProvider && window.readerMonaco?.editor,{timeout:30000});
 await page.evaluate(()=>window.PdfReviewReady);
 console.log(JSON.stringify({loaded:await page.evaluate(()=>({engine:!!PdfSelectionDiff,selection:!!PdfSelection,review:!!PdfReviewProvider,local:typeof PdfSelectionDiff.textDiff,oldEngine:!!window.PdfLocalTextDiff})),errors,forbidden:requests.filter(url=>/local-text-diff|local-ocr-text-reader|defaultLinesDiffComputer|ocr.text|text-manifest/.test(url))}));
 assert.deepEqual(errors,[]);assert.equal(requests.filter(url=>/local-text-diff|local-ocr-text-reader|defaultLinesDiffComputer/.test(url)).length,0);
 const result=await page.evaluate(()=>{
  const api=PdfSelectionDiff,loc=api.createLocator({}, {document});
  const html='<p>Alpha beta WRONG</p>',index=loc.sourceIndex(html);
  const target={raw:'Alpha\nbeta RIGHT\n',fontVersion:0,parts:[{start:0,end:6,font:{bold:false,italic:false}},{start:6,end:10,font:{bold:true,italic:true}},{start:10,end:17,font:{bold:false,italic:false}}]};
  const c=loc.rememberConnection(index,0,index.raw.length,target,{start:0,end:target.raw.length});
  const d=api.connectionDiff(index,target,c);
  const text=api.reviewCandidates(index,[target]),fonts=api.formatDifferences(index,[[c,target]]);
  const edited=api.previewEdits(html,fonts.flatMap(item=>item.options[0].edits));
  const cacheSame=api.connectionDiff(index,target,c)===d;
  const repeated=api.formatDifferences(index,[[c,target]]).map(item=>item.formats.length);
  target.parts[1].font.bold=false;target.parts[1].font.italic=false;target.fontVersion++;
  const refreshed=api.connectionDiff(index,target,c);
  return {texts:text.map(item=>item.comparison),fonts:fonts.map(item=>item.text),edited,cacheSame,repeated,refreshedFonts:refreshed.fonts.length,alignmentSame:refreshed.parts===d.parts};
 });
 console.log(JSON.stringify(result));assert.deepEqual(result.fonts,['beta']);assert.equal(result.edited,'<p>Alpha <b><i>beta</i></b> WRONG</p>');assert.ok(result.cacheSame && result.alignmentSame);assert.equal(result.refreshedFonts,0);
 await page.goto('http://localhost:49317/index.html');await page.evaluate(()=>window.PdfReviewReady);assert.ok(await page.evaluate(()=>!!window.ReplacementReview));console.log('reader and editor loading passed');
} finally {await browser.close();}

