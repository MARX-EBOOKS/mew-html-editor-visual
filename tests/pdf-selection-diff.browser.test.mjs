import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';
import { launchBrowser } from './support/browser.mjs';
import { reviewFile, popupSource, diffSource, engineSource, highlightSource, providerSource, fullReviewSource, fullProviderSource, source, readerMenu, engine } from './support/pdf-harness.mjs';
const PdfReviewProvider = engine();

test('review popup navigates immediately without full model reads and coalesces scroll layout', async () => {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    await page.setContent('<div id="pdf" style="width:800px;height:850px"></div>');
    await page.addStyleTag({ content: await readFile(new URL('../public/pdfdiff/replacement-review.css', import.meta.url), 'utf8') });
    await page.addScriptTag({ content: engineSource });
    await page.evaluate(() => {
      let value = 'Alpha Beta', version = 1, selection;
      const node = document.getElementById('pdf'), rect = node.getBoundingClientRect.bind(node);
      window.modelReads = 0; window.layoutReads = 0;
      node.getBoundingClientRect = () => { layoutReads++; return rect(); };
      const model = { getValue: () => { modelReads++; return value; }, getVersionId: () => version,
        getOffsetAt: position => position.column - 1 };
      const subscriptions = new Map();
      const listen = name => callback => { subscriptions.set(name, callback); return { dispose: () => subscriptions.delete(name) }; };
      window.testEditor = { getDomNode: () => node, getModel: () => model, getSelection: () => selection,
        setSelection: range => { selection = range; }, revealRangeInCenterIfOutsideViewport() {}, focus() {},
        onDidChangeModel: listen('model'), onDidChangeModelContent: listen('content'), onDidScrollChange: listen('scroll') };
      window.readerMonaco = { editor: testEditor };
      window.burstScroll = () => { for (let i = 0; i < 40; i++) subscriptions.get('scroll')?.(); };
      window.editSource = () => { value += '!'; version++; subscriptions.get('content')?.({ changes: [{ rangeOffset: 10, rangeLength: 0, text: '!' }] }); };
    });
    await page.addScriptTag({ content: fullProviderSource });
    await page.evaluate(async () => {
      await PdfReviewReady;
      ReplacementReview.register({ id: 'perf', label: 'Performance fixture', compact: true,
        provide: () => ['first', 'second'].map(id => ({ id, options: [{ id: 'keep', edits: [] }] })),
        presentation: (context, item) => ({ side: 'pdf', container: document.getElementById('pdf'),
          anchor: { left: 20, top: item?.id === 'second' ? 600 : 300, bottom: item?.id === 'second' ? 620 : 320 } }),
        content: () => ({ range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 6 }, expanded: false }),
        apply: state => ({ items: state.items.slice(1), position: 0 })
      });
      await ReplacementReview.open('perf', testEditor);
    });
    const result = await page.evaluate(async () => {
      const panel = document.querySelector('.replacement-review'), next = panel.querySelector('[data-next]'), prev = panel.querySelector('[data-prev]');
      const firstTop = panel.getBoundingClientRect().top;
      modelReads = 0;
      next.click();
      const nextTop = panel.getBoundingClientRect().top;
      for (let i = 0; i < 20; i++) { prev.click(); next.click(); }
      const reads = modelReads;
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      layoutReads = 0; burstScroll();
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return { firstTop, nextTop, reads, layouts: layoutReads, position: panel.querySelector('[data-position]').textContent };
    });
    assert.notEqual(result.nextTop, result.firstTop, 'navigation places the popup at the current item synchronously');
    assert.equal(result.position, '2 / 2');
    assert.equal(result.reads, 0, 'version checks never read the full model during navigation');
    assert.equal(result.layouts, 1, 'forty scroll notifications share one placement');
    await page.evaluate(() => editSource());
    await page.waitForFunction(() => !document.querySelector('[data-apply]').disabled);
    assert.equal(await page.evaluate(() => modelReads > 0), true, 'source changes still obtain a fresh snapshot');
  } finally { await browser.close(); }
});

test('native selections suppress page-uniform styles without checking other pages', async () => {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.route('**/api/reader/settings', route => route.fulfill({ json: { diffHighlight: true } }));
    await page.setContent('<div id="stage"><div class="pdfViewer"><div class="page" data-page-number="1"><div class="textLayer"><span role="presentation">Uniform text</span></div></div></div></div>');
    await page.addScriptTag({ content: engineSource });
    await page.addScriptTag({ content: fullReviewSource });
    await page.addScriptTag({ content: source });
    await page.waitForFunction(() => window.PdfSelection);
    await page.evaluate(() => {
      window.notices = 0;
      addEventListener('pdf-selection-difference', () => notices++);
      const read = PdfReviewProvider.PdfLocator.prototype.layerFonts;
      PdfReviewProvider.PdfLocator.prototype.layerFonts = function(view, layer, refresh) { return read.call(this, view, layer, () => {
        window.layerFonts = [read.call(this, view, layer, () => {})(layer.querySelector('span'))]; refresh();
      }); };
      window.otherPageChecks = 0;
      const pages = ['Uniform text', 'Another page'].map((str, i) => ({
        commonObjs: new Map([['f', { name: 'Times-BoldItalic', bold: true, italic: true }]]),
        async getTextContent() {
          // Page-one style decisions must not wait for another OCR page.
          if (i) await new Promise(() => {});
          return { items: [{ str, fontName: 'f', transform: [1, 0, 0, 1, 0, 100], height: 12, width: 80 }] };
        },
        async getOperatorList() { if (i) { window.otherPageChecks++; throw new Error('Other pages must not be checked'); } return { fnArray: [], argsArray: [] }; }
      }));
      const div = document.querySelector('.page');
      const viewer = { pdfDocument: { numPages: 2, getPage: async n => pages[n - 1] }, viewer: div.parentElement,
        container: document.getElementById('stage'), currentPageNumber: 1, getPageView: () => ({ div, pdfPage: pages[0] }),
        _getVisiblePages: () => ({ views: [{ id: 1 }] }), eventBus: { on() {}, off() {} } };
      const model = { getValue: () => '<p>Uniform text</p>', getVersionId: () => 1, getPositionAt: at => ({ lineNumber: 1, column: at + 1 }) };
      PdfSelection.attachViewer(viewer);
      PdfSelection.attachEditor({ getModel: () => model, getDomNode: () => document.body, setSelection() {},
        hasTextFocus: () => false, onDidChangeCursorSelection: () => ({ dispose() {} }), getSelection: () => null });
      window.selectUniform = () => {
        const range = document.createRange(); range.selectNodeContents(div.querySelector('span'));
        getSelection().removeAllRanges(); getSelection().addRange(range);
        document.dispatchEvent(new Event('selectionchange'));
      };
    });
    await page.waitForFunction(() => window.layerFonts);
    await page.evaluate(() => selectUniform());
    const result = await page.evaluate(() => ({ notices, otherPageChecks, fonts: layerFonts.map(font => [font.bold, font.italic]),
      overlays: document.querySelectorAll('.mew-pdf-selection-highlight').length }));
    assert.deepEqual(result, { notices: 1, otherPageChecks: 0, fonts: [[null, null]], overlays: 1 });
    assert.equal(await page.locator('.replacement-review').isHidden(), true, 'unknown styles do not open review');
  } finally { await browser.close(); }
});

