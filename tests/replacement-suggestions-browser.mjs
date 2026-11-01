import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchBrowser, startServer, stopServer } from './support/browser.mjs';

const fixture = await mkdtemp(path.join(tmpdir(), 'mew-suggestions-'));
let server, browser;
try {
  await writeFile(path.join(fixture, 'a.html'), '<p>WRONG</p>');
  server = await startServer('server.js', 41887, ['-r', fixture]);
  browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://127.0.0.1:41887/?file=a.html');
  await page.waitForFunction(() => window.mewWorkbench?.editor && window.PdfSelectionDiff && window.ReplacementReview);
  await page.evaluate(async () => {
    const node = document.createElement('div');
    node.style.cssText = 'position:fixed;inset:100px 0 0;background:white;z-index:10000';
    document.body.append(node);
    window.suggestionEditor = monaco.editor.create(node, { value: '  WRONG tail', language: 'html', quickSuggestions: false });
    const registerAction = monaco.languages.registerCodeActionProvider;
    const registerCompletion = monaco.languages.registerCompletionItemProvider;
    monaco.languages.registerCodeActionProvider = (...args) => { window.actionProvider = args[1]; return registerAction(...args); };
    monaco.languages.registerCompletionItemProvider = (...args) => { window.completionProvider = args[1]; return registerCompletion(...args); };
    window.plans = model => {
      const match = /WRONGx?/.exec(model.getValue());
      return !match ? [] : [{ label: `${match[0]} → RIGHT`, edits: [{ start: match.index, end: match.index + match[0].length, expected: match[0], text: 'RIGHT' }] }];
    };
    ReplacementReview.bindSuggestions(suggestionEditor, plans);
    monaco.languages.registerCodeActionProvider = registerAction;
    monaco.languages.registerCompletionItemProvider = registerCompletion;
    ReplacementReview.register({ id: 'suggestion-test', label: 'Test',
      provide: ({ model }) => plans(model).map((value, i) => ({ id: String(i), options: [{ id: 'replace', ...value }] })),
      content: (state, item) => ({ range: item && PdfSelectionDiff.rangeAt(state.context.model, 2, 7) }) });
    localStorage.setItem('mew-review-preview', 'false');
    suggestionEditor.setPosition({ lineNumber: 1, column: 3 });
    suggestionEditor.focus();
  });
  await page.waitForTimeout(400);
  assert.equal(await page.locator('.suggest-widget.visible').count(), 0, 'cursor entry does not open suggestions');
  const initial = await page.evaluate(() => {
    const model = suggestionEditor.getModel();
    const at = column => new monaco.Range(1, column, 1, column);
    return { before: completionProvider.provideCompletionItems(model, at(3).getStartPosition()).suggestions.length,
      after: completionProvider.provideCompletionItems(model, at(8).getStartPosition()).suggestions.length,
      away: completionProvider.provideCompletionItems(model, at(11).getStartPosition()).suggestions.length,
      actions: actionProvider.provideCodeActions(model, at(3)).actions.length };
  });
  assert.deepEqual(initial, { before: 1, after: 1, away: 0, actions: 1 });
  const reads = await page.evaluate(() => {
    const model = suggestionEditor.getModel(), getValue = model.getValue;
    const values = [{ edits: [{ start: 2, end: 7, expected: 'WRONG', text: 'RIGHT' }] },
      { edits: [{ start: 2, end: 7, expected: 'WRONG', text: 'OTHER' }] }];
    ReplacementReview.bindSuggestions(suggestionEditor, () => values);
    let count = 0;
    model.getValue = function(...args) { count++; return getValue.apply(this, args); };
    try {
      const completions = completionProvider.provideCompletionItems(model, { lineNumber: 1, column: 4 }).suggestions;
      const completion = count;
      count = 0;
      const actions = actionProvider.provideCodeActions(model, new monaco.Range(1, 4, 1, 4)).actions;
      return { completion, action: count, texts: completions.map(value => value.insertText), actions: actions.length };
    } finally { model.getValue = getValue; ReplacementReview.bindSuggestions(suggestionEditor, plans); }
  });
  assert.deepEqual(reads, { completion: 1, action: 1, texts: ['RIGHT', 'OTHER'], actions: 2 }, 'each request reads one source snapshot for all candidates');
  assert.equal(await page.evaluate(() => actionProvider.provideCodeActions(
    suggestionEditor.getModel(), new monaco.Range(1, 3, 1, 3)).actions[0].title), 'RIGHT');
  await page.evaluate(() => suggestionEditor.setPosition({ lineNumber: 1, column: 8 }));
  await page.keyboard.type('x');
  await page.waitForSelector('.suggest-widget.visible');
  assert.match(await page.locator('.suggest-widget.visible').innerText(), /RIGHT/);
  await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => suggestionEditor.getValue()), '  RIGHT tail', 'completion replaces the pattern');
  const excluded = await page.evaluate(() => {
    const count = () => completionProvider.provideCompletionItems(suggestionEditor.getModel(), { lineNumber: 1, column: 2 }).suggestions.length;
    suggestionEditor.setValue('WRONG\ntail');
    ReplacementReview.bindSuggestions(suggestionEditor, () => [{ label: 'multiline', edits: [{ start: 0, end: 10, text: 'RIGHT' }] }]);
    const sourceNewline = count();
    suggestionEditor.setValue('WRONG');
    ReplacementReview.bindSuggestions(suggestionEditor, () => [{ label: 'multiline', edits: [{ start: 0, end: 5, text: 'RIGHT\nnext' }] }]);
    const targetNewline = count();
    suggestionEditor.setValue('<b>teWR</b>rm');
    ReplacementReview.bindSuggestions(suggestionEditor, () => [{ label: 'pattern', range: { start: 3, end: 13 },
      edits: [{ start: 5, end: 6, expected: 'W', text: '' }] }]);
    const completion = completionProvider.provideCompletionItems(suggestionEditor.getModel(), { lineNumber: 1, column: 6 }).suggestions[0];
    suggestionEditor.executeEdits('test', [{ range: completion.range, text: completion.insertText }]);
    const taggedPattern = suggestionEditor.getValue();
    suggestionEditor.setValue('prefix A middle B suffix');
    ReplacementReview.bindSuggestions(suggestionEditor, () => [{ label: 'multiple', range: { start: 0, end: 24 },
      edits: [{ start: 16, end: 17, text: '' }, { start: 7, end: 8, text: '𠀀LONG' }] }]);
    const multiple = completionProvider.provideCompletionItems(suggestionEditor.getModel(), { lineNumber: 1, column: 8 }).suggestions[0];
    suggestionEditor.executeEdits('test', [{ range: multiple.range, text: multiple.insertText }]);
    const multiplePattern = suggestionEditor.getValue();
    ReplacementReview.bindSuggestions(suggestionEditor, plans);
    suggestionEditor.setValue('  WRONG tail');
    return { sourceNewline, targetNewline, taggedPattern, multiplePattern };
  });
  assert.deepEqual(excluded, { sourceNewline: 0, targetNewline: 0, taggedPattern: '<b>teR</b>rm', multiplePattern: 'prefix 𠀀LONG middle  suffix' });
  const selectionActions = await page.evaluate(() => {
    suggestionEditor.setValue('intro\n  WRONG tail\nending');
    const model = suggestionEditor.getModel();
    const paragraph = actionProvider.provideCodeActions(model, new monaco.Range(1, 1, 3, 7)).actions.length;
    const unrelated = actionProvider.provideCodeActions(model, new monaco.Range(3, 1, 3, 7)).actions.length;
    suggestionEditor.setValue('  WRONG tail');
    return { paragraph, unrelated };
  });
  assert.deepEqual(selectionActions, { paragraph: 1, unrelated: 0 }, 'paragraph selections expose only applicable replacements');
  await page.evaluate(() => {
    suggestionEditor.setSelection(new monaco.Selection(1, 3, 1, 8)); suggestionEditor.focus();
  });
  const lightbulb = page.locator('.lightBulbWidget:visible, .codicon-gutter-lightbulb:visible').first();
  await lightbulb.waitFor({ state: 'visible' });
  assert.equal(await page.locator('.replacement-review').isVisible(), false, 'selection lightbulb works without opening preview');
  await lightbulb.click();
  await page.waitForSelector('.action-widget');
  assert.equal(await page.locator('.action-widget .group-header').first().innerText(), '替换与预览');
  const selectedAction = page.locator('.action-widget:not(.action-list-submenu-panel)').getByText('RIGHT', { exact: true }).first();
  assert.equal(await page.locator('.action-widget:not(.action-list-submenu-panel)').getByText('RIGHT', { exact: true }).count(), 1, 'one entry per replacement');
  const selectedBox = await selectedAction.boundingBox();
  await page.mouse.move(selectedBox.x + selectedBox.width / 2, selectedBox.y + selectedBox.height / 2);
  await page.waitForFunction(() => !!document.querySelector('.mew-review-proposed'));
  assert.equal(await page.evaluate(() => suggestionEditor.getValue()), '  WRONG tail', 'hover previews without applying');
  assert.equal(await page.locator('.action-widget:not(.action-list-submenu-panel)').isVisible(), true, 'hover keeps the menu open');
  await page.mouse.move(1390, 890);
  await page.waitForFunction(() => !document.querySelector('.mew-review-current, .mew-review-proposed'));
  await page.mouse.move(selectedBox.x + selectedBox.width / 2, selectedBox.y + selectedBox.height / 2);
  await page.waitForSelector('.mew-review-proposed');
  await page.keyboard.press('Control+Enter');
  await page.waitForFunction(() => !!document.querySelector('.mew-review-proposed'));
  assert.equal(await page.evaluate(() => suggestionEditor.getValue()), '  WRONG tail', 'native Preview highlights without applying');
  assert.equal(await page.locator('.replacement-review').isVisible(), false, 'native Preview reuses highlights without opening a popup');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('.mew-review-current, .mew-review-proposed'));
  await page.evaluate(() => suggestionEditor.trigger('test', 'editor.action.quickFix', {}));
  const previewAction = page.locator('.action-widget:not(.action-list-submenu-panel)').getByText('RIGHT', { exact: true });
  await previewAction.waitFor();
  const previewBox = await previewAction.boundingBox();
  await page.mouse.move(previewBox.x + previewBox.width / 2, previewBox.y + previewBox.height / 2);
  await page.waitForFunction(() => !!document.querySelector('.mew-review-proposed'));
  assert.equal(await page.evaluate(() => suggestionEditor.getValue()), '  WRONG tail', 'hovering again previews without applying');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('.mew-review-current, .mew-review-proposed'));
  await page.evaluate(() => ReplacementReview.bindSuggestions(suggestionEditor, model => [
    ...plans(model), { label: 'alternative', edits: [{ start: 2, end: 7, expected: 'WRONG', text: 'OTHER' }] }
  ]));
  await page.evaluate(() => suggestionEditor.trigger('test', 'editor.action.quickFix', {}));
  const otherAction = page.locator('.action-widget:not(.action-list-submenu-panel)').getByText('OTHER', { exact: true }).first();
  await otherAction.waitFor();
  const otherBox = await otherAction.boundingBox();
  await page.mouse.move(otherBox.x + otherBox.width / 2, otherBox.y + otherBox.height / 2);
  await page.waitForFunction(() => [...document.querySelectorAll('.mew-review-proposed')].map(node => node.textContent).join('')
    === PdfSelectionDiff.textDiff('WRONG', 'OTHER', true).parts.filter(part => part.changed).map(part => part.pdf).join(''));
  assert.equal(await page.evaluate(() => suggestionEditor.getValue()), '  WRONG tail', 'Preview uses the hovered candidate without modifying the source');
  await page.keyboard.press('Escape');
  await page.evaluate(() => ReplacementReview.bindSuggestions(suggestionEditor, plans));
  await page.evaluate(() => suggestionEditor.trigger('test', 'editor.action.quickFix', {}));
  await selectedAction.waitFor();
  const reopenedBox = await selectedAction.boundingBox();
  await page.mouse.move(reopenedBox.x + reopenedBox.width / 2, reopenedBox.y + reopenedBox.height / 2);
  await selectedAction.click();
  await page.waitForFunction(() => suggestionEditor.getValue() === '  RIGHT tail');
  await page.evaluate(() => suggestionEditor.trigger('test', 'undo', {}));
  await page.waitForFunction(() => suggestionEditor.getValue() === '  WRONG tail');
  await page.evaluate(async () => { await ReplacementReview.open('suggestion-test', suggestionEditor); });
  await page.locator('[data-apply]').click();
  await page.evaluate(() => { suggestionEditor.setPosition({ lineNumber: 1, column: 4 }); suggestionEditor.focus(); });
  await page.waitForFunction(() => [...document.querySelectorAll('.lightBulbWidget, .codicon-gutter-lightbulb')].some(node => node.getBoundingClientRect().width > 0));
  await mkdir('tmp/replacement-suggestions', { recursive: true });
  await page.screenshot({ path: 'tmp/replacement-suggestions/lightbulb.png', clip: { x: 0, y: 95, width: 700, height: 210 } });
  assert.equal(await page.evaluate(() => actionProvider.provideCodeActions(suggestionEditor.getModel(), new monaco.Range(1, 4, 1, 4)).actions.length), 1);
  const previewMarks = await page.locator('.mew-review-current, .mew-review-proposed').count();
  assert.ok(previewMarks > 0);
  await page.mouse.click(1390, 890);
  assert.equal(await page.locator('.replacement-review').isVisible(), false, 'ordinary outside clicks still dismiss review');
  await page.waitForFunction(() => !document.querySelector('.mew-review-current, .mew-review-proposed'));
  await page.evaluate(async () => {
    await ReplacementReview.open('suggestion-test', suggestionEditor);
    suggestionEditor.setPosition({ lineNumber: 1, column: 4 }); suggestionEditor.focus();
  });
  await lightbulb.click();
  await page.waitForSelector('.action-widget');
  assert.equal(await page.locator('.replacement-review').isVisible(), true, 'clicking the preview lightbulb keeps the review open');
  assert.equal(await page.locator('[data-apply]').getAttribute('aria-pressed'), 'true');
  assert.equal(await page.evaluate(() => suggestionEditor.getValue()), '  WRONG tail', 'opening quick fixes preserves the source');
  assert.equal(await page.locator('.mew-review-current, .mew-review-proposed').count(), previewMarks, 'opening quick fixes preserves preview highlights');
  // Monaco blocks the opening click until the pointer moves into the menu.
  const actionBox = await page.locator('.action-widget:not(.action-list-submenu-panel)').boundingBox();
  await page.mouse.move(actionBox.x + actionBox.width / 2, actionBox.y + actionBox.height / 2);
  assert.ok(actionBox.width <= 326, 'quick fix menu stays compact');
  await page.screenshot({ path: 'tmp/replacement-suggestions/menu.png', clip: { x: 0, y: 95, width: 700, height: 210 } });
  await page.locator('.action-widget:not(.action-list-submenu-panel)').getByText('RIGHT', { exact: true }).first().click();
  await page.waitForFunction(() => suggestionEditor.getValue() === '  RIGHT tail');
  assert.equal(await page.evaluate(() => completionProvider.provideCompletionItems(suggestionEditor.getModel(), { lineNumber: 1, column: 4 }).suggestions.length), 0);
  await page.evaluate(() => suggestionEditor.trigger('test', 'undo', {}));
  await page.waitForFunction(() => suggestionEditor.getValue() === '  WRONG tail');
  await page.evaluate(() => {
    ReplacementReview.close();
    suggestionEditor.executeEdits('test', [{ range: new monaco.Range(1, 1, 1, 1), text: 'prefix ' }]);
    suggestionEditor.setPosition({ lineNumber: 1, column: 15 }); suggestionEditor.focus();
  });
  await page.waitForTimeout(400);
  assert.equal(await page.locator('.suggest-widget.visible').count(), 0, 'programmatic edits do not open suggestions');
  await page.keyboard.type('x');
  await page.waitForSelector('.suggest-widget.visible');
  assert.match(await page.locator('.suggest-widget.visible').innerText(), /RIGHT/);
  await page.evaluate(() => { ReplacementReview.close(); suggestionEditor.updateOptions({ readOnly: true }); });
  assert.equal(await page.evaluate(() => completionProvider.provideCompletionItems(suggestionEditor.getModel(), { lineNumber: 1, column: 3 }).suggestions.length), 0);
  // Exercise the shared context through real cross-window snapshots and edits.
  const popup = page.waitForEvent('popup');
  await page.evaluate(() => { window.reviewPeer = window.open('/?file=a.html', 'review-context-peer'); });
  const peer = await popup;
  peer.on('pageerror', error => errors.push(error.message));
  await peer.waitForFunction(() => window.ReplacementReview && window.mewWorkbench?.editor);
  const installContextReview = () => {
    window.contextCalls = 0;
    ReplacementReview.register({ id: 'context-test', label: 'Context test', compact: true,
      presentation({ editor, request }) {
        const owner = editor.getDomNode().ownerDocument.defaultView;
        const destination = request?.side === 'pdf' ? owner.reviewPeer : owner;
        return { side: request?.side || 'html', switchable: true, host: destination.ReplacementReview, container: destination.document.body };
      },
      provide({ source }) {
        contextCalls++;
        return [...source.matchAll(/WRONG/g)].map(match => ({ id: String(match.index), options: [{ id: 'replace',
          edits: [{ start: match.index, end: match.index + 5, expected: 'WRONG', text: 'RIGHT' }] }] }));
      },
      content(state, item) {
        for (const key of ['editor', 'model', 'source', 'version']) {
          if (Object.hasOwn(state, key)) throw new Error(`Duplicate context field: ${key}`);
        }
        const { model, source, version, toolbox } = state.context;
        if (source !== model.getValue() || version !== model.getVersionId()) throw new Error('Stale context');
        window.contextSource = source;
        const edit = item?.options[0].edits[0];
        return { range: edit && toolbox.rangeAt(model, edit.start, edit.end) };
      },
      apply({ context: { editor, model, source, version, toolbox }, items, position }) {
        const edits = items[position].options[0].edits;
        toolbox.applyEdits(editor, model, version, source, edits);
        return { offset: edits[0].start + edits[0].text.length };
      }
    });
  };
  await page.evaluate(installContextReview);
  await peer.evaluate(installContextReview);
  await page.evaluate(async () => {
    suggestionEditor.updateOptions({ readOnly: false });
    suggestionEditor.setValue('WRONG and WRONG');
    localStorage.setItem('mew-review-preview', 'false');
    await ReplacementReview.open('context-test', suggestionEditor);
  });
  await peer.waitForFunction(() => document.querySelector('[data-position]').textContent === '1 / 2');
  assert.equal(await peer.evaluate(() => contextCalls), 0, 'opening the peer consumes the prepared snapshot');
  await page.locator('[data-apply]').click();
  await peer.waitForFunction(() => document.querySelector('[data-apply]').getAttribute('aria-pressed') === 'true');
  assert.equal(await page.evaluate(() => suggestionEditor.getValue()), 'WRONG and WRONG', 'mirrored preview preserves source');
  await page.locator('[data-next]').click();
  await peer.waitForFunction(() => document.querySelector('[data-position]').textContent === '2 / 2');
  await page.evaluate(() => suggestionEditor.executeEdits('test', [{ range: new monaco.Range(1, 1, 1, 1), text: 'prefix ' }]));
  for (const target of [page, peer]) await target.waitForFunction(() => contextSource === 'prefix WRONG and WRONG' && !document.querySelector('[data-advance]').disabled);
  await peer.locator('[data-advance]').click();
  await page.waitForFunction(() => suggestionEditor.getValue() === 'prefix WRONG and RIGHT');
  for (const target of [page, peer]) await target.waitForFunction(() => contextSource === 'prefix WRONG and RIGHT' && document.querySelector('[data-position]').textContent === '1 / 1');
  await page.locator('[data-prev]').click();
  await page.locator('[data-advance]').click();
  for (const target of [page, peer]) await target.waitForFunction(() => contextSource === 'prefix RIGHT and RIGHT' && document.querySelector('[data-position]').textContent === '0 / 0');
  await page.evaluate(() => ReplacementReview.close());
  assert.equal(await peer.locator('.replacement-review').isHidden(), true, 'closing the owner closes its peer');
  await peer.close();
  await page.evaluate(async () => {
    ReplacementReview.register({ id: 'unavailable-layout', label: 'Unavailable', available: () => false, provide: () => [],
      presentation: () => ({ side: 'pdf', switchable: true, switchLabel: 'Peer window', container: document.body }) });
    await ReplacementReview.open('unavailable-layout', suggestionEditor);
  });
  assert.equal(await page.locator('[data-switch]').isVisible(), true, 'unavailable review retains its opening layout');
  assert.equal(await page.locator('[data-switch]').textContent(), 'Peer window');
  await page.evaluate(() => ReplacementReview.showNotice({ title: 'Notice', message: 'A short notice',
    anchor: { left: 100, top: 500, bottom: 520 } }));
  assert.equal(await page.locator('[data-switch]').isHidden(), true, 'a notice clears the previous switch button');
  const noticeBox = await page.locator('.replacement-review').boundingBox();
  assert.ok(noticeBox.x >= 99 && noticeBox.y + noticeBox.height <= 500, 'a notice without layout keeps its explicit anchor');
  await page.evaluate(() => dispatchEvent(new Event('resize')));
  await page.waitForTimeout(50);
  assert.deepEqual(await page.locator('.replacement-review').boundingBox(), noticeBox, 'relayout retains the notice anchor');
  await page.evaluate(() => ReplacementReview.showNotice({ message: 'A long notice\n'.repeat(80),
    anchor: { left: 100, top: 500, bottom: 520 } }));
  const limited = await page.locator('.replacement-review').boundingBox();
  await page.setViewportSize({ width: 1400, height: 1300 });
  await page.waitForFunction(height => document.querySelector('.replacement-review').getBoundingClientRect().height > height + 100, limited.height);
  const expanded = await page.locator('.replacement-review').boundingBox();
  assert.ok(expanded.y >= 0 && expanded.y + expanded.height <= 1300, 'a constrained notice grows again when space returns');
  const pending = await page.evaluate(async () => {
    const requests = [];
    ReplacementReview.register({ id: 'pending-test', label: 'Pending',
      provide({ signal }) { return new Promise(resolve => requests.push({ signal, resolve })); }, content: () => ({}) });
    const first = ReplacementReview.openForSelection('pending-test', suggestionEditor, 'first');
    ReplacementReview.openForSelection('pending-test', suggestionEditor, 'first');
    const deduplicated = requests.length === 1;
    ReplacementReview.close();
    const cancelled = requests[0].signal.aborted;
    requests[0].resolve([]); await first;
    const stayedClosed = document.querySelector('.replacement-review').hidden;
    const older = ReplacementReview.openForSelection('pending-test', suggestionEditor, 'older');
    const newer = ReplacementReview.openForSelection('pending-test', suggestionEditor, 'newer');
    requests[1].resolve([]); await older;
    ReplacementReview.openForSelection('pending-test', suggestionEditor, 'newer');
    const retainedNewer = requests.length === 3 && requests[1].signal.aborted && !requests[2].signal.aborted;
    requests[2].resolve([]); await newer;
    const openedNewer = !document.querySelector('.replacement-review').hidden;
    ReplacementReview.close();
    return { deduplicated, cancelled, stayedClosed, retainedNewer, openedNewer };
  });
  assert.deepEqual(pending, { deduplicated: true, cancelled: true, stayedClosed: true, retainedNewer: true, openedNewer: true });
  assert.deepEqual(errors, []);
  console.log('PASS: typing-only completion, replacement-only titles, native selected-action preview/escape, compact quick fixes, preview persistence, outside dismissal, apply/undo, stale and read-only filtering');
} finally {
  await browser?.close();
  await stopServer(server);
  await rm(fixture, { recursive: true, force: true });
}
