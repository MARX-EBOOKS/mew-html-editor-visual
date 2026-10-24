// PDF mapping, review candidates, provider actions and highlights.
'use strict';
// Source/PDF mapping and candidate generation.
function reviewCandidates(index, targets = [], notice = null) {
  const items = [], seen = [];
  function claim(start, end) {
    let low = 0, high = seen.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (seen[middle].start < start) low = middle + 1; else high = middle;
    }
    if (seen[low]?.start === start || low && seen[low - 1].end > start
      || seen[low] && seen[low].start < end && seen[low].end > start) return false;
    seen.splice(low, 0, { start, end });
    return true;
  }
  const add = (start, parts, pdfRaw = '', pdfStart = 0) => {
    const projection = [];
    let left = start, right = pdfStart;
    for (const part of parts || []) {
      if (part.pdf.length) projection.push({ left, right, stop: right + part.pdf.length, part });
      left += part.html.length; right += part.pdf.length;
    }
    const project = (offset, endBias) => {
      let low = 0, high = projection.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (projection[middle].stop < offset) low = middle + 1; else high = middle;
      }
      const hit = projection[low];
      if (!hit) return left;
      if (!hit.part.changed) return hit.left + Math.max(0, offset - hit.right);
      if (offset <= hit.right) return hit.left;
      return endBias || offset === hit.stop ? hit.left + hit.part.html.length : hit.left;
    };
    for (const part of parts || []) {
      const from = start, end = start += part.html.length, at = pdfStart;
      pdfStart += part.pdf.length;
      if (part.changed && significantText(part.html, index, from) !== significantText(part.pdf) && claim(from, end)) {
        const lineStart = pdfRaw.lastIndexOf('\n', Math.max(0, at - 1)) + 1;
        const nextLine = pdfRaw.indexOf('\n', at + part.pdf.length);
        const lineEnd = nextLine < 0 ? pdfRaw.length : nextLine;
        let a = pdfRaw ? Math.min(from, project(lineStart, false)) : index.raw.lastIndexOf('\n', Math.max(0, from - 1)) + 1;
        let b = pdfRaw ? Math.max(end, project(lineEnd, true)) : index.raw.indexOf('\n', end);
        if (b < 0) b = index.raw.length;
        a = Math.max(0, a);
        b = Math.min(index.raw.length, b);
        const before = index.raw.slice(a, from), after = index.raw.slice(end, b);
        const preview = { html: index.raw.slice(a, b), pdf: before + part.pdf + after };
        index.locator.comparisonParts(preview, [{ html: before, pdf: before, changed: false }, part, { html: after, pdf: after, changed: false }]);
        items.push({
          id: `${from}:${end}`, sourceStart: from, sourceEnd: end, preview,
          comparison: { html: part.html, pdf: part.pdf }, options: [
            { id: 'pdf', label: '替换', edits: toolbox.textEdits(index, from, end, part.pdf) }
          ]
        });
      }
    }
  };
  for (const target of targets.filter(Boolean)) for (const connection of index.connections.get(target) || [])
    add(connection.start, textDiff(index, target, connection)?.parts, target.raw, connection.targetStart);
  if (notice?.source && index.raw.slice(notice.source.start, notice.source.end) === notice.html)
    add(notice.source.start, index.locator.comparisonParts(notice));
  return items.sort((a, b) => a.sourceStart - b.sourceStart || a.sourceEnd - b.sourceEnd);
}
// Shared popup and session initialization.

