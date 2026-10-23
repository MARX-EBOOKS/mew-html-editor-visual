// Shared review popup, session, navigation and saving. Providers own content and actions.
(() => {
  'use strict';
  const toolbox = window.PdfSelectionDiff, providers = new Map();
  let session = null, generation = 0, pending = null, view = null, previewModels = [], disposals = [], lastRequest = null;
  let widget = null, widgetEditor = null, noticeAnchor = null, noticeLayout = null, manualTimer = null, composing = false;
  let placementFrame = null;
  const menu = document.getElementById('replacementFeatures');
  const panel = document.createElement('section');
  panel.className = 'replacement-review'; panel.hidden = true;
  panel.tabIndex = -1;
  panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', '审阅与批量替换');
  panel.innerHTML = `<div class="review-heading"><strong data-title></strong><span data-position></span><button type="button" data-switch hidden></button><button type="button" data-close aria-label="关闭审阅">×</button></div>
    <p data-status role="status"></p><div data-comparison></div><div data-options class="review-options"></div>
    <div class="review-controls"><button type="button" data-prev aria-label="上一条" title="上一条">↑</button><button type="button" data-next aria-label="下一条" title="下一条">↓</button><button type="button" data-apply>应用本条</button><button type="button" data-advance>应用并下一条</button><button type="button" data-save>替换&amp;保存</button></div>
    <details data-expanded><summary>差异预览与批量操作</summary><div class="review-controls"><label><input type="checkbox" data-file>整个文件 diff</label><button type="button" data-all>应用全部候选的所选方案</button></div><div data-preview data-review-preview></div></details>`;
  document.body.append(panel);
  const fields = new Map();
  const get = name => {
    if (!fields.has(name)) fields.set(name, panel.querySelector(`[data-${name}]`));
    return fields.get(name);
  };
  function workspace() {
    const owner = session?.editor.getDomNode()?.ownerDocument.defaultView;
    return owner?.mewWorkbench || owner?.readerMonaco;
  }
  function message(text) { get('status').textContent = text; get('status').hidden = !text; }
  function current() { return session?.items[session.position]; }
  function presentation() { return session?.provider.presentation?.(session.context, current()) || noticeLayout; }
  function valid() {
    return session && !session.stale && session.editor.getModel() === session.model
      && (session.version !== undefined ? session.model.getVersionId?.() === session.version : session.model.getValue() === session.source)
      && (!session.provider.isCurrent || session.provider.isCurrent(session.context));
  }
  function validateCandidates(result) {
    const ids = new Set();
    return (result.items || result).map(item => {
      if (typeof item.id !== 'string' || ids.has(item.id) || !item.options?.length) throw new Error('候选必须有唯一 id 和修改选项');
      ids.add(item.id);
      const options = new Set();
      for (const value of item.options) {
        if (typeof value.id !== 'string' || options.has(value.id)) throw new Error('修改选项必须有唯一 id');
        options.add(value.id);
      }
      return item;
    });
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
      const button = document.createElement(provider.provide ? 'button' : 'span'); button.textContent = provider.label;
      if (provider.provide) { button.type = 'button'; button.onclick = () => { const overflow = menu.closest('details'); if (overflow) overflow.open = false; void open(provider.id); }; }
      row.append(button); menu.append(row);
    }
  }
  function clearPreview() {
    view?.setModel(null);
    const previous = previewModels.splice(0);
    // Monaco releases the previous diff view model on the next event-loop turn.
    if (previous.length) setTimeout(() => previous.forEach(model => model.dispose()), 0);
  }
  function mount(target) {
    const api = target?.getDomNode()?.ownerDocument.defaultView.monaco;
    if (!target?.addContentWidget || !api) return;
    widgetEditor = target;
    widget = {
      getId: () => 'mew.replacement-review', getDomNode: () => panel,
      allowEditorOverflow: false, suppressMouseDown: false,
      getPosition() {
        if (panel.hidden) return null;
        const range = session?.anchor;
        const position = range ? { lineNumber: range.startLineNumber, column: range.startColumn } : target.getPosition();
        return { position, preference: [api.editor.ContentWidgetPositionPreference.ABOVE, api.editor.ContentWidgetPositionPreference.BELOW] };
      }
    };
    panel.dataset.contentWidget = '';
    panel.style.top = ''; panel.style.left = '';
    target.addContentWidget(widget);
  }
  function close(dismiss = true, restoreFocus = true) {
    cancelAnimationFrame(placementFrame); placementFrame = null;
    clearTimeout(manualTimer); manualTimer = null; composing = false;
    ++generation; pending?.abort(); pending = null;
    disposals.splice(0).forEach(dispose => dispose());
    clearPreview(); panel.hidden = true; lastRequest = null; noticeAnchor = noticeLayout = null;
    if (widget) { widgetEditor.removeContentWidget(widget); widget = widgetEditor = null; document.body.append(panel); delete panel.dataset.contentWidget; panel.style.cssText = ''; }
    const previous = session; session = null;
    previous?.provider.onClose?.(previous.context);
    if (previous && dismiss) window.dispatchEvent(new CustomEvent('replacement-review-closed', { detail: {
      id: previous.provider.id, editor: previous.editor, model: previous.model
    } }));
    const owner = previous?.editor.getDomNode()?.ownerDocument.defaultView;
    if (previous && dismiss && owner && owner !== window) owner.dispatchEvent(new owner.CustomEvent('replacement-review-closed', { detail: {
      id: previous.provider.id, editor: previous.editor, model: previous.model
    } }));
    if (dismiss && restoreFocus && panel.dataset.side !== 'pdf') previous?.editor.focus();
  }
  function stale(event) {
    if (!session) return;
    session.stale = true; ++generation; clearPreview();
    queueManualRefresh(event);
  }
  function queueManualRefresh(event) {
    const saved = session;
    if (!saved) return;
    if (!saved.manualPending) saved.resumeOffset = saved.anchorOffset ?? 0;
    // Monaco change offsets refer to the source before this event.
    const offset = saved.resumeOffset;
    saved.resumeOffset = offset + (event?.changes || []).reduce((delta, change) => delta + (
      change.rangeOffset >= offset ? 0 : change.rangeOffset + change.rangeLength <= offset
        ? change.text.length - change.rangeLength : change.rangeOffset - offset
    ), 0);
    saved.manualPending = true;
    if (event) { saved.needsSave = true; saved.manualSave = true; }
    clearTimeout(manualTimer);
    message('正在自动重新计算差异…' + (saved.needsSave ? ' 内容已修改，请保存。' : '')); controls();
    if (!composing) manualTimer = setTimeout(() => void refreshAfterEdit(saved), 0);
  }
  function refreshAfterEdit(saved) {
    return saved.refreshTask ||= (async () => {
    if (session !== saved || !saved.manualPending || composing || saved.editor.getModel() !== saved.model) return;
    const request = ++generation, source = saved.model.getValue(), version = saved.model.getVersionId?.();
    const context = { ...saved.context, source, version, request: { ...saved.context.request, snapshot: null } };
    try {
      const sameReference = !saved.provider.isCurrent || saved.provider.isCurrent(context);
      if (!sameReference) { context.targets = null; context.request = { side: context.request?.side }; }
      const result = sameReference && saved.provider.refreshAfterEdit
        ? await saved.provider.refreshAfterEdit(context, saved.resumeOffset, saved)
        : { items: await saved.provider.provide(context), position: saved.position };
      if (session !== saved || request !== generation || saved.model.getValue() !== source
        || saved.model.getVersionId?.() !== version || (saved.provider.isCurrent && !saved.provider.isCurrent(context))) return;
      const items = validateCandidates(result);
      Object.assign(saved, { items, position: result.position ?? saved.position,
        context, source, version, stale: false, manualPending: false });
      saved.choices = result.choices || new Map(saved.items.map(item => [item.id, saved.choices.get(item.id) || item.options[0].id]));
      render(true);
    } catch (error) { if (session === saved && request === generation) message(error.message); }
    })().finally(() => { saved.refreshTask = null; });
  }
  function controls() {
    const item = current(), currentVersion = valid(), ready = (currentVersion || session?.manualPending && !composing) && !!item && !session.applying && !session.saving && !session.waitingApply;
    for (const name of ['apply', 'advance', 'all']) get(name).disabled = !ready || !session?.provider.apply || session.content?.apply === false;
    get('save').textContent = session?.manualSave ? '保存修改' : '替换&保存';
    get('save').disabled = !workspace()?.save || !!session?.saving || !!session?.applying || !(session?.manualSave
      ? session.editor.getModel() === session.model : ready && session?.provider.apply && session.content?.apply !== false);
    const blocked = !currentVersion || !!session?.applying;
    get('prev').disabled = blocked || session.position <= 0;
    get('next').disabled = blocked || session.position >= session.items.length - 1;
    get('position').textContent = session ? `${Math.min(session.position + 1, session.items.length)} / ${session.items.length}` : '';
  }
  async function open(id, suppliedEditor, focusId, fallbackPosition = 0, requestData = null) {
    const provider = providers.get(id), target = suppliedEditor || window.mewWorkbench?.editor || window.readerMonaco?.editor;
    const placement = provider?.presentation?.({ editor: target, request: requestData });
    if (placement?.host && placement.host !== window.ReplacementReview) return placement.host.open(id, target, focusId, fallbackPosition, requestData);
    close(false);
    lastRequest = { id, editor: target, focusId };
    panel.hidden = false;
    panel.classList.toggle('compact', !!provider?.compact);
    panel.dataset.side = placement?.side || 'html';
    get('expanded').hidden = !!provider?.compact;
    if (provider?.compact) get('expanded').open = false;
    get('prev').parentElement.hidden = false;
    get('advance').hidden = false;
    get('switch').hidden = !placement?.switchable;
    get('switch').textContent = placement?.switchLabel || '';
    get('title').textContent = provider?.label || '审阅'; get('options').replaceChildren(); get('comparison').replaceChildren(); controls();
    if (!provider || !target?.getModel()) { message('请先打开可编辑的文件。'); place(); return; }
    if (provider.isEnabled?.() === false) { message('请先在菜单中启用此功能。'); place(); return; }
    if (placement?.side !== 'pdf') {
      target.getDomNode()?.ownerDocument.defaultView.readerMonaco?.showSource?.();
      mount(target);
    }
    const request = ++generation, controller = pending = new AbortController();
    const model = target.getModel(), source = model.getValue(), version = model.getVersionId?.();
    const context = { editor: target, model, source, version, signal: controller.signal, toolbox, request: requestData };
    if (requestData?.snapshot) Object.assign(context, requestData.snapshot.context, { editor: target, model, source, version, signal: controller.signal, request: requestData });
    const modelChange = target.onDidChangeModel(() => close());
    const contentChange = target.onDidChangeModelContent(event => {
      if (event.isFlush || !session) close();
      else if (!session.applying) stale(event);
    });
    disposals.push(() => modelChange.dispose(), () => contentChange.dispose());
    const ownerWindow = target.getDomNode()?.ownerDocument.defaultView;
    const dirtyIndicator = ownerWindow?.document.getElementById(ownerWindow.mewWorkbench ? 'tabs' : 'saveBtn');
    const dirtyObserver = new MutationObserver(() => {
      if (!session?.needsSave || target.getModel() !== session.model) return;
      const dirty = ownerWindow.mewWorkbench
        ? [...ownerWindow.mewWorkbench.documents.values()].find(doc => doc.model === session.model)?.dirty
        : dirtyIndicator.classList.contains('dirty');
      if (dirty !== false) return;
      session.needsSave = false; session.manualSave = false;
      if (valid()) render(true);
      else { message('已保存。差异更新中…'); controls(); }
    });
    if (dirtyIndicator) dirtyObserver.observe(dirtyIndicator, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    disposals.push(() => dirtyObserver.disconnect());
    const compositionStart = target.onDidCompositionStart?.(() => { composing = true; clearTimeout(manualTimer); });
    const compositionEnd = target.onDidCompositionEnd?.(() => {
      composing = false;
      if (session?.manualPending) { const saved = session; manualTimer = setTimeout(() => void refreshAfterEdit(saved), 0); }
    });
    disposals.push(() => compositionStart?.dispose(), () => compositionEnd?.dispose());
    // Keep an opening session so typing while extraction runs schedules a fresh calculation.
    session = { provider, editor: target, model, source, version, context, items: [], position: 0,
      choices: new Map(), manualSave: requestData?.snapshot?.manualSave || false, needsSave: requestData?.snapshot?.needsSave || false };
    const scroll = target.onDidScrollChange(queuePlace); disposals.push(() => scroll.dispose());
    if (placement?.container) {
      const container = placement.container, move = queuePlace;
      container.addEventListener('scroll', move); disposals.push(() => container.removeEventListener('scroll', move));
      placement.eventBus?.on('textlayerrendered', move);
      disposals.push(() => placement.eventBus?.off('textlayerrendered', move));
    }
    message('正在计算候选…'); place(target);
    try {
      const snapshot = requestData?.snapshot;
      const result = snapshot?.model === model && snapshot.source === source && snapshot.version === version
        ? snapshot.items : await provider.provide(context);
      if (request !== generation || providers.get(id) !== provider) return;
      if (target.getModel() !== model || model.getValue() !== source || model.getVersionId?.() !== version
        || (provider.isCurrent && !provider.isCurrent(context))) { stale(); return; }
      const items = validateCandidates(result);
      let found = items.findIndex(item => item.id === focusId);
      if (found < 0) found = provider.focusIndex?.(items, requestData) ?? -1;
      session = { provider, editor: target, model, source, version, context, items,
        position: found >= 0 ? found : Math.max(0, Math.min(fallbackPosition, items.length - 1)),
        manualSave: snapshot?.manualSave || false, needsSave: snapshot?.needsSave || false, choices: new Map(items.map(item => [item.id, snapshot?.choices.get(item.id) || item.options[0].id])) };
      render(!!requestData);
    } catch (error) { if (request === generation) {
      if (provider.isCurrent && !provider.isCurrent(context)) stale();
      else { message(error.message); controls(); }
    } }
    finally { if (pending === controller) pending = null; }
  }
  function render(preserveSelection = false) {
    if (!session) return;
    const item = current();
    session.content = session.provider.content?.(session, item) || {};
    const content = session.content;
    get('options').replaceChildren(); controls();
    message((content.message || '') + (session.needsSave ? ' 内容已修改，请保存。' : '')); comparison(content.comparison);
    get('title').textContent = content.title || session.provider.label;
    get('apply').textContent = content.applyLabel || '应用本条';
    for (const name of ['advance', 'expanded', 'all']) get(name).hidden = content[name] === false;
    if (item) {
      for (const value of content.options || []) {
        const label = document.createElement('label'), input = document.createElement('input');
        input.type = 'radio'; input.name = 'review-choice'; input.checked = session.choices.get(item.id) === value.id;
        input.onchange = () => { session.choices.set(item.id, value.id); render(); };
        label.append(input, document.createTextNode(value.label)); get('options').append(label);
      }
      selectField(preserveSelection); session.provider.onSelect?.(item, session.context, session.items);
    } else session.provider.onClose?.(session.context);
    void preview(); place(session.editor);
  }
  function comparison(rows = []) {
    get('comparison').replaceChildren();
    for (const row of rows) {
      const line = document.createElement('div');
      if (row.label) line.append(`${row.label}: `);
      for (const part of row.parts || []) {
        const span = document.createElement(part.changed ? 'mark' : 'span'); span.textContent = part.text; line.append(span);
      }
      get('comparison').append(line);
    }
  }
  function showNotice({ title = '', message: text, comparison: rows, anchor, layout }) {
    if (layout?.host && layout.host !== window.ReplacementReview) return layout.host.showNotice({ title, message: text, comparison: rows, anchor, layout });
    close(); panel.hidden = false; noticeAnchor = anchor; noticeLayout = layout;
    panel.classList.add('compact'); panel.dataset.side = layout?.side || 'html';
    get('title').textContent = title; get('options').replaceChildren();
    for (const name of ['switch', 'advance', 'expanded']) get(name).hidden = true;
    comparison(rows); message(text || ''); controls(); get('prev').parentElement.hidden = true; place();
  }
  function openForSelection(id, target, focusId, request) {
    if (session?.applying || session?.saving) return;
    if (session?.manualPending && session.provider.id === id && session.editor === target) return;
    if (session?.provider.id === id && session.editor === target && valid()) {
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
    if (pending && lastRequest?.id === id && lastRequest.editor === target && lastRequest.focusId === focusId) return;
    return open(id, target, focusId, 0, request);
  }
  function selectField(preserveSelection) {
    const selected = preserveSelection && session.editor.getSelection();
    const keep = selected && !selected.isEmpty();
    const range = keep ? selected : session.content?.range;
    session.anchor = range;
    if (range) {
      session.anchorOffset = session.model.getOffsetAt({ lineNumber: range.startLineNumber, column: range.startColumn });
      if (!preserveSelection) {
        session.editor.setSelection(range);
        session.editor.revealRangeInCenterIfOutsideViewport(range);
      }
    }
  }
  async function preview() {
    if (get('expanded').hidden || !get('expanded').open || !valid() || !current()) return;
    const saved = session, request = ++generation;
    try {
      const api = await window.MewEditorCore.loadMonaco();
      if (session !== saved || request !== generation || !valid() || !get('expanded').open) return;
      const data = await session.provider.preview?.(session, get('file').checked);
      if (!data || session !== saved || request !== generation || !valid()) return;
      const { before, after, language = 'plaintext' } = data;
      if (!view) view = api.editor.createDiffEditor(get('preview'), { automaticLayout: true, readOnly: true, originalEditable: false,
        renderSideBySide: false, minimap: { enabled: false }, scrollBeyondLastLine: false, diffAlgorithm: 'advanced' });
      clearPreview();
      previewModels = [api.editor.createModel(before, language), api.editor.createModel(after, language)];
      view.setModel({ original: previewModels[0], modified: previewModels[1] });
    } catch (error) { if (session === saved && request === generation) { clearPreview(); message(error.message); } }
  }
  async function apply(all, advance = false) {
    const saved = session;
    if (saved?.waitingApply) return;
    if (saved?.refreshTask || saved?.manualPending && !composing)
      await (saved.waitingApply = saved.refreshTask || refreshAfterEdit(saved)).finally(() => { saved.waitingApply = null; });
    if (session !== saved || !valid()) return;
    if (!current() || !saved.provider.apply || saved.applying) return;
    saved.applying = true; controls();
    try {
      // Providers receive candidate data; session lifecycle remains owned here.
      const result = await saved.provider.apply({ editor: saved.editor, model: saved.model,
        source: saved.source, version: saved.version, items: saved.items,
        position: saved.position, choices: saved.choices, context: { ...saved.context } }, all);
      if (session !== saved) return;
      const source = saved.model.getValue(), changed = source !== saved.source;
      Object.assign(saved, { items: result.items, choices: result.choices || saved.choices,
        position: result.position, context: result.context || saved.context,
        source, version: saved.model.getVersionId?.() });
      if (changed) saved.needsSave = true;
      Object.assign(saved.context, { source: saved.source, version: saved.version });
      if (saved.context.request) saved.context.request = { ...saved.context.request, snapshot: null };
      if (!valid()) { stale(); return; }
      render();
      saved.applying = false; controls();
      if (advance && !saved.items.length) await navigate(1);
      return true;
    } catch (error) {
      if (session !== saved) return;
      saved.applying = false;
      if (saved.model.getValue() !== saved.source) stale();
      message(error.message); controls();
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
  function place(target = session?.editor) {
    if (panel.hidden) return;
    const layout = presentation(), pdfSide = layout?.side === 'pdf';
    const node = pdfSide ? layout.container : target?.getDomNode(), rect = node?.getBoundingClientRect();
    if (layout) {
      panel.dataset.side = layout.side;
      get('switch').hidden = !layout.switchable;
      get('switch').textContent = layout.switchLabel || '';
    }
    const left = Math.max(8, rect?.left || 8), right = Math.min(innerWidth - 8, rect?.right || innerWidth - 8);
    panel.style.width = panel.classList.contains('compact') ? 'max-content' : `${Math.max(0, Math.min(460, right - left))}px`;
    panel.style.maxWidth = `${Math.max(0, Math.min(panel.classList.contains('compact') ? 280 : 460, right - left))}px`;
    panel.style.maxHeight = `${Math.max(100, Math.min(innerHeight - 16, (rect?.height || innerHeight) * (panel.classList.contains('compact') ? .45 : .7)))}px`;
    if (widget) { widgetEditor.layoutContentWidget(widget); return; }
    const range = session?.anchor;
    const position = !pdfSide && range ? target.getScrolledVisiblePosition({ lineNumber: range.startLineNumber, column: range.startColumn }) : null;
    const top = Math.max(8, rect?.top || 8), bottom = Math.min(innerHeight - 8, rect?.bottom || innerHeight - 8);
    const fragment = layout?.anchor || noticeAnchor;
    // Never show a new candidate at the preceding selection's coordinates.
    panel.style.visibility = pdfSide && current() && !fragment ? 'hidden' : '';
    const anchor = Math.max(top, Math.min(bottom, fragment?.top ?? (rect?.top || 0) + (position?.top ?? 40)));
    const height = panel.getBoundingClientRect().height;
    const above = anchor - height - 8;
    if (pdfSide && fragment) {
      const placement = layout.window?.PdfSelection?.popupPlacement(fragment, { left, right, top, bottom }, panel.offsetWidth, height)
        || { left: Math.max(left, Math.min(right - panel.offsetWidth, fragment.left)), height,
          top: Math.max(top, Math.min(bottom - height, above >= top ? above : fragment.bottom + 8)) };
      panel.style.visibility = '';
      if (placement) {
        panel.style.maxHeight = `${placement.height}px`;
        panel.style.top = `${placement.top}px`; panel.style.left = `${placement.left}px`;
      }
      return;
    } else {
      panel.style.top = `${Math.max(top, Math.min(bottom - height, above >= top ? above : (fragment?.bottom ?? anchor + (position?.height || 20)) + 8))}px`;
    }
    panel.style.left = `${Math.max(left, Math.min(right - panel.offsetWidth, fragment?.left ?? left + (position?.left || 0)))}px`;
  }
  async function switchSide() {
    if (!valid() || session.applying) return;
    const saved = session, item = current(), side = presentation()?.side === 'pdf' ? 'html' : 'pdf';
    const request = { ...saved.context.request, side, snapshot: {
      model: saved.model, source: saved.source, version: saved.version, context: saved.context,
      items: saved.items, choices: saved.choices, needsSave: saved.needsSave, manualSave: saved.manualSave
    } };
    const placement = saved.provider.presentation?.({ ...saved.context, request }, item);
    const destination = placement?.host;
    if (!destination) return;
    close(false);
    const opening = destination.open(saved.provider.id, saved.editor, item?.id, saved.position, request);
    const targetWindow = placement.window;
    // Re-select the existing browsing context while the click still has user
    // activation. Chromium can ignore focus() alone on the opener's window.
    if (targetWindow && targetWindow !== window) {
      if (!targetWindow.name) targetWindow.name = `mew-review-${window.crypto.randomUUID()}`;
      window.open('', targetWindow.name)?.focus();
    }
    placement.window?.focus();
    await opening;
    if (destination.isOpenFor(saved.provider.id, saved.editor)) {
      placement.window?.focus();
      placement.window?.document.querySelector('.replacement-review:not([hidden])')?.focus({ preventScroll: true });
    }
  }
  get('close').onclick = close;
  get('switch').onclick = () => void switchSide();
  get('prev').onclick = () => void navigate(-1);
  get('next').onclick = () => void navigate(1);
  get('apply').onclick = () => apply(false);
  get('advance').onclick = () => void apply(false, true);
  get('all').onclick = () => apply(true);
  async function save() {
    const saved = session, owner = workspace();
    if (!saved || !owner?.save || get('save').disabled) return;
    saved.saving = true; controls();
    try {
      if (!saved.manualSave && !await apply(false)) return;
      // A popup refresh must not cancel saving an already applied replacement.
      if (saved.editor.getModel() !== saved.model) throw new Error('文件已切换，未保存替换。');
      saved.manualSave = true;
      const source = saved.model.getValue();
      const result = await owner.save({ followPdf: false });
      if (result === false) throw new Error('保存失败，修改仍未保存，请重试。');
      if (session === saved && result !== false && saved.model.getValue() === source) {
        saved.needsSave = false; saved.manualSave = false;
        if (valid()) render();
        else message('已保存。差异更新中…');
      }
    }
    catch (error) { if (session === saved) message(error.message); }
    finally { saved.saving = false; controls(); }
  }
  get('save').onclick = () => save();
  get('file').onchange = () => void preview();
  get('expanded').ontoggle = () => { void preview(); place(); };
  panel.addEventListener('keydown', event => { event.stopPropagation(); if (event.key === 'Escape') close(); });
  document.addEventListener('pointerdown', event => {
    const position = session?.editor.getTargetAtClientPoint(event.clientX, event.clientY)?.position;
    const api = session?.editor.getDomNode()?.ownerDocument.defaultView.monaco;
    if (position && session.anchor && api?.Range.containsPosition(session.anchor, position)) return;
    if (!panel.hidden && !event.composedPath().includes(panel)) close(true, false);
  }, true);
  new ResizeObserver(queuePlace).observe(panel);
  window.addEventListener('resize', queuePlace);
  window.addEventListener('pagehide', () => { close(); view?.dispose(); });
  window.ReplacementReview = {
    open, openForSelection, showNotice, close, refreshMenu: updateMenu,
    isOpenFor(id, target) { return !panel.hidden && (session?.provider.id === id && session.editor === target || lastRequest?.id === id && lastRequest.editor === target); },
    invalidate(id, changed = () => true) { if (session?.provider.id === id && changed(session.context)) stale(); },
    register(provider) {
      if (!provider?.id || (typeof provider.provide !== 'function' && typeof provider.setEnabled !== 'function')) throw new Error('功能需要 id 和 provide(context) 或 setEnabled(enabled)');
      if (providers.has(provider.id)) throw new Error(`审阅功能已注册：${provider.id}`);
      providers.set(provider.id, provider); updateMenu();
      return () => { if (session?.provider === provider || lastRequest?.id === provider.id) close(); providers.delete(provider.id); updateMenu(); };
    }
  };
  updateMenu();
})();
