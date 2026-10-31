import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from '../../tests/support/browser.mjs';
const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(new URL('../extension.cjs', import.meta.url));
const source = await readFile(path.join(root, 'extension.cjs'), 'utf8');
const uri = value => ({ scheme: 'file', path: value, toString: () => value });
const htmlUri = uri('file:///pages/1.html'), pdfUri = uri('file:///book.pdf');
let text = '<p>Before WRONG after.</p>', version = 1, saves = 0, editCalls = 0, diffCalls = 0;
const original = text, snapshots = [];
class Position { constructor(line, character) { this.line = line; this.character = character; } }
class Range {
  constructor(a, b, c, d) {
    this.start = typeof a === 'number' ? new Position(a, b) : a;
    this.end = typeof a === 'number' ? new Position(c, d) : b;
  }
}
class Selection extends Range { constructor(a, b) { super(a, b); this.anchor = a; this.active = b; } }
const document = { uri: htmlUri, get version() { return version; }, get isDirty() { return text !== original; },
  getText: () => text, positionAt: offset => new Position(0, offset), offsetAt: position => position.character,
  save: async () => { saves++; return true; } };
const editor = { document, selections: [new Selection(new Position(0, 0), new Position(0, 0))],
  get selection() { return this.selections[0]; }, set selection(value) { this.selections = [value]; },
  revealRange() {}, setDecorations() {},
  async edit(callback) {
    const edits = [];
    callback({ replace: (range, replacement) => edits.push({ range, replacement }) });
    for (const edit of edits.sort((a, b) => b.range.start.character - a.range.start.character))
      text = text.slice(0, edit.range.start.character) + edit.replacement + text.slice(edit.range.end.character);
    version++; editCalls++; return true;
  }
};
const state = new Map();
const context = { extensionUri: '', subscriptions: [], globalState: { get: (key, fallback) => state.get(key) ?? fallback, update: async (key, value) => state.set(key, value) } };
class MarkdownString { appendText() { return this; } appendMarkdown() { return this; } }
const vscode = { Position, Range, Selection, MarkdownString, ThemeColor: class { constructor(id) { this.id = id; } }, TextEditorRevealType: { InCenterIfOutsideViewport: 0 },
  commands: { async executeCommand(command) { assert.equal(command, 'vscode.diff'); diffCalls++; } },
  Uri: { parse: uri, joinPath: (base, ...parts) => `${base}/${parts.join('/')}` },
  window: { visibleTextEditors: [editor], createTextEditorDecorationType: () => ({ dispose() {} }),
    showTextDocument: async () => editor }, workspace: { openTextDocument: async () => document } };