// PDF comparison is one review provider. Selection synchronization remains independent.
let host, toolbox, textDiff, significantText, formatDifferences, PdfLocator, PdfSourceIndex, fallbackLocator, highlights;
let enabled = true, fontEnabled = true;
function readerWindow() {
  if (window.ReaderUI?.getPdfViewer) return window;
  try { if (window.opener && !window.opener.closed && window.opener.ReaderUI?.getPdfViewer) return window.opener; } catch { }
  return null;
}
function viewer() { return readerWindow()?.ReaderUI.getPdfViewer() || window.PdfSelection?.viewer; }
function selection() { return readerWindow()?.PdfSelection || window.PdfSelection; }
function getLocator() { return selection()?.locator || fallbackLocator; }
function presentation(context, item) {
  const reader = readerWindow() || window, source = context.editor?.getDomNode()?.ownerDocument.defaultView || window;
  const split = source !== reader, side = split ? context.request?.side || 'html' : 'pdf';
  const request = context.request;
  const element = request?.anchorElement, box = request?.anchorBox;
  const rect = (!item || side !== 'pdf') && element?.isConnected && element.getBoundingClientRect();
  const anchor = item && side === 'pdf' ? getLocator().reviewAnchor(item, context.index) : rect && box ? {
    left: rect.left + box.x * rect.width, top: rect.top + box.y * rect.height,
    bottom: rect.top + (box.y + box.h) * rect.height
  } : request?.anchor;
  const destination = side === 'pdf' ? reader : source;
  return {
    side, switchable: split, switchLabel: side === 'pdf' ? '查看HTML' : '查看PDF', host: destination.ReplacementReview, window: destination,
    container: viewer()?.container, eventBus: viewer()?.eventBus, anchor
  };
}
function isCurrent(context) { return context.pdf === viewer()?.pdfDocument; }
async function provide(context) {
  const pdf = context.pdf = viewer()?.pdfDocument;
  if (!pdf) throw new Error('请先在对照阅读器中打开 PDF。');
  const request = context.request;
  if (request?.pdf === pdf && request.notice?.source?.index.source === context.source) {
    context.targets = [...new Set([request.notice.target?.index, ...(request.targets || [])].filter(Boolean))];
    context.index = request.notice.source.index;
    return reviewItems(context.index, context.targets, request.notice, context.model);
  }
  const full = await getLocator().indexDocument(pdf);
  if (context.signal.aborted) return [];
  if (!full || !isCurrent(context)) throw new Error('PDF 已变化，正在等待对照文件就绪。');
  const index = context.index = getLocator().editorSourceIndex(context.model);
  context.targets = [full];
  getLocator().prepareSource(index, context.targets, pdf);
  if (fontEnabled) await getLocator().indexFonts(pdf, index, context.signal);
  return context.signal.aborted || !isCurrent(context) ? [] : reviewItems(index, context.targets, null, context.model);
}
function refreshCandidates(context, offset) {
  const locator = getLocator(), index = context.index = locator.editorSourceIndex(context.model);
  locator.prepareSource(index, context.targets, context.pdf);
  const items = reviewItems(index, context.targets, null, context.model);
  const choices = new Map();
  let found = -1;
  for (const [position, item] of items.entries()) {
    choices.set(item.id, item.options[0].id);
    if (found < 0 && ((index.starts[item.sourceEnd] ?? context.source.length) > offset
      || (index.starts[item.sourceStart] ?? context.source.length) >= offset)) found = position;
  }
  return { items, choices, position: found < 0 ? items.length : found };
}
function reviewItems(index, targets, notice, model) {
  let text = enabled ? reviewCandidates(index, targets) : [];
  const selected = enabled && selectionCandidate(index, notice, model);
  if (selected) text = [...text.filter(item => item.sourceEnd <= selected.sourceStart && item.sourceStart < selected.sourceStart
    || item.sourceStart >= selected.sourceEnd && item.sourceEnd > selected.sourceEnd), selected].sort((a, b) => a.sourceStart - b.sourceStart);
  const formats = fontEnabled ? formatDifferences(index, (targets || []).filter(Boolean)
    .flatMap(target => (index.connections.get(target) || []).map(connection => [connection, target]))) : [];
  const positions = new Map();
  let cursor = 0;
  for (const item of formats) {
    item.range = toolbox.rangeAt(model, index.starts[item.sourceStart], index.ends[item.sourceEnd - 1]);
    while (cursor < text.length && text[cursor].sourceEnd < item.sourceStart) cursor++;
    const nearby = text[cursor];
    positions.set(item, nearby && nearby.sourceStart <= item.sourceEnd ? nearby.sourceStart : item.sourceStart);
  }
  const order = item => positions.get(item) ?? item.sourceStart;
  return [...text, ...formats].sort((a, b) => order(a) - order(b) || Number(!!a.font) - Number(!!b.font))
    .map(item => ({ ...item, pdfSource: { index, start: item.sourceStart, end: item.sourceEnd } }));
}
function selectionCandidate(index, notice, model) {
  const source = notice?.source;
  if (!source) return null;
  const selected = reviewCandidates(index, [], notice);
  if (!selected.length) return null;
  return {
    id: `${source.start}:${source.end}`, sourceStart: source.start, sourceEnd: source.end,
    selection: true, comparison: notice,
    range: toolbox.rangeAt(model, index.starts[source.start] ?? index.source.length,
      index.ends[source.end - 1] ?? index.starts[source.start] ?? index.source.length),
    options: [{ id: 'pdf', label: '替换', edits: selected.flatMap(item => item.options[0].edits) }]
  };
}
function content(state, item) {
  const edits = item?.options[0].edits || [], formats = item?.formats || [item];
  const message = item?.font ? ['italic', 'bold'].flatMap(key => [...new Set(formats.filter(value => typeof value.font[key] === 'boolean'
    && value.font[key] !== value.htmlFont[key]).map(value =>
      `${key === 'italic' ? '斜体' : '粗体'}不一致（HTML ${value.htmlFont[key] ? '是' : '否'} / PDF ${value.font[key] ? '是' : '否'}${key === 'bold' && value.font.scanBoldRatio ? '，扫描估计' : ''}）`))]).join('；')
    : item ? '文字不一致' : state.items.length ? '已到末尾，可返回上一条。' : '没有可审阅的差异。';
  return {
    message,
    comparison: item?.font ? [] : getLocator().comparisonRows(item?.preview || item?.comparison, !item?.selection),
    apply: !item?.font || !!edits.length,
    range: item?.range || (edits.length ? toolbox.rangeAt(state.model, Math.min(...edits.map(edit => edit.start)), Math.max(...edits.map(edit => edit.end))) : null),
    options: [], applyLabel: item?.font ? '替换格式' : '替换', advance: false, expanded: false
  };
}
function pattern(value, index) {
  // Without source context, only the selected candidate may match itself.
  if (!index || !Number.isInteger(value.sourceStart) || !Number.isInteger(value.sourceEnd)) return value;
  const { raw } = index, start = value.sourceStart, end = value.sourceEnd;
  let before = start, after = end;
  const word = /^[\p{L}\p{M}\p{N}_'’\-]+$/u;
  while (before > 0 && word.test(raw.slice(before - (raw.codePointAt(before - 2) > 0xffff ? 2 : 1), before)))
    before -= raw.codePointAt(before - 2) > 0xffff ? 2 : 1;
  while (after < raw.length && word.test(String.fromCodePoint(raw.codePointAt(after))))
    after += raw.codePointAt(after) > 0xffff ? 2 : 1;
  const prefix = raw.slice(before, start), suffix = raw.slice(end, after);
  if ([...raw.slice(before, after)].length < 2
    && [...(prefix + (value.comparison?.pdf ?? value.text ?? '') + suffix)].length < 2) return value;
  return JSON.stringify([!!value.font, ...(value.font ? [value.text,
  ...['italic', 'bold'].flatMap(key => [value.htmlFont[key], value.font[key]])] : [value.comparison?.html, value.comparison?.pdf]),
    prefix, suffix]);
}
function apply(state, all) {
  const item = state.items[state.position];
  if (all || item?.font) getLocator().prepareSource(state.context.index, state.context.targets, state.context.pdf);
  const key = item && pattern(item, state.context.index), selected = all ? state.items
    : state.items.filter(value => pattern(value, state.context.index) === key);
  const edits = [], formats = [];
  for (const value of selected) {
    if (value.font) formats.push(value);
    else edits.push(...value.options[0].edits);
  }
  if (fontEnabled && formats.length) for (const candidate of formatDifferences(state.context.index, (state.context.targets || []).filter(Boolean)
    .flatMap(target => (state.context.index.connections.get(target) || []).map(connection => [connection, target]))))
    if (formats.some(value => candidate.sourceStart < value.sourceEnd && candidate.sourceEnd > value.sourceStart))
      edits.push(...candidate.options[0].edits);
  const checked = toolbox.validateEdits(state.source, edits);
  const offset = state.context.index.starts[item.sourceStart] ?? state.source.length;
  const shifted = offset + checked.reduce((delta, edit) => delta + (edit.end <= offset
    ? edit.text.length - (edit.end - edit.start) : 0), 0);
  toolbox.applyEdits(state.editor, state.model, state.version, state.source, checked);
  const source = state.model.getValue();
  const context = { ...state.context, source, version: state.model.getVersionId?.() };
  // Regenerate ranges and expected text from the new source, including overlapping format changes.
  return { ...refreshCandidates(context, shifted), context };
}

const review = {
  compact: true, content, apply, presentation, isCurrent, provide,
  refreshAfterEdit: refreshCandidates,
  onSelect(item, context, items) {
    const key = pattern(item, context.index);
    selection()?.showReviewPointer(context.editor, items.filter(value => pattern(value, context.index) === key));
  },
  onClose(context) { selection()?.clearReviewPointer(context.editor); }
};
function onSources(event) {
  const { editor, index, targets, enabled } = event.detail;
  if (!editor?.createDecorationsCollection) return;
  if (index) getLocator().prepareSource(index, targets, event.detail.pdf);
  const connections = index ? targets.flatMap(target => (index.connections.get(target) || []).map(item => [item, target])) : [];
  const key = [index, enabled, editor.getModel(), ...connections.flatMap(([item, target]) => [item, target, target.fontVersion])];
  highlights.updateSource(editor, key, () => enabled && index ? toolbox.sourceDecorations(index, connections, editor.getModel()) : [],
    '.mew-ocr-diff-line{border-left:3px solid #d58b24;margin-left:3px;cursor:pointer}.mew-ocr-diff-text{background:rgba(255,166,40,.3);border-bottom:1px solid #d58b24;cursor:pointer}.mew-ocr-diff-insert{border-left:2px solid #d58b24;margin-left:-1px;cursor:pointer}');
}
// The independent selection module publishes data, never review UI calls.
let listeningWindow = null;
let dismissed = null;
function onClose(event) {
  if (!['pdf-ocr', 'pdf-font'].includes(event.detail.id)) return;
  const { editor, model } = event.detail;
  dismissed = { editor, model, version: model.getVersionId?.(), range: editor.getSelection()?.toString(), interaction: selection()?.interactionId };
}
function onDifference(event) {
  if (!enabled && !fontEnabled) return;
  const data = event.detail, editor = data.editor, model = editor?.getModel();
  const readerHost = listeningWindow?.ReplacementReview;
  const destination = ['pdf-ocr', 'pdf-font'].some(id => readerHost?.isOpenFor(id, editor)) ? readerHost
    : editor?.getDomNode()?.ownerDocument.defaultView.ReplacementReview || readerHost;
  if (destination !== host || data.pdf !== viewer()?.pdfDocument || (data.model && model !== data.model)) return;
  if (dismissed?.editor === editor && dismissed.model === model && dismissed.version === model?.getVersionId?.()
    && dismissed.range === editor?.getSelection()?.toString() && dismissed.interaction === data.interactionId) return;
  dismissed = null;
  const changed = data.notices.find(value => typeof value.html === 'string' && typeof value.pdf === 'string'
    && getLocator().comparisonParts(value).some(part => part.changed));
  const notice = changed || data.notices.find(value => value.source) || data.notices[0];
  if (!notice || notice.source && model && notice.source.index.source !== model.getValue()) return;
  if (!changed) {
    if (notice.source && model) {
      const index = notice.source.index;
      const targets = [...new Set([notice.target?.index, ...(data.targets || [])].filter(Boolean))];
      // Compare the selected PDF layer even before background page mapping
      // has populated the source's connections (including exact text hits).
      if (notice.target && getLocator().normalized(index.raw.slice(notice.source.start, notice.source.end)).text
        === getLocator().normalized(notice.target.index.raw.slice(notice.target.start, notice.target.end)).text) {
        index.rememberConnection(notice.source.start, notice.source.end, notice.target.index, { start: notice.target.start, end: notice.target.end });
      }
      const differences = fontEnabled ? formatDifferences(index, targets
        .flatMap(target => (index.connections.get(target) || []).map(connection => [connection, target]))) : [];
      const item = differences.find(item => item.sourceStart < notice.source.end && item.sourceEnd > notice.source.start);
      if (item) {
        void host.openForSelection(enabled ? 'pdf-ocr' : 'pdf-font', editor, item.id,
          { ...data, targets, notice, kind: 'font' }); return;
      }
    }
    return;
  }
  if (!enabled) return;
  if (!notice.source || !model) {
    host.showNotice({
      title: 'PDF 文字差异', message: '文字不一致', comparison: getLocator().comparisonRows(notice, false), anchor: data.anchor,
      layout: presentation({ editor, request: data })
    }); return;
  }
  void host.openForSelection('pdf-ocr', editor, `${notice.source.start}:${notice.source.end}`, { ...data, notice });
}
function bind() {
  const target = readerWindow() || window;
  if (target === listeningWindow) return;
  listeningWindow?.removeEventListener('pdf-selection-difference', onDifference);
  // Only the reader owns decorations, including those in its paired editor.
  if (listeningWindow === window) {
    window.removeEventListener('pdf-selection-sources', onSources);
    window.removeEventListener('pdf-selection-reset', highlights.clearMarks);
    highlights.clearMarks();
  }
  listeningWindow = target; target.addEventListener('pdf-selection-difference', onDifference);
  if (target === window) {
    window.addEventListener('pdf-selection-sources', onSources);
    window.addEventListener('pdf-selection-reset', highlights.clearMarks);
  }
}
window.PdfReviewReady = (async () => {
  if (!window.PdfSelectionDiff) await import('./pdf-selection-diff.js');
  await window.PdfSelectionDiff.loadMonaco();
  toolbox = window.PdfSelectionDiff;
  ({ textDiff, significantText, formatDifferences, PdfLocator, PdfSourceIndex } = toolbox);
  if (!window.ReplacementReview || !window.ReviewHighlights) await import('./replacement-review.js');
  host = window.ReplacementReview;
  try { enabled = localStorage.getItem('mew.pdf-review.enabled') !== 'false'; } catch { }
  try { fontEnabled = localStorage.getItem('mew.pdf-review.font-enabled') !== 'false'; } catch { }
  fallbackLocator = new PdfLocator({}, {
    document, getPdf: () => viewer()?.pdfDocument,
    isCurrent: pdf => viewer()?.pdfDocument === pdf,
    waitForIdle: () => new Promise(resolve => setTimeout(resolve, 0))
  });
  highlights = window.ReviewHighlights.create({
    document,
    classes: { selection: 'mew-pdf-selection-highlight', pointer: 'mew-pdf-review-pointer', caret: 'mew-pdf-selection-caret' }
  });
  const unregister = [host.register({
    ...review,
    id: 'pdf-ocr', label: 'PDF 文字差异审阅', isEnabled: () => enabled,
    focusIndex(items, request) {
      const offset = request?.notice?.source?.start;
      if (offset === undefined) return -1;
      const found = items.findIndex(item => !!item.font === (request?.kind === 'font')
        && (item.sourceEnd > offset || item.sourceStart >= offset));
      return found < 0 ? items.length - 1 : found;
    },
    containsSelection(item, request) {
      const source = request?.notice?.source;
      return source && item && item.sourceStart === source.start && item.sourceEnd === source.end;
    },
    setEnabled(value) {
      enabled = value;
      try { localStorage.setItem('mew.pdf-review.enabled', String(value)); } catch { }
      host.invalidate('pdf-font');
    }
  }), host.register({
    ...review,
    id: 'pdf-font', label: 'PDF 斜体／粗体探测',
    isEnabled: () => fontEnabled,
    setEnabled(value) {
      fontEnabled = value;
      try { localStorage.setItem('mew.pdf-review.font-enabled', String(value)); } catch { }
      host.invalidate('pdf-ocr');
    },
    focusIndex(items, request) {
      const start = request?.notice?.source?.start;
      return start === undefined ? -1 : items.findIndex(item => item.sourceEnd > start);
    },
    containsSelection(item, request) {
      const source = request?.notice?.source;
      return source && item.sourceStart < source.end && item.sourceEnd > source.start;
    }
  }), host.register({
    id: 'pdf-selection', label: 'PDF 与源码差异高亮', available: () => !!selection(),
    isEnabled: () => selection()?.enabled === true,
    setEnabled(value) { selection()?.setDiffHighlight(value); }
  }), host.register({
    id: 'pdf-selection-sync', label: 'PDF 与源码选区联动', available: () => !!selection(),
    isEnabled: () => selection()?.selectionEnabled === true,
    setEnabled(value) { selection()?.setSelectionHighlight(value); }
  })];
  window.PdfReviewProvider = {
    PdfLocator, PdfSourceIndex, reviewCandidates,
    measureHighlights: highlights.measureHighlights, paintHighlight: highlights.paintHighlight, clearHighlights: highlights.clearHighlights,
    getHighlight: highlights.getHighlight,
    readPageFonts: toolbox.readPageFonts,
    layerFonts: toolbox.layerFonts,
    selectionRange: highlights.selectionRange
  };
  window.addEventListener('replacement-review-closed', onClose);
  bind();
  let previousPdf = viewer()?.pdfDocument, previousApi = selection(), previousEnabled = previousApi?.enabled;
  const poll = setInterval(() => {
    bind();
    const pdf = viewer()?.pdfDocument, api = selection(), state = api?.enabled;
    if (previousPdf !== pdf) {
      previousPdf = pdf;
      for (const id of ['pdf-ocr', 'pdf-font']) host.invalidate(id, context => context.pdf !== pdf);
    }
    if (previousApi !== api || previousEnabled !== state) {
      previousApi = api; previousEnabled = state; host.refreshMenu();
    }
  }, 500);
  window.addEventListener('pagehide', () => { clearInterval(poll); highlights.dispose(); window.removeEventListener('pdf-selection-sources', onSources); window.removeEventListener('pdf-selection-reset', highlights.clearMarks); listeningWindow?.removeEventListener('pdf-selection-difference', onDifference); window.removeEventListener('replacement-review-closed', onClose); unregister.forEach(dispose => dispose()); });
  return window.PdfReviewProvider;
})();
