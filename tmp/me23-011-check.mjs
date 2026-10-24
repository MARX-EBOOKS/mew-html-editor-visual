import { readFile, writeFile } from 'node:fs/promises';
import vm from 'node:vm';
import { getDocument } from '../node_modules/pdfjs-dist/legacy/build/pdf.mjs';
import { DefaultLinesDiffComputer } from '../node_modules/monaco-editor/esm/vs/editor/common/diff/defaultLinesDiffComputer/defaultLinesDiffComputer.js';
const window = {};
vm.runInNewContext(await readFile('public/pdfdiff/local-text-diff.js', 'utf8') + await readFile(process.argv[2] || 'public/pdfdiff/pdf-selection-diff.js', 'utf8'), { window });
const api = window.PdfSelectionDiff;
api.useMonaco(new DefaultLinesDiffComputer());
const locator = api.createLocator({}, { document: { createElement: () => ({}) }, isCurrent: () => true, waitForIdle: async () => {} });
const task = getDocument({ data: new Uint8Array(await readFile('../马恩全集德文/mew_band23.pdf')), useSystemFonts: true });
const pdf = await task.promise;
for (let n = 11; n <= 19; n++) {
  const page = await pdf.getPage(n), content = await page.getTextContent();
  const text = content.items.map(i => i.str).join(' ');
  console.log('PAGE', n, text.slice(0, 90));
}
const subset = { numPages: 9, getPage: n => pdf.getPage(n + 10) };
const full = await locator.indexDocument(subset);
const pages = full.pages.map(p => locator.sourceIndex(full.raw.slice(p.start, p.end)));
const html = await readFile('../MEW_BRIEF/23/ME23-011.html', 'utf8');
const source = locator.sourceIndex(html);
locator.prepareSource(source, pages, subset);
console.log('SOURCE', source.raw.length);
for (const [i, target] of [...pages, full].entries()) {
  console.log('CONNECTIONS', i + 11, (source.connections.get(target) || []).map(c => [c.start, c.end, c.targetStart, c.targetEnd]));
}
const candidates = api.reviewCandidates(source, [...pages, full]);
console.log('CANDIDATES', candidates.length, candidates.map(i => [i.sourceStart, i.sourceEnd, i.comparison]));
await writeFile('tmp/me23-011-fixture.json', JSON.stringify({html, pages: pages.map(p => p.raw)}, null, 2));
await task.destroy();
