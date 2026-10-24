import { readFile, writeFile } from 'node:fs/promises';
import vm from 'node:vm';
import { getDocument } from '../node_modules/pdfjs-dist/legacy/build/pdf.mjs';
import { DefaultLinesDiffComputer } from '../node_modules/monaco-editor/esm/vs/editor/common/diff/defaultLinesDiffComputer/defaultLinesDiffComputer.js';
const window = {};
vm.runInNewContext(await readFile('public/pdfdiff/local-text-diff.js','utf8') + await readFile(process.argv[2] || 'public/pdfdiff/pdf-selection-diff.js','utf8'), {window,console});
const api = window.PdfSelectionDiff;
api.useMonaco(new DefaultLinesDiffComputer());
const locator = api.createLocator({}, {document:{createElement:()=>({})},isCurrent:()=>true,waitForIdle:async()=>{}});
const task = getDocument({data:new Uint8Array(await readFile('../马恩全集德文/mew_band07.pdf')),useSystemFonts:true});
const pdf = await task.promise;
const subset = {numPages:4,getPage:n=>pdf.getPage(n+95)};
const full = await locator.indexDocument(subset);
const pages = full.pages.map(p=>locator.sourceIndex(full.raw.slice(p.start,p.end)));
const fixtures = [];
for (const number of [73,74]) {
  const html = await readFile(`../MEW_BRIEF/7/ME07-0${number}.html`,'utf8');
  const index = locator.sourceIndex(html);
  locator.prepareSource(index,pages,subset);
  const items = api.reviewCandidates(index,[...pages,full]);
  console.log(number,JSON.stringify(items.map(i=>i.comparison)));
  const connections = index.connections.get(full)||[];
  console.log('full boundaries',connections.map(c=>[full.raw.slice(c.targetStart,c.targetStart+70),full.raw.slice(c.targetEnd-70,c.targetEnd)]));
  fixtures.push({number,html,pages:pages.map(p=>p.raw)});
}
await writeFile('tmp/me07-073-fixtures.json',JSON.stringify(fixtures,null,2));
await task.destroy();
