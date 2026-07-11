const $ = (id) => document.getElementById(id);
const state = { config: null, volume: null, page: null, source: "", savedSource: "", mtime: null, editable: true, dirty: false, mode: "visual", zoom: 1, sideBySide: false, matches: [], match: -1, undo: [], redo: [], pendingVisualScroll: null };
const tags = [
  ["B", "b", "<b>", "</b>", "Alt+B / b"], ["I", "i", "<i>", "</i>", "Alt+I / i"],
  ["Q", "q", "<blockquote>", "</blockquote>", "Alt+Q / q"], ["A", "a", "<a href=\"\" id=\"\">", "</a>", "Alt+A / a"],
  ["ID", "x", "<a id=\"\">", "</a>", "Alt+X / x"],
  ["HREF", "l", "<a href=\"\">", "</a>", "Alt+L / l"], ["FN", "f", "<sup><a href=\"\" id=\"\">", "</a></sup>", "Alt+F / f"],
  ["R", "r", "<p align=\"right\">", "</p>", "Alt+R / r"], ["C", "c", "<p align=\"center\">", "</p>", "Alt+C / c"],
  ["H1", "1", "<h1>", "</h1>", "Alt+1 / 1"], ["H2", "2", "<h2>", "</h2>", "Alt+2 / 2"], ["H3", "3", "<h3>", "</h3>", "Alt+3 / 3"],
  ["H4", "4", "<h4>", "</h4>", "Alt+4 / 4"], ["H5", "5", "<h5>", "</h5>", "Alt+5 / 5"], ["H6", "6", "<h6>", "</h6>", "Alt+6 / 6"],
  ["P", "p", "<p>", "</p>", "Alt+P / p"], ["BR", "Enter", "<br>\n", "", "Alt+Enter"],
  ["DIV", "d", "<div>", "</div>", "Alt+D / d"], ["SPAN", "s", "<span>", "</span>", "Alt+S / s"]
];
const tagMap = Object.fromEntries(tags.map((tag) => [tag[1].toLowerCase(), tag]));
const attrs = [["ID=", ' id=""', 5],["CLASS=", ' class=""', 8],["STYLE=", ' style=""', 8],["text-indent: 0", " style=\"text-indent: 0;\"", 23]];

function esc(value) {
  return String(value).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;");
}

async function api(url, options) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

function note(message) {
  $("status").textContent = message;
  clearTimeout(note.timer);
  note.timer = setTimeout(() => { $("status").textContent = ""; }, 2600);
}

function markDirty(on = true) {
  state.dirty = on;
  $("saveBtn").classList.toggle("dirty", on);
  $("saveBtn").textContent = on ? "保存*" : "保存";
}

function currentSnapshot() {
  const editor = document.getElementById("editor");
  const visualDocument = document.getElementById("visualEditor").contentDocument;
  const scroll = state.mode === "visual" ? (visualDocument?.scrollingElement?.scrollTop || 0) : editor.scrollTop;
  const scrollLeft = state.mode === "visual" ? (visualDocument?.scrollingElement?.scrollLeft || 0) : editor.scrollLeft;
  const text = state.mode === "visual" ? sourceFromVisual() : editor.value;
  return { text, a: editor.selectionStart || 0, b: editor.selectionEnd || 0, scroll, scrollLeft };
}

function updateHistoryButtons() {
  const undoButton = document.getElementById("undoBtn");
  const redoButton = document.getElementById("redoBtn");
  if (undoButton) undoButton.disabled = !state.undo.length;
  if (redoButton) redoButton.disabled = !state.redo.length;
}

function remember() {
  if (!state.page) return;
  const snap = currentSnapshot();
  const last = state.undo[state.undo.length - 1];
  if (!last || last.text !== snap.text || last.a !== snap.a || last.b !== snap.b) state.undo.push(snap);
  if (state.undo.length > 100) state.undo.shift();
  state.redo = [];
  updateHistoryButtons();
}

function applySnapshot(snap) {
  state.source = snap.text;
  if (state.mode === "source") {
    const editor = document.getElementById("editor");
    editor.value = snap.text;
    editor.focus();
    editor.setSelectionRange(Math.min(snap.a, snap.text.length), Math.min(snap.b, snap.text.length));
    editor.scrollTop = snap.scroll || 0;
    editor.scrollLeft = snap.scrollLeft || 0;
    updateHighlight();
  } else { state.pendingVisualScroll = { top: snap.scroll || 0, left: snap.scrollLeft || 0 }; showVisual(); }
  markDirty(state.source !== state.savedSource);
  updateHistoryButtons();
}

