import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';
import { chromium } from 'playwright';

const reviewFile = await readFile(new URL('../tmp/pdf-provider-trim-before.js', import.meta.url), 'utf8');
const mappingSection = reviewFile.slice(reviewFile.indexOf('  // Source/PDF mapping and candidate generation.'),
  reviewFile.indexOf('  // Shared popup and session initialization.'));
const selectionFile = await readFile(new URL('../public/pdfdiff/pdf-selection.js', import.meta.url), 'utf8');
const selectionMapping = selectionFile.slice(selectionFile.indexOf('  function findLocations('),
  selectionFile.indexOf('  function nativeBoxes('))
  .replace('visiblePages().map(number => ({ number, index: layerIndex(viewer.getPageView(number - 1)?.div) }))',
    'environment.getVisiblePages?.() || []')
  .replace('viewer?.pdfDocument', 'environment.getPdf?.()');
const mappingSource = '(() => {\n' + mappingSection + '\n})();';
// Unit tests exercise the private selection functions with the same locator and environment.
const selectionMappingSource = mappingSource
  .replace('    return { sourceIndex', '    const diff = { sourceIndex')
  .replace('getDocumentIndex, prepareSource };',
    'getDocumentIndex, prepareSource };\n    return { ...diff, findLocations, locateSource, locateLayer };\n' + selectionMapping);
const popupSource = await readFile(new URL('../public/pdfdiff/replacement-review.js', import.meta.url), 'utf8');
const fullReviewSource = popupSource + '\n' + reviewFile.replace(mappingSection, '');
const fullProviderSource = fullReviewSource;
const diffSource = await readFile(new URL('../public/pdfdiff/pdf-selection-diff.js', import.meta.url), 'utf8');
const engineSource = diffSource + '\n' + selectionMappingSource;
const highlightSource = popupSource.split('// Shared review popup, session, navigation and saving.')[0];
const providerSource = highlightSource + '\n' + fullReviewSource
  .split('// PDF comparison is one review provider. Selection synchronization remains independent.')[1]
  .replace(/\r?\n  return window\.PdfReviewProvider;\r?\n\}\)\(\);\s*$/, '');
const source = `if (!window.PdfReviewProvider?.measureHighlights) { ${fullReviewSource} }` + `
window.lastNotice = null;
window.addEventListener('pdf-selection-difference', event => { window.lastNotice = event.detail; });
window.addEventListener('pdf-selection-highlight-status', event => { if (event.detail.mode === null) window.lastNotice = null; });
` + await readFile(new URL('../public/pdfdiff/pdf-selection.js', import.meta.url), 'utf8');
const readerMenu = (await readFile(new URL('../public/reader.html', import.meta.url), 'utf8')).match(/<button id="diffHighlightBtn".*?<\/button>/)[0];
function engine() {
  const window = {};
  vm.runInNewContext(engineSource, { window });
  return Object.assign(window.PdfReviewProvider, window.PdfSelectionDiff);
}
function reviewProvider(api, providers = new Map(), selection, document = {}) {
  const window = { PdfSelection: selection, PdfSelectionDiff: api, PdfReviewProvider: api, ReplacementReview: { register: provider => { providers.set(provider.id, provider); return () => {}; } },
    addEventListener() {}, removeEventListener() {} };
  vm.runInNewContext(providerSource, { window, document, setInterval: () => 0, clearInterval() {} });
  return window.PdfReviewProvider;
}

test('concurrent font indexing shares page work while cancellation stays caller-local', async () => {
  const api = engine();
  let pageReads = 0, operators = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const page = {
    commonObjs: new Map([['f', { name: 'Times', bold: false, italic: false }]]),
    getTextContent: async () => ({ items: [{ str: 'Text', fontName: 'f', transform: [1, 0, 0, 1, 0, 10], height: 10, width: 20 }] }),
    getOperatorList: async () => { operators++; await gate; return { fnArray: [], argsArray: [] }; }
  };
  const pdf = { numPages: 1, getPage: async () => { pageReads++; return page; } };
  const locator = api.createLocator({}, { isCurrent: () => true, waitForIdle: async () => {} });
  const index = await locator.indexDocument(pdf);
  const controller = new AbortController();
  const first = locator.indexFonts(pdf, null, controller.signal), second = locator.indexFonts(pdf);
  await Promise.resolve();
  controller.abort(); release();
  assert.equal(await first, null);
  assert.equal(await second, index);
  assert.equal(pageReads, 1, 'text indexing and font detection use the same PDF page read');
  assert.equal(operators, 1);
  assert.equal(index.fontVersion, 1, 'one metadata publication per page');
});

test('prepared page reuse invalidates when connections or target pages change', () => {
  const locator = engine().createLocator({}, { document: { createElement: () => ({}) } });
  const source = locator.sourceIndex('Alpha Beta Gamma Delta');
  const page = locator.sourceIndex(source.raw), pdf = {};
  locator.prepareSource(source, [page], pdf);
  const initial = source.connections.get(page);
  let scopeReads = 0;
  const scopes = source.pageScopes;
  source.pageScopes = { get(target) { scopeReads++; return scopes.get(target); }, set: (target, value) => scopes.set(target, value) };
  for (let i = 0; i < 20; i++) locator.prepareSource(source, [page], pdf);
  assert.equal(scopeReads, 0, 'unchanged mappings bypass preparation entirely');
  assert.equal(source.connections.get(page), initial);
  locator.rememberConnection(source, 0, 5, page, { start: 0, end: 5 });
  locator.prepareSource(source, [page], pdf);
  assert.ok(scopeReads > 0, 'new selection mappings invalidate preparation');
  const rebuilt = locator.sourceIndex(source.raw);
  locator.prepareSource(source, [rebuilt], pdf);
  assert.ok(source.connections.get(rebuilt)?.length, 'rebuilt text layers receive fresh mappings');
});

test('candidate interval lookup retains overlap and insertion boundary rules', () => {
  const api = engine(), locator = api.createLocator({}, { document: { createElement: () => ({}) } });
  const index = locator.sourceIndex('abcdefghijklmnopqrstuv');
  const intervals = [[5, 8], [0, 2], [2, 5], [8, 8], [7, 10], [8, 11], [11, 14], [14, 14], [13, 15]];
  const targets = intervals.map(([start, end]) => {
    const target = { raw: 'XYZ' };
    index.connections.set(target, [{ start, end, targetStart: 0, targetEnd: 3,
      editorDiff: { parts: [{ html: index.raw.slice(start, end), pdf: target.raw, changed: true }] } }]);
    return target;
  });
  assert.deepEqual(Array.from(api.reviewCandidates(index, targets), item => item.id),
    ['0:2', '2:5', '5:8', '8:8', '11:14', '14:14']);
});

test('large selected passages share one comparison between replacement edits and popup rendering', async () => {
  const api = engine(), providers = new Map(), pdf = {};
  const diff = api.textDiff;
  let comparisons = 0;
  api.textDiff = (...args) => { comparisons++; return diff(...args); };
  const locator = api.createLocator({}, { document: { createElement: () => ({}) } });
  const html = 'A long selected passage with surrounding context. '.repeat(320);
  const index = locator.sourceIndex(html), changed = html.indexOf('selected') + 3;
  const reading = html.slice(0, changed) + 'X' + html.slice(changed + 1);
  const notice = { html, pdf: reading, source: { index, start: 0, end: html.length } };
  const model = { getValue: () => html, getPositionAt: offset => ({ lineNumber: 1, column: offset + 1 }) };
  reviewProvider(api, providers, { viewer: { pdfDocument: pdf }, locator });
  const provider = providers.get('pdf-ocr');
  const items = await provider.provide({ source: html, model, request: { pdf, notice }, signal: new AbortController().signal });
  assert.equal(items.length, 1);
  const item = items[0], state = { model, items, choices: new Map([[item.id, 'pdf']]) };
  const content = provider.content(state, item);
  provider.content(state, item);
  assert.equal(comparisons, 1, 'opening and rendering the same selection must not repeat its character diff');
  assert.equal(api.previewEdits(html, item.options[0].edits), reading, 'cached parts preserve the exact replacement');
  assert.equal(content.comparison[0].parts.map(part => part.text).join(''), html);
  assert.equal(content.comparison[1].parts.map(part => part.text).join(''), reading);
  notice.pdf = reading + '!';
  provider.content(state, item);
  assert.equal(comparisons, 2, 'a changed PDF reading invalidates the comparison');
});

test('review navigation reuses comparison diffs and invalidates changed readings', () => {
  const api = engine(), providers = new Map(), diff = api.textDiff;
  let calls = 0;
  api.textDiff = (...args) => { calls++; return diff(...args); };
  reviewProvider(api, providers);
  const item = { id: 'item', comparison: { html: 'before WRONG after', pdf: 'before RIGHT after' },
    options: [{ id: 'pdf', edits: [] }] };
  const state = { choices: new Map([['item', 'pdf']]), items: [item] };
  const provider = providers.get('pdf-ocr');
  const first = provider.content(state, item);
  for (let i = 0; i < 20; i++) assert.deepEqual(provider.content(state, item).comparison, first.comparison);
  assert.equal(calls, 1);
  item.comparison.pdf = 'before NEW after';
  provider.content(state, item);
  assert.equal(calls, 2, 'changed text must not reuse the preceding diff');
});

test('popup anchor reuses mappings and text geometry while following scrolling and changed connections', () => {
  const window = {};
  vm.runInNewContext(engineSource.replace(
    '      connection ||= (source.connections.get(target)',
    '      window.mappingCalls = (window.mappingCalls || 0) + 1; connection ||= (source.connections.get(target)'
  ), { window });
  let top = 20, scale = 1, visible, measurements = 0;
  const locator = window.PdfReviewProvider.createLocator({}, {
    getVisiblePages: () => [{ index: visible }],
    document: { createElement: () => ({}), createRange: () => ({ setStart() {}, setEnd() {},
      getClientRects: () => { measurements++; return [{ left: 10, top, bottom: top + 12, height: 12 }]; } }) }
  });
  const source = locator.sourceIndex('Alpha Beta');
  visible = locator.sourceIndex('Alpha Beta');
  visible.layer = { isConnected: true, getBoundingClientRect: () => ({ left: 0, top: top - 20, width: 600 * scale, height: 800 * scale }) };
  visible.parts = [{ start: 0, end: visible.raw.length, node: { length: visible.raw.length } }];
  locator.rememberConnection(source, 0, source.raw.length, visible, { start: 0, end: visible.raw.length });
  const item = { sourceStart: 6, sourceEnd: 10, pdfSource: { index: source, start: 6, end: 10 } };
  assert.equal(locator.reviewAnchor(item, source).top, 20);
  const initial = window.mappingCalls;
  top = 50;
  assert.equal(locator.reviewAnchor(item, source).top, 50, 'scrolling follows the current layer position');
  assert.equal(measurements, 1, 'scrolling does not remeasure selected text');
  assert.equal(window.mappingCalls, initial, 'scrolling reuses the confirmed mapping');
  scale = 2;
  assert.equal(locator.reviewAnchor(item, source).bottom, 94, 'cached coordinates follow the layer scale');
  assert.equal(measurements, 1, 'scaling existing geometry needs no text measurement');
  scale = 1;
  source.connections.set(visible, [...source.connections.get(visible)]);
  locator.reviewAnchor(item, source);
  assert.ok(window.mappingCalls > initial, 'changed connections invalidate the mapping');
  assert.equal(measurements, 2, 'changed connections invalidate text geometry');
  visible.layer.isConnected = false;
  assert.equal(locator.reviewAnchor(item, source), null, 'detached layers never anchor a popup');
});

test('review popup navigates immediately without full model reads and coalesces scroll layout', async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
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

test('PDF newline differences use a caret without highlighting adjacent letters', () => {
  for (const newline of ['\n', '\r\n', '\r']) {
    const endpoints = [];
    const provider = reviewProvider(engine(), new Map(), undefined, { createRange: () => ({
      setStart(node, offset) { endpoints.push([node, offset]); },
      setEnd(node, offset) { endpoints.push([node, offset]); },
      getClientRects: () => [{ left: 20, right: 20, top: 20, width: 0, height: 10 }]
    }) });
    const next = { length: 4 }, raw = 'alpha' + newline + 'beta';
    const index = { raw, parts: [
      { node: { length: 5 }, start: 0, end: 5 },
      { node: next, start: 5 + newline.length, end: raw.length }
    ] };
    const div = { clientLeft: 0, clientTop: 0, clientWidth: 100, clientHeight: 100,
      offsetWidth: 100, offsetHeight: 100, getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }) };
    const hit = { start: 5, end: 5 + newline.length, difference: { html: 's', pdf: newline } };
    const result = provider.measureHighlights(div, index, [hit], hit);
    assert.deepEqual(endpoints, [[next, 0], [next, 0]], 'both PDF range endpoints stay at the insertion point');
    assert.equal(result.boxes.length, 1);
    assert.equal(result.boxes[0].caret, true);
    assert.equal(result.boxes[0].w, .02);
    assert.equal(result.notices[0].pdf, newline, 'replacement retains the actual line break');
  }
});

