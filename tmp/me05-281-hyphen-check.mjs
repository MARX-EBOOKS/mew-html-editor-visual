import {readFile} from 'node:fs/promises';
import {launchBrowser} from '../tests/support/browser.mjs';
const original=await readFile('public/pdfdiff/pdf-selection-diff.js','utf8');
const browser=await launchBrowser();
try {await Promise.all(['significance','normalization'].map(async variant=>{
 const page=await browser.newPage({viewport:{width:1700,height:1050}});
 let changed=original;
 if(variant==='significance') changed=changed.replace('[\\s\\-\\u00ad\\u2010\\u2011\\d]','[\\s\\d]');
 else changed=changed.replace(/raw\.matchAll\(.*?\) \{/,'raw.matchAll(/[\\s\\S]/gu)) {').replace('    if (match[1] || char === "\\u00ad") continue;','');
 await page.route('**/pdfdiff/pdf-selection-diff.js',r=>r.fulfill({body:changed,contentType:'text/javascript'}));
 await page.goto('http://127.0.0.1:17000/?volume=5&page=281&mode=source');
 await page.waitForFunction(()=>window.readerMonaco?.editor&&window.PdfSelection?.locator?.getDocumentIndex(PdfSelection.viewer?.pdfDocument),null,{timeout:60000});
 await page.waitForTimeout(1000);
 const result=await page.evaluate(()=>{const ed=readerMonaco.editor,m=ed.getModel(),l=PdfSelection.locator,ix=l.editorSourceIndex(m),at=ix.raw.indexOf('Anforderungen',ix.raw.indexOf('Anforderungen')+1),targets=[...l.environment.getTargets(),l.getDocumentIndex(PdfSelection.viewer.pdfDocument)];l.prepareSource(ix,targets,PdfSelection.viewer.pdfDocument);return{at,candidates:ix.reviewCandidates(targets).filter(x=>x.sourceStart<at+20&&x.sourceEnd>=at-5).map(x=>({start:x.sourceStart,end:x.sourceEnd,comparison:x.comparison})),marks:m.getAllDecorations().filter(d=>d.range.startLineNumber===7&&(d.options.inlineClassName||'').includes('mew-ocr')).map(d=>({text:m.getValueInRange(d.range),column:d.range.startColumn}))}});
 console.log(variant,JSON.stringify(result));await page.close();
}));}finally{await browser.close()}
