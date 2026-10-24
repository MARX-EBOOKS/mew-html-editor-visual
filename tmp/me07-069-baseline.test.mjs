import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';
import { chromium } from 'playwright';
import { DefaultLinesDiffComputer } from '../node_modules/monaco-editor/esm/vs/editor/common/diff/defaultLinesDiffComputer/defaultLinesDiffComputer.js';

const localDiffSource = await readFile(new URL('../public/pdfdiff/local-text-diff.js', import.meta.url), 'utf8');
const engineSource = localDiffSource + await readFile(new URL('../tmp/me07-069-before-diff.js', import.meta.url), 'utf8');
const providerSource = (await readFile(new URL('../public/pdfdiff/pdf-review-provider.js', import.meta.url), 'utf8'))
  .split('// PDF comparison is one review provider. Selection synchronization remains independent.')[1]
  .replace(/\r?\n  return window\.PdfReviewProvider;\r?\n\}\)\(\);\s*$/, '');
const fullProviderSource = await readFile(new URL('../public/pdfdiff/pdf-review-provider.js', import.meta.url), 'utf8');
const source = `if (!window.PdfReviewProvider) { ${fullProviderSource} }` + `
window.lastNotice = null;
window.addEventListener('pdf-selection-difference', event => { window.lastNotice = event.detail; });
window.addEventListener('pdf-selection-highlight-status', event => { if (event.detail.mode === null) window.lastNotice = null; });
` + await readFile(new URL('../tmp/me07-069-before-selection.js', import.meta.url), 'utf8');
const readerMenu = (await readFile(new URL('../public/reader.html', import.meta.url), 'utf8')).match(/<button id="diffHighlightBtn".*?<\/button>/)[0];
function engine() {
  const window = {};
  vm.runInNewContext(engineSource, { window });
  window.PdfSelectionDiff.local = window.PdfLocalTextDiff;
  return window.PdfSelectionDiff;
}
function reviewProvider(api, providers = new Map(), selection, document = {}) {
  const window = { PdfSelection: selection, PdfSelectionDiff: api, ReplacementReview: { register: provider => { providers.set(provider.id, provider); return () => {}; } },
    addEventListener() {}, removeEventListener() {} };
  vm.runInNewContext(providerSource.replace('window.PdfReviewProvider = {', 'window.PdfReviewProvider = { sourceDecorations,'), { window, document, setInterval: () => 0, clearInterval() {} });
  return window.PdfReviewProvider;
}

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
  api.useMonaco(new DefaultLinesDiffComputer());
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
  const formats = api.formatDifferences(formatIndex, [[connection, regular]]);
  assert.deepEqual(Array.from(formats, item => item.text), ['ab cd', 'EF']);
  assert.equal(formats[0].formats.length, 4, 'both bold and italic details survive grouping');
});