test('PDF.js detects four actual PDF faces in file review and native selections', async () => {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.route('http://fonts.test/**', async route => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><div id="stage"><div class="pdfViewer"><div class="page" data-page-number="1" style="position:relative;width:600px;height:800px"><div class="textLayer"></div></div></div></div>' });
      if (pathname.startsWith('/pdf')) return route.fulfill({ contentType: 'text/javascript', body: await readFile(new URL('../node_modules/pdfjs-dist/build' + pathname, import.meta.url)) });
      if (pathname === '/api/reader/settings') return route.fulfill({ json: { diffHighlight: true } });
      if (pathname.startsWith('/monaco/esm/')) return route.fulfill({ contentType: 'text/javascript', body: await readFile(new URL('../node_modules/monaco-editor/' + pathname.slice('/monaco/'.length), import.meta.url)) });
      return route.abort();
    });
    await page.goto('http://fonts.test/');
    await page.addScriptTag({ content: engineSource });
    const providerSource = '(() => {\n' + fullReviewSource.split('// PDF comparison is one review provider. Selection synchronization remains independent.')[1]
  .replace(/\r?\n  return window\.PdfReviewProvider;\r?\n\}\)\(\);\s*$/, '') + '\n})();';
    const result = await page.evaluate(async ({ providerSource, highlightSource }) => {
      const lib = await import('/pdf.mjs');
      lib.GlobalWorkerOptions.workerSrc = '/pdf.worker.mjs';
      const faces = ['Helvetica', 'Helvetica-Oblique', 'Helvetica-Bold', 'Helvetica-BoldOblique'];
      const words = ['Regular', 'Italic', 'Bold', 'Both'];
      const stream = words.map((word, i) => `BT /F${i} 18 Tf 1 0 0 1 50 ${700 - i * 40} Tm (${word}) Tj ET`).join('\n');
      const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << ' + faces.map((_, i) => `/F${i} ${5 + i} 0 R`).join(' ') + ' >> >> /Contents 4 0 R >>',
        `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`, ...faces.map(face => `<< /Type /Font /Subtype /Type1 /BaseFont /${face} >>`)];
      let data = '%PDF-1.4\n'; const offsets = [0];
      objects.forEach((object, i) => { offsets.push(data.length); data += `${i + 1} 0 obj\n${object}\nendobj\n`; });
      const xref = data.length;
      data += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
        + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
      const pdf = await lib.getDocument({ data: new TextEncoder().encode(data), useSystemFonts: true }).promise;
      const locator = new PdfReviewProvider.PdfLocator({}, { isCurrent: () => true, waitForIdle: async () => {} });
      const full = await locator.indexFonts(pdf);
      const runs = full.fontRuns();
      const pdfPage = await pdf.getPage(1), div = document.querySelector('.page');
      const layer = new lib.TextLayer({ textContentSource: pdfPage.streamTextContent(), container: div.firstChild, viewport: pdfPage.getViewport({ scale: 1 }) });
      await layer.render();
      const viewer = { pdfDocument: pdf, viewer: div.parentElement, container: document.getElementById('stage'), currentPageNumber: 1,
        getPageView: () => ({ div, pdfPage }), _getVisiblePages: () => ({ views: [{ id: 1 }] }), eventBus: { on() {}, off() {} } };
      window.ReaderUI = { getPdfViewer: () => viewer };
      const providers = new Map();
      let opened = null, fontMarks = [];
      window.ReplacementReview = { register(provider) { providers.set(provider.id, provider); return () => {}; }, refreshMenu() {}, invalidate() {},
        isOpenFor: () => false, openForSelection(id) { opened = id; }, showNotice() {} };
      new Function(providerSource)();
      const html = '<p>' + words.join('\n') + '</p>';
      let liveHtml = html, version = 1;
      const model = { getValue: () => liveHtml, getVersionId: () => version, getPositionAt: at => ({ lineNumber: 1, column: at + 1 }) };
      const context = { model, source: html, signal: new AbortController().signal };
      const items = await providers.get('pdf-font').provide(context);
      const content = providers.get('pdf-font').content({ context, model: context.model, items, choices: new Map(items.map(item => [item.id, item.options[0].id])) }, items[0]);
      liveHtml = '<p>Regular\n<i>Italic</i>\n<b>Bold</b>\n<b><i>Both</i></b></p>'; version++;
      const correct = await providers.get('pdf-font').provide({ ...context, source: liveHtml });
      liveHtml = '<p>Regular\n<i>Italic</i>\n<b>Bold</b>\n<b>Both</b></p>'; version++;
      const partial = await providers.get('pdf-font').provide({ ...context, source: liveHtml });
      liveHtml = html; version++;
      new Function(highlightSource)();
      for (let i = 0; i < 100 && !window.PdfSelection; i++) await new Promise(resolve => setTimeout(resolve, 10));
      const editor = { getModel: () => model, getDomNode: () => document.body, setSelection() {}, hasTextFocus: () => false, onDidChangeCursorSelection: () => ({ dispose() {} }),
        createDecorationsCollection: () => ({ clear() {}, set(marks) { fontMarks = marks; } }), getSelection: () => null };
      PdfSelection.attachViewer(viewer); PdfSelection.attachEditor(editor);
      const notice = new Promise(resolve => window.addEventListener('pdf-selection-difference', event => resolve(event.detail.notices[0]), { once: true }));
      const span = [...div.querySelectorAll('span')].find(node => node.textContent === 'Both');
      // PDF.js Find splits an original text div into text and highlight spans.
      span.innerHTML = 'B<span class="highlight selected">ot</span>h';
      const range = document.createRange(); range.selectNodeContents(span);
      getSelection().removeAllRanges(); getSelection().addRange(range);
      const selected = await Promise.race([notice, new Promise((_, reject) => setTimeout(() => reject(new Error(JSON.stringify({ runs, items: items.length, status: PdfSelection.status, layer: div.innerHTML }))), 3000))]);
      const marked = fontMarks.some(mark => mark.options.description === 'PDF font difference');
      getSelection().removeAllRanges();
      await new Promise(resolve => setTimeout(resolve, 30));
      PdfSelection.highlight('Both');
      for (let i = 0; i < 100 && !div.querySelector('.mew-pdf-selection-highlight'); i++) await new Promise(resolve => setTimeout(resolve, 10));
      const before = div.querySelector('.mew-pdf-selection-highlight > div').getBoundingClientRect();
      span.textContent = 'Both';
      span.style.marginLeft = '25px';
      for (let i = 0; i < 100; i++) {
        const mark = div.querySelector('.mew-pdf-selection-highlight > div');
        if (mark && Math.abs(mark.getBoundingClientRect().left - before.left - 25) < 1) break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      const after = div.querySelector('.mew-pdf-selection-highlight > div').getBoundingClientRect();
      const refreshed = Math.abs(after.left - before.left - 25) < 1 && Math.abs(after.width - before.width) < 1;
      PdfSelection.stop();
      return { runs: runs.map(run => [run.italic, run.bold]), texts: items.map(item => item.text), message: content.message, selected: selected.target.index.fontRuns(selected.target.start, selected.target.end),
        refreshed, correct: correct.length, partial: partial.map(item => item.text), opened, marked };
    }, { providerSource, highlightSource: source });
    assert.deepEqual(result.runs, [[false, false], [true, false], [false, true], [true, true]]);
    assert.deepEqual(result.texts, ['Italic', 'Bold', 'Both']);
    assert.equal(result.message, '斜体不一致（HTML 否 / PDF 是）');
    assert.equal(result.selected[0].italic, true);
    assert.equal(result.selected[0].bold, true);
    assert.equal(result.correct, 0);
    assert.deepEqual(result.partial, ['Both']);
    assert.equal(result.opened, 'pdf-ocr');
    assert.equal(result.marked, true);
    assert.equal(result.refreshed, true, 'text-layer mutations repaint the active highlight without another selection');
  } finally { await browser.close(); }
});