const sandbox = { require: name => name === 'vscode' ? vscode : require(name), exports: {}, module: { exports: {} }, console, setTimeout, clearTimeout };
vm.createContext(sandbox);
vm.runInContext(source + '\nexports.pdfHtml=pdfHtml;exports.Controller=ReaderController;exports.PdfReview=PdfReview;', sandbox);
const Review = sandbox.exports.PdfReview;
const html = sandbox.exports.pdfHtml({ cspSource: "'self'", asWebviewUri: value => value }, context);
const controller = new sandbox.exports.Controller(context);
controller.review = new Review(controller);
controller.current = { uri: htmlUri, page: 1, volume: { pdfUri, pages: [1, 2] } };
controller.panelPdfUri = pdfUri;
// An uncompressed PDF fixture keeps its OCR text independently inspectable.
const stream = 'BT /F1 16 Tf 40 170 Td (Before RIGHT after.) Tj ET';
const objects = ['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Count 1 /Kids [3 0 R] >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 240] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
  '<< /Type /Font /Subtype /Type1 /BaseFont /Times-Roman >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
let pdf = '%PDF-1.4\n', offsets = [0];
objects.forEach((obj, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${obj}\nendobj\n`; });
const xref = Buffer.byteLength(pdf);
pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n => String(n).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
const mime = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.ttf': 'font/ttf', '.wasm': 'application/wasm' };
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://local');
    if (url.pathname === '/') { res.setHeader('Content-Type', 'text/html'); return res.end(html); }
    if (url.pathname === '/book.pdf') { res.setHeader('Content-Type', 'application/pdf'); return res.end(pdf); }
    if (url.pathname === '/favicon.ico') { res.statusCode = 204; return res.end(); }
    const file = path.join(root, decodeURIComponent(url.pathname));
    assert.ok(file.startsWith(root));
    res.setHeader('Content-Type', mime[path.extname(file)] || 'application/octet-stream');
    res.end(await readFile(file));
  } catch (error) { res.statusCode = 404; res.end(error.message); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await launchBrowser();
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 850 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') console.error(message.text()); });
  const panel = controller.panel = { webview: { postMessage: async message => {
    snapshots.push(message); await page.evaluate(message => window.postMessage(message), message); return true;
  } } };
  controller.ready = true;
  await page.exposeFunction('nativePostMessage', async message => {
    if (message.type.startsWith('review')) await controller.review.handleMessage(message, panel);
    if (message.type === 'ready') {
      await panel.webview.postMessage({ type: 'showPdf', url: `http://127.0.0.1:${server.address().port}/book.pdf`, htmlUri: htmlUri.toString(), fileName: 'Fixture PDF', pageLabel: '1' });
      await controller.review.sendSource();
    }
  });
  await page.addInitScript(() => { window.acquireVsCodeApi = () => ({ getState: () => null, setState() {}, postMessage: message => { void window.nativePostMessage(structuredClone(message)); } }); });
  await page.route('**/monaco/**', route => { throw new Error('Native review must not load Monaco'); });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(() => window.PdfSelection?.viewer?.pdfDocument && document.querySelector('.textLayer span'), null, { timeout: 20000 });
  await page.waitForFunction(() => window.PdfSelection?.locator?.index?.differences?.items?.length, null, { timeout: 15000 });
  await page.evaluate(() => window.PdfReviewProvider.locator.prepareReview({
    type: 'pdf-selection-difference', detail: { editor: window.ReaderUI.getSourceEditor() }
  }));
  assert.equal(await page.locator('.replacement-review:not([hidden])').count(), 0,
    'native selection differences do not open a review popup');
  await page.locator('#tools summary').click();
  await page.getByRole('button', { name: 'PDF 文字差异审阅', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.replacement-review [data-comparison]')?.textContent.includes('WRONG'), null, { timeout: 10000 });
  assert.equal(text, original, 'opening review does not edit native source');
  const popup = page.locator('.replacement-review');
  await popup.locator('[data-apply]').click();
  assert.equal(text, original, 'preview does not edit native source');
  await page.evaluate(() => window.ReaderUI.getSourceEditor().previewReview({ before: window.ReaderUI.getSourceEditor().getValue(), after: '<p>Before RIGHT after.</p>' }));
  for (let i = 0; diffCalls === 0 && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(diffCalls, 1, 'review preview opens the VS Code diff editor');
  assert.equal(text, original, 'native diff leaves source unchanged');
  await popup.locator('[data-save]').click();
  await page.waitForFunction(() => window.ReaderUI.getSourceEditor().getValue().includes('RIGHT'));
  assert.equal(text, '<p>Before RIGHT after.</p>');
  assert.equal(editCalls, 1);
  for (let i = 0; saves === 0 && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(saves, 1);
  // Old native edit requests must not modify a newer source version.
  const oldVersion = version; text += '\n'; version++;
  await controller.review.handleMessage({ type: 'reviewApply', id: 1000, uri: htmlUri.toString(), version: oldVersion,
    source: '<p>Before RIGHT after.</p>', edits: [{ start: 10, end: 15, text: 'STALE' }] }, panel);
  assert.equal(editCalls, 1); assert.equal(saves, 1);
  assert.ok(snapshots.find(message => message.id === 1000 && message.error));
  assert.equal(await page.evaluate(() => window.readerMonaco === window.ReaderUI.getSourceEditor()), true);
  assert.deepEqual(errors, []);
  assert.equal(await page.evaluate(() => typeof window.monaco), 'undefined');
  await page.screenshot({ path: path.join(root, 'test/artifacts/pdf-review.png') });
  console.log('PASS: real PDF + shared review with native preview/edit/save, stale-version rejection.');
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