test('font indexing is explicit, cached, and retains unavailable font metadata as unknown', async () => {
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
  assert.equal(operators, 0, 'ordinary text indexing never loads operators');
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
        const items = api.formatDifferences(index, [[connection, full]]);
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
    await page.evaluate(() => { PdfSelectionDiff.loadMonaco = async () => false; });
    await page.addScriptTag({ content: await readFile(new URL('../public/pdfdiff/pdf-review-provider.js', import.meta.url), 'utf8') });
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
        getTextContent: async () => ({ items: [{ str, fontName: 'f', transform: [1, 0, 0, 1, 0, 100], height: 12, width: 80 }] }),
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
    assert.equal(api.formatDifferences(heading, [[connection, target]]).length, 0, 'a heading alone does not declare bold');
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
  const items = api.formatDifferences(index, [[connection, target], [connection, target]]);
  assert.deepEqual(Array.from(items, item => item.text), ['A B C', '𠀀']);
  assert.equal(items[0].htmlFont.bold, false, 'italic alone misses the bold half');
  assert.equal(items[0].formats[1].htmlFont.italic, false, 'bold alone misses the italic half');
  assert.equal(items[0].formats[2].font.bold, false, 'surplus HTML formatting is also flagged');
  const revised = api.previewEdits(html, items.flatMap(item => item.options[0].edits));
  const corrected = locator.sourceIndex(revised);
  assert.equal(corrected.raw, index.raw, 'format replacement preserves all visible text and UTF-16 characters');
  const confirmed = locator.rememberConnection(corrected, 0, corrected.raw.length, target, { start: 0, end: target.raw.length });
  assert.equal(api.formatDifferences(corrected, [[confirmed, target]]).length, 0, 'missing, surplus and mixed bold/italic are corrected together');
  assert.ok(revised.includes('<strong>D</strong> <em>E</em>'), 'already correct formatting stays unchanged');
  api.useMonaco(new DefaultLinesDiffComputer());
  const model = { getPositionAt: at => ({ lineNumber: 1, column: at + 1 }) };
  const marks = api.sourceDecorations(index, [[connection, target]], model);
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
    assert.equal(api.formatDifferences(index, [[connection, target]]).length, 0);
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
    const providerSource = (await readFile(new URL('../public/pdfdiff/pdf-review-provider.js', import.meta.url), 'utf8')).split('// PDF comparison is one review provider. Selection synchronization remains independent.')[1]
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
      const locator = PdfSelectionDiff.createLocator({}, { isCurrent: () => true, waitForIdle: async () => {} });
      const full = await locator.indexFonts(pdf);
      const runs = PdfSelectionDiff.fontRuns(full);
      await PdfSelectionDiff.loadMonaco();
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
      await PdfSelectionDiff.loadMonaco();
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
      const locator = PdfSelectionDiff.createLocator({}, { getVisiblePages: () => [{ index: visibleTarget }] }), index = locator.editorSourceIndex(model);
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
    await page.addScriptTag({ content: await readFile(new URL('../public/pdfdiff/pdf-review-provider.js', import.meta.url), 'utf8') });
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
  api.useMonaco(new DefaultLinesDiffComputer());
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
  api.useMonaco(new DefaultLinesDiffComputer());
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
  const marks = targets => api.sourceDecorations(index, targets.flatMap(target =>
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
  api.useMonaco(new DefaultLinesDiffComputer());
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
  const api = engine(), computer = new DefaultLinesDiffComputer();
  let comparisons = 0;
  api.useMonaco({ computeDiff(...args) { comparisons++; return computer.computeDiff(...args); } });
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
  assert.equal(comparisons, connections.length, 'inverse mappings reuse the forward character diffs');
  const calls = comparisons;
  locator.prepareSource(source, [full], pdf);
  assert.deepEqual(source.connections.get(full), connections, 'review initialization must reuse inverse mappings without scanning the whole volume again');
  assert.equal(comparisons, calls, 'repeat preparation reuses both alignment directions');
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

test('Monaco ranges take priority; missing, failed, timed-out and incomplete results fall back', () => {
  const api = engine(), left = 'prefix abc suffix', right = 'prefix axc suffix';
  const fallback = api.textDiff(left, right, true);
  let calls = 0;
  const change = { originalRange: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: left.length + 1 },
    modifiedRange: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: right.length + 1 } };
  api.useMonaco({ computeDiff() { calls++; return { changes: [{ innerChanges: [change] }], hitTimeout: false }; } });
  const primary = api.textDiff(left, right, true);
  assert.equal(calls, 1);
  assert.deepEqual(primary, fallback, 'broad Monaco ranges are refined into exact character changes');
  assert.equal(primary.distance, fallback.distance);
  for (const computeDiff of [
    () => { throw new Error('worker unavailable'); },
    () => ({ hitTimeout: true, changes: [] }),
    () => ({ changes: [{}] }),
    () => ({ changes: [] }),
    () => ({ changes: [{ innerChanges: [{ ...change, originalRange: { ...change.originalRange, endColumn: 999 } }] }] })
  ]) {
    api.useMonaco({ computeDiff });
    assert.deepEqual(api.textDiff(left, right, true), fallback);
  }
  api.useMonaco({
    computeDiff() { throw new Error('line diff unavailable'); },
    myersDiffingAlgorithm: { compute() { throw new Error('character diff unavailable'); } }
  });
  assert.equal(api.textDiff(left, right).distance, fallback.distance);
  assert.deepEqual(api.textDiff(left, right, true), fallback);
  api.useMonaco(null);
  assert.deepEqual(api.textDiff(left, right, true), fallback);
});

test('highlight hunks separate OCR boundary spaces beyond the whole-passage refinement budget', () => {
  const api = engine();
  const locator = api.createLocator({}, { document: { createElement: () => ({}) } });
  const source = 'aft der\n' + 'x'.repeat(140), target = { raw: 'äft  der\n' + 'y'.repeat(140) };
  const range = (line, endColumn) => ({ startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn });
  api.useMonaco({ computeDiff: () => ({ changes: [{ innerChanges: [
    { originalRange: range(1, 4), modifiedRange: range(1, 5) },
    { originalRange: range(2, 141), modifiedRange: range(2, 141) }
  ] }], hitTimeout: false }) });
  const index = locator.sourceIndex(source);
  const connection = { start: 0, end: source.length, targetStart: 0, targetEnd: target.raw.length };
  index.connections.set(target, [connection]);
  const parts = api.connectionDiff(index, target, connection).parts;
  assert.deepEqual(Array.from(parts.slice(0, 4), part => [part.html, part.pdf, part.changed]),
    [['a', 'ä', true], ['ft', 'ft', false], ['', ' ', true], [' der\n', ' der\n', false]]);
  const items = api.reviewCandidates(index, [target]);
  assert.deepEqual({ ...items[0].comparison }, { html: 'a', pdf: 'ä' });
  assert.equal(api.previewEdits(source, items[0].options[0].edits), source.replace('aft', 'äft'));
  const hit = locator.connectedRange(index, target, 0, 3, false, connection, true);
  assert.equal(target.raw.slice(hit.start, hit.end), 'äft', 'click excludes the following space insertion');
});

test('ME04-608 wrapped prose stays aligned across blank-line anchors', () => {
  const api = engine();
  api.useMonaco(new DefaultLinesDiffComputer());
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

test('bounded anchor checks reject impossible lengths before invoking Monaco', () => {
  const api = engine(), computer = new DefaultLinesDiffComputer();
  let calls = 0;
  api.useMonaco({ computeDiff(...args) { calls++; return computer.computeDiff(...args); } });
  const left = 'a'.repeat(80), right = 'b'.repeat(577854);
  assert.equal(api.textDiff(left, right, false, 12).distance, 13);
  const rejected = api.textDiff(right, left, true, 12);
  assert.equal(rejected.distance, 13);
  assert.deepEqual(Array.from(rejected.parts, part => [part.html, part.pdf, part.changed]), [[right, left, true]]);
  assert.equal(calls, 0, 'impossible anchor spans must never start a synchronous Monaco diff');
  assert.equal(api.textDiff('a', 'a𠀀', false, 1).distance, 1);
  assert.equal(calls, 1, 'length bounds count Unicode code points, not UTF-16 units');
  assert.equal(api.textDiff('a', 'ab', false, 1).distance, 1);
  const unbounded = api.textDiff('a', 'abc', true);
  assert.equal(unbounded.parts.map(part => part.pdf).join(''), 'abc');
  assert.equal(calls, 3, 'boundary and unbounded comparisons still use Monaco');
});

test('shared textDiff applies a one-second Monaco budget and falls back per comparison', () => {
  const api = engine(), computer = new DefaultLinesDiffComputer();
  const left = '中文𠀀 wrong', right = '中文𠀀 right';
  let calls = 0;
  api.useMonaco({ computeDiff(a, b, options) {
    assert.equal(options.maxComputationTimeMs, 1000);
    if (++calls === 1) return { hitTimeout: true, changes: [] };
    if (calls === 2) throw new Error('diff failed');
    return computer.computeDiff(a, b, options);
  } });
  assert.deepEqual(api.textDiff(left, right, true), api.local.textDiff(left, right, true));
  assert.deepEqual(api.textDiff(left, right, false, 1), api.local.textDiff(left, right, false, 1));
  assert.equal(api.monacoAvailable, true);
  const result = api.textDiff(left, right, true);
  assert.equal(calls, 3, 'a timeout or failure does not disable Monaco for later comparisons');
  assert.equal(result.parts.map(part => part.html).join(''), left);
  assert.equal(result.parts.map(part => part.pdf).join(''), right);
});

test('installed Monaco preserves complete Unicode readings and maps source positions in both directions', () => {
  const api = engine(), computer = new DefaultLinesDiffComputer();
  let calls = 0;
  api.useMonaco({ computeDiff(...args) { calls++; return computer.computeDiff(...args); } });
  for (const [left, right] of [
    ['First line\nwork together\n中文𠀀 last', 'First line\nworks together\n中文𠀀 last'],
    ['a𠀀b', 'a𠀁b'], ['before\nend', 'before\nextra\nend'], ['', 'added'], ['deleted', ''],
    ['Die Straße', 'Die Strasse'], ['line\r\nnext', 'line\r\nnew next']
  ]) {
    const diff = api.textDiff(left, right, true);
    assert.equal(diff.parts.map(part => part.html).join(''), left);
    assert.equal(diff.parts.map(part => part.pdf).join(''), right);
    assert.equal(diff.distance, api.local.textDiff(left, right).distance);
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
  assert.equal(calls, 8);
});

test('native decorations split changes around tags, map entities, and mark missing HTML text', () => {
  const api = engine(), provider = reviewProvider(api);
  assert.equal(api.textDiff('a', 'b', true).parts[0].changed, true);
  assert.deepEqual([...provider.sourceDecorations({}, [], {})], []);
  api.useMonaco(new DefaultLinesDiffComputer());
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
  api.useMonaco({ computeDiff: () => { throw new Error('unavailable'); } });
  assert.equal(api.textDiff('a', 'b', true).parts[0].changed, true);
  assert.deepEqual([...provider.sourceDecorations(index, [[{ ...connection, editorDiff: null }, target]], model)], [...decorations]);
  api.useMonaco(null);
  assert.deepEqual([...provider.sourceDecorations(index, [[connection, target]], model)], [...decorations]);
});

test('ME04-004 quote markers exclude matching paragraphs, PDF wrapping and the footnote', async () => {
  const fixture = JSON.parse(await readFile(new URL('../tests/fixtures/pdf-selection-me04.json', import.meta.url), 'utf8'));
  const api = engine();
  api.useMonaco(new DefaultLinesDiffComputer());
  const target = { raw: fixture.layerRaw, parts: [] }, pdf = {};
  const locator = api.createLocator({}, { document: { createElement: () => ({}) },
    getVisiblePages: () => [{ number: 20, index: target }] });
  Object.assign(target, { normalized: locator.normalized(target.raw) });
  const model = { getValue: () => fixture.html, getVersionId: () => 1,
    getPositionAt: offset => ({ lineNumber: 1, column: offset + 1 }) };
  const index = locator.editorSourceIndex(model);
  locator.sourcePageScope(index, target, true);
  const connections = (index.connections.get(target) || []).map(connection => [connection, target]);
  const marks = api.sourceDecorations(index, connections, model);
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
  api.useMonaco(new DefaultLinesDiffComputer());
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

test('ME07-066 missing page-end text maps before whole-document indexing', async () => {
  const fixture = JSON.parse(await readFile(new URL('../tests/fixtures/pdf-selection-me07-066.json', import.meta.url), 'utf8'));
  for (const monaco of [false, true]) for (const html of [fixture.html, fixture.html.replace(/\r\n/g, '\n')]) {
    const api = engine();
    if (monaco) api.useMonaco(new DefaultLinesDiffComputer());
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
  api.useMonaco(new DefaultLinesDiffComputer());
  const locator = api.createLocator({}, { document: { createElement: () => ({}) }, getTargets: () => pages });
  const index = { source: fixture.html, ...locator.sourceIndex(fixture.html) };
  const pages = fixture.pages.map(page => locator.sourceIndex(page.raw));
  locator.prepareSource(index, pages, {});
  // Font metadata can rebuild just the adjacent layer after the first preparation.
  pages[1] = locator.sourceIndex(fixture.pages[1].raw);
  locator.prepareSource(index, [pages[1]], {});
  const connections = pages.flatMap(page => (index.connections.get(page) || []).map(connection => [connection, page]));
  const model = { getPositionAt: offset => ({ lineNumber: 1, column: offset + 1 }) };
  const marks = api.sourceDecorations(index, connections, model);
  const at = fixture.html.indexOf('Gesellschaft nur') + 8;
  assert.ok(!marks.some(({ range }) => range.startColumn - 1 <= at && range.endColumn - 1 > at),
    'the uppercase H in the next page quotation is not a difference in this page');
  assert.ok(marks.some(({ options }) => /ooo/.test(options.hoverMessage?.value)), 'actual OCR differences remain reviewable');
});

test('ME04-037 keeps the matching heading out of deletion/reinsertion markers', async () => {
  const fixture = JSON.parse(await readFile(new URL('../tests/fixtures/pdf-selection-me04-037.json', import.meta.url), 'utf8'));
  const api = engine();
  api.useMonaco(new DefaultLinesDiffComputer());
  const locator = api.createLocator({}, { document: { createElement: () => ({}) } });
  for (const html of [fixture.html, fixture.html.replace(/\r\n/g, '\n')]) {
    const index = { source: html, ...locator.sourceIndex(html) }, target = locator.sourceIndex(fixture.layerRaw);
    locator.sourcePageScope(index, target, true);
    const connections = (index.connections.get(target) || []).map(connection => [connection, target]);
    assert.ok(connections.length);
    const model = { getPositionAt: offset => ({ lineNumber: 1, column: offset + 1 }) };
    const marks = api.sourceDecorations(index, connections, model);
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

test('source decorations ignore whitespace and hyphens while preserving subsequent character offsets', () => {
  const api = engine();
  api.useMonaco(new DefaultLinesDiffComputer());
  const model = { getPositionAt: offset => ({ lineNumber: 1, column: offset + 1 }) };
  const decorate = (raw, pdf) => api.sourceDecorations(
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

test('source markers locate Monaco changes at word boundaries, inside words and beside repeated characters', () => {
  const api = engine();
  api.useMonaco(new DefaultLinesDiffComputer());
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
    await page.evaluate(async () => {
      await PdfSelectionDiff.loadMonaco();
      window.editor = monaco.editor.create(document.getElementById('editor'), { value: 'first\naX&𠀀Z', wordWrap: 'on' });
      const model = editor.getModel(), raw = model.getValue();
      window.marks = editor.createDecorationsCollection(PdfSelectionDiff.sourceDecorations(
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
      window.ReplacementReview = { register: () => () => {}, refreshMenu() {}, invalidate() {},
        isOpenFor: () => false, openForSelection() {}, showNotice() {} };
    }, readerMenu);
    await page.addScriptTag({ content: (await readFile(new URL('../public/pdfdiff/pdf-review-provider.js', import.meta.url), 'utf8'))
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

test('browser loads Monaco ESM through static assets and uses its character ranges', async () => {
  const browser = await chromium.launch({ executablePath: process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: true });
  try {
    const page = await browser.newPage();
    await page.route('http://diff.test/**', async route => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html>' });
      if (!pathname.startsWith('/monaco/esm/') || pathname.includes('..')) return route.abort();
      const body = await readFile(new URL('../node_modules/monaco-editor/' + pathname.slice('/monaco/'.length), import.meta.url), 'utf8');
      await route.fulfill({ contentType: 'text/javascript', body });
    });
    await page.goto('http://diff.test/');
    await page.addScriptTag({ content: engineSource });
    const result = await page.evaluate(async () => {
      const loaded = await PdfSelectionDiff.loadMonaco();
      const { DefaultLinesDiffComputer } = await import('/monaco/esm/vs/editor/common/diff/defaultLinesDiffComputer/defaultLinesDiffComputer.js');
      const computer = new DefaultLinesDiffComputer();
      let calls = 0;
      PdfSelectionDiff.useMonaco({ computeDiff(...args) { calls++; return computer.computeDiff(...args); } });
      const diff = PdfSelectionDiff.textDiff('first\n中文𠀀 work end', 'first\n中文𠀀 works end', true);
      return { loaded, calls, diff };
    });
    assert.equal(result.loaded, true);
    assert.equal(result.calls, 1);
    assert.equal(result.diff.parts.map(part => part.html).join(''), 'first\n中文𠀀 work end');
    assert.equal(result.diff.parts.map(part => part.pdf).join(''), 'first\n中文𠀀 works end');
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

test('equal text skips Monaco computation and batch preview preserves all untouched text', () => {
  const api = engine();
  let calls = 0;
  api.useMonaco({ computeDiff() { calls++; throw new Error('unnecessary diff'); } });
  assert.equal(api.textDiff('same 𠀀', 'same 𠀀', true).parts[0].changed, false);
  assert.equal(calls, 0);
  const source = 'a𠀀bcdef';
  assert.equal(api.previewEdits(source, [{ start: 7, end: 8, text: 'Z' },
    { start: 1, end: 3, text: '&amp;' }, { start: 4, end: 4, text: 'X' }]), 'a&amp;bXcdeZ');
  assert.throws(() => api.previewEdits(source, [{ start: 1, end: 4, text: '' },
    { start: 3, end: 5, text: '' }]), /重叠/);
});

test('PDF replacement batches identical patterns and retains different text or formatting targets', () => {
  for (const format of [false, true]) {
    const api = engine(), providers = new Map();
    api.useMonaco(new DefaultLinesDiffComputer());
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
  const computer = new DefaultLinesDiffComputer();
  api.useMonaco({ computeDiff(...args) { calls++; return computer.computeDiff(...args); } });
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


test('local textDiff replaces Monaco for review candidates and popup comparisons', () => {
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
  api.useMonaco(new DefaultLinesDiffComputer());
  for (const connection of index.connections.get(target)) delete connection.editorDiff;
  const monacoItems = api.reviewCandidates(index, [target]);
  for (const items of [localItems, monacoItems])
    assert.equal(api.previewEdits(source, items.flatMap(item => item.options[0].edits)), source.replace('wrong', 'right'));
  const monacoRows = provider.content({ items: [item], choices: new Map() }, item).comparison;
  for (const rows of [localRows, monacoRows]) {
    assert.equal(rows[0].parts.map(part => part.text).join(''), index.raw);
    assert.equal(rows[1].parts.map(part => part.text).join(''), target.raw);
    assert.ok(rows.every(row => row.parts.some(part => part.changed)));
  }
});

test('browser loads the local substitute when Monaco assets are unavailable', async () => {
  const browser = await chromium.launch({ executablePath: process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: true });
  try {
    const page = await browser.newPage();
    await page.route('http://fallback.test/**', route => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html>' });
      if (path === '/pdfdiff/local-text-diff.js') return route.fulfill({ contentType: 'text/javascript', body: localDiffSource });
      if (path === '/pdfdiff/pdf-selection-diff.js') return route.fulfill({ contentType: 'text/javascript', body: engineSource.slice(localDiffSource.length) });
      return route.abort();
    });
    await page.goto('http://fallback.test/');
    const result = await page.evaluate(async () => {
      await import('/pdfdiff/pdf-selection-diff.js');
      const loaded = await PdfSelectionDiff.loadMonaco();
      return { loaded, local: typeof PdfLocalTextDiff.textDiff,
        diff: PdfSelectionDiff.textDiff('中文𠀀 wrong', '中文𠀀 right', true),
        distance: PdfSelectionDiff.textDiff('a'.repeat(200), 'b'.repeat(200)).distance };
    });
    assert.equal(result.loaded, false);
    assert.equal(result.local, 'function');
    assert.equal(result.distance, 200);
    assert.equal(result.diff.parts.map(part => part.html).join(''), '中文𠀀 wrong');
    assert.equal(result.diff.parts.map(part => part.pdf).join(''), '中文𠀀 right');
    assert.ok(result.diff.parts.some(part => part.changed));
  } finally { await browser.close(); }
});
