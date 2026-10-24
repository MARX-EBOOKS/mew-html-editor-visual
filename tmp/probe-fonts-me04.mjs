import { chromium } from 'playwright';
import { readFile, writeFile } from 'node:fs/promises';
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const page = await browser.newPage();
  await page.route('http://font-probe.test/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html>' });
    if (path === '/band04.pdf') return route.fulfill({ contentType: 'application/pdf', body: await readFile('D:/马恩列总装/马恩全集德文/mew_band04.pdf') });
    if (path.startsWith('/vendor/pdfjs/')) return route.fulfill({ contentType: path.endsWith('.mjs') ? 'text/javascript' : 'application/octet-stream', body: await readFile('node_modules/pdfjs-dist/' + path.slice('/vendor/pdfjs/'.length)) });
    return route.abort();
  });
  await page.goto('http://font-probe.test/');
  await page.addScriptTag({ content: await readFile('public/pdf-selection-diff.js', 'utf8') });
  const inputs = await Promise.all(['015', '021', '136'].map(async label => ({ label, html: await readFile(`D:/马恩列总装/MEW_BRIEF/4/ME04-${label}.html`, 'utf8') })));
  const result = await page.evaluate(async inputs => {
    const lib = await import('/vendor/pdfjs/build/pdf.mjs');
    lib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/build/pdf.worker.mjs';
    const task = lib.getDocument({ url: '/band04.pdf', standardFontDataUrl: '/vendor/pdfjs/standard_fonts/', useSystemFonts: true });
    const pdf = await task.promise;
    const labels = await pdf.getPageLabels(), results = [];
    for (const input of inputs) {
      const number = labels.indexOf(String(Number(input.label))) + 1, pdfPage = await pdf.getPage(number);
      const locator = PdfSelectionDiff.createLocator({}, { document, isCurrent: () => true, waitForIdle: async () => {} });
      const full = await locator.indexFonts({ numPages: 1, getPage: async () => pdfPage });
      const index = { source: input.html, ...locator.sourceIndex(input.html) };
      locator.sourcePageScope(index, full, true);
      const differences = PdfSelectionDiff.formatDifferences(index, (index.connections.get(full) || []).map(connection => [connection, full]));
      const runs = PdfSelectionDiff.fontRuns(full);
      results.push({ label: input.label, physical: number,
        fonts: [...new Map(runs.map(run => [run.name, { name: run.name, italic: run.italic, bold: run.bold, declaredBold: run.declaredBold, reason: run.reason }])).values()],
        differences: differences.map(item => ({ text: item.text, html: item.htmlFont, pdf: item.font })),
        boldMismatches: differences.filter(item => typeof item.font.bold === 'boolean' && item.font.bold !== item.htmlFont.bold).length });
    }
    await task.destroy();
    return results;
  }, inputs);
  await writeFile('tmp/me04-font-probe.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally { await browser.close(); }
