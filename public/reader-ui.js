(() => {
  "use strict";
  const byId = (id) => document.getElementById(id);
  const element = (tag, className = "", textContent = "", properties = {}) =>
    Object.assign(document.createElement(tag), { className, textContent }, properties);
  const button = (label, title = label, properties = {}) =>
    element("button", "", label, { type: "button", title, ...properties });
  const root = document.documentElement;
  const body = document.body;
  const grid = document.querySelector(".reader-grid");
  const scanPane = document.querySelector(".scan-pane");
  const monacoHost = byId("monacoEditor");
  const visualFrame = byId("visualEditor");
  const pdfFrame = byId("pdfFrame");
  const listeners = {};
  let initialized = false;
  let monacoApi = null, sourceEditor = null, sourceModel = null;
  let editorScale = 1;
  let statusTimer = null;
  let pendingPdfOptions = null;
  let pdfRuntimePromise = null, pdfViewer = null, pdfLinkService = null, pdfLoadingTask = null;
  let pdfUrl = "", pdfPageLabels = null, scrollMode = null, pdfWriteTimer = null, pdfRevision = 0;
  let pdfShortcutActive = false;
  const PDF_SETTINGS_KEY = "readerPdfSettings.v1";
  const PDF_DEFAULTS = { brightness: 100, paper: "#ffffff", ink: "#000000", invert: false, horizontal: false, scale: "page-width" };
  let pdfSettings = { ...PDF_DEFAULTS };
  const PDF_DIRECT_HTML = `<svg aria-hidden="true" width="0" height="0"><filter id="scanColorFilter" color-interpolation-filters="sRGB"><feComponentTransfer><feFuncR id="filterR" type="table" tableValues="0 1"/><feFuncG id="filterG" type="table" tableValues="0 1"/><feFuncB id="filterB" type="table" tableValues="0 1"/></feComponentTransfer></filter></svg><div class="pdf-tools"><div class="pdf-group"><button id="direction" type="button">左右翻页</button><button id="settings" type="button">显示设置</button></div><div class="pdf-group pdf-zoom"><button id="zoomOut" type="button" aria-label="缩小 PDF" title="缩小 PDF（Ctrl+−）">−</button><input id="zoomValue" type="text" inputmode="decimal" maxlength="8" value="页宽" aria-label="PDF 缩放比例" title="输入 25%–1000% 并按回车；输入“页宽”恢复适合页宽；PDF 区域支持 Ctrl+滚轮及 Ctrl+＋/−"><button id="zoomIn" type="button" aria-label="放大 PDF" title="放大 PDF（Ctrl+＋）">＋</button></div><button id="full" type="button">全屏</button></div><div id="stage"><div id="viewer" class="pdfViewer"></div><p id="missing">正在载入 PDF…</p></div><dialog id="settingsDialog"><form method="dialog"><header><strong>扫描件显示设置</strong><button value="close">×</button></header><label>亮度 <output id="brightnessValue"></output><input id="brightness" type="range" min="50" max="160"></label><label>背景色 <input id="paper" type="color"></label><label>文字色 <input id="ink" type="color"></label><label class="toggle"><input id="invert" type="checkbox">反色</label><footer><button id="reset" type="button">恢复默认</button><button value="close">完成</button></footer></form></dialog>`;

  function emit(name, ...args) {
    return listeners[name]?.(...args);
  }

  function bind(id, event, handler) {
    byId(id)?.addEventListener(event, handler);
  }

  function setToc(open) {
    root.classList.toggle("toc-open", open);
    byId("tocBtn")?.setAttribute("aria-expanded", String(open));
  }

  function setTheme(dark) {
    body.classList.toggle("dark", dark);
    localStorage.setItem("readerDark", dark ? "1" : "0");
    const button = byId("darkBtn");
    if (button) button.textContent = dark ? "浅色" : "深色";
    if (monacoApi) monacoApi.editor.setTheme(dark ? "reader-dark" : "reader-light");
    applyVisualTheme();
  }

  function registerHtmlStyleColorProvider(api) {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    const cssRegions = text => {
      const regions = [];
      for (const match of text.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)) {
        regions.push({ start: match.index + match[0].indexOf(match[1]), text: match[1] });
      }
      for (const tag of text.matchAll(/<(?!style\b|\/|!)[^>]+>/gi)) {
        for (const attr of tag[0].matchAll(/\bstyle\s*=\s*(["'])([\s\S]*?)\1/gi)) {
          regions.push({ start: tag.index + attr.index + attr[0].indexOf(attr[2]), text: attr[2] });
        }
      }
      return regions;
    };
    const parse = value => {
      if (!context || !CSS.supports("color", value)) return null;
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = "rgba(0, 0, 0, 0)";
      context.fillStyle = value;
      context.fillRect(0, 0, 1, 1);
      const [red, green, blue, alpha] = context.getImageData(0, 0, 1, 1).data;
      return { red: red / 255, green: green / 255, blue: blue / 255, alpha: alpha / 255 };
    };
    const colorPattern = /#(?:[\da-f]{8}|[\da-f]{6}|[\da-f]{4}|[\da-f]{3})\b|(?:rgba?|hsla?)\([^)]*\)/gi;
    api.languages.registerColorProvider("html", {
      provideDocumentColors(model) {
        const text = model.getValue(), colors = [];
        for (const region of cssRegions(text)) {
          for (const match of region.text.matchAll(colorPattern)) {
            const color = parse(match[0]);
            if (!color) continue;
            const start = region.start + match.index;
            colors.push({ color, range: api.Range.fromPositions(model.getPositionAt(start), model.getPositionAt(start + match[0].length)) });
          }
        }
        return colors;
      },
      provideColorPresentations(_model, { color, range }) {
        const bytes = [color.red, color.green, color.blue, color.alpha].map(value => Math.round(value * 255));
        const hex = bytes.slice(0, bytes[3] === 255 ? 3 : 4).map(value => value.toString(16).padStart(2, "0")).join("");
        const label = `#${hex}`;
        return [{ label, textEdit: { range, text: label } }];
      }
    });
  }

  function initMonaco(api) {
    if (sourceEditor) return sourceEditor;
    monacoApi = api;
    registerHtmlStyleColorProvider(monacoApi);
    const themes = [
      ["reader-light", "vs", { bg: "#fbfcfe", ink: "#27231f", selection: "#add6ff80", muted: "#716b64", panel: "#ffffff", line: "#d9d2c8" }],
      ["reader-dark", "vs-dark", { bg: "#1e1e1e", ink: "#eeeeee", selection: "#264f78", muted: "#aaaaaa", panel: "#242424", line: "#444444" }]
    ];
    for (const [name, base, color] of themes) {
      monacoApi.editor.defineTheme(name, {
        base, inherit: true, rules: [],
        colors: {
          "editor.background": color.bg, "editor.foreground": color.ink,
          "editor.selectionBackground": color.selection, "editorLineNumber.foreground": color.muted,
          "editorWidget.background": color.panel, "editorWidget.border": color.line,
          "input.background": color.panel, "input.foreground": color.ink,
          "editorCursor.foreground": color.ink
        }
      });
    }
    sourceModel = monacoApi.editor.createModel("", "html", monacoApi.Uri.parse("mew-reader:///page.html"));
    sourceEditor = monacoApi.editor.create(monacoHost, {
      model: sourceModel, automaticLayout: true, fontFamily: 'Consolas, "Cascadia Mono", monospace',
      fontSize: 14 * editorScale, lineHeight: Math.round(22 * editorScale), tabSize: 2, wordWrap: "on", minimap: { enabled: false },
      find: { addExtraSpaceOnTop: false }, occurrencesHighlight: "off", scrollBeyondLastLine: false,
      padding: { top: 14, bottom: 14 }, readOnly: true,
      colorDecorators: true, defaultColorDecorators: "never"
    });
    sourceModel.onDidChangeContent(() => emit("sourceInput"));
    sourceEditor.onDidChangeCursorSelection(() => emit("historyChanged"));
    sourceEditor.addCommand(monacoApi.KeyMod.CtrlCmd | monacoApi.KeyCode.KeyF, () => toggleSourceFind(false, false));
    sourceEditor.addCommand(monacoApi.KeyMod.CtrlCmd | monacoApi.KeyCode.KeyH, () => toggleSourceFind(true, false));
    setTheme(body.classList.contains("dark"));
    window.readerMonaco = { editor: sourceEditor, model: sourceModel };
    return sourceEditor;
  }

  function setEditorScale(value) {
    editorScale = Math.min(1.6, Math.max(.8, Number(value) || 1));
    sourceEditor?.updateOptions({ fontSize: 14 * editorScale, lineHeight: Math.round(22 * editorScale) });
    const doc = visualFrame?.contentDocument;
    if (doc?.documentElement) doc.documentElement.style.zoom = editorScale;
    return editorScale;
  }

  function applyVisualTheme() {
    const doc = visualFrame?.contentDocument;
    if (!doc?.body) return;
    const dark = body.classList.contains("dark");
    doc.documentElement.style.colorScheme = dark ? "dark" : "light";
    doc.documentElement.style.setProperty("--reader-bg", dark ? "#1e1e1e" : "#ffffff");
    doc.documentElement.style.setProperty("--reader-ink", dark ? "#d4d4d4" : "#251f1b");
    doc.documentElement.style.setProperty("--reader-link", dark ? "#4fc1ff" : "#8f2923");
    doc.documentElement.style.zoom = editorScale;
  }

  function setMode(mode) {
    const sourceMode = mode === "source";
    byId("sourcePane").hidden = !sourceMode;
    visualFrame.hidden = sourceMode;
    const modeButton = byId("modeBtn");
    modeButton.textContent = sourceMode ? "可视化" : "源代码";
    modeButton.setAttribute("aria-pressed", String(sourceMode));
    modeButton.title = sourceMode ? "切换到可视化编辑" : "切换到源代码编辑";
    window.dispatchEvent(new Event("reader-mode-change"));
  }

  function setWorkspaceMode(mode, editorAvailable = true) {
    const readerOnly = mode === "reader";
    body.classList.toggle("reader-only", readerOnly);
    document.title = readerOnly ? "MEW 对照阅读器" : "MEW 对照阅读编辑器";
    document.querySelector(".brand-name").textContent = document.title;
    document.querySelector(".action-group-edit").hidden = readerOnly;
    byId("modeBtn").hidden = readerOnly;
    byId("combinedViewBtn").hidden = !readerOnly;
    const splitButton = byId("splitViewBtn");
    splitButton.disabled = !editorAvailable;
    splitButton.textContent = readerOnly ? "打开编辑器" : "双窗口";
    splitButton.title = editorAvailable
      ? (readerOnly ? "打开或重新聚焦联控编辑器窗口" : "用独立窗口打开编辑器，并把本窗口切换为纯阅读器")
      : "当前阅读器配置没有可用的本地编辑目录";
    splitter.hidden = readerOnly;
    requestAnimationFrame(() => {
      pdfViewer?.update();
      syncChromeMetrics();
    });
  }

  function notify(message, persistent = false) {
    byId("status").textContent = message || "";
    clearTimeout(statusTimer);
    if (message && !persistent) statusTimer = setTimeout(() => { byId("status").textContent = ""; }, 2600);
  }

  const pageButtons = [
    ["prevBtn", "hasPrevious", "Alt+←", " & 保存"], ["nextPageBtn", "hasNext", "Alt+→", " & 保存"],
    ["tagPrevBtn", "hasPrevious", "Prev", " · Auto Save"], ["tagNextPageBtn", "hasNext", "Next", " · Auto Save"]
  ];
  function setDirty(dirty) {
    byId("saveBtn").classList.toggle("dirty", dirty);
    byId("saveBtn").textContent = dirty ? "保存*" : "保存";
    for (const [id, , title, suffix] of pageButtons) {
      if (byId(id)) byId(id).title = title + (dirty ? suffix : "");
    }
  }

  function setHistoryButtons(canUndo, canRedo) {
    byId("undoBtn").disabled = !canUndo;
    byId("redoBtn").disabled = !canRedo;
  }

  function renderVolumes(volumes, selected) {
    const select = byId("volumeSelect");
    select.replaceChildren(...volumes.map(item => element("option", "", item.shortTitle, { value: item.id })));
    select.value = selected || "";
  }

  function renderToc(title, items) {
    byId("tocTitle").textContent = `${title}目录`;
    const list = byId("tocList");
    list.replaceChildren(...items.map((item) => {
      const li = element("li");
      li.style.setProperty("--level", item.level);
      const link = element("a", "", "", { href: "#" });
      link.dataset.page = item.page;
      link.append(element("span", "", item.page), item.title);
      li.append(link);
      return li;
    }));
    byId("tocBtn").hidden = !items.length;
  }

  function renderNavigation(view) {
    byId("chapterTitle").textContent = view.chapterTitle;
    byId("pageContext").textContent = view.pageContext;
    byId("pagePosition").textContent = view.pageTotal;
    if (document.activeElement !== byId("pageInput")) byId("pageInput").value = view.page;
    byId("volumeSelect").value = view.volume;
    for (const [id, enabled] of pageButtons) {
      if (byId(id)) byId(id).disabled = !view[enabled];
    }
    const panel = document.querySelector('.float-panel[data-panel="tagBar"]');
    const pageTitle = view.page ? `编辑按钮 · 第 ${view.page} 页 · ${view.pageIndex} / ${view.pageTotal}` : "编辑按钮";
    const panelTitle = panel?.querySelector(".fp-title");
    const panelHeader = panel?.querySelector(".fp-header");
    if (panelTitle) panelTitle.textContent = pageTitle;
    if (panelHeader) panelHeader.title = `${pageTitle}：按住标题栏拖动可自由浮动，拖到窗口上/下边缘可停靠，双击恢复默认`;
    byId("saveBtn").disabled = !view.editable;
    document.querySelectorAll("#tocList a").forEach((link) =>
      link.classList.toggle("active", Number(link.dataset.page) === view.chapterPage));
  }

  function renderTools(tags, attrs) {
    const tools = (items, kind) => items.map((item, index) => {
      const node = button(item.label, kind === "attr" ? "" : item.hotkey
        ? `Alt+${item.hotkey === "Enter" ? "Enter" : item.hotkey.toUpperCase()}` : item.title || item.label);
      node.dataset[kind] = index;
      return node;
    });
    const pageButton = (id, direction, label, title) => {
      const node = button(label, title, { id, className: "tag-page-button" });
      node.dataset.pageAdjacent = direction;
      return node;
    };
    byId("tagBar").replaceChildren(
      ...tools(tags, "tag"), element("span", "spacer"),
      ...tools(attrs, "attr"), element("span", "spacer"),
      pageButton("tagPrevBtn", -1, "← Prev", "Prev"),
      pageButton("tagNextPageBtn", 1, "Next →", "Next")
    );
  }

  function showVisual(source, options) {
    visualFrame.onload = () => {
      const doc = visualFrame.contentDocument;
      if (!doc?.body) return;
      doc.body.contentEditable = options.editable ? "true" : "false";
      doc.body.spellcheck = false;
      doc.body.addEventListener("input", () => emit("visualInput"));
      for (const [eventName, handlerName] of [["dblclick", "visualDoubleClick"], ["keydown", "keyDown"], ["click", "visualClick"]]) {
        doc.addEventListener(eventName, (event) => emit(handlerName, ...(eventName === "dblclick" ? [doc] : eventName === "click" ? [event, doc] : [event])));
      }
      const updateLinkMode = (event) => doc.documentElement.classList.toggle("reader-ctrl-link", event.ctrlKey || event.metaKey);
      for (const eventName of ["keydown", "keyup", "mousemove"]) doc.addEventListener(eventName, updateLinkMode);
      visualFrame.contentWindow.addEventListener("blur", () => doc.documentElement.classList.remove("reader-ctrl-link"));
      applyVisualTheme();
      window.dispatchEvent(new CustomEvent("reader-visual-ready", { detail: { document: doc } }));
      if (options.scroll) requestAnimationFrame(() => {
        doc.scrollingElement.scrollTop = options.scroll.top;
        doc.scrollingElement.scrollLeft = options.scroll.left;
      });
    };
    visualFrame.srcdoc = source;
  }

  const frameId = (id) => pdfFrame?.querySelector(`#${id}`);
  function normalizedPdfSettings(value = {}) {
    const color = (input, fallback) => /^#[0-9a-f]{6}$/i.test(String(input)) ? String(input).toLowerCase() : fallback;
    const scale = typeof value.scale === "string" && value.scale.length <= 32 ? value.scale : PDF_DEFAULTS.scale;
    return { ...PDF_DEFAULTS, ...value, brightness: Math.max(50, Math.min(160, Number(value.brightness) || 100)), paper: color(value.paper, PDF_DEFAULTS.paper), ink: color(value.ink, PDF_DEFAULTS.ink), invert: Boolean(value.invert), horizontal: Boolean(value.horizontal), scale };
  }
  function applyPdfSettings() {
    const stage = frameId("stage");
    if (!stage) return;
    stage.style.setProperty("--paper", pdfSettings.paper);
    const channels = (hex) => [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255);
    const ink = channels(pdfSettings.ink), paper = channels(pdfSettings.paper);
    ["filterR", "filterG", "filterB"].forEach((id, index) => frameId(id)?.setAttribute("tableValues", `${ink[index]} ${paper[index]}`));
    const filter = [];
    if (pdfSettings.ink !== PDF_DEFAULTS.ink || pdfSettings.paper !== PDF_DEFAULTS.paper) filter.push("url(#scanColorFilter)");
    if (pdfSettings.brightness !== 100) filter.push(`brightness(${pdfSettings.brightness}%)`);
    if (pdfSettings.invert) filter.push("invert(1)");
    stage.style.setProperty("--scan-filter", filter.join(" ") || "none");
    frameId("brightness").value = pdfSettings.brightness; frameId("brightnessValue").value = `${pdfSettings.brightness}%`;
    frameId("paper").value = pdfSettings.paper; frameId("ink").value = pdfSettings.ink; frameId("invert").checked = pdfSettings.invert;
    const direction = frameId("direction"); direction.setAttribute("aria-pressed", String(pdfSettings.horizontal)); direction.textContent = pdfSettings.horizontal ? "上下翻页" : "左右翻页";
    if (pdfViewer && scrollMode) pdfViewer.scrollMode = pdfSettings.horizontal ? scrollMode.HORIZONTAL : scrollMode.VERTICAL;
  }
  function savePdfSettings() {
    localStorage.setItem(PDF_SETTINGS_KEY, JSON.stringify(pdfSettings));
    clearTimeout(pdfWriteTimer); pdfWriteTimer = setTimeout(() => fetch("/api/reader/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(pdfSettings) }).catch(() => {}), 350);
  }
  function changePdfSettings(patch) { pdfSettings = normalizedPdfSettings({ ...pdfSettings, ...patch }); applyPdfSettings(); savePdfSettings(); }
  function setPdfStatus(message = "") { const node = frameId("missing"); if (!node) return; node.hidden = !message; if (message) node.textContent = message; }
  function showPdfScaleValue() {
    const input = frameId("zoomValue");
    if (!input) return;
    input.value = pdfViewer?.currentScale ? `${Math.round(pdfViewer.currentScale * 100)}%` : "页宽";
  }
  function scalePercent(input, min, max, restore, label = "") {
    const match = input.value.trim().match(/^(\d+(?:\.\d+)?)\s*%?$/);
    const percent = match ? Number(match[1]) : NaN;
    if (Number.isFinite(percent) && percent >= min && percent <= max) return percent / 100;
    restore();
    notify(`${label}缩放比例请输入 ${min}%–${max}%`, true);
  }

  function bindScaleInput(input, commit, restore) {
    input.addEventListener("change", commit);
    input.addEventListener("keydown", event => {
      if (event.key === "Enter") { event.preventDefault(); commit(); input.select(); }
      else if (event.key === "Escape") { event.preventDefault(); restore(); input.blur(); }
    });
  }

  function applyPdfScaleInput() {
    const input = frameId("zoomValue");
    if (!input || !pdfViewer) return showPdfScaleValue();
    const value = input.value.trim().toLowerCase();
    if (["页宽", "适合页宽", "page-width", "auto"].includes(value)) {
      pdfViewer.currentScaleValue = "page-width";
      return;
    }
    const scale = scalePercent(input, 25, 1000, showPdfScaleValue, "PDF ");
    if (scale != null) pdfViewer.currentScaleValue = String(scale);
  }

  function changePdfScale(direction) {
    if (direction > 0) pdfViewer?.increaseScale();
    else if (direction < 0) pdfViewer?.decreaseScale();
  }

  function handlePdfScaleShortcut(event) {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    const wheel = event.type === "wheel";
    const insidePdf = event.target === pdfFrame || event.target.closest?.("#pdfFrame");
    if ((wheel && !insidePdf) || (!wheel && !insidePdf && !pdfShortcutActive)) return;
    const direction = wheel ? (event.deltaY < 0 ? 1 : event.deltaY > 0 ? -1 : 0)
      : ["Equal", "NumpadAdd"].includes(event.code) || event.key === "+" ? 1
        : ["Minus", "NumpadSubtract"].includes(event.code) || event.key === "-" ? -1 : 0;
    if (!direction) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (wheel) pdfShortcutActive = true;
    changePdfScale(direction);
  }

  function pdfPageNumberForLabel(label) {
    const matches = pdfPageLabels?.map((value, index) => String(value) === String(label) ? index + 1 : 0).filter(Boolean);
    const current = pdfViewer?.currentPageNumber || matches?.[0];
    return matches?.reduce((best, page) => Math.abs(page - current) < Math.abs(best - current) ? page : best, matches[0]) || null;
  }
  function showPendingPdfPage() { const page = pdfPageNumberForLabel(pendingPdfOptions?.pageLabel); if (page) pdfViewer.currentPageNumber = page; }
  async function ensurePdfRuntime() {
    if (pdfRuntimePromise) return pdfRuntimePromise;
    pdfRuntimePromise = (async () => {
      const pdfjs = await import("/vendor/pdfjs/build/pdf.mjs"); globalThis.pdfjsLib = pdfjs;
      const viewerModule = await import("/vendor/pdfjs/web/pdf_viewer.mjs"); pdfjs.GlobalWorkerOptions.workerSrc = "/vendor/pdfjs/build/pdf.worker.mjs";
      const eventBus = new viewerModule.EventBus(); pdfLinkService = new viewerModule.PDFLinkService({ eventBus });
      pdfViewer = new viewerModule.PDFViewer({ container: frameId("stage"), viewer: frameId("viewer"), eventBus, linkService: pdfLinkService, imageResourcesPath: "/vendor/pdfjs/web/images/" });
      pdfLinkService.setViewer(pdfViewer); scrollMode = viewerModule.ScrollMode;
      eventBus.on("pagesinit", () => { pdfViewer.setPageLabels(pdfPageLabels); pdfViewer.currentScaleValue = pdfSettings.scale; applyPdfSettings(); showPendingPdfPage(); setPdfStatus(); });
      eventBus.on("pagechanging", ({ pageNumber, pageLabel }) => { if (pageNumber != null) emit("pdfPageChange", { pageNumber, pageLabel }); });
      eventBus.on("scalechanging", ({ scale, presetValue }) => { pdfSettings.scale = presetValue || String(scale); frameId("zoomValue").value = `${Math.round(scale * 100)}%`; savePdfSettings(); });
      return pdfjs;
    })().catch((error) => { pdfRuntimePromise = null; throw error; });
    return pdfRuntimePromise;
  }
  async function setPdf(options) {
    pendingPdfOptions = options;
    const pdfjs = await ensurePdfRuntime();
    const url = options.url || "";
    if (url === pdfUrl && (pdfViewer.pdfDocument || pdfLoadingTask)) return showPendingPdfPage();
    const revision = ++pdfRevision;
    pdfUrl = url; setPdfStatus(url ? "正在载入 PDF…" : "此卷未配置 PDF");
    pdfViewer.setDocument(null); pdfLinkService.setDocument(null); pdfPageLabels = null;
    const oldTask = pdfLoadingTask; pdfLoadingTask = null; await oldTask?.destroy();
    if (!url || revision !== pdfRevision) return;
    try {
      const task = pdfjs.getDocument({ url, cMapUrl: "/vendor/pdfjs/cmaps/", cMapPacked: true, standardFontDataUrl: "/vendor/pdfjs/standard_fonts/", wasmUrl: "/vendor/pdfjs/wasm/" });
      pdfLoadingTask = task;
      const document = await task.promise;
      if (revision !== pdfRevision || task !== pdfLoadingTask) return document.destroy();
      pdfPageLabels = await document.getPageLabels() || Array.from({ length: document.numPages }, (_, index) => String(index + 1));
      if (revision !== pdfRevision) return document.destroy();
      pdfViewer.setDocument(document); pdfLinkService.setDocument(document);
    } catch (error) {
      if (revision !== pdfRevision) return;
      pdfLoadingTask = null; setPdfStatus(`PDF 载入失败：${error.message}`); notify(`PDF 载入失败：${error.message}`, true);
    }
  }
  function initPdfFrame() {
    pdfFrame.innerHTML = PDF_DIRECT_HTML;
    document.addEventListener("pointerdown", (event) => { pdfShortcutActive = pdfFrame.contains(event.target); }, true);
    document.addEventListener("wheel", handlePdfScaleShortcut, { capture: true, passive: false });
    document.addEventListener("keydown", handlePdfScaleShortcut, true);
    (async () => {
      let saved = {};
      try { saved = JSON.parse(localStorage.getItem(PDF_SETTINGS_KEY) || "{}"); } catch { localStorage.removeItem(PDF_SETTINGS_KEY); }
      const legacy = {};
      if (localStorage.getItem("readerPdfHorizontal") != null) legacy.horizontal = localStorage.getItem("readerPdfHorizontal") === "1";
      if (localStorage.getItem("readerImageInverted") != null) legacy.invert = localStorage.getItem("readerImageInverted") === "1";
      if (localStorage.getItem("readerPdfScaleValue")) legacy.scale = localStorage.getItem("readerPdfScaleValue");
      saved = { ...legacy, ...saved };
      try { pdfSettings = normalizedPdfSettings({ ...(await fetch("/api/reader/settings").then((r) => r.ok ? r.json() : {})), ...saved }); } catch { pdfSettings = normalizedPdfSettings(saved); }
      applyPdfSettings();
      frameId("zoomIn").onclick = () => changePdfScale(1); frameId("zoomOut").onclick = () => changePdfScale(-1);
      bindScaleInput(frameId("zoomValue"), applyPdfScaleInput, showPdfScaleValue);
      frameId("zoomValue").ondblclick = () => { if (pdfViewer) pdfViewer.currentScaleValue = "page-width"; };
      frameId("direction").onclick = () => changePdfSettings({ horizontal: !pdfSettings.horizontal }); frameId("settings").onclick = () => frameId("settingsDialog").showModal(); frameId("brightness").oninput = (event) => changePdfSettings({ brightness: event.target.value }); frameId("paper").oninput = (event) => changePdfSettings({ paper: event.target.value }); frameId("ink").oninput = (event) => changePdfSettings({ ink: event.target.value }); frameId("invert").onchange = (event) => changePdfSettings({ invert: event.target.checked }); frameId("reset").onclick = () => changePdfSettings(PDF_DEFAULTS); frameId("full").onclick = () => (document.fullscreenElement ? document.exitFullscreen() : pdfFrame.requestFullscreen()).catch((error) => notify(error.message, true));
      document.addEventListener("fullscreenchange", () => { frameId("full").textContent = document.fullscreenElement ? "退出全屏" : "全屏"; requestAnimationFrame(() => pdfViewer?.update()); });
      if (pendingPdfOptions) setPdf(pendingPdfOptions);
    })().catch((error) => notify(error.message, true));
  }

  function init(handlers) {
    Object.assign(listeners, handlers);
    if (initialized) return;
    initialized = true;
    initPdfFrame();
    for (const action of ["mode", "save", "undo", "redo", "splitView", "combinedView", "find"]) {
      bind(`${action}Btn`, "click", () => emit(action));
    }
    bind("volumeSelect", "change", (event) => emit("volume", event.target.value));
    bind("pageForm", "submit", (event) => {
      event.preventDefault();
      const input = byId("pageInput");
      const page = Number(input.value);
      input.blur();
      emit("page", page);
    });
    for (const [id, direction] of [["prevBtn", -1], ["nextPageBtn", 1]]) bind(id, "click", () => emit("adjacent", direction));
    bind("tocBtn", "click", () => setToc(!root.classList.contains("toc-open")));
    for (const id of ["tocClose", "tocBackdrop"]) bind(id, "click", () => setToc(false));
    bind("tocList", "click", (event) => {
      const link = event.target.closest("[data-page]");
      if (!link) return;
      event.preventDefault();
      setToc(false);
      emit("page", Number(link.dataset.page));
    });
    bind("darkBtn", "click", () => setTheme(!body.classList.contains("dark")));
    bind("tagBar", "click", (event) => {
      for (const [attribute, action] of [["pageAdjacent", "adjacent"], ["tag", "tag"], ["attr", "attr"]]) {
        const node = event.target.closest("button");
        if (node && attribute in node.dataset) emit(action, Number(node.dataset[attribute]));
      }
    });
    document.addEventListener("keydown", (event) => emit("keyDown", event));
    window.addEventListener("beforeunload", (event) => emit("beforeUnload", event));
    setTheme(localStorage.getItem("readerDark") === "1");
  }

  const splitter = document.createElement("div");
  splitter.className = "pane-splitter";
  splitter.setAttribute("role", "separator");
  splitter.setAttribute("aria-label", "调整正文与扫描原图宽度");
  splitter.setAttribute("aria-orientation", "vertical");
  splitter.setAttribute("aria-valuemin", "25");
  splitter.setAttribute("aria-valuemax", "75");
  splitter.tabIndex = 0;
  grid.insertBefore(splitter, scanPane);

  const savedWidth = Number(localStorage.getItem("readerLeftPane"));
  let dragging = false;
  let currentWidth;
  const setWidth = percent => {
    currentWidth = Math.min(75, Math.max(25, percent));
    grid.style.setProperty("--left-pane", `${currentWidth}%`);
    splitter.setAttribute("aria-valuenow", String(Math.round(currentWidth)));
  };
  setWidth(savedWidth >= 25 && savedWidth <= 75 ? savedWidth : 54);
  const resizeTo = clientX => {
    const bounds = grid.getBoundingClientRect();
    setWidth((clientX - bounds.left) / bounds.width * 100);
  };

  splitter.addEventListener("pointerdown", (event) => {
    if (matchMedia("(max-width: 850px)").matches) return;
    dragging = true;
    splitter.classList.add("dragging");
    body.classList.add("resizing");
    splitter.setPointerCapture?.(event.pointerId);
    resizeTo(event.clientX);
    event.preventDefault();
  });

  splitter.addEventListener("pointermove", (event) => {
    if (dragging) resizeTo(event.clientX);
  });

  const stopResize = () => {
    if (!dragging) return;
    dragging = false;
    splitter.classList.remove("dragging");
    body.classList.remove("resizing");
    localStorage.setItem("readerLeftPane", currentWidth.toFixed(2));
  };

  splitter.addEventListener("pointerup", stopResize);
  splitter.addEventListener("pointercancel", stopResize);
  splitter.addEventListener("dblclick", () => {
    setWidth(54);
    localStorage.removeItem("readerLeftPane");
  });

  splitter.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const step = (event.shiftKey ? 5 : 2) * (event.key === "ArrowRight" ? 1 : -1);
    setWidth(event.key === "Home" ? 25 : event.key === "End" ? 75 : currentWidth + step);
    localStorage.setItem("readerLeftPane", currentWidth.toFixed(2));
  });

  const chromeNodes = [document.querySelector(".site-header"), document.querySelector(".page-footer")];
  const chromeHeights = (fallback = 0) => ({
    header: Math.round(chromeNodes[0]?.getBoundingClientRect().height || fallback),
    footer: Math.round(chromeNodes[1]?.getBoundingClientRect().height || 0)
  });
  const syncChromeMetrics = () => {
    for (const [name, height] of Object.entries(chromeHeights(64))) root.style.setProperty(`--app-${name}-height`, `${height}px`);
    window.dispatchEvent(new Event("reader-chrome-resize"));
  };
  const chromeResizeObserver = new ResizeObserver(syncChromeMetrics);
  chromeNodes.filter(Boolean).forEach(node => chromeResizeObserver.observe(node));
  syncChromeMetrics();

  async function toggleSourceFind(replace = true, toggleIfVisible = true) {
    if (!sourceEditor) return;
    const visible = sourceEditor.getDomNode()?.querySelector(".find-widget")?.classList.contains("visible");
    if (visible && toggleIfVisible) return sourceEditor.trigger("reader", "closeFindWidget");
    // Request clipboard access only on first opening, directly from the user gesture.
    const clipboardText = !visible && navigator.clipboard?.readText?.().catch(() => null);
    if (!visible) sourceEditor.focus();
    await sourceEditor.getAction(replace ? "editor.action.startFindReplaceAction" : "actions.find")?.run();
    const text = await clipboardText;
    if (text) sourceEditor.getContribution("editor.contrib.findController")?.setSearchString(text.replace(/\r\n?/g, "\n"));
  }

  function editSource(text, range, origin) {
    sourceEditor.pushUndoStop();
    sourceEditor.executeEdits(origin, [{ range, text, forceMoveMarkers: true }]);
    sourceEditor.pushUndoStop();
  }

  window.ReaderUI = {
    init, notify, setDirty, setHistoryButtons, renderVolumes, renderToc, renderNavigation, renderTools,
    setMode, setWorkspaceMode, setToc, setPdf, applyVisualTheme, showVisual, initMonaco, setEditorScale,
    getSource: () => sourceModel?.getValue() || "",
    setSource: (text, preserveUndo = false) => {
      text = String(text ?? "");
      if (!sourceModel || sourceModel.getValue() === text) return;
      if (!preserveUndo) return sourceModel.setValue(text);
      editSource(text, sourceModel.getFullModelRange(), "reader.visual");
    },
    getSourceSelection: () => {
      const selection = sourceEditor?.getSelection();
      return selection ? { start: sourceModel.getOffsetAt(selection.getStartPosition()), end: sourceModel.getOffsetAt(selection.getEndPosition()) } : { start: 0, end: 0 };
    },
    setSourceSelection: (start, end = start) => sourceEditor.setSelection(monacoApi.Selection.fromPositions(sourceModel.getPositionAt(start), sourceModel.getPositionAt(end))),
    replaceSourceRange: (text, start, end) => editSource(text,
      monacoApi.Range.fromPositions(sourceModel.getPositionAt(start), sourceModel.getPositionAt(end)), "reader.edit"),
    focusSource: () => sourceEditor?.focus(),
    setSourceScroll: ({ top = 0, left = 0 }) => sourceEditor?.setScrollPosition({ scrollTop: top, scrollLeft: left }),
    setSourceEditable: (editable) => sourceEditor?.updateOptions({ readOnly: !editable }),
    canUndo: () => Boolean(sourceModel?.canUndo()),
    canRedo: () => Boolean(sourceModel?.canRedo()),
    undoSource: () => sourceEditor?.trigger("reader", "undo"),
    redoSource: () => sourceEditor?.trigger("reader", "redo"),
    toggleFind: toggleSourceFind,
    hasSourceTextFocus: () => Boolean(sourceEditor?.hasTextFocus()),
    getVisualDocument: () => visualFrame.contentDocument
  };

/* 编辑工具面板：单一状态源管理停靠、浮动、拉伸和缩放。 */
(() => {
  "use strict";
  const LS_KEY = "readerDockPanels.v1";
  const SNAP = 56, MIN_SCALE = .8, MAX_SCALE = 1.6, CONTROL_HEIGHT = 28;
  const DOCK_DEFS = [
    ["editor-top", "栏上", "停靠编辑框上方（与编辑框等宽）"],
    ["editor-bottom", "栏下", "停靠编辑框下方（与编辑框等宽）"],
    ["window-top", "窗上", "停靠窗口顶部（与窗口等宽）"],
    ["window-bottom", "窗下", "停靠窗口底部（与窗口等宽）"],
    ["floating", "浮动", "自由浮动（可拖动、可拉伸）"]
  ];
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(LS_KEY)) || {}; } catch { /* use defaults */ }
  const clampScale = value => Math.min(MAX_SCALE, Math.max(MIN_SCALE, Number(value) || 1));
  let editorScale = clampScale(saved._editorScale);
  let lastScaleTarget = "editor";

  const snapTop = element("div", "fp-snap fp-snap-top");
  const snapBottom = element("div", "fp-snap fp-snap-bottom");
  document.body.append(snapTop, snapBottom);
  const content = document.querySelector("#tagBar");
  if (!content) return;
  const panel = element("div", "float-panel");
  panel.dataset.panel = "tagBar";
  const header = element("div", "fp-header");
  const title = element("span", "fp-title", "编辑按钮");
  const actions = element("div", "fp-actions");
  actions.setAttribute("role", "group");
  actions.setAttribute("aria-label", "编辑按钮与编辑框尺寸及停靠位置");
  header.title = "编辑按钮：按住标题栏拖动可自由浮动，拖到窗口上/下边缘可停靠，双击恢复默认";
  header.append(element("span", "fp-grip", "≡"), title, actions);
  content.parentNode.insertBefore(panel, content);
  panel.append(header, content);

  const state = Object.assign({ dock: "editor-top", x: 60, y: 96, w: 520, h: null, scale: 1, naturalH: 56 }, saved.tagBar || {});
  state.scale = clampScale(state.scale);
  const measured = Math.round(panel.offsetHeight);
  if (measured) state.naturalH = measured;

  const minHeight = () => Math.ceil((header.getBoundingClientRect().height || 27) + CONTROL_HEIGHT * state.scale);
  const heightLimit = () => {
    const { header: top, footer } = chromeHeights();
    const available = Math.max(80, innerHeight - top - footer);
    return state.dock.startsWith("window-") ? Math.max(minHeight(), available - 120)
      : state.dock.startsWith("editor-") ? Math.max(minHeight(), panel.parentElement.getBoundingClientRect().height - 100)
        : available;
  };

  function save() {
    const { dock, x, y, w, h, scale } = state;
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({
        _editorScale: editorScale,
        tagBar: { dock, x: Math.round(x), y: Math.round(y), w: Math.round(w), h: h == null ? null : Math.round(h), scale }
      }));
    } catch { /* storage is optional */ }
  }

  function updateScaleControls(target) {
    const value = target === "editor" ? editorScale : state.scale;
    const input = actions.querySelector(`[data-scale-input="${target}"]`);
    input.value = `${Math.round(value * 100)}%`;
    const group = input.closest(".fp-scale-actions");
    group.querySelector('[data-scale-action="smaller"]').disabled = value <= MIN_SCALE;
    group.querySelector('[data-scale-action="larger"]').disabled = value >= MAX_SCALE;
    if (target === "editor") return window.ReaderUI?.setEditorScale(editorScale);
    const contentMinHeight = Math.ceil(CONTROL_HEIGHT * state.scale);
    panel.style.setProperty("--fp-header-height", `${header.getBoundingClientRect().height || 27}px`);
    panel.style.setProperty("--fp-scale", state.scale);
    panel.style.setProperty("--fp-content-min-height", `${contentMinHeight}px`);
  }

  function updateWindowDockLayout() {
    const { header, footer } = chromeHeights();
    const docked = state.dock.startsWith("window-") && panel.getClientRects().length;
    const height = docked ? Math.round(panel.getBoundingClientRect().height) : 0;
    const topHeight = state.dock === "window-top" ? height : 0;
    const bottomHeight = state.dock === "window-bottom" ? height : 0;
    if (topHeight) panel.style.top = `${header}px`;
    if (bottomHeight) panel.style.bottom = `${footer}px`;
    document.documentElement.style.setProperty("--window-dock-top", `${topHeight}px`);
    document.documentElement.style.setProperty("--window-dock-bottom", `${bottomHeight}px`);
    snapTop.style.top = `${header + topHeight}px`;
    snapBottom.style.bottom = `${footer + bottomHeight}px`;
  }

  function clampFloating() {
    if (state.dock !== "floating") return;
    const { header, footer } = chromeHeights();
    state.w = Math.min(Math.max(150, state.w), innerWidth);
    state.h = Math.min(Math.max(minHeight(), state.h || panel.getBoundingClientRect().height || state.naturalH), Math.max(80, innerHeight - header - footer));
    state.x = Math.min(innerWidth - 36, Math.max(36 - state.w, state.x));
    state.y = Math.min(innerHeight - footer - 28, Math.max(header, state.y));
    Object.assign(panel.style, { left: `${state.x}px`, top: `${state.y}px`, width: `${state.w}px`, height: `${state.h}px` });
  }

  function applyPanel() {
    const parent = panel.parentElement;
    panel.classList.remove("dock-editor-top", "dock-editor-bottom", "dock-window-top", "dock-window-bottom", "floating");
    panel.classList.add(state.dock === "floating" ? "floating" : `dock-${state.dock}`);
    parent.classList.toggle("bar-bottom", state.dock === "editor-bottom");
    parent.classList.toggle("bar-fixed", state.dock.startsWith("window-") || state.dock === "floating");
    panel.style.left = panel.style.top = panel.style.right = panel.style.bottom = panel.style.width = "";
    const fixed = state.dock.startsWith("window-") || state.dock === "floating";
    let h = fixed ? state.h ?? state.naturalH : state.h;
    if (h != null) {
      h = Math.min(Math.max(minHeight(), h), heightLimit());
      state.h = state.h == null && state.dock !== "floating" ? null : h;
    }
    panel.style.height = h != null ? `${h}px` : "";
    panel.classList.toggle("auto-height", h == null);
    updateScaleControls("tag");
    clampFloating();
    panel.querySelectorAll(".fp-dock").forEach((btn) => {
      const active = btn.dataset.dock === state.dock;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-pressed", String(active));
    });
    requestAnimationFrame(updateWindowDockLayout);
  }

  function floatPanel() {
    if (state.dock === "floating") return;
    const rect = panel.getBoundingClientRect();
    Object.assign(state, { dock: "floating", x: rect.left, y: rect.top, w: rect.width, h: state.h ?? Math.round(rect.height) });
  }

  function dock(target) {
    if (target === "floating") floatPanel();
    state.dock = target;
    applyPanel();
    save();
  }

  function trackPointer(move, finish) {
    const clean = () => {
      document.body.classList.remove("panel-dragging");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", clean);
    };
    const up = () => { clean(); finish(); };
    document.body.classList.add("panel-dragging");
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up, { once: true });
    window.addEventListener("pointercancel", clean, { once: true });
  }

  header.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    if (event.target.closest(".fp-actions, .fp-handle, button")) return;
    event.preventDefault();
    floatPanel();
    applyPanel();
    const offsetX = event.clientX - state.x, offsetY = event.clientY - state.y;
    let snap = null;
    const move = (ev) => {
      const { header: top, footer } = chromeHeights();
      state.x = Math.min(innerWidth - 36, Math.max(36 - panel.offsetWidth, ev.clientX - offsetX));
      state.y = Math.min(innerHeight - footer - 28, Math.max(top, ev.clientY - offsetY));
      Object.assign(panel.style, { left: `${state.x}px`, top: `${state.y}px` });
      snap = ev.clientY < top + SNAP + 6 ? "top" : ev.clientY > innerHeight - footer - SNAP - 6 ? "bottom" : null;
      snapTop.classList.toggle("active", snap === "top");
      snapBottom.classList.toggle("active", snap === "bottom");
    };
    trackPointer(move, () => {
      snapTop.classList.remove("active");
      snapBottom.classList.remove("active");
      if (snap) dock(`window-${snap}`);
      else save();
    });
  });

  function bindResize(handle, dir) {
    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      const rect = panel.getBoundingClientRect();
      const startX = event.clientX, startY = event.clientY;
      const base = { x: rect.left, y: rect.top, w: rect.width, h: rect.height };
      const move = (ev) => {
        const dx = ev.clientX - startX, dy = ev.clientY - startY;
        let { x, y, w, h } = base;
        const maxHeight = heightLimit();
        if (dir.includes("e")) w = Math.min(innerWidth - x, Math.max(150, base.w + dx));
        if (dir.includes("w")) {
          w = Math.min(base.x + base.w, Math.max(150, base.w - dx));
          x = base.x + base.w - w;
        }
        if (dir.includes("s")) h = Math.min(maxHeight, Math.max(minHeight(), base.h + dy));
        if (dir.includes("n")) { h = Math.min(maxHeight, Math.max(minHeight(), base.h - dy)); y = base.y + base.h - h; }
        Object.assign(state, { x, y, w, h });
        if (state.dock === "floating") Object.assign(panel.style, { left: `${x}px`, top: `${y}px`, width: `${w}px` });
        panel.style.height = `${h}px`;
        updateWindowDockLayout();
      };
      trackPointer(move, save);
    });
  }

  function setScale(target, value) {
    const scale = Math.round(clampScale(value) * 100) / 100;
    if (target === "editor") editorScale = scale;
    else state.scale = scale;
    updateScaleControls(target);
    if (target !== "editor") {
      if (state.h != null) {
        const required = Math.ceil((header.offsetHeight || 27) + content.scrollHeight + panel.offsetHeight - panel.clientHeight);
        state.h = Math.min(Math.max(state.h, required, minHeight()), heightLimit());
        panel.style.height = `${state.h}px`;
      }
      updateWindowDockLayout();
    }
    save();
  }

  const changeScale = (target, delta) => setScale(target, (target === "editor" ? editorScale : state.scale) + delta);
  function commitScaleInput(input) {
    const target = input.dataset.scaleInput;
    const scale = scalePercent(input, MIN_SCALE * 100, MAX_SCALE * 100, () => updateScaleControls(target));
    if (scale != null) setScale(target, scale);
  }

  function panelButton(label, tip, className, data) {
    const node = button(label, tip, { className });
    node.setAttribute("aria-label", tip);
    Object.assign(node.dataset, data);
    return node;
  }

  function makeScaleActions(target, label) {
    const group = element("span", "fp-scale-actions");
    group.dataset.scaleTarget = target;
    group.setAttribute("role", "group");
    group.setAttribute("aria-label", `${label}缩放`);
    const input = element("input", "fp-scale-input", "", {
      type: "text", inputMode: "decimal", maxLength: 5, value: "100%",
      title: `${label}缩放比例：输入 80%–160% 后按回车；双击恢复 100%`
    });
    input.dataset.scaleInput = target;
    input.setAttribute("aria-label", `${label}缩放比例`);
    group.append(element("span", "fp-scale-label", target === "editor" ? "编辑" : "标签"),
      panelButton("−", `缩小${label}（Ctrl+−）`, "fp-scale-control", { scaleAction: "smaller" }), input,
      panelButton("＋", `放大${label}（Ctrl+＋）`, "fp-scale-control", { scaleAction: "larger" }));
    return group;
  }

  actions.append(makeScaleActions("editor", "编辑框"), makeScaleActions("tag", "标签按钮"));
  for (const [dockName, label, tip] of DOCK_DEFS) {
    actions.append(panelButton(label, tip, "fp-dock", { dock: dockName }));
  }
  for (const dir of ["n", "s", "e", "w", "ne", "nw", "se", "sw"]) {
    const handle = element("div", `fp-handle fp-handle-${dir}`);
    handle.dataset.dir = dir;
    panel.append(handle);
    bindResize(handle, dir);
  }

  actions.addEventListener("pointerdown", (event) => {
    const group = event.target.closest("[data-scale-target]");
    if (!group) return;
    lastScaleTarget = group.dataset.scaleTarget;
    event.stopPropagation();
    if (!event.target.matches("input")) event.preventDefault();
  });
  actions.addEventListener("click", (event) => {
    const scaleButton = event.target.closest("[data-scale-action]");
    if (scaleButton) {
      event.preventDefault();
      changeScale(scaleButton.closest("[data-scale-target]").dataset.scaleTarget, scaleButton.dataset.scaleAction === "larger" ? .1 : -.1);
    }
    const dockButton = event.target.closest(".fp-dock");
    if (dockButton) dock(dockButton.dataset.dock);
  });
  for (const input of actions.querySelectorAll("[data-scale-input]")) {
    input.addEventListener("focus", () => input.select());
    bindScaleInput(input, () => commitScaleInput(input), () => updateScaleControls(input.dataset.scaleInput));
    input.addEventListener("dblclick", () => { setScale(input.dataset.scaleInput, 1); input.select(); });
  }
  header.addEventListener("dblclick", (event) => {
    if (event.target.closest(".fp-actions, button")) return;
    Object.assign(state, { dock: "editor-top", h: null, x: 60, y: 96, w: 520 });
    applyPanel();
    save();
  });

  function bindScaleShortcuts(doc, fixedTarget = null) {
    const scaleShortcut = event => {
      const wheel = event.type === "wheel";
      if (!(event.ctrlKey || event.metaKey) || (!wheel && event.altKey)) return;
      const direction = wheel ? (event.deltaY < 0 ? 1 : -1)
        : ["Equal", "NumpadAdd"].includes(event.code) || event.key === "+" ? 1
          : ["Minus", "NumpadSubtract"].includes(event.code) || event.key === "-" ? -1 : 0;
      if (!direction) return;
      const target = fixedTarget || (event.target.closest?.('.float-panel[data-panel="tagBar"]') ? "tag"
        : event.target.closest?.("#sourcePane, #monacoEditor, #visualEditor") ? "editor" : wheel ? null : lastScaleTarget);
      if (!target) return;
      lastScaleTarget = target;
      event.preventDefault();
      if (!wheel) event.stopPropagation();
      changeScale(target, direction * .1);
    };
    doc.addEventListener("wheel", scaleShortcut, { capture: true, passive: false });
    doc.addEventListener("keydown", scaleShortcut, true);
  }

  updateScaleControls("editor");
  applyPanel();
  bindScaleShortcuts(document);
  window.addEventListener("reader-visual-ready", (event) => bindScaleShortcuts(event.detail.document, "editor"));
  window.addEventListener("reader-mode-change", updateWindowDockLayout);
  window.addEventListener("reader-chrome-resize", updateWindowDockLayout);
  window.addEventListener("resize", () => {
    clampFloating();
    updateWindowDockLayout();
  });
  updateWindowDockLayout();
})();
})();
