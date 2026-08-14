(() => {
  "use strict";
  const ui = window.ReaderUI;
  if (!ui) throw new Error("ReaderUI 未载入");

  const state = {
    config: null,
    volume: null,
    page: null,
    source: "",
    savedSource: "",
    mtime: null,
    editable: true,
    dirty: false,
    mode: "source",
    matches: [],
    match: -1,
    undo: [],
    redo: [],
    pendingVisualScroll: null,
    navigationRevision: 0,
    savePromise: null
  };

  const tags = [
    { label: "B", hotkey: "b", open: "<b>", close: "</b>" },
    { label: "I", hotkey: "i", open: "<i>", close: "</i>" },
    { label: "Q", hotkey: "q", open: "<blockquote>", close: "</blockquote>" },
    { label: "A", hotkey: "a", open: '<a href="" id="">', close: "</a>" },
    { label: "ID", hotkey: "x", open: '<a id="">', close: "</a>" },
    { label: "HREF", hotkey: "l", open: '<a href="">', close: "</a>" },
    { label: "FN", hotkey: "f", open: '<sup><a href="" id="">', close: "</a></sup>" },
    { label: "R", hotkey: "r", open: '<p align="right">', close: "</p>" },
    { label: "C", hotkey: "c", open: '<p align="center">', close: "</p>" },
    { label: "ltgt", title: "插入尖括号", open: "&lt;", close: "&gt;" },
    { label: "H1", hotkey: "1", open: "<h1>", close: "</h1>" },
    { label: "H2", hotkey: "2", open: "<h2>", close: "</h2>" },
    { label: "H3", hotkey: "3", open: "<h3>", close: "</h3>" },
    { label: "H4", hotkey: "4", open: "<h4>", close: "</h4>" },
    { label: "H5", hotkey: "5", open: "<h5>", close: "</h5>" },
    { label: "H6", hotkey: "6", open: "<h6>", close: "</h6>" },
    { label: "P", hotkey: "p", open: "<p>", close: "</p>" },
    { label: "BR", hotkey: "Enter", open: "<br>", close: "" },
    { label: "DIV", hotkey: "d", open: "<div>", close: "</div>" },
    { label: "SPAN", hotkey: "s", open: "<span>", close: "</span>" },
    { label: "ASIDE", title: "插入 aside", open: "<aside>", close: "</aside>" },
    { label: "SUP", title: "上标", open: "<sup>", close: "</sup>" },
    { label: "SUB", title: "下标", open: "<sub>", close: "</sub>" }
  ];
  const tagMap = new Map(tags.filter((tag) => tag.hotkey).map((tag) => [tag.hotkey.toLowerCase(), tag]));
  const attrs = [
    { label: "ID=", text: ' id=""', offset: 5 },
    { label: "CLASS=", text: ' class=""', offset: 8 },
    { label: "STYLE=", text: ' style=""', offset: 8 },
    { label: "hr", text: "<hr>", offset: 3 },
    { label: "hrs", text: '<hr style="width: 20%;">', offset: 22 },
    { label: "no-indent", text: ' style="text-indent: 0;"', offset: 23 }
  ];
  const blockTagNames = new Set(["p", "div", "h1", "h2", "h3", "h4", "h5", "h6"]);

  function escapeHtml(value) {
    return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
  }

  async function api(url, options) {
    const response = await fetch(url, options);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return data;
  }

  function currentVolume() {
    return state.config?.volumes.find((item) => item.id === state.volume);
  }

  function activeChapter() {
    let active = null;
    for (const item of currentVolume()?.toc || []) {
      if (item.page <= state.page) active = item;
      else break;
    }
    return active;
  }

  function pagePositionText() {
    const volume = currentVolume();
    if (!volume || state.page == null) return "";
    const index = volume.pages.indexOf(state.page);
    return `第 ${state.page} 页 · ${index + 1} / ${volume.pages.length}${state.dirty ? " *" : ""}`;
  }

  function markDirty(dirty = true) {
    state.dirty = dirty;
    ui.setDirty(dirty, pagePositionText());
  }

  function updateHistoryButtons() {
    ui.setHistoryButtons(Boolean(state.undo.length), Boolean(state.redo.length));
  }

  function sourceFromVisual() {
    const live = ui.getVisualDocument();
    if (!live?.body) return state.source;
    const parsed = new DOMParser().parseFromString(state.source, "text/html");
    parsed.body.innerHTML = live.body.innerHTML;
    parsed.head.querySelectorAll("[data-reader-editor]").forEach((node) => node.remove());
    const doctype = parsed.doctype ? `<!DOCTYPE ${parsed.doctype.name}>` : "<!doctype html>";
    return `${doctype}\n${parsed.documentElement.outerHTML}`;
  }

  function currentSource() {
    return state.mode === "visual" ? sourceFromVisual() : ui.getSource();
  }

  function currentSnapshot() {
    const selection = ui.getSourceSelection();
    const visual = ui.getVisualDocument();
    const scroll = state.mode === "visual"
      ? { top: visual?.scrollingElement?.scrollTop || 0, left: visual?.scrollingElement?.scrollLeft || 0 }
      : ui.sourceScroll();
    return { text: currentSource(), ...selection, scroll };
  }

  function remember() {
    if (state.page == null) return;
    const snapshot = currentSnapshot();
    const last = state.undo.at(-1);
    if (!last || last.text !== snapshot.text || last.start !== snapshot.start || last.end !== snapshot.end) {
      state.undo.push(snapshot);
      if (state.undo.length > 100) state.undo.shift();
    }
    state.redo = [];
    updateHistoryButtons();
  }

  function applySnapshot(snapshot) {
    state.source = snapshot.text;
    if (state.mode === "source") {
      ui.setSource(snapshot.text);
      ui.setSourceSelection(Math.min(snapshot.start, snapshot.text.length), Math.min(snapshot.end, snapshot.text.length));
      ui.setSourceScroll(snapshot.scroll);
      ui.focusSource();
      refreshHighlight();
    } else {
      state.pendingVisualScroll = snapshot.scroll;
      renderVisual();
    }
    markDirty(state.source !== state.savedSource);
    invalidateFind();
    updateHistoryButtons();
  }

  function undo() {
    const snapshot = state.undo.pop();
    if (!snapshot) return ui.notify("没有可撤销的操作");
    state.redo.push(currentSnapshot());
    applySnapshot(snapshot);
    ui.notify("已撤销");
  }

  function redo() {
    const snapshot = state.redo.pop();
    if (!snapshot) return ui.notify("没有可重做的操作");
    state.undo.push(currentSnapshot());
    applySnapshot(snapshot);
    ui.notify("已重做");
  }

  function injectEditorDocument(source) {
    const base = `<base href="/api/reader/resource/${encodeURIComponent(state.volume)}/">`;
    const style = '<style data-reader-editor>html{background:var(--reader-bg,#fff)}body{max-width:760px;margin:0 auto;padding:40px 48px 80px;background:var(--reader-bg,#fff);color:var(--reader-ink,#251f1b);caret-color:currentColor;font:18px/1.75 Georgia,"Noto Serif SC","SimSun",serif;outline:none}img{max-width:100%;height:auto}a{color:var(--reader-link,#8f2923)}.reader-ctrl-link a[href]{text-decoration:underline;cursor:pointer}body:focus{box-shadow:inset 0 0 0 2px #9d2b2430}</style>';
    if (/<head\b[^>]*>/i.test(source)) return source.replace(/<head\b[^>]*>/i, (head) => `${head}${base}${style}`);
    if (/<html\b[^>]*>/i.test(source)) return source.replace(/<html\b[^>]*>/i, (html) => `${html}<head>${base}${style}</head>`);
    return `<!doctype html><html><head>${base}${style}</head><body>${source}</body></html>`;
  }

  function renderVisual() {
    const scroll = state.pendingVisualScroll;
    state.pendingVisualScroll = null;
    ui.showVisual(injectEditorDocument(state.source), { editable: state.editable, scroll });
  }

  function setMode(mode = state.mode === "visual" ? "source" : "visual", { resetSourceScroll = false } = {}) {
    if (state.page == null) return;
    const next = mode === "visual" ? "visual" : "source";
    if (next !== state.mode) state.source = currentSource();
    state.mode = next;
    ui.setMode(next);
    if (next === "source") {
      ui.setSource(state.source);
      if (resetSourceScroll) ui.setSourceScroll({ top: 0, left: 0 });
      refreshHighlight();
    } else {
      renderVisual();
    }
    syncUrl();
  }

  function syncUrl() {
    if (state.volume == null || state.page == null) return;
    history.replaceState(null, "", `?volume=${encodeURIComponent(state.volume)}&page=${state.page}&mode=${state.mode}`);
  }

  function nearestPage(pages, requested) {
    if (!pages.length) return null;
    if (pages.includes(requested)) return requested;
    return pages.reduce((best, page) => Math.abs(page - requested) < Math.abs(best - requested) ? page : best);
  }

  function imagePages(volume, page) {
    const index = volume.pages.indexOf(page);
    const nextPage = volume.pages[index + 1];
    const end = Number.isFinite(nextPage) ? nextPage : page + 1;
    return Array.from({ length: Math.max(1, end - page) }, (_, offset) => page + offset);
  }

  function imageUrlForPage(url, sourcePage, targetPage) {
    if (targetPage === sourcePage) return url;
    const parsed = new URL(url, location.href);
    const parts = parsed.pathname.split("/");
    for (let index = parts.length - 1; index >= 0; index--) {
      const match = [...parts[index].matchAll(/\d+/g)].reverse().find((item) => Number(item[0]) === sourcePage);
      if (!match) continue;
      const replacement = String(targetPage).padStart(match[0].length, "0");
      parts[index] = parts[index].slice(0, match.index) + replacement + parts[index].slice(match.index + match[0].length);
      parsed.pathname = parts.join("/");
      return parsed.href;
    }
    return url;
  }

  function renderNavigation() {
    const volume = currentVolume();
    const index = volume.pages.indexOf(state.page);
    const chapter = activeChapter();
    ui.renderNavigation({
      chapterTitle: chapter?.title || volume.title,
      chapterPage: chapter?.page,
      pageContext: `${volume.shortTitle} · 第 ${state.page} 页`,
      pagePosition: pagePositionText(),
      page: state.page,
      volume: state.volume,
      hasPrevious: index > 0,
      hasNext: index < volume.pages.length - 1,
      editable: state.editable
    });
  }

  async function navigate(targetVolume, targetPage, force = false) {
    if (!force && state.dirty && !(await save())) return false;
    const volume = state.config.volumes.find((item) => item.id === String(targetVolume));
    if (!volume) return false;
    const page = nearestPage(volume.pages, Number(targetPage));
    if (page == null) return false;
    const revision = ++state.navigationRevision;
    try {
      const data = await api(`/api/reader/page/${encodeURIComponent(volume.id)}/${page}`);
      if (revision !== state.navigationRevision) return true;
      const volumeChanged = state.volume !== volume.id;
      state.volume = volume.id;
      state.page = page;
      state.source = data.text;
      state.savedSource = data.text;
      state.mtime = data.mtime;
      state.editable = data.editable;
      state.undo = [];
      state.redo = [];
      state.matches = [];
      state.match = -1;
      updateHistoryButtons();
      markDirty(false);
      if (volumeChanged) ui.renderToc(volume.shortTitle, volume.toc);
      // A textarea retains its scroll position when its value changes. A newly
      // opened file must begin at the top when shown as source.
      setMode(state.mode, { resetSourceScroll: true });
      renderNavigation();
      const urls = data.imageUrl
        ? imagePages(volume, page).map((imagePage) => imageUrlForPage(data.imageUrl, page, imagePage))
        : [];
      ui.setImages(urls);
      if (!state.editable) ui.notify("远程页面：只读");
      return true;
    } catch (error) {
      if (revision === state.navigationRevision) ui.notify(error.message, true);
      return false;
    }
  }

  async function performSave() {
    if (!state.editable || state.page == null) return true;
    state.source = currentSource();
    const context = {
      volume: state.volume,
      page: state.page,
      text: state.source,
      mtime: state.mtime
    };
    try {
      const result = await api(`/api/reader/page/${encodeURIComponent(context.volume)}/${context.page}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: context.text, mtime: context.mtime })
      });
      if (context.volume === state.volume && context.page === state.page) {
        state.mtime = result.mtime;
        state.savedSource = context.text;
        state.source = currentSource();
        markDirty(state.source !== context.text);
      }
      ui.notify("已保存");
      return true;
    } catch (error) {
      ui.notify(`保存失败：${error.message}`, true);
      return false;
    }
  }

  async function save() {
    while (state.dirty) {
      if (!state.savePromise) state.savePromise = performSave();
      const task = state.savePromise;
      const succeeded = await task;
      if (state.savePromise === task) state.savePromise = null;
      if (!succeeded) return false;
    }
    return true;
  }

  function attrToken(raw, value) {
    const link = raw.match(/^\s*href\s*=\s*(["'])([\s\S]*?)\1$/i);
    if (link) return `<span class="tok-string">${escapeHtml(link[1])}</span><span class="tok-link" data-href="${escapeHtml(link[2])}" title="Ctrl+click to open">${escapeHtml(link[2])}</span><span class="tok-string">${escapeHtml(link[1])}</span>`;
    return `<span class="tok-string">${escapeHtml(value)}</span>`;
  }

  function colorTag(raw) {
    if (raw.startsWith("<!--")) return `<span class="tok-comment">${escapeHtml(raw)}</span>`;
    let result = "", last = 0;
    const pattern = /(<\/?)([A-Za-z][\w:-]*)|([\w:-]+)(\s*=\s*)("[^"]*"|'[^']*')|([<>\/=])/g;
    for (let match; (match = pattern.exec(raw));) {
      result += escapeHtml(raw.slice(last, match.index));
      if (match[1]) result += `${escapeHtml(match[1])}<span class="tok-tag">${escapeHtml(match[2])}</span>`;
      else if (match[3]) result += `<span class="tok-attr">${escapeHtml(match[3])}</span>${escapeHtml(match[4])}${attrToken(match[0], match[5])}`;
      else result += escapeHtml(match[6]);
      last = match.index + match[0].length;
    }
    return result + escapeHtml(raw.slice(last));
  }

  function colorHtml(text) {
    let result = "", last = 0;
    const pattern = /<!--[\s\S]*?-->|<\/?[A-Za-z][^>]*?>/g;
    for (let match; (match = pattern.exec(text));) {
      result += escapeHtml(text.slice(last, match.index)) + colorTag(match[0]);
      last = match.index + match[0].length;
    }
    return result + escapeHtml(text.slice(last)) + (text.endsWith("\n") ? " " : "");
  }

  function refreshHighlight() {
    ui.updateHighlight(colorHtml(ui.getSource()));
  }

  function gotoAnchor(fragment) {
    const id = decodeURIComponent(fragment.slice(1));
    if (!id) return false;
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = new RegExp(`\\bid\\s*=\\s*(["'])${escaped}\\1`, "i").exec(ui.getSource());
    if (!match) return false;
    const start = match.index + match[0].lastIndexOf(id);
    ui.focusSource();
    ui.setSourceSelection(start, start + id.length);
    ui.scrollSourceSelectionIntoView(start);
    ui.notify(`已跳转到 ${fragment}`);
    return true;
  }

  function openSourceHref(href) {
    if (href.startsWith("#")) {
      if (!gotoAnchor(href)) ui.notify(`未找到锚点：${href}`);
      return;
    }
    const base = `/api/reader/resource/${encodeURIComponent(state.volume)}/`;
    window.open(new URL(href, location.origin + base).href, "_blank", "noopener");
  }

  function openHighlightedLink(event) {
    if (!(event.ctrlKey || event.metaKey)) return;
    const link = event.target.closest(".tok-link[data-href]");
    if (!link) return;
    event.preventDefault();
    openSourceHref(link.dataset.href);
  }

  function openVisualLink(event, doc) {
    const link = event.target.closest?.("a[href]");
    if (!link || !(event.ctrlKey || event.metaKey)) return;
    const href = link.getAttribute("href");
    event.preventDefault();
    if (href.startsWith("#")) {
      const id = decodeURIComponent(href.slice(1));
      const target = doc.getElementById(id) || doc.getElementsByName(id)[0];
      if (target) {
        target.scrollIntoView({ block: "center", inline: "nearest" });
        ui.notify(`已跳转到 ${href}`);
      } else ui.notify(`未找到锚点：${href}`);
      return;
    }
    window.open(new URL(href, doc.baseURI).href, "_blank", "noopener");
  }

  function trimVisualWordSelection(doc) {
    const selection = doc.getSelection();
    if (!selection || selection.rangeCount !== 1 || selection.isCollapsed) return;
    const range = selection.getRangeAt(0);
    const text = range.toString();
    if (!text || !text.trim()) return;
    const leading = text.length - text.trimStart().length;
    const trailing = text.length - text.trimEnd().length;
    if (!leading && !trailing) return;
    const root = range.commonAncestorContainer;
    const nodes = root.nodeType === doc.defaultView.Node.TEXT_NODE ? [root] : [];
    if (!nodes.length) {
      const walker = doc.createTreeWalker(root, doc.defaultView.NodeFilter.SHOW_TEXT);
      for (let node; (node = walker.nextNode());) {
        if (range.intersectsNode(node)) nodes.push(node);
      }
    }
    let remaining = leading;
    for (const node of nodes) {
      if (!remaining) break;
      const start = node === range.startContainer ? range.startOffset : 0;
      const cut = Math.min(remaining, node.textContent.length - start);
      range.setStart(node, start + cut);
      remaining -= cut;
    }
    remaining = trailing;
    for (let index = nodes.length - 1; index >= 0 && remaining; index--) {
      const node = nodes[index];
      const end = node === range.endContainer ? range.endOffset : node.textContent.length;
      const cut = Math.min(remaining, end);
      range.setEnd(node, end - cut);
      remaining -= cut;
    }
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function trimSourceWordSelection() {
    const text = ui.getSource();
    let { start, end } = ui.getSourceSelection();
    if (start === end) return;
    while (start < end && /\s/.test(text[start])) start += 1;
    while (end > start && /\s/.test(text[end - 1])) end -= 1;
    ui.setSourceSelection(start, end);
  }

  function tagInfo(open) {
    const match = String(open).match(/^<([a-z][\w:-]*)([^>]*)>/i);
    if (!match) return null;
    const name = match[1].toLowerCase();
    const align = match[2].match(/\balign\s*=\s*["']?([^"'\s>]+)/i)?.[1]?.toLowerCase() || "";
    return { name, kind: name === "p" && align ? `p:${align}` : name, block: blockTagNames.has(name) };
  }

  function elementTagInfo(element) {
    const name = element.tagName.toLowerCase();
    const align = (element.getAttribute("align") || "").toLowerCase();
    return { name, kind: name === "p" && align ? `p:${align}` : name };
  }

  function findTagContainer(text, start, end, names) {
    const pattern = /<\/?([A-Za-z][\w:-]*)\b(?:[^>"']|"[^"]*"|'[^']*')*>/g;
    const stack = [], candidates = [];
    for (let match; (match = pattern.exec(text));) {
      const name = match[1].toLowerCase();
      if (!names.has(name)) continue;
      const token = match[0];
      if (!token.startsWith("</") && !token.endsWith("/>")) {
        stack.push({ name, token, start: match.index, end: pattern.lastIndex });
        continue;
      }
      if (!token.startsWith("</")) continue;
      let index = stack.length - 1;
      while (index >= 0 && stack[index].name !== name) index -= 1;
      if (index < 0) continue;
      const open = stack.splice(index, 1)[0];
      const close = { token, start: match.index, end: pattern.lastIndex };
      const selectedWhole = open.start === start && close.end === end;
      if ((open.end <= start && end <= close.start) || selectedWhole) candidates.push({ open, close, selectedWhole });
    }
    return candidates.sort((a, b) => (a.close.end - a.open.start) - (b.close.end - b.open.start))[0] || null;
  }

  function setSourceWrapper(container, openTag = "", closeTag = "") {
    const text = ui.getSource();
    const selection = ui.getSourceSelection();
    const inner = text.slice(container.open.end, container.close.start);
    const relativeStart = container.selectedWhole ? 0 : selection.start - container.open.end;
    const relativeEnd = container.selectedWhole ? inner.length : selection.end - container.open.end;
    ui.replaceSourceRange(openTag + inner + closeTag, container.open.start, container.close.end, "select");
    ui.setSourceSelection(
      container.open.start + openTag.length + relativeStart,
      container.open.start + openTag.length + relativeEnd
    );
  }

  function selectVisualContents(element, doc) {
    const range = doc.createRange();
    range.selectNodeContents(element);
    const selection = doc.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function unwrapVisual(element, doc) {
    const parent = element.parentNode;
    const first = element.firstChild, last = element.lastChild;
    if (!parent) return;
    while (element.firstChild) parent.insertBefore(element.firstChild, element);
    element.remove();
    if (!first || !last) return;
    const range = doc.createRange();
    range.setStartBefore(first);
    range.setEndAfter(last);
    const selection = doc.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function replaceVisual(element, open, doc) {
    const template = doc.createElement("template");
    template.innerHTML = open;
    const replacement = template.content.firstElementChild;
    if (!replacement) return;
    while (element.firstChild) replacement.append(element.firstChild);
    element.replaceWith(replacement);
    selectVisualContents(replacement, doc);
  }

  function insertVisual(tag) {
    const doc = ui.getVisualDocument();
    if (!doc?.body || !state.editable) return;
    remember();
    const info = tagInfo(tag.open);
    const selection = doc.getSelection();
    const anchor = selection?.anchorNode?.nodeType === doc.defaultView.Node.ELEMENT_NODE
      ? selection.anchorNode : selection?.anchorNode?.parentElement;
    const container = info && anchor?.closest?.(info.block ? "p,div,h1,h2,h3,h4,h5,h6" : info.name);
    let action = "已插入";
    if (container && doc.body.contains(container)) {
      if (elementTagInfo(container).kind === info.kind) {
        unwrapVisual(container, doc);
        action = "已移除";
      } else {
        replaceVisual(container, tag.open, doc);
        action = "已替换";
      }
    } else {
      const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
      if (!range) return;
      const template = doc.createElement("template");
      const holder = doc.createElement("div");
      holder.append(range.cloneContents());
      template.innerHTML = tag.open + holder.innerHTML + tag.close;
      const fragment = template.content;
      const inserted = [...fragment.childNodes];
      range.deleteContents();
      range.insertNode(fragment);
      if (inserted.length) {
        const nextRange = doc.createRange();
        nextRange.setStartBefore(inserted[0]);
        nextRange.setEndAfter(inserted.at(-1));
        selection.removeAllRanges();
        selection.addRange(nextRange);
      }
    }
    markDirty();
    doc.body.focus();
    return action;
  }

  function insertSource(text, close = "", offset = null) {
    const info = tagInfo(text);
    const selection = ui.getSourceSelection();
    remember();
    let action = "已插入";
    if (info && close) {
      const names = info.block ? blockTagNames : new Set([info.name]);
      const container = findTagContainer(ui.getSource(), selection.start, selection.end, names);
      if (container) {
        const sameKind = tagInfo(container.open.token)?.kind === info.kind;
        setSourceWrapper(container, sameKind || !info.block ? "" : text, sameKind || !info.block ? "" : close);
        action = sameKind || !info.block ? "已移除" : "已替换";
      } else {
        const selected = ui.getSource().slice(selection.start, selection.end);
        ui.replaceSourceRange(text + selected + close, selection.start, selection.end, "end");
        if (!selected) ui.setSourceSelection(selection.start + text.length);
      }
    } else {
      const selected = ui.getSource().slice(selection.start, selection.end);
      ui.replaceSourceRange(text + selected + close, selection.start, selection.end, "end");
      if (!selected && close) ui.setSourceSelection(selection.start + (offset ?? text.length));
      else if (offset != null) ui.setSourceSelection(selection.start + offset);
    }
    state.source = ui.getSource();
    markDirty();
    invalidateFind();
    refreshHighlight();
    ui.focusSource();
    return action;
  }

  function editTag(tag) {
    const action = state.mode === "visual" ? insertVisual(tag) : insertSource(tag.open, tag.close);
    if (action) ui.notify(`${action} ${tag.label}`);
  }

  function compileFindPattern() {
    const options = ui.findOptions();
    if (!options.query) return null;
    const source = options.regex ? options.query : options.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return { pattern: new RegExp(source, `g${options.caseSensitive ? "" : "i"}`), options };
  }

  function findAll(reset = true) {
    if (reset) state.match = -1;
    state.matches = [];
    try {
      const compiled = compileFindPattern();
      if (!compiled) {
        ui.setFindInfo("");
        return;
      }
      for (let match; (match = compiled.pattern.exec(ui.getSource()));) {
        state.matches.push([match.index, match.index + match[0].length]);
        if (!match[0]) compiled.pattern.lastIndex += 1;
      }
      ui.setFindInfo(`${state.matches.length} 处`);
    } catch (error) {
      ui.setFindInfo(error.message);
    }
  }

  function invalidateFind() {
    findAll(true);
  }

  function nextMatch() {
    if (!state.matches.length) findAll(false);
    if (!state.matches.length) return;
    state.match = (state.match + 1) % state.matches.length;
    const [start, end] = state.matches[state.match];
    ui.focusSource();
    ui.setSourceSelection(start, end);
    ui.scrollSourceSelectionIntoView(start);
    ui.setFindInfo(`${state.match + 1}/${state.matches.length}`);
  }

  function replaceOne() {
    if (state.match < 0 || !state.matches[state.match]) nextMatch();
    if (state.match < 0 || !state.matches[state.match]) return;
    const [start, end] = state.matches[state.match];
    remember();
    ui.replaceSourceRange(ui.findOptions().replacement, start, end, "end");
    state.source = ui.getSource();
    markDirty();
    refreshHighlight();
    findAll(true);
  }

  function replaceAll() {
    try {
      const compiled = compileFindPattern();
      if (!compiled) return;
      remember();
      const replacement = compiled.options.replacement;
      const replaced = compiled.options.regex
        ? ui.getSource().replace(compiled.pattern, replacement)
        : ui.getSource().replace(compiled.pattern, () => replacement);
      ui.setSource(replaced);
      state.source = replaced;
      markDirty();
      refreshHighlight();
      findAll(true);
    } catch (error) {
      ui.setFindInfo(error.message);
    }
  }

  function adjacent(direction) {
    const pages = currentVolume()?.pages || [];
    const index = pages.indexOf(state.page);
    if (pages[index + direction] != null) navigate(state.volume, pages[index + direction]);
  }

  function handleKeyDown(event) {
    const key = event.key.toLowerCase();
    const command = event.ctrlKey || event.metaKey;
    const formField = event.target.matches?.("input, textarea:not(#editor), select");
    ui.setSourceLinkMode(command);
    if (command && key === "s") {
      event.preventDefault();
      save();
      return;
    }
    if (command && !formField && (key === "z" || key === "y")) {
      event.preventDefault();
      key === "y" || event.shiftKey ? redo() : undo();
      return;
    }
    if (event.key === "Escape") ui.setToc(false);
    if (formField) return;
    if (event.altKey && !command) {
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        adjacent(event.key === "ArrowLeft" ? -1 : 1);
        return;
      }
      const hotkey = event.key === "Enter" ? "enter" : key;
      const tag = tagMap.get(hotkey);
      if (tag) {
        event.preventDefault();
        editTag(tag);
      }
      return;
    }
    const editableTarget = event.target.matches?.("textarea,[contenteditable]") || event.target.isContentEditable;
    if (!editableTarget && (event.key === "ArrowLeft" || event.key === "ArrowRight")) adjacent(event.key === "ArrowLeft" ? -1 : 1);
  }

  async function changeVolume(id) {
    const volume = state.config.volumes.find((item) => item.id === id);
    if (!volume || !(await navigate(volume.id, volume.pages[0]))) renderNavigation();
  }

  async function init() {
    ui.init({
      mode: () => setMode(), save, undo, redo, volume: changeVolume,
      page: (page) => navigate(state.volume, page), adjacent,
      tag: (index) => editTag(tags[index]),
      attr: (index) => {
        if (state.mode === "visual") return ui.notify("属性按钮请在源代码模式使用");
        const attr = attrs[index];
        insertSource(attr.text, "", attr.offset);
      },
      beforeEdit: remember,
      sourceInput: () => { state.source = ui.getSource(); markDirty(); refreshHighlight(); invalidateFind(); },
      visualInput: () => markDirty(),
      sourceScroll: refreshHighlight,
      sourceDoubleClick: trimSourceWordSelection,
      visualDoubleClick: trimVisualWordSelection,
      visualClick: openVisualLink,
      highlightClick: openHighlightedLink,
      find: nextMatch,
      nextMatch,
      replace: replaceOne,
      replaceAll,
      findChanged: invalidateFind,
      keyDown: handleKeyDown,
      beforeUnload: (event) => {
        if (!state.dirty) return;
        event.preventDefault();
        event.returnValue = "";
      }
    });
    ui.renderTools(tags, attrs);
    updateHistoryButtons();
    try {
      state.config = await api("/api/reader/config");
      const params = new URLSearchParams(location.search);
      const requestedMode = params.get("mode");
      if (requestedMode === "source" || requestedMode === "visual") state.mode = requestedMode;
      const firstVolume = state.config.volumes.find((item) => item.id === params.get("volume")) || state.config.volumes[0];
      if (!firstVolume) throw new Error("配置中没有找到包含 HTML 页面的卷册");
      ui.renderVolumes(state.config.volumes, firstVolume.id);
      await navigate(firstVolume.id, Number(params.get("page")) || firstVolume.pages[0], true);
    } catch (error) {
      ui.renderNavigation({
        chapterTitle: "载入失败", chapterPage: null, pageContext: "", pagePosition: "",
        page: "", volume: "", hasPrevious: false, hasNext: false, editable: false
      });
      ui.notify(error.message, true);
    }
  }

  init();
})();
