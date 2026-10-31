import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchBrowser, startServer, stopServer } from './support/browser.mjs';

const fixture = await mkdtemp(path.join(tmpdir(), 'mew-split-model-'));
let server, browser;
try {
  await mkdir(path.join(fixture, '1'));
  const text = n => `<p>Page ${n} has a unique opening with enough context to establish its independent source location. This original text belongs exclusively to page ${n} and ends with another lengthy unique passage.</p>`;
  for (const n of [1, 2]) await writeFile(path.join(fixture, `1/ME01-00${n}.html`), text(n));
  await writeFile(path.join(fixture, 'config.json'), JSON.stringify({ volumes: [{ id: '1', pdf: 'missing.pdf', pages: { directory: '1', pattern: '^ME01-([0-9]+)[.]html$' } }] }));
  server = await startServer('reader-server.js', 41896, ['-c', path.join(fixture, 'config.json')]);
  browser = await launchBrowser();
  const context = await browser.newContext();
  const errors = [];
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  await context.route('**/api/reader/settings', route => route.fulfill({ json: { diffHighlight: false, sourceDiffHighlight: true, selectionHighlight: false, italicDetection: false, boldDetection: false } }));
  const combined = await context.newPage();
  await combined.goto('http://127.0.0.1:41896/?volume=1&page=1&mode=source');
  await combined.waitForFunction(() => window.readerMonaco?.model?.getValue().includes('Page 1'));
  await combined.evaluate(async () => {
    window.originalModel = readerMonaco.model;
    readerMonaco.editor.executeEdits('model-test', [{ range: originalModel.getFullModelRange(), text: originalModel.getValue() + '<p>Saved edit with undo history</p>' }]);
    await readerMonaco.save();
    await readerMonaco.reviewFiles().open(2);
  });
  assert.equal(await combined.evaluate(() => readerMonaco.model !== originalModel && readerMonaco.model.getValue().includes('Page 2')), true);
  await combined.evaluate(() => readerMonaco.reviewFiles().open(1));
  assert.equal(await combined.evaluate(() => readerMonaco.model === originalModel && originalModel.canUndo()), true);
  await combined.close();
  const reader = await context.newPage();
  await reader.addInitScript(() => {
    let ui;
    Object.defineProperty(window, 'ReaderUI', { configurable: true, get: () => ui, set(value) {
      ui = value;
      const init = value.init;
      value.init = handlers => { window.readerHandlers = handlers; return init(handlers); };
    } });
  });
  const session = `models-${Date.now()}`;
  await reader.goto(`http://127.0.0.1:41896/?view=reader&sync=${session}&volume=1&page=1`);
  await reader.waitForFunction(() => window.ReaderUI?.getSourceEditor && window.PdfSelection);
  const popup = reader.waitForEvent('popup');
  await reader.evaluate(session => window.open(`/index.html?readerSession=${session}&file=1/ME01-001.html`, `mew-editor-${session}`), session);
  const editor = await popup;
  await editor.waitForFunction(() => window.mewWorkbench?.editor.getModel());
  await reader.waitForFunction(() => PdfSelection.editor?.getModel().uri.path === '/1/ME01-001.html');
  assert.equal(await reader.evaluate(() => !!window.readerMonaco), false);
  await editor.evaluate(() => {
    window.firstModel = mewWorkbench.editor.getModel();
    mewWorkbench.editor.executeEdits('test', [{ range: firstModel.getFullModelRange(), text: firstModel.getValue().replace('original', 'unsaved') }]);
  });
  await reader.evaluate(() => {
    const stage = document.createElement('div');
    document.body.append(stage);
    const views = [1, 2].map(n => {
      const div = document.createElement('div'); div.className = 'page'; div.dataset.pageNumber = n;
      div.innerHTML = `<div class="textLayer"><span>PDF page ${n} independent text</span></div>`;
      stage.append(div); return { div };
    });
    window.mockPdf = { numPages: 2, async getPage(n) { return { async getTextContent() { return { items: [{ str: `PDF page ${n} independent text`, transform: [1,0,0,1,0,100], width: 100, height: 12 }] }; } }; } };
    window.mockViewer = { pdfDocument: mockPdf, container: stage, getPageView: i => views[i], eventBus: { on() {}, off() {} }, _getVisiblePages: () => ({ views: [{ id: 1 }, { id: 2 }] }) };
    ReaderUI.getPdfSourcePages = () => [new URL(location.href).searchParams.get('page') === '2' ? 2 : 1];
    PdfSelection.attachViewer(mockViewer);
  });
  await reader.evaluate(async () => {
    const locator = PdfSelection.locator;
    await locator.indexDocument(mockPdf); // An existing volume cache must not escape the page scope.
    await locator.indexDocument(mockPdf, [1]);
    PdfSelection.refresh();
  });
  assert.deepEqual(await reader.evaluate(() => PdfSelection.locator.environment.getTargets().flatMap(t => t.pages?.map(p => p.number) || [Number(t.layer.closest('.page').dataset.pageNumber)])), [1, 1]);
  // Pause the file bridge response to exercise the gap between reader navigation and editor activation.
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  await editor.route('**/api/file?path=1%2FME01-002.html', async route => { await pending; await route.continue(); });
  await reader.evaluate(() => readerHandlers.pdfPageChange({ pageNumber: 2, pageLabel: '2' }));
  await reader.waitForFunction(() => new URL(location.href).searchParams.get('page') === '2');
  assert.equal(await reader.evaluate(() => PdfSelection.editor === null || PdfSelection.editor === undefined), true);
  assert.deepEqual(await reader.evaluate(() => PdfSelection.locator.environment.getTargets()), []);
  release();
  await editor.waitForFunction(() => mewWorkbench.editor.getModel().uri.path.endsWith('002.html'));
  await reader.waitForFunction(() => PdfSelection.editor?.getModel().uri.path.endsWith('002.html'));
  await reader.evaluate(async () => { await PdfSelection.locator.indexDocument(mockPdf, [2]); PdfSelection.refresh(); });
  assert.deepEqual(await reader.evaluate(() => PdfSelection.locator.environment.getTargets().flatMap(t => t.pages?.map(p => p.number) || [Number(t.layer.closest('.page').dataset.pageNumber)])), [2, 2]);
  assert.equal(await editor.evaluate(() => firstModel !== mewWorkbench.editor.getModel() && firstModel.getValue().includes('unsaved') && mewWorkbench.documents.get('1/ME01-001.html').dirty), true);
  await editor.evaluate(() => mewWorkbench.openFile('1/ME01-001.html'));
  await reader.waitForFunction(() => new URL(location.href).searchParams.get('page') === '1');
  assert.equal(await editor.evaluate(() => firstModel === mewWorkbench.editor.getModel()), true);
  // The reader can review the editor's model, but only the owning window saves it.
  const installSaveReview = () => ReplacementReview.register({
    id: 'save-ownership', label: 'Save ownership',
    presentation: () => ({ side: window.ReaderUI ? 'pdf' : 'html' }),
    provide: () => [{ id: 'one', options: [{ id: 'keep', edits: [] }] }],
    content: (_state, item) => ({ message: 'Save ownership', options: item.options })
  });
  await reader.evaluate(installSaveReview);
  await editor.evaluate(installSaveReview);
  await reader.evaluate(() => ReplacementReview.open('save-ownership', PdfSelection.editor));
  const readerSave = reader.locator('.replacement-review [data-save]');
  await readerSave.waitFor({ state: 'visible' });
  assert.equal(await readerSave.textContent(), '保存修改');
  assert.equal(await readerSave.isDisabled(), true);
  let writes = 0;
  context.on('request', request => { if (request.method() === 'POST' && request.url().includes('/api/save')) writes++; });
  await readerSave.evaluate(async button => { button.disabled = false; await button.onclick(); });
  assert.equal(writes, 0, 'even a programmatic reader-side click cannot save another window');
  assert.equal(await editor.evaluate(() => mewWorkbench.documents.get('1/ME01-001.html').dirty), true);
  await reader.evaluate(() => ReplacementReview.close());
  await editor.evaluate(() => ReplacementReview.open('save-ownership', mewWorkbench.editor));
  const editorSave = editor.locator('.replacement-review [data-save]');
  await editorSave.waitFor({ state: 'visible' });
  assert.equal(await editorSave.isEnabled(), true);
  await editorSave.click();
  await editor.waitForFunction(() => !mewWorkbench.documents.get('1/ME01-001.html').dirty);
  assert.equal(writes, 1, 'index.html saves its own model through the existing save flow');
  assert.deepEqual(errors, []);
  console.log('Split file bridge: independent dirty models, page-scoped targets, and navigation-gap isolation passed');
} finally {
  await browser?.close();
  await stopServer(server);
  await rm(fixture, { recursive: true, force: true });
}

