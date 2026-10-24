import { launchBrowser } from '../tests/support/browser.mjs';
const browser = await launchBrowser();
try {
  const page = await browser.newPage({ viewport: { width: 1700, height: 1050 } });
  page.on('pageerror', e => console.log('PAGEERROR', e.message));
  await page.goto('http://127.0.0.1:17000/?volume=5&page=283&mode=source');
  await page.waitForFunction(() => window.readerMonaco?.editor && window.PdfSelection?.viewer?.getPageView(PdfSelection.viewer.currentPageNumber - 1)?.div.querySelector('.textLayer span'), null, { timeout: 60000 });
  await page.waitForFunction(() => PdfSelection.locator.getDocumentIndex(PdfSelection.viewer.pdfDocument), null, { timeout: 60000 }).catch(e => console.log('INDEX_WAIT', e.message));
  await page.waitForTimeout(500);
  console.log(JSON.stringify(await page.evaluate(async () => {
    const s = PdfSelection, loc = s.locator, editor = readerMonaco.editor, model = editor.getModel(), index = loc.editorSourceIndex(model);
    const view = s.viewer.getPageView(s.viewer.currentPageNumber - 1);
    const full = loc.getDocumentIndex(s.viewer.pdfDocument);
    const visible = loc.environment.getVisiblePages();
    const targets = [...visible.map(p => p.index), full].filter(Boolean);
    const connections = index.connectionPairs(targets);
    return { page: s.viewer.currentPageNumber, source: model.getValue(), raw: index.raw, pdf: view.div.textContent, documentReady: !!full,
      visible: visible.map(p => ({ number: p.number, raw: p.index?.raw, connections: index.connections.get(p.index), runs: p.index?.fontRuns().filter(r => /An/.test(p.index.raw.slice(r.start, r.end))).map(r => ({ ...r, text: p.index.raw.slice(r.start, r.end) })) })),
      decorations: model.getAllDecorations().filter(d => /mew-/.test(d.options.inlineClassName || '')).map(d => ({ range: d.range, text: model.getValueInRange(d.range), cls: d.options.inlineClassName })),
      candidates: index.reviewCandidates(targets).map(i => ({ start: i.sourceStart, end: i.sourceEnd, comparison: i.comparison })),
      formats: index.formatDifferences(connections).map(i => ({ start: i.sourceStart, end: i.sourceEnd, text: index.raw.slice(i.sourceStart, i.sourceEnd), font: i.font })) };
  }), null, 2));
  await page.screenshot({ path: 'tmp/me05-283-popup-before.png' });
} finally { await browser.close(); }