test('font detection preserves unknown attributes and merges only compatible UTF-16 runs', () => {
  const api = engine();
  assert.equal(api.fontStyle(null, 'g_d0_f1').italic, null);
  assert.equal(api.fontStyle(null, 'serif', { fontWeight: '400', fontStyle: 'normal' }).bold, null);
  const italic = api.fontStyle({ name: 'ABCDEF+Times-Italic', italic: true, bold: false });
  const bold = api.fontStyle({ name: 'Helvetica-Bold', italic: false, bold: true });
  assert.equal(italic.italic, true);
  assert.equal(italic.bold, false);
  assert.equal(api.fontStyle({ name: 'Blackadder', bold: false }).bold, false, 'explicit metadata takes priority over name hints');
  assert.equal(api.fontStyle(null, 'Times-BoldOblique').bold, true);
  assert.equal(api.fontStyle(null, '', { fontStyle: 'oblique 12deg' }).italic, true);
  const index = { raw: '𠀀a b c', parts: [
    { start: 0, end: 3, font: italic }, { start: 4, end: 5, font: italic }, { start: 6, end: 7, font: bold }
  ] };
  const runs = api.fontRuns(index, 2, 7);
  assert.equal(runs.length, 2);
  assert.equal(index.raw.slice(runs[0].start, runs[0].end), 'a b');
  assert.match(api.fontSummary(runs), /斜体：混合；粗体：混合/);
  assert.match(api.fontSummary([]), /未知/);
});

test('independent text differences stay separate across tags while format runs retain their grouping', () => {
  const api = engine();
  const locator = api.createLocator({}, { document: { createElement: () => ({}) } });
  const source = '<p><i>liebe</i>“ …</p>\n<p>later <b>abc</b>.</p>';
  const model = { getValue: () => source, getVersionId: () => 1 };
  const index = locator.editorSourceIndex(model);
  const target = { raw: index.raw.replace('liebe“ …', 'Liebe" ...').replace('abc', 'xyz') };
  locator.rememberConnection(index, 0, index.raw.length, target, { start: 0, end: target.raw.length });
  const items = api.reviewCandidates(index, [target]);
  assert.deepEqual(Array.from(items, item => [item.comparison.html, item.comparison.pdf]),
    [['l', 'L'], ['“', '"'], ['…', '...'], ['abc', 'xyz']]);
  const updated = api.previewEdits(source, items.flatMap(item => item.options[0].edits));
  assert.equal(updated, '<p><i>Liebe</i>" ...</p>\n<p>later <b>xyz</b>.</p>', 'merged edits preserve inline tags');

  const formatted = '<p><i>a</i><b>b</b> <i>c</i><b>d</b></p>\n<p><i>E</i><b>F</b></p>';
  const formatIndex = locator.editorSourceIndex({ getValue: () => formatted, getVersionId: () => 1 });
  const regular = { raw: formatIndex.raw, parts: [{ start: 0, end: formatIndex.raw.length, font: { italic: false, bold: false } }] };
  const connection = locator.rememberConnection(formatIndex, 0, formatIndex.raw.length, regular, { start: 0, end: regular.raw.length });
  const formats = api.formatDifferences(formatIndex, [[connection, regular, api.connectionDiff(formatIndex, regular, connection)]]);
  assert.deepEqual(Array.from(formats, item => item.text), ['ab cd', 'EF']);
  assert.equal(formats[0].formats.length, 4, 'both bold and italic details survive grouping');
});

test('OCR text indexing starts shared font detection and retains unavailable metadata as unknown', async () => {
  const api = engine();
  let operators = 0;
  const objects = new Map();
  const pdf = { numPages: 1, getPage: async () => ({
    commonObjs: objects,
    getOperatorList: async () => { operators++; objects.set('f1', { name: 'Times-BoldItalic', italic: true, bold: true }); },
    getTextContent: async () => ({ items: ['f1', 'missing'].map((fontName, i) => ({
      str: i ? 'unknown' : 'styled', fontName, transform: [1, 0, 0, 1, 0, 100 - i * 20], height: 12, width: 40
    })) })
  }) };
  const locator = api.createLocator({}, { isCurrent: () => true, waitForIdle: async () => {} });
  const text = await locator.indexDocument(pdf);
  assert.equal(operators, 1, 'the OCR page read starts font detection without a separate review pass');
  const full = await locator.indexFonts(pdf);
  assert.equal(full, text, 'font data enriches the existing text index');
  const runs = api.fontRuns(full);
  assert.equal(runs[0].italic, true);
  assert.equal(runs[0].bold, true);
  assert.equal(runs[1].italic, null);
  assert.equal(await locator.indexFonts(pdf), full);
  assert.equal(operators, 1);
});

test('page-uniform styles become unknown independently of other pages', async () => {
  for (const styles of [
    [[true, false], [true, true]],
    [[false, true], [true, true]],
    [[true, true], [true, true]],
    [[true, false], [true, false]],
    [[false, true], [false, true]],
    [[false, false], [true, true]],
    [[true, true], [null, null]]
  ]) {
    const api = engine();
    const pages = styles.map(([bold, italic], i) => ({
      commonObjs: new Map([['f', { name: `Face${i}`, bold, italic }]]),
      getOperatorList: async () => ({ fnArray: [37, 38, 44], argsArray: [['f', 12], [3], []] }),
      getTextContent: async () => ({ items: [{ str: `Page${i}`, fontName: 'f', transform: [1, 0, 0, 1, 0, 100], height: 12, width: 40 }] })
    }));
    const pdf = { numPages: pages.length, getPage: async number => pages[number - 1] };
    const locator = api.createLocator({}, { isCurrent: () => true, waitForIdle: async () => {} });
    const full = await locator.indexFonts(pdf);
    for (let i = 0; i < styles.length; i++) {
      const font = full.pages[i].parts[0].font;
      for (const [column, key] of ['bold', 'italic'].entries()) {
        const uniform = styles[i][column] === true;
        assert.equal(font[key], uniform ? null : styles[i][column]);
        if (uniform) assert.match(font.reason, /均为/);
      }
    }
    assert.equal(await locator.indexFonts(pdf), full);
    if (styles.every(style => style[0] === styles[0][0] && style[1] === styles[0][1])) {
      // Unknown attributes must produce neither missing nor surplus style marks.
      for (const htmlStyle of [false, true]) {
        const index = { raw: full.raw, formats: Array.from(full.raw, () => ({ bold: htmlStyle, italic: htmlStyle })) };
        const connection = { start: 0, end: full.raw.length, targetStart: 0, targetEnd: full.raw.length };
        const items = api.formatDifferences(index, [[connection, full, api.connectionDiff(index, full, connection)]]);
        const knownMismatch = styles[0].some(value => value === false && htmlStyle);
        assert.equal(items.length > 0, knownMismatch);
      }
    }
  }
});

test('uniform page styles are unknown even while later pages are pending', async () => {
  const api = engine();
  let finish, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { finish = resolve; });
  const pages = [1, 2].map(number => ({
    commonObjs: new Map([['f', { name: 'Times-BoldItalic', bold: true, italic: true }]]),
    getTextContent: async () => ({ items: [{ str: `Page${number}`, fontName: 'f', transform: [1, 0, 0, 1, 0, 100], height: 12, width: 40 }] }),
    async getOperatorList() { if (number === 2) { entered(); await gate; } return { fnArray: [], argsArray: [] }; }
  }));
  const pdf = { numPages: 2, getPage: async number => pages[number - 1] };
  const locator = api.createLocator({}, { isCurrent: () => true, waitForIdle: async () => {} });
  const full = await locator.indexDocument(pdf);
  const pending = locator.indexFonts(pdf);
  await waiting;
  assert.ok(api.fontRuns(full).every(run => run.bold === null && run.italic === null));
  finish();
  await pending;
  assert.ok(api.fontRuns(full).every(run => run.bold === null && run.italic === null));
});

