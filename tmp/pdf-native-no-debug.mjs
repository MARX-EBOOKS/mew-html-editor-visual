import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const fixture = await mkdtemp(path.join(tmpdir(), 'mew-pdf-cache-'));
const python = process.env.PYTHON || 'python';
execFileSync(python, ['-c', `
import fitz, json, sys
from pathlib import Path
root = Path(sys.argv[1])
(root/'pages').mkdir()
(root/'pages/ME01-001.html').write_text('<p>Normal surrounding text for stable alignment.</p><p>Italic passage with enough letters.</p><p>Bold passage with enough letters.</p><p>Another WRONG reading here.</p>', encoding='utf-8')
with fitz.open() as book:
    page=book.new_page()
    for y, font, text in [(40,'Times-Roman','Normal surrounding text for stable alignment.'), (70,'Times-Italic','Italic passage with enough letters.'), (100,'Times-Bold','Bold passage with enough letters.'), (130,'Times-Roman','Another correct reading here.')]:
        page.insert_text((30,y),text,fontname=font,fontsize=14 if font=='Times-Italic' else 11,
                         color=(1,0,0) if font=='Times-Italic' else (0,0,0))
    book.set_page_labels([dict(startpage=0,prefix='',style='D',firstpagenum=1)])
    book.save(root/'scan.pdf')
(root/'config.json').write_text(json.dumps(dict(volumes=[dict(id='1',pages=dict(directory='pages',pattern='^ME01-([0-9]+)[.]html$'),pdf='scan.pdf')])),encoding='utf-8')
`, fixture], { windowsHide: true });
execFileSync(python, ['pdf_text_backend.py', '--config', path.join(fixture, 'config.json')], { windowsHide: true });
let server, browser;
try {
  server = spawn(process.execPath, ['reader-server.js', '-p', '41886', '-c', path.join(fixture, 'config.json')], { windowsHide: true, stdio: 'pipe' });
  let output = '';
  server.stdout.on('data', data => output += data);
  server.stderr.on('data', data => output += data);
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null) throw new Error(output);
    try { if ((await fetch('http://127.0.0.1:41886/')).ok) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  browser = await chromium.launch({ executablePath: process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: true });
  const page = await browser.newPage();
  const errors = [];
  await page.route('**/pdfdiff/local-ocr-text-reader.js', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: await response.text() + `
      LocalOcrTextReader.readDocument = LocalOcrTextReader.readDocumentFonts = () => {
        throw new Error('JSON comparison must not call the fallback text/font reader');
      };
    ` });
  });
  page.on('pageerror', error => errors.push(String(error)));
  await page.goto('http://127.0.0.1:41886/?volume=1&page=1&mode=source');
  await page.waitForFunction(() => window.ReaderUI?.getPdfViewer()?.pdfDocument && window.PdfSelection);
  await page.evaluate(async () => {
    const config = await (await fetch('/api/reader/config')).json();
    const pdf = ReaderUI.getPdfViewer().pdfDocument;
    pdf.ocrTextUrl ||= config.volumes[0].pdfTextUrl;
    await PdfSelection.locator.indexDocument(pdf);
  });
  await page.waitForFunction(() => {
    const pdf = ReaderUI?.getPdfViewer()?.pdfDocument;
    return pdf && PdfSelection?.locator.getDocumentIndex(pdf);
  });
  const result = await page.evaluate(async () => {
    const pdf = ReaderUI.getPdfViewer().pdfDocument;
    const locator = PdfSelection.locator;
    const index = await locator.indexDocument(pdf);
    // Neither document comparison nor format indexing may reopen/extract PDF pages.
    pdf.getPage = () => { throw new Error('Unexpected PDF extraction'); };
    const source = locator.sourceIndex('<p>Normal surrounding text for stable alignment.</p><p>Italic passage with enough letters.</p><p>Bold passage with enough letters.</p><p>Another WRONG reading here.</p>');
    locator.prepareSource(source, [index], pdf);
    await locator.indexFonts(pdf, source);
    const connections = (source.connections.get(index) || []).map(connection => [connection, index]);
    const canonical = locator.sourceIndex('<p>Normal surrounding text for stable alignment.</p><p><em>Italic passage with enough letters.</em></p><p><strong>Bold passage with enough letters.</strong></p><p>Another correct reading here.</p>');
    locator.prepareSource(canonical, [index], pdf);
    const canonicalFormats = PdfSelectionDiff.formatDifferences(canonical,
      (canonical.connections.get(index) || []).map(connection => [connection, index]));
    return { url: pdf.ocrTextUrl, raw: index.raw,
      canonicalFormats: canonicalFormats.length,
      runs: PdfSelectionDiff.fontRuns(index),
      formats: PdfSelectionDiff.formatDifferences(source, connections).map(item => ({ text: item.text, font: item.font })),
      texts: PdfSelectionDiff.reviewCandidates(source, [index]).map(item => item.comparison),
      same: index === await locator.indexDocument(pdf), cached: !index.textLayer,
      geometryFree: index.pages.every(page => page.parts.every(part => !part.item && !part.bbox)),
      blocks: index.pages[0].blocks.length };
  });
  assert.match(result.url, /^\/OCR_DATA\/scan\.[a-f0-9]+\/manifest\.json$/);
  const jsonResponse = await page.request.get(`http://127.0.0.1:41886${result.url}`);
  assert.ok(jsonResponse.ok());
  const { readFile, readdir } = await import('node:fs/promises');
  const savedName = (await readdir(path.join(fixture, 'OCR_DATA'))).find(name => name.startsWith('scan.'));
  assert.deepEqual(await jsonResponse.body(), await readFile(path.join(fixture, 'OCR_DATA', savedName, 'manifest.json')));
  const payload = await jsonResponse.json();
  assert.equal(payload.schema, 7);
  assert.equal(payload.geometry, 'pdfjs');
  assert.equal(payload.page_count, 1);
  assert.equal(payload.text, undefined);
  const pageUrl = new URL(payload.pages[0].file, `http://127.0.0.1:41886${result.url}`);
  const pageResponse = await page.request.get(pageUrl.href);
  assert.ok(pageResponse.ok());
  const pagePayload = await pageResponse.json();
  assert.equal(pagePayload.page_index, 0);
  assert.equal(pagePayload.document_id, payload.document_id);
  assert.ok(pagePayload.parsing_res_list.every(block => block.lines.every(line => line.spans.length)));
  assert.equal((await readdir(path.join(fixture, 'OCR_DATA', savedName))).length, 2);
  assert.equal((await readdir(path.join(fixture, 'OCR_DATA'))).length, 1);
  assert.ok(result.same);
  assert.ok(result.cached, 'comparison must use the saved page results');
  assert.ok(result.geometryFree);
  assert.ok(result.blocks > 0);
  assert.equal(result.canonicalFormats, 0, 'em/strong compare as canonical i/b');
  assert.ok(result.runs.some(run => run.italic === true));
  assert.ok(result.runs.some(run => run.italic === true && run.size === 14 && run.color === 0xFF0000 && run.alpha === 255));
  assert.ok(result.runs.some(run => run.bold === true));
  assert.ok(result.formats.some(item => item.font.italic === true && item.text.includes('Italic')));
  assert.ok(result.formats.some(item => item.font.bold === true && item.text.includes('Bold')));
  assert.ok(result.texts.some(item => item.html.includes('WRONG') && item.pdf.includes('correct')));
  await page.waitForSelector('.textLayer span');
  await page.evaluate(() => {
    const span = [...document.querySelectorAll('.textLayer span')].find(span => span.textContent.includes('Normal surrounding'));
    const range = document.createRange();
    range.selectNodeContents(span);
    const selection = document.getSelection();
    selection.removeAllRanges(); selection.addRange(range);
  });
  await page.waitForFunction(() => {
    const editor = window.readerMonaco?.editor;
    return editor?.getModel().getValueInRange(editor.getSelection()).includes('Normal surrounding');
  });
  await page.waitForFunction(() => [...document.querySelectorAll('.textLayer .highlight')]
    .some(span => span.textContent.includes('Normal surrounding')));
  const unicode = await page.evaluate(async () => {
    const originalFetch = window.fetch;
    const manifest = { schema: 7, document_id: 'unicode', page_count: 2, text_length: 5,
      fonts: [{ name: 'Italic', italic: true, bold: false }], pages: [
        { page_index: 0, page_label: '1', start: 0, end: 3, file: 'page-00001.json' },
        { page_index: 1, page_label: '2', start: 3, end: 5, file: 'page-00002.json' }] };
    const makePage = (i, content) => ({ schema: 7, document_id: 'unicode', page_index: i,
      page_count: 2, page_label: String(i + 1), comparison: { offset_unit: 'utf16', raw: content,
        start: i === 0 ? 0 : 4, end: (i === 0 ? 0 : 4) + content.length,
        parts: [{ start: i === 0 ? 0 : 4, end: (i === 0 ? 0 : 4) + content.length - 1, fontIndex: 0 }] }, parsing_res_list: [{ block_id: 0, block_order: 0,
        block_label: 'text', block_content: content, start: 0, end: [...content].length, lines: [
          { start: 0, end: [...content].length, spans: [{ length: [...content].length - 1, font_index: 0 }] }] }] });
    try {
      window.fetch = async url => {
        const name = new URL(url).pathname.split('/').pop();
        const data = name === 'manifest.json' ? manifest : makePage(name.includes('00001') ? 0 : 1,
          name.includes('00001') ? 'A😀\n' : 'I\n');
        return new Response(JSON.stringify(data));
      };
      const locator = PdfSelectionDiff.createLocator({}, { isCurrent: () => true, waitForIdle: async () => {} });
      const index = await locator.indexDocument({ ocrTextUrl: '/unicode/manifest.json', numPages: 2 });
      return { raw: index.raw, pages: index.pages.map(page => [page.start, page.end]),
        spans: index.pages.map(page => page.parts.map(span => [span.start, span.end])) };
    } finally { window.fetch = originalFetch; }
  });
  assert.deepEqual(unicode, { raw: 'A😀\nI\n', pages: [[0, 4], [4, 6]], spans: [[[0, 3]], [[4, 5]]] });
  const nativeHighlights = await page.evaluate(() => {
    const view = ReaderUI.getPdfViewer().getPageView(0);
    const div = document.createElement('div'), layer = document.createElement('div');
    div.style.cssText = 'position:absolute;width:400px;height:200px';
    layer.className = 'textLayer'; div.append(layer); document.body.append(div);
    const strings = ['repeat ', '😀 second ', '', 'repeat'];
    const spans = strings.map((text, i) => {
      const span = document.createElement('span'); span.textContent = text;
      // Original item order deliberately disagrees with visual top/left order.
      span.style.cssText = `position:absolute;top:${150 - i * 40}px;left:${200 - i * 40}px`;
      layer.append(span); return span;
    });
    const controller = { highlightMatches: true, pageMatches: [[0]], pageMatchesLength: [[6]],
      state: { highlightAll: false }, selected: { pageIdx: 0, matchIdx: 0 }, scrollMatchIntoView() {} };
    const highlighter = new view._textHighlighter.constructor({ findController: controller,
      eventBus: view.eventBus, pageIndex: 0 });
    highlighter.setTextMapping(spans, strings); highlighter.enable();
    const observer = new MutationObserver(() => {});
    observer.observe(layer, { childList: true, subtree: true });
    const index = { layer, highlighter, observer, raw: strings.join('') };
    const start = index.raw.lastIndexOf('repeat'), hit = { start, end: start + 6 };
    const result = PdfReviewProvider.measureHighlights(div, index, [hit], hit);
    PdfReviewProvider.paintHighlight(div, result.boxes, 'gold');
    const marked = () => [...layer.querySelectorAll('.highlight')].map(span => span.textContent);
    const combined = marked();
    const pointer = PdfReviewProvider.measureHighlights(div, index, [{ start: 7, end: 9 }]);
    PdfReviewProvider.paintHighlight(div, pointer.boxes, 'gold', true);
    const unicodeMarked = marked().includes('😀');
    PdfReviewProvider.clearHighlights(false);
    const pointerSurvives = marked().includes('😀') && !spans[3].querySelector('.highlight');
    PdfReviewProvider.clearHighlights(true);
    const restored = marked();
    const insertion = PdfReviewProvider.measureHighlights(div, index, [{ start: 10, end: 10 }]);
    PdfReviewProvider.paintHighlight(div, insertion.boxes, 'gold');
    const caret = !!layer.querySelector('.highlight.appended:empty');
    PdfReviewProvider.clearHighlights(); highlighter.disable(); observer.disconnect(); div.remove();
    return { combined, unicodeMarked, pointerSurvives, restored, caret,
      unchanged: strings.join('') === index.raw, noOverlay: !div.querySelector('.mew-pdf-selection-highlight') };
  });
  assert.deepEqual(nativeHighlights, { combined: ['repeat', 'repeat'], unicodeMarked: true,
    pointerSurvives: true, restored: ['repeat'], caret: true, unchanged: true, noOverlay: true });
  const fallback = await page.evaluate(async () => {
    const originalFetch = window.fetch, originalReader = LocalOcrTextReader.readDocument;
    let calls = 0;
    try {
      window.fetch = async () => new Response('{}');
      LocalOcrTextReader.readDocument = async () => {
        calls++;
        return { raw: 'Fallback text', pages: [], textLayer: true, fontVersion: 0 };
      };
      const locator = PdfSelectionDiff.createLocator({}, { isCurrent: () => true });
      try {
        await locator.indexDocument({ ocrTextUrl: '/invalid/manifest.json', numPages: 1 });
        return { calls, rejected: false };
      } catch (error) {
        return { calls, rejected: /Run pdf_text_backend.py/.test(error.message) };
      }
    } finally { window.fetch = originalFetch; LocalOcrTextReader.readDocument = originalReader; }
  });
  assert.deepEqual(fallback, { calls: 0, rejected: true });
  assert.deepEqual(errors, []);
  console.log('Python launcher, PDF display, cached text/format comparison and index reuse passed.');
} finally {
  await browser?.close();
  server?.kill();
  // Let the Python backend observe the launcher's pipe closing before removing fixtures.
  await new Promise(resolve => setTimeout(resolve, 800));
  await rm(fixture, { recursive: true, force: true });
}
