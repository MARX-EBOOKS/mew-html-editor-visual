import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {DefaultLinesDiffComputer} from '../node_modules/monaco-editor/esm/vs/editor/common/diff/defaultLinesDiffComputer/defaultLinesDiffComputer.js';
import {getDocument} from '../node_modules/pdfjs-dist/legacy/build/pdf.mjs';
const window={};
const provider=await readFile('public/pdfdiff/pdf-review-provider.js','utf8');
vm.runInNewContext(await readFile('public/pdfdiff/pdf-selection-diff.js','utf8')+'\n(()=>{const toolbox=window.PdfSelectionDiff;'+provider.slice(provider.indexOf('// Source/PDF mapping'),provider.indexOf('// Shared popup and session initialization.'))+';window.PdfLocator=PdfLocator;})();',{window});
window.PdfSelectionDiff.useMonaco(new DefaultLinesDiffComputer());
const locator=new window.PdfLocator({}, {document:{createElement:()=>({})},isCurrent:()=>true,waitForIdle:async()=>{}});
const task=getDocument({data:new Uint8Array(await readFile('../马恩全集德文/mew_band05.pdf')),useSystemFonts:true,wasmUrl: new URL('../node_modules/pdfjs-dist/wasm/',import.meta.url).pathname.replace(/^\/(\w:)/,'\u00241')});
const pdf=await task.promise;
const labels=await pdf.getPageLabels();
const n=labels.indexOf('278')+1;
const page=await pdf.getPage(n);
const {items}=await page.getTextContent();
const fonts=await locator.readPageFonts(page,items);
console.log('PAGE',n,'FONTS',[...fonts]);
console.log('HEADER ITEMS', items.slice(Math.max(0,items.findIndex(i=>i.str==='Rheinische')-10),items.findIndex(i=>i.str==='Rheinische')+5).map(i=>({text:i.str,font:i.fontName})));
console.log('ITEMS',items.filter(i=>/Neue|Rhein|Zeitung|Gesetz|Feudal/.test(i.str)).map(i=>({str:i.str,font:i.fontName,style:fonts.get(i.fontName)})));
const target=await locator.indexFonts({numPages:1,getPage:async()=>page});
const html=await readFile('../MEW_BRIEF/5/ME05-278.html','utf8');
const index=locator.sourceIndex(html);
locator.prepareSource(index,[target],pdf);
for(const [c,t] of index.connectionPairs([target])) {let at=c.start; for(const part of index.connectionDiff(t,c).parts){if(at<index.raw.indexOf('Zeitung')+8 && at+part.html.length>index.raw.indexOf('Neue')-5) console.log('ALIGN',JSON.stringify(part));at+=part.html.length;}}
for(const item of index.formatDifferences(index.connectionPairs([target]))){const revised=window.PdfSelectionDiff.previewEdits(html,item.options[0].edits); const corrected=locator.sourceIndex(revised); if(corrected.raw!==index.raw) throw Error('Text changed'); for(let at=item.sourceStart;at<item.sourceEnd;at++) for(const key of ['bold','italic']) if(typeof item.font[key]==='boolean' && corrected.formats[at][key]!==item.font[key]) throw Error('Style not applied'); console.log('DIFF',JSON.stringify({text:item.text,font:item.font,html:{bold:item.htmlFont.bold,italic:item.htmlFont.italic},edits:item.options[0].edits,verified:true}));}
const start=index.raw.indexOf('Rheinische Zeitung'); console.log('PATCH',window.PdfSelectionDiff.previewEdits(html,index.fontEdits(start,start+'Rheinische Zeitung'.length,{bold:false,italic:false})).slice(130,400));
if(!index.formatDifferences(index.connectionPairs([target])).some(i=>i.text==='Neue Rheinische Zeitung' && i.font.bold===false)) throw Error('Surplus bold not detected');
for(const part of target.pages[0].parts) part.font={...part.font,bold:false}; const title=index.formatDifferences(index.connectionPairs([target])).find(i=>i.text.includes('Zeitung')); if(title?.text!=='Neue Rheinische Zeitung') throw Error('Incomplete font alignment: '+title?.text); if(window.PdfSelectionDiff.previewEdits(html,title.options[0].edits).includes('<b>Neu')) throw Error('Split word patch'); console.log('PASS: surplus bold detection and full-word font alignment');
await task.destroy();