test('format notices suppress matching and unknown styles and stay compact over PDF in combined view', async () => {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    await page.route('http://notice.test/**', async route => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname.startsWith('/monaco/esm/')) return route.fulfill({ contentType: 'text/javascript', body: await readFile(new URL('../node_modules/monaco-editor/' + pathname.slice('/monaco/'.length), import.meta.url)) });
      return route.fulfill({ contentType: 'text/html', body: '<!doctype html><div id="editor"></div><div id="pdf" style="position:fixed;left:600px;top:80px;width:580px;height:700px"><div class="textLayer" style="margin-top:100px"></div></div>' });
    });
    await page.goto('http://notice.test/');
    await page.addStyleTag({ content: await readFile(new URL('../public/pdfdiff/replacement-review.css', import.meta.url), 'utf8') });
    await page.addScriptTag({ content: engineSource });
    await page.evaluate(async () => {
      let sourceValue = '<p>Word</p>', sourceVersion = 1;
      const model = { getValue: () => sourceValue, getVersionId: () => sourceVersion, getPositionAt: n => ({ lineNumber: 1, column: n + 1 }), getOffsetAt: p => p.column - 1 };
      const subscription = () => ({ dispose() {} });
      const editor = { getModel: () => model, getDomNode: () => document.getElementById('editor'), getSelection: () => window.selectedRange || null,
        getOption: () => false, getTargetAtClientPoint: () => null, setSelection(range) { if (window.passageSelection) window.selectedRange = range; }, revealRangeInCenterIfOutsideViewport() {}, focus() {},
        executeEdits(origin, edits) {
          for (const edit of edits.slice().reverse()) {
            const start = model.getOffsetAt({ column: edit.range.startColumn }), end = model.getOffsetAt({ column: edit.range.endColumn });
            sourceValue = sourceValue.slice(0, start) + edit.text + sourceValue.slice(end);
          }
          sourceVersion++; return true;
        },
        onDidChangeModel: subscription, onDidChangeModelContent: subscription, onDidScrollChange: subscription };
      const pdf = {};
      window.readerMonaco = { editor };
      window.ReaderUI = { getPdfViewer: () => ({ pdfDocument: pdf, container: document.getElementById('pdf') }) };
      let visibleTarget;
      const locator = new PdfReviewProvider.PdfLocator({}, { getVisiblePages: () => [{ index: visibleTarget }] }), index = locator.editorSourceIndex(model);
      window.PdfSelection = { locator, showReviewPointer() {}, clearReviewPointer() {} };
      const renderTarget = target => {
        target.normalized = window.PdfSelectionDiff.normalized(target.raw);
        const layer = target.layer = document.querySelector('.textLayer');
        layer.replaceChildren();
        for (const part of target.parts) {
          const span = document.createElement('span'); span.textContent = target.raw.slice(part.start, part.end);
          layer.append(span); part.node = span.firstChild;
        }
        visibleTarget = target;
      };
      const target = new PdfReviewProvider.PdfSourceIndex(new PdfReviewProvider.PdfLocator(), { raw: index.raw, parts: [{ start: 0, end: index.raw.length, font: { bold: false, italic: false } }] });
      index.rememberConnection(0, index.raw.length, target, { start: 0, end: index.raw.length });
      window.addEventListener('pdf-selection-difference', event => { window.lastReviewNotice = event.detail; });
      window.sendNotice = (bold, italic, unmapped = false, textMismatch = false) => {
        target.raw = textMismatch ? index.raw.replace('Word', 'WxrX') : index.raw;
        renderTarget(target);
        index.connections.delete(target);
        index.rememberConnection(0, index.raw.length, target, { start: 0, end: target.raw.length });
        target.parts[0].font = { bold, italic };
        window.dispatchEvent(new CustomEvent('pdf-selection-difference', { detail: {
          editor, model, pdf, interactionId: Math.random(), targets: [target], anchor: { left: 0, top: 500, bottom: 520 },
          notices: unmapped ? [{ html: 'X', pdf: 'Y' }] : [{ ...(textMismatch ? { html: index.raw, pdf: target.raw } : {}), fonts: [target.parts[0].font], text: 'Word', source: { index, start: 0, end: index.raw.length } }]
        } }));
      };
      window.selectFormatPassage = (normal = false, mismatch = false) => {
        sourceValue = normal ? '<p><i>Vorträge <a href="/keep">über</a> die Grundlagen</i></p>' : '<p>„Nur die Arbeit</p>'; sourceVersion++;
        const index = locator.editorSourceIndex(model);
        const target = new PdfReviewProvider.PdfSourceIndex(new PdfReviewProvider.PdfLocator(), { raw: mismatch ? index.raw.replace('Vorträge', 'Vortrage') : index.raw, parts: normal
          ? [{ start: 0, end: index.raw.length, font: { bold: false, italic: false } }] : [
          { start: 0, end: 4, font: { bold: false, italic: true } },
          { start: 4, end: index.raw.length, font: { bold: false, italic: false } }
        ] });
        index.rememberConnection(0, index.raw.length, target, { start: 0, end: target.raw.length });
        renderTarget(target);
        window.passageSelection = window.selectedRange = Object.assign(PdfSelectionDiff.rangeAt(model, 4, 18),
          { selectionStartColumn: 19, positionColumn: 5, isEmpty: () => false });
        window.dispatchEvent(new CustomEvent('pdf-selection-difference', { detail: {
          editor, model, pdf, interactionId: Math.random(), targets: [target],
          notices: [{ source: { index, start: normal ? 0 : 1, end: index.raw.length },
            target: { index: target, start: normal ? 0 : 1, end: target.raw.length } }]
        } }));
      };
    });
    await page.addScriptTag({ content: fullReviewSource });
    const popup = page.locator('.replacement-review');
    await page.evaluate(() => sendNotice(false, false));
    assert.equal(await popup.isHidden(), true, 'matching styles do not open a notice');
    await page.evaluate(() => sendNotice(null, null));
    assert.equal(await popup.isHidden(), true, 'unknown styles do not open a notice');
    await page.evaluate(() => sendNotice(true, null));
    await page.waitForFunction(() => document.querySelector('[data-status]').textContent === '粗体不一致（HTML 否 / PDF 是）');
    assert.equal(await popup.getAttribute('data-side'), 'pdf');
    assert.equal(await popup.getAttribute('data-content-widget'), null);
    const withinPdf = () => {
      const box = document.querySelector('.replacement-review').getBoundingClientRect(), pdf = document.getElementById('pdf').getBoundingClientRect();
      return box.width <= 280 && box.left >= pdf.left && box.right <= pdf.right && box.top >= pdf.top && box.bottom <= pdf.bottom;
    };
    assert.equal(await page.evaluate(withinPdf), true, 'confirmed difference stays within PDF');
    assert.equal(await popup.locator('[data-comparison]').textContent(), '', 'format-only notice shows only the differing format');
    await page.evaluate(() => { ReplacementReview.close(); sendNotice(null, true); });
    await page.waitForFunction(() => document.querySelector('[data-status]').textContent === '斜体不一致（HTML 否 / PDF 是）');
    await page.evaluate(() => { ReplacementReview.close(); sendNotice(true, true); });
    await page.waitForFunction(() => document.querySelector('[data-status]').textContent.includes('斜体不一致') && document.querySelector('[data-status]').textContent.includes('粗体不一致'));
    await page.evaluate(() => { ReplacementReview.close(); sendNotice(true, true, false, true); });
    await page.waitForFunction(() => document.querySelector('[data-status]').textContent === '文字不一致');
    assert.equal(await popup.locator('[data-position]').textContent(), '1 / 2', 'continuous text is one entry followed by its format entry');
    assert.ok(await popup.locator('[data-comparison] mark').count() >= 2);
    assert.equal(await popup.locator('[data-apply]').isEnabled(), true);
    await popup.locator('[data-next]').click();
    assert.equal(await popup.locator('[data-position]').textContent(), '2 / 2');
    assert.match(await popup.locator('[data-status]').textContent(), /斜体不一致.*粗体不一致/);
    assert.equal(await popup.locator('[data-comparison]').textContent(), '');
    assert.equal(await popup.locator('[data-apply]').isEnabled(), true, 'format differences offer replacement');
    assert.equal(await popup.locator('[data-save]').isDisabled(), true);
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('pdf-selection-difference', { detail: lastReviewNotice })));
    assert.equal(await popup.locator('[data-position]').textContent(), '2 / 2', 'selection echoes do not switch back from format to text');
    assert.equal(await page.evaluate(withinPdf), true, 'switching entries stays over PDF');
    await popup.locator('[data-prev]').click();
    assert.equal(await popup.locator('[data-status]').textContent(), '文字不一致');
    assert.equal(await popup.locator('[data-apply]').isEnabled(), true);
    await page.evaluate(() => { ReplacementReview.close(); sendNotice(null, null, false, true); });
    await page.waitForFunction(() => document.querySelector('[data-status]').textContent === '文字不一致');
    assert.doesNotMatch(await popup.textContent(), /未知/);
    await page.evaluate(() => { ReplacementReview.close(); sendNotice(null, null, true); });
    assert.equal(await popup.locator('[data-status]').textContent(), '文字不一致');
    assert.equal(await popup.locator('.review-controls').first().isHidden(), true);
    assert.equal(await page.evaluate(withinPdf), true, 'unknown source notice stays within PDF');
    assert.ok((await popup.boundingBox()).width < 280, 'short notice shrinks to content');
    await page.evaluate(() => { ReplacementReview.close(); sendNotice(true, true, false, true); });
    await page.waitForFunction(() => document.querySelector('[data-status]').textContent === '文字不一致');
    await popup.locator('[data-apply]').click();
    await page.waitForFunction(() => document.querySelector('[data-status]').textContent.includes('粗体不一致'));
    assert.equal(await popup.locator('[data-position]').textContent(), '1 / 1', 'text replacement retains the format entry');
    assert.equal(await page.evaluate(() => readerMonaco.editor.getModel().getValue()), '<p>WxrX</p>');
    assert.equal(await popup.locator('[data-apply]').isEnabled(), true);
    await popup.locator('[data-apply]').click();
    assert.match(await page.evaluate(() => readerMonaco.editor.getModel().getValue()), /font-style:italic;font-weight:bold/);
    await page.evaluate(() => { ReplacementReview.close(); selectFormatPassage(); });
    await page.waitForFunction(() => document.querySelector('[data-status]').textContent === '斜体不一致（HTML 否 / PDF 是）');
    assert.equal(await page.evaluate(() => selectedRange === passageSelection), true,
      'automatic format review preserves the backward passage selection instead of selecting „Nur');
    await page.evaluate(() => { ReplacementReview.close(); selectFormatPassage(true); });
    await page.waitForFunction(() => document.querySelector('[data-status]').textContent === '斜体不一致（HTML 是 / PDF 否）');
    await popup.locator('[data-apply]').click();
    assert.equal(await page.evaluate(() => readerMonaco.editor.getModel().getValue()),
      '<p>Vorträge <a href="/keep">über</a> die Grundlagen</p>', 'Apply removes surplus tags instead of inserting normal-style spans');
    await page.evaluate(() => { ReplacementReview.close(); selectFormatPassage(true, true); });
    await page.evaluate(() => document.querySelector('[data-all]').click());
    await page.waitForFunction(() => readerMonaco.editor.getModel().getValue().replace(/<[^>]+>/g, '').startsWith('Vortrage'));
    const batch = await page.evaluate(() => readerMonaco.editor.getModel().getValue());
    assert.equal(batch.replace(/<[^>]+>/g, ''), 'Vortrage über die Grundlagen', 'batch composes text replacement with removal of the surrounding italic tag');
    assert.doesNotMatch(batch, /font-style:normal/);
  } finally { await browser.close(); }
});