test('native selections suppress page-uniform styles without checking other pages', async () => {
  const browser = await chromium.launch({ executablePath: process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: true });
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
      const read = PdfReviewProvider.layerFonts;
      PdfReviewProvider.layerFonts = (view, layer, refresh) => read(view, layer, () => {
        window.layerFonts = [read(view, layer, () => {})(layer.querySelector('span'))]; refresh();
      });
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

test('format differences include missing, surplus and partially marked bold italic', () => {
  const api = engine();
  const locator = api.createLocator({}, { document: { createElement: () => ({}) } });
  for (let level = 1; level <= 6; level++) {
    const heading = locator.sourceIndex(`<h${level}>2<br>Engels an Marx<br>in London</h${level}>`);
    const target = { raw: heading.raw, parts: [{ start: 0, end: heading.raw.length, font: { bold: false, italic: false } }] };
    const connection = locator.rememberConnection(heading, 0, heading.raw.length, target, { start: 0, end: target.raw.length });
    assert.equal(api.formatDifferences(heading, [[connection, target, api.connectionDiff(heading, target, connection)]]).length, 0, 'a heading alone does not declare bold');
    for (const markup of ['<b>Title</b>', '<strong>Title</strong>', '<span style="font-weight:700">Title</span>']) {
      const explicit = locator.sourceIndex(`<h${level}>${markup}</h${level}>`);
      assert.equal(explicit.formats[0].bold, true, 'explicit bold inside a heading is retained');
    }
  }
  const html = '<p><i>A</i> <b>B</b> <b><i>C</i></b> <strong>D</strong> <em>E</em> <b style="font-weight:normal">F</b> <i style="font-style:normal">G</i> 𠀀</p>';
  const index = { source: html, ...locator.sourceIndex(html) };
  const styles = [
    ['A', true, true], ['B', true, true], ['C', false, false], ['D', false, true],
    ['E', true, false], ['F', false, false], ['G', false, false], ['𠀀', true, null]
  ];
  const target = { raw: index.raw, parts: styles.map(([text, italic, bold]) => ({
    start: index.raw.indexOf(text), end: index.raw.indexOf(text) + text.length, font: { italic, bold, name: 'fixture' }
  })) };
  const connection = locator.rememberConnection(index, 0, index.raw.length, target, { start: 0, end: target.raw.length });
  const items = api.formatDifferences(index, [[connection, target, api.connectionDiff(index, target, connection)], [connection, target, api.connectionDiff(index, target, connection)]]);
  assert.deepEqual(Array.from(items, item => item.text), ['A B C', '𠀀']);
  assert.equal(items[0].htmlFont.bold, false, 'italic alone misses the bold half');
  assert.equal(items[0].formats[1].htmlFont.italic, false, 'bold alone misses the italic half');
  assert.equal(items[0].formats[2].font.bold, false, 'surplus HTML formatting is also flagged');
  const revised = api.previewEdits(html, items.flatMap(item => item.options[0].edits));
  const corrected = locator.sourceIndex(revised);
  assert.equal(corrected.raw, index.raw, 'format replacement preserves all visible text and UTF-16 characters');
  const confirmed = locator.rememberConnection(corrected, 0, corrected.raw.length, target, { start: 0, end: target.raw.length });
  assert.equal(api.formatDifferences(corrected, [[confirmed, target, api.connectionDiff(corrected, target, confirmed)]]).length, 0, 'missing, surplus and mixed bold/italic are corrected together');
  assert.ok(revised.includes('<strong>D</strong> <em>E</em>'), 'already correct formatting stays unchanged');
  const model = { getPositionAt: at => ({ lineNumber: 1, column: at + 1 }) };
  const marks = reviewProvider(api).sourceDecorations(index, [[connection, target]], model);
  assert.ok(marks.length >= 4);
  assert.ok(marks.every(mark => !html.slice(mark.range.startColumn - 1, mark.range.endColumn - 1).includes('<')), 'decorations exclude markup');
});

test('font edits move nearby bold and italic boundaries instead of duplicating wrappers', () => {
  const api = engine();
  const locator = api.createLocator({}, { document: { createElement: () => ({}) } });
  for (const [html, font, expected] of [
    ['<p><b>A</b> B</p>', { bold: true }, '<p><b>A B</b></p>'],
    ['<p>B <strong>C</strong></p>', { bold: true }, '<p><strong>B C</strong></p>'],
    ['<p><em>A</em> B <em>C</em></p>', { italic: true }, '<p><em>A B C</em></p>'],
    ['<p><i>A</i>\tB\t<i>C</i></p>', { italic: true }, '<p><i>A\tB\tC</i></p>'],
    ['<p><b>A</b> B <strong>C</strong></p>', { bold: true }, '<p><b>A B</b> <strong>C</strong></p>'],
    ['<p><b>A</b>\nB</p>', { bold: true }, '<p><b>A</b>\n<b>B</b></p>'],
    ['<p><b>A</b> X B</p>', { bold: true }, '<p><b>A</b> X <b>B</b></p>'],
    ['<p><b style="font-weight:normal">A</b> B</p>', { bold: true }, '<p><b style="font-weight:normal">A</b> <b>B</b></p>'],
    ['<p><b>A</b> B <i>C</i></p>', { bold: true, italic: true }, '<p><b>A</b> <b><i>B</i></b> <i>C</i></p>']
  ]) {
    const index = locator.sourceIndex(html), start = index.raw.indexOf('B');
    const revised = api.previewEdits(html, api.fontEdits(index, start, start + 1, font));
    assert.equal(revised, expected);
    const corrected = locator.sourceIndex(revised);
    assert.equal(corrected.raw, index.raw);
    for (const key of ['bold', 'italic']) {
      for (let at = 0; at < index.raw.length; at++) {
        if (/\s/.test(index.raw[at])) continue;
        assert.equal(corrected.formats[at][key], at === start && typeof font[key] === 'boolean' ? font[key] : index.formats[at][key]);
      }
    }
  }
});

test('font edits reuse source coordinates and preserve entities, attributes and inline structure', () => {
  const api = engine();
  const document = { createElement: () => ({ set innerHTML(text) { this.content = { textContent: text === '&amp;' ? '&' : text }; } }) };
  const locator = api.createLocator({}, { document });
  const html = '<p id="keep"><i>A&amp;<a href="/keep">𠀀B</a>C</i></p>';
  const index = locator.sourceIndex(html);
  document.createElement = () => { throw new Error('must reuse the existing source index'); };
  const edits = api.fontEdits(index, 1, 5, { italic: false, bold: true });
  const revised = api.previewEdits(html, edits);
  assert.equal(revised, '<p id="keep"><i>A</i><span style="font-weight:bold">&amp;</span><a href="/keep"><span style="font-weight:bold">𠀀B</span></a><i>C</i></p>');
  assert.equal(api.fontEdits(index, 0, 1, { italic: null, bold: null }).length, 0, 'unknown PDF styles never produce automatic edits');
  assert.throws(() => api.previewEdits(html.replace('𠀀B', 'changed'), edits), /原文已变化/);
});

test('normal PDF formatting removes surplus tags and preserves formatting outside a partial correction', () => {
  const api = engine();
  const locator = api.createLocator({}, { document: { createElement: () => ({}) } });
  for (const [html, expected] of [
    ['<p><i>Vorträge über die Grundlagen</i></p>', '<p>Vorträge über die Grundlagen</p>'],
    ['<p><b><em>Vorträge über die Grundlagen</em></b></p>', '<p>Vorträge über die Grundlagen</p>'],
    ['<p><span style="font-style:italic;color:red">Vorträge über die Grundlagen</span></p>', '<p><span style="color:red">Vorträge über die Grundlagen</span></p>'],
    ['<p><i id="keep">Vorträge über die Grundlagen</i></p>', '<p><span id="keep">Vorträge über die Grundlagen</span></p>']
  ]) {
    const index = locator.sourceIndex(html), end = index.raw.trimEnd().length;
    assert.equal(api.previewEdits(html, api.fontEdits(index, 0, end, { italic: false, bold: false })), expected);
  }
  const html = '<p><i>A<a href="/keep">BC</a>D</i></p>', index = locator.sourceIndex(html);
  const edits = api.fontEdits(index, [
    { sourceStart: 1, sourceEnd: 2, font: { italic: false, bold: null } },
    { sourceStart: 3, sourceEnd: 4, font: { italic: false, bold: null } }
  ]);
  const revised = api.previewEdits(html, edits);
  assert.equal(revised, '<p><i>A</i><a href="/keep">B<i>C</i></a>D</p>');
  const corrected = locator.sourceIndex(revised);
  assert.equal(corrected.raw, index.raw);
  assert.deepEqual(Array.from(corrected.formats.slice(0, 4), font => font.italic), [true, false, true, false]);
});

test('retained OCR font declarations participate in style comparison even when invisible or not embedded', async () => {
  const api = engine();
  const objects = new Map([
    ['hidden', { name: 'TimesNewRomanPS-BoldMT', italic: false, bold: true, missingFile: true }],
    ['hiddenItalic', { name: 'TimesNewRomanPS-BoldItalicMT', italic: true, bold: true, missingFile: false }],
    ['visible', { name: 'Helvetica-Bold', italic: false, bold: true, missingFile: true }],
    ['regular', { name: 'Helvetica', italic: false, bold: false }]
  ]);
  const items = [...objects.keys()].map(fontName => ({ fontName, str: fontName }));
  let calls = 0;
  const page = { commonObjs: objects, getOperatorList: async () => {
    calls++;
    return { fnArray: [10, 38, 37, 44, 37, 44, 11, 37, 44],
      argsArray: [[], [3], ['hidden', 8.5], [], ['hiddenItalic', 8.5], [], [], ['visible', 12], []] };
  } };
  const fonts = await api.readPageFonts(page, items);
  assert.equal(fonts.get('hidden').bold, true);
  assert.equal(fonts.get('hidden').declaredBold, true);
  assert.match(fonts.get('hidden').reason, /OCR 字体/);
  assert.equal(fonts.get('hiddenItalic').italic, true);
  assert.equal(fonts.get('hiddenItalic').declaredItalic, true);
  assert.equal(fonts.get('hiddenItalic').bold, true);
  assert.equal(fonts.get('visible').bold, true);
  assert.equal(await api.readPageFonts(page, items), fonts);
  assert.equal(calls, 1);
});

test('mixed visibility retains font declarations but failed inspection remains unknown', async () => {
  const api = engine(), commonObjs = new Map([['f', { name: 'Helvetica-Bold', bold: true, italic: false }]]);
  for (const [i, getOperatorList] of [
    async () => ({ fnArray: [37, 44, 38, 44], argsArray: [['f', 12], [], [7], []] }),
    async () => { throw new Error('unavailable operators'); }
  ].entries()) {
    const fonts = await api.readPageFonts({ commonObjs, getOperatorList }, [{ fontName: 'f', str: 'Word' }]);
    assert.equal(fonts.get('f').bold, null, 'uniform bold is unknown regardless of visibility');
    assert.equal(fonts.get('f').italic, i === 0 ? false : null);
    assert.ok(fonts.get('f').reason);
  }
});

test('review font loading uses metadata without reading scan pixels', async () => {
  for (const uniform of [false, true]) {
    const api = engine(), width = 600, height = 600, data = new Uint8Array(width * height / 8).fill(255);
    const items = Array.from({ length: 12 }, (_, i) => ({ str: 'abcdefghijklmnopqrst', fontName: i === 11 ? 'regular' : 'bold',
      transform: [24, 0, 0, 24, 50, 550 - i * 40], height: 24, width: 400 }));
    for (const [i, item] of items.entries()) {
      const thickness = uniform || i === 2 ? 5 : 2, top = height - item.transform[5] - 18;
      for (let glyph = 0; glyph < 20; glyph++) for (let y = top; y < top + 18; y++)
        for (let x = 55 + glyph * 18; x < 55 + glyph * 18 + thickness; x++)
          data[y * (width / 8) + (x >> 3)] &= ~(128 >> (x & 7));
    }
    const page = { commonObjs: new Map([['bold', { name: 'Same-Bold', bold: true, italic: false }],
      ['regular', { name: 'Same-Regular', bold: false, italic: false }]]),
      objs: { get: (id, resolve) => resolve({ data, width, height, kind: 1 }) },
      getOperatorList: async () => ({ fnArray: [10, 12, 85, 11, 37, 38, 44],
        argsArray: [[], [600, 0, 0, 600, 0, 0], ['scan'], [], ['bold', 24], [3], []] }),
      getTextContent: async () => ({ items }) };
    let scanReads = 0;
    page.objs.get = () => { scanReads++; throw new Error('Review must not read scan pixels'); };
    const pdf = { numPages: 1, getPage: async () => page };
    const baseFonts = await api.readPageFonts(page, items);
    assert.equal(api.textItemFont(baseFonts, items[2]).bold, null, 'PDF loading alone never detects scan bold');
    const provider = reviewProvider(api), readPageFonts = provider.readPageFonts;
    const locator = api.createLocator({}, { isCurrent: () => true, waitForIdle: async () => {}, readPageFonts });
    const index = await locator.indexFonts(pdf), fonts = await readPageFonts(page, items);
    assert.equal(await readPageFonts(page, structuredClone(items)), fonts, 'provider shares cached PDF metadata');
    assert.equal(api.textItemFont(baseFonts, items[2]).bold, null, 'review retains unknown bold metadata');
    assert.equal(fonts.get('bold').bold, null, 'character-weighted dominant declaration is not trusted');
    assert.equal(index.pages[0].parts[0].font.bold, null, 'baseline text is not guessed regular');
    assert.equal(index.pages[0].parts[11].font.bold, false, 'minority regular metadata survives');
    const spans = items.map(item => ({ textContent: item.str, ownerDocument: { defaultView: {
      getComputedStyle: () => ({ fontFamily: 'Same', fontStyle: 'normal', fontWeight: '400' })
    } } }));
    const view = { pdfPage: page, _textHighlighter: { textDivs: spans } };
    await new Promise(resolve => provider.layerFonts(view, {}, resolve));
    const fontAt = provider.layerFonts(view, {}, () => {});
    assert.equal(fontAt(spans[2]).bold, null, 'selection uses PDF metadata without scan estimates');
    assert.equal(api.textItemFont(fonts, structuredClone(items[2])).bold, null);
    assert.equal(index.pages[0].parts[2].font.bold, null);
    assert.equal(scanReads, 0, 'review indexing and selection never access scan image data');
  }
});

test('Tesseract placeholder fonts remain unknown and cannot produce surplus HTML style differences', async () => {
  const api = engine();
  for (const name of ['GlyphLessFont', 'ABCDEF+GlyphLessFont']) {
    const style = api.fontStyle({ name, bold: false, italic: false }, '', { fontWeight: '700', fontStyle: 'italic' });
    assert.equal(style.bold, null);
    assert.equal(style.italic, null);
    assert.match(style.reason, /占位字体/);
    const locator = api.createLocator({}, { document: { createElement: () => ({}) } });
    const html = '<p><b><i>Word</i></b></p>';
    const index = { source: html, ...locator.sourceIndex(html) };
    const target = { raw: index.raw, parts: [{ start: 0, end: index.raw.length, font: style }] };
    const connection = locator.rememberConnection(index, 0, index.raw.length, target, { start: 0, end: target.raw.length });
    assert.equal(api.formatDifferences(index, [[connection, target, api.connectionDiff(index, target, connection)]]).length, 0);
  }
});

test('PDF.js detects four actual PDF faces in file review and native selections', async () => {
  const browser = await chromium.launch({ executablePath: process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: true });
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
    const providerSource = fullReviewSource.split('// PDF comparison is one review provider. Selection synchronization remains independent.')[1]
  .replace(/\r?\n  return window\.PdfReviewProvider;\r?\n\}\)\(\);\s*$/, '');
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
      const locator = PdfReviewProvider.createLocator({}, { isCurrent: () => true, waitForIdle: async () => {} });
      const full = await locator.indexFonts(pdf);
      const runs = PdfSelectionDiff.fontRuns(full);
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
      return { runs: runs.map(run => [run.italic, run.bold]), texts: items.map(item => item.text), message: content.message, selected: PdfSelectionDiff.fontRuns(selected.target.index, selected.target.start, selected.target.end),
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
  const browser = await chromium.launch({ executablePath: process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: true });
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
      const locator = PdfReviewProvider.createLocator({}, { getVisiblePages: () => [{ index: visibleTarget }] }), index = locator.editorSourceIndex(model);
      window.PdfSelection = { locator, showReviewPointer() {}, clearReviewPointer() {} };
      const renderTarget = target => {
        target.normalized = locator.normalized(target.raw);
        const layer = target.layer = document.querySelector('.textLayer');
        layer.replaceChildren();
        for (const part of target.parts) {
          const span = document.createElement('span'); span.textContent = target.raw.slice(part.start, part.end);
          layer.append(span); part.node = span.firstChild;
        }
        visibleTarget = target;
      };
      const target = { raw: index.raw, parts: [{ start: 0, end: index.raw.length, font: { bold: false, italic: false } }] };
      locator.rememberConnection(index, 0, index.raw.length, target, { start: 0, end: index.raw.length });
      window.addEventListener('pdf-selection-difference', event => { window.lastReviewNotice = event.detail; });
      window.sendNotice = (bold, italic, unmapped = false, textMismatch = false) => {
        target.raw = textMismatch ? index.raw.replace('Word', 'WxrX') : index.raw;
        renderTarget(target);
        index.connections.delete(target);
        locator.rememberConnection(index, 0, index.raw.length, target, { start: 0, end: target.raw.length });
        target.parts[0].font = { bold, italic };
        window.dispatchEvent(new CustomEvent('pdf-selection-difference', { detail: {
          editor, model, pdf, interactionId: Math.random(), targets: [target], anchor: { left: 0, top: 500, bottom: 520 },
          notices: unmapped ? [{ html: 'X', pdf: 'Y' }] : [{ ...(textMismatch ? { html: index.raw, pdf: target.raw } : {}), fonts: [target.parts[0].font], text: 'Word', source: { index, start: 0, end: index.raw.length } }]
        } }));
      };
      window.selectFormatPassage = (normal = false, mismatch = false) => {
        sourceValue = normal ? '<p><i>Vorträge <a href="/keep">über</a> die Grundlagen</i></p>' : '<p>„Nur die Arbeit</p>'; sourceVersion++;
        const index = locator.editorSourceIndex(model);
        const target = { raw: mismatch ? index.raw.replace('Vorträge', 'Vortrage') : index.raw, parts: normal
          ? [{ start: 0, end: index.raw.length, font: { bold: false, italic: false } }] : [
          { start: 0, end: 4, font: { bold: false, italic: true } },
          { start: 4, end: index.raw.length, font: { bold: false, italic: false } }
        ] };
        locator.rememberConnection(index, 0, index.raw.length, target, { start: 0, end: target.raw.length });
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

test('locator returns page targets and rendered/source ranges without the highlight script', async () => {
  const api = engine();
  const texts = ['First page heading. Repeated words end here.', 'Second page heading. Repeated words end here.'];
  let reads = 0, indexed = 0;
  const pdf = { numPages: 2, async getPage(number) {
    reads++;
    return { async getTextContent() { return { items: [{ str: texts[number - 1],
      transform: [1, 0, 0, 1, 0, 500], width: 800, height: 24 }] }; } };
  } };
  const locator = api.createLocator({}, {
    document: { createElement: () => ({}) }, isCurrent: current => current === pdf,
    waitForIdle: async () => {}, onIndexed: () => indexed++
  });
  const source = locator.sourceIndex('<p>' + texts.join('</p><p>') + '</p>');
  const start = source.raw.lastIndexOf('Repeated'), end = start + 'Repeated words'.length;
  const entry = { index: source, start, end, text: source.raw.slice(start, end),
    before: 'Second page heading. ', after: ' end here.' };
  const [location] = await locator.findLocations(pdf, [entry]);
  assert.equal(location.targets.length, 1);
  assert.equal(location.targets[0].pageNumber, 2);
  const page = locator.sourceIndex(texts[1]);
  const { hits, focusHit } = locator.locateLayer(page, [], location.targets);
  assert.equal(hits.length, 1);
  assert.equal(page.raw.slice(focusHit.start, focusHit.end), entry.text);
  const { hit, difference } = locator.locateSource(source, [{ index: page, start: focusHit.start, end: focusHit.end }]);
  assert.equal(hit.start, start, 'reverse search respects the second page scope');
  assert.equal(hit.end, end);
  assert.equal(difference, null);
  assert.ok(Array.isArray(locator.findLocations(pdf, [entry])), 'prepared locations are synchronous');
  assert.equal(reads, 2, 'the PDF index is reused');
  assert.equal(indexed, 1);
});

test('ME32-007 reverse selections reuse OCR alignment around Gewißheit', async () => {
  const fixture = JSON.parse(await readFile(new URL('../tests/fixtures/pdf-selection-me32.json', import.meta.url), 'utf8'));
  const api = engine();
  const pdf = { numPages: 1, async getPage() {
    return { getTextContent: async () => ({ items: fixture.pages[0].items }) };
  } };
  const locator = api.createLocator({}, { document: { createElement: () => ({}) },
    isCurrent: () => true, waitForIdle: async () => {} });
  const source = locator.sourceIndex(fixture.html), full = await locator.indexDocument(pdf);
  const page = locator.sourceIndex(full.raw.trim());
  locator.prepareSource(source, [page], pdf);
  for (const [word, expected] of [['hatte', 'hatte'], ['ihn', 'ihn'], ['GewiBheit', 'Gewißheit'], ['abzunehmen', 'abzunehmen']]) {
    const start = page.raw.indexOf(word, page.raw.indexOf('GewiBheit'));
    assert.ok(start >= 0);
    const { hit, difference } = locator.locateSource(source, [{ index: page, start, end: start + word.length }]);
    assert.ok(hit, `reverse selection of ${word} must survive neighbouring OCR errors`);
    assert.equal(source.raw.slice(hit.start, hit.end), expected);
    assert.equal(!!difference, word === 'GewiBheit');
    const forward = locator.connectedRange(source, page, hit.start, hit.end);
    assert.equal(forward.start, start);
    assert.equal(forward.end, start + word.length);
  }
});

test('background document mapping retains page font highlights alongside text differences', async () => {
  const api = engine();
  const text = 'Und endlich kommt er doch. Wie Kinder unter dem großen Himmelssaal.';
  const later = 'Another independent passage follows on the next page with enough context.';
  const pdf = { numPages: 2, getPage: async number => ({ getTextContent: async () => ({ items: [{
    str: number === 1 ? text : later, transform: [1, 0, 0, 1, 0, 100], height: 12, width: 400
  }] }) }) };
  const locator = api.createLocator({}, { document: { createElement: () => ({}) },
    isCurrent: () => true, waitForIdle: async () => {} });
  const index = locator.sourceIndex('<p>' + text.replace('Kinder', '<i>Kinder</i>').replace('endlich', '<b>endlich</b>').replace('unter', 'untex')
    + '</p><p>' + later + '</p>');
  const page = locator.sourceIndex(text);
  page.parts = [{ start: 0, end: page.raw.length, font: { italic: false, bold: false } }];
  locator.rememberConnection(index, 0, text.length, page, { start: 0, end: page.raw.length });
  const model = { getPositionAt: at => ({ lineNumber: 1, column: at + 1 }) };
  const marks = targets => reviewProvider(api).sourceDecorations(index, targets.flatMap(target =>
    (index.connections.get(target) || []).map(connection => [connection, target])), model);
  assert.equal(marks([page]).filter(mark => mark.options.description === 'PDF font difference').length, 2);
  const full = await locator.indexDocument(pdf);
  for (let refresh = 0; refresh < 2; refresh++) {
    locator.prepareSource(index, [page, full], pdf);
    const refreshed = marks([page, full]);
    assert.ok(refreshed.some(mark => mark.options.description === 'PDF OCR text difference'));
    assert.equal(refreshed.filter(mark => mark.options.description === 'PDF font difference').length, 2,
      'the text-only document mapping must not discard the page font mapping');
  }
});

test('locator cancels obsolete extraction and keeps document caches per reader', async () => {
  const api = engine();
  let current = true, reads = 0;
  const pdf = { numPages: 1, async getPage() {
    reads++;
    return { async getTextContent() { return { items: [] }; } };
  } };
  const locator = api.createLocator({}, {
    isCurrent: () => current, waitForIdle: async () => { current = false; }
  });
  assert.equal(await locator.indexDocument(pdf), null);
  assert.equal(reads, 0, 'a replaced PDF is not extracted after the idle wait');
  assert.equal(locator.getDocumentIndex(pdf), undefined);
  current = true;
  const other = api.createLocator({}, { isCurrent: () => current, waitForIdle: async () => {} });
  assert.ok(await other.indexDocument(pdf));
  assert.equal(reads, 1);
  assert.equal(locator.getDocumentIndex(pdf), undefined, 'another reader cannot populate this cache');
});

test('source/PDF pairs reuse one snapshot and rebuild all mappings after edits', () => {
  const api = engine();
  const firstPdf = {}, secondPdf = {};
  let pdf = firstPdf, source = '<p>First independent passage with enough unchanged words for mapping.</p>', version = 1;
  const locator = api.createLocator({}, { document: { createElement: () => ({}) }, getPdf: () => pdf });
  const model = { getValue: () => source, getVersionId: () => version };
  const target = locator.sourceIndex('First independent passage with enough unchanged words for mapping.');
  const before = locator.editorSourceIndex(model);
  locator.prepareSource(before, [target], pdf);
  assert.ok(before.connections.get(target).length);
  assert.equal(locator.editorSourceIndex(model), before);
  pdf = secondPdf;
  assert.notEqual(locator.editorSourceIndex(model), before, 'PDF switches have independent owners');
  pdf = firstPdf;
  assert.equal(locator.editorSourceIndex(model), before);
  source = source.replace('<p>', '<p><b>').replace('</p>', '</b></p>'); version++;
  const after = locator.editorSourceIndex(model);
  assert.notEqual(after, before);
  assert.equal(after.connections.get(target), undefined, 'markup edits invalidate mappings too');
  locator.prepareSource(after, [target], pdf);
  assert.ok(after.connections.get(target).length);
  assert.equal(after.formats[0].bold, true);
  assert.equal(locator.editorSourceIndex(model), after, 'all consumers share the rebuilt snapshot');
});

test('MEW_BRIEF/23/ME23-316 prepares reusable mappings across five actual OCR pages', async () => {
  const fixture = JSON.parse(await readFile(new URL('../tests/fixtures/pdf-selection-me23.json', import.meta.url), 'utf8'));
  const api = engine();
  const pdf = { numPages: fixture.pages.length, async getPage(n) {
    return { getTextContent: async () => ({ items: fixture.pages[n - 1].items }) };
  } };
  const locator = api.createLocator({}, { document: { createElement: () => ({}) },
    isCurrent: () => true, waitForIdle: async () => {} });
  const source = locator.sourceIndex(fixture.html), full = await locator.indexDocument(pdf);
  for (const page of full.pages) for (const part of page.parts)
    assert.equal(full.raw.slice(part.start, part.end), part.item.str, 'page-local construction keeps global item offsets');
  locator.prepareSource(source, [], pdf);
  const connections = source.connections.get(full);
  assert.ok(connections.length >= 8, 'footnote ordering must not discard independently validated passages');
  locator.prepareSource(source, [full], pdf);
  assert.deepEqual(source.connections.get(full), connections, 'review initialization must reuse inverse mappings without scanning the whole volume again');
  const touchedPages = new Set();
  let changed = 0, probes = 0;
  for (const item of connections) {
    let cursor = 0;
    for (const span of item.spans) {
      if (span.html.length && span.pdf.length) {
        const a = span.changed ? cursor : cursor + Math.floor(span.html.length / 2);
        const b = span.changed ? cursor + span.html.length : a + 1;
        const start = item.start + item.left.starts[a], end = item.start + item.left.ends[b - 1];
        const hit = locator.connectedRange(source, full, start, end, false, item);
        assert.ok(hit);
        assert.equal(locator.normalized(full.raw.slice(hit.start, hit.end)).text,
          span.changed ? span.pdf : locator.normalized(source.raw.slice(start, end)).text);
        const reverse = locator.connectedRange(source, full, hit.start, hit.end, true, item);
        assert.equal(reverse.start, start); assert.equal(reverse.end, end);
        for (const page of full.pages) if (hit.start < page.end && hit.end > page.start) touchedPages.add(fixture.pages[page.number - 1].number);
        changed += Number(span.changed); probes++;
      }
      cursor += span.html.length;
    }
  }
  assert.equal(touchedPages.size, 5); assert.ok(changed > 0); assert.ok(probes > 20);
});

test('long multi-page passages retain OCR mappings beyond the whole-range edit limit', () => {
  const api = engine(), locator = api.createLocator();
  let seed = 29;
  const raw = Array.from({ length: 20000 }, () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return String.fromCharCode(97 + seed % 26);
  }).join('');
  const positions = Array.from({ length: 300 }, (_, i) => i * 64 + 48);
  const changed = [...raw]; for (const at of positions) changed[at] = '7';
  const index = raw => ({ raw, normalized: locator.normalized(raw), pageScopes: new WeakMap(), connections: new WeakMap() });
  const source = index(raw), target = index(changed.join(''));
  locator.sourcePageScope(source, target, true);
  assert.ok(source.connections.get(target).length > 1, 'bounded groups survive more than 128 total OCR edits');
  for (const at of positions) {
    const hit = locator.connectedRange(source, target, at, at + 1);
    assert.ok(hit, `missing mapping at ${at}`);
    assert.equal(target.raw.slice(hit.start, hit.end), '7');
    const reverse = locator.connectedRange(source, target, hit.start, hit.end, true);
    assert.equal(reverse.start, at); assert.equal(reverse.end, at + 1);
  }
});

test('local highlight hunks separate OCR boundary spaces', () => {
  const api = engine();
  const locator = api.createLocator({}, { document: { createElement: () => ({}) } });
  const source = 'aft der\n' + 'x'.repeat(100), target = { raw: 'äft  der\n' + 'y'.repeat(100) };
  const index = locator.sourceIndex(source);
  const connection = { start: 0, end: source.length, targetStart: 0, targetEnd: target.raw.length };
  index.connections.set(target, [connection]);
  const parts = api.connectionDiff(index, target, connection).parts;
  assert.deepEqual(Array.from(parts.slice(0, 4), part => [part.html, part.pdf, part.changed]),
    [['a', 'ä', true], ['ft ', 'ft ', false], ['', ' ', true], ['der\n', 'der\n', false]]);
  const items = api.reviewCandidates(index, [target]);
  assert.deepEqual({ ...items[0].comparison }, { html: 'a', pdf: 'ä' });
  assert.equal(api.previewEdits(source, items[0].options[0].edits), source.replace('aft', 'äft'));
  const hit = locator.connectedRange(index, target, 0, 3, false, connection, true);
  assert.equal(target.raw.slice(hit.start, hit.end), 'äft', 'click excludes the following space insertion');
});

test('an over-budget page comparison does not highlight or replace the whole passage', () => {
  const api = engine();
  const locator = api.createLocator({}, { document: { createElement: () => ({}) } });
  const lines = Array.from({ length: 150 }, (_, i) => `Passage ${i} contains matching words.`);
  const index = locator.sourceIndex(lines.join(' '));
  const target = { raw: lines.join('\n').replace('Passage 5', 'Passage X') };
  const broad = locator.rememberConnection(index, 0, index.raw.length, target, { start: 0, end: target.raw.length });
  assert.ok(broad, 'normalized text still confirms the page mapping');
  const end = index.raw.indexOf('Passage 10'), targetEnd = target.raw.indexOf('Passage 10');
  const local = locator.rememberConnection(index, 0, end, target, { start: 0, end: targetEnd });
  assert.ok(api.differences(index, target, local).text.length, 'confirmed local changes remain available');
  assert.equal(api.differences(index, target, broad).text.length, 0, 'failed traceback supplies no discrepancy spans');
  assert.equal(locator.connectedRange(index, target, 0, index.raw.length, false, broad, true), null,
    'failed traceback cannot map a discrepancy to the entire PDF page');
  const items = api.reviewCandidates(index, [target]);
  assert.deepEqual(Array.from(items, item => [item.comparison.html, item.comparison.pdf]), [['5', 'X']]);
});

test('ME04-608 wrapped prose stays aligned across blank-line anchors', () => {
  const api = engine();
  const locator = api.createLocator({}, { document: { createElement: () => ({}) } });
  const paragraph = "<p><i>Born</i> stattet Bericht ab über die Versammlung im Café l'Europe; ebenso <i>Sterbitzki</i>. Mit großer Mehrzahl beschlossen, nicht in dieses Café zu gehn, wo Decker und Venedey eine Versammlung halten.</p>";
  const pdf = "Born stattet Bericht ab über die Versammlung im Cafe l'Europe; ebenso\n\nSterhitzki' Mit großer Mehrzahl beschlossen, nicht in dieses Cafe zu gehn,\nwo Decker und Venedey eine Versammlung halten.\nEngler, Buchfink und Vogler (Weitlingianer) aufgenommen einstimmig.\n";
  for (const newline of ['\r\n', '\n']) {
    const html = paragraph + newline + '<p>Engler, Buchfink und Vogler (Weitlingianer) aufgenommen einstimmig.</p>';
    const index = locator.editorSourceIndex({ getValue: () => html, getVersionId: () => 1 });
    const target = { raw: pdf };
    locator.rememberConnection(index, 0, index.raw.length, target, { start: 0, end: pdf.length });
    const items = api.reviewCandidates(index, [target]);
    assert.deepEqual(Array.from(items, item => [item.comparison.html, item.comparison.pdf]),
      [['é', 'e'], ['b', 'h'], ['.', "'"], ['é', 'e']]);
    assert.equal(api.previewEdits(html, items.flatMap(item => item.options[0].edits)),
      html.replaceAll('Café', 'Cafe').replace('Sterbitzki</i>.', "Sterhitzki</i>'"));
  }
});

test('bounded local anchor checks reject impossible lengths and count Unicode code points', () => {
  const api = engine();
  const left = 'a'.repeat(80), right = 'b'.repeat(577854);
  assert.equal(api.textDiff(left, right, false, 12).distance, 13);
  const rejected = api.textDiff(right, left, true, 12);
  assert.equal(rejected.distance, 13);
  assert.deepEqual(Array.from(rejected.parts, part => [part.html, part.pdf, part.changed]), [[right, left, true]]);
  assert.equal(api.textDiff('a', 'a𠀀', false, 1).distance, 1);
  assert.equal(api.textDiff('a', 'ab', false, 1).distance, 1);
  const unbounded = api.textDiff('a', 'abc', true);
  assert.equal(unbounded.parts.map(part => part.pdf).join(''), 'abc');
});

test('local diff preserves complete Unicode readings and maps source positions in both directions', () => {
  const api = engine();
  for (const [left, right] of [
    ['First line\nwork together\n中文𠀀 last', 'First line\nworks together\n中文𠀀 last'],
    ['a𠀀b', 'a𠀁b'], ['before\nend', 'before\nextra\nend'], ['', 'added'], ['deleted', ''],
    ['Die Straße', 'Die Strasse'], ['line\r\nnext', 'line\r\nnew next']
  ]) {
    const diff = api.textDiff(left, right, true);
    assert.equal(diff.parts.map(part => part.html).join(''), left);
    assert.equal(diff.parts.map(part => part.pdf).join(''), right);
    assert.equal(diff.distance, api.textDiff(left, right).distance);
    for (const part of diff.parts) if (!part.changed) assert.equal(part.html, part.pdf);
  }
  const { normalized, rememberConnection, connectedRange } = api.createLocator();
  const index = raw => ({ raw, normalized: normalized(raw), connections: new WeakMap() });
  const left = index('Before working together after.'), right = index('Before working nicely together after.');
  rememberConnection(left, 0, left.raw.length, right, { start: 0, end: right.raw.length });
  const word = left.raw.indexOf('together'), mapped = connectedRange(left, right, word, word + 8);
  assert.equal(right.raw.slice(mapped.start, mapped.end), 'together');
  const reverse = connectedRange(left, right, mapped.start, mapped.end, true);
  assert.equal(left.raw.slice(reverse.start, reverse.end), 'together');
});

test('native decorations split changes around tags, map entities, and mark missing HTML text', () => {
  const api = engine(), provider = reviewProvider(api);
  assert.equal(api.textDiff('a', 'b', true).parts[0].changed, true);
  assert.deepEqual([...provider.sourceDecorations({}, [], {})], []);
  const markup = '<p>a<b>X</b>&amp;𠀀Z</p>', raw = 'aX&𠀀Z';
  const starts = [3, 7, 12, 17, 18, 19], ends = [4, 8, 17, 18, 19, 20];
  const index = { raw, starts, ends }, target = { raw: 'aY!𠀀Z+' };
  const connection = { start: 0, end: raw.length, targetStart: 0, targetEnd: target.raw.length };
  const model = { getPositionAt: offset => ({ lineNumber: 1, column: offset + 1 }) };
  const decorations = provider.sourceDecorations(index, [[connection, target]], model);
  const ranges = decorations.map(({ range }) => markup.slice(range.startColumn - 1, range.endColumn - 1));
  assert.deepEqual([...ranges], ['X', '&amp;', '']);
  assert.ok(decorations.every(item => item.options.linesDecorationsClassName));
  assert.equal(decorations.at(-1).options.beforeContentClassName, 'mew-ocr-diff-insert');
  assert.equal(decorations.at(-1).range.startColumn, 21, 'trailing insertion is anchored before the closing tag');
  assert.match(decorations.at(-1).options.hoverMessage.value, /OCR:.*\+/);
  const saved = connection.editorDiff;
  provider.sourceDecorations(index, [[connection, target]], model);
  assert.equal(connection.editorDiff, saved);
  assert.equal(api.textDiff('a', 'b', true).parts[0].changed, true);
  assert.deepEqual([...provider.sourceDecorations(index, [[{ ...connection, editorDiff: null }, target]], model)], [...decorations]);
  assert.deepEqual([...provider.sourceDecorations(index, [[connection, target]], model)], [...decorations]);
});

test('ME04-004 quote markers exclude matching paragraphs, PDF wrapping and the footnote', async () => {
  const fixture = JSON.parse(await readFile(new URL('../tests/fixtures/pdf-selection-me04.json', import.meta.url), 'utf8'));
  const api = engine();
  const target = { raw: fixture.layerRaw, parts: [] }, pdf = {};
  const locator = api.createLocator({}, { document: { createElement: () => ({}) },
    getVisiblePages: () => [{ number: 20, index: target }] });
  Object.assign(target, { normalized: locator.normalized(target.raw) });
  const model = { getValue: () => fixture.html, getVersionId: () => 1,
    getPositionAt: offset => ({ lineNumber: 1, column: offset + 1 }) };
  const index = locator.editorSourceIndex(model);
  locator.sourcePageScope(index, target, true);
  const connections = (index.connections.get(target) || []).map(connection => [connection, target]);
  const marks = reviewProvider(api).sourceDecorations(index, connections, model);
  const quote = fixture.html.indexOf('entwickeln.') + 'entwickeln.'.length;
  const mark = marks.find(({ range }) => range.startColumn - 1 <= quote && range.endColumn - 1 > quote);
  assert.ok(mark, 'the closing quotation mark has a difference marker');
  assert.equal(fixture.html.slice(mark.range.startColumn - 1, mark.range.endColumn - 1), '“');
  const start = index.raw.indexOf('entwickeln.') + 'entwickeln.'.length;
  const [location] = locator.findLocations(pdf, [{ index, marked: true, start, end: start + 1,
    text: '“', before: index.raw.slice(start - 160, start), after: index.raw.slice(start + 1, start + 161) }]);
  assert.equal(location.targets.length, 1);
  assert.equal(location.targets[0].difference.html, '“');
  assert.equal(location.targets[0].difference.pdf, '"');
  const { focusHit } = locator.locateLayer(target, [], location.targets);
  assert.equal(target.raw.slice(focusHit.start, focusHit.end), '"');
  for (const { range } of marks) {
    const text = fixture.html.slice(range.startColumn - 1, range.endColumn - 1);
    assert.doesNotMatch(text, /Kinder|Herzen|Gemeinschaft|entwickeln|Haschen|>1</,
      'matching words and the footnote must not receive difference markers');
  }
});

test('ME04-117 case-only differences survive selection mapping in both directions', () => {
  const html = '<p>Ein sozialer Vorteil, gleich 400, stellt für das Individuum, wenn die Gesellschaft nur aus einer Million Menschen besteht, <sup>4</sup>/<sub>10000</sub> dar.</p>';
  const api = engine();
  const locator = api.createLocator({}, { document: { createElement: () => ({}) } });
  const index = { source: html, ...locator.sourceIndex(html) };
  const start = index.raw.indexOf('Gesellschaft nur') + 'Gesellsc'.length;
  const target = locator.sourceIndex(index.raw.slice(0, start) + 'H' + index.raw.slice(start + 1));
  locator.rememberConnection(index, 0, index.raw.length, target, { start: 0, end: target.raw.length });
  for (const reverse of [false, true]) {
    const hit = locator.connectedRange(index, target, start, start + 1, reverse);
    assert.equal(hit.start, start);
    assert.equal(hit.end, start + 1);
    assert.equal(hit.approximate, true, 'case folding for locating must not erase a text difference');
  }
  const { difference } = locator.locateSource(index, [{ index: target, start, end: start + 1 }]);
  assert.equal(difference.html, 'h');
  assert.equal(difference.pdf, 'H');
});

test('ME07-073 and ME07-074 alignment excludes neighboring pages and preserves the final punctuation', async () => {
  const fixtures = JSON.parse(await readFile(new URL('../tests/fixtures/pdf-selection-me07-073-074.json', import.meta.url), 'utf8'));
  for (const fixture of fixtures) for (const lf of [false, true]) {
    const api = engine();
    const locator = api.createLocator({}, { document: { createElement: () => ({}) },
      isCurrent: () => true, waitForIdle: async () => {} });
    const pdf = { numPages: fixture.pages.length, getPage: async n => ({
      getTextContent: async () => ({ items: [{ str: fixture.pages[n - 1],
        transform: [1, 0, 0, 1, 0, 100], width: 100, height: 10 }] })
    }) };
    const html = lf ? fixture.html.replace(/\r\n/g, '\n') : fixture.html;
    const index = locator.sourceIndex(html), pages = fixture.pages.map(raw => locator.sourceIndex(raw));
    locator.prepareSource(index, pages, pdf);
    const before = api.reviewCandidates(index, pages).map(item => item.comparison);
    const full = await locator.indexDocument(pdf);
    locator.prepareSource(index, pages, pdf);
    const after = api.reviewCandidates(index, [...pages, full]).map(item => item.comparison);
    assert.deepEqual(after, before, 'background alignment must not add neighboring text or delete final punctuation');
    const page = full.pages[fixture.number - 72];
    for (const connection of index.connections.get(full) || []) {
      assert.equal(full.raw.slice(connection.targetStart, Math.max(connection.targetStart, page.start)).trim(), '',
        'previous page content stays outside the mapping');
      assert.equal(full.raw.slice(Math.min(connection.targetEnd, page.end), connection.targetEnd).trim(), '',
        'next page content stays outside the mapping');
    }
    const word = fixture.number === 73 ? 'Taten!' : 'Clichy!';
    const start = index.raw.indexOf(word);
    const hit = locator.connectedRange(index, full, start, start + word.length, false, undefined, true);
    assert.ok(hit);
    assert.equal(full.raw.slice(hit.start, hit.end), word, 'final footnote punctuation survives alignment');
    const reverse = locator.connectedRange(index, full, hit.start, hit.end, true);
    assert.equal(index.raw.slice(reverse.start, reverse.end), word, 'reverse selection uses the same boundary');
  }
});

test('ME07-066 missing page-end text maps before whole-document indexing', async () => {
  const fixture = JSON.parse(await readFile(new URL('../tests/fixtures/pdf-selection-me07-066.json', import.meta.url), 'utf8'));
  for (const html of [fixture.html, fixture.html.replace(/\r\n/g, '\n')]) {
    const api = engine();
    const locator = api.createLocator({}, { document: { createElement: () => ({}) } });
    const index = locator.sourceIndex(html), target = locator.sourceIndex(fixture.layerRaw);
    const pdf = {};
    locator.prepareSource(index, [target], pdf);
    assert.equal(locator.getDocumentIndex(pdf), undefined, 'only the visible page is available');
    const item = api.reviewCandidates(index, [target]).find(item => item.comparison.pdf.includes('Delegierten'));
    assert.ok(item, 'the missing word is highlighted without waiting for the full PDF');
    assert.equal(item.sourceStart, item.sourceEnd, 'HTML has an insertion point, not selectable text');
    assert.equal(item.comparison.html, '');
    const hit = locator.connectedRange(index, target, item.sourceStart, item.sourceEnd, false, undefined, true);
    assert.ok(hit, 'the same page mapping supplies the popup anchor');
    assert.equal(target.raw.slice(hit.start, hit.end).trim(), 'Delegierten');
    const edit = item.options[0].edits[0];
    assert.equal(edit.start, edit.end);
    assert.match(api.previewEdits(html, [edit]), /Montagne und Delegierten\s+der geheimen/);
  }
});

test('ME04-117 adjacent-page quotations cannot override a complete page mapping', async () => {
  const fixture = JSON.parse(await readFile(new URL('../tests/fixtures/pdf-selection-me04-117.json', import.meta.url), 'utf8'));
  const api = engine();
  const locator = api.createLocator({}, { document: { createElement: () => ({}) }, getTargets: () => pages });
  const index = { source: fixture.html, ...locator.sourceIndex(fixture.html) };
  const pages = fixture.pages.map(page => locator.sourceIndex(page.raw));
  locator.prepareSource(index, pages, {});
  // Font metadata can rebuild just the adjacent layer after the first preparation.
  pages[1] = locator.sourceIndex(fixture.pages[1].raw);
  locator.prepareSource(index, [pages[1]], {});
  const connections = pages.flatMap(page => (index.connections.get(page) || []).map(connection => [connection, page]));
  const model = { getPositionAt: offset => ({ lineNumber: 1, column: offset + 1 }) };
  const marks = reviewProvider(api).sourceDecorations(index, connections, model);
  const at = fixture.html.indexOf('Gesellschaft nur') + 8;
  assert.ok(!marks.some(({ range }) => range.startColumn - 1 <= at && range.endColumn - 1 > at),
    'the uppercase H in the next page quotation is not a difference in this page');
  assert.ok(marks.some(({ options }) => /ooo/.test(options.hoverMessage?.value)), 'actual OCR differences remain reviewable');
});

test('ME04-037 keeps the matching heading out of deletion/reinsertion markers', async () => {
  const fixture = JSON.parse(await readFile(new URL('../tests/fixtures/pdf-selection-me04-037.json', import.meta.url), 'utf8'));
  const api = engine();
  const locator = api.createLocator({}, { document: { createElement: () => ({}) } });
  for (const html of [fixture.html, fixture.html.replace(/\r\n/g, '\n')]) {
    const index = { source: html, ...locator.sourceIndex(html) }, target = locator.sourceIndex(fixture.layerRaw);
    locator.sourcePageScope(index, target, true);
    const connections = (index.connections.get(target) || []).map(connection => [connection, target]);
    assert.ok(connections.length);
    const model = { getPositionAt: offset => ({ lineNumber: 1, column: offset + 1 }) };
    const marks = reviewProvider(api).sourceDecorations(index, connections, model);
    const start = html.indexOf('[Erklärung', html.indexOf('<h1>'));
    const end = start + '[Erklärung gegen Karl Grün'.length;
    assert.ok(marks.length, 'actual OCR differences still receive markers');
    for (const { range } of marks) {
      assert.ok(range.endColumn - 1 <= start || range.startColumn - 1 >= end,
        'the matching heading must not be marked as deleted');
      assert.doesNotMatch(html.slice(range.startColumn - 1, range.endColumn - 1), /<\/?h1>/,
        'the closing heading tag must not be highlighted');
    }
    const connection = connections[0][0];
    assert.equal(connection.editorDiff.parts.map(part => part.html).join(''), index.raw.slice(connection.start, connection.end));
    assert.equal(connection.editorDiff.parts.map(part => part.pdf).join(''), target.raw.slice(connection.targetStart, connection.targetEnd));
    const at = index.raw.indexOf('Erklärung');
    const hit = locator.connectedRange(index, target, at, at + 'Erklärung'.length, false, connection, true);
    assert.equal(target.raw.slice(hit.start, hit.end), 'Erklärung', 'click mapping shares the refined alignment');
  }
});

test('ME07-261 missing letters after a PDF line break keep a source insertion marker and mapping', () => {
  const api = engine();
  const window = {};
  const decorationSource = reviewFile.slice(reviewFile.indexOf('  function sourceDecorations('), reviewFile.indexOf('  function onSources('));
  vm.runInNewContext(decorationSource + '\nwindow.decorate = sourceDecorations;', { window, toolbox: api, mapping: api });
  const locator = api.createLocator({}, { document: { createElement: () => ({}) } });
  const model = { getPositionAt: offset => ({ lineNumber: 1, column: offset + 1 }) };
  for (const gap of [' ', '\n', '\r\n ', '\t']) {
    const html = `<p>Folgerung${gap}schließt</p>`, pdf = 'Folgerung\nanschließt';
    const index = locator.sourceIndex(html), target = locator.sourceIndex(pdf);
    locator.rememberConnection(index, 0, index.raw.length, target, { start: 0, end: target.raw.length });
    const connections = index.connections.get(target).map(connection => [connection, target]);
    const [mark, ...extra] = window.decorate(index, connections, model);
    assert.equal(extra.length, 0);
    assert.ok(mark, 'whitespace-only HTML changes must still mark missing PDF letters');
    assert.equal(mark.range.startColumn, html.indexOf('schließt') + 1);
    assert.equal(mark.range.endColumn, mark.range.startColumn);
    assert.equal(mark.options.beforeContentClassName, 'mew-ocr-diff-insert');
    assert.equal(mark.options.inlineClassName, undefined);
    const at = index.raw.indexOf('schließt');
    const hit = locator.connectedRange(index, target, at, at, false, undefined, true);
    assert.ok(hit, 'clicking the insertion caret maps back to the missing letters');
    assert.equal(target.raw.slice(hit.start, hit.end).trim(), 'an');
    if (gap === ' ') assert.equal(locator.connectedRange(index, target, at, at), null,
      'ordinary caret does not select whitespace-adjacent changes');
    const [item] = api.reviewCandidates(index, [target]);
    const patched = api.previewEdits(html, item.options[0].edits);
    assert.ok(patched.includes('an'), 'replacement retains the missing PDF letters');
  }
});

test('source decorations ignore whitespace and hyphens while preserving subsequent character offsets', () => {
  const api = engine();
  const model = { getPositionAt: offset => ({ lineNumber: 1, column: offset + 1 }) };
  const decorate = (raw, pdf) => reviewProvider(api).sourceDecorations(
    { raw, starts: Array.from({ length: raw.length }, (_, i) => i),
      ends: Array.from({ length: raw.length }, (_, i) => i + 1) },
    [[{ start: 0, end: raw.length, targetStart: 0, targetEnd: pdf.length }, { raw: pdf }]], model);
  for (const [html, pdf] of [
    ['word word', 'wordword'], ['wordword', 'word word'],
    ['word  word', 'word word'], ['word\tword', 'word word'],
    ['word\nword', 'word word'], ['word\u00a0word', 'word word'],
    [' word ', 'word'], ['word-word', 'wordword'], ['wordword', 'word-word'],
    ['word\u2010word', 'word-word'], ['word\u2011word', 'wordword'],
    ['word\u00adword', 'wordword'], ['word-\nword', 'wordword']
  ]) assert.equal(decorate(html, pdf).length, 0, JSON.stringify([html, pdf]));
  const html = 'word  word X end', pdf = 'word word Y end';
  const decorations = decorate(html, pdf);
  assert.deepEqual([...decorations.map(({ range }) => html.slice(range.startColumn - 1, range.endColumn - 1))], ['X']);
  const withHyphen = decorate('word- word X end', 'word word Y end');
  assert.deepEqual([...withHyphen.map(({ range }) => range.startColumn)], [12]);
  for (const [html, pdf, column] of [
    ['wordword', 'word word+', 9], ['wordword', 'word+word', 5],
    ['schöpliche', 'schöpfliche', 6], ['work', 'works', 5],
    ['word', 'sword', 1], ['', 'added', 1], ['a𠀀b', 'a𠀀𠀁b', 4]
  ]) {
    const [mark] = decorate(html, pdf);
    assert.equal(decorate(html, pdf).length, 1, JSON.stringify([html, pdf]));
    assert.equal(mark.range.startColumn, column);
    assert.equal(mark.range.endColumn, column);
    assert.equal(mark.options.beforeContentClassName, 'mew-ocr-diff-insert');
    assert.equal(mark.options.inlineClassName, undefined);
  }
});

test('source markers locate local diff changes at word boundaries, inside words and beside repeated characters', () => {
  const api = engine();
  for (const [html, pdf, at, missing] of [
    ['work', 'works', 4, 's'], ['word', 'sword', 0, 's'],
    ['Louis-Philippees den', 'Louis-Philippes\nden', 14, 's\n'],
    ['schöpliche', 'schöpfliche', 5, 'f'], ['a𠀀b', 'a𠀀𠀁b', 3, '𠀁']
  ]) {
    const target = { raw: pdf, parts: [] }, pdfDocument = {};
    const locator = api.createLocator({}, { getVisiblePages: () => [{ number: 1, index: target }] });
    const index = { raw: html, starts: [...Array(html.length).keys()],
      ends: Array.from({ length: html.length }, (_, i) => i + 1),
      normalized: locator.normalized(html), connections: new WeakMap(), pageScopes: new WeakMap() };
    target.normalized = locator.normalized(pdf);
    locator.rememberConnection(index, 0, html.length, target, { start: 0, end: pdf.length });
    const end = html.includes('Philippees') ? at + 3 : at;
    const hit = locator.connectedRange(index, target, at, end, false, undefined, true);
    assert.equal(pdf.slice(hit.start, hit.end), missing);
    const [location] = locator.findLocations(pdfDocument, [{ index, marked: true, start: at, end, text: html.slice(at, end), before: html.slice(0, at), after: html.slice(end) }]);
    assert.equal(location.targets[0].difference.html, html.slice(at, end));
    assert.equal(location.targets[0].difference.pdf, missing);
    const { focusHit } = locator.locateLayer(target, [], location.targets);
    assert.equal(pdf.slice(focusHit.start, focusHit.end), missing);
    assert.equal(locator.connectedRange(index, target, 1, 1), null, 'ordinary carets do not select PDF characters');
  }
});

test('Monaco standalone renders native source-line and exact character decorations', async () => {
  const browser = await chromium.launch({ executablePath: process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: true });
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
      window.marks = editor.createDecorationsCollection(PdfReviewProvider.sourceDecorations(
        { raw, starts: [...Array(raw.length).keys()], ends: Array.from({ length: raw.length }, (_, i) => i + 1) },
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
    await page.addScriptTag({ content: fullReviewSource
      .split('// PDF comparison is one review provider. Selection synchronization remains independent.')[1]
      .replace(/\r?\n  return window\.PdfReviewProvider;\r?\n\}\)\(\);\s*$/, '') });
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
        PdfSelectionDiff.textEdits(source.index, source.start, source.end, notice.pdf));
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
        PdfSelectionDiff.textEdits(source.index, source.start, source.end, notice.pdf));
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
        PdfSelectionDiff.textEdits(source.index, source.start, source.end, notice.pdf));
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
        PdfSelectionDiff.textEdits(source.index, source.start, source.end, notice.pdf));
    });
    assert.equal(await page.evaluate(() => editor.getValue()), '<p>' + await page.evaluate(() => passage.replace('an X', 'an "')) + '</p>', 'quote correction replaces the complete HTML entity');
    const fixture = JSON.parse(await readFile(new URL('../tests/fixtures/pdf-selection-me04.json', import.meta.url), 'utf8'));
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
        PdfSelectionDiff.textEdits(source.index, source.start, source.end, notice.pdf));
    });
    assert.equal(await page.evaluate(() => editor.getValue()), fixture.html.replace('entwickeln.“', 'entwickeln."'),
      'only the closing quote changes; paragraphs, formatting and footnote remain intact');
    await page.evaluate(() => editor.trigger('test', 'undo'));
    assert.equal(await page.evaluate(() => editor.getValue()), fixture.html, 'quote replacement undoes in one step');
    const headingFixture = JSON.parse(await readFile(new URL('../tests/fixtures/pdf-selection-me04-037.json', import.meta.url), 'utf8'));
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