function undo() {
  const snap = state.undo.pop();
  if (!snap) return note("没有可撤销的操作");
  state.redo.push(currentSnapshot());
  applySnapshot(snap);
  note("已撤销");
}

function redo() {
  const snap = state.redo.pop();
  if (!snap) return note("没有可重做的操作");
  state.undo.push(currentSnapshot());
  applySnapshot(snap);
  note("已重做");
}

function tagKeydown(event) {
  if (!event.altKey || event.ctrlKey || event.metaKey) return false;
  const key = event.key === "Enter" ? "enter" : event.key.toLowerCase();
  const tag = tagMap[key];
  if (!tag) return false;
  event.preventDefault();
  insert(tag[2], tag[3]);
  return true;
}
function historyKeydown(event) {
  if (!(event.ctrlKey || event.metaKey)) return;
  const key = event.key.toLowerCase();
  if (key === "z") { event.preventDefault(); event.shiftKey ? redo() : undo(); }
  else if (key === "y") { event.preventDefault(); redo(); }
}
function installHistoryButtons() {
  const saveButton = document.getElementById("saveBtn");
  const undoButton = document.createElement("button");
  const redoButton = document.createElement("button");
  undoButton.id = "undoBtn"; undoButton.textContent = "撤销"; undoButton.title = "撤销 Ctrl+Z";
  redoButton.id = "redoBtn"; redoButton.textContent = "重做"; redoButton.title = "重做 Ctrl+Y";
  saveButton.before(undoButton, redoButton);
  undoButton.onclick = undo; redoButton.onclick = redo;
  updateHistoryButtons();
}
function volume() {
  return state.config?.volumes.find((item) => item.id === state.volume);
}

function activeChapter() {
  let active = null;
  for (const item of volume()?.toc || []) {
    if (item.page <= state.page) active = item;
    else break;
  }
  return active;
}

function injectEditorDocument(source) {
  const base = `<base href="/api/reader/resource/${encodeURIComponent(state.volume)}/">`;
  const style = `<style data-reader-editor>html{background:var(--reader-bg,#fff)}body{max-width:760px;margin:0 auto;padding:40px 48px 80px;background:var(--reader-bg,#fff);color:var(--reader-ink,#251f1b);font:18px/1.75 Georgia,"Noto Serif SC","SimSun",serif;outline:none}img{max-width:100%;height:auto}a{color:var(--reader-link,#8f2923)}.reader-ctrl-link a[href]{text-decoration:underline;cursor:pointer}body:focus{box-shadow:inset 0 0 0 2px #9d2b2430}</style>`;
  if (/<head\b[^>]*>/i.test(source)) return source.replace(/<head\b[^>]*>/i, (head) => `${head}${base}${style}`);
  if (/<html\b[^>]*>/i.test(source)) return source.replace(/<html\b[^>]*>/i, (html) => `${html}<head>${base}${style}</head>`);
  return `<!doctype html><html><head>${base}${style}</head><body>${source}</body></html>`;
}

function applyVisualTheme() {
  const doc = document.getElementById("visualEditor").contentDocument;
  if (!doc?.body) return;
  const dark = document.body.classList.contains("dark");
  doc.documentElement.style.colorScheme = dark ? "dark" : "light";
  doc.documentElement.style.setProperty("--reader-bg", dark ? "#1e1e1e" : "#ffffff");
  doc.documentElement.style.setProperty("--reader-ink", dark ? "#d4d4d4" : "#251f1b");
  doc.documentElement.style.setProperty("--reader-link", dark ? "#4fc1ff" : "#8f2923");
}
function setVisualLinkMode(doc, event) {
  doc.documentElement.classList.toggle("reader-ctrl-link", event.ctrlKey || event.metaKey);
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
      note(`Jumped to ${href}`);
    } else note(`Anchor not found: ${href}`);
    return;
  }
  window.open(new URL(href, doc.baseURI).href, "_blank");
}

  const frame = $("visualEditor");
