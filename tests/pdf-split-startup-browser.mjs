import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { launchBrowser, startServer, stopServer } from './support/browser.mjs';

const fixture = await mkdtemp(path.join(tmpdir(), 'mew-split-startup-'));
let server, browser;
try {
  await mkdir(path.join(fixture, '32'));
  const text = 'This passage has enough unchanged context to locate its text on the scanned page. The original word differs here. Another sentence supplies the ending context for comparison.';
  await writeFile(path.join(fixture, '32/ME32-151.html'), `<p>${text.replace('original', 'corrected')}</p>`);
  execFileSync('python', ['-c', 'import pymupdf,sys; d=pymupdf.open(); p=d.new_page(); p.insert_textbox(p.rect+(40,40,-40,-40), sys.argv[2]); d.set_page_labels([dict(startpage=0,style="D",firstpagenum=151)]); d.save(sys.argv[1])', path.join(fixture, 'scan.pdf'), text]);
  await writeFile(path.join(fixture, 'config.json'), JSON.stringify({ volumes: [
    { id: '32', pdf: 'scan.pdf', pages: { directory: '32', pattern: '^ME32-([0-9]+)[.]html$' } }
  ] }));
  server = await startServer('reader-server.js', 41895, ['-c', path.join(fixture, 'config.json')]);
  browser = await launchBrowser();
  const context = await browser.newContext();
  await context.route('**/api/reader/settings', route => route.fulfill({ json: {
    splitView: true, diffHighlight: true, sourceDiffHighlight: true, selectionHighlight: true,
    italicDetection: false, boldDetection: false
  } }));
  await context.addInitScript(() => {
    const OriginalEventSource = window.EventSource;
    window.EventSource = class extends OriginalEventSource {
      constructor(...args) { super(...args); window.directoryEvents = this; }
    };
  });
  const reader = await context.newPage();
  const errors = [];
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  const popup = reader.waitForEvent('popup');
  await reader.goto('http://127.0.0.1:41895/reader.html?volume=32&page=151&mode=source');
  const editor = await popup;
  await editor.waitForFunction(() => window.mewWorkbench?.editor.getModel());
  const pdfMarks = () => reader.locator('.mew-pdf-default-highlight > div').count();
  const sourceMarks = () => editor.evaluate(() => mewWorkbench.editor.getModel().getAllDecorations()
    .filter(mark => /PDF.*difference/.test(mark.options.description)).length);
  await reader.waitForFunction(() => document.querySelector('.mew-pdf-default-highlight > div'));
  assert.ok(await sourceMarks());
  for (const event of ['ready', 'rename']) {
    await reader.evaluate(event => directoryEvents.onmessage({ data: JSON.stringify({ event }) }), event);
    await reader.waitForTimeout(800);
    assert.equal(await reader.evaluate(() => !!PdfSelection.editor), true, `${event}: retain the paired model`);
    assert.ok(await pdfMarks(), `${event}: keep PDF highlights without navigation`);
    assert.ok(await sourceMarks(), `${event}: keep source highlights without navigation`);
  }
  await reader.reload();
  await reader.waitForTimeout(1200);
  await reader.waitForFunction(() => document.querySelector('.mew-pdf-default-highlight > div'));
  assert.ok(await sourceMarks(), 'reload restores source highlights in the existing editor');
  assert.equal(context.pages().length, 2, 'reload reuses the paired editor');
  assert.deepEqual(errors, []);
  console.log('Split startup: directory ready/rename and reader reload preserve both highlights without navigation.');
} finally {
  await browser?.close();
  await stopServer(server);
  if (path.dirname(fixture) === path.resolve(tmpdir()) && path.basename(fixture).startsWith('mew-split-startup-')) await rm(fixture, { recursive: true, force: true });
}
