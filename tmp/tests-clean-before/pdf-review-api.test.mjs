import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { chromium } from 'playwright';

const scripts = new Map(await Promise.all([
  'pdf-selection-diff.js', 'pdf-review-provider.js', 'replacement-review.js', 'pdf-selection.js'
].map(async name => [name, await readFile(new URL(`../public/pdfdiff/${name}`, import.meta.url), 'utf8')])));

test('diff engine stays within 930 physical lines', () => {
  const source = scripts.get('pdf-selection-diff.js');
  assert.ok(source.split(/\r?\n/).length - Number(source.endsWith('\n')) <= 930);
});

for (const order of [
  ['pdf-review-provider.js', 'pdf-selection.js'],
  ['replacement-review.js', 'pdf-review-provider.js', 'pdf-selection.js'],
  ['pdf-selection.js']
]) {
  test(`real provider API and callbacks: ${order.join(' → ')}`, async () => {
    const browser = await chromium.launch({
      executablePath: process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      headless: true
    });
    try {
      const page = await browser.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', event => { if (event.type() === 'error') errors.push(event.text()); });
      await page.route('http://review.test/**', async route => {
        const url = new URL(route.request().url());
        if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body:
          '<body><div id="replacementFeatures"></div>' + order.map(name => `<script src="/pdfdiff/${name}"></script>`).join('') });
        if (url.pathname === '/api/reader/settings') return route.fulfill({ json: {} });
        // Exercise the supported local-diff fallback without a Monaco server.
        if (url.pathname.startsWith('/monaco/')) return route.fulfill({ contentType: 'text/javascript', body: 'throw new Error("Monaco unavailable in API fixture");' });
        const source = scripts.get(url.pathname.replace('/pdfdiff/', ''));
        assert.ok(source, `unexpected request: ${url.pathname}`);
        return route.fulfill({ contentType: 'text/javascript', body: source });
      });
      await page.goto('http://review.test/');
      await page.waitForFunction(() => window.PdfSelection);
      const result = await page.evaluate(async () => {
        const api = await window.PdfReviewReady;
        const methods = ['PdfLocator', 'PdfSourceIndex',
          'measureHighlights', 'paintHighlight', 'clearHighlights', 'getHighlight',
          'selectionRange'];
        if (api !== window.PdfReviewProvider || methods.some(name => typeof api[name] !== 'function'))
          throw new Error('Incomplete provider API');
        if (typeof PdfSelectionDiff.PdfSourceIndex.prototype.sourceDecorations !== 'function' || 'sourceDecorations' in PdfSelectionDiff || 'sourceDecorations' in api)
          throw new Error('Source decorations must belong to PdfSourceIndex');
        if ('connectionDiff' in api || 'textDifferences' in api) throw new Error('Obsolete diff helpers remain exported');
        if (api.PdfSourceIndex !== PdfSelectionDiff.PdfSourceIndex || 'reviewCandidates' in api) throw new Error('Index operations must belong to the diff engine');
        if (['normalized', 'approximateMatches', 'lowerBound', 'htmlFontDefinition'].some(name =>
          typeof PdfSelectionDiff[name] !== 'function' || name in PdfSelection.locator || name in PdfSelectionDiff.PdfSourceIndex))
          throw new Error('Stateless helpers must remain outside the class without locator wrappers');
        if (['reviewCandidates', 'connectionPairs', 'connectionDiff', 'sourceRange', 'fontRuns', 'fontEdits', 'formatDifferences', 'sourceSegments', 'insertionSegment', 'sourceDecorations', 'textEdits']
          .some(name => typeof PdfSelectionDiff.PdfSourceIndex.prototype[name] !== 'function' || name in PdfSelectionDiff))
          throw new Error('Index operations must be exported on the complete class');
        if (['readPageText', 'readPageFonts', 'layerFonts'].some(name =>
          typeof api.PdfLocator.prototype[name] !== 'function' || name in PdfSelectionDiff || name in api))
          throw new Error('Data reading must belong to PdfLocator');
        if (['fontStyle', 'textItemFont'].some(name => typeof api[name] !== 'function' || name in PdfSelectionDiff))
          throw new Error('Font metadata helpers must belong to the provider');
        if (!(PdfSelection.locator instanceof api.PdfLocator)) throw new Error('Selection uses a different provider');
        let value = '<p>Before WRONG after.</p>', version = 1;
        const model = { getValue: () => value, getVersionId: () => version,
          getPositionAt: offset => ({ lineNumber: 1, column: offset + 1 }),
          getOffsetAt: position => position.column - 1 };
        const noop = () => ({ dispose() {} });
        const editor = { getModel: () => model, getDomNode: () => document.body, getOption: () => false,
          onDidChangeModel: noop, onDidChangeModelContent: noop, onDidScrollChange: noop,
          getSelection: () => null, setSelection() {}, revealRangeInCenterIfOutsideViewport() {}, pushUndoStop() {}, focus() {},
          executeEdits(origin, edits) {
            for (const edit of [...edits].reverse()) value = value.slice(0, edit.range.startColumn - 1)
              + edit.text + value.slice(edit.range.endColumn - 1);
            version++; return true;
          } };
        let currentToolbox;
        const unregister = ReplacementReview.register({ id: 'api-context', label: 'API context',
          provide(context) { currentToolbox = context.toolbox; return []; } });
        await ReplacementReview.open('api-context', editor);
        if (currentToolbox !== window.PdfSelectionDiff) throw new Error('Popup captured an unavailable toolbox');
        ReplacementReview.close(); unregister();
        const locator = PdfSelection.locator, index = locator.editorSourceIndex(model);
        const target = locator.sourceIndex('<p>Before RIGHT after.</p>');
        const connection = index.rememberConnection(0, index.raw.length, target, { start: 0, end: target.raw.length });
        const marks = index.sourceDecorations([[connection, target]], model);
        const combined = [
          ['<i>heine</i>', 'keine'], ['<i>keXne</i>', 'keine'], ['<i>keinX</i>', 'keine'],
          ['<i>heeine</i>', 'keine'], ['<i>heine Worte</i>', 'keine Worte'],
          ['<i>he<b>in</b>e</i>', 'keine'], ['heine', 'keine'], ['<i>keine</i>', 'keine'],
          ['<i>heine</i>', 'keine+'], ['<i>keineX</i>', 'keine'], ['<i>Xkeine</i>', 'keine'],
          ['<i> </i><b> </b>', 'XYZ']
        ].map(([markup, raw]) => {
          const source = locator.sourceIndex(markup);
          const pdf = new PdfSelectionDiff.PdfSourceIndex(locator, { raw,
            parts: [{ start: 0, end: raw.length, font: { italic: false, bold: false } }] });
          const pair = source.rememberConnection(0, source.raw.length, pdf, { start: 0, end: raw.length });
          const decorations = source.sourceDecorations([[pair, pdf]], model);
          const text = source.reviewCandidates([pdf]);
          return { ranges: decorations.map(({ range }) => markup.slice(range.startColumn - 1, range.endColumn - 1)),
            textRanges: decorations.filter(mark => mark.options.hoverMessage.value.includes('OCR:'))
              .map(({ range }) => markup.slice(range.startColumn - 1, range.endColumn - 1)),
            fontRanges: decorations.filter(mark => mark.options.inlineClassName?.includes('mew-font-diff-text'))
              .map(({ range }) => markup.slice(range.startColumn - 1, range.endColumn - 1)),
            combined: decorations.filter(mark => mark.options.description === 'PDF text and font difference')
              .every(mark => mark.options.hoverMessage.value.includes('OCR:') && mark.options.hoverMessage.value.includes('PDF 斜体')),
            duplicateRanges: decorations.some((mark, at) => !mark.options.beforeContentClassName
              && decorations.slice(at + 1).some(other => !other.options.beforeContentClassName
                && mark.range.startColumn === other.range.startColumn && mark.range.endColumn === other.range.endColumn)),
            hover: decorations.flatMap(mark => [mark.options.hoverMessage].flat().map(message => message.value)),
            carets: decorations.filter(mark => mark.options.beforeContentClassName).length,
            replaced: PdfSelectionDiff.previewEdits(markup, text.flatMap(item => item.options[0].edits)) };
        });
        const pdf = {};
        window.ReaderUI = { getPdfViewer: () => ({ pdfDocument: pdf }) };
        const start = index.raw.indexOf('WRONG'), end = start + 5;
        const request = { pdf, targets: [target], notice: { html: 'WRONG', pdf: 'RIGHT', source: { index, start, end },
          target: { index: target, start, end } } };
        await ReplacementReview.open('pdf-ocr', editor, `${start}:${end}`, 0, request);
        const panel = document.querySelector('.replacement-review');
        const comparison = [...panel.querySelectorAll('[data-comparison] mark')].map(node => node.textContent);
        panel.querySelector('[data-apply]').click();
        await new Promise(resolve => setTimeout(resolve, 0));
        const position = panel.querySelector('[data-position]').textContent;
        ReplacementReview.close();
        return { value, comparison, position, marks: marks.length, combined };
      });
      assert.equal(result.value, '<p>Before RIGHT after.</p>');
      assert.deepEqual(result.comparison, ['WRONG', 'RIGHT']);
      assert.equal(result.position, '0 / 0', 'provider refresh removes the applied candidate');
      assert.ok(result.marks > 0, 'public provider creates source decorations');
      assert.deepEqual(result.combined.map(item => item.fontRanges), [
        ['heine'], ['keXne'], ['keinX'], ['heeine'], ['heine Worte'],
        ['he', 'in', 'e'], [], ['keine'], ['heine'], ['keineX'], ['Xkeine'], []
      ], 'continuous text and font discrepancies share the complete range');
      assert.ok(result.combined.every(item => item.combined && !item.duplicateRanges),
        'combined decorations include both hover details without duplicate ranges');
      assert.deepEqual(result.combined.slice(0, 3).map(item => item.textRanges), [['heine'], ['keXne'], ['keinX']],
        'text discrepancies highlight the whole overlapping font segment');
      assert.deepEqual(result.combined[6].textRanges, ['h'], 'text-only differences remain highlighted');
      assert.deepEqual(result.combined[7].textRanges, [], 'font-only differences create no text decoration');
      assert.ok(result.combined[0].hover.some(value => value.includes('OCR:')));
      assert.ok(result.combined[0].hover.some(value => value.includes('PDF 斜体')));
      assert.equal(result.combined[8].carets, 1, 'overlapping font differences preserve the missing-text caret');
      assert.equal(result.combined[0].replaced, '<i>keine</i>', 'text edits retain their original precise range');
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
  });
}
