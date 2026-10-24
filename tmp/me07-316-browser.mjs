import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
const fixture = JSON.parse(await readFile('tests/fixtures/pdf-selection-me07-316.json','utf8'));
const browser = await chromium.launch({channel:'msedge',headless:true});
try {
 const page = await browser.newPage({viewport:{width:1400,height:850}});
 page.on('pageerror',e=>console.log('PAGEERROR',e.message));
 await page.route('http://check.test/**', async route=>{
  const path = new URL(route.request().url()).pathname;
  if(path==='/api/reader/settings') return route.fulfill({json:{diffHighlight:true,selectionHighlight:true}});
  if(path==='/') return route.fulfill({contentType:'text/html',body:'<div id="editor" style="width:900px;height:500px"></div><div id="stage"><div class="pdfViewer"><div class="page" style="position:relative;width:800px;height:200px"><div class="textLayer"></div></div></div></div>'});
  const file = path.startsWith('/monaco/') ? 'node_modules/monaco-editor/'+path.slice(8) : 'public'+path;
  try {return route.fulfill({contentType:path.endsWith('.css')?'text/css':'text/javascript',body:await readFile(file)});} catch {return route.abort();}
 });
 await page.goto('http://check.test/');
 await page.addStyleTag({content:await readFile('public/pdfdiff/replacement-review.css','utf8')});
 await page.addStyleTag({content:'#stage{position:fixed;left:950px;top:0;width:400px;height:800px;overflow:auto}'});
 await page.addScriptTag({url:'/monaco/min/vs/loader.js'});
 await page.evaluate(()=>new Promise(r=>{require.config({paths:{vs:'/monaco/min/vs'}});require(['vs/editor/editor.main'],r);}));
 await page.addScriptTag({url:'/pdfdiff/replacement-review.js'});
 await page.addScriptTag({url:'/pdfdiff/pdf-review-provider.js'});
 await page.evaluate(()=>PdfReviewReady);
 await page.evaluate(f=>{
  window.editor=monaco.editor.create(document.getElementById('editor'),{value:f.html,language:'html',wordWrap:'on'});
  document.querySelector('.textLayer').textContent=f.layerRaw;
  window.mockViewer={container:document.getElementById('stage'),viewer:document.querySelector('.pdfViewer'),eventBus:{on(){},off(){}},pdfDocument:{numPages:1,getPage:()=>new Promise(()=>{})},getPageView:()=>({div:document.querySelector('.page')}),_getVisiblePages:()=>({views:[{id:1}]})};
  window.lastNotice=null; addEventListener('pdf-selection-difference',e=>{ window.lastNotice=e.detail; });
 },fixture);
 await page.addScriptTag({url:'/pdfdiff/pdf-selection.js'});
 await page.waitForFunction(()=>!!window.PdfSelection);
 await page.evaluate(()=>{PdfSelection.attachViewer(mockViewer);PdfSelection.attachEditor(editor);editor.revealLine(6);});
 const marker=page.locator('.mew-ocr-diff-insert');
 await marker.waitFor({timeout:8000});
 console.log('marker',await page.evaluate(()=>editor.getModel().getAllDecorations().filter(d=>d.options.beforeContentClassName==='mew-ocr-diff-insert').map(d=>({range:d.range,hover:d.options.hoverMessage}))));
 await marker.click();
 await page.waitForFunction(()=>!document.querySelector('.replacement-review').hidden,{timeout:5000});
 console.log('notice',await page.evaluate(()=>JSON.stringify(lastNotice?.notices?.map(n=>({html:n.html,pdf:n.pdf,source:n.source&&[n.source.start,n.source.end]})))));
 console.log('comparison',await page.locator('[data-comparison]').textContent());
 await page.screenshot({path:'tmp/me07-316-click.png'});
 assert.match(await page.locator('[data-comparison]').textContent(),/12763/);
 for (const linked of [true]) {
  await page.evaluate(linked=>{ReplacementReview.close();PdfSelection.setSelectionHighlight(linked);editor.setPosition({lineNumber:1,column:1});},linked);
  await marker.click();
  await page.waitForFunction(()=>!document.querySelector('.replacement-review').hidden);
  assert.match(await page.locator('[data-comparison]').textContent(),/12763/);
  console.log('PASS marker click, selection linking:',linked);
 }
 const anchor = await page.evaluate(()=>{
  const d=editor.getModel().getAllDecorations().find(d=>d.options.beforeContentClassName==='mew-ocr-diff-insert');
  return editor.getModel().getOffsetAt(d.range.getStartPosition());
 });
 assert.equal(anchor,fixture.html.indexOf('</h1>'));
 await page.locator('[data-apply]').click();
 assert.equal(await page.evaluate(()=>editor.getValue()),fixture.html.replace('</h1>','12763</h1>'));
 await page.evaluate(()=>editor.trigger('test','undo'));
 assert.equal(await page.evaluate(()=>editor.getValue()),fixture.html);
 console.log('PASS marker before closing h1, real click opens review, replacement stays inside h1, single undo restores source');
} finally {await browser.close();}