function showVisual() {
  frame.onload = () => {
    const doc = frame.contentDocument;
    if (!doc?.body) return;
    doc.body.contentEditable = state.editable ? "true" : "false";
    doc.body.spellcheck = false;
    doc.body.addEventListener("beforeinput", remember);
    doc.body.addEventListener("input", () => markDirty());
    doc.addEventListener("keydown", historyKeydown);
    doc.addEventListener("keydown", tagKeydown);
    applyVisualTheme();
    doc.addEventListener("click", (event) => openVisualLink(event, doc));
    doc.addEventListener("keydown", (event) => setVisualLinkMode(doc, event));
    doc.addEventListener("keyup", (event) => setVisualLinkMode(doc, event));
    doc.addEventListener("mousemove", (event) => setVisualLinkMode(doc, event));
    frame.contentWindow.addEventListener("blur", () => doc.documentElement.classList.remove("reader-ctrl-link"));
    if (state.pendingVisualScroll != null) { const position = state.pendingVisualScroll; state.pendingVisualScroll = null; requestAnimationFrame(() => { doc.scrollingElement.scrollTop = position.top; doc.scrollingElement.scrollLeft = position.left; }); }
  };
  frame.srcdoc = injectEditorDocument(state.source);
}

function sourceFromVisual() {
  const live = $("visualEditor").contentDocument;
  if (!live?.body) return state.source;
  const parsed = new DOMParser().parseFromString(state.source, "text/html");
  parsed.body.innerHTML = live.body.innerHTML;
  parsed.head.querySelectorAll("[data-reader-editor]").forEach((node) => node.remove());
  const doctype = parsed.doctype ? `<!DOCTYPE ${parsed.doctype.name}>` : "<!doctype html>";
  return `${doctype}\n${parsed.documentElement.outerHTML}`;
}

function syncFromVisual() {
  state.source = sourceFromVisual();
}

function setMode(mode) {
  if (!state.page) return;
  if (mode === "source" && state.mode === "visual") {
    // Show the file text loaded by the server, not a serialization of the preview DOM.
    $("editor").value = state.source;
    updateHighlight();
  } else if (mode === "visual" && state.mode === "source") {
    state.source = $("editor").value;
    showVisual();
  }
  state.mode = mode;
  $("sourcePane").hidden = mode !== "source";
  $("visualEditor").hidden = mode === "source";
  $("modeBtn").textContent = mode === "source" ? "可视化" : "源代码";
}

function nearestPage(requested) {
  const pages = volume()?.pages || [];
  if (pages.includes(requested)) return requested;
  return pages.reduce((best, page) => Math.abs(page - requested) < Math.abs(best - requested) ? page : best, pages[0]);
}

async function navigate(targetVolume, targetPage, force = false) {
  if (!force && state.dirty && !confirm("当前页有未保存修改，仍要离开吗？")) return false;
  const nextVolume = state.config.volumes.find((item) => item.id === String(targetVolume));
  if (!nextVolume) return false;
  const page = nearestPage.call({ volume: () => nextVolume }, Number(targetPage));
  const actualPage = nextVolume.pages.includes(Number(targetPage)) ? Number(targetPage)
    : nextVolume.pages.reduce((best, item) => Math.abs(item - Number(targetPage)) < Math.abs(best - Number(targetPage)) ? item : best, nextVolume.pages[0]);
  try {
    const data = await api(`/api/reader/page/${encodeURIComponent(nextVolume.id)}/${actualPage}`);
    state.volume = nextVolume.id; state.page = actualPage; state.source = data.text;
    state.savedSource = data.text; state.undo = []; state.redo = []; updateHistoryButtons();
    state.mtime = data.mtime; state.editable = data.editable; state.mode = "visual";
    $("volumeSelect").value = state.volume; $("pageInput").value = state.page;
    $("sourcePane").hidden = true; $("visualEditor").hidden = false; $("modeBtn").textContent = "源代码";
    $("editor").value = state.source; markDirty(false); showVisual(); renderNavigation(); setImages(data.imageUrl, imagePages(nextVolume, actualPage));
    history.replaceState(null, "", `?volume=${encodeURIComponent(state.volume)}&page=${state.page}`);
    if (!state.editable) note("远程页面：只读");
    return true;
  } catch (error) {
    note(error.message);
    return false;
  }
}

