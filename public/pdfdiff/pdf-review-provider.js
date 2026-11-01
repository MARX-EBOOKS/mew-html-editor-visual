// PDF mapping, review candidates, provider actions and highlights.
'use strict';
// Source/PDF mapping and candidate generation.
const pageTexts = new WeakMap();
const fontPages = new WeakMap(), pageFontItems = new WeakMap();
class PdfLocator {
  documents = new WeakMap();
  sourceIndexes = new WeakMap();
  reviewAnchors = new WeakMap();
  reviewLists = new WeakMap();
  dismissed = null;
  textEnabled = true;
  fontStyles = ['italic', 'bold'];

  constructor(options = {}, environment = {}) {
    this.options = options;
    this.environment = environment;
    this.pdf = environment.getPdf?.() || {};
    this.document = environment.document || window.document;
  }

  textItemBaseline(item) {
    const [a, b, , , x, y] = item.transform; // Compare baselines at the same horizontal origin on tilted scans.
    return y - (a ? x * b / a : 0);
  }

  fontStyle(font, fallback = '', css = {}) {
    const name = font?.name || fallback;
    // Tesseract placeholder flags do not describe the recognized text.
    if (/glyphlessfont/i.test(name)) return { name, italic: null, bold: null,
      reason: 'GlyphLessFont 占位字体未保留 OCR 粗斜体信息' };
    const italic = /italic|oblique/i.test(css.fontStyle || '')
      || (typeof font?.italic === 'boolean' ? font.italic : /italic|oblique|kursiv/i.test(name) ? true : null);
    const bold = /bold/i.test(css.fontWeight || '') || Number(css.fontWeight) >= 600 || font?.black === true
      || (typeof font?.bold === 'boolean' ? font.bold : /bold|black|heavy|demi|semibold|fett/i.test(name) ? true : null);
    return { name, italic, bold };
  }

  textItemFont(fonts, item) {
    return fonts?.get(JSON.stringify([item.fontName, item.str, item.transform, item.width])) || fonts?.get(item.fontName);
  }

