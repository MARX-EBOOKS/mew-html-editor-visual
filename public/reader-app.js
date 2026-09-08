(() => {
  "use strict";
  const tags = [
    { id: "b", label: "B", shortcut: "b", open: "<b>", close: "</b>", title: "Alt+B / b" },
    { id: "i", label: "I", shortcut: "i", open: "<i>", close: "</i>", title: "Alt+I / i" },
    { id: "em", label: "EM", shortcut: "em", open: "<em>", close: "</em>", title: "Insert emphasis" },
    { id: "q", label: "Q", shortcut: "q", open: "<blockquote>", close: "</blockquote>", title: "Alt+Q / q" },
    { id: "a", label: "A", shortcut: "a", open: "<a href=\"\" id=\"\">", close: "</a>", title: "Alt+A / a" },
    { id: "x", label: "AID", shortcut: "x", open: "<a id=\"\">", close: "</a>", title: "Alt+X / x" },
    { id: "l", label: "HREF", shortcut: "l", open: "<a href=\"\">", close: "</a>", title: "Alt+L / l" },
    { id: "f", label: "FN", shortcut: "f", open: "<sup><a href=\"\" id=\"\">", close: "</a></sup>", title: "Alt+F / f" },
    { id: "r", label: "R", shortcut: "r", open: "<p align=\"right\">", close: "</p>", title: "Alt+R / r" },
    { id: "c", label: "C", shortcut: "c", open: "<p align=\"center\">", close: "</p>", title: "Alt+C / c" },
    { id: "ltgt", label: "&lt;&gt;", shortcut: "&lt;&gt;", open: "&lt;", close: "&gt;", title: "Insert angle bracket" },
    { id: "h1", label: "H1", shortcut: "1", open: "<h1>", close: "</h1>", title: "Alt+1 / 1" },
    { id: "h2", label: "H2", shortcut: "2", open: "<h2>", close: "</h2>", title: "Alt+2 / 2" },
    { id: "h3", label: "H3", shortcut: "3", open: "<h3>", close: "</h3>", title: "Alt+3 / 3" },
    { id: "h4", label: "H4", shortcut: "4", open: "<h4>", close: "</h4>", title: "Alt+4 / 4" },
    { id: "h5", label: "H5", shortcut: "5", open: "<h5>", close: "</h5>", title: "Alt+5 / 5" },
    { id: "h6", label: "H6", shortcut: "6", open: "<h6>", close: "</h6>", title: "Alt+6 / 6" },
    { id: "p", label: "P", shortcut: "p", open: "<p>", close: "</p>", title: "Alt+P / p" },
    { id: "div", label: "DIV", shortcut: "d", open: "<div>", close: "</div>", title: "Alt+D / d" },
    { id: "span", label: "SPAN", shortcut: "s", open: "<span>", close: "</span>", title: "Alt+S / s" },
    { id: "aside", label: "ASIDE", shortcut: "aside", open: "<aside>", close: "</aside>", title: "Aside" },
    { id: "sup", label: "SUP", shortcut: "sup", open: "<sup>", close: "</sup>", title: "Insert Superscript" },
    { id: "sub", label: "SUB", shortcut: "sub", open: "<sub>", close: "</sub>", title: "Insert Subscript" }
  ];
  const tagMap = new Map(tags.filter((tag) => tag.shortcut).map((tag) => [tag.shortcut.toLowerCase(), tag]));
  const attrs = [
    { id: "idAttr", label: "ID=", text: " id=\"\"", cursorOffset: 5, title: "Insert id attribute" },
    { id: "classAttr", label: "CLASS=", text: " class=\"\"", cursorOffset: 8, title: "Insert class attribute" },
    { id: "styleAttr", label: "STYLE=", text: " style=\"\"", cursorOffset: 8, title: "Insert style attribute" },
    { id: "hrs", label: "HRS", text: "<hr style=\"width: 20%;\">", cursorOffset: 22, title: "Insert short hardline" },
    { id: "noIndentAttr", label: "NO INDENT", text: " style=\"text-indent: 0;\"", cursorOffset: 23, title: "Insert no-indent style attribute" },
    { id: "HR", label: "HR", text: "<hr>", cursorOffset: 3, title: "Insert hardline" },
    { id: "BR", label: "BR", text: "<br>", cursorOffset: 3, title: "Insert change line" }
  ];
  const blockTagNames = new Set(["p", "div", "h1", "h2", "h3", "h4", "h5", "h6"]);
  const blockSelector = [...blockTagNames].join(",");
  const blockTagIds = new Set(["p", "r", "c", "h1", "h2", "h3", "h4", "h5", "h6", "div"]);
  const voidTagNames = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
  const rawTagNames = new Set(["script", "style", "textarea", "title"]);
  const tagPattern = /<!--[\s\S]*?-->|<\/?[A-Za-z][\w:-]*\b(?:[^>"']|"[^"]*"|'[^']*')*>/g;
  class DocumentModel {
    static async load(options) {
      return new DocumentModel({ ...options, ...await options.read() });
    }

    constructor({ text = "", mtime = null, editable = true, read, write } = {}) {
      this.content = text;
      this.savedContent = text;
      this.mtime = mtime;
      this.editable = editable;
      this.revision = 0;
      this.reloadRevision = 0;
      this.undoStack = [];
      this.redoStack = [];
      this.read = read;
      this.write = write;
      this.pending = Promise.resolve();
    }

    get dirty() { return this.content !== this.savedContent; }

    textFromEditor(text) {
      // Textareas normalize CRLF and CR to LF. Keep the original bytes when
      // the editor still represents the current or saved source.
      const normalize = value => value.replace(/\r\n?/g, "\n");
      for (const source of [this.content, this.savedContent]) {
        if (normalize(source) === normalize(text)) return source;
      }
      return text;
    }

    update(text) {
      if (text !== this.content) this.revision += 1;
      this.content = text;
    }

    pushHistory(stack, snapshot) {
      stack.push(snapshot);
      let size = stack.reduce((sum, item) => sum + item.text.length, 0);
      while (stack.length > 100 || size > 10_000_000) size -= stack.shift().text.length;
    }

    remember(snapshot) {
      const last = this.undoStack.at(-1);
      if (!last || ["text", "start", "end"].some(key => last[key] !== snapshot[key])) {
        this.pushHistory(this.undoStack, snapshot);
      }
      this.redoStack = [];
    }

    restore(from, to, current) {
      const snapshot = from.pop();
      if (!snapshot) return null;
      this.pushHistory(to, current);
      this.update(snapshot.text);
      return snapshot;
    }

    undo(current) { return this.restore(this.undoStack, this.redoStack, current); }
    redo(current) { return this.restore(this.redoStack, this.undoStack, current); }

    enqueue(operation) {
      const task = this.pending.then(operation);
      this.pending = task.catch(() => {});
      return task;
    }

    async writeSnapshot(text) {
      if (!this.editable) throw new Error("Document is read-only");
      const result = await this.write({ text, mtime: this.mtime });
      this.savedContent = text;
      this.mtime = result.mtime;
      return result;
    }

    save(text = this.content) {
      const revision = this.reloadRevision;
      return this.enqueue(() => {
        if (revision !== this.reloadRevision) throw new Error("File reloaded before saving. Review the current content and save again.");
        return this.writeSnapshot(text);
      });
    }

    async saveUntilClean() {
      while (this.dirty) {
        await this.enqueue(() => this.dirty ? this.writeSnapshot(this.content) : undefined);
      }
    }

    refresh() {
      return this.enqueue(async () => {
        const data = await this.read();
        const result = data.text === this.savedContent ? "unchanged"
          : data.text === this.content ? "saved" : "updated";
        if (result === "updated") {
          if (this.dirty) return "conflict";
          this.reloadRevision += 1;
          this.update(data.text);
          this.undoStack = [];
          this.redoStack = [];
        }
        this.savedContent = data.text;
        this.mtime = data.mtime;
        return result;
      });
    }
  }


  const ui = window.ReaderUI;
  if (!ui) throw new Error("ReaderUI 未载入");

  const state = {
    config: null,
    volume: null,
    page: null,
    document: new DocumentModel({ editable: false }),
    mode: "source",
    navigationRevision: 0
  };

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

  function markDirty() {
    ui.setDirty(state.document.dirty);
  }

  function updateHistoryButtons() {
    ui.setHistoryButtons(ui.canUndo(), ui.canRedo());
  }

  function sourceFromVisual() {
    const live = ui.getVisualDocument();
    if (!live?.body) return state.document.content;
    const parsed = new DOMParser().parseFromString(state.document.content, "text/html");
    // Parsing changes source formatting even without an edit. Compare bodies
    // in the same DOM representation before serializing a visual change.
    if (parsed.body.innerHTML === live.body.innerHTML) return state.document.content;
    parsed.body.innerHTML = live.body.innerHTML;
    parsed.head.querySelectorAll("[data-reader-editor]").forEach((node) => node.remove());
    const doctype = parsed.doctype ? `<!DOCTYPE ${parsed.doctype.name}>` : "<!doctype html>";
    return `${doctype}\n${parsed.documentElement.outerHTML}`;
  }

  function currentSource() {
    return state.mode === "visual" ? sourceFromVisual() : state.document.textFromEditor(ui.getSource());
  }

  function updateWorkingCopy(source = currentSource()) {
    source = state.document.textFromEditor(source);
    state.document.update(source);
    if (state.mode === "visual") ui.setSource(source, true);
    markDirty();
    updateHistoryButtons();
    return source;
  }

  function restoreHistory(method, action) {
    const visual = ui.getVisualDocument();
    const scroll = state.mode === "visual"
      ? { top: visual?.scrollingElement?.scrollTop || 0, left: visual?.scrollingElement?.scrollLeft || 0 }
      : null;
    ui[`${method}Source`]();
    state.document.update(state.document.textFromEditor(ui.getSource()));
    markDirty();
    updateHistoryButtons();
    if (state.mode === "visual") renderVisual(scroll);
    else ui.focusSource();
    ui.notify(`已${action}`);
  }

  const undo = () => restoreHistory("undo", "撤销");
  const redo = () => restoreHistory("redo", "重做");

  function injectEditorDocument(source) {
    const base = `<base href="/api/reader/resource/${encodeURIComponent(state.volume)}/">`;
    const style = '<style data-reader-editor>html{background:var(--reader-bg,#fff)}body{max-width:760px;margin:0 auto;padding:40px 48px 80px;background:var(--reader-bg,#fff);color:var(--reader-ink,#251f1b);caret-color:currentColor;font:18px/1.75 Georgia,"Noto Serif SC","SimSun",serif;outline:none}img{max-width:100%;height:auto}a{color:var(--reader-link,#8f2923)}.reader-ctrl-link a[href]{text-decoration:underline;cursor:pointer}body:focus{box-shadow:inset 0 0 0 2px #9d2b2430}</style>';
    if (/<head\b[^>]*>/i.test(source)) return source.replace(/<head\b[^>]*>/i, (head) => `${head}${base}${style}`);
    if (/<html\b[^>]*>/i.test(source)) return source.replace(/<html\b[^>]*>/i, (html) => `${html}<head>${base}${style}</head>`);
    return `<!doctype html><html><head>${base}${style}</head><body>${source}</body></html>`;
  }

  function renderVisual(scroll = null) {
    ui.showVisual(injectEditorDocument(state.document.content), { editable: state.document.editable, scroll });
  }

  function setMode(mode = state.mode === "visual" ? "source" : "visual", { resetSourceScroll = false } = {}) {
    if (state.page == null) return;
    const next = mode === "visual" ? "visual" : "source";
    if (next !== state.mode) updateWorkingCopy();
    state.mode = next;
    ui.setMode(next);
    if (next === "source") {
      ui.setSource(state.document.content);
      if (resetSourceScroll) ui.setSourceScroll({ top: 0, left: 0 });
      ui.focusSource();
    } else {
      renderVisual();
    }
    updateHistoryButtons();
    syncUrl();
  }

  function syncUrl() {
    if (state.volume == null || state.page == null) return;
    history.replaceState(null, "", `?volume=${encodeURIComponent(state.volume)}&page=${state.page}&mode=${state.mode}`);
  }

  function pageNumberFromPdfLabel(pdfLabel) {
    const numericPrefix = String(pdfLabel ?? "").match(/^(\d+)/)?.[1];
    return numericPrefix ? Number(numericPrefix) : null;
  }

  async function loadPageOrPrevious(volume, requestedPage) {
    const candidates = volume.pages
      .filter((page) => page <= requestedPage)
      .sort((a, b) => b - a);

    for (const page of candidates) {
      try {
        const url = `/api/reader/page/${encodeURIComponent(volume.id)}/${page}`;
        const document = await DocumentModel.load({
          read: () => api(url),
          write: snapshot => api(url, {
            method: "PUT", headers: { "content-type": "application/json" },
            body: JSON.stringify(snapshot)
          })
        });
        return { page, document, fellBack: page !== requestedPage };
      } catch (error) {
        if (!isMissingPageError(error)) throw error;
      }
    }
    return null;
  }

  function renderNavigation() {
    const volume = currentVolume();
    const index = volume.pages.indexOf(state.page);
    const chapter = activeChapter();
    ui.renderNavigation({
      chapterTitle: chapter?.title || volume.title,
      chapterPage: chapter?.page,
      pageContext: `${volume.shortTitle} · 第 ${state.page} 页`,
      pageTotal: volume.pages.length,
      pageIndex: index + 1,
      page: state.page,
      volume: state.volume,
      hasPrevious: index > 0,
      hasNext: index < volume.pages.length - 1,
      editable: state.document.editable
    });
  }

  function isMissingPageError(error) {
    // 页面文件不存在（本地 ENOENT 或远程读取失败）时不应中断翻页：
    // 这类错误会被当作“占位页”处理，而不是让导航停在当前页反复回退。
    return /(ENOENT|no such file|远程页面读取失败)/i.test(error?.message || "");
  }

  async function navigate(targetVolume, targetPage, force = false, pdfOrigin = null) {
    if (!force && state.document.dirty && !(await save())) return false;
    const volume = state.config.volumes.find((item) => item.id === String(targetVolume));
    if (!volume) return false;
    const requestedPage = Number(targetPage);
    if (!Number.isFinite(requestedPage)) return false;
    const revision = ++state.navigationRevision;
    const previousDocument = state.document;
    const workingCopyRevision = previousDocument.revision;
    try {
      const loaded = await loadPageOrPrevious(volume, requestedPage);
      if (!loaded) throw new Error(`第 ${requestedPage} 页及之前没有可用的网页文件`);
      if (revision !== state.navigationRevision) return true;
      if (previousDocument !== state.document || workingCopyRevision !== state.document.revision || state.document.dirty) {
        if (!(await save())) return false;
        if (revision !== state.navigationRevision) return true;
        return navigate(volume.id, requestedPage, true, pdfOrigin);
      }

      const { page, document, fellBack } = loaded;
      const volumeChanged = state.volume !== volume.id;
      state.volume = volume.id;
      state.page = page;
      state.document = document;
      ui.setSourceEditable(document.editable);
      ui.setSource(document.content);
      markDirty();
      if (volumeChanged) ui.renderToc(volume.shortTitle, volume.toc);
      setMode(state.mode, { resetSourceScroll: true });
      renderNavigation();

      // PDF 发起的翻页已经处于正确的物理页，不反向驱动 PDF。
      // 左侧网页发起导航时才定位 PDF；UI 会在重复标签中选择离当前物理页最近的一项。
      if (!pdfOrigin) {
        ui.setPdf({ url: volume.pdfUrl, pageLabel: String(page) })
          .catch((error) => ui.notify(`PDF 载入失败：${error.message}`, true));
      }
      if (fellBack) ui.notify(`第 ${requestedPage} 页暂无网页文件，已显示上一可用页 ${page}`, false);
      else if (!state.document.editable) ui.notify("远程页面：只读");
      return true;
    } catch (error) {
      if (revision === state.navigationRevision) ui.notify(error.message, true);
      return false;
    }
  }

  async function save() {
    if (state.page == null) return true;
    updateWorkingCopy();
    const document = state.document;
    try {
      await document.saveUntilClean();
      if (document === state.document) markDirty();
      ui.notify("已保存");
      return true;
    } catch (error) {
      ui.notify(`保存失败：${error.message}`, true);
      return false;
    }
  }

  let refreshing = false;
  async function refreshLocalFile() {
    if (refreshing || document.hidden || state.page == null || !state.document.editable) return;
    refreshing = true;
    const current = state.document;
    try {
      const result = await current.refresh();
      if (current !== state.document) return;
      if (result === "conflict") ui.notify("文件已在外部修改；本地未保存内容已保留，请保存副本后重新载入", true);
      else if (result === "updated") {
        ui.setSource(current.content);
        if (state.mode === "visual") renderVisual();
        markDirty();
        updateHistoryButtons();
        ui.notify("已从本地文件刷新");
      } else if (result === "saved") markDirty();
    } catch (error) {
      ui.notify(`本地文件刷新失败：${error.message}`, true);
    } finally { refreshing = false; }
  }

  function refreshAfterEdit(source = currentSource()) {
    updateWorkingCopy(source);
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

  function elementTagInfo(element) {
    if (!element) return null;
    const name = element.tagName.toLowerCase();
    const align = (element.getAttribute("align") || "").toLowerCase();
    return { name, kind: name === "p" && align ? `p:${align}` : name, block: blockTagNames.has(name) };
  }

  function buildTagEdit(text, start, end, tag) {
    const elements = tagPairs(text);
    const selected = text.slice(start, end);
    const name = /^<([A-Za-z][\w:-]*)\b/.exec(tag.open)?.[1].toLowerCase();
    const simple = name && tag.close.toLowerCase() === `</${name}>`;
    const complete = start < end && isCompleteSelection(text, elements, start, end);
    const exact = complete && elements.find((element) => element.start === start && element.end === end);

    // 完整选中时操作外层；否则只操作包住选区的最内层。
    if (complete) {
      // 错配闭合标签：以前面的开始标签为准。点击同类标签删除，
      // 点击其他标签则直接替换整个外层，而不是再包一层。
      if (exact && exact.closeName && exact.closeName !== exact.name) {
        if (name === exact.name) return changeWrapper(text, exact, start, end);
        return changeWrapper(text, exact, start, end, tag);
      }
      if (exact && blockTagNames.has(exact.name) && blockTagIds.has(tag.id)) {
        if (blockId(exact) === tag.id) return changeWrapper(text, exact, start, end);
        if (tag.id !== "div") return changeWrapper(text, exact, start, end, tag);
      }
      if (exact && exact.name === name && simple) return changeWrapper(text, exact, start, end);
      if (tag.close && selected.startsWith(tag.open) && selected.endsWith(tag.close)) {
        const inner = selected.slice(tag.open.length, -tag.close.length);
        return { start, end, text: inner, selectStart: 0, selectEnd: inner.length };
      }
      return wrapEdit(start, end, selected, tag, true);
    }

    const block = blockTagIds.has(tag.id) && innermost(elements.filter((element) => blockTagNames.has(element.name)), start, end);
    if (block) return changeWrapper(text, block, start, end, blockId(block) === tag.id ? undefined : tag);

    const same = simple && innermost(elements.filter((element) => element.name === name), start, end);
    if (same) return changeWrapper(text, same, start, end);

    const before = start - tag.open.length;
    const after = end + tag.close.length;
    if (tag.close && before >= 0 && text.slice(before, start) === tag.open && text.slice(end, after) === tag.close) {
      return { start: before, end: after, text: selected, selectStart: 0, selectEnd: selected.length };
    }
    return wrapEdit(start, end, selected, tag, false);
  }

  function changeWrapper(text, element, start, end, tag) {
    const open = tag?.open || "", close = tag?.close || "";
    const inner = text.slice(element.openEnd, element.closeStart);
    const whole = start === element.start && end === element.end;
    const inOpeningTag = start === end && element.start < start && start < element.openEnd;
    const from = whole || inOpeningTag ? 0 : start - element.openEnd;
    const to = whole ? inner.length : inOpeningTag ? 0 : end - element.openEnd;
    return {
      start: element.start,
      end: element.end,
      text: open + inner + close,
      selectStart: open.length + from,
      selectEnd: open.length + to
    };
  }

  function wrapEdit(start, end, selected, tag, keepSelection) {
    const text = tag.open + selected + tag.close;
    const emptyAttribute = tag.open.indexOf('=""');
    const cursor = emptyAttribute >= 0 ? emptyAttribute + 2 : selected ? text.length : tag.open.length;
    return {
      start, end, text,
      selectStart: keepSelection ? tag.open.length : cursor,
      selectEnd: keepSelection ? tag.open.length + selected.length : cursor
    };
  }

  function innermost(elements, start, end) {
    return elements
      .filter((element) => (start === end && element.start < start && start < element.openEnd) ||
        (element.openEnd <= start && end <= element.closeStart))
      .reduce((inner, element) => !inner || element.end - element.start < inner.end - inner.start ? element : inner, undefined);
  }

  function isCompleteSelection(text, elements, start, end) {
    // Each opening token has one pair: index it once instead of rescanning per sibling.
    const byStart = new Map(elements.map(element => [element.start, element]));
    let cursor = start, found = false;
    while (cursor < end) {
      if (/\s/.test(text[cursor])) { cursor += 1; continue; }
      const outer = byStart.get(cursor);
      if (!outer || outer.end > end) return false;
      found = true;
      cursor = outer.end;
    }
    return found;
  }

  function tagPairs(text) {
    const stack = [], pairs = [];
    let rawName;
    tagPattern.lastIndex = 0;
    for (let match; (match = tagPattern.exec(text));) {
      const token = match[0];
      if (token.startsWith("<!--")) continue;
      const name = token.match(/^<\/?([A-Za-z][\w:-]*)/i)[1].toLowerCase();
      const closing = /^<\//.test(token);

      if (rawName && !(closing && name === rawName)) continue;
      if (closing) {
        const open = stack.at(-1);
        const crossed = stack.findLastIndex((item) => item.name === name);
        if (open && (open.name === name || crossed < 0)) {
          // 正常闭合或没有同名开始标签的错配闭合，都与栈顶配对。
          stack.pop();
          pairs.push({ name: open.name, closeName: name, start: open.start, openEnd: open.end, closeStart: match.index, end: tagPattern.lastIndex, open: open.token });
          if (name === rawName) rawName = undefined;
        } else if (crossed >= 0) {
          // 同名开始标签在栈内时，保留交叉标签恢复逻辑。
          stack.length = crossed;
        }
      } else if (voidTagNames.has(name) || /\/\s*>$/.test(token)) {
        pairs.push({ name, start: match.index, openEnd: tagPattern.lastIndex, closeStart: tagPattern.lastIndex, end: tagPattern.lastIndex, open: token });
      } else {
        stack.push({ name, start: match.index, end: tagPattern.lastIndex, token });
        if (rawTagNames.has(name)) rawName = name;
      }
    }
    return pairs;
  }

  function blockId(element) {
    if (element.name !== "p") return element.name;
    const align = element.open.match(/\balign\s*=\s*["']?(center|right)/i)?.[1]?.toLowerCase();
    return align === "center" ? "c" : align === "right" ? "r" : "p";
  }

  function selectVisualContents(element, doc) {
    const range = doc.createRange();
    range.selectNodeContents(element);
    const selection = doc.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }



  function selectVisualNodes(first, last, doc) {
    if (!first || !last) return;
    const range = doc.createRange();
    range.setStartBefore(first);
    range.setEndAfter(last);
    const selection = doc.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }



  function insertVisual(tag) {
    const doc = ui.getVisualDocument();
    if (!doc?.body || !state.document.editable) return;
    const template = doc.createElement("template");
    template.innerHTML = tag.open;
    const info = elementTagInfo(template.content.firstElementChild);
    const selection = doc.getSelection();
    const anchor = selection?.anchorNode?.nodeType === doc.defaultView.Node.ELEMENT_NODE
      ? selection.anchorNode : selection?.anchorNode?.parentElement;
    const container = info && anchor?.closest?.(info.block ? blockSelector : info.name);
    let action = "已插入";
    if (container && doc.body.contains(container)) {
      const remove = elementTagInfo(container).kind === info.kind;
      const replacement = remove ? doc.createDocumentFragment() : template.content.firstElementChild;
      if (!replacement) return;
      const first = container.firstChild, last = container.lastChild;
      replacement.append(...container.childNodes);
      container.replaceWith(replacement);
      if (remove) selectVisualNodes(first, last, doc);
      else selectVisualContents(replacement, doc);
      action = remove ? "已移除" : "已替换";
    } else {
      const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
      if (!range) return;
      const holder = doc.createElement("div");
      holder.append(range.cloneContents());
      template.innerHTML = tag.open + holder.innerHTML + tag.close;
      const fragment = template.content;
      const inserted = [...fragment.childNodes];
      range.deleteContents();
      range.insertNode(fragment);
      selectVisualNodes(inserted[0], inserted.at(-1), doc);
    }
    updateWorkingCopy();
    doc.body.focus();
    return action;
  }

  function insertSourceTag(tag) {
    const { start, end } = ui.getSourceSelection();
    const source = ui.getSource();
    const operation = buildTagEdit(source, start, end, tag);
    const removed = operation.text.length < operation.end - operation.start;
    const wrapped = tag.open + source.slice(start, end) + tag.close;
    const replaced = !removed && operation.text !== wrapped;
    applySourceEdit(operation.text, operation.start, operation.end,
      operation.start + operation.selectStart, operation.start + operation.selectEnd);
    return removed ? "已移除" : replaced ? "已替换" : "已插入";
  }

  function insertSourceAttribute(attr) {
    const { start, end } = ui.getSourceSelection();
    const selected = ui.getSource().slice(start, end);
    applySourceEdit(attr.text + selected, start, end, start + (attr.cursorOffset ?? attr.text.length + selected.length));
  }

  function applySourceEdit(text, start, end, selectStart, selectEnd = selectStart) {
    ui.replaceSourceRange(text, start, end, "select");
    ui.setSourceSelection(selectStart, selectEnd);
    refreshAfterEdit(ui.getSource());
    ui.focusSource();
  }

  function editTag(tag) {
    const action = state.mode === "visual" ? insertVisual(tag) : insertSourceTag(tag);
    if (action) ui.notify(`${action} ${tag.label}`);
  }

  function toggleFind() {
    if (state.mode !== "source") setMode("source");
    ui.focusSource();
    ui.toggleFind(true);
  }

  function adjacent(direction) {
    const pages = currentVolume()?.pages || [];
    const index = pages.indexOf(state.page);
    if (pages[index + direction] != null) navigate(state.volume, pages[index + direction]);
  }

  function handleKeyDown(event) {
    const key = event.key.toLowerCase();
    const command = event.ctrlKey || event.metaKey;
    const formField = event.target.matches?.("input, textarea, select");
    if (command && key === "s") {
      event.preventDefault();
      save();
      return;
    }
    if (command && (key === "f" || key === "h") && state.mode !== "source") {
      event.preventDefault();
      toggleFind();
      return;
    }
    if (command && !formField && !ui.hasSourceTextFocus() && (key === "z" || key === "y")) {
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
      const tag = tagMap.get(key);
      if (tag) {
        event.preventDefault();
        editTag(tag);
      }
      return;
    }
    const editableTarget = event.target.matches?.("textarea,[contenteditable]") || event.target.isContentEditable || event.target.closest?.(".monaco-editor");
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
        insertSourceAttribute(attrs[index]);
      },
      sourceInput: () => refreshAfterEdit(ui.getSource()),
      visualInput: () => refreshAfterEdit(),
      visualDoubleClick: trimVisualWordSelection,
      visualClick: openVisualLink,
      pdfPageChange: ({ pageNumber, pageLabel }) => {
        updateWorkingCopy();
        if (state.document.dirty) {
          ui.notify("网页有未保存修改；PDF 滚动不会自动切换网页");
          return;
        }
        const volume = currentVolume();
        if (!volume) return;
        const page = pageNumberFromPdfLabel(pageLabel);
        if (page != null) navigate(volume.id, page, false, { pageNumber, pageLabel });
      },
      find: toggleFind,
      historyChanged: updateHistoryButtons,
      keyDown: handleKeyDown,
      beforeUnload: (event) => {
        if (!state.document.dirty) return;
        event.preventDefault();
        event.returnValue = "";
      }
    });
    try {
      if (typeof require !== "function") throw new Error("Monaco 加载器未载入");
      const monaco = await new Promise((resolve, reject) => {
        require.config({ paths: { vs: "/monaco/min/vs" } });
        require(["vs/editor/editor.main"], resolve, reject);
      });
      ui.initMonaco(monaco);
      ui.renderTools(tags, attrs);
      updateHistoryButtons();
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
        chapterTitle: "载入失败", chapterPage: null, pageContext: "", pageTotal: "", pageIndex: "",
        page: "", volume: "", hasPrevious: false, hasNext: false, editable: false
      });
      ui.notify(error.message, true);
    }
  }

  window.addEventListener("focus", refreshLocalFile);
  document.addEventListener("visibilitychange", refreshLocalFile);
  setInterval(refreshLocalFile, 2000);
  init();
})();