test('Monaco standalone renders native source-line and exact character decorations', async () => {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    let savedSettings = { diffHighlight: true };
    await page.route('http://native.test/**', async route => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === '/api/reader/settings') {
        if (route.request().method() === 'PUT') savedSettings = { ...savedSettings, ...route.request().postDataJSON() };
        return route.fulfill({ json: savedSettings });
      }
      if (pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><div id="editor" style="width:700px;height:400px"></div><style>.mew-ocr-diff-line{border-left:3px solid orange}.mew-ocr-diff-text{background:orange}</style>' });
      if (!pathname.startsWith('/monaco/') || pathname.includes('..')) return route.abort();
      await route.fulfill({ contentType: pathname.endsWith('.css') ? 'text/css' : 'text/javascript',
        body: await readFile(new URL('../node_modules/monaco-editor/' + pathname.slice('/monaco/'.length), import.meta.url)) });
    });
    await page.goto('http://native.test/');
    await page.addScriptTag({ url: '/monaco/min/vs/loader.js' });
    await page.evaluate(() => new Promise(resolve => {
      require.config({ paths: { vs: '/monaco/min/vs' } });
      require(['vs/editor/editor.main'], resolve);
    }));
    await page.addScriptTag({ content: engineSource });
    await page.addScriptTag({ content: fullProviderSource });
    await page.evaluate(async () => {
      await PdfReviewReady;
      window.editor = monaco.editor.create(document.getElementById('editor'), { value: 'first\naX&𠀀Z', wordWrap: 'on' });
      const model = editor.getModel(), raw = model.getValue();
      window.marks = editor.createDecorationsCollection(new PdfReviewProvider.PdfSourceIndex(new PdfReviewProvider.PdfLocator(),
        { raw, starts: [...Array(raw.length).keys()], ends: Array.from({ length: raw.length }, (_, i) => i + 1) }).sourceDecorations(
        [[{ start: 0, end: raw.length, targetStart: 0, targetEnd: raw.length + 1 }, { raw: 'first\naY!𠀀Z+' }]], model));
    });
    await page.waitForSelector('.mew-ocr-diff-line');
    await page.waitForSelector('.mew-ocr-diff-text');
    assert.equal(await page.locator('.mew-ocr-diff-text').innerText(), 'X&');
    assert.equal(await page.evaluate(() => marks.getRange(0).startLineNumber), 2);
    await page.evaluate(() => marks.clear());
    await page.waitForFunction(() => !document.querySelector('.mew-ocr-diff-line'));
    await page.evaluate(() => {
      window.passage = 'A lengthy introductory passage establishes the source location with unique words. The reading has an X character in the middle. A second lengthy passage completes the unique context for this comparison. The ending contains a Q character for another comparison.';
      editor.getModel().setValue('<p>' + passage + '</p>');
      document.body.insertAdjacentHTML('beforeend', '<div id="stage"><div class="pdfViewer"><div class="page" style="position:relative;width:700px;height:200px"><div class="textLayer"><span></span></div></div></div></div>');
      document.querySelector('.textLayer span').textContent = passage.replace('an X', 'an Y').replace('a Q', 'a R');
    });
    await page.evaluate(menu => {
      document.body.insertAdjacentHTML('beforeend', menu);
    }, readerMenu);
    await page.addScriptTag({ content: '(() => {\n' + fullReviewSource
      .split('// PDF comparison is one review provider. Selection synchronization remains independent.')[1]
      .replace(/\r?\n  return window\.PdfReviewProvider;\r?\n\}\)\(\);\s*$/, '') + '\n})();' });
    await page.addScriptTag({ content: source });
    await page.waitForFunction(() => !!window.PdfSelection);
    await page.evaluate(() => {
      PdfSelection.attachEditor(editor);
      window.bus = { on() {}, off() {} };
      PdfSelection.attachViewer({ eventBus: bus, container: document.getElementById('stage'),
        viewer: document.querySelector('.pdfViewer'), pdfDocument: { numPages: 1, getPage: () => new Promise(() => {}) },
        getPageView: () => ({ div: document.querySelector('.page') }), _getVisiblePages: () => ({ views: [{ id: 1 }] }) });
    });
    await page.waitForSelector('.mew-ocr-diff-text');
    assert.deepEqual(await page.locator('.mew-ocr-diff-text').allInnerTexts(), ['X', 'Q'], 'reader preparation decorates the exact differing characters');
    for (const [html, pdf] of [['Q', 'R'], ['X', 'Y']]) {
      const point = await page.evaluate(html => {
        const model = editor.getModel(), position = model.getPositionAt(model.getValue().indexOf(html));
        const visible = editor.getScrolledVisiblePosition(position), rect = editor.getDomNode().getBoundingClientRect();
        const layout = editor.getLayoutInfo();
        return { x: rect.left + layout.decorationsLeft + layout.decorationsWidth / 2,
          y: rect.top + visible.top + visible.height / 2 };
      }, html);
      await page.mouse.click(point.x, point.y);
      await page.waitForFunction(({ html, pdf }) => {
        return window.lastNotice?.notices[0]?.html === html && window.lastNotice?.notices[0]?.pdf === pdf;
      }, { html, pdf });
      await page.evaluate(() => PdfSelection.clear());
    }
    await page.locator('.mew-ocr-diff-text').first().click();
    await page.waitForFunction(() => window.lastNotice);
    assert.equal(await page.evaluate(() => 'HTML: ' + lastNotice.notices[0].html), 'HTML: X');
    assert.equal(await page.evaluate(() => 'PDF: ' + lastNotice.notices[0].pdf), 'PDF: Y');
    await page.locator('#diffHighlightBtn').click();
    await page.waitForFunction(() => !document.querySelector('.mew-ocr-diff-text,.mew-ocr-diff-line,.mew-pdf-selection-difference'));
    assert.equal(await page.locator('#diffHighlightBtn').getAttribute('aria-pressed'), 'false');
    assert.equal(await page.locator('#diffHighlightBtn').textContent(), '显示差异高亮');
    await page.waitForFunction(async () => (await fetch('/api/reader/settings').then(response => response.json())).diffHighlight === false);
    assert.equal(savedSettings.diffHighlight, false);
    await page.evaluate(() => { window.savedViewer = PdfSelection.viewer; PdfSelection.stop(); });
    await page.addScriptTag({ content: source });
    await page.waitForFunction(() => !!window.PdfSelection);
    assert.equal(await page.locator('#diffHighlightBtn').getAttribute('aria-pressed'), 'false', 'saved preference is restored on startup');
    await page.evaluate(() => { PdfSelection.attachEditor(editor); PdfSelection.attachViewer(savedViewer); });
    await page.evaluate(() => {
      editor.getModel().setValue('<p>' + passage + '</p>');
      PdfSelection.highlight(passage);
    });
    await page.waitForTimeout(400);
    assert.equal(await page.locator('.mew-ocr-diff-text,.mew-ocr-diff-line,.mew-pdf-selection-difference').count(), 0, 'diff highlighting stays off after preparation and selection');
    assert.equal(await page.evaluate(() => editor.getValue()), '<p>' + await page.evaluate(() => passage) + '</p>');
    await page.locator('#diffHighlightBtn').click();
    await page.waitForSelector('.mew-ocr-diff-text');
    assert.equal(await page.locator('#diffHighlightBtn').getAttribute('aria-pressed'), 'true');
    await page.waitForFunction(async () => (await fetch('/api/reader/settings').then(response => response.json())).diffHighlight === true);
    await page.locator('.mew-ocr-diff-text').first().click();
    await page.waitForFunction(() => window.lastNotice);
    await page.evaluate(() => {
      const { editor, model, notices } = lastNotice, notice = notices[0], source = notice.source;
      PdfSelectionDiff.applyEdits(editor, model, model.getVersionId(), model.getValue(),
        source.index.textEdits(source.start, source.end, notice.pdf));
    });
    assert.equal(await page.evaluate(() => editor.getValue()), '<p>' + await page.evaluate(() => passage.replace('an X', 'an Y')) + '</p>');
    await page.waitForFunction(() => !window.lastNotice);
    await page.evaluate(() => editor.trigger('test', 'undo'));
    await page.waitForSelector('.mew-ocr-diff-text');
    assert.equal(await page.evaluate(() => editor.getValue()), '<p>' + await page.evaluate(() => passage) + '</p>', 'replacement is one undo step');
    await page.evaluate(() => { document.querySelector('.textLayer span').textContent = passage.replace('an X', 'an Y'); });
    await page.evaluate(() => editor.getModel().setValue('<p>' + passage.replace('an X', 'an Y') + '</p>'));
    await page.waitForFunction(() => !document.querySelector('.mew-ocr-diff-text'));
    await page.waitForTimeout(400);
    assert.equal(await page.locator('.mew-ocr-diff-line').count(), 0, 'correction removes stale markers');
    await page.evaluate(() => editor.getModel().setValue('<p>' + passage + '</p>'));
    await page.waitForSelector('.mew-ocr-diff-text');
    // Surplus HTML has no PDF character: show the comparison at a caret-sized anchor.
    await page.evaluate(() => {
      document.querySelector('.textLayer span').textContent = passage.replace('an X', 'an ');
      editor.getModel().setValue('<p>' + passage.replace('an X', 'an <b>X</b>') + '</p>');
    });
    await page.waitForSelector('.mew-ocr-diff-text');
    await page.locator('.mew-ocr-diff-text').click();
    await page.waitForFunction(() => window.lastNotice?.notices[0]?.html === 'X' && lastNotice.notices[0].pdf === '');
    assert.ok(await page.evaluate(() => Number.isFinite(lastNotice.anchor.left)));
    assert.equal(await page.evaluate(() => lastNotice.notices[0].html || lastNotice.notices[0].pdf), 'X');
    await page.evaluate(() => {
      const { editor, model, notices } = lastNotice, notice = notices[0], source = notice.source;
      PdfSelectionDiff.applyEdits(editor, model, model.getVersionId(), model.getValue(),
        source.index.textEdits(source.start, source.end, notice.pdf));
    });
    assert.ok((await page.evaluate(() => editor.getValue())).includes('an <b></b>'), 'deletion preserves HTML wrappers');
    await page.evaluate(() => editor.trigger('test', 'undo'));
    await page.waitForSelector('.mew-ocr-diff-text');
    await page.locator('.mew-ocr-diff-text').click();
    await page.waitForFunction(() => window.lastNotice);
    await page.evaluate(() => PdfSelection.clear());
    await page.waitForFunction(() => !window.lastNotice);
    await page.locator('.mew-ocr-diff-text').click();
    await page.waitForFunction(() => window.lastNotice);
    await page.evaluate(() => {
      document.querySelector('.textLayer span').textContent = passage;
      editor.getModel().setValue('<p>' + passage.replace('reading', 'reding') + '</p>');
    });
    await page.waitForSelector('.mew-ocr-diff-insert');
    const insertion = page.locator('.mew-ocr-diff-insert');
    const box = await insertion.boundingBox();
    assert.ok(box.width > 0 && box.height > 0, 'missing character marker is visible');
    assert.equal(await insertion.evaluate(node => getComputedStyle(node).borderLeftWidth), '2px');
    const missing = await page.evaluate(() => {
      const model = editor.getModel();
      const mark = model.getAllDecorations().find(item => item.options.beforeContentClassName === 'mew-ocr-diff-insert');
      return { offset: model.getOffsetAt(mark.range.getStartPosition()), hover: mark.options.hoverMessage.value };
    });
    assert.equal(missing.offset, 3 + (await page.evaluate(() => passage.indexOf('reading'))) + 2);
    assert.match(missing.hover, /OCR: "a"/);
    await insertion.click();
    await page.waitForFunction(() => window.lastNotice?.notices[0]?.html === '' && lastNotice.notices[0].pdf === 'a');
    assert.equal(await page.evaluate(() => lastNotice.notices[0].html || lastNotice.notices[0].pdf), 'a');
    await page.evaluate(() => {
      const { editor, model, notices } = lastNotice, notice = notices[0], source = notice.source;
      PdfSelectionDiff.applyEdits(editor, model, model.getVersionId(), model.getValue(),
        source.index.textEdits(source.start, source.end, notice.pdf));
    });
    assert.equal(await page.evaluate(() => editor.getValue()), '<p>' + await page.evaluate(() => passage) + '</p>', 'missing PDF character is inserted');
    await page.evaluate(() => editor.trigger('test', 'undo'));
    await page.waitForSelector('.mew-ocr-diff-insert');
    await page.locator('.mew-ocr-diff-insert').click();
    await page.waitForFunction(() => window.lastNotice);
    await page.evaluate(() => PdfSelection.clear());
    await page.waitForFunction(() => !window.lastNotice);
    await insertion.click();
    await page.waitForFunction(() => window.lastNotice);
    await page.evaluate(() => PdfSelection.clear());
    await page.waitForFunction(() => !window.lastNotice);
    await page.locator('.mew-ocr-diff-line').click();
    await page.waitForFunction(() => window.lastNotice?.notices[0]?.html === '' && lastNotice.notices[0].pdf === 'a');
    await page.evaluate(() => editor.getModel().setValue('<p>' + passage + '</p>'));
    await page.waitForFunction(() => !document.querySelector('.mew-ocr-diff-insert'));
    assert.equal(await page.locator('.mew-ocr-diff-line').count(), 0, 'restoring the missing character clears its marker');
    await page.evaluate(() => {
      document.getElementById('editor').style.width = '300px'; editor.layout();
      document.getElementById('stage').style.cssText = 'position:absolute;left:340px;top:0;width:700px;height:400px';
      document.querySelector('.textLayer span').textContent = passage.replace('an X', 'an "');
      editor.getModel().setValue('<p>' + passage.replace('an X', 'an &ldquo;') + '</p>');
    });
    await page.waitForSelector('.mew-ocr-diff-text');
    await page.locator('.mew-ocr-diff-text').click();
    await page.waitForFunction(() => window.lastNotice?.notices[0]?.html === '“');
    assert.equal(await page.evaluate(() => 'HTML: ' + lastNotice.notices[0].html), 'HTML: “');
    assert.equal(await page.evaluate(() => 'PDF: ' + lastNotice.notices[0].pdf), 'PDF: "');
    assert.ok(await page.evaluate(() => Number.isFinite(lastNotice.anchor.top)), 'selection publishes the PDF anchor');
    await page.evaluate(() => {
      document.body.classList.remove('dark');
      PdfSelection.clear();
      document.querySelector('.textLayer').style.cssText = 'position:absolute;bottom:10px';
    });
    await page.locator('.mew-ocr-diff-text').click();
    await page.waitForFunction(() => window.lastNotice);
    await page.evaluate(() => {
      const { editor, model, notices } = lastNotice, notice = notices[0], source = notice.source;
      PdfSelectionDiff.applyEdits(editor, model, model.getVersionId(), model.getValue(),
        source.index.textEdits(source.start, source.end, notice.pdf));
    });
    assert.equal(await page.evaluate(() => editor.getValue()), '<p>' + await page.evaluate(() => passage.replace('an X', 'an "')) + '</p>', 'quote correction replaces the complete HTML entity');
    const fixture = JSON.parse(await readFile(new URL('./fixtures/pdf-selection-me04.json', import.meta.url), 'utf8'));
    await page.evaluate(fixture => {
      PdfSelection.clear();
      const layer = document.querySelector('.textLayer');
      layer.style.cssText = 'position:absolute;top:0;left:0;font:12px/16px monospace';
      layer.replaceChildren(...fixture.layerRaw.split('\n').map(line => {
        const span = document.createElement('span');
        span.style.cssText = 'display:block;white-space:pre'; span.textContent = line;
        return span;
      }));
      document.querySelector('.page').style.height = '900px';
      document.getElementById('stage').style.overflow = 'auto';
      editor.getModel().setValue(fixture.html);
      editor.revealPositionInCenter(editor.getModel().getPositionAt(fixture.html.indexOf('entwickeln.')));
    }, fixture);
    await page.waitForFunction(() => [...document.querySelectorAll('.mew-ocr-diff-text')].at(-1)?.textContent === '“');
    await page.locator('.mew-ocr-diff-text').last().click();
    await page.waitForFunction(() => window.lastNotice?.notices[0]?.html === '“');
    assert.equal(await page.evaluate(() => 'HTML: ' + lastNotice.notices[0].html), 'HTML: “');
    assert.equal(await page.evaluate(() => 'PDF: ' + lastNotice.notices[0].pdf), 'PDF: "',
      'the rendered page popup excludes matching prose and the footnote');
    await page.evaluate(() => {
      const { editor, model, notices } = lastNotice, notice = notices[0], source = notice.source;
      PdfSelectionDiff.applyEdits(editor, model, model.getVersionId(), model.getValue(),
        source.index.textEdits(source.start, source.end, notice.pdf));
    });
    assert.equal(await page.evaluate(() => editor.getValue()), fixture.html.replace('entwickeln.“', 'entwickeln."'),
      'only the closing quote changes; paragraphs, formatting and footnote remain intact');
    await page.evaluate(() => editor.trigger('test', 'undo'));
    assert.equal(await page.evaluate(() => editor.getValue()), fixture.html, 'quote replacement undoes in one step');
    const headingFixture = JSON.parse(await readFile(new URL('./fixtures/pdf-selection-me04-037.json', import.meta.url), 'utf8'));
    await page.evaluate(fixture => {
      PdfSelection.clear();
      const layer = document.querySelector('.textLayer');
      layer.replaceChildren(...fixture.layerRaw.split('\n').map(line => {
        const span = document.createElement('span');
        span.style.cssText = 'display:block;white-space:pre'; span.textContent = line;
        return span;
      }));
      editor.getModel().setValue(fixture.html);
      editor.revealLine(6);
    }, headingFixture);
    await page.waitForFunction(() => editor.getModel().getAllDecorations().some(item =>
      item.options.hoverMessage?.value?.includes('25')));
    const markedText = await page.evaluate(() => editor.getModel().getAllDecorations()
      .filter(item => item.options.inlineClassName === 'mew-ocr-diff-text')
      .map(item => editor.getModel().getValueInRange(item.range)));
    assert.ok(markedText.length);
    assert.ok(markedText.every(text => !/Erklärung|gegen Karl Grün|<\/?h1>/.test(text)),
      'real Monaco decorations exclude the matching ME04-037 heading and its closing tag');
    await page.evaluate(() => PdfSelection.stop());
    await page.waitForFunction(() => !document.querySelector('.mew-ocr-diff-text'));
    await page.evaluate(() => editor.dispose());
  } finally { await browser.close(); }
});

