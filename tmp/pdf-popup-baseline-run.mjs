import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const fixture = await mkdtemp(path.join(tmpdir(), 'mew-review-'));
const original = Array.from({ length: 45 }, (_, i) => `<p>Paragraph ${i} contains enough surrounding text for contextual mapping.</p>`).join('\n')
  + '\n<p>Before <b>WR</b>ONG &amp; rest after.</p>\n<p>Second WRONG passage.</p>';
const servers = [];
let browser;
async function start(script, port, args) {
  const child = spawn(process.execPath, [script, '-p', String(port), ...args], { windowsHide: true, stdio: 'pipe' });
  servers.push(child);
  let output = ''; child.stdout.on('data', d => output += d); child.stderr.on('data', d => output += d);
  for (let i = 0; i < 80; i++) {
    if (child.exitCode !== null) throw new Error(output);
    try { if ((await fetch(`http://127.0.0.1:${port}/`)).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(output);
}
// Test providers explicitly own their edit behavior and display data.
function installFixtureReview() {
  window.fixtureReview = {
    content(state, item) {
      const edits = item?.options.flatMap(value => value.edits) || [];
      return { message: item?.label || '没有可审阅的差异。', options: item?.options || [],
        range: edits.length ? PdfSelectionDiff.rangeAt(state.model, Math.min(...edits.map(edit => edit.start)), Math.max(...edits.map(edit => edit.end))) : null };
    },
    preview(state, wholeFile) {
      const edits = (wholeFile ? state.items : [state.items[state.position]])
        .flatMap(item => item.options.find(value => value.id === state.choices.get(item.id)).edits);
      return { before: state.source, after: PdfSelectionDiff.previewEdits(state.source, edits), language: state.model.getLanguageId() };
    },
    apply(state, all) {
      const edits = (all ? state.items : [state.items[state.position]])
        .flatMap(item => item.options.find(value => value.id === state.choices.get(item.id)).edits);
      const checked = PdfSelectionDiff.validateEdits(state.source, edits);
      const shift = offset => offset + checked.reduce((sum, edit) => sum + (edit.end <= offset ? edit.text.length - edit.end + edit.start : 0), 0);
      const before = state.items.slice(0, state.position).length;
      const items = all ? [] : state.items.filter((item, at) => at !== state.position).map(item => ({ ...item,
        options: item.options.map(value => ({ ...value, edits: value.edits.map(edit => ({ ...edit, start: shift(edit.start), end: shift(edit.end) })) })) }));
      PdfSelectionDiff.applyEdits(state.editor, state.model, state.version, state.source, edits);
      return { items, source: state.model.getValue(), version: state.model.getVersionId(), position: Math.min(before, Math.max(0, items.length - 1)) };
    }
  };
}
try {
  await mkdir(path.join(fixture, '1'));
  await writeFile(path.join(fixture, 'a.html'), original);
  await writeFile(path.join(fixture, 'b.html'), '<p>No candidates here.</p>');
  await writeFile(path.join(fixture, 'c.html'), '<p>Third WRONG file.</p>');
  await writeFile(path.join(fixture, '1', 'ME01-001.html'), original);
  await writeFile(path.join(fixture, '1', 'ME01-002.html'), '<p>No candidates here.</p>');
  await writeFile(path.join(fixture, '1', 'ME01-003.html'), '<p>Third WRONG file.</p>');
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R 5 0 R 6 0 R] /Count 3 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << >> /Contents 4 0 R >>', '<< /Length 0 >>\nstream\n\nendstream'];
  objects.push(objects[2], objects[2]);
  let pdf = '%PDF-1.4\n'; const offsets = [0];
  for (const [i, object] of objects.entries()) { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; }
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  await writeFile(path.join(fixture, 'blank.pdf'), pdf);
  await writeFile(path.join(fixture, 'config.json'), JSON.stringify({ htmlRoot: '.', pdf: 'blank.pdf', volumes: [{ id: '1', pages: { directory: '1', pattern: '^ME01-(?<page>\\d+)\\.html$' } }] }));
  await start('server.js', 41879, ['-r', fixture]);
  await start('reader-server.js', 41880, ['-c', path.join(fixture, 'config.json')]);
  browser = await chromium.launch({ executablePath: process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: true });
  const errors = [];
  for (const reader of [false, true]) {
    const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
    await page.context().addInitScript(installFixtureReview);
    page.on('pageerror', error => { errors.push(error.message); console.error(error.stack); });
    page.on('console', event => { if (event.type() === 'error') console.error(event.text()); });
    await page.route('**/pdfdiff/pdf-review-provider.js', async route => route.fulfill({ contentType: 'application/javascript', body: await readFile('tmp/pdf-review-provider.before-perf.js', 'utf8') }));
    await page.route('**/pdfdiff/pdf-selection-diff.js', async route => route.fulfill({ contentType: 'application/javascript', body: await readFile('tmp/pdf-selection-diff.before-perf.js', 'utf8') }));
    await page.route('**/api/reader/settings', route => route.fulfill({ json: { diffHighlight: true } }));
    await page.goto(reader ? 'http://127.0.0.1:41880/?volume=1&page=1&mode=source' : 'http://127.0.0.1:41879/?file=a.html');
    await page.waitForFunction(() => (window.mewWorkbench || window.readerMonaco)?.editor.getValue().includes('WRONG'));
    await page.evaluate(() => {
      window.testEditor = (window.mewWorkbench || window.readerMonaco).editor;
      window.testOriginal = testEditor.getValue();
      window.fixtureCalls = 0;
      ReplacementReview.register({ ...fixtureReview, id: 'fixture', label: '格式修订测试', provide({ model, toolbox }) {
        ++window.fixtureCalls;
        const index = toolbox.createLocator().editorSourceIndex(model), items = [];
        for (const match of index.raw.matchAll(/WRONG/g)) items.push({ id: String(items.length), label: '替换错误文字', options: [
          { id: 'replace', label: '改成 <正确> & 𠀀', edits: toolbox.textEdits(index, match.index, match.index + 5, '<正确> & 𠀀') },
          { id: 'keep', label: '保留原文', edits: [] }
        ] });
        return items;
      } });
    });
    // Open through the actual submenu, including the reader's overflow menu.
    if (reader) await page.evaluate(() => document.getElementById('modeBtn').click());
    const summary = page.locator('#replacementMenu > summary');
    if (!await summary.isVisible()) await page.locator('.topActions > summary').click();
    await summary.click();
    await page.getByRole('button', { name: '格式修订测试', exact: true }).click();
    const popup = page.locator('.replacement-review');
    await page.waitForFunction(() => document.querySelector('[data-position]').textContent === '1 / 2');
    if (reader) assert.equal(await page.locator('#sourcePane').isVisible(), true, 'opening review from visual mode switches to synchronized source');
    await page.waitForFunction(() => testEditor.getModel().getValueInRange(testEditor.getSelection()).includes('WR'));
    const bounds = await page.evaluate(() => {
      const box = document.querySelector('.replacement-review').getBoundingClientRect();
      const position = testEditor.getScrolledVisiblePosition(testEditor.getSelection().getStartPosition());
      const top = testEditor.getDomNode().getBoundingClientRect().top + position.top;
      return { above: box.bottom <= top + 1, visible: box.top >= 0 && box.left >= 0 && box.right <= innerWidth && box.bottom <= innerHeight };
    });
    assert.equal(bounds.above, true, 'popup sits above the source highlight when space permits');
    assert.equal(bounds.visible, true);
    await popup.getByRole('button', { name: '下一条', exact: true }).click();
    assert.equal(await popup.locator('[data-position]').textContent(), '2 / 2');
    assert.equal(await page.evaluate(() => testEditor.getModel().getValueInRange(testEditor.getSelection())), 'WRONG', 'navigation selects the exact source field');
    await popup.getByText('保留原文', { exact: true }).click();
    await popup.getByRole('button', { name: '上一条', exact: true }).click();
    await popup.locator('[data-expanded] > summary').click();
    await page.waitForFunction(() => document.querySelector('[data-preview] .monaco-diff-editor'));
    await popup.locator('[data-file]').check();
    await page.waitForFunction(() => monaco.editor.getModels().some(model => model.getValue().includes('&lt;正确&gt; &amp; 𠀀')));
    await popup.locator('[data-all]').click();
    await page.waitForFunction(() => testEditor.getValue().includes('&lt;正确&gt;'));
    assert.equal(await page.evaluate(() => testEditor.getValue()), original.replace('<b>WR</b>ONG', '<b>&lt;正确&gt; &amp; 𠀀</b>'), 'batch preserves tags/entities and respects per-item choices');
    assert.equal(await page.evaluate(() => fixtureCalls), 1, 'batch consumes candidates without calling the provider again');
    await page.evaluate(() => { ReplacementReview.close(); testEditor.trigger('test', 'undo'); });
    assert.equal(await page.evaluate(() => testEditor.getValue()), original, 'the whole batch is one undo step');
    await page.evaluate(() => ReplacementReview.open('fixture'));
    await page.waitForFunction(() => document.querySelector('[data-position]').textContent === '1 / 2');
    await page.evaluate(() => testEditor.executeEdits('test', [{ range: testEditor.getModel().getFullModelRange(), text: testOriginal + '\n<!-- changed -->' }]));
    assert.equal(await popup.locator('[data-apply]').isDisabled(), true, 'external edits invalidate candidates');
    assert.match(await popup.locator('[data-status]').textContent(), /正在自动重新计算/);
    assert.equal(await popup.locator('[data-refresh]').count(), 0);
    await page.waitForFunction(() => !document.querySelector('[data-apply]').disabled);
    await page.evaluate(() => testEditor.updateOptions({ readOnly: true }));
    await popup.locator('[data-apply]').click();
    assert.match(await popup.locator('[data-status]').textContent(), /只读/);
    await page.evaluate(async () => { ReplacementReview.close(); await ReplacementReview.open('fixture'); });
    await page.evaluate(() => {
      const owner = window.mewWorkbench || window.readerMonaco;
      window.savedReviewSave = owner.save; window.blockedReviewSaves = 0;
      owner.save = async () => { ++blockedReviewSaves; return true; };
    });
    await popup.locator('[data-save]').click();
    assert.match(await popup.locator('[data-status]').textContent(), /只读/);
    assert.equal(await page.evaluate(() => blockedReviewSaves), 0, 'failed replacement must not save');
    await page.evaluate(() => { (window.mewWorkbench || window.readerMonaco).save = savedReviewSave; testEditor.updateOptions({ readOnly: false }); ReplacementReview.close(); });
    await page.evaluate(async () => { testEditor.getModel().setValue(testOriginal); await ReplacementReview.open('fixture'); window.callsBeforeApply = fixtureCalls; });
    await popup.locator('[data-apply]').click();
    assert.equal(await popup.locator('[data-position]').textContent(), '1 / 1', 'replacement immediately selects the remaining candidate');
    assert.equal(await page.evaluate(() => testEditor.getModel().getValueInRange(testEditor.getSelection())), 'WRONG', 'remaining coordinates account for tag segments, entities and Unicode');
    const textToSave = original.replace('<b>WR</b>ONG', '<b>&lt;正确&gt; &amp; 𠀀</b>').replace('Second WRONG', 'Second &lt;正确&gt; &amp; 𠀀');
    assert.equal(await popup.locator('[data-save]').textContent(), '替换&保存');
    const savedResponse = page.waitForResponse(response => response.url().includes('/api/') && response.request().method() === (reader ? 'PUT' : 'POST'));
    await popup.locator('[data-save]').click();
    await savedResponse;
    assert.equal(await readFile(path.join(fixture, reader ? '1/ME01-001.html' : 'a.html'), 'utf8'), textToSave, 'popup save writes the current file');
    assert.equal(await popup.isVisible(), true, 'saving keeps review open');
    assert.equal(await popup.locator('[data-position]').textContent(), '0 / 0');
    assert.equal(await popup.locator('[data-save]').isDisabled(), true);
    assert.equal(await page.evaluate(() => fixtureCalls), await page.evaluate(() => callsBeforeApply), 'successive replacements never recompute candidates');
    assert.equal(await page.evaluate(() => testEditor.getValue()), original.replace('<b>WR</b>ONG', '<b>&lt;正确&gt; &amp; 𠀀</b>').replace('Second WRONG', 'Second &lt;正确&gt; &amp; 𠀀'));
    assert.equal(await popup.locator('[data-position]').textContent(), '0 / 0');
    await page.evaluate(() => { ReplacementReview.close(); testEditor.trigger('test', 'undo'); });
    assert.match(await page.evaluate(() => testEditor.getValue()), /Second WRONG/);
    // Candidate navigation stays inside this file and never asks for a global file list.
    await page.evaluate(async () => {
      testEditor.getModel().setValue(testOriginal);
      await ReplacementReview.open('fixture');
      const workspace = window.mewWorkbench || window.readerMonaco;
      window.savedReviewFiles = workspace.reviewFiles;
      window.reviewFileLookups = 0;
      workspace.reviewFiles = () => { ++reviewFileLookups; throw new Error('Unexpected global navigation'); };
    });
    assert.equal(await popup.locator('[data-prev]').isDisabled(), true);
    await popup.locator('[data-next]').click();
    assert.equal(await popup.locator('[data-position]').textContent(), '2 / 2');
    assert.equal(await popup.locator('[data-next]').isDisabled(), true);
    await popup.locator('[data-prev]').click();
    assert.equal(await popup.locator('[data-position]').textContent(), '1 / 2');
    await popup.locator('[data-all]').click();
    assert.equal(await popup.locator('[data-prev]').isDisabled(), true);
    assert.equal(await popup.locator('[data-next]').isDisabled(), true);
    assert.equal(await page.evaluate(() => reviewFileLookups), 0);
    // Manually opening another file closes the old review instead of showing refresh.
    await page.evaluate(async () => {
      testEditor.getModel().setValue(testOriginal);
      await ReplacementReview.open('fixture');
      const workspace = window.mewWorkbench || window.readerMonaco;
      workspace.reviewFiles = savedReviewFiles;
      const scope = await workspace.reviewFiles();
      await scope.open(scope.files[scope.files.indexOf(scope.current) + 1]);
    });
    assert.equal(await popup.isHidden(), true, 'file switching dismisses the old popup');
    assert.match(await page.evaluate(() => testEditor.getValue()), /No candidates/);
    await page.evaluate(() => testEditor.getModel().setValue(testOriginal));
    // Refuse overlapping batch edits atomically; individual options are still valid.
    await page.evaluate(async () => {
      ReplacementReview.register({ ...fixtureReview, id: 'overlap', label: '冲突测试', provide: () => [0, 1].map(i => ({ id: String(i), options: [{ id: 'x', label: '替换', edits: [{ start: i, end: i + 2, text: 'x' }] }] })) });
      await ReplacementReview.open('overlap');
    });
    const beforeOverlap = await page.evaluate(() => testEditor.getValue());
    await popup.locator('[data-all]').click();
    assert.match(await popup.locator('[data-status]').textContent(), /重叠/);
    assert.equal(await page.evaluate(() => testEditor.getValue()), beforeOverlap);
    await page.evaluate(async () => {
      ReplacementReview.register({ id: 'slow', label: '慢比较', provide: () => new Promise(resolve => window.finishSlow = resolve) });
      void ReplacementReview.open('slow'); ReplacementReview.close(); finishSlow([]);
    });
    assert.equal(await popup.isHidden(), true, 'a late result cannot reopen a closed popup');
    console.log(`${reader ? 'reader' : 'index'}: anchored popup, Monaco diff, batch choices, markup/Unicode, undo, stale/readonly/overlap/cancellation passed`);
    if (!reader) {
      // Attach the real PDF integration to a controlled native-text layer.
      await page.evaluate(() => {
        const passage = 'A lengthy introductory passage establishes the source location with unique words. The reading has an X character in the middle. A second lengthy passage completes the unique context for this comparison. The ending contains a Q character for another comparison.';
        testEditor.getModel().setValue('<p>' + passage + '</p>');
        const stage = document.createElement('div'); stage.id = 'testStage';
        stage.style.cssText = 'position:fixed;right:10px;top:400px;width:400px;height:300px;overflow:auto';
        stage.innerHTML = '<div class="pdfViewer"><div class="page" style="position:relative;width:400px;height:300px"><div class="textLayer"><span></span></div></div></div>';
        stage.querySelector('span').textContent = passage.replace('an X', 'an YYYYY').replace('a Q', 'a Z');
        document.body.append(stage);
        const div = stage.querySelector('.page'), text = div.textContent;
        window.mockViewer = { container: stage, viewer: stage.firstChild, currentPageNumber: 1,
          _getVisiblePages: () => ({ views: [{ id: 1 }] }), getPageView: () => ({ div }), eventBus: { on() {}, off() {} },
          pdfDocument: { numPages: 1, async getPage() { return { async getTextContent() { return { items: [{ str: text, transform: [1,0,0,1,0,500], width: 400, height: 20 }] }; } }; } } };
        window.ReaderUI = { getPdfViewer: () => mockViewer };
      });
      await page.addScriptTag({ url: '/pdfdiff/pdf-selection.js' });
      await page.waitForFunction(() => window.PdfSelection);
      await page.evaluate(() => { PdfSelection.attachViewer(mockViewer); PdfSelection.attachEditor(testEditor); });
      try { await page.waitForSelector('.mew-ocr-diff-text', { timeout: 7000 }); }
      catch (error) { console.log(JSON.stringify(await page.evaluate(() => ({ status: PdfSelection.status, available: PdfSelectionDiff.monacoAvailable, value: testEditor.getValue(), marks: testEditor.getModel().getAllDecorations().map(item => ({ range: item.range, options: item.options })), editors: monaco.editor.getEditors().map(editor => ({ value: editor.getValue(), preview: !!editor.getOption(monaco.editor.EditorOption.inDiffEditor) })), scroll: testEditor.getScrollTop(), visible: testEditor.getVisibleRanges() })))); throw error; }
      // ME04-117: selecting or clicking h/H must reach the shared review popup.
      const beforeCase = await page.evaluate(() => {
        const source = testEditor.getValue(), layer = document.querySelector('#testStage .textLayer span');
        const pdf = layer.textContent;
        const passage = 'Ein sozialer Vorteil, gleich 400, stellt für das Individuum, wenn die Gesellschaft nur aus einer Million Menschen besteht.';
        layer.textContent = passage.replace('Gesellschaft', 'GesellscHaft');
        testEditor.setValue('<p>' + passage + '</p>');
        return { source, pdf };
      });
      await page.waitForSelector('.mew-ocr-diff-text');
      await page.evaluate(() => {
        const model = testEditor.getModel(), start = model.getValue().indexOf('Gesellschaft') + 8;
        testEditor.setSelection(PdfSelectionDiff.rangeAt(model, start, start + 1));
      });
      await popup.waitFor({ state: 'visible' });
      assert.deepEqual(await popup.locator('[data-comparison] mark').allTextContents(), ['h', 'H']);
      await page.evaluate(() => ReplacementReview.close());
      await page.locator('.mew-ocr-diff-text').click();
      await popup.waitFor({ state: 'visible' });
      assert.deepEqual(await popup.locator('[data-comparison] mark').allTextContents(), ['h', 'H']);
      await popup.locator('[data-apply]').click();
      assert.match(await page.evaluate(() => testEditor.getValue()), /GesellscHaft/);
      await page.evaluate(({ source, pdf }) => {
        ReplacementReview.close();
        document.querySelector('#testStage .textLayer span').textContent = pdf;
        testEditor.setValue(source);
      }, beforeCase);
      await page.waitForSelector('.mew-ocr-diff-text');
      const drag = await page.evaluate(() => {
        ReplacementReview.close();
        const model = testEditor.getModel(), at = model.getValue().indexOf('an X') + 3;
        testEditor.revealPositionInCenter(model.getPositionAt(at));
        const box = testEditor.getDomNode().getBoundingClientRect();
        const point = offset => {
          const position = testEditor.getScrolledVisiblePosition(model.getPositionAt(offset));
          return { x: box.left + position.left, y: box.top + position.top + position.height / 2 };
        };
        return { start: point(at + 12), middle: point(at), end: point(at - 12), anchor: at + 12 };
      });
      await page.mouse.move(drag.start.x, drag.start.y);
      await page.mouse.down();
      await page.mouse.move(drag.middle.x, drag.middle.y, { steps: 12 });
      await page.waitForTimeout(250);
      assert.equal(await popup.isHidden(), true, 'crossing a diff during backward dragging does not open review');
      await page.mouse.move(drag.end.x, drag.end.y, { steps: 12 });
      await page.waitForTimeout(250);
      assert.equal(await page.evaluate(() => testEditor.getModel().getOffsetAt(testEditor.getSelection().getSelectionStart())), drag.anchor,
        'backward dragging retains the original selection anchor across the diff');
      assert.equal(await popup.isHidden(), true, 'review waits until the mouse is released');
      await page.mouse.up();
      await page.waitForFunction(() => !document.querySelector('.replacement-review').hidden && !document.querySelector('[data-apply]').disabled);
      await page.evaluate(() => {
        ReplacementReview.close();
        const model = testEditor.getModel();
        testEditor.setPosition(model.getPositionAt(3));
        testEditor.revealPositionInCenter(model.getPositionAt(model.getValue().indexOf('an X') + 3));
      });
      await page.waitForTimeout(150);
      const fromDiff = await page.evaluate(() => {
        const model = testEditor.getModel(), start = model.getValue().indexOf('an X') + 3;
        const end = model.getValue().indexOf('a Q') + 3;
        const box = testEditor.getDomNode().getBoundingClientRect();
        const point = offset => {
          const position = testEditor.getScrolledVisiblePosition(model.getPositionAt(offset));
          return { x: box.left + position.left, y: box.top + position.top + position.height / 2 };
        };
        return { start: point(start), end: point(end), text: model.getValue().slice(start, end), anchor: start };
      });
      await page.mouse.move(fromDiff.start.x, fromDiff.start.y);
      await page.mouse.down();
      await page.waitForTimeout(250);
      assert.equal(await popup.isHidden(), true, 'pressing a diff leaves the user free to start selecting');
      await page.mouse.move(fromDiff.end.x, fromDiff.end.y, { steps: 20 });
      await page.waitForTimeout(250);
      assert.equal(await popup.isHidden(), true, 'dragging from a diff waits for the whole selection');
      await page.mouse.up();
      await page.waitForTimeout(250);
      assert.equal(await page.evaluate(() => testEditor.getModel().getValueInRange(testEditor.getSelection())), fromDiff.text,
        'dragging from a diff preserves the whole selected passage');
      await page.evaluate(() => ReplacementReview.close());
      await page.locator('.mew-ocr-diff-text').first().click();
      try { await page.waitForFunction(() => !document.querySelector('.replacement-review').hidden && document.querySelector('[data-title]').textContent === 'PDF 文字差异审阅' && !document.querySelector('[data-apply]').disabled); } catch (error) { console.log(await popup.textContent()); throw error; }
      assert.equal(await popup.getAttribute('widgetid'), 'mew.replacement-review', 'source click opens the shared native Monaco content widget');
      assert.equal(await page.evaluate(() => testEditor.getModel().getValueInRange(testEditor.getSelection())), 'X');
      assert.equal(await page.locator('.mew-pdf-selection-difference').count(), 0, 'no separate PDF popup is constructed');
      assert.deepEqual(await popup.locator('[data-comparison] mark').allTextContents(), ['X', 'YYYYY']);
      const light = await popup.evaluate(node => getComputedStyle(node).backgroundColor);
      await page.evaluate(() => document.body.classList.add('dark'));
      assert.notEqual(await popup.evaluate(node => getComputedStyle(node).backgroundColor), light);
      await page.evaluate(() => document.body.classList.remove('dark'));
      if (process.env.REVIEW_SCREENSHOT) await page.screenshot({ path: process.env.REVIEW_SCREENSHOT });
      await page.evaluate(() => { ReplacementReview.close(); window.dispatchEvent(new Event('resize')); });
      await page.waitForTimeout(150);
      assert.equal(await popup.isHidden(), true, 'layout changes cannot reopen a dismissed review');
      await page.locator('.mew-ocr-diff-text').first().click();
      await popup.waitFor({ state: 'visible' });
      assert.equal(await popup.locator('[data-position]').textContent(), '1 / 2');
      await popup.locator('[data-next]').click();
      assert.equal(await page.evaluate(() => testEditor.getModel().getValueInRange(testEditor.getSelection())), 'Q');
      assert.deepEqual(await popup.locator('[data-comparison] mark').allTextContents(), ['Q', 'Z']);
      await popup.locator('[data-prev]').click();
      await page.evaluate(() => ReplacementReview.close());
      await page.evaluate(() => {
        window.fullSelection = testEditor.getValue().slice(3, -4);
        const model = testEditor.getModel();
        testEditor.setSelection(PdfSelectionDiff.rangeAt(model, 3, model.getValueLength() - 4));
      });
      await page.waitForFunction(() => !document.querySelector('.replacement-review').hidden && !document.querySelector('[data-apply]').disabled);
      assert.equal(await page.evaluate(() => testEditor.getModel().getValueInRange(testEditor.getSelection())),
        await page.evaluate(() => fullSelection), 'a mismatching passage keeps the whole HTML selection');
      assert.deepEqual(await popup.locator('[data-comparison] mark').allTextContents(), ['X', 'Q', 'YYYYY', 'Z'],
        'the selection popup marks every mismatch, including distant differences');
      assert.equal(await popup.locator('[data-comparison] > *').first().textContent(),
        'HTML: ' + await page.evaluate(() => fullSelection), 'the popup retains all matching context without truncation');
      await popup.locator('[data-apply]').click();
      assert.match(await page.evaluate(() => testEditor.getValue()), /an YYYYY.*a Z/,
        'replacement applies all differences in the selected passage');
      await page.evaluate(() => { ReplacementReview.close(); testEditor.trigger('test', 'undo'); });
      assert.match(await page.evaluate(() => testEditor.getValue()), /an X.*a Q/, 'selection replacement is one undoable edit');
      await page.evaluate(() => {
        document.getElementById('testStage').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
        const text = document.querySelector('#testStage .textLayer span').firstChild, at = text.textContent.indexOf('an Y') + 3;
        const range = document.createRange(); range.setStart(text, at); range.setEnd(text, at + 1);
        const selected = document.getSelection(); selected.removeAllRanges(); selected.addRange(range);
        document.getElementById('testStage').dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
      });
      await page.waitForFunction(() => !document.querySelector('.replacement-review').hidden && !document.querySelector('[data-apply]').disabled);
      assert.equal(await popup.getAttribute('widgetid'), 'mew.replacement-review', 'PDF selection opens the same native source widget');
      assert.equal(await page.evaluate(() => testEditor.getModel().getValueInRange(testEditor.getSelection())), 'X');
      assert.equal(await popup.locator('[data-expanded]').isHidden(), true, 'compact PDF review hides expanded preview');
      await page.evaluate(() => {
        window.reviewCalls = 0; window.reviewScopes = [];
        const original = PdfSelectionDiff.reviewCandidates;
        PdfSelectionDiff.reviewCandidates = (...args) => { ++reviewCalls; reviewScopes.push(args[1]?.length || 0); return original(...args); };
      });
      await popup.locator('[data-apply]').click();
      await page.waitForFunction(() => testEditor.getValue().includes('an Y'));
      assert.equal(await popup.locator('[data-position]').textContent(), '1 / 2',
        'recomputation discovers the four missing Ys after replacing X with a selected single Y');
      assert.ok(await page.evaluate(() => reviewCalls) > 0);
      await popup.locator('[data-apply]').click();
      await page.waitForFunction(() => testEditor.getValue().includes('an YYYYY'));
      assert.equal(await popup.locator('[data-position]').textContent(), '1 / 1');
      assert.equal(await page.evaluate(() => testEditor.getModel().getValueInRange(testEditor.getSelection())), 'Q');
      const refreshedCalls = await page.evaluate(() => reviewCalls);
      await page.waitForTimeout(400);
      assert.equal(await page.evaluate(() => reviewCalls), refreshedCalls, 'selection feedback does not restart candidate calculation');
      await popup.locator('[data-apply]').click();
      assert.match(await page.evaluate(() => testEditor.getValue()), /a Z character/);
      for (let i = 0; i < 3; i++)
        await page.evaluate(() => { ReplacementReview.close(); testEditor.trigger('test', 'undo'); });
      assert.match(await page.evaluate(() => testEditor.getValue()), /an X/);
      await page.evaluate(async () => {
        await ReplacementReview.open('pdf-ocr');
        window.manualExtractions = 0;
        const getPage = mockViewer.pdfDocument.getPage.bind(mockViewer.pdfDocument);
        mockViewer.pdfDocument.getPage = (...args) => { ++manualExtractions; return getPage(...args); };
        window.manualCalculations = reviewCalls;
        window.manualOriginal = testEditor.getValue();
        testEditor.focus();
      });
      // Clicking the highlighted difference allows manual editing with review open.
      const point = await page.evaluate(() => {
        const pos = testEditor.getScrolledVisiblePosition(testEditor.getSelection().getStartPosition());
        const box = testEditor.getDomNode().getBoundingClientRect();
        return { x: box.left + pos.left + 2, y: box.top + pos.top + pos.height / 2 };
      });
      await page.mouse.click(point.x, point.y);
      assert.equal(await popup.isVisible(), true, 'clicking the highlighted difference keeps review open');
      await page.evaluate(() => testEditor.setSelection(PdfSelectionDiff.rangeAt(testEditor.getModel(), manualOriginal.indexOf('X'), manualOriginal.indexOf('X') + 1)));
      await page.keyboard.insertText('Y');
      await page.keyboard.insertText('YYYY');
      const insertionCaret = await page.evaluate(() => testEditor.getPosition());
      assert.equal(await popup.isVisible(), true, 'manual typing keeps review open');
      await page.waitForFunction(() => document.querySelector('[data-position]').textContent === '1 / 1' && !document.querySelector('[data-apply]').disabled);
      assert.equal(await page.evaluate(() => testEditor.getSelection().isEmpty()), true, 'refresh after insertion keeps the caret collapsed');
      assert.deepEqual(await page.evaluate(() => testEditor.getPosition()), insertionCaret, 'refresh after insertion preserves the caret position');
      const deletionCalculations = await page.evaluate(() => reviewCalls);
      await page.keyboard.press('Backspace');
      const deletionCaret = await page.evaluate(() => testEditor.getPosition());
      await page.waitForFunction(before => reviewCalls > before && !document.querySelector('[data-status]').textContent.includes('正在自动重新计算'), deletionCalculations);
      assert.equal(await page.evaluate(() => testEditor.getSelection().isEmpty()), true, 'refresh after deletion keeps the caret collapsed');
      assert.deepEqual(await page.evaluate(() => testEditor.getPosition()), deletionCaret, 'refresh after deletion preserves the caret position');
      await page.keyboard.insertText('Y');
      await page.waitForFunction(() => document.querySelector('[data-position]').textContent === '1 / 1' && !document.querySelector('[data-apply]').disabled);
      assert.equal(await popup.locator('[data-save]').textContent(), '保存修改');
      assert.match(await popup.locator('[data-status]').textContent(), /请保存/);
      assert.equal(await page.evaluate(() => manualExtractions), 0);
      assert.ok(await page.evaluate(() => reviewCalls - manualCalculations) > 0, 'manual edits rediscover differences');
      const manuallyRevised = await page.evaluate(() => testEditor.getValue());
      await popup.locator('[data-save]').click();
      await page.waitForFunction(() => document.querySelector('[data-save]').textContent === '替换&保存');
      assert.equal(await page.evaluate(() => testEditor.getValue()), manuallyRevised, 'saving manual edits does not replace the next difference');
      assert.equal(await readFile(path.join(fixture, 'b.html'), 'utf8'), manuallyRevised);
      await page.locator('#testStage').dispatchEvent('pointerdown', { button: 0 });
      assert.equal(await popup.isHidden(), true, 'clicking elsewhere still dismisses review');
      await page.evaluate(() => testEditor.getModel().setValue(manualOriginal));
      assert.equal(await page.locator('#replacementFeatures button').filter({ hasText: 'PDF 文字差异' }).count(), 1);
      await page.evaluate(async () => { await ReplacementReview.open('pdf-ocr'); PdfSelection.setDiffHighlight(false); });
      await popup.waitFor({ state: 'visible' });
      assert.equal(await popup.isVisible(), true, 'disabling the independent selection module leaves review open');
      assert.equal(await popup.locator('[data-apply]').isEnabled(), true);
      await page.evaluate(async () => { PdfSelection.stop(); await ReplacementReview.open('pdf-ocr'); });
      assert.equal(await popup.locator('[data-apply]').isEnabled(), true, 'review works even after the selection module stops');
      await page.evaluate(() => { mockViewer.pdfDocument = {}; ReplacementReview.invalidate('pdf-ocr'); });
      assert.equal(await popup.locator('[data-apply]').isDisabled(), true);
      console.log('PDF integration: independent selection module, selected review fields, PDF popup, file diff and replacement/undo passed');
    }
    if (reader) {
      await page.evaluate(() => testEditor.getModel().setValue(testOriginal));
      const split = page.locator('#splitViewBtn');
      if (!await split.isVisible()) await page.locator('.topActions > summary').click();
      const opened = page.waitForEvent('popup');
      await split.click();
      const child = await opened;
      child.on('pageerror', error => errors.push(error.message));
      await child.waitForFunction(() => window.mewWorkbench?.editor.getModel());
      await child.waitForFunction(() => document.querySelector('input[aria-label="启用PDF 与源码选区联动"]')?.disabled === false);
      await child.evaluate(async () => {
        const editor = mewWorkbench.editor, model = editor.getModel(), index = PdfSelectionDiff.createLocator().editorSourceIndex(model);
        const start = index.raw.lastIndexOf('WRONG');
        opener.dispatchEvent(new opener.CustomEvent('pdf-selection-difference', { detail: {
          editor, model, pdf: opener.ReaderUI.getPdfViewer().pdfDocument, targets: [],
          notices: [{ html: 'WRONG', pdf: 'RIGHT', source: { index, start, end: start + 5 } }]
        } }));
      });
      await child.waitForFunction(() => !document.querySelector('.replacement-review').hidden && !document.querySelector('[data-apply]').disabled);
      assert.equal(await child.locator('.replacement-review').getAttribute('widgetid'), 'mew.replacement-review');
      assert.equal(await page.locator('.replacement-review').isHidden(), true, 'reader-origin difference opens only in the owning editor window');
      const pageCount = page.context().pages().length;
      const comparisonBeforeSwitch = await child.locator('.replacement-review [data-comparison] > div').allTextContents();
      await child.evaluate(() => {
        const open = window.open;
        window.reviewWindowTargets = [];
        window.open = function(url, name, ...args) {
          reviewWindowTargets.push({ url, name, reader: name === opener.name });
          return open.call(this, url, name, ...args);
        };
      });
      await child.locator('.replacement-review [data-switch]').click();
      await page.locator('.replacement-review').waitFor({ state: 'visible' });
      assert.equal(await child.locator('.replacement-review').isHidden(), true);
      assert.deepEqual(await child.evaluate(() => reviewWindowTargets), [{ url: '', name: await page.evaluate(() => window.name), reader: true }], 'View PDF re-selects the existing reader window during the click');
      assert.equal(await page.locator('.replacement-review').getAttribute('data-side'), 'pdf');
      assert.deepEqual(await page.locator('.replacement-review [data-comparison] > div').allTextContents(), comparisonBeforeSwitch);
      await page.locator('.replacement-review [data-switch]').click();
      await child.locator('.replacement-review').waitFor({ state: 'visible' });
      assert.equal(await page.locator('.replacement-review').isHidden(), true);
      assert.equal(page.context().pages().length, pageCount, 'switching sides reuses both windows');
      await child.evaluate(async () => {
        ReplacementReview.register({ ...fixtureReview, id: 'split-fixture', label: '独立窗测试', provide({ source }) {
          const start = source.lastIndexOf('WRONG');
          return [{ id: 'word', options: [{ id: 'fix', label: '替换', edits: [{ start, end: start + 5, text: 'RIGHT' }] }] }];
        } });
        await ReplacementReview.open('split-fixture');
      });
      assert.equal(await child.evaluate(() => mewWorkbench.editor.getModel().getValueInRange(mewWorkbench.editor.getSelection())), 'WRONG');
      await child.locator('.replacement-review').waitFor({ state: 'visible' });
      assert.equal(await child.locator('.replacement-review').isVisible(), true);
      await page.evaluate(() => PdfSelection.stop());
      await child.waitForFunction(() => document.querySelector('input[aria-label="启用PDF 与源码选区联动"]')?.disabled === true);
      assert.equal(await child.locator('.replacement-review [data-apply]').isEnabled(), true, 'split-window review remains independent of the reader selection module');
      await child.evaluate(() => ReplacementReview.close());
      await child.close();
      console.log('split window: editor-owned popup and source selection, reader module control, independent lifecycle passed');
    }
    await page.close();
  }
  assert.deepEqual(errors, []);
} finally {
  await browser?.close();
  servers.forEach(server => server.kill());
  await rm(fixture, { recursive: true, force: true });
}