test('concurrent page extraction is shared across locators and failures can retry', async () => {
  const api = engine();
  let calls = 0;
  const page = { getTextContent: async () => { calls++; return { items: [] }; } };
  const pdf = { numPages: 1, getPage: async () => page };
  const environment = { isCurrent: () => true, waitForIdle: async () => {} };
  await Promise.all([api.createLocator({}, environment).indexDocument(pdf),
    api.createLocator({}, environment).indexDocument(pdf), api.readPageText(page)]);
  assert.equal(calls, 1);
  let attempts = 0;
  const broken = { getTextContent: async () => {
    if (++attempts === 1) throw new Error('temporary failure');
    return { items: [] };
  } };
  await assert.rejects(api.readPageText(broken), /temporary failure/);
  await api.readPageText(broken);
  assert.equal(attempts, 2);
});

test('equal text stays unchanged and batch preview preserves all untouched text', () => {
  const api = engine();
  assert.equal(api.textDiff('same 𠀀', 'same 𠀀', true).parts[0].changed, false);
  const source = 'a𠀀bcdef';
  assert.equal(api.previewEdits(source, [{ start: 7, end: 8, text: 'Z' },
    { start: 1, end: 3, text: '&amp;' }, { start: 4, end: 4, text: 'X' }]), 'a&amp;bXcdeZ');
  assert.throws(() => api.previewEdits(source, [{ start: 1, end: 4, text: '' },
    { start: 3, end: 5, text: '' }]), /重叠/);
});

