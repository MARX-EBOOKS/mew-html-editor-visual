import { readFile, writeFile } from 'node:fs/promises';
import vm from 'node:vm';
import { getDocument } from '../node_modules/pdfjs-dist/legacy/build/pdf.mjs';
const review = await readFile('public/pdfdiff/pdf-review-provider.js', 'utf8');
const mapping = review.slice(review.indexOf('  // Source/PDF mapping and candidate generation.'), review.indexOf('  // Shared popup and session initialization.'));
const window = {};
vm.runInNewContext(await readFile('public/pdfdiff/pdf-selection-diff.js', 'utf8') + '\n(() => {' + mapping + '})();', { window });
const api = window.PdfSelectionDiff, provider = window.PdfReviewProvider;
const locator = provider.createLocator({}, { document: { createElement: () => ({}) } });
const html = await readFile('../MEW_BRIEF/7/ME07-316.html', 'utf8');
const task = getDocument({ data: new Uint8Array(await readFile('../马恩全集德文/mew_band07.pdf')), useSystemFonts: true });
const pdf = await task.promise;
for (let n = 337; n <= 340; n++) {
  const content = await (await pdf.getPage(n)).getTextContent();
  const raw = content.items.map(i => i.str + (i.hasEOL ? '\n' : '')).join('');
  if (!raw.includes('Dean')) continue;
  await writeFile('tests/fixtures/pdf-selection-me07-316.json', JSON.stringify({ html: html.replaceAll('\r\n', '\n'), layerRaw: raw }, null, 2) + '\n');
  const index = locator.sourceIndex(html), target = locator.sourceIndex(raw);
  locator.prepareSource(index, [target], pdf);
  for (const connection of index.connections.get(target) || []) {
    let cursor = connection.start;
    for (const part of provider.connectionDiff(index, target, connection).parts) {
      const end = cursor + part.html.length;
      if (part.changed && api.significantText(part.html,index,cursor) !== api.significantText(part.pdf)) {
        const segments = api.sourceSegments(index,cursor,end), insertion = api.insertionSegment(index,end);
        console.log(JSON.stringify({page:n,cursor,end,...part,segments,insertion,context:html.slice(insertion.start-45,insertion.end+45),clickRaw:locator.lowerBound(index.ends,insertion.start+1)}));
      }
      cursor=end;
    }
  }
}
await task.destroy();
