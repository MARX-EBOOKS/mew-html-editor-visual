import { readFile } from 'node:fs/promises';
import { getDocument } from '../node_modules/pdfjs-dist/legacy/build/pdf.mjs';
import { engine } from '../tests/support/pdf-harness.mjs';
const api = engine(), task = getDocument({ data: new Uint8Array(await readFile('../马恩全集德文/mew_band05.pdf')), useSystemFonts: true }), doc = await task.promise;
try {
  const page = await doc.getPage(300), content = await page.getTextContent();
  const at = content.items.findIndex(i => i.str.includes('An'));
  console.log('ITEMS', JSON.stringify(content.items.slice(at - 2, at + 3).map(i => ({ text: i.str, font: i.fontName }))));
  const locator = new api.PdfLocator({}, { document: { createElement: () => ({}) }, isCurrent: () => true, waitForIdle: async () => {} });
  const target = await locator.indexDocument({ numPages: 1, getPage: async () => page });
  const source = locator.sourceIndex(await readFile('../MEW_BRIEF/5/ME05-283.html', 'utf8'));
  locator.prepareSource(source, [target], {});
  console.log('CONNECTIONS', JSON.stringify((source.connections.get(target) || []).map(c => ({ start: c.start, end: c.end, targetStart: c.targetStart, targetEnd: c.targetEnd }))));
  console.log('CANDIDATES', JSON.stringify(source.reviewCandidates([target])));
  const start = source.raw.indexOf('Anstand');
  const hit = source.connectedRange(target, start, start + 2, false, undefined, true);
  await locator.indexFonts({ numPages: 1, getPage: async () => page });
  const fonts = await locator.readPageFonts(page, content.items);
  console.log('AN', JSON.stringify({ html: source.raw.slice(start, start + 2), pdf: target.raw.slice(hit.start, hit.end), htmlFont: { bold: source.formats[start].bold, italic: source.formats[start].italic }, pdfFont: fonts.get(content.items[at].fontName) }));
} finally { await task.destroy(); }
