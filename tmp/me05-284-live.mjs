import {writeFile} from 'node:fs/promises';
import {launchBrowser} from '../tests/support/browser.mjs';
const browser=await launchBrowser();
try { const page=await browser.newPage({viewport:{width:1700,height:1050}}); page.on('pageerror',e=>console.log('ERROR',e.message));
await page.goto('http://127.0.0.1:17000/?volume=5&page=284&mode=source');
await page.waitForFunction(()=>window.readerMonaco?.editor&&window.PdfSelection?.locator?.getDocumentIndex(PdfSelection.viewer?.pdfDocument),null,{timeout:60000});
await page.waitForTimeout(1500);
const result=await page.evaluate(()=>{const l=PdfSelection.locator,m=readerMonaco.editor.getModel(),targets=l.environment.getTargets?.()||[],i=l.editorSourceIndex(m,targets),full=l.getDocumentIndex(PdfSelection.viewer.pdfDocument);l.prepareSource(i,[full,...targets],PdfSelection.viewer.pdfDocument);return {source:m.getValue(),pdf:full.raw,connections:i.connectionPairs([full,...targets]).map(([c,t])=>({start:c.start,end:c.end,targetStart:c.targetStart,targetEnd:c.targetEnd,html:i.raw.slice(c.start,c.end),pdf:t.raw.slice(c.targetStart,c.targetEnd),parts:i.connectionDiff(t,c).parts})),candidates:i.reviewCandidates([full,...targets]).map(c=>({start:c.sourceStart,end:c.sourceEnd,comparison:c.comparison})),decorations:m.getAllDecorations().filter(d=>(d.options.inlineClassName||'').includes('mew-ocr')).map(d=>({text:m.getValueInRange(d.range),hover:d.options.hoverMessage})),targets:targets.map(t=>({raw:t.raw,connections:(i.connections.get(t)||[]).map(c=>({start:c.start,end:c.end,targetStart:c.targetStart,targetEnd:c.targetEnd,parts:i.connectionDiff(t,c).parts}))})),pages:full.pages.map(p=>({number:p.number,start:p.start,end:p.end}))}});
console.log(JSON.stringify({connections:result.connections?.map(c=>({start:c.start,end:c.end,htmlTail:c.html.slice(-130),pdfTail:c.pdf.slice(-130),tail:c.parts.slice(-12),valid:c.parts.map(p=>p.html).join("")===c.html})),candidates:result.candidates,decorations:result.decorations},null,2)); await writeFile('tmp/me05-284-live.json',JSON.stringify(result));
} finally {await browser.close()}