test('provider loads font/text and popup scripts before selection consumes its mapping API', async () => {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    const requests = [];
    await page.route('http://fallback.test/**', route => {
      const path = new URL(route.request().url()).pathname;
      requests.push(path);
      if (path === '/pdfdiff/pdf-review-provider.js') return route.fulfill({ contentType: 'text/javascript', body: reviewFile });
      if (path === '/pdfdiff/replacement-review.js') return route.fulfill({ contentType: 'text/javascript', body: popupSource });
      if (path === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html>' });
      if (path === '/pdfdiff/pdf-selection-diff.js') return route.fulfill({ contentType: 'text/javascript', body: diffSource });
      return route.abort();
    });
    await page.goto('http://fallback.test/');
    const result = await page.evaluate(async () => {
      await import('/pdfdiff/pdf-review-provider.js');
      await PdfReviewReady;
      return { popupReady: typeof ReplacementReview.open === 'function',
        highlightsReady: typeof ReviewHighlights.create === 'function',
        mappingReady: typeof PdfReviewProvider.PdfLocator === 'function',
        mappingInFontText: 'PdfLocator' in PdfSelectionDiff,
        diff: PdfSelectionDiff.textDiff('中文𠀀 wrong', '中文𠀀 right', true),
        distance: PdfSelectionDiff.textDiff('a'.repeat(200), 'b'.repeat(200)).distance };
    });
    assert.equal(result.popupReady, true);
    assert.equal(result.highlightsReady, true);
    assert.equal(result.mappingReady, true);
    assert.equal(result.mappingInFontText, false);
    assert.equal(result.distance, 200);
    assert.equal(result.diff.parts.map(part => part.html).join(''), '中文𠀀 wrong');
    assert.equal(result.diff.parts.map(part => part.pdf).join(''), '中文𠀀 right');
    assert.ok(result.diff.parts.some(part => part.changed));
    const extracted = await page.evaluate(async () => {
      const locator = new PdfReviewProvider.PdfLocator({}, { isCurrent: () => true, waitForIdle: async () => {} });
      const index = await locator.indexDocument({ numPages: 1, getPage: async () => ({
        getTextContent: async () => ({ items: [{ str: 'Original OCR', transform: [1, 0, 0, 1, 0, 10], width: 40, height: 10 }] })
      }) });
      return { raw: index.raw, readerLoaded: !!window.LocalOcrTextReader };
    });
    assert.equal(extracted.raw, 'Original OCR\n');
    assert.equal(extracted.readerLoaded, false);
    assert.deepEqual(requests.filter(path => path.startsWith('/pdfdiff/')), [
      '/pdfdiff/pdf-review-provider.js', '/pdfdiff/pdf-selection-diff.js',
      '/pdfdiff/replacement-review.js'
    ]);
    assert.equal(await page.locator('.replacement-review').count(), 1);
  } finally { await browser.close(); }
});

