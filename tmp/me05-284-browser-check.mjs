import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {launchBrowser} from '../tests/support/browser.mjs';
const fixture=JSON.parse(await readFile('tests/fixtures/pdf-selection-me05-284.json','utf8'));
const browser=await launchBrowser();
try {
 const page=await browser.newPage({viewport:{width:1700,height:1050}});
 await page.goto('http://127.0.0.1:17000/?volume=5&page=284&mode=source');
 await page.waitForFunction(()=>window.readerMonaco?.editor&&window.PdfSelection?.locator?.getDocumentIndex(PdfSelection.viewer?.pdfDocument),null,{timeout:60000});
 await page.waitForTimeout(1000);
 const result=await page.evaluate(f=>{
  const active=PdfSelection.locator, editor=readerMonaco.editor, model=editor.getModel();
  const marks=model.getAllDecorations().filter(d=>(d.options.inlineClassName||'').includes('mew-ocr')).map(d=>model.getValueInRange(d.range));
  const api=PdfSelectionDiff, l=new active.constructor({}, {document}),t=new api.PdfSourceIndex(l,{raw:f.pdf});l.getDocumentIndex=()=>t;
  let source=f.source.replace('Kölnischen Zeitung','Kölnische Zeitung'),version=1;
  const m={getValue:()=>source,getVersionId:()=>version},pdf={},i=l.editorSourceIndex(m,[t]);l.prepareSource(i,[t],pdf);
  const item=i.reviewCandidates([t]).find(c=>c.comparison.pdf==='n');if(!item)throw new Error('missing letter absent');
  source=api.previewEdits(source,item.options[0].edits);version++;
  const revised=l.editorSourceIndex(m,[t]);l.prepareSource(revised,[t],pdf);
  return {marks,corrected:source.includes('Kölnischen Zeitung'),stale:revised.reviewCandidates([t]).some(c=>c.comparison.pdf==='n')};
 },fixture);
 assert.ok(!result.marks.some(s=>/Wo|ist|dem|–/.test(s)),JSON.stringify(result));
 assert.equal(result.corrected,true);assert.equal(result.stale,false);
 console.log('PASS: live ME05-284 has no false word/dash marks; browser snapshot drops corrected missing-letter candidate',JSON.stringify(result));
}finally{await browser.close()}
