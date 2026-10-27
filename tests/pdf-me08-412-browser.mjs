import assert from 'node:assert/strict';
import { launchBrowser, startServer, stopServer } from './support/browser.mjs';

const server = await startServer('reader-server.js', 17049);
let browser;
try {
  browser = await launchBrowser();
  for (const number of [412, 432]) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/reader/settings', route => route.fulfill({ json: {
    diffHighlight: true, sourceDiffHighlight: true, selectionHighlight: true
  } }));
  await page.goto(`http://127.0.0.1:17049/?volume=8&page=${number}&mode=source`);
  await page.waitForFunction(() => window.readerMonaco?.editor && window.PdfSelection
    && document.querySelector('.mew-pdf-review-pointer'), null, { timeout: 20000 });
  if (number === 432) {
    const result = await page.evaluate(() => {
      const editor = readerMonaco.editor, locator = PdfSelection.locator, index = locator.editorSourceIndex(editor.getModel());
      const targets = locator.environment.getTargets();
      locator.prepareSource(index, targets);
      const target = targets.find(t => t.layer), candidates = index.reviewCandidates(targets);
      const sentence = 'Beweise der Wahrheit und Beweise der Zuverlässigkeit!', at = index.raw.indexOf(sentence);
      const hit = index.connectedRange(target, at, at + sentence.length, false, undefined, true);
      const item = candidates.find(c => c.sourceStart >= at && c.comparison.pdf === 'aftigk');
      const insertion = item && index.connectedRange(target, item.sourceStart, item.sourceEnd, false, undefined, true);
      const marks = editor.getModel().getAllDecorations().filter(d => d.options.inlineClassName?.includes('mew-ocr-diff'));
      return { missingDer: candidates.some(c => c.sourceStart >= at && c.comparison.pdf.trim() === 'der'),
        sentence: hit && PdfSelectionDiff.significantText(target.raw.slice(hit.start, hit.end)),
        lastParagraph: hit && hit.start > target.raw.lastIndexOf('Mitteilungen'),
        insertion: insertion && target.raw.slice(insertion.start, insertion.end),
        whitespaceMarker: marks.some(d => d.range.startLineNumber === 13 && editor.getModel().getValueInRange(d.range) === ' '),
        collapsed: editor.getSelection().isEmpty() };
    });
    assert.equal(result.missingDer, false);
    assert.equal(result.sentence, 'BeweisederWahrhaftigkeitundBeweisederZuverlassigkeit!');
    assert.equal(result.lastParagraph, true);
    assert.equal(result.insertion, 'aftigk');
    assert.equal(result.whitespaceMarker, false, 'no false missing-der marker after the existing der');
    assert.equal(result.collapsed, true);
    await page.evaluate(() => {
      const editor = readerMonaco.editor, index = PdfSelection.locator.editorSourceIndex(editor.getModel());
      const text = 'Man verstehe wohl!', start = index.raw.indexOf(text);
      window.openingText = text;
      window.openingNotice = null;
      addEventListener('pdf-selection-difference', event => {
        const notice = event.detail.notices?.find(n => n.html === openingText);
        if (notice) window.openingNotice = notice;
      });
      const range = index.sourceRange(editor.getModel(), start, start + text.length);
      editor.revealRangeInCenter(range);
      editor.setSelection(range);
    });
    await page.waitForFunction(() => window.openingNotice, null, { timeout: 5000 });
    const opening = await page.evaluate(() => {
      const notice = openingNotice;
      return { html: notice.html, pdf: notice.pdf,
        measured: notice.target.index.raw.slice(notice.target.start, notice.target.end),
        rect: notice.box };
    });
    assert.equal(opening.html, 'Man verstehe wohl!');
    assert.equal(opening.pdf, 'Ma?  ^rsteke wohl!');
    assert.equal(opening.measured, opening.pdf, 'painted range excludes the stray OCR prefix before Man');
    assert.ok(opening.rect.w > 0 && opening.rect.h > 0);
    await page.waitForFunction(() => ReaderUI.getPdfViewer().getPageView(453).renderingState === 3);
    assert.deepEqual(errors, []);
    console.log('ME08-432: der marker, final sentence and visible Man verstehe wohl! selection passed');
    await page.close();
    continue;
  }
  const before = await page.evaluate(() => {
    const editor = readerMonaco.editor, model = editor.getModel(), locator = PdfSelection.locator;
    const index = locator.editorSourceIndex(model), targets = locator.environment.getTargets();
    const candidates = index.reviewCandidates(targets), at = index.raw.indexOf('597–601') + 3;
    const item = candidates.find(c => c.sourceStart === at && c.sourceEnd === at + 1);
    const range = index.sourceRange(model, at, at + 1);
    const marks = model.getAllDecorations().filter(d => d.options.inlineClassName?.includes('mew-ocr-diff'));
    const des = index.raw.indexOf('des deutschen');
    const div = ReaderUI.getPdfViewer().getPageView(433).div;
    const pointer = PdfReviewProvider.getHighlight(div, true)?.notices.find(n => n.source?.start === at && n.source.end === at + 1);
    window.me08DashRange = range;
    editor.revealRangeInCenter(range); editor.render(true);
    return { comparison: item?.comparison, collapsed: editor.getSelection().isEmpty(), source: editor.getValue(),
      marked: marks.some(d => model.getValueInRange(d.range) === '–' && d.range.startLineNumber === range.startLineNumber),
      desMarked: marks.some(d => model.getOffsetAt(d.range.getStartPosition()) < index.ends[des + 2]
        && model.getOffsetAt(d.range.getEndPosition()) > index.starts[des]),
      pdf: pointer && pointer.target.index.raw.slice(pointer.target.start, pointer.target.end) };
  });
  assert.deepEqual(before.comparison, { html: '–', pdf: '-' });
  assert.equal(before.collapsed, true);
  assert.equal(before.marked, true, 'dash is highlighted before any selection');
  assert.equal(before.desMarked, false, 'matching des stays outside deletion highlights');
  assert.equal(before.pdf, '-', 'default PDF pointer covers only the dash');
  await page.waitForTimeout(150);
  const point = await page.evaluate(() => {
    const editor = readerMonaco.editor, box = editor.getDomNode().getBoundingClientRect();
    const pos = editor.getScrolledVisiblePosition({ lineNumber: me08DashRange.startLineNumber, column: me08DashRange.startColumn });
    return { x: box.left + pos.left + 2, y: box.top + pos.top + pos.height / 2 };
  });
  await page.mouse.click(point.x, point.y);
  const popup = page.locator('.replacement-review');
  await popup.waitFor({ state: 'visible', timeout: 5000 });
  assert.deepEqual(await popup.locator('[data-comparison] mark').allTextContents(), ['–', '-']);
  assert.equal(await page.evaluate(() => readerMonaco.editor.getValue()), before.source);
  assert.deepEqual(errors, []);
  console.log('ME08-412: des alignment, initial HTML/PDF dash highlights and exact click popup passed');
  await page.close();
  }
} finally { await browser?.close(); await stopServer(server); }