  sourceHover(item, model, command) {
    const escape = text => JSON.stringify(text.trim() ? text : '').replace(/[\\`*_{}\[\]()#+.!<>|~-]/g, '\\$&');
    const request = { model: model.uri?.toString(), version: model.getVersionId?.(), id: item.id };
    const pdf = command ? `[PDF:](command:${command}?${encodeURIComponent(JSON.stringify([request]))})` : 'PDF:';
    const htmlText = item.font ? this.fontSummary(item.formats, 'htmlFont') : escape(item.comparison.html);
    const pdfText = item.font ? this.fontSummary(item.formats, 'font') : escape(item.comparison.pdf);
    const save = command && !item.missing ? `\n\n[替换&保存](command:${command}?${encodeURIComponent(JSON.stringify([{ ...request, save: true }]))})` : '';
    return { value: (item.missing ? `${pdf} PDF OCR 缺少相关文字。` : `HTML: ${htmlText}\n\n${pdf} ${pdfText}`) + save,
      isTrusted: command ? { enabledCommands: [command] } : false };
  }

  fontSummary(runs, field) {
    const states = [['italic', '斜体', new Set()], ['bold', '粗体', new Set()]], reasons = new Set();
    for (const value of runs) for (const [key, label, values] of states) {
      const run = value[field || 'font'];
      if (field) { values.add(run[key]); if (run.reason) reasons.add(run.reason); }
      else if (typeof run[key] === 'boolean' && run[key] !== value.htmlFont[key])
        values.add(`${label}不一致（HTML ${value.htmlFont[key] ? '是' : '否'} / PDF ${run[key] ? '是' : '否'}${key === 'bold' && run.scanBoldRatio ? '，扫描估计' : ''}）`);
    }
    return states.map(([, label, values]) => field ? `${label}：${!values.size || values.has(null) ? '未知' : values.size > 1 ? '混合' : values.has(true) ? '是' : '否'}` : [...values].join('；')).filter(Boolean).join('；')
      + (reasons.size ? `（${[...reasons].join('；')}）` : '');
  }

  prepareReview(context = {}) {
    if (selection()?.selectionEnabled === false) return null;
    if (context.type === 'replacement-review-closed') {
      const { id, editor, model } = context.detail;
      if (['pdf-ocr', 'pdf-font', 'pdf-bold'].includes(id)) this.dismissed = {
        editor, model, version: model.getVersionId?.(), range: editor.getSelection()?.toString(), interaction: selection()?.interactionId
      };
      return;
    }
    if (context.type === 'pdf-selection-difference') {
      const data = context.detail, editor = data.editor, model = editor?.getModel(), readerHost = listeningWindow?.ReplacementReview;
      const destination = data.side === 'pdf' || ['pdf-ocr', 'pdf-font', 'pdf-bold'].some(id => readerHost?.isOpenFor(id, editor)) ? readerHost
        : editor?.getDomNode()?.ownerDocument.defaultView.ReplacementReview || readerHost;
      if (destination !== host || this.dismissed?.editor === editor && this.dismissed.model === model && this.dismissed.version === model?.getVersionId?.()
        && this.dismissed.range === editor?.getSelection()?.toString() && this.dismissed.interaction === data.interactionId) return;
      this.reviewRequest = data;
      const prepared = this.reviewItems(), request = this.reviewRequest;
      delete this.reviewRequest;
      const item = request?.candidateId ? prepared.items.find(item => item.id === request.candidateId)
        : request?.kind === 'font' ? prepared.focus : prepared.selection;
      if (!request || request.notice.source && model && !item) return;
      if (item) request.focusId = item.id;
      this.dismissed = null;
      if (!request.notice.source || !model) return host.showNotice({
        title: 'PDF 文字差异', message: '文字不一致', comparison: this.comparisonRows(request.notice, false), anchor: data.anchor,
        layout: presentation({ editor, request })
      });
      return host.openForSelection(this.textEnabled ? 'pdf-ocr' : activeFontStyles().includes('italic') ? 'pdf-font' : 'pdf-bold', editor, request.focusId, request);
    }
    const pdf = viewer()?.pdfDocument, editor = selection()?.editor, model = editor?.getModel();
    if (!pdf || !model || context.signal?.aborted || context.pdf && context.pdf !== pdf ||
    context.editor && context.editor !== editor || context.model && context.model !== model || (context.version !== undefined ? context.version !== model.getVersionId() : context.source !== undefined && context.source !== model.getValue()))
      return null;
    Object.assign(context, { pdf, editor, model });
    const request = context.request, { source, target } = request?.notice || {};
    const selected = request?.pdf === pdf && context.source !== undefined && source?.index.source === context.source && source.index;
    this.editorSourceIndex(model, selected
      ? [...new Set([target?.index, ...(request.targets || [])].filter(Boolean))]
      : model === this.model && pdf === this.pdf ? this.index?.targets : undefined, selected || undefined);
    // A selection can confirm an exact text mapping before background preparation.
    if (selected && target && window.PdfSelectionDiff.normalized(this.index.raw.slice(source.start, source.end)).text
      === window.PdfSelectionDiff.normalized(target.index.raw.slice(target.start, target.end)).text)
      this.index.rememberConnection(source.start, source.end, target.index, { start: target.start, end: target.end });
    return this.index;
  }
  reviewItems(context = this.reviewRequest || {}) {
    if ((readerWindow()?.PdfSelection || window.PdfSelection)?.selectionEnabled === false) return { items: [] };
    const fontStyles = activeFontStyles();
    if (context.notices) {
      this.reviewRequest = null;
      const { notices, candidateId, kind, editor, model, pdf } = context;
      if (pdf !== viewer()?.pdfDocument || model && model !== editor?.getModel()
        || !this.textEnabled && !fontStyles.length) return { items: [] };
      const changed = candidateId && kind !== 'font' ? notices[0] : notices.find(value =>
        typeof value.html === 'string' && typeof value.pdf === 'string'
        && (!value.source || value.source.index.raw.slice(value.source.start, value.source.end) === value.html)
        && this.comparisonParts(value).some(part => part.changed));
      const notice = changed || notices.find(value => value.source) || notices[0];
      if (!notice || changed && !this.textEnabled || !changed && (!notice.source || !editor?.getModel())) return { items: [] };
      this.reviewRequest = { ...context, notice, kind: changed ? kind : 'font' };
      if (!notice.source || !editor?.getModel()) return { items: [] };
      context = { ...context, source: notice.source.index.source, version: notice.source.index.version, request: this.reviewRequest };
    }
    if (context.source !== undefined) { if (!this.prepareReview(context)) return { items: [] }; }
    else if (context.model || !this.index)
      this.editorSourceIndex(context.model, context.model && context.model !== this.model ? undefined : this.index?.targets);
    const { request, model, pdf } = context;
    if (context.source !== undefined && !(request?.pdf === pdf && request.notice?.source?.index === this.index)) {
      const source = context.source, version = context.version ?? model.getVersionId?.(), pages = (readerWindow() || window).ReaderUI?.getPdfSourcePages?.();
      return (fontStyles.length ? this.indexFonts(pdf, this.index, context.signal, pages) : this.indexDocument(pdf, pages)).then(full => {
        if (!full || source !== model.getValue() || !this.prepareReview({ ...context, source: undefined, version })) return { items: [] };
        this.editorSourceIndex(model, [...new Set([full, ...(this.environment.getTargets?.() || [])])]);
        return this.reviewItems({ request });
      });
    }
    const notice = !request?.candidateId && request?.notice;
    const shared = this.index.differences, fontKey = fontStyles.join(',');
    const cached = this.review;
    if (cached?.shared === shared && cached.notice === notice && cached.enabled === this.textEnabled && cached.fontKey === fontKey && cached.model === this.model) return cached;
    const source = this.textEnabled && notice?.source, selected = source && (notice.missing ? [] : this.index.reviewCandidates(notice));
    const selection = source && (notice.missing || selected.length && !shared.items.some(item => item.missing
      && item.sourceStart < source.end && item.sourceEnd > source.start)) && {
      id: `${source.start}:${source.end}`, sourceStart: source.start, sourceEnd: source.end,
      selection: true, comparison: notice, ...(notice.missing ? { missing: true } : {}),
      options: [{ id: 'pdf', label: '替换', edits: selected.flatMap(item => item.options[0].edits) }]
    };
    let items = this.textEnabled ? shared.items : shared.items.filter(item => item.font);
    if (selection) {
      const text = items.filter(item => !item.font);
      const selections = [selection], covered = new Set();
      const changes = selection.missing ? [] : this.comparisonParts(notice).filter(part => part.changed);
      const [change] = changes;
      let cursor = 0;
      // Anchor the selected context to confirmed faults in the existing queue.
      for (const anchor of change ? text : []) {
        if (anchor.missing || anchor.comparison.html !== change.html || anchor.comparison.pdf !== change.pdf) continue;
        const start = anchor.sourceStart - change.start, end = start + notice.html.length;
        if (start === selection.sourceStart || start < 0 || this.index.raw.slice(start, end) !== notice.html) continue;
        while (cursor < text.length && text[cursor].sourceEnd < start) cursor++;
        const faults = [];
        for (let at = cursor; at < text.length && text[at].sourceStart <= end; at++) {
          const item = text[at];
          if (item.sourceEnd <= start && item.sourceStart < start || item.sourceStart >= end && item.sourceEnd > end) continue;
          faults.push(item);
        }
        if (faults.length !== changes.length || faults.some((item, at) => item.missing
          || item.sourceStart !== start + changes[at].start || item.sourceEnd !== start + changes[at].end
          || item.comparison.html !== changes[at].html || item.comparison.pdf !== changes[at].pdf)) continue;
        selections.push({ ...selection, id: `${start}:${end}`, sourceStart: start, sourceEnd: end,
          comparison: { html: notice.html, pdf: notice.pdf, source: { index: this.index, start, end } },
          options: [{ id: 'pdf', label: '替换', edits: faults.flatMap(item => { covered.add(item); return item.options[0].edits; }) }] });
      }
      items = [...text.filter(item => !covered.has(item) && (item.missing && !selection.missing
        || item.sourceEnd <= selection.sourceStart && item.sourceStart < selection.sourceStart
        || item.sourceStart >= selection.sourceEnd && item.sourceEnd > selection.sourceEnd)),
      ...selections].sort((a, b) => a.sourceStart - b.sourceStart);
    }
    const data = { index: this.index, model: this.model, shared, notice, enabled: this.textEnabled, fontKey,
      items: this.index.formatDifferences(items, fontStyles), selection, entries: [], edits: [], plans: [], groups: new Map() };
    for (const value of data.items) {
      if (value.font && notice?.source && value.sourceStart < notice.source.end && value.sourceEnd > notice.source.start) data.focus ||= value;
      if (value.font || value.missing || value.selection) value.range ||= window.PdfSelectionDiff.rangeAt(this.model, value.sourceStart, value.sourceEnd, this.index);
      value.pdfSource ||= this.sourceEntry(this.index, value.sourceStart, value.sourceEnd, true);
      const key = pattern(value, this.index);
      if (!value.missing) data.plans.push(value.font ? { ...value.options[0],
        title: `替换格式：${value.text}（${this.fontSummary(value.formats)}）`,
        range: { start: this.index.starts[value.sourceStart], end: this.index.ends[value.sourceEnd - 1] }
      } : value.options[0]);
      let group = data.groups.get(key);
      if (!group) { group = { index: this.index, items: [], entries: [], edits: [] }; data.groups.set(key, group); this.reviewLists.set(group.items, group); }
      data.groups.set(value, group);
      group.items.push(value); group.entries.push(value.pdfSource); group.edits.push(...value.options[0].edits);
      data.entries.push(value.pdfSource); data.edits.push(...value.options[0].edits);
    }
    this.reviewLists.set(data.items, data);
    return this.review = data;
  }

  comparisonParts(value) {
    if (value.comparisonDiff?.html !== value.html || value.comparisonDiff.pdf !== value.pdf) {
      let offset = 0;
      value.comparisonDiff = { html: value.html, pdf: value.pdf, rows: [], parts: (window.PdfSelectionDiff.textDiff(value.html, value.pdf, true)?.parts || [{ html: value.html, pdf: value.pdf, changed: false }]).map(part => ({ ...part,
        start: offset, end: offset += part.html.length, changed: part.changed && window.PdfSelectionDiff.significantText(part.html) !== window.PdfSelectionDiff.significantText(part.pdf) })) };
    }
    return value.comparisonDiff.parts;
  }
  comparisonRows(value, compact = true, missing = value?.missing) {
    if (typeof value?.html !== 'string' || typeof value?.pdf !== 'string') return [];
    let parts = this.comparisonParts(value);
    const rows = value.comparisonDiff.rows, key = Number(compact) + 2 * !!missing;
    if (rows[key]) return rows[key];
    if (compact) {
      const first = parts.findIndex(part => part.changed), last = parts.findLastIndex(part => part.changed);
      if (first >= 0) {
        // Keep every changed run, including unchanged text between distant edits.
        // Reuse the original character diff rather than computing it again on a crop.
        const before = value.html.slice(0, parts[first].start);
        const after = value.html.slice(parts[last].end);
        const prefix = (before.length > 45 ? '…' : '') + before.slice(-45);
        const suffix = after.slice(0, 45) + (after.length > 45 ? '…' : '');
        parts = [...(prefix ? [{ html: prefix, pdf: prefix, changed: false }] : []),
        ...parts.slice(first, last + 1), ...(suffix ? [{ html: suffix, pdf: suffix, changed: false }] : [])];
      }
    }
    return rows[key] = ['html', 'pdf'].map(side => ({
      label: side.toUpperCase(), parts: parts.map(part => {
        const empty = part.changed && !part[side].trim() && !!part[side === 'html' ? 'pdf' : 'html'].trim();
        return { ...part, changed: part.changed && !missing, text: empty ? '' : part[side], source: !compact && value.source
          ? { index: value.source.index, start: value.source.start + part.start, end: value.source.start + part.end } : undefined };
      })
    }));
  }
  sourceEntry(index, start, end, marked, text = index.raw.slice(start, end)) {
    return { index, start, end, marked, text,
      before: index.raw.slice(Math.max(0, start - 160), start), after: index.raw.slice(end, end + 160) };
  }
  sourceIndex(source) {
    this.template ||= this.document.createElement("template");
    const starts = [], ends = [], formats = [];
    const stack = [{ name: '', italic: false, bold: false, tags: [] }];
    let raw = "", ignored = "";
    const tokens = /<!--[\s\S]*?(?:-->|$)|<![^>]*>|<\/?[a-z][^>"']*(?:(?:"[^"]*"|'[^']*')[^>"']*)*>|&(?:#\d+|#x[\da-f]+|[a-z][\da-z]+);|[^<&]+|[<&]/gi;
    for (const token of source.matchAll(tokens)) {
      const text = token[0], tag = /^<(\/?)\s*([a-z][\w:-]*)/i.exec(text);
      if (ignored) {
        if (tag?.[1] && tag[2].toLowerCase() === ignored) ignored = "";
        continue;
      }
      let value = text, encoded = false;
      if (tag) {
        const name = tag[2].toLowerCase();
        if (!tag[1] && /^(head|script|style)$/.test(name)) ignored = name;
        if (tag[1]) {
          const at = stack.findLastIndex(value => value.name === name);
          if (at > 0) {
            Object.assign(stack[at].definition, { closeStart: token.index, closeEnd: token.index + text.length, closing: text, rawEnd: raw.length });
            stack.length = at;
          }
        } else if (!ignored && !/^(area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/.test(name) && !/\/\s*>$/.test(text)) {
          const inherited = stack.at(-1);
          const definition = window.PdfSelectionDiff.htmlFontDefinition(name, text, raw.length, token.index);
          stack.push({
            name, definition, italic: definition.italic ?? inherited.italic, bold: definition.bold ?? inherited.bold,
            tags: definition.italic !== null || definition.bold !== null ? [...inherited.tags, definition] : inherited.tags
          });
        }
        value = (tag[1] && /^(p|div|li|h[1-6])$/.test(name)) || name === "br" ? "\n" : "";
        encoded = true;
      } else if (text.startsWith("<!")) value = "";
      else if (text.startsWith("&") && text.endsWith(";")) {
        this.template.innerHTML = text;
        value = this.template.content.textContent;
        encoded = value !== text;
      }
      raw += value;
      for (let i = 0; i < value.length; i++) {
        starts.push(token.index + (encoded ? 0 : i));
        ends.push(token.index + (encoded ? text.length : i + 1));
        formats.push(stack.at(-1));
      }
    }
    return new window.PdfSelectionDiff.PdfSourceIndex(this, { source, raw, starts, ends, formats });
  }
  editorSourceIndex(model = this.model, targets, index) {
    this.model = model;
    this.pdf = this.environment.getPdf?.() || this.pdf;
    let pairs = this.sourceIndexes.get(model);
    if (!pairs) this.sourceIndexes.set(model, pairs = new WeakMap());
    const previous = pairs.get(this.pdf), version = model.getVersionId?.();
    const source = version !== undefined && previous?.version === version ? previous.source : model.getValue();
    if (!index && previous?.source === source && previous.version === version) index = previous;
    const created = !index;
    if (created) index = this.sourceIndex(source);
    Object.assign(index, { version, model, targets: targets || index.targets || previous?.targets || [] });
    pairs.set(this.pdf, index);
    this.index = index;
    if (created && previous) {
      const { start, oldEnd, newEnd } = window.PdfSelectionDiff.changedRange(previous.raw, index.raw);
      const shift = range => range && (range.end <= start ? 0 : range.start >= oldEnd ? newEnd - oldEnd : null);
      // Keep confirmed, unchanged passages; only edited passages need a new diff.
      for (const target of new Set([...index.targets, ...(this.environment.getTargets?.() || []),
        this.getDocumentIndex(this.pdf, this.environment.getSourcePages?.())].filter(Boolean))) {
        const retained = (previous.connections.get(target) || []).flatMap(item => {
          const delta = shift(item);
          return delta === null ? [] : [{ ...item, start: item.start + delta, end: item.end + delta }];
        });
        if (retained.length) index.connections.set(target, retained);
        const reverse = (target.connections?.get(previous) || []).flatMap(item => {
          const delta = shift({ start: item.targetStart, end: item.targetEnd });
          return delta === null ? [] : [{ ...item, targetStart: item.targetStart + delta, targetEnd: item.targetEnd + delta }];
        });
        if (reverse.length) target.connections.set(index, reverse);
        const cached = previous.pageScopes.get(target), delta = shift(cached?.scope);
        if (cached?.scope && delta !== null) index.pageScopes.set(target, {
          ...cached, scope: { ...cached.scope, start: cached.scope.start + delta, end: cached.scope.end + delta },
          connections: cached.connections?.map(item => ({ ...item, start: item.start + delta, end: item.end + delta }))
        });
        // Formatting edits keep reverse scopes in the same text coordinates too.
        if (previous.raw === index.raw) {
          const reverseScope = target.pageScopes?.get(previous);
          if (reverseScope) target.pageScopes.set(index, reverseScope);
        }
      }
    }
    return index;
  }
  reviewAnchor(item, currentIndex = this.index) {
    const source = item?.pdfSource;
    if (!source) return null;
    let anchors = this.reviewAnchors.get(item);
    if (!anchors) this.reviewAnchors.set(item, anchors = new WeakMap());
    // Read the candidate's confirmed diff, including after its HTML offsets move.
    // Popup layout must never search again or prepare another source mapping.
    for (const { index } of this.environment.getVisiblePages?.() || []) {
      if (!index?.layer?.isConnected) continue;
      const connections = source.index.connections.get(index), currentConnections = currentIndex?.connections.get(index);
      let cached = anchors.get(index);
      if (!cached || cached.connections !== connections || cached.currentIndex !== currentIndex || cached.currentConnections !== currentConnections) {
        const hit = source.index.connectedRange(index, source.start, source.end, false, undefined, true)
          || currentIndex && currentIndex !== source.index && currentIndex.connectedRange(index, item.sourceStart, item.sourceEnd, false, undefined, true)
          || item.missing && source.index.missingRange(index, source.start, source.end);
        cached = { connections, currentIndex, currentConnections, hit };
        anchors.set(index, cached);
      }
      const hit = cached.hit;
      if (!hit) continue;
      const layer = index.layer.getBoundingClientRect();
      if (cached.bounds) return {
        left: layer.left + cached.bounds.left * layer.width,
        top: layer.top + cached.bounds.top * layer.height, bottom: layer.top + cached.bounds.bottom * layer.height
      };
      const end = index.raw.slice(hit.start, hit.end).trim() ? hit.end : hit.start;
      const bounds = { left: Infinity, top: Infinity, bottom: -Infinity };
      const range = this.document.createRange();
      for (const part of index.fontRuns(hit.start, end, true)) {
        range.setStart(part.node, Math.max(0, Math.min(part.node.length, hit.start - part.start)));
        range.setEnd(part.node, Math.max(0, Math.min(part.node.length, end - part.start)));
        for (const box of range.getClientRects()) if (box.height && (box.width || end === hit.start)) {
          bounds.left = Math.min(bounds.left, box.left);
          bounds.top = Math.min(bounds.top, box.top);
          bounds.bottom = Math.max(bounds.bottom, box.bottom);
        }
      }
      if (bounds.bottom !== -Infinity) {
        if (layer.width && layer.height) cached.bounds = {
          left: (bounds.left - layer.left) / layer.width,
          top: (bounds.top - layer.top) / layer.height, bottom: (bounds.bottom - layer.top) / layer.height
        };
        return bounds;
      }
    }
    return null;
  }
  readPageText(page) {
    if (!pageTexts.has(page)) pageTexts.set(page, Promise.resolve().then(() => page.getTextContent())
      .catch(error => {
        pageTexts.delete(page);
        throw error;
      }));
    return pageTexts.get(page);
  }
  async readPageFonts(page, items) {
    if (fontPages.has(page)) return fontPages.get(page);
    fontPages.set(page, (async () => {
      const ops = window.pdfjsLib?.OPS || { save: 10, restore: 11, setFont: 37, setTextRenderingMode: 38,
        showText: 44, showSpacedText: 45, nextLineShowText: 46, nextLineSetSpacingShowText: 47 };
      const textOps = new Set([ops.showText, ops.showSpacedText, ops.nextLineShowText, ops.nextLineSetSpacingShowText]);
      const invisibleFonts = new Set(), stack = [];
      let fontId = null, mode = 0, failed = false;
      try {
        const list = await page.getOperatorList?.();
        for (let i = 0; i < (list?.fnArray.length || 0); i++) {
          const fn = list.fnArray[i], args = list.argsArray[i];
          if (fn === ops.save) stack.push([fontId, mode]);
          else if (fn === ops.restore && stack.length) [fontId, mode] = stack.pop();
          else if (fn === ops.setFont) fontId = args[0];
          else if (fn === ops.setTextRenderingMode) mode = args[0];
          else if (textOps.has(fn)
            && (mode & 3) === 3) invisibleFonts.add(fontId);
        }
      } catch {
        failed = true; /* Text comparison remains available. */
      }
      const fonts = new Map(), textFonts = new Set();
      let letters = 0, boldLetters = 0;
      for (const item of items) {
        let style = fonts.get(item.fontName);
        if (!style) {
          const id = item.fontName, font = id && page.commonObjs?.has(id) ? page.commonObjs.get(id) : null;
          style = this.fontStyle(font, id || '');
          if (failed) {
            style.bold = style.italic = null;
            style.reason = '字体读取失败';
          } else if (invisibleFonts.has(id)) {
            // Invisible OCR retains declarations, not scan-derived style evidence.
            style.declaredBold = style.bold;
            style.declaredItalic = style.italic;
            style.reason ||= 'OCR 字体';
          }
          fonts.set(id, style);
        }
        const count = item.str?.replace(/\s/g, '').length || 0;
        if (count) textFonts.add(style);
        letters += count;
        if (style.bold === true) boldLetters += count;
      }
      const dominantBold = letters > 0 && boldLetters / letters >= 0.8;
      for (const key of ['bold', 'italic']) {
        if (!textFonts.size || !(key === 'bold' && dominantBold) && ![...textFonts].every(font => font?.[key] === true)) continue;
        const reason = key === 'bold' && boldLetters < letters ? '大部分文字声明为粗体' : `均为${key === 'bold' ? '粗体' : '斜体'}`;
        for (const font of textFonts) {
          if (font[key] !== true) continue;
          if (key === 'bold') font.declaredBold = true;
          font[key] = null;
          font.reason = font.reason ? `${font.reason}：${reason}` : reason;
        }
      }
      return fonts;
    })());
    return fontPages.get(page);
  }
  layerFonts(view, layer, refresh) {
    const page = view?.pdfPage, objects = page?.commonObjs, fonts = new Map();
    if (page?.getTextContent && !pageFontItems.has(page)) {
      pageFontItems.set(page, { items: [], fonts: new Map() });
      this.readPageText(page).then(async content => {
        const items = content.items.filter(item => item.str?.length);
        const fonts = await this.readPageFonts(page, items);
        pageFontItems.set(page, { items, fonts }); refresh();
      }).catch(() => pageFontItems.delete(page));
    }
    const data = pageFontItems.get(page), items = data?.items || [];
    const spans = (view?._textHighlighter?.textDivs || [...layer.querySelectorAll('span[role="presentation"]')]).filter(span => span.textContent);
    const names = new Map();
    if (spans.length === items.length && spans.every((span, i) => span.textContent === items[i].str))
      spans.forEach((span, i) => names.set(span, items[i]));
    return Object.assign(element => {
      const item = names.get(element);
      const observed = item && this.textItemFont(data?.fonts, item);
      if (observed) return observed;
      const css = element.ownerDocument.defaultView.getComputedStyle(element), family = css.fontFamily;
      const id = item?.fontName || element.dataset?.fontName;
      const key = `${id}:${family}:${css.fontStyle}:${css.fontWeight}`;
      if (!fonts.has(key)) {
        const font = id && objects?.has(id) ? objects.get(id) : objects && [...objects]
          .find(([, value]) => value.loadedName && family.includes(value.loadedName))?.[1];
        const style = data?.fonts.get(id) || this.fontStyle(font, family, css);
        fonts.set(key, page?.getTextContent && !data?.fonts.has(id)
          ? { ...style, bold: null, italic: null, reason: '字体渲染模式检查中' } : style);
      }
      return fonts.get(key);
    }, { items: names, spans });
  }
  async indexDocument(pdf, numbers) {
    let documents = this.documents.get(pdf);
    if (!documents) this.documents.set(pdf, documents = new Map());
    const key = numbers ? `pages:${numbers.join(',')}` : '';
    if (documents.has(key)) return documents.get(key).task;
    const cached = {};
    documents.set(key, cached);
    cached.task = (async () => {
      let raw = "", mappedStart = 0;
      const pages = [], mapped = { text: "", starts: [], ends: [] };
      for (const number of numbers || Array.from({ length: pdf.numPages }, (_, i) => i + 1)) {
        if (!this.environment.isCurrent(pdf)) return null;
        await this.environment.waitForIdle(pdf);
        if (!this.environment.isCurrent(pdf)) return null;
        const page = await pdf.getPage(number), content = await this.readPageText(page);
        if (!this.environment.isCurrent(pdf)) return null;
        const start = raw.length, parts = [];
        let previous = null, pageRaw = "";
        for (const item of content.items.filter(item => item.str?.trim()).sort((a, b) =>
          Math.round((this.textItemBaseline(b) - this.textItemBaseline(a)) / Math.max(a.height, b.height)) || a.transform[4] - b.transform[4])) {
          if (previous && !pageRaw.endsWith("\n")) {
            const lineBreak = Math.abs(this.textItemBaseline(item) - this.textItemBaseline(previous)) > Math.max(item.height, previous.height) * 0.5;
            if (lineBreak) pageRaw += "\n";
            else if (item.transform[4] - previous.transform[4] - previous.width > Math.max(item.height, previous.height) * 0.08) pageRaw += " ";
          }
          parts.push({ start: start + pageRaw.length, end: start + pageRaw.length + item.str.length, item });
          pageRaw += item.str;
          if (item.hasEOL) pageRaw += "\n";
          previous = item;
        }
        pages.push({ number, start, end: start + pageRaw.length, parts });
        raw += pageRaw + "\n";
        if (!/[-\u2010\u2011]\s*$/.test(raw.slice(mappedStart))) {
          window.PdfSelectionDiff.normalized(raw.slice(mappedStart), mapped, mappedStart); mappedStart = raw.length;
        }
      }
      window.PdfSelectionDiff.normalized(raw.slice(mappedStart), mapped, mappedStart);
      cached.index = new window.PdfSelectionDiff.PdfSourceIndex(this, { raw, pages, normalized: mapped, sourcePages: numbers });
      if (this.environment.isCurrent(pdf)) this.environment.onIndexed?.();
      return cached.index;
    })().catch(error => {
      documents.delete(key);
      throw error;
    });
    await cached.task;
    if (!cached.index) documents.delete(key);
    return cached.index || null;
  }
  getDocumentIndex(pdf, numbers) { return this.documents.get(pdf)?.get(numbers ? `pages:${numbers.join(',')}` : '')?.index; }
  async indexFonts(pdf, source, signal, numbers) {
    const index = await this.indexDocument(pdf, numbers);
    if (!index || signal?.aborted) return null;
    source?.diff();
    const ranges = source?.preparation.pairs.flatMap(([connection, target]) => target === index ? [connection] : []);
    for (const entry of index.pages) {
      if (entry.parts.every(part => part.font)
        || source && !ranges.some(hit => hit.targetStart < entry.end && hit.targetEnd > entry.start)) continue;
      if (signal?.aborted || !this.environment.isCurrent(pdf)) return null;
      // Share in-flight work too; separate reviews can request the same page.
      await (entry.fontTask ||= (async () => {
        await this.environment.waitForIdle(pdf);
        if (!this.environment.isCurrent(pdf)) return;
        const page = await pdf.getPage(entry.number);
        if (!this.environment.isCurrent(pdf)) return;
        const fonts = await this.readPageFonts(page, entry.parts.map(part => part.item));
        if (!this.environment.isCurrent(pdf)) return;
        for (const part of entry.parts) part.font = this.textItemFont(fonts, part.item);
        index.fontVersion = (index.fontVersion || 0) + 1;
      })().finally(() => { entry.fontTask = null; }));
    }
    return !signal?.aborted && this.environment.isCurrent(pdf) ? index : null;
  }
}
// Shared popup and session initialization.

// PDF comparison is one review provider. Selection synchronization remains independent.
let host, locator, highlights, listeningWindow = null;
function readerWindow() {
  if (window.ReaderUI?.getPdfViewer) return window;
  try { if (window.opener && !window.opener.closed && window.opener.ReaderUI?.getPdfViewer) return window.opener; } catch { }
  return null;
}
function viewer() { return readerWindow()?.ReaderUI.getPdfViewer() || window.PdfSelection?.viewer; }
function selection() { return readerWindow()?.PdfSelection || window.PdfSelection; }
function activeFontStyles() {
  const reader = readerWindow();
  return reader && reader !== window ? reader.PdfReviewProvider?.locator.fontStyles || locator.fontStyles : locator.fontStyles;
}
// Only the reader owns decorations, including those in its paired editor.
function bind(target = readerWindow() || window) {
  if (!locator) {
    locator = window.PdfSelection?.locator || new PdfLocator({}, {
      document, getPdf: () => viewer()?.pdfDocument,
      isCurrent: pdf => selection()?.selectionEnabled !== false && viewer()?.pdfDocument === pdf,
      waitForIdle: () => new Promise(resolve => setTimeout(resolve, 0))
    });
    try { locator.textEnabled = localStorage.getItem('mew.pdf-review.enabled') !== 'false'; } catch { }
    window.addEventListener('replacement-review-closed', locator.prepareReview = locator.prepareReview.bind(locator));
  }
  if (target === listeningWindow) return;
  listeningWindow?.removeEventListener('pdf-selection-difference', locator.prepareReview);
  if (listeningWindow === window) {
    window.removeEventListener('pdf-selection-sources', onSources);
    window.removeEventListener('pdf-selection-reset', highlights.clearMarks);
    highlights.clearMarks();
  }
  listeningWindow = target;
  target?.addEventListener('pdf-selection-difference', locator.prepareReview);
  if (target === window) {
    window.addEventListener('pdf-selection-sources', onSources);
    window.addEventListener('pdf-selection-reset', highlights.clearMarks);
  }
}
function presentation(context, item) {
  const reader = readerWindow() || window, source = context.editor?.getDomNode()?.ownerDocument.defaultView || window;
  const split = source !== reader, side = split ? context.request?.side || 'html' : 'pdf';
  const request = context.request;
  const element = request?.anchorElement, box = request?.anchorBox;
  const rect = element?.isConnected && element.getBoundingClientRect();
  const requested = (!item || item.sourceStart === request?.notice?.source?.start) && (rect && box ? {
    left: rect.left + box.x * rect.width, top: rect.top + box.y * rect.height,
    bottom: rect.top + (box.y + box.h) * rect.height
  } : request?.anchor);
  const anchor = item?.missing && requested
    || item && side === 'pdf' && locator.reviewAnchor(item) || requested;
  const destination = side === 'pdf' ? reader : source;
  return {
    side, switchable: split, switchLabel: side === 'pdf' ? '查看HTML' : '查看PDF', host: destination.ReplacementReview, window: destination,
    container: viewer()?.container, eventBus: viewer()?.eventBus, anchor,
    highlights: side === 'pdf' ? [anchor,
      ...(context.highlightedItems || []).map(value => value !== item && locator.reviewAnchor(value))
    ].filter(Boolean) : []
  };
}
function content(state, item) {
  const { model } = state.context, edits = item?.options[0].edits || [], data = locator.reviewLists.get(state.items);
  const message = item?.missing ? 'PDF OCR 缺少相关文字。' : item?.font ? locator.fontSummary(item.formats || [item])
    : item ? '文字不一致' : state.items.length ? '已到末尾，可返回上一条。' : '没有可审阅的差异。';
  return {
    message, edits: data?.groups.get(item)?.edits, allEdits: data?.edits,
    comparison: item?.font ? [] : locator.comparisonRows(item?.comparison, !item?.selection, item?.missing),
    previewDecorations: item?.font || item?.missing ? item.previewDecorations ||= (data?.index || item.pdfSource?.index || locator.index).sourceSegments(item.sourceStart, item.sourceEnd, true).map(segment => ({
      range: window.PdfSelectionDiff.rangeAt(model, segment.start, segment.end), options: { inlineClassName: item.missing ? 'mew-review-proposed' : 'mew-review-format', stickiness: 1 }
    })) : [],
    apply: !!edits.length,
    range: item?.range || (edits.length ? window.PdfSelectionDiff.rangeAt(model, Math.min(...edits.map(edit => edit.start)), Math.max(...edits.map(edit => edit.end))) : null),
    advance: false, expanded: false
  };
}
function pattern(value, index) {
  if (value.missing || !index) return value;
  const start = value.sourceStart, end = value.sourceEnd;
  // Unknown or foreign source context may only match the candidate itself.
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > index.raw.length
    || value.pdfSource && value.pdfSource.index !== index) return value;
  if (value.selection) return JSON.stringify(['selection', value.comparison.html, value.comparison.pdf]);
  let before = start, after = end;
  const word = /^[\p{L}\p{M}\p{N}_'’\-]+$/u;
  while (before > 0 && word.test(index.raw.slice(before - (index.raw.codePointAt(before - 2) > 0xffff ? 2 : 1), before)))
    before -= index.raw.codePointAt(before - 2) > 0xffff ? 2 : 1;
  while (after < index.raw.length && word.test(String.fromCodePoint(index.raw.codePointAt(after))))
    after += index.raw.codePointAt(after) > 0xffff ? 2 : 1;
  if (!value.font && value.options?.[0]) value.options[0].range = {
    start: index.starts[before] ?? index.source.length,
    end: after > before ? index.ends[after - 1] : index.starts[before] ?? index.source.length };
  const prefix = index.raw.slice(before, start), suffix = index.raw.slice(end, after);
  if ([...index.raw.slice(before, after)].length < 2
    && [...(prefix + (value.comparison?.pdf ?? value.text ?? '') + suffix)].length < 2) return value;
  const change = value.font ? [value.text, ...['italic', 'bold'].flatMap(key => [value.htmlFont[key], value.font[key]])]
      : [value.comparison?.html, value.comparison?.pdf];
  return JSON.stringify([!!value.font, change, prefix, suffix]);
}
function matchingItems(item, context, items) {
  if (!item) return [];
  const data = locator.reviewLists.get(items);
  if (data) return (data.groups?.get(item) || data.groups?.get(pattern(item, data.index)))?.items || [];
  const key = pattern(item, locator.index);
  return items.filter(value => pattern(value, locator.index) === key);
}
function apply(state, all) {
  const item = state.items[state.position], { editor, model, source, version } = state.context;
  const index = locator.reviewLists.get(state.items)?.index || locator.index;
  const offset = index.starts[item.sourceStart] ?? source.length;
  if (index !== locator.editorSourceIndex(model)) return { offset };
  const selected = all ? state.items : matchingItems(item, state.context, state.items), candidates = new Set(selected);
  if (!all && item.font) for (const candidate of state.items)
    if (candidate.font && selected.some(value => value.font && candidate.sourceStart < value.sourceEnd && candidate.sourceEnd > value.sourceStart))
      candidates.add(candidate);
  const edits = (candidates.size === selected.length && locator.reviewLists.get(selected)?.edits)
    || [...candidates].flatMap(value => value.options[0].edits);
  const position = state.items.findIndex((value, at) => at > state.position && !candidates.has(value));
  return { position: position < 0 ? state.items.length : position,
    apply: () => window.PdfSelectionDiff.applyEdits(editor, model, version, source, edits),
    offset: offset + edits.reduce((delta, edit) => delta + (edit.end <= offset
      ? edit.text.length - (edit.end - edit.start) : 0), 0) };
}

const review = {
  compact: true, content, apply, presentation, matchingItems,
  isCurrent: ({ source, ...context }) => (source === undefined || source === context.model.getValue()) && !!locator.prepareReview(context),
  available: editor => !!locator.prepareReview({ editor }),
  focusIndex(items, request) {
    const offset = request?.notice?.source?.start, text = this.id === 'pdf-ocr';
    if (offset === undefined) return -1;
    const found = items.findIndex(item => text ? !!item.font === (request?.kind === 'font')
      && (item.sourceEnd > offset || item.sourceStart >= offset) : item.sourceEnd > offset);
    return text && found < 0 ? items.length - 1 : found;
  },
  containsSelection(item, request) {
    const source = request?.notice?.source;
    return source && item && (this.id === 'pdf-ocr' ? item.sourceStart === source.start && item.sourceEnd === source.end
      : item.sourceStart < source.end && item.sourceEnd > source.start);
  },
  selectComparison(context, part) {
    const { index, start, end } = part.source, owner = index.locator.document.defaultView;
    context.editor.setSelection(window.PdfSelectionDiff.rangeAt(context.model, start, end, index));
    owner.dispatchEvent(new owner.CustomEvent('pdf-selection-difference', { detail: { ...context, ...context.request, interactionId: undefined, snapshot: null, notices: [part] } }));
  },
  onSelect(item, context, items, previewEnabled = false) {
    context.editor.getDomNode()?.classList.toggle('mew-review-preview', previewEnabled);
    context.highlightedItems = matchingItems(item, context, items);
    selection()?.showReviewPointer(context.editor, context.highlightedItems);
  },
  onClose(context) {
    delete context.highlightedItems;
    context.editor.getDomNode()?.classList.remove('mew-review-preview');
    selection()?.clearReviewPointer(context.editor);
  }
};
function onSources(event) {
  if (selection()?.selectionEnabled === false) return;
  const fontStyles = activeFontStyles();
  const { editor, targets, enabled: highlighted } = event.detail;
  const index = editor?.createDecorationsCollection && locator.prepareReview({ editor });
  if (!index) return;
  index.targets = targets;
  const model = editor.getModel(), data = locator.reviewItems();
  host.bindSuggestions(editor, currentModel => editor === selection()?.editor && locator.prepareReview({ editor, model: currentModel })
    ? locator.reviewItems().plans : []);
  if (editor.addAction && !editor.getAction('mew.pdf-difference')) {
    const action = editor.addAction({
      id: 'mew.pdf-difference', label: '查看 PDF 差异',
      run(_, request) {
        const model = editor.getModel(), owner = editor.getDomNode()?.ownerDocument.defaultView;
        if (!locator.prepareReview({ editor, model, version: request.version }) || model.uri.toString() !== request.model) return;
        const items = locator.reviewItems().items, item = items.find(item => item.id === request.id);
        if (!item) return;
        if (request.save) { 
          apply({ items, position: items.indexOf(item), context: { editor, model, source: model.getValue(), version: request.version } }, false).apply?.();
          return (owner.mewWorkbench || owner.readerMonaco).save({ followPdf: false, model }); 
        }
        const reader = readerWindow() || window, notice = { ...item.comparison, source: { index: locator.index, start: item.sourceStart, end: item.sourceEnd } };
        reader.dispatchEvent(new reader.CustomEvent('pdf-selection-difference', { detail: {
          editor, model, pdf: viewer()?.pdfDocument, notices: [notice], targets: locator.index.targets,
          candidateId: item.font ? item.id : undefined, kind: item.font ? 'font' : 'text', side: 'pdf'
        } }));
        if (owner && owner !== reader) {
          reader.name ||= `mew-review-${crypto.randomUUID()}`;
          owner.open('', reader.name)?.focus();
        }
      }
    });
    editor.onDidDispose(() => action.dispose());
  }
  const command = editor.getId?.() && `${editor.getId()}:mew.pdf-difference`;
  highlights.updateSource(editor, [index, highlighted, data, model],
    () => highlighted && index ? index.sourceDecorations(data.items, fontStyles, locator.textEnabled,
      item => locator.sourceHover(item, model, command)) : []);
  if (event.detail.diffEnabled && data) selection()?.showReviewPointer(editor, data.items, data);
}
window.PdfReviewReady = (async () => {
  if (!window.PdfSelectionDiff) await import('./pdf-selection-diff.js');
  await window.PdfSelectionDiff.ready;
  if (!window.ReplacementReview || !window.ReviewHighlights) await import('./replacement-review.js');
  host = window.ReplacementReview;
  highlights = window.ReviewHighlights.create({
    document,
    classes: { selection: 'mew-pdf-selection-highlight', pointer: 'mew-pdf-review-pointer', caret: 'mew-pdf-selection-caret' }
  });
  bind();
  window.PdfReviewProvider = {
    PdfLocator, locator, highlights,
    setFontEnabled(value, key, persist = true) {
      locator.fontStyles = ['italic', 'bold'].filter(name => !key || name === key ? value : locator.fontStyles.includes(name));
      if (persist) for (const style of key ? [key] : ['italic', 'bold'])
        selection()?.savePreference(`${style}Detection`, !!value, '无法保存字体探测设置');
      for (const id of ['pdf-ocr', 'pdf-font', 'pdf-bold']) host.invalidate(id);
      selection()?.clearReviewPointer();
      selection()?.refresh();
    }
  };
  const unregister = [host.register({
    ...review, locator,
    id: 'pdf-ocr', label: 'PDF 文字差异审阅', isEnabled: () => locator.textEnabled,
    setEnabled(value) {
      locator.textEnabled = value;
      try { localStorage.setItem('mew.pdf-review.enabled', String(value)); } catch { }
      for (const id of ['pdf-font', 'pdf-bold']) host.invalidate(id);
      selection()?.refresh();
    }
  }), ...['italic', 'bold'].map(key => host.register({
    ...review, locator,
    id: key === 'italic' ? 'pdf-font' : 'pdf-bold', label: key === 'italic' ? 'PDF 斜体探测' : 'PDF 粗体探测',
    isEnabled: () => activeFontStyles().includes(key),
    setEnabled(value) {
      (readerWindow()?.PdfReviewProvider || window.PdfReviewProvider).setFontEnabled(value, key);
    }
  })), ...[
    ['pdf-selection', 'PDF 差异高亮', 'enabled', value => selection()?.setDiffHighlight(value), true],
    ['source-diff', '源码差异高亮', 'sourceEnabled', value => selection()?.setDiffHighlight(value, 'source'), true],
    ['pdf-selection-sync', 'PDF 与源码选区联动', 'selectionEnabled', value => selection()?.setSelectionHighlight(value)]
  ].map(([id, label, setting, setEnabled, toggleOnly]) => host.register({
    id, label, toggleOnly, setEnabled, available: () => !!selection() && (setting === 'selectionEnabled' || selection().selectionEnabled), isEnabled: () => selection()?.[setting] === true
  }))];
  let previousPdf = viewer()?.pdfDocument, previousApi = selection(), previousEnabled, previousFonts = activeFontStyles();
  const poll = setInterval(() => {
    bind();
    const pdf = viewer()?.pdfDocument, api = selection(), fonts = activeFontStyles(), state = `${api?.enabled}:${api?.sourceEnabled}:${api?.selectionEnabled}:${fonts}`;
    if (previousPdf !== pdf || previousFonts !== fonts) {
      const fontsChanged = previousFonts !== fonts;
      previousPdf = pdf; previousFonts = fonts;
      for (const id of ['pdf-ocr', 'pdf-font', 'pdf-bold']) host.invalidate(id, context => fontsChanged || context.pdf !== pdf);
    }
    if (previousApi !== api || previousEnabled !== state) {
      previousApi = api; previousEnabled = state; host.refreshMenu();
    }
  }, 500);
  window.addEventListener('pagehide', () => { clearInterval(poll); bind(null); highlights.dispose(); window.removeEventListener('replacement-review-closed', locator.prepareReview); unregister.forEach(dispose => dispose()); });
  return window.PdfReviewProvider;
})();