test('PDF replacement batches identical patterns and retains different text or formatting targets', () => {
  for (const format of [false, true]) {
    const api = engine(), providers = new Map();
    let source = format ? '<p>Word</p><p>Word</p><p>Word</p><p>Other</p>'
      : '<p>WRONG</p><p>WRONG</p><p>WRONG</p><p>OTHER</p>', version = 1, applications = 0, undoStops = 0;
    const model = { getValue: () => source, getVersionId: () => version,
      getPositionAt: at => ({ lineNumber: 1, column: at + 1 }), getOffsetAt: position => position.column - 1 };
    const locator = api.createLocator({}, { document: { createElement: () => ({}) } });
    // These candidates already have confirmed mappings from scanning.
    api.createLocator = () => locator;
    const index = locator.editorSourceIndex(model);
    const target = { raw: format ? index.raw : index.raw.replace('WRONG', 'RIGHT𠀀').replace('WRONG', 'RIGHT𠀀')
      .replace('WRONG', 'DIFFERENT').replace('OTHER', 'RIGHT𠀀'), parts: [] };
    locator.prepareSource = current => locator.rememberConnection(current, 0, current.raw.length, target,
      { start: 0, end: target.raw.length });
    const starts = [...index.raw.matchAll(format ? /Word|Other/g : /WRONG|OTHER/g)].map(match => match.index);
    const items = starts.map((start, at) => {
      const end = start + (format ? at === 3 ? 5 : 4 : 5);
      const font = { italic: at === 2, bold: at !== 2 };
      if (format) target.parts.push({ start, end, font });
      return { id: String(at), sourceStart: start, sourceEnd: end,
        ...(format ? { text: index.raw.slice(start, end), font, htmlFont: index.formats[start] }
          : { comparison: { html: index.raw.slice(start, end), pdf: at === 2 ? 'DIFFERENT' : 'RIGHT𠀀' } }),
        options: [{ id: format ? 'format' : 'pdf', edits: format ? api.fontEdits(index, start, end, font)
          : api.textEdits(index, start, end, at === 2 ? 'DIFFERENT' : 'RIGHT𠀀') }] };
    });
    locator.rememberConnection(index, 0, index.raw.length, target, { start: 0, end: target.raw.length });
    const editor = { getModel: () => model, getOption: () => false, pushUndoStop() { undoStops++; },
      executeEdits(origin, edits) {
        applications++;
        for (const edit of [...edits].reverse()) source = source.slice(0, edit.range.startColumn - 1) + edit.text + source.slice(edit.range.endColumn - 1);
        version++; return true;
      } };
    let highlighted;
    reviewProvider(api, providers, { showReviewPointer(targetEditor, matches) {
      assert.equal(targetEditor, editor); highlighted = matches;
    } });
    providers.get('pdf-ocr').onSelect(items[1], { editor }, items);
    assert.deepEqual(Array.from(highlighted, item => item.id), ['0', '1'],
      'one popup highlights every matching pattern and excludes other corrections or styles');
    api.reviewCandidates = () => { throw new Error('incremental replacement must preserve existing candidates'); };
    const result = providers.get('pdf-ocr').apply({ editor, model, source, version, items, position: 1,
      choices: new Map(items.map(item => [item.id, item.options[0].id])), context: { model, index, targets: [target] } }, false);
    assert.equal(source, format ? '<p><b>Word</b></p><p><b>Word</b></p><p>Word</p><p>Other</p>'
      : '<p>RIGHT𠀀</p><p>RIGHT𠀀</p><p>WRONG</p><p>OTHER</p>');
    assert.deepEqual(Array.from(result.items, item => item.comparison?.pdf || item.text),
      format ? ['Word', 'Other'] : ['DIFFERENT', 'RIGHT𠀀']);
    assert.equal(result.items[0].comparison, items[2].comparison, 'original comparison and grouping survive');
    assert.equal(result.items[0].pdfSource.index, result.context.index, 'candidate uses the current source mapping');
    assert.equal(result.position, 0, 'matching candidates before the current item are also removed');
    assert.equal(applications, 1);
    assert.equal(undoStops, 2, 'the entire batch uses one undo group');
    const next = result.items[0].options[0].edits[0];
    assert.equal(source.slice(next.start, next.end), next.expected, 'remaining edits use the current source');
    assert.equal(result.context.index.source, source);
    for (const candidate of result.items) for (const option of candidate.options) api.validateEdits(source, option.edits);
    const nextResult = providers.get('pdf-ocr').apply({ editor, model, source, version, items: result.items,
      position: result.position, choices: result.choices, context: result.context }, false);
    for (const candidate of nextResult.items) for (const option of candidate.options) api.validateEdits(source, option.edits);
    assert.equal(nextResult.context.index.source, source, 'consecutive replacements keep candidates on the current source');
  }
});

