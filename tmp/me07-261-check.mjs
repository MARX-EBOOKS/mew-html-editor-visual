import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { getDocument } from '../node_modules/pdfjs-dist/legacy/build/pdf.mjs';
const review = await readFile('public/pdfdiff/pdf-review-provider.js', 'utf8');
const mapping = review.slice(review.indexOf('  // Source/PDF mapping and candidate generation.'), review.indexOf('  // Shared popup and session initialization.'));
const window = {};
vm.runInNewContext(await readFile('public/pdfdiff/pdf-selection-diff.js', 'utf8') + '\n(() => {' + mapping + '})();', { window });
const api = window.PdfSelectionDiff, provider = window.PdfReviewProvider;
const locator = provider.createLocator({}, { document: { createElement: () => ({}) } });
const html = await readFile('../MEW_BRIEF/7/ME07-261.html', 'utf8');
const task = getDocument({ data: new Uint8Array(await readFile('../马恩全集德文/mew_band07.pdf')), useSystemFonts: true });
const pdf = await task.promise;
for (let n = 281; n <= 287; n++) {
  const content = await (await pdf.getPage(n)).getTextContent();
  const raw = content.items.map(i => i.str + (i.hasEOL ? '\n' : '')).join('');
  if (!raw.includes('Folgerung')) continue;
  const index = locator.sourceIndex(html), target = locator.sourceIndex(raw);
  locator.prepareSource(index, [target], pdf);
  console.log('page', n);
  for (const connection of index.connections.get(target) || []) {
    const diff = provider.connectionDiff(index, target, connection);
    let cursor = connection.start;
    for (const part of diff.parts) {
      if (part.changed && (part.pdf.includes('an') || index.raw.slice(cursor - 10, cursor + 15).includes('schlie'))) {
        console.log(JSON.stringify({ cursor, ...part, segments: api.sourceSegments(index, cursor, cursor + part.html.length), context: index.raw.slice(cursor - 20, cursor + 30), insertion: api.insertionSegment(index, cursor) }));
      }
      cursor += part.html.length;
    }
  }
}
await task.destroy();