function renderNavigation() {
  const current = volume();
  const index = current.pages.indexOf(state.page);
  const chapter = activeChapter();
  $("chapterTitle").textContent = chapter?.title || current.title;
  $("pageContext").textContent = `${current.shortTitle} · 第 ${state.page} 页`;
  $("pagePosition").textContent = `第 ${state.page} 页 · ${index + 1} / ${current.pages.length}`;
  $("prevBtn").disabled = index <= 0; $("nextPageBtn").disabled = index >= current.pages.length - 1;
  $("saveBtn").disabled = !state.editable;
  document.querySelectorAll("#tocList a").forEach((link) => link.classList.toggle("active", Number(link.dataset.page) === chapter?.page));
}

function renderVolumes() {
  $("volumeSelect").innerHTML = state.config.volumes.map((item) => `<option value="${esc(item.id)}">${esc(item.shortTitle)}</option>`).join("");
}

function renderToc() {
  const current = volume();
  $("tocTitle").textContent = `${current.shortTitle}目录`;
  $("tocList").innerHTML = current.toc.map((item) =>
    `<li style="--level:${item.level}"><a href="#" data-page="${item.page}"><span>${item.page}</span>${esc(item.title)}</a></li>`
  ).join("");
  $("tocBtn").hidden = !current.toc.length;
}

function imagePages(currentVolume, page) {
  const index = currentVolume.pages.indexOf(page);
  const nextPage = currentVolume.pages[index + 1];
  const end = Number.isFinite(nextPage) ? nextPage : page + 1;
  return Array.from({ length: Math.max(1, end - page) }, (_, offset) => page + offset);
}

function imageUrlForPage(url, sourcePage, targetPage) {
  if (targetPage === sourcePage) return url;
  const parsed = new URL(url, location.href);
  const parts = parsed.pathname.split("/");
  for (let index = parts.length - 1; index >= 0; index--) {
    const matches = [...parts[index].matchAll(/\d+/g)];
    const match = matches.reverse().find((item) => Number(item[0]) === sourcePage);
    if (!match) continue;
    const replacement = String(targetPage).padStart(match[0].length, "0");
    parts[index] = parts[index].slice(0, match.index) + replacement + parts[index].slice(match.index + match[0].length);
    parsed.pathname = parts.join("/");
    return parsed.href;
  }
  return url;
}

function updateImageLayout() {
  const stage = $("scanStage");
  const images = stage.querySelectorAll(".scan-page-image");
  const canSpread = images.length > 1;
  const button = $("imageLayout");
  button.hidden = !canSpread;
  button.setAttribute("aria-pressed", String(canSpread && state.sideBySide));
  button.textContent = state.sideBySide ? "上下分布" : "左右分布";
  stage.classList.toggle("side-by-side", canSpread && state.sideBySide);
}

function setZoom(zoom) {
  state.zoom = Math.max(.25, Math.min(3, zoom));
  document.querySelectorAll(".scan-page-image").forEach((image) => image.style.setProperty("--zoom", state.zoom));
  $("zoomFit").textContent = `${Math.round(state.zoom * 100)}%`;
}

function setImages(url, pages) {
  const stage = $("scanStage");
  const dialog = $("imageDialog");
  stage.querySelectorAll(".scan-page-image").forEach((image) => image.remove());
  dialog.querySelectorAll(".dialog-page-image").forEach((image) => image.remove());
  $("scanImage").hidden = true;
  $("dialogImage").hidden = true;
  setZoom(1);
  let loaded = 0;

  const urls = url ? pages.map((page) => imageUrlForPage(url, state.page, page)) : [];
  $("scanMissing").hidden = Boolean(urls.length);
  $("fullImage").disabled = !urls.length;

  urls.forEach((imageUrl, index) => {
    const image = document.createElement("img");
    image.className = "scan-page-image";
    image.alt = "";
    image.loading = "lazy";
    image.decoding = "async";
    image.style.setProperty("--zoom", 1);
    image.onload = () => {
      if (!image.isConnected) return;
      loaded += 1; $("scanMissing").hidden = true; $("fullImage").disabled = false;
    };
    image.onerror = () => {
      if (!image.isConnected) return;
      image.remove();
      updateImageLayout();
      if (!loaded && !stage.querySelector(".scan-page-image")) {
        $("scanMissing").hidden = false;
        $("fullImage").disabled = true;
      }
    };
    image.src = imageUrl;
    stage.insertBefore(image, $("scanMissing"));

    const fullImage = document.createElement("img");
    fullImage.className = "dialog-page-image";
    fullImage.alt = image.alt;
    fullImage.loading = "lazy";
    fullImage.decoding = "async";
    fullImage.style.cssText = "display:block;max-width:none;margin:0 auto 16px";
    fullImage.src = imageUrl;
    fullImage.onerror = () => fullImage.remove();
    dialog.appendChild(fullImage);
  });
  updateImageLayout();
}