test('compact review keeps distant differences without computing a second diff', () => {
  const api = engine(), providers = new Map();
  let calls = 0;
  const diff = api.textDiff;
  api.textDiff = (...args) => { calls++; return diff(...args); };
  reviewProvider(api, providers);
  const prefix = 'prefix '.repeat(12), middle = ' unchanged '.repeat(20), suffix = ' suffix'.repeat(12);
  const item = { id: 'one', options: [{ id: 'pdf', edits: [] }],
    comparison: { html: prefix + 'WRONG' + middle + 'BAD' + suffix,
      pdf: prefix + 'RIGHT' + middle + 'GOOD' + suffix } };
  const content = providers.get('pdf-ocr').content({ items: [item], choices: new Map([['one', 'pdf']]) }, item);
  const html = content.comparison[0].parts.map(part => part.text).join('');
  const pdf = content.comparison[1].parts.map(part => part.text).join('');
  assert.ok(html.includes('WRONG' + middle + 'BAD'));
  assert.ok(pdf.includes('RIGHT' + middle + 'GOOD'));
  assert.ok(html.startsWith('…') && html.endsWith('…'));
  assert.equal(calls, 1);
});


test('local textDiff serves review candidates and popup comparisons', () => {
  const api = engine(), providers = new Map();
  reviewProvider(api, providers);
  const locator = api.createLocator({}, { document: { createElement: () => ({}) } });
  const source = '<p>中文𠀀 wrong end</p>';
  const index = locator.editorSourceIndex({ getValue: () => source, getVersionId: () => 1 });
  const target = { raw: index.raw.replace('wrong', 'right') };
  locator.rememberConnection(index, 0, index.raw.length, target, { start: 0, end: target.raw.length });
  const localItems = api.reviewCandidates(index, [target]);
  assert.ok(localItems.length);
  const item = { options: [], comparison: { html: index.raw, pdf: target.raw } };
  const provider = providers.get('pdf-ocr');
  const localRows = provider.content({ items: [item], choices: new Map() }, item).comparison;
  assert.ok(localRows.every(row => row.parts.some(part => part.changed)));
  for (const connection of index.connections.get(target)) delete connection.editorDiff;
  const refreshedItems = api.reviewCandidates(index, [target]);
  for (const items of [localItems, refreshedItems])
    assert.equal(api.previewEdits(source, items.flatMap(item => item.options[0].edits)), source.replace('wrong', 'right'));
  const refreshedRows = provider.content({ items: [item], choices: new Map() }, item).comparison;
  for (const rows of [localRows, refreshedRows]) {
    assert.equal(rows[0].parts.map(part => part.text).join(''), index.raw);
    assert.equal(rows[1].parts.map(part => part.text).join(''), target.raw);
    assert.ok(rows.every(row => row.parts.some(part => part.changed)));
  }
});

