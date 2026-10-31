// VS Code owns source UI and edits; PdfLocator supplies every candidate.
if (typeof module === 'object' && module.exports) {
  const vscode = require('vscode');
  const { sameUri, validateReviewEdits, reviewDecorationGroups } = require('../reader-core.cjs');
  module.exports.attach = (reader, panel, source, focusPdf) => {
    const subscriptions = [], previews = new Map();
    let hovers = [], plans = null, popup = null, token = 0, disposed = false, preferenceWrite = Promise.resolve();
    let returningToSource = true;
    const hoverMarkdown = value => {
      const markdown = new vscode.MarkdownString(typeof value === 'string' ? value : value.value);
      markdown.isTrusted = { enabledCommands: ['mewReader:mew.pdf-difference'] }; return markdown;
    };
    const matches = (document, range) => !plans || !sameUri(document.uri, plans.uri) || document.version !== plans.version ? []
      : plans.items.flatMap((plan, index) => {
        const start = document.offsetAt(range.start), end = document.offsetAt(range.end);
        return plan.edits?.length && (plan.range ? plan.range.start <= end && plan.range.end >= start
          : plan.edits.some(edit => edit.start <= end && edit.end >= start)) ? [{ plan, index }] : [];
      });
    async function edit(document, values) {
      const version = document.version, before = document.getText(), edits = validateReviewEdits(before, values);
      if (!edits.length) return false;
      const editor = source.editors()[0] || await vscode.window.showTextDocument(document, { preserveFocus: true, preview: true });
      await source.document({ uri: document.uri.toString(true), version });
      if (document.getText() !== before) throw new Error('原文已变化，请重新审阅。');
      if (!await editor.edit(builder => {
        for (const value of edits) builder.replace(new vscode.Range(document.positionAt(value.start), document.positionAt(value.end)), value.text);
      }, { undoStopBefore: true, undoStopAfter: true })) throw new Error('无法修改当前文件。');
      return true;
    }
    async function preview(before, after) {
      previews.clear();
      const id = ++token, left = vscode.Uri.parse(`mew-review:/${id}/before.html`), right = vscode.Uri.parse(`mew-review:/${id}/after.html`);
      previews.set(left.toString(), before); previews.set(right.toString(), after);
      await vscode.commands.executeCommand('vscode.diff', left, right, 'PDF 修改预览', { preserveFocus: true });
    }
    async function runPlan(requestToken, index, action) {
      const saved = plans, plan = saved?.items[index];
      if (!saved || saved.token !== requestToken || !plan) return;
      const document = await source.document({ uri: saved.uri.toString(true), version: saved.version });
      if (plans !== saved) return;
      if (action === 'apply') { await edit(document, plan.edits); await source.publish(); }
      else if (action === 'preview') {
        const before = document.getText(); let after = before;
        for (const value of validateReviewEdits(before, plan.edits).reverse()) after = after.slice(0, value.start) + value.text + after.slice(value.end);
        await preview(before, after);
      }
    }
    const selector = { scheme: 'file', language: 'html' };
    subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('mew-review', {
      provideTextDocumentContent: uri => previews.get(uri.toString()) || ''
    }), vscode.languages.registerHoverProvider(selector, {
      provideHover(document, position) {
        if (popup && sameUri(document.uri, popup.uri) && document.version === popup.version && popup.range.contains(position))
          return new vscode.Hover(popup.markdown, popup.range);
        const hits = hovers.filter(mark => sameUri(document.uri, mark.uri) && document.version === mark.version && mark.range.contains(position));
        if (hits.length) return new vscode.Hover(hits.flatMap(mark => mark.markdown), hits[0].range);
      }
    }), vscode.languages.registerCodeActionsProvider(selector, {
      provideCodeActions: (document, range) => matches(document, range).flatMap(({ plan, index }) =>
        [['apply', plan.title || plan.edits.map(value => value.text || '删除此处文字').join('、')], ['preview', '预览替换']].map(([action, title]) => {
          const value = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
          value.command = { command: 'mewReader.reviewPlan', title, arguments: [plans.token, index, action] }; return value;
        }))
    }, { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }),
    vscode.languages.registerCompletionItemProvider(selector, {
      provideCompletionItems: (document, position) => matches(document, new vscode.Range(position, position)).flatMap(({ plan }) => {
        const start = Math.min(plan.range?.start ?? Infinity, ...plan.edits.map(value => value.start)),
          end = Math.max(plan.range?.end ?? 0, ...plan.edits.map(value => value.end));
        const before = document.getText(), range = new vscode.Range(document.positionAt(start), document.positionAt(end));
        let after = before.slice(start, end);
        for (const value of validateReviewEdits(before, plan.edits).reverse())
          after = after.slice(0, value.start - start) + value.text + after.slice(value.end - start);
        if (range.start.line !== range.end.line || /[\r\n]/.test(after)) return [];
        const item = new vscode.CompletionItem(after || '删除此处文字', vscode.CompletionItemKind.Text);
        item.range = range; item.insertText = after; item.sortText = '0000';
        item.filterText = before.slice(start, document.offsetAt(position)); item.detail = plan.label || 'PDF 对照替换'; return [item];
      })
    }), vscode.commands.registerCommand('mewReader.reviewPlan', (id, index, action) => runPlan(id, index, action).catch(reader.report)),
    vscode.commands.registerCommand('mewReader:mew.pdf-difference', async request => {
      await source.document({ uri: request?.model, version: request?.version });
      if (!await panel.webview.postMessage({ type: 'reviewSourceAction', action: 'mew.pdf-difference', request })) return;
      if (request.save) return;
      panel.reveal(undefined, false); await focusPdf();
    }));
    subscriptions.push(vscode.window.onDidChangeActiveTextEditor(() => { returningToSource = true; }));
    subscriptions.push(vscode.window.onDidChangeTextEditorSelection(event => {
      popup = null;
      if (event.kind === vscode.TextEditorSelectionChangeKind.Mouse) {
        if (!returningToSource) void panel.webview.postMessage({ type: 'reviewClose' });
        returningToSource = false;
      } else if (event.kind === vscode.TextEditorSelectionChangeKind.Keyboard) returningToSource = false;
      if (event.textEditor !== vscode.window.activeTextEditor || !event.textEditor.selection.isEmpty) return;
      const { document, selection } = event.textEditor;
      if (hovers.some(mark => sameUri(document.uri, mark.uri) && document.version === mark.version && mark.range.contains(selection.active)))
        void vscode.commands.executeCommand('editor.action.showHover', { focus: 'noAutoFocus' }).then(undefined, reader.report);
    }));
    subscriptions.push(panel.webview.onDidReceiveMessage(message => {
      if (!['reviewPreference', 'reviewDecorations', 'reviewPlans', 'reviewHover', 'reviewPreview', 'reviewApply', 'reviewSave'].includes(message?.type)) return;
      void (async () => {
        if (disposed || reader.panel !== panel) return;
        if (message.type === 'reviewPreference') {
          if (!['diffHighlight', 'sourceDiffHighlight', 'selectionHighlight', 'italicDetection', 'boldDetection', 'textDetection'].includes(message.key)
            || typeof message.value !== 'boolean') return;
          const write = () => reader.context.globalState.update('mewReader.pdfReviewSettings', {
            ...reader.context.globalState.get('mewReader.pdfReviewSettings', {}), [message.key]: message.value });
          return preferenceWrite = preferenceWrite.then(write, write);
        }
        const document = await source.document(message);
        if (message.type === 'reviewDecorations') {
          hovers = [...reviewDecorationGroups(message.decorations).values()].flat().filter(mark => mark.hover.length).map(mark => {
            let range = source.range(mark.range);
            if (range.isEmpty) {
              const at = range.start;
              range = new vscode.Range(at.line, Math.max(0, at.character - 1), at.line,
                Math.min(document.lineAt(at.line).text.length, at.character + 1));
            }
            return { range, uri: document.uri, version: document.version, markdown: mark.hover.map(hoverMarkdown) };
          });
          return;
        }
        if (message.type === 'reviewPlans') {
          plans = { uri: document.uri, version: document.version, token: ++token, items: message.plans }; return;
        }
        if (message.type === 'reviewHover') {
          const data = message.hover;
          const editor = message.focus ? await vscode.window.showTextDocument(document, {
            viewColumn: source.editors()[0]?.viewColumn ?? (await source.snapshot())?.layout?.sourceViewColumn ?? vscode.ViewColumn.Active,
            selection: source.range(message.range),
            preserveFocus: false, preview: false
          }) : vscode.window.activeTextEditor;
          if (!editor || editor.document !== document || !data) return;
          await source.document(message);
          const hit = source.range(message.range);
          if (!hit.intersection(editor.selection)) return;
          const range = hit.union(editor.selection);
          popup = { uri: document.uri, version: document.version, range, markdown: data.map(hoverMarkdown) };
          return vscode.commands.executeCommand('editor.action.showHover', { focus: 'noAutoFocus' });
        }
        if (message.type === 'reviewPreview') {
          if (message.before !== document.getText()) throw new Error('原文已变化，请重新预览。');
          await preview(message.before, message.after);
        } else {
          if (message.source !== document.getText()) throw new Error('原文已变化，无法应用旧修改。');
          if (message.type === 'reviewApply') await edit(document, message.edits);
          else if (!await document.save()) throw new Error('保存失败，修改仍未保存。');
        }
        await source.reply(message, { result: true });
      })().catch(error => {
        if (message.id) void source.reply(message, { error: error.message }).catch(reader.report);
        else if (['reviewPlans', 'reviewHover'].includes(message.type)) void source.publish().catch(reader.report);
        else reader.report(error);
      });
    }));
    panel.onDidDispose(() => { disposed = true; subscriptions.forEach(value => value.dispose()); previews.clear(); plans = popup = null; });
  };
} else {
// VS Code review: PDF overlays and native source decorations.
(() => {
  'use strict';
  window.ReviewHighlights = { create };
  function create({ document = window.document, classes = {} }) {
    const { selection: selectionClass = 'review-highlight', pointer: pointerClass = 'review-pointer',
      caret: caretClass = 'review-caret' } = classes;
    const selectionAreas = new Map(), pointerAreas = new Map(), marks = new Map();
    return { measureHighlights, paintHighlight, clearHighlights, clearMarks, updateSource, selectionRange,
      getHighlight: (div, pointer = false) => (pointer ? pointerAreas : selectionAreas).get(div),
      dispose() { clearHighlights(); clearHighlights(true); clearMarks(); } };
    function measureHighlights(div, index, hits, focusHit) {
      // Measure the indexed text nodes in their reading order.
      const boxes = [], notices = [];
      let range;
      const union = (a, b) => {
        const left = Math.min(a.left, b.left), top = Math.min(a.top, b.top), right = Math.max(a.right, b.right);
        return { left, top, right, width: right - left, height: Math.max(a.top + a.height, b.top + b.height) - top };
      };
      let focus = null;
      for (const hit of hits) {
        let noticeBox = null;
        const caret = hit.start === hit.end || !!hit.difference && !index.raw.slice(hit.start, hit.end).trim();
        const at = caret && hit.endBias ? Math.max(0, hit.start - 1) : hit.start;
        // Reading order can differ from DOM order; measure the indexed text nodes.
        for (const part of index.fontRuns(at, caret ? at : hit.end, true)) {
          range ||= (div.ownerDocument || document).createRange();
          range.setStart(part.node, Math.max(0, hit.start - part.start));
          range.setEnd(part.node, Math.max(0, Math.min(part.node.length, (caret ? hit.start : hit.end) - part.start)));
          if (!caret && !range.toString().trim()) continue;
          for (let box of caret ? [range.getBoundingClientRect()] : range.getClientRects()) if ((box.width || caret) && box.height) {
            // Collapsed ranges can have a fractional width in Chromium. Always
            // draw missing text as a visible caret at the insertion point.
            if (caret) box = { left: box.left - 2, right: box.left + 2, top: box.top, width: 4, height: box.height, caret: true };
            const previous = boxes.at(-1);
            // Range rects can include both a span and its text, or adjoining spans.
            if (previous && !previous.caret && !box.caret && Math.abs(previous.top - box.top) < .5 && Math.abs(previous.height - box.height) < .5
              && box.left >= previous.left && box.left <= previous.right + .5) {
              boxes[boxes.length - 1] = union(previous, box);
            } else boxes.push(box);
            noticeBox = noticeBox ? union(noticeBox, box) : box;
            if (hit === focusHit && !focus) focus = box;
          }
        }
        if (noticeBox) notices.push({ box: noticeBox, ...hit.difference, target: { index, start: hit.start, end: hit.end }, source: hit.source });
      }
      const pageBox = div.getBoundingClientRect();
      const sx = pageBox.width / div.offsetWidth, sy = pageBox.height / div.offsetHeight;
      const relative = box => ({
        x: (box.left - pageBox.left - div.clientLeft * sx) / (div.clientWidth * sx),
        y: (box.top - pageBox.top - div.clientTop * sy) / (div.clientHeight * sy),
        w: box.width / (div.clientWidth * sx), h: box.height / (div.clientHeight * sy), caret: !!box.caret
      });
      return { count: hits.length, focus: focus && relative(focus), boxes: boxes.map(relative), notices: notices.map(notice => ({ ...notice, box: relative(notice.box) })) };
    }
    function paintHighlight(div, boxes, color, pointer = false) {
      const store = pointer ? pointerAreas : selectionAreas;
      const previous = store.get(div);
      if (previous?.boxes === boxes && previous.node.isConnected) return previous;
      if (!boxes.length) {
        previous?.node.remove();
        store.delete(div);
        return;
      }
      const overlay = previous?.node.isConnected ? previous.node : document.createElement("div");
      if (!overlay.isConnected) {
        overlay.className = selectionClass + (pointer ? ' ' + pointerClass : '');
        overlay.style.cssText = "position:absolute;inset:0;pointer-events:none;z-index:20;overflow:hidden;contain:strict;";
        div.append(overlay);
      }
      for (let i = 0; i < boxes.length; i++) {
        const box = boxes[i];
        let mark = overlay.children[i];
        if (!mark) {
          mark = document.createElement("div");
          mark.setAttribute("aria-hidden", "true");
          overlay.append(mark);
        }
        mark.style.cssText = `position:absolute;left:${box.x * 100}%;top:${box.y * 100}%;width:${box.w * 100}%;height:${box.h * 100}%;border-radius:2px;pointer-events:none;`;
        mark.style.background = color;
        mark.classList.toggle(caretClass, box.caret);
      }
      while (overlay.children.length > boxes.length) overlay.lastElementChild.remove();
      const painted = { node: overlay, boxes };
      store.set(div, painted);
      return painted;
    }
    function clearHighlights(pointer = false, visible = new Set()) {
      const areas = pointer ? pointerAreas : selectionAreas;
      for (const [div, painted] of areas) if (!visible.has(div)) {
        painted.node.remove(); areas.delete(div);
      }
    }
    function clearMarks() {
      for (const state of marks.values()) { state.collection.clear(); state.dispose?.(); }
      marks.clear();
    }
    function updateSource(editor, key, decorations) {
      let state = marks.get(editor);
      if (!state) {
        state = { collection: editor.createDecorationsCollection() };
        const subscription = editor.onDidChangeModel?.(() => { state.key = null; state.collection.clear(); });
        state.dispose = () => subscription?.dispose();
        marks.set(editor, state);
      }
      if (state.key?.length === key.length && key.every((value, i) => value === state.key[i])) return;
      state.collection.set(decorations());
      editor.render?.(true);
      state.key = key;
    }
    function selectionRange(editor, event, range) {
      if (event?.source === 'replacement-review-close') return null;
      // A text drag owns its full range, even when it ends on a diff marker.
      if (!event?.lineRange && !range.isEmpty?.()) return null;
      const collection = marks.get(editor)?.collection, position = event?.position || range.getStartPosition();
      const node = editor.getDomNode?.(), box = event?.clientX !== undefined && node?.getBoundingClientRect();
      for (let i = 0; i < (collection?.length || 0); i++) {
        const mark = collection.getRange(i);
        if (event?.lineRange ? mark?.intersectRanges(event.lineRange) : mark?.containsPosition(position)
          && (mark.isEmpty() || event?.source === 'keyboard' || position.lineNumber !== mark.endLineNumber || position.column !== mark.endColumn
            || box && event.clientX < box.left + editor.getScrolledVisiblePosition(position)?.left * box.width / node.offsetWidth)) return mark;
        // Missing text beside a space must also be reachable from that space.
        if (!event?.lineRange && mark?.isEmpty() && position.lineNumber === mark.startLineNumber
          && position.column + 1 === mark.startColumn && /^\s$/u.test(editor.getModel().getValueInRange({
            startLineNumber: position.lineNumber, startColumn: position.column,
            endLineNumber: mark.startLineNumber, endColumn: mark.startColumn }))) return mark;
      }
      return null;
    }
  }
})();

// VS Code review session and PDF-side controls. Candidates belong to PdfLocator.
(() => {
  'use strict';
  const providers = new Map();
  const previewKey = 'mew-review-preview';
  let session = null, generation = 0, disposals = [], lastRequest = null;
  let noticeLayout = null, manualTimer = null;
  let placementFrame = null;
  let panelMoved = false;
  let returningToWindow = false;
  const revisionMarks = window.ReviewHighlights.create({ document });
  const menu = document.getElementById('replacementFeatures');
  const panel = document.createElement('section');
  panel.className = 'replacement-review'; panel.hidden = true;
  panel.tabIndex = -1;
  panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', '审阅与批量替换');
  panel.innerHTML = `<div class="review-heading"><strong data-title></strong><span data-position></span><button type="button" data-preview-diff>打开差异预览</button><button type="button" data-switch hidden></button><button type="button" data-close aria-label="关闭审阅">×</button></div>
    <p data-status role="status"></p><div data-comparison></div><div data-options class="review-options"></div>
    <div class="review-controls"><button type="button" data-prev aria-label="上一条" title="上一条">↑</button><button type="button" data-next aria-label="下一条" title="下一条">↓</button><button type="button" data-apply aria-pressed="false" title="开启或关闭修改预览，不更改正文">预览</button><button type="button" data-advance>应用并下一条</button><button type="button" data-save>替换&amp;保存</button></div>
    <details data-expanded><summary>差异预览与批量操作</summary><div class="review-controls"><label><input type="checkbox" data-file>整个文件 diff</label><button type="button" data-all>应用全部候选的所选方案</button></div></details>`;
  document.body.append(panel);
  const fields = Object.create(null);
  const get = name => fields[name] ||= panel.querySelector(`[data-${name}]`);
  function workspace() {
    return window.readerMonaco;
  }
  function message(text) { get('status').textContent = text; get('status').hidden = !text; }
  function current() { return session?.items[session.position]; }
  function selectedEdits(all = false) {
    return session.content?.[all ? 'allEdits' : 'edits'] || (all ? session.items : session.provider.matchingItems?.(current(), session.context, session.items) || [current()])
      .flatMap(item => item?.options.find(value => value.id === session.choices.get(item.id))?.edits || []);
  }
  function bindSuggestions(editor, provide) {
    editor.bindReviewSuggestions(provide, () => session?.context.editor === editor && valid() ? session : null);
  }
  function paintRevision(editor, model, key, edits, decorations = []) {
    const toolbox = window.PdfSelectionDiff;
    revisionMarks.updateSource(editor, key, () => [...edits.flatMap(edit => {
      if (edit.options) return [edit];
      let offset = edit.start;
      return toolbox.textDiff(model.getValueInRange(toolbox.rangeAt(model, edit.start, edit.end)), edit.text, true).parts.flatMap(part => {
        const start = offset;
        offset += part.html.length;
        return part.changed ? [{ start, end: offset, text: part.pdf }] : [];
      });
    }).map(edit => ({
      range: toolbox.rangeAt(model, edit.start, edit.end),
      options: edit.options || { description: 'Revision preview', stickiness: 1, showIfCollapsed: true,
        inlineClassName: edit.end > edit.start ? 'mew-review-current' : undefined,
        after: edit.text ? { content: edit.text, inlineClassName: 'mew-review-proposed', cursorStops: 0 } : undefined }
    })), ...decorations]);
  }
  function valid() {
    return session && !session.stale && session.context.editor.getModel() === session.context.model
      && (session.context.version !== undefined ? session.context.model.getVersionId?.() === session.context.version : session.context.model.getValue() === session.context.source)
      && (!session.provider.isCurrent || session.provider.isCurrent(session.context));
  }
  function validateCandidates(result, previous) {
    const choices = new Map(), items = result.items || result;
    for (const item of items) {
      if (typeof item.id !== 'string' || choices.has(item.id) || !item.options?.length) throw new Error('候选必须有唯一 id 和修改选项');
      choices.set(item.id, result.choices?.get(item.id) || previous?.get(item.id) || item.options[0].id);
      const options = new Set();
      for (const value of item.options) {
        if (typeof value.id !== 'string' || options.has(value.id)) throw new Error('修改选项必须有唯一 id');
        options.add(value.id);
      }
    }
    return { items, choices };
  }
  function updateMenu() {
    if (!menu) return;
    menu.replaceChildren();
    if (!providers.size) { const hint = document.createElement('span'); hint.textContent = '暂无可用的审阅功能'; menu.append(hint); }
    for (const provider of providers.values()) {
      const row = document.createElement('div'); row.className = 'review-feature';
      if (provider.setEnabled) {
        const label = document.createElement('label'), input = document.createElement('input');
        input.type = 'checkbox'; input.checked = provider.isEnabled?.() !== false;
        input.disabled = provider.available?.() === false;
        input.setAttribute('aria-label', `启用${provider.label}`);
        input.onchange = () => {
          provider.setEnabled(input.checked);
          if (!input.checked && (session?.provider === provider || lastRequest?.id === provider.id)) close();
          updateMenu();
        };
        label.append(input);
        if (provider.toggleOnly) label.append(document.createTextNode(provider.label));
        row.append(label);
      }
      if (provider.toggleOnly) { menu.append(row); continue; }
      const button = document.createElement((provider.locator || provider.provide) ? 'button' : 'span'); button.textContent = provider.label;
      if (provider.locator || provider.provide) { button.type = 'button'; button.onclick = () => { const overflow = menu.closest('details'); if (overflow) overflow.open = false; void open(provider.id); }; }
      row.append(button); menu.append(row);
    }
  }
  function close(dismiss = true, restoreFocus = true, position = null) {
    panelMoved = false;
    cancelAnimationFrame(placementFrame); placementFrame = null;
    clearTimeout(manualTimer); manualTimer = null;
    ++generation; lastRequest?.controller?.abort();
    disposals.splice(0).forEach(dispose => dispose());
    revisionMarks.clearMarks();
    panel.hidden = true; lastRequest = null; noticeLayout = null;
    const previous = session, context = previous?.context; session = null;
    previous?.provider.onClose?.(context);
    if (dismiss && previous && context.editor.getModel() === context.model) {
      const selected = context.editor.getSelection();
      if (selected && (position || restoreFocus && !selected.isEmpty())) context.editor.setPosition(position || selected.getPosition(), 'replacement-review-close');
    }
    const detail = dismiss && previous && { id: previous.provider.id, editor: context.editor, model: context.model };
    if (detail) window.dispatchEvent(new CustomEvent('replacement-review-closed', { detail }));
    if (dismiss && restoreFocus && panel.dataset.side !== 'pdf') context?.editor.focus();
  }
  function stale(event) {
    if (!session) return;
    session.stale = true; ++generation; revisionMarks.clearMarks();
    const saved = session;
    if (!saved.manualPending) saved.resumeOffset = saved.anchorOffset ?? 0;
    // Native document changes use offsets in the previous source.
    const offset = saved.resumeOffset;
    saved.resumeOffset = offset + (event?.changes || []).reduce((delta, change) => delta + (
      change.rangeOffset >= offset ? 0 : change.rangeOffset + change.rangeLength <= offset
        ? change.text.length - change.rangeLength : change.rangeOffset - offset
    ), 0);
    saved.manualPending = true;
    clearTimeout(manualTimer);
    message('正在自动重新计算差异…'); controls();
    manualTimer = setTimeout(() => void refreshAfterEdit(saved), 350);
  }
  function refreshAfterEdit(saved) {
    if (saved.refreshTask) return saved.refreshTask;
    if (session !== saved || !saved.manualPending || saved.context.editor.getModel() !== saved.context.model || saved.provider.available?.(saved.context.editor) === false) return Promise.resolve();
    const request = ++generation, source = saved.context.model.getValue(), version = saved.context.model.getVersionId?.();
    const context = { ...saved.context, source, version, request: { side: saved.context.request?.side } };
    return saved.refreshTask = (async () => {
    try {
      const result = saved.provider.locator ? await saved.provider.locator.reviewItems(context) : await saved.provider.provide(context);
      if (session !== saved || request !== generation || saved.context.model.getValue() !== source
        || saved.context.model.getVersionId?.() !== version || (saved.provider.isCurrent && !saved.provider.isCurrent(context))) return;
      const { items, choices } = validateCandidates(result, saved.choices);
      const found = items.findIndex(item => {
        const range = item.range || saved.provider.content({ ...saved, context, items, choices }, item).range;
        return range && (saved.context.model.getOffsetAt({ lineNumber: range.endLineNumber, column: range.endColumn }) > saved.resumeOffset
          || saved.context.model.getOffsetAt({ lineNumber: range.startLineNumber, column: range.startColumn }) >= saved.resumeOffset);
      });
      Object.assign(saved, { items, choices, position: found < 0 ? items.length : found,
        context, stale: false, manualPending: false });
      if (!saved.saving) render(true);
    } catch (error) { if (session === saved && request === generation) message(error.message); }
    })().finally(() => {
      saved.refreshTask = null;
      if (session === saved && saved.manualPending && request !== generation)
        manualTimer = setTimeout(() => void refreshAfterEdit(saved), 0);
    });
  }
  function controls() {
    const item = current(), currentVersion = valid(), busy = !!(session?.applying || session?.saving);
    const ready = (currentVersion || session?.manualPending) && !!item && !busy && !session.waitingApply;
    const canApply = ready && session.provider.apply && session.content?.apply !== false;
    get('apply').disabled = !currentVersion || !item || busy;
    get('preview-diff').disabled = !currentVersion || !item || busy;
    for (const name of ['advance', 'all']) get(name).disabled = !canApply;
    get('save').disabled = !workspace()?.save || !canApply;
    const blocked = !currentVersion || !!session?.applying;
    get('prev').disabled = blocked || session.position <= 0;
    get('next').disabled = blocked || session.position >= session.items.length - 1;
    get('position').textContent = session ? `${Math.min(session.position + 1, session.items.length)} / ${session.items.length}` : '';
  }
  function subscribe(target, event, callback) {
    const listener = target[event]?.(callback);
    if (listener) disposals.push(() => listener.dispose());
  }
  async function open(id, suppliedEditor, focusId, fallbackPosition = 0, requestData = null) {
    const provider = providers.get(id), target = suppliedEditor || window.readerMonaco.editor;
    const placement = provider?.presentation?.({ editor: target, request: requestData });
    close(false); noticeLayout = placement;
    lastRequest = { id, editor: target, focusId };
    panel.hidden = false;
    panel.classList.toggle('compact', !!provider?.compact);
    get('expanded').hidden = !!provider?.compact;
    if (provider?.compact) get('expanded').open = false;
    get('prev').parentElement.hidden = false;
    get('prev').hidden = get('next').hidden = false;
    get('apply').hidden = !!provider?.compact;
    get('advance').hidden = false;
    get('title').textContent = provider?.label || '审阅'; get('options').replaceChildren(); get('comparison').replaceChildren(); controls();
    if (!provider || !target?.getModel() || provider.available?.(target) === false) { message('编辑器或审阅文档尚未就绪。'); place(); return; }
    bindSuggestions(target);
    if (provider.isEnabled?.() === false) { message('请先在菜单中启用此功能。'); place(); return; }
    const request = ++generation, controller = lastRequest.controller = new AbortController();
    const model = target.getModel(), source = model.getValue(), version = model.getVersionId?.();
    const context = { ...requestData?.snapshot?.context, editor: target, model, source, version, signal: controller.signal, toolbox: window.PdfSelectionDiff, request: requestData };
    subscribe(target, 'onDidChangeModel', () => close());
    subscribe(target, 'onDidDispose', () => close(false, false));
    subscribe(target, 'onDidChangeModelContent', event => {
      if (!session?.applying) stale(event);
    });
    // Keep an opening session so typing while extraction runs schedules a fresh calculation.
    session = { provider, context, items: [], position: 0,
      choices: new Map() };
    if (placement?.container) {
      const container = placement.container;
      container.addEventListener('scroll', queuePlace); disposals.push(() => container.removeEventListener('scroll', queuePlace));
      placement.eventBus?.on('textlayerrendered', queuePlace);
      disposals.push(() => placement.eventBus?.off('textlayerrendered', queuePlace));
    }
    message('正在计算候选…'); place(target);
    try {
      const snapshot = requestData?.snapshot;
      const result = snapshot?.context.model === model && snapshot.context.source === source && snapshot.context.version === version
        ? snapshot.items : provider.locator ? await provider.locator.reviewItems(context) : await provider.provide(context);
      if (request !== generation || providers.get(id) !== provider) return;
      if (target.getModel() !== model || model.getValue() !== source || model.getVersionId?.() !== version
        || (provider.isCurrent && !provider.isCurrent(context))) { stale(); return; }
      const { items, choices } = validateCandidates(result, snapshot?.choices);
      let found = items.findIndex(item => item.id === focusId);
      if (found < 0) found = provider.focusIndex?.(items, requestData) ?? -1;
      Object.assign(session, { items,
        position: found >= 0 ? found : Math.max(0, Math.min(fallbackPosition, items.length - 1)),
        choices });
      render(!!requestData);
    } catch (error) { if (request === generation) {
      if (provider.isCurrent && !provider.isCurrent(context)) stale();
      else { message(error.message); controls(); }
    } }
    finally { if (lastRequest?.controller === controller) delete lastRequest.controller; }
  }
  function render(preserveSelection = false) {
    if (!session) return;
    const item = current(), { editor, model, source, version } = session.context;
    session.content = session.provider.content?.(session, item) || {};
    const content = session.content;
    let previewEnabled = false;
    try { previewEnabled = !session.provider.compact && localStorage.getItem(previewKey) === 'true'; } catch {}
    get('apply').setAttribute('aria-pressed', String(previewEnabled));
    get('options').replaceChildren(); controls();
    message(content.message || ''); comparison(content.comparison);
    get('title').textContent = content.title || session.provider.label;
    for (const name of ['advance', 'expanded', 'all']) get(name).hidden = content[name] === false;
    if (item) {
      for (const value of content.options || []) {
        const label = document.createElement('label'), input = document.createElement('input');
        input.type = 'radio'; input.name = 'review-choice'; input.checked = session.choices.get(item.id) === value.id;
        input.onchange = () => { session.choices.set(item.id, value.id); render(); };
        label.append(input, document.createTextNode(value.label)); get('options').append(label);
      }
      const range = preserveSelection && editor.getSelection() || content.range;
      session.anchor = content.range ? model.validateRange(content.range) : range;
      if (range) {
        session.anchorOffset = model.getOffsetAt({ lineNumber: range.startLineNumber, column: range.startColumn });
        if (!preserveSelection) editor.setSelection(session.anchor);
        editor.revealRangeInCenterIfOutsideViewport(session.anchor);
      }
      session.provider.onSelect?.(item, session.context, session.items, previewEnabled);
    } else session.provider.onClose?.(session.context);
    if (editor.getDomNode()?.ownerDocument === document) {
      paintRevision(editor, model, [model, version ?? source, item, session.choices.get(item?.id), previewEnabled],
        previewEnabled ? selectedEdits() : [], previewEnabled ? content.previewDecorations : []);
    }
    place(editor);
  }
  function hoverContent(provider, context, item, items) {
    const content = provider.content({ context, items }, item), { editor, model } = context;
    const command = `${editor.getId()}:mew.pdf-difference`;
    const request = { model: model.uri.toString(), version: model.getVersionId(), id: item.id };
    if (item.selection) request.selection = { html: item.comparison.html, pdf: item.comparison.pdf,
      start: item.sourceStart, end: item.sourceEnd, missing: item.missing };
    const link = (label, data) => `[${label}](command:${command}?${encodeURIComponent(JSON.stringify([data]))})`;
    const escape = text => text.replace(/[\\`*_{}\[\]()#+.!<>|~-]/g, '\\$&');
    const rows = content.comparison.map(row => {
      let text = row.parts.map(part => part.text).join('');
      if (!item.font) text = JSON.stringify(text.trim() ? text : '');
      return `${row.label === 'PDF' ? link('PDF:', request) : row.label + ':'} ${escape(text)}`;
    });
    return { value: item.missing ? `${link('PDF:', request)} ${content.message}`
      : rows.join('\n\n') + (content.apply ? `\n\n${link('替换&保存', { ...request, save: true })}` : ''),
      isTrusted: { enabledCommands: [command] } };
  }
  function showHover(provider, context, item, items, source = { start: item.sourceStart, end: item.sourceEnd }, focus = false) {
    const content = provider.content({ context, items }, item);
    const hover = items.filter(value => value === item || value.font
      && value.sourceStart < source.end && value.sourceEnd > source.start)
      .map(value => hoverContent(provider, context, value, items));
    context.editor.showReviewHover(content.range, hover, focus);
  }
  function comparison(rows = []) {
    get('comparison').replaceChildren();
    for (const row of rows) {
      const line = document.createElement('div');
      if (row.label) line.append(`${row.label}: `);
      for (const part of row.parts || []) {
        const span = document.createElement(part.changed ? 'mark' : 'span'); span.textContent = part.text; line.append(span);
        if (part.changed && part.source && session?.provider.selectComparison) {
          span.style.cursor = 'pointer'; span.onclick = () => { if (valid()) session.provider.selectComparison(session.context, part); };
        }
      }
      get('comparison').append(line);
    }
  }
  function showNotice({ title = '', message: text, comparison: rows, anchor, layout }) {
    close(); panel.hidden = false; noticeLayout = { ...layout, anchor: layout?.anchor || anchor };
    panel.classList.add('compact');
    get('title').textContent = title; get('options').replaceChildren();
    for (const name of ['switch', 'advance', 'expanded']) get(name).hidden = true;
    comparison(rows); message(text || ''); controls(); get('prev').parentElement.hidden = true; place();
  }
  function openForSelection(id, target, focusId, request) {
    if (session?.applying || session?.saving) return;
    if (session?.manualPending && session.provider.id === id && session.context.editor === target) return;
    if (session?.provider.id === id && session.context.editor === target && valid()) {
      const sameInteraction = request?.interactionId !== undefined && request.interactionId === session.context.request?.interactionId;
      // Selection synchronization after our own navigation is not a new review request.
      if (sameInteraction && target.getSelection()?.equalsRange(session.anchor)) { place(target); return; }
      const previousSource = session.context.request?.notice?.source, source = request?.notice?.source;
      const sameSelection = source && previousSource && source.index === previousSource.index
        && source.start === previousSource.start && source.end === previousSource.end;
      session.context.request = { ...session.context.request, ...request, side: session.context.request?.side };
      if (sameInteraction && (sameSelection || session.provider.containsSelection?.(current(), request))) { place(target); return; }
      const at = session.items.findIndex(item => item.id === focusId);
      if (at >= 0) { if (at !== session.position) { session.position = at; render(true); } else place(target); return; }
      // A broader selected passage can contain the current character candidate.
      if (session.provider.containsSelection?.(current(), request)) { place(target); return; }
    }
    if (lastRequest?.controller && lastRequest.id === id && lastRequest.editor === target && lastRequest.focusId === focusId) return;
    return open(id, target, focusId, 0, request);
  }
  async function preview() {
    if (!valid() || !current()) return;
    const saved = session, { model, source } = saved.context;
    try {
      const data = saved.provider.preview ? await saved.provider.preview(saved, get('file').checked)
        : { before: source, after: source, language: model.getLanguageId() };
      if (!data || session !== saved || !valid()) return;
      const edits = saved.provider.preview ? [] : window.PdfSelectionDiff.validateEdits(source, selectedEdits(get('file').checked));
      await saved.context.editor.previewReview({ ...data, edits });
    } catch (error) { if (session === saved) message(error.message); }
  }
  async function apply(all) {
    const saved = session, model = saved?.context.model;
    if (saved?.waitingApply) return;
    if (saved?.refreshTask || saved?.manualPending)
      await (saved.waitingApply = saved.refreshTask || refreshAfterEdit(saved)).finally(() => { saved.waitingApply = null; });
    if (session !== saved || !valid()) return;
    if (!current() || !saved.provider.apply || saved.applying) return;
    saved.applying = true; controls();
    try {
      // Providers receive candidate data; session lifecycle remains owned here.
      const result = await saved.provider.apply({ ...saved, context: { ...saved.context } }, all);
      if (session !== saved) return true;
      if (result.offset !== undefined) {
        saved.resumeOffset = result.offset; saved.manualPending = true;
        await refreshAfterEdit(saved);
        return true;
      }
      Object.assign(saved, { items: result.items, choices: result.choices || saved.choices,
        position: result.position, context: { ...saved.context, ...result.context,
          source: model.getValue(), version: model.getVersionId?.() } });
      if (saved.context.request) saved.context.request = { ...saved.context.request, snapshot: null };
      if (!valid()) { stale(); return; }
      if (!saved.saving) render();
      return true;
    } catch (error) {
      if (session !== saved) return;
      if (model.getValue() !== saved.context.source) stale();
      message(error.message);
    } finally { saved.applying = false; controls(); }
  }
  function navigate(direction) {
    if (!valid() || session.applying) return;
    const next = session.position + direction;
    if (next >= 0 && next < session.items.length) { session.position = next; render(); }
  }
  function queuePlace() {
    if (!panel.hidden && placementFrame === null) placementFrame = requestAnimationFrame(() => {
      placementFrame = null; place();
    });
  }
  function place(target = session?.context.editor) {
    placeFallback(target);
  }
  function placeFallback(target) {
    if (panel.hidden) return;
    get('switch').hidden = target?.splitView !== true;
    get('switch').textContent = '查看HTML';
    get('switch').onclick = () => current()
      ? showHover(session.provider, session.context, current(), session.items, undefined, true) : target?.focus();
    if (panelMoved) return;
    const layout = session?.provider.presentation?.(session.context, current()) || noticeLayout, compact = panel.classList.contains('compact');
    const rect = (layout?.container || document.getElementById('stage')).getBoundingClientRect();
    panel.dataset.side = 'pdf';
    const left = Math.max(8, rect?.left || 8), right = Math.min(innerWidth - 8, rect?.right || innerWidth - 8);
    panel.style.width = compact ? 'max-content' : `${Math.max(0, Math.min(640, right - left))}px`;
    panel.style.maxWidth = `${Math.max(0, Math.min(compact ? 560 : 640, right - left))}px`;
    panel.style.maxHeight = `${Math.max(100, Math.min(innerHeight - 16, (rect?.height || innerHeight) * .75))}px`;
    const top = Math.max(8, rect?.top || 8), bottom = Math.min(innerHeight - 8, rect?.bottom || innerHeight - 8);
    const fragment = layout?.anchor;
    const anchor = Math.max(top, Math.min(bottom, fragment?.top ?? (rect?.top || 0) + 40));
    const height = panel.getBoundingClientRect().height;
    const end = fragment?.bottom ?? anchor + 20;
    const roomAbove = Math.max(0, anchor - top - 8), roomBelow = Math.max(0, bottom - end - 8);
    const useAbove = roomAbove >= height || roomAbove >= roomBelow;
    let available = Math.min(height, useAbove ? roomAbove : roomBelow);
    let y = useAbove ? anchor - available - 8 : end + 8;
    if (layout?.highlights?.length) {
      let edge = top;
      available = 0;
      // Each free band ends above a highlight or starts below one.
      for (const box of [...layout.highlights, { top: bottom + 8, bottom }].sort((a, b) => a.top - b.top)) {
        const end = Math.min(bottom, box.top - 8), room = Math.min(height, Math.max(0, end - edge));
        if (room > available) {
          available = room;
          y = end <= anchor ? end - room : edge;
        }
        edge = Math.max(edge, box.bottom + 8);
      }
    }
    panel.style.visibility = !available ? 'hidden' : '';
    panel.style.maxHeight = `${available}px`;
    panel.style.top = `${y}px`;
    panel.style.left = `${Math.max(left, Math.min(right - panel.offsetWidth, fragment?.left ?? left))}px`;
  }
  get('position').ondblclick = () => { panelMoved = false; place(); };
  get('position').onpointerdown = event => {
    if (panel.dataset.side !== 'pdf' || event.button !== 0) return;
    const handle = event.currentTarget, box = panel.getBoundingClientRect();
    const dx = event.clientX - box.left, dy = event.clientY - box.top;
    handle.setPointerCapture(event.pointerId);
    handle.onpointermove = move => {
      if (!handle.hasPointerCapture(move.pointerId)) return;
      panelMoved = true;
      const bounds = (session?.provider.presentation?.(session.context, current()) || noticeLayout).container.getBoundingClientRect();
      panel.style.left = `${Math.max(bounds.left, Math.min(bounds.right - panel.offsetWidth, move.clientX - dx))}px`;
      panel.style.top = `${Math.max(bounds.top, Math.min(bounds.bottom - panel.offsetHeight, move.clientY - dy))}px`;
    };
    event.preventDefault();
  };
  get('close').onclick = () => close();
  get('preview-diff').onclick = () => void preview();
  document.getElementById('reviewBtn')?.addEventListener('click', () => void open('pdf-ocr', window.PdfSelection?.editor));
  get('prev').onclick = () => navigate(-1);
  get('next').onclick = () => navigate(1);
  get('apply').onclick = () => {
    if (!valid() || get('apply').disabled) return;
    try { localStorage.setItem(previewKey, String(get('apply').getAttribute('aria-pressed') !== 'true')); } catch { return; }
    render(true);
  };
  get('advance').onclick = () => apply(false);
  get('all').onclick = () => apply(true);
  get('save').onclick = async () => {
    const saved = session, owner = workspace(), model = saved?.context.model;
    if (!saved || !owner?.save || get('save').disabled) return;
    saved.saving = true; controls();
    try {
      if (!await apply(false)) return;
      // A popup refresh must not cancel saving an already applied replacement.
      if (saved.context.editor.getModel() !== model) throw new Error('文件已切换，未保存替换。');
      const source = model.getValue();
      if (await owner.save({ followPdf: false, model: model }) === false) throw new Error('保存失败，修改仍未保存，请重试。');
      if (session === saved && model.getValue() === source) {
        if (valid()) render();
        else message('已保存。差异更新中…');
      }
    }
    catch (error) { if (session === saved) message(error.message); }
    finally { saved.saving = false; controls(); }
  };
  get('file').onchange = () => void preview();
  get('expanded').ontoggle = () => { if (get('expanded').open) void preview(); place(); };
  panel.addEventListener('keydown', event => { event.stopPropagation(); if (event.key === 'Escape') close(); });
  window.addEventListener('blur', () => { if (!document.hasFocus()) returningToWindow = true; });
  window.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !event.isComposing && !panel.hidden) {
      event.preventDefault(); close(true, false);
    }
    if (document.hasFocus() && !['Alt', 'Control', 'Meta', 'Shift'].includes(event.key)
      && !(event.key === 'Tab' && event.altKey)) returningToWindow = false;
  }, true);
  document.addEventListener('pointerdown', event => {
    const returning = event.returningToWindow = returningToWindow || !document.hasFocus();
    returningToWindow = false;
    if (!panel.hidden && !returning && !event.composedPath().includes(panel)) close(true, false);
  }, true);
  new ResizeObserver(queuePlace).observe(panel);
  window.addEventListener('resize', queuePlace);
  window.addEventListener('storage', event => {
    if ((event.key === previewKey || event.key === null) && valid()) render(true);
  });
  window.addEventListener('pagehide', () => close(false, false));
  window.ReplacementReview = {
    open, openForSelection, showNotice, close, bindSuggestions, hoverContent, showHover, refreshMenu: updateMenu, refreshPresentation: queuePlace,
    isOpenFor(id, target) { return !panel.hidden && (session?.provider.id === id && session.context.editor === target || lastRequest?.id === id && lastRequest.editor === target); },
    invalidate(id, changed = () => true) { if (session?.provider.id === id && changed(session.context)) stale(); },
    register(provider) {
      if (!provider?.id || (!provider.locator && typeof provider.provide !== 'function' && typeof provider.setEnabled !== 'function')) throw new Error('功能需要 id 和 locator、provide(context) 或 setEnabled(enabled)');
      if (providers.has(provider.id)) throw new Error(`审阅功能已注册：${provider.id}`);
      providers.set(provider.id, provider); updateMenu();
      return () => { if (session?.provider === provider || lastRequest?.id === provider.id) close(); providers.delete(provider.id); updateMenu(); };
    }
  };
  updateMenu();
})();

}