async function save() {
  if (!state.editable) return;
  if (state.mode === "visual") syncFromVisual(); else state.source = $("editor").value;
  try {
    const result = await api(`/api/reader/page/${encodeURIComponent(state.volume)}/${state.page}`, {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: state.source, mtime: state.mtime })
    });
    state.mtime = result.mtime; state.savedSource = state.source; $("editor").value = state.source; markDirty(false); note("已保存");
  } catch (error) { note(error.message); }
}

function attrToken(raw, value) {
  const link = raw.match(/^\s*href\s*=\s*(["'])([\s\S]*?)\1$/i);
  if (link) return `<span class="tok-string">${esc(link[1])}</span><span class="tok-link" data-href="${esc(link[2])}" title="Ctrl+click to open">${esc(link[2])}</span><span class="tok-string">${esc(link[1])}</span>`;
  return `<span class="tok-string">${esc(value)}</span>`;
}

function colorTag(raw) {
  if (raw.startsWith("<!--")) return `<span class="tok-comment">${esc(raw)}</span>`;
  let result = "", last = 0;
  const pattern = /(<\/?)([A-Za-z][\w:-]*)|([\w:-]+)(\s*=\s*)("[^"]*"|'[^']*')|([<>\/=])/g;
  for (let match; (match = pattern.exec(raw));) {
    result += esc(raw.slice(last, match.index));
    if (match[1]) result += `${esc(match[1])}<span class="tok-tag">${esc(match[2])}</span>`;
    else if (match[3]) result += `<span class="tok-attr">${esc(match[3])}</span>${esc(match[4])}${attrToken(match[0], match[5])}`;
    else result += esc(match[6]);
    last = match.index + match[0].length;
  }
  return result + esc(raw.slice(last));
}

function colorHtml(text) {
  let result = "", last = 0;
  const pattern = /<!--[\s\S]*?-->|<\/?[A-Za-z][^>]*?>/g;
  for (let match; (match = pattern.exec(text));) {
    result += esc(text.slice(last, match.index)) + colorTag(match[0]);
    last = match.index + match[0].length;
  }
  return result + esc(text.slice(last)) + (text.endsWith("\n") ? " " : "");
}

function updateHighlight() {
  $("highlight").innerHTML = colorHtml($("editor").value);
  $("highlight").scrollTop = $("editor").scrollTop; $("highlight").scrollLeft = $("editor").scrollLeft;
}


function scrollSelectionIntoView(editor, pos) {
  const wrap = editor.parentElement;
  const style = getComputedStyle(editor);
  const mirror = document.createElement("div");
  const marker = document.createElement("span");
  mirror.style.cssText = `position:absolute;visibility:hidden;inset:0 auto auto 0;width:${editor.clientWidth}px;min-height:${editor.clientHeight}px;padding:${style.padding};border:0;margin:0;box-sizing:border-box;overflow-wrap:break-word;white-space:pre-wrap;font:${style.font};line-height:${style.lineHeight};letter-spacing:${style.letterSpacing};tab-size:${style.tabSize}`;
  mirror.textContent = editor.value.slice(0, pos);
  marker.textContent = "\u200b";
  mirror.append(marker);
  wrap.append(mirror);
  editor.scrollTop = Math.max(0, marker.offsetTop - editor.clientHeight / 2);
  editor.scrollLeft = Math.max(0, marker.offsetLeft - editor.clientWidth / 2);
  mirror.remove();
  updateHighlight();
}

function gotoAnchor(fragment) {
  const id = decodeURIComponent(fragment.slice(1));
  if (!id) return false;
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`\\bid\\s*=\\s*(["'])${escaped}\\1`, "i").exec($("editor").value);
  if (!match) return false;
  const start = match.index + match[0].lastIndexOf(id);
  const editor = $("editor");
  editor.focus();
  editor.setSelectionRange(start, start + id.length);
  scrollSelectionIntoView(editor, start);
  note(`Jumped to ${fragment}`);
  return true;
}

function openSourceHref(href) {
  if (href.startsWith("#")) {
    if (!gotoAnchor(href)) note(`Anchor not found: ${href}`);
    return;
  }
  const base = `/api/reader/resource/${encodeURIComponent(state.volume)}/`;
  window.open(new URL(href, location.origin + base).href, "_blank");
}

function openHighlightedLink(event) {
  if (!(event.ctrlKey || event.metaKey)) return;
  const link = event.target.closest(".tok-link[data-href]");
  if (!link) return;
  event.preventDefault();
  openSourceHref(link.dataset.href);
}

function setLinkClickMode(event) {
  document.querySelector(".editor-wrap")?.classList.toggle("ctrl-link", event.ctrlKey || event.metaKey);
}


function insertVisual(open, close) {
  remember();
  const doc = document.getElementById("visualEditor").contentDocument;
  if (!doc?.body || !state.editable) return;
  doc.body.focus();
  const selection = doc.getSelection();
  const selected = selection && selection.rangeCount ? selection.getRangeAt(0).cloneContents() : null;
  const holder = doc.createElement("div");
  if (selected) holder.append(selected);
  doc.execCommand("insertHTML", false, open + holder.innerHTML + close);
  markDirty();
  doc.body.focus();
}
function insert(open, close = "", offset = null) {
  if (state.mode === "visual") return insertVisual(open, close);
  remember();
  const editor = $("editor"), start = editor.selectionStart, end = editor.selectionEnd;
  const selected = editor.value.slice(start, end);
  editor.setRangeText(open + selected + close, start, end, "end");
  if (!selected && close) editor.setSelectionRange(start + (offset ?? open.length), start + (offset ?? open.length));
  state.source = editor.value; markDirty(); updateHighlight(); editor.focus();
}

function regex() {
  const query = $("findText").value;
  if (!query) return null;
  const flags = `g${$("caseBox").checked ? "" : "i"}`;
  return $("regexBox").checked ? new RegExp(query, flags) : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags);
}

function findAll() {
  state.matches = []; state.match = -1;
  try {
    const pattern = regex(); if (!pattern) return $("findInfo").textContent = "";
    for (let match; (match = pattern.exec($("editor").value));) {
      state.matches.push([match.index, match.index + match[0].length]);
      if (!match[0]) pattern.lastIndex += 1;
    }
    $("findInfo").textContent = `${state.matches.length} 处`;
  } catch (error) { $("findInfo").textContent = error.message; }
}

function nextMatch() {
  findAll(); if (!state.matches.length) return;
  state.match = (state.match + 1) % state.matches.length;
  const [start, end] = state.matches[state.match]; $("editor").focus(); $("editor").setSelectionRange(start, end);
  $("findInfo").textContent = `${state.match + 1}/${state.matches.length}`;
}

function replaceOne() {
  nextMatch(); if (!state.matches.length) return;
  const [start, end] = state.matches[state.match];
  remember();
  $("editor").setRangeText($("replaceText").value, start, end, "end");
  state.source = $("editor").value; markDirty(); updateHighlight();
}

function replaceAll() {
  try {
    const pattern = regex(); if (!pattern) return;
    remember();
    $("editor").value = $("editor").value.replace(pattern, $("replaceText").value);
    state.source = $("editor").value; markDirty(); updateHighlight(); findAll();
  } catch (error) { $("findInfo").textContent = error.message; }
}

function buildTools() {
  $("tagBar").innerHTML = tags.map((tag, index) => `<button data-tag="${index}">${esc(tag[0])}</button>`).join("")
    + attrs.map((item, index) => `<button data-attr="${index}">${esc(item[0])}</button>`).join("");
  document.querySelectorAll("#tagBar [data-tag]").forEach((button) => { const tag = tags[Number(button.dataset.tag)]; button.title = "Alt+" + (tag[1] === "Enter" ? "Enter" : tag[1].toUpperCase()); });
  $("tagBar").onclick = (event) => {
    const tag = event.target.closest("[data-tag]"), attr = event.target.closest("[data-attr]");
    if (tag) { const item = tags[Number(tag.dataset.tag)]; insert(item[2], item[3]); }
    if (attr) { if (state.mode === "visual") return note("属性按钮请在源代码模式使用"); const item = attrs[Number(attr.dataset.attr)]; insert(item[1], "", item[2]); }
  };
}

function closeToc() { document.documentElement.classList.remove("toc-open"); }
function adjacent(direction) {
  const pages = volume().pages, index = pages.indexOf(state.page);
  if (pages[index + direction] != null) navigate(state.volume, pages[index + direction]);
}

async function init() {
  installHistoryButtons();
  buildTools();
  try {
    state.config = await api("/api/reader/config"); renderVolumes();
    const params = new URLSearchParams(location.search);
    const firstVolume = state.config.volumes.find((item) => item.id === params.get("volume")) || state.config.volumes[0];
    if (!firstVolume) throw new Error("配置中没有找到包含 HTML 页面的卷册");
    state.volume = firstVolume.id; renderToc();
    await navigate(firstVolume.id, Number(params.get("page")) || firstVolume.pages[0], true);
  } catch (error) { $("chapterTitle").textContent = "载入失败"; note(error.message); }
}

$("modeBtn").onclick = () => setMode(state.mode === "visual" ? "source" : "visual");
$("saveBtn").onclick = save;
$("volumeSelect").onchange = async () => {
  const target = state.config.volumes.find((item) => item.id === $("volumeSelect").value);
  if (await navigate(target.id, target.pages[0])) renderToc(); else $("volumeSelect").value = state.volume;
};
$("pageForm").onsubmit = (event) => { event.preventDefault(); navigate(state.volume, Number($("pageInput").value)); };
$("prevBtn").onclick = () => adjacent(-1); $("nextPageBtn").onclick = () => adjacent(1);
$("tocBtn").onclick = () => document.documentElement.classList.add("toc-open");
$("tocClose").onclick = closeToc; $("tocBackdrop").onclick = closeToc;
$("tocList").onclick = (event) => { const link = event.target.closest("[data-page]"); if (link) { event.preventDefault(); closeToc(); navigate(state.volume, Number(link.dataset.page)); } };
document.getElementById("editor").addEventListener("beforeinput", remember);
$("editor").oninput = () => { state.source = $("editor").value; markDirty(); updateHighlight(); };
$("editor").onscroll = updateHighlight;
$("highlight").addEventListener("click", openHighlightedLink);
$("findBtn").onclick = nextMatch; $("nextBtn").onclick = nextMatch; $("replaceBtn").onclick = replaceOne; $("allBtn").onclick = replaceAll;
$("findText").oninput = findAll; $("regexBox").onchange = findAll; $("caseBox").onchange = findAll;
$("zoomIn").onclick = () => setZoom(state.zoom + .25);
$("zoomOut").onclick = () => setZoom(state.zoom - .25);
$("zoomFit").onclick = () => setZoom(1);
$("imageLayout").onclick = () => { state.sideBySide = !state.sideBySide; updateImageLayout(); };
$("fullImage").onclick = () => $("imageDialog").showModal(); $("dialogClose").onclick = () => $("imageDialog").close();
document.addEventListener("keydown", setLinkClickMode);
document.addEventListener("keyup", setLinkClickMode);
window.addEventListener("blur", () => document.querySelector(".editor-wrap")?.classList.remove("ctrl-link"));
$("darkBtn").onclick = () => { document.body.classList.toggle("dark"); localStorage.setItem("readerDark", document.body.classList.contains("dark") ? "1" : "0"); };
document.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && ["z", "y"].includes(event.key.toLowerCase())) return historyKeydown(event);
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); save(); }
  if (event.key === "Escape") closeToc();
  if (tagKeydown(event)) return;
  if (event.target.matches("input,textarea,[contenteditable]")) return;
  if (event.key === "ArrowLeft") adjacent(-1);
  if (event.key === "ArrowRight") adjacent(1);
});
window.addEventListener("beforeunload", (event) => { if (state.dirty) { event.preventDefault(); event.returnValue = ""; } });
document.body.classList.toggle("dark", localStorage.getItem("readerDark") === "1");
new MutationObserver(applyVisualTheme).observe(document.body, { attributes: true, attributeFilter: ["class"] });
init();