test('provider loads font/text and popup scripts before selection consumes its mapping API', async () => {
  const browser = await chromium.launch({ executablePath: process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: true });
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
        mappingReady: typeof PdfReviewProvider.createLocator === 'function',
        mappingInFontText: 'createLocator' in PdfSelectionDiff,
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
      const locator = PdfReviewProvider.createLocator({}, { isCurrent: () => true, waitForIdle: async () => {} });
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


test('text candidates, font candidates and decorations reuse one traversal and refresh font metadata', () => {
  const api = engine(), provider = reviewProvider(api);
  const locator = api.createLocator({}, { document: { createElement: () => ({}) } });
  const index = locator.sourceIndex('Alpha beta gamma');
  const target = { raw: 'Alpha beta GAMMA', fontVersion: 0, parts: [
    { start: 0, end: 6, font: { bold: false, italic: false } },
    { start: 6, end: 10, font: { bold: true, italic: false } },
    { start: 10, end: 16, font: { bold: false, italic: false } }
  ] };
  const connection = locator.rememberConnection(index, 0, index.raw.length, target, { start: 0, end: target.raw.length });
  let reads = 0;
  connection.editorDiff = { parts: [
    { html: 'Alpha beta ', pdf: 'Alpha beta ', changed: false },
    { html: 'gamma', pdf: 'GAMMA', changed: true }
  ].map(part => new Proxy(part, { get(object, key) { reads++; return object[key]; } })) };
  const items = api.reviewCandidates(index, [target]);
  const traversed = reads;
  const fonts = api.formatDifferences(index, [[connection, target, api.connectionDiff(index, target, connection)]]);
  const model = { getPositionAt: offset => ({ lineNumber: 1, column: offset + 1 }) };
  const marks = provider.sourceDecorations(index, [[connection, target]], model);
  assert.equal(reads, traversed, 'review and highlight consumers share the classified spans');
  assert.deepEqual(Array.from(items, item => item.comparison.pdf), ['GAMMA']);
  assert.deepEqual(Array.from(fonts, item => item.text), ['beta']);
  assert.equal(marks.filter(mark => mark.options.description === 'PDF OCR text difference').length, 1);
  assert.equal(marks.filter(mark => mark.options.description === 'PDF font difference').length, 1);
  target.parts[1].font.bold = false;
  target.fontVersion++;
  assert.equal(api.formatDifferences(index, [[connection, target, api.connectionDiff(index, target, connection)]]).length, 0);
  assert.ok(reads > traversed, 'new font metadata invalidates classification');
  assert.equal(api.reviewCandidates(index, [target])[0].comparison.pdf, 'GAMMA');
});

test('transient mapping eviction preserves every prepared passage and recent selections', () => {
  const locator = engine().createLocator({}, { document: { createElement: () => ({}) } });
  const index = locator.sourceIndex('a'.repeat(400)), target = locator.sourceIndex(index.raw);
  for (let start = 0; start < 360; start++)
    locator.rememberConnection(index, start, start + 1, target, { start, end: start + 1 }, null, start < 160);
  const retained = index.connections.get(target);
  assert.equal(retained.filter(item => item.prepared).length, 160, 'required mappings are never evicted');
  assert.equal(retained.filter(item => !item.prepared).length, 128, 'selection history has a fixed bound');
  assert.equal(locator.connectedRange(index, target, 0, 1).start, 0);
  assert.equal(locator.connectedRange(index, target, 359, 360).start, 359);
  assert.equal(locator.connectedRange(index, target, 160, 161), null);
});


test('passage pruning matches pairwise containment and ignores cache recency order', () => {
  const locator = engine().createLocator({}, { document: { createElement: () => ({}) } });
  let seed = 23;
  const random = max => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % max; };
  for (let round = 0; round < 80; round++) {
    const index = locator.sourceIndex('a'.repeat(500)), pdf = {};
    const pages = Array.from({ length: 8 }, () => locator.sourceIndex('Page'));
    for (const page of pages) {
      index.pageScopes.set(page, { prepared: true, scope: null });
      index.connections.set(page, Array.from({ length: 20 }, () => {
        const start = random(400); return { start, end: start + random(100) + 1 };
      }));
    }
    const all = pages.flatMap(page => index.connections.get(page).map(item => ({ page, item })));
    const expected = pages.map(page => index.connections.get(page).filter(item => !all.some(other => other.page !== page
      && other.item.start <= item.start && other.item.end >= item.end
      && other.item.end - other.item.start > item.end - item.start)));
    locator.prepareSource(index, pages, pdf);
    pages.forEach((page, i) => assert.deepEqual(index.connections.get(page), expected[i]));
    const preparation = index.preparation;
    locator.prepareSource(index, [...pages].reverse(), pdf);
    assert.equal(index.preparation, preparation, 'LRU recency changes do not invalidate prepared mappings');
  }
});


test('OCR page reads publish font styles into the same aligned spans without a separate font pass', async () => {
  const api = engine(), objects = new Map();
  let pageReads = 0, textReads = 0, operatorReads = 0, release, notifications = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const items = ['Regular', 'Styled', 'RIGHT'].map((str, i) => ({ str, fontName: i === 1 ? 'style' : 'regular',
    transform: [1, 0, 0, 1, i * 80, 100], width: 70, height: 12 }));
  const page = { commonObjs: objects,
    async getTextContent() { textReads++; return { items }; },
    async getOperatorList() {
      operatorReads++;
      await gate;
      objects.set('regular', { name: 'Times', bold: false, italic: false });
      objects.set('style', { name: 'Times-BoldItalic', bold: true, italic: true });
      return { fnArray: [37, 38, 44, 37, 44], argsArray: [['regular', 12], [3], [], ['style', 12], []] };
    }
  };
  const pdf = { numPages: 1, async getPage() { pageReads++; return page; } };
  const locator = api.createLocator({}, { document: { createElement: () => ({}) },
    isCurrent: () => true, waitForIdle: async () => {}, onIndexed: () => notifications++ });
  const target = await locator.indexDocument(pdf);
  const source = locator.sourceIndex('<p>Regular Styled WRONG</p>');
  const connection = locator.rememberConnection(source, 0, source.raw.length, target, { start: 0, end: target.raw.length });
  const before = api.differences(source, target, connection);
  assert.ok(before.text.length > 0, 'text comparison works while PDF font metadata is pending');
  assert.equal(before.fonts.length, 0, 'pending font data cannot create an automatic format edit');
  assert.equal(operatorReads, 1, 'font detection already started with the OCR page read');
  const alignment = connection.editorDiff;
  release();
  await target.pages[0].fontTask;
  const after = api.differences(source, target, connection);
  assert.equal(connection.editorDiff, alignment, 'font publication reuses the confirmed text alignment');
  assert.equal(after.fonts.length, 1);
  assert.equal(source.raw.slice(after.fonts[0].sourceStart, after.fonts[0].sourceEnd), 'Styled');
  assert.equal(after.fonts[0].font.bold, true);
  assert.equal(after.fonts[0].font.italic, true);
  assert.ok(notifications >= 2, 'late font metadata publishes an index update for existing highlights');
  const content = await api.readPageText(page);
  assert.equal(target.pages[0].parts[1].font, content.fonts.get('style'));
  const spans = items.map(item => ({ textContent: item.str,
    ownerDocument: { defaultView: { getComputedStyle: () => ({ fontFamily: 'serif' }) } } }));
  const view = { pdfPage: page, _textHighlighter: { textDivs: spans } };
  await new Promise(resolve => api.layerFonts(view, {}, resolve));
  assert.equal(api.layerFonts(view, {}, () => {})(spans[1]), target.pages[0].parts[1].font,
    'rendered OCR layers and the document index use the same detected style object');
  const changed = locator.sourceIndex('<p>Regular BADDDD RIGHT</p>');
  const mismatch = locator.rememberConnection(changed, 0, changed.raw.length, target, { start: 0, end: target.raw.length });
  assert.equal(api.formatDifferences(changed, [[mismatch, target, api.connectionDiff(changed, target, mismatch)]]).length, 0,
    'styled PDF text cannot be applied to a different HTML word without aligned characters');
  await locator.indexFonts(pdf);
  assert.deepEqual([pageReads, textReads, operatorReads], [1, 1, 1], 'review and native layers never reread this page');
});


test('saved font sizes and colors load without merging distinct frontend runs', async () => {
  const window = {};
  const fonts = [
    { name: 'Times-Roman', italic: false, bold: false, flags: 4, size: 11, color: 0, alpha: 255, ascender: 1.05, descender: -0.28 },
    { name: 'Times-Roman', italic: false, bold: false, flags: 4, size: 22, color: 0, alpha: 255, ascender: 1.05, descender: -0.28 },
    { name: 'Times-Roman', italic: false, bold: false, flags: 4, size: 22, color: 0xFF0000, alpha: 128, ascender: 1.05, descender: -0.28 }
  ];
  const formatted = fonts.map((font, i) => ({ start: i * 2, end: i * 2 + 1, fontIndex: i, text: 'ABC'[i] }));
  const data = { schema: 3, raw: 'A B C', fonts, formatted,
    pages: [{ number: 1, start: 0, end: 5, parts: formatted.map(part => ({ ...part, item: { str: part.text } })) }] };
  vm.runInNewContext(engineSource, { window, fetch: async () => ({ ok: true, json: async () => data }) });
  const index = await window.LocalOcrTextReader.readDocument({ numPages: 1, ocrTextUrl: '/cache' }, { isCurrent: () => true });
  assert.equal(index.pages[0].parts[1].font, fonts[1]);
  const runs = window.PdfSelectionDiff.fontRuns(index);
  assert.equal(runs.length, 3, 'same family and bold/italic state must retain size/color boundaries');
  for (let i = 0; i < runs.length; i++) {
    for (const key of Object.keys(fonts[i])) assert.equal(runs[i][key], fonts[i][key]);
  }
  const spans = [{ textContent: 'A' }, { textContent: 'B C' }];
  const lookup = window.PdfSelectionDiff.layerFonts({ _textHighlighter: { textDivs: spans } }, {}, () => {}, index.pages[0], index);
  assert.equal(lookup(spans[0]).size, 11);
  assert.equal(lookup(spans[1]).italic, null, 'a mixed span cannot inherit only its first font');
});

test('PDF cache stays primary and unavailable or invalid caches use the original text layer', async () => {
  const window = {};
  let response, requests = 0, reads = 0;
  vm.runInNewContext(engineSource, { window, fetch: async () => {
    requests++;
    if (response instanceof Error) throw response;
    return response;
  } });
  const api = Object.assign(window.PdfReviewProvider, window.PdfSelectionDiff);
  const environment = { isCurrent: () => true, waitForIdle: async () => {} };
  const makePdf = () => ({ numPages: 1, ocrTextUrl: '/cache', getPage: async () => {
    reads++;
    return { getTextContent: async () => ({ items: [
      { str: 'Original', transform: [1, 0, 0, 1, 0, 10], height: 10, width: 40 }
    ] }) };
  } });
  response = { ok: true, json: async () => ({ schema: 3, raw: 'Cached', fonts: [], formatted: [],
    pages: [{ number: 1, start: 0, end: 6, parts: [] }] }) };
  const cached = await api.createLocator({}, environment).indexDocument(makePdf());
  assert.equal(cached.raw, 'Cached');
  assert.equal(reads, 0, 'a valid backend cache never reads PDF.js text');
  for (const failure of [new Error('offline'),
    { ok: false, json: async () => ({ error: 'unavailable' }) },
    { ok: true, json: async () => { throw new SyntaxError('invalid JSON'); } },
    { ok: true, json: async () => ({ schema: 2, raw: 'Old', fonts: [], formatted: [], pages: [] }) },
    { ok: true, json: async () => ({ schema: 1, pages: [] }) }]) {
    response = failure;
    const pdf = makePdf(), locator = api.createLocator({}, environment);
    const [first, second] = await Promise.all([locator.indexDocument(pdf), locator.indexDocument(pdf)]);
    assert.equal(first, second, 'fallback index work is shared');
    assert.equal(first.raw, 'Original\n');
    assert.equal(first.pages[0].parts[0].start, 0);
    assert.equal(first.pages[0].parts[0].end, 8);
    assert.equal(first.normalized.text, 'original ');
  }
  const pdf = makePdf();
  delete pdf.ocrTextUrl;
  const before = requests;
  assert.equal((await api.createLocator({}, environment).indexDocument(pdf)).raw, 'Original\n');
  assert.equal(requests, before, 'no backend request without a URL');
  assert.equal(reads, 6, 'each fallback reads its page once');
});

test('text-layer fallback stops on document change and failed extraction can retry', async () => {
  const api = engine();
  let current = true, reads = 0;
  const pdf = { numPages: 2, getPage: async () => {
    reads++;
    return { getTextContent: async () => { current = false; return { items: [] }; } };
  } };
  const environment = { isCurrent: () => current, waitForIdle: async () => {} };
  assert.equal(await api.createLocator({}, environment).indexDocument(pdf), null);
  assert.equal(reads, 1);
  current = true;
  let attempts = 0;
  const page = { getTextContent: async () => {
    if (++attempts === 1) throw new Error('temporary text failure');
    return { items: [] };
  } };
  const retryPdf = { numPages: 1, getPage: async () => page };
  const locator = api.createLocator({}, environment);
  await assert.rejects(locator.indexDocument(retryPdf), /temporary text failure/);
  assert.ok(await locator.indexDocument(retryPdf));
  assert.equal(attempts, 2);
});
