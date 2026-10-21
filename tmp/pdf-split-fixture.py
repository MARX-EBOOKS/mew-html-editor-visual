from pathlib import Path
p=Path('tests/replacement-review-browser.mjs');s=p.read_text(encoding='utf-8')
needle="""      await child.evaluate(async () => {
        const editor = mewWorkbench.editor, model = editor.getModel(), index = PdfSelectionDiff.createLocator().editorSourceIndex(model);
        const start = index.raw.lastIndexOf('WRONG');
        opener.dispatchEvent(new opener.CustomEvent('pdf-selection-difference', { detail: {
          editor, model, pdf: opener.ReaderUI.getPdfViewer().pdfDocument, targets: [],
          notices: [{ html: 'WRONG', pdf: 'RIGHT', source: { index, start, end: start + 5 } }]
        } }));
      });"""
replacement="""      await page.evaluate(() => {
        const viewer = ReaderUI.getPdfViewer(), div = viewer.getPageView(0).div;
        const layer = div.querySelector('.textLayer') || div.appendChild(document.createElement('div'));
        layer.className = 'textLayer';
        layer.innerHTML = '<span role="presentation" style="position:absolute;left:80px;top:100px;font-size:20px">RIGHT</span>';
        window.addEventListener('pdf-selection-sources', event => {
          const target = event.detail.targets.find(target => target.layer === layer);
          if (target) window.splitTargetIndex = target;
        });
        viewer.scrollPageIntoView({ pageNumber: 1 });
        viewer.eventBus.dispatch('textlayerrendered', { pageNumber: 1 });
      });
      await page.waitForFunction(() => window.splitTargetIndex?.raw.includes('RIGHT'));
      await child.evaluate(async () => {
        const editor = mewWorkbench.editor, model = editor.getModel(), index = PdfSelectionDiff.createLocator().editorSourceIndex(model);
        const start = index.raw.lastIndexOf('WRONG'), target = opener.splitTargetIndex;
        const range = PdfSelectionDiff.rangeAt(model, index.starts[start], index.ends[start + 4]);
        editor.setSelection(range); editor.revealRangeInCenter(range);
        opener.PdfSelection.locator.rememberConnection(index, start, start + 5, target, { start: 0, end: 5 });
        opener.dispatchEvent(new opener.CustomEvent('pdf-selection-difference', { detail: {
          editor, model, pdf: opener.ReaderUI.getPdfViewer().pdfDocument, targets: [target],
          notices: [{ html: 'WRONG', pdf: 'RIGHT', source: { index, start, end: start + 5 }, target: { index: target, start: 0, end: 5 } }]
        } }));
      });"""
assert needle in s;s=s.replace(needle,replacement);p.write_text(s,encoding='utf-8')
