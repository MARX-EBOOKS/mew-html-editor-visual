import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { launchBrowser } from './support/browser.mjs';

test('real ME08 corrupted OCR uses normal text additions, warnings and no missing-text carets', async () => {
  const fixtures = JSON.parse(await readFile(new URL('./fixtures/pdf-missing-context-me08.json', import.meta.url), 'utf8'));
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('http://missing.test/**', async route => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === '/') return route.fulfill({ contentType: 'text/html', body: `<link rel="stylesheet" href="/pdfdiff/replacement-review.css"><body>
        <div id="replacementFeatures"></div><div id="editor" style="width:600px;height:500px"></div>
        <div id="pdf" style="position:absolute;left:650px;top:80px;width:700px;height:750px">
          <div class="pdfViewer"><div class="page" data-page-number="1" style="position:relative;width:700px;height:750px">
            <div class="textLayer" style="position:absolute;inset:0;position:absolute"><span role="presentation"></span></div>
          </div></div>
        </div></body>` });
      if (pathname === '/api/reader/settings') return route.fulfill({ json: {} });
      const file = pathname.startsWith('/monaco/') ? 'node_modules/monaco-editor/' + pathname.slice(8) : 'public' + pathname;
      return route.fulfill({ contentType: pathname.endsWith('.css') ? 'text/css' : 'text/javascript',
        body: await readFile(new URL('../' + file, import.meta.url)) });
    });
    await page.goto('http://missing.test/');
    await page.addScriptTag({ url: '/monaco/min/vs/loader.js' });
    await page.evaluate(() => new Promise(resolve => {
      require.config({ paths: { vs: '/monaco/min/vs' } }); require(['vs/editor/editor.main'], resolve);
    }));
    await page.evaluate(() => {
      window.testEditor = monaco.editor.create(document.getElementById('editor'), { value: '', wordWrap: 'on' });
      window.mewWorkbench = { editor: testEditor };
      const div = document.querySelector('.page');
      window.mockViewer = { container: document.getElementById('pdf'), viewer: document.querySelector('.pdfViewer'), currentPageNumber: 1,
        _getVisiblePages: () => ({ views: [{ id: mockViewer.currentPageNumber }] }), getPageView: () => ({ div }),
        eventBus: { on() {}, off() {} } };
      window.ReaderUI = { getPdfViewer: () => mockViewer, getPdfSourcePages: () => [mockViewer.currentPageNumber] };
    });
    await page.addScriptTag({ url: '/pdfdiff/pdf-selection.js' });
    await page.waitForFunction(() => window.PdfSelection);
    await page.evaluate(() => addEventListener('pdf-selection-difference', event => { window.selectedNotices = event.detail.notices; }));
    const popup = page.locator('.replacement-review:visible');
    const confirmed = 'A confirmed passage with words to anchor reminders at either end.';
    for (const fixture of [...fixtures,
      { number: 'clean anchors', physical: 1, source: '<p>' + 'Missing prefix. '.repeat(10) + confirmed + 'Missing suffix. '.repeat(10) + '</p>',
        view: [0, 0, 600, 850], boxes: [[confirmed, 30, 400, 400, 20]] },
      { number: 'final anchors', physical: 1, source: '<p>' + 'Missing prefix. '.repeat(10) + confirmed + 'Missing suffix. '.repeat(10) + '</p>',
        view: [0, 0, 600, 850], boxes: [[confirmed, 30, 400, 400, 20]] }]) {
      await page.evaluate(fixture => {
        ReplacementReview.close(); testEditor.setValue(fixture.source);
        const div = document.querySelector('.page'), layer = div.querySelector('.textLayer'), scale = .8;
        div.dataset.pageNumber = fixture.physical; layer.replaceChildren();
        for (const [str, x, y, width, height] of fixture.boxes) {
          const span = document.createElement('span'); span.setAttribute('role', 'presentation'); span.textContent = str;
          span.style.cssText = `position:absolute;white-space:pre;left:${x * scale}px;top:${(fixture.view[3] - y - height) * scale}px;font:${height * scale}px serif`;
          layer.append(span);
        }
        mockViewer.currentPageNumber = fixture.physical;
        mockViewer.pdfDocument = { numPages: fixture.physical, async getPage() { return {
          commonObjs: { has: () => false }, async getOperatorList() { return { fnArray: [], argsArray: [] }; },
          async getTextContent() { return { items: fixture.boxes.map(([str, x, y, width, height]) => ({ str, transform: [1,0,0,1,x,y], width, height })) }; }
        }; } };
        PdfSelection.attachViewer(mockViewer); PdfSelection.attachEditor(testEditor); PdfSelection.refresh();
      }, fixture);
      await page.waitForFunction(() => {
        const locator = PdfSelection.locator, index = locator.editorSourceIndex(testEditor.getModel());
        const target = locator.getDocumentIndex(mockViewer.pdfDocument, [mockViewer.currentPageNumber]);
        return target && index.pageScopes.get(target)?.prepared
          && (!index.reviewCandidates(null, false, true, true, locator.environment.getTargets()).some(item => item.missing)
            || testEditor.getModel().getAllDecorations().some(mark => mark.options.inlineClassName === 'mew-ocr-diff-text' && !mark.options.before));
      }, null, { timeout: 5000 });
      const gaps = await page.evaluate(() => {
        const locator = PdfSelection.locator, index = locator.editorSourceIndex(testEditor.getModel());
        return index.reviewCandidates(null, false, true, true, locator.environment.getTargets()).filter(item => item.missing)
          .map(item => [item.sourceStart, item.sourceEnd]);
      });
      if (!gaps.length) continue;
      for (const [start, end] of gaps) {
        const selectedText = await page.evaluate(([start, end]) => {
          ReplacementReview.close();
          window.selectedNotices = [];
          const index = PdfSelection.locator.editorSourceIndex(testEditor.getModel());
          testEditor.setSelection(window.PdfSelectionDiff.rangeAt(testEditor.getModel(), index.starts[start + 1] ?? index.source.length,
            (end - 1 > start + 1 ? index.ends[(end - 1) - 1] : index.starts[start + 1]) ?? index.source.length));
          return index.raw.slice(start + 1, end - 1);
        }, [start, end]);
        await popup.waitFor({ timeout: 3000 });
        const status = await popup.locator('[data-status]').textContent();
        if (status === '文字不一致') continue; // A recovered normal match takes priority over the missing-text reminder.
        assert.match(status, /PDF OCR.*文字/u, `ME08-${fixture.number}`);
        assert.equal(await popup.locator('[data-comparison] > div').first().textContent(), 'HTML: ' + selectedText,
          'the popup contains exactly the selected text');
        assert.match(await popup.locator('[data-comparison]').textContent(), /HTML:.*PDF:/s);
        assert.equal(await popup.locator('[data-save]').isDisabled(), true);
        if (fixture.number === 'clean anchors') {
          await popup.locator('[data-apply]').click();
          await page.waitForFunction(() => [...document.querySelectorAll('#editor .mew-review-proposed')]
            .some(node => getComputedStyle(node).backgroundColor.startsWith('rgba(46, 160, 67,')
              ));
          assert.equal(await page.evaluate(() => testEditor.getValue()), fixture.source);
          await popup.locator('[data-apply]').click();
          await page.waitForFunction(() => !document.querySelector('#editor .mew-review-proposed'));
        }
        const remainingWords = await page.evaluate(() => selectedNotices.some(({ target }) =>
          target && !!target.index.raw.slice(target.start, target.end).trim()));
        assert.equal(await page.locator('.mew-pdf-selection-highlight:not(.mew-pdf-review-pointer) > :not(.mew-pdf-selection-caret)').count() > 0,
          remainingWords, `ME08-${fixture.number} highlights the OCR words remaining in its gap`);
        const placement = await page.evaluate(() => {
          const div = document.querySelector('.page'), rect = div.getBoundingClientRect();
          const boxes = PdfReviewProvider.highlights.getHighlight(div)?.boxes || [];
          const anchor = boxes.length ? { top: rect.top + Math.min(...boxes.map(box => box.y)) * rect.height,
            bottom: rect.top + Math.max(...boxes.map(box => box.y + box.h)) * rect.height } : null;
          const box = document.querySelector('.replacement-review').getBoundingClientRect();
          return { anchor, top: box.top, bottom: box.bottom };
        });
        if (placement.anchor) assert.ok(placement.bottom <= placement.anchor.top || placement.top >= placement.anchor.bottom,
          `ME08-${fixture.number} popup avoids its anchor sequence`);
      }
      await popup.locator('[data-close]').click();
      assert.equal(await page.evaluate(() => (PdfReviewProvider.highlights.getHighlight(document.querySelector('.page'), true)?.notices || [])
        .filter(notice => notice.missing && notice.target.start === notice.target.end).length), 0, 'missing OCR has no PDF insertion caret');
      assert.equal(await page.evaluate(() => testEditor.getValue()), fixture.source);
    }
    await page.getByLabel('启用源码差异高亮', { exact: true }).uncheck();
    await page.getByLabel('启用PDF 差异高亮', { exact: true }).uncheck();
    await page.evaluate(() => testEditor.setSelection(new monaco.Range(1, 5, 1, 12)));
    await popup.waitFor({ timeout: 3000 });
    await popup.locator('[data-close]').click();
    await page.getByLabel('启用PDF 文字差异审阅', { exact: true }).uncheck();
    await page.waitForFunction(() => !document.querySelector('#editor .mew-ocr-diff-insert'));
    await page.evaluate(() => testEditor.setSelection(new monaco.Range(1, 5, 1, 12)));
    await page.waitForTimeout(150);
    assert.equal(await popup.count(), 0);
    await page.getByLabel('启用源码差异高亮', { exact: true }).check();
    await page.getByLabel('启用PDF 文字差异审阅', { exact: true }).check();
    // Click inside the actual HTML addition, rather than either boundary.
    await page.evaluate(() => {
      const locator = PdfSelection.locator, index = locator.editorSourceIndex(testEditor.getModel());
      const item = index.reviewCandidates(null, false, true, true, locator.environment.getTargets()).find(item => item.missing);
      window.addition = item;
    });
    const addition = await page.evaluate(() => window.addition && [addition.sourceStart, addition.sourceEnd]);
    assert.ok(addition, 'the final fixture has a missing-OCR addition to click');
    if (addition) {
      const point = await page.evaluate(([start, end]) => {
        const index = PdfSelection.locator.editorSourceIndex(testEditor.getModel());
        const position = testEditor.getModel().getPositionAt(index.starts[Math.floor((start + end) / 2)]);
        testEditor.revealPositionInCenter(position);
        const at = testEditor.getScrolledVisiblePosition(position), rect = testEditor.getDomNode().getBoundingClientRect();
        return { x: rect.left + at.left + 2, y: rect.top + at.top + at.height / 2 };
      }, addition);
      await page.mouse.click(point.x, point.y);
      await popup.waitFor({ timeout: 3000 });
      assert.match(await popup.locator('[data-status]').textContent(), /PDF OCR.*文字/u);
      assert.match(await popup.locator('[data-comparison]').textContent(), /HTML:.*PDF:/s);
      await popup.locator('[data-close]').click();
    }
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
