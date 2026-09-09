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
    ...Array.from({ length: 6 }, (_, index) => {
      const shortcut = String(index + 1), id = `h${shortcut}`;
      return { id, label: id.toUpperCase(), shortcut, open: `<${id}>`, close: `</${id}>`, title: `Alt+${shortcut} / ${shortcut}` };
    }),
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
    constructor({ text = "", mtime = null, editable = true, read, write } = {}) {
      this.content = text;
      this.savedContent = text;
      this.mtime = mtime;
      this.editable = editable;
      this.revision = 0;
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

    enqueue(operation) {
      const task = this.pending.then(operation);
      this.pending = task.catch(() => {});
      return task;
    }

    async saveUntilClean() {
      while (this.dirty) {
        await this.enqueue(async () => {
          if (!this.dirty) return;
          if (!this.editable) throw new Error("Document is read-only");
          const text = this.content;
          const result = await this.write({ text, mtime: this.mtime });
          this.savedContent = text;
          this.mtime = result.mtime;
        });
      }
    }

    refresh() {
      return this.enqueue(async () => {
        const data = await this.read();
        const result = data.text === this.savedContent ? "unchanged"
          : data.text === this.content ? "saved" : "updated";
        if (result === "updated") {
          if (this.dirty) return "conflict";
          this.update(data.text);
        }
        this.savedContent = data.text;
        this.mtime = data.mtime;
        return result;
      });
    }
  }


  const ui = window.ReaderUI;
  if (!ui) throw new Error("ReaderUI 未载入");

  const initialParams = new URLSearchParams(location.search);
  const requestedSession = /^[\w-]{1,128}$/.test(initialParams.get("sync") || "") ? initialParams.get("sync") : "";

  const state = {
    config: null,
    volume: null,
    page: null,
    document: new DocumentModel({ editable: false }),
    mode: "source",
    workspaceMode: initialParams.get("view") === "reader" ? "reader" : "combined",
    syncSession: requestedSession,
    navigationRevision: 0,
    pendingPdfNavigation: null
  };
  let syncChannel = null;
  let pairedWindow = null;
  let locateRevision = 0;
  const editorPathCache = new Map();

  function channelFor(session, receive) {
    const name = `mew-reader-${session}`;
    if ("BroadcastChannel" in window) {
      const channel = new BroadcastChannel(name);
      channel.onmessage = (event) => receive(event.data);
      return channel;
    }
    const key = `__${name}`;
    const listener = (event) => {
      if (event.key !== key || !event.newValue) return;
      try { receive(JSON.parse(event.newValue).message); } catch { /* ignore malformed peer data */ }
    };
    window.addEventListener("storage", listener);
    return {
      postMessage(message) { localStorage.setItem(key, JSON.stringify({ nonce: crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`, message })); },
      close() { window.removeEventListener("storage", listener); }
    };
  }

  async function api(url, options) {
    const response = await fetch(url, options);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return data;
  }

  async function editorPathForPage(volume = state.volume, page = state.page) {
    const key = `${volume}:${page}`;
    if (editorPathCache.has(key)) return editorPathCache.get(key);
    const link = await api(`/api/reader/link/${encodeURIComponent(volume)}/${page}`);
    editorPathCache.set(key, link.path);
    return link.path;
  }

  async function announceReaderPage() {
    if (!syncChannel || state.workspaceMode !== "reader" || state.page == null) return;
    const volume = state.volume;
    const page = state.page;
    try {
      const editorPath = await editorPathForPage(volume, page);
      if (volume !== state.volume || page !== state.page || !syncChannel) return;
      syncChannel.postMessage({
        source: "reader", type: "reader-page", volume, page, path: editorPath
      });
    } catch (error) {
      ui.notify(`当前页无法在独立编辑器中打开：${error.message}`, true);
    }
  }

  async function receiveSyncMessage(message) {
    if (!message || message.source !== "editor" || state.workspaceMode !== "reader") return;
    if (message.type === "editor-ready") return announceReaderPage();
    if (message.type !== "editor-page" || !message.path) return;
    const revision = ++locateRevision;
    try {
      const target = await api(`/api/reader/locate?path=${encodeURIComponent(message.path)}`);
      if (revision !== locateRevision) return;
      if (target.volume !== state.volume || target.page !== state.page) await navigate(target.volume, target.page);
    } catch {
      // Ordinary files may remain open in index.html without moving the PDF.
    }
  }

  function openSyncChannel() {
    syncChannel?.close();
    syncChannel = state.syncSession ? channelFor(state.syncSession, receiveSyncMessage) : null;
    syncChannel?.postMessage({ source: "reader", type: "reader-ready" });
  }

  function newSession() {
    return (crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`).replace(/[^\w-]/g, "");
  }

  async function ensureEditorRuntime() {
    if (typeof require !== "function") throw new Error("Monaco 加载器未载入");
    require.config({ paths: { vs: "/monaco/min/vs" } });
    const monaco = await new Promise((resolve, reject) => require(["vs/editor/editor.main"], resolve, reject));
    ui.initMonaco(monaco);
    ui.renderTools(tags, attrs);
    updateHistoryButtons();
  }

  function currentVolume() {
    return state.config?.volumes.find((item) => item.id === state.volume);
  }

  function markDirty() {
    ui.setDirty(state.document.dirty);
  }

  function updateHistoryButtons() {
    ui.setHistoryButtons(ui.canUndo(), ui.canRedo());
  }

  function currentSource() {
    if (state.mode !== "visual") return state.document.textFromEditor(ui.getSource());
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
    updateWorkingCopy(ui.getSource());
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
    if (state.page == null || state.workspaceMode === "reader") return;
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
    const params = new URLSearchParams(location.search);
    const paired = state.workspaceMode === "reader" && state.syncSession;
    for (const [key, value] of Object.entries({ volume: state.volume, page: state.page, mode: state.mode,
      view: paired ? "reader" : null, sync: paired || null })) {
      if (value == null) params.delete(key);
      else params.set(key, value);
    }
    history.replaceState(null, "", `${location.pathname}?${params}`);
  }

  async function loadPageOrPrevious(volume, requestedPage) {
    const candidates = volume.pages
      .filter((page) => page <= requestedPage)
      .sort((a, b) => b - a);

    for (const page of candidates) {
      try {
        const url = `/api/reader/page/${encodeURIComponent(volume.id)}/${page}`;
        const data = await api(url);
        const document = new DocumentModel({
          ...data,
          read: () => api(url),
          write: snapshot => api(url, {
            method: "PUT", headers: { "content-type": "application/json" },
            body: JSON.stringify(snapshot)
          })
        });
        return { page, document, editorPath: data.path || null };
      } catch (error) {
        // Missing local/remote files fall back to the previous available page.
        if (!/(ENOENT|no such file|远程页面读取失败)/i.test(error?.message || "")) throw error;
      }
    }
    return null;
  }

  function renderNavigation() {
    const volume = currentVolume();
    const index = volume.pages.indexOf(state.page);
    const chapter = (volume.toc || []).findLast(item => item.page <= state.page);
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
      editable: state.workspaceMode !== "reader" && state.document.editable
    });
  }

  async function navigate(targetVolume, targetPage, force = false, pdfOrigin = null) {
    // Any local/PDF navigation supersedes an older editor-path lookup that may
    // still be in flight; otherwise a late dirty-state announcement can jump back.
    ++locateRevision;
    if (!pdfOrigin) state.pendingPdfNavigation = null;
    if (state.workspaceMode !== "reader" && !force && state.document.dirty && !(await save())) return false;
    const volume = state.config.volumes.find((item) => item.id === String(targetVolume));
    if (!volume) return false;
    const requestedPage = Number(targetPage);
    if (!Number.isFinite(requestedPage)) return false;
    const revision = ++state.navigationRevision;
    const readerOnly = state.workspaceMode === "reader";
    const previousDocument = state.document;
    const workingCopyRevision = previousDocument.revision;
    try {
      const candidate = volume.pages.filter((page) => page <= requestedPage).at(-1);
      const loaded = readerOnly
        ? candidate == null ? null : { page: candidate, document: new DocumentModel({ editable: false }), editorPath: null }
        : await loadPageOrPrevious(volume, requestedPage);
      if (!loaded) throw new Error(`第 ${requestedPage} 页及之前没有可用的网页文件`);
      if (revision !== state.navigationRevision) return true;
      if (!readerOnly && (previousDocument !== state.document || workingCopyRevision !== state.document.revision || state.document.dirty)) {
        if (!(await save())) return false;
        if (revision !== state.navigationRevision) return true;
        return navigate(volume.id, requestedPage, true, pdfOrigin);
      }

      const { page, document, editorPath } = loaded;
      const volumeChanged = state.volume !== volume.id;
      state.volume = volume.id;
      state.page = page;
      if (editorPath) editorPathCache.set(`${volume.id}:${page}`, editorPath);
      state.document = document;
      if (!readerOnly) {
        ui.setSourceEditable(document.editable);
        ui.setSource(document.content);
        markDirty();
        setMode(state.mode, { resetSourceScroll: true });
      } else syncUrl();
      if (volumeChanged) ui.renderToc(volume.shortTitle, volume.toc);
      renderNavigation();

      // PDF 发起的翻页已经处于正确的物理页，不反向驱动 PDF。
      // 左侧网页发起导航时才定位 PDF；UI 会在重复标签中选择离当前物理页最近的一项。
      if (!pdfOrigin) {
        ui.setPdf({ url: volume.pdfUrl, pageLabel: String(page) })
          .catch((error) => ui.notify(`PDF 载入失败：${error.message}`, true));
      }
      if (page !== requestedPage) ui.notify(`第 ${requestedPage} 页暂无网页文件，已${readerOnly ? "定位" : "显示"}上一可用页 ${page}`);
      else if (!readerOnly && !document.editable) ui.notify("远程页面：只读");
      if (readerOnly) announceReaderPage();
      return true;
    } catch (error) {
      if (revision === state.navigationRevision) ui.notify(error.message, true);
      return false;
    }
  }

  async function save(options = {}) {
    const followPdf = options.followPdf !== false;
    if (state.page == null) return true;
    updateWorkingCopy();
    const document = state.document;
    try {
      await document.saveUntilClean();
      if (document === state.document) markDirty();
      ui.notify("已保存");
      const pending = followPdf && document === state.document && !document.dirty
        ? state.pendingPdfNavigation : null;
      if (pending) {
        state.pendingPdfNavigation = null;
        if (pending.volume === state.volume && pending.page !== state.page) {
          return navigate(pending.volume, pending.page, true, pending.pdfOrigin);
        }
      }
      return true;
    } catch (error) {
      ui.notify(`保存失败：${error.message}`, true);
      return false;
    }
  }

  function editorUrl(path) {
    const url = new URL("index.html", location.href);
    url.search = "";
    url.searchParams.set("readerSession", state.syncSession);
    if (path) url.searchParams.set("file", path);
    return url.href;
  }

  function openEditorWindow() {
    const brands = navigator.userAgentData?.brands || [];
    const chromium = brands.some(({ brand }) => /Chromium|Google Chrome|Microsoft Edge/i.test(brand))
      || /\b(?:Chrome|Chromium|Edg|OPR)\/\d/i.test(navigator.userAgent);
    const name = `mew-editor-${state.syncSession}`;
    // Chromium honors the `popup` feature as a minimal-chrome, app-style
    // window. Other engines keep their normal named-window behavior.
    return chromium ? window.open("", name, "popup=yes") : window.open("", name);
  }

  async function openPairedEditor(popup) {
    try {
      const volume = state.volume;
      const page = state.page;
      const editorPath = await editorPathForPage(volume, page);
      if (volume !== state.volume || page !== state.page) return openPairedEditor(popup);
      const url = editorUrl(editorPath);
      const params = new URL(popup.location.href).searchParams;
      if (popup.location.pathname.endsWith("/index.html") && params.get("readerSession") === state.syncSession) popup.focus();
      else popup.location.replace(url);
      pairedWindow = popup;
      announceReaderPage();
      return true;
    } catch (error) {
      popup.close();
      ui.notify(`无法打开独立编辑器：${error.message}`, true);
      return false;
    }
  }

  async function enterSplitView() {
    if (!state.config?.editorAvailable) return ui.notify("当前阅读器配置没有可用的本地编辑目录", true);
    if (!state.syncSession) state.syncSession = newSession();
    const popup = pairedWindow && !pairedWindow.closed
      ? pairedWindow
      : openEditorWindow();
    if (!popup) return ui.notify("浏览器阻止了编辑器窗口，请允许此站点打开弹出窗口", true);
    if (state.workspaceMode === "reader") return openPairedEditor(popup);
    if (state.document.dirty && !(await save({ followPdf: false }))) {
      popup.close();
      return false;
    }
    state.workspaceMode = "reader";
    state.document = new DocumentModel({ editable: false });
    state.pendingPdfNavigation = null;
    ui.setWorkspaceMode("reader", true);
    openSyncChannel();
    renderNavigation();
    syncUrl();
    if (!(await openPairedEditor(popup))) return false;
    // Reload through the pure-reader entry path so this window releases the
    // already-created Monaco instance instead of merely hiding its DOM.
    location.reload();
    return true;
  }

  function restoreCombinedView() {
    syncChannel?.postMessage({ source: "reader", type: "reader-detached" });
    syncChannel?.close();
    syncChannel = null;
    state.syncSession = "";
    state.workspaceMode = "combined";
    ui.setWorkspaceMode("combined", state.config?.editorAvailable);
    syncUrl();
    location.reload();
  }

  let refreshing = false;
  async function refreshLocalFile() {
    if (state.workspaceMode === "reader" || refreshing || document.hidden || state.page == null || !state.document.editable) return;
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
    for (const [edge, count, ordered] of [["Start", leading, nodes], ["End", trailing, [...nodes].reverse()]]) {
      let remaining = count;
      const start = edge === "Start";
      for (const node of ordered) {
        if (!remaining) break;
        const offset = start
          ? node === range.startContainer ? range.startOffset : 0
          : node === range.endContainer ? range.endOffset : node.textContent.length;
        const cut = Math.min(remaining, start ? node.textContent.length - offset : offset);
        range[`set${edge}`](node, offset + (start ? cut : -cut));
        remaining -= cut;
      }
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

  function selectVisualNodes(first, last, doc, contents = false) {
    if (!first || !last) return;
    const range = doc.createRange();
    if (contents) range.selectNodeContents(first);
    else {
      range.setStartBefore(first);
      range.setEndAfter(last);
    }
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
      else selectVisualNodes(replacement, replacement, doc, true);
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

  function applySourceEdit(text, start, end, selectStart, selectEnd = selectStart) {
    ui.replaceSourceRange(text, start, end, "select");
    ui.setSourceSelection(selectStart, selectEnd);
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
    const commandAction = command && state.workspaceMode !== "reader" && (
      key === "s" ? save
        : (key === "f" || key === "h") && state.mode !== "source" ? toggleFind
          : !formField && !ui.hasSourceTextFocus() && (key === "z" || key === "y")
            ? (key === "y" || event.shiftKey ? redo : undo) : null);
    if (commandAction) {
      event.preventDefault();
      return commandAction();
    }
    if (event.key === "Escape") ui.setToc(false);
    if (formField) return;
    const direction = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
    const editableTarget = event.target.matches?.("textarea,[contenteditable]") || event.target.isContentEditable || event.target.closest?.(".monaco-editor");
    if (event.altKey && !command) {
      const tag = tagMap.get(key);
      if (direction || tag) event.preventDefault();
      if (direction) adjacent(direction);
      else if (tag) editTag(tag);
    } else if (direction && !editableTarget) adjacent(direction);
  }

  async function changeVolume(id) {
    const volume = state.config.volumes.find((item) => item.id === id);
    if (!volume || !(await navigate(volume.id, volume.pages[0]))) renderNavigation();
  }

  async function init() {
    ui.init({
      mode: () => setMode(), save, undo, redo, volume: changeVolume,
      splitView: enterSplitView, combinedView: restoreCombinedView,
      page: (page) => navigate(state.volume, page), adjacent,
      tag: (index) => editTag(tags[index]),
      attr: (index) => {
        if (state.mode === "visual") return ui.notify("属性按钮请在源代码模式使用");
        const attr = attrs[index], { start, end } = ui.getSourceSelection();
        const selected = ui.getSource().slice(start, end);
        applySourceEdit(attr.text + selected, start, end, start + (attr.cursorOffset ?? attr.text.length + selected.length));
      },
      sourceInput: () => updateWorkingCopy(ui.getSource()),
      visualInput: () => updateWorkingCopy(),
      visualDoubleClick: trimVisualWordSelection,
      visualClick: openVisualLink,
      pdfPageChange: ({ pageNumber, pageLabel }) => {
        updateWorkingCopy();
        const volume = currentVolume();
        if (!volume) return;
        const prefix = String(pageLabel ?? "").match(/^(\d+)/)?.[1];
        if (!prefix) return;
        const page = Number(prefix);
        if (state.document.dirty) {
          state.pendingPdfNavigation = {
            volume: volume.id,
            page,
            pdfOrigin: { pageNumber, pageLabel }
          };
          ui.notify("网页有未保存修改；保存后将切换到当前 PDF 页");
          return;
        }
        state.pendingPdfNavigation = null;
        navigate(volume.id, page, false, { pageNumber, pageLabel });
      },
      find: toggleFind,
      historyChanged: updateHistoryButtons,
      keyDown: handleKeyDown,
      beforeUnload: (event) => {
        if (state.workspaceMode === "reader" || !state.document.dirty) return;
        event.preventDefault();
        event.returnValue = "";
      }
    });
    try {
      if (state.workspaceMode !== "reader") await ensureEditorRuntime();
      state.config = await api("/api/reader/config");
      const requestedMode = initialParams.get("mode");
      if (requestedMode === "source" || requestedMode === "visual") state.mode = requestedMode;
      if (state.workspaceMode === "reader" && !state.syncSession) state.syncSession = newSession();
      ui.setWorkspaceMode(state.workspaceMode, state.config.editorAvailable);
      if (state.workspaceMode === "reader") openSyncChannel();
      const firstVolume = state.config.volumes.find((item) => item.id === initialParams.get("volume")) || state.config.volumes[0];
      if (!firstVolume) throw new Error("配置中没有找到包含 HTML 页面的卷册");
      ui.renderVolumes(state.config.volumes, firstVolume.id);
      await navigate(firstVolume.id, Number(initialParams.get("page")) || firstVolume.pages[0], true);
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
