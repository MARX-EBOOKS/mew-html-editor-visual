// Monaco workbench. File persistence and tag parsing retain the original editor semantics.
let editor, monaco, previewTimer = 0, openRevision = 0, closing = false;
const PREVIEW_DELAY = 200, TAG_PANEL_KEY = 'mewMonacoTagPanel.v1';
const $ = id => document.getElementById(id);
const state = { path: "", docs: new Map(), checkingTree: false, cssText: "", treeText: "" };
const editorScale = () => Math.min(1.6, Math.max(.8,
  Number.parseFloat(document.documentElement.style.getPropertyValue('--editor-scale')) || 1));
const applyEditorScale = (scale = editorScale()) => editor?.updateOptions({
  fontSize: 14 * scale, lineHeight: Math.round(21 * scale)
});
window.addEventListener('mew-editor-scale-change', event => applyEditorScale(event.detail));
let saveAllChordTimer = 0, saveAllChordPending = false;

function handleSaveAllChord(event) {
  if (event.isComposing) return;
  const key = event.key.toLowerCase();
  if (saveAllChordPending) {
    if (['control', 'meta', 'shift', 'alt'].includes(key)) return;
    clearTimeout(saveAllChordTimer);
    saveAllChordPending = false;
    if (key !== 's' || event.altKey || event.shiftKey) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    saveAll();
    return;
  }
  if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || key !== 'k') return;
  event.preventDefault();
  event.stopImmediatePropagation();
  saveAllChordPending = true;
  clearTimeout(saveAllChordTimer);
  saveAllChordTimer = setTimeout(() => { saveAllChordPending = false; }, 2000);
}
const readerSession = (() => {
  const value = new URLSearchParams(location.search).get('readerSession') || '';
  return /^[\w-]{1,128}$/.test(value) ? value : '';
})();
let readerChannel = null;

function channelFor(session, receive) {
  const name = `mew-reader-${session}`;
  if ('BroadcastChannel' in window) {
    const channel = new BroadcastChannel(name);
    channel.onmessage = event => receive(event.data);
    return channel;
  }
  const key = `__${name}`;
  const listener = event => {
    if (event.key !== key || !event.newValue) return;
    try { receive(JSON.parse(event.newValue).message); } catch { /* ignore malformed peer data */ }
  };
  window.addEventListener('storage', listener);
  return {
    postMessage(message) { localStorage.setItem(key, JSON.stringify({ nonce: crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`, message })); },
    close() { window.removeEventListener('storage', listener); }
  };
}

function announceEditorPage() {
  if (!readerChannel || !state.path) return;
  readerChannel.postMessage({ source: 'editor', type: 'editor-page', path: state.path, dirty: Boolean(doc()?.dirty) });
}

function startReaderSync() {
  if (!readerSession) return;
  readerChannel = channelFor(readerSession, message => {
    if (!message || message.source !== 'reader') return;
    if (message.type === 'reader-page' && message.path) {
      if (message.path === state.path) return announceEditorPage();
      openFile(message.path);
    } else if (message.type === 'reader-ready') announceEditorPage();
    else if (message.type === 'reader-detached') {
      readerChannel?.close();
      readerChannel = null;
      note('阅读器已恢复合窗；本编辑器继续独立运行');
    }
  });
  readerChannel.postMessage({ source: 'editor', type: 'editor-ready' });
  document.title = 'MEW Monaco Editor · 阅读器联控';
}
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
const tagMap = new Map(tags.filter(tag => tag.shortcut).map(tag => [tag.shortcut.toLowerCase(), tag]));
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
    this.reloadRevision = 0;
    this.read = read;
    this.write = write;
    this.pending = Promise.resolve();
  }

  get dirty() { return this.content !== this.savedContent; }

  textFromEditor(text) {
    // Monaco may normalize line endings. Keep the original bytes when
    // the editor still represents the current or saved source.
    const normalize = value => value.replace(/\r\n?/g, "\n");
    for (const source of [this.content, this.savedContent]) {
      if (normalize(source) === normalize(text)) return source;
    }
    return text;
  }

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
      if (data.text === this.savedContent) {
        this.mtime = data.mtime;
        return "unchanged";
      }
      if (data.text === this.content) {
        this.savedContent = data.text;
        this.mtime = data.mtime;
        return "saved";
      }
      if (this.dirty) return "conflict";
      this.reloadRevision += 1;
      this.content = data.text;
      this.savedContent = data.text;
      this.mtime = data.mtime;
      return "updated";
    });
  }
}
function api(url, options) {
  if (window.MEWBackend) return window.MEWBackend.api(url, options);
  return fetch(url, options).then(async r => {
    const type = r.headers.get("content-type") || "";
    const data = type.includes("json") ? await r.json() : await r.text();
    if (!r.ok || data.error) throw new Error(data.error || data);
    return data;
  });
}
function postJson(url, data) {
  return api(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(data)
  });
}
function note(msg) { $("status").textContent = msg; setTimeout(() => { if ($("status").textContent === msg) $("status").textContent = ""; }, 2500); }
function esc(s) { return s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c])); }
function fileLabel(path) { return path.split("/").pop() || path || "Untitled"; }
function doc() { return state.docs.get(state.path); }

async function loadTree(rel = "", host = $("tree"), open = new Set()) {
  const data = await api(`/api/tree?path=${encodeURIComponent(rel)}`);
  $("rootPath").textContent = data.root;
  const box = rel ? document.createElement("div") : host;
  if (rel) box.className = "indent";
  box.innerHTML = "";
  for (const e of data.entries) {
    const row = document.createElement("div");
    row.className = "item";
    row.dataset.path = e.path;
    row.dataset.type = e.type;
    row.title = e.type === "file" ? "Click to open in this window." : "Click to expand.";
    row.innerHTML = `<span>${e.type === "dir" ? "+" : "-"}</span><span class="name">${esc(e.name)}</span>`;
    row.tabIndex = 0;
    row.setAttribute("role", "treeitem");
    if (e.type === "dir") row.setAttribute("aria-expanded", String(open.has(e.path)));
    row.onkeydown = ev => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); row.click(); } };
    row.onclick = ev => {
      ev.stopPropagation();
      if (e.type === "dir") return toggleDir(row, e.path).catch(error => note(error.message));
      openFile(e.path);
    };
    box.append(row);
    if (e.type === "dir" && open.has(e.path)) {
      row.firstChild.contentContent = "-";
      await loadTree(e.path, row, open);
    }
  }
  if (rel) host.after(box);
  box.querySelector(`.item[data-path="${CSS.escape(state.path)}"]`)?.classList.add("active");
}
async function toggleDir(row, rel) {
  const next = row.nextElementSibling;
  if (next?.classList.contains("indent")) { next.remove(); row.setAttribute("aria-expanded", "false"); row.firstChild.contentContent = "+"; return; }
  row.firstChild.contentContent = "-";
  row.setAttribute("aria-expanded", "true");
  await loadTree(rel, row);
  filterTree();
}
function openDirs() {
  return new Set([...document.querySelectorAll(".item[data-type='dir']")]
    .filter(row => row.nextElementSibling?.classList.contains("indent"))
    .map(row => row.dataset.path));
}
async function refreshTree() {
  if (state.checkingTree) {
    clearTimeout(treeRefreshTimer);
    treeRefreshTimer = setTimeout(refreshTree, 80);
    return;
  }
  state.checkingTree = true;
  try {
    const open = openDirs();
    const nextTree = document.createElement("div");
    await loadTree("", nextTree, open);
    const nextText = nextTree.textContent;
    if (state.treeText !== nextText) {
      $("tree").replaceChildren(...nextTree.childNodes);
      if (state.treeText) note("File tree updated");
      filterTree();
    }
    state.treeText = nextText;
  } catch (e) {
    note(e.message);
  } finally {
    state.checkingTree = false;
  }
}
async function openFile(rel) {
  const request = ++openRevision;
  if (state.docs.has(rel)) return switchDoc(rel);
  try {
    const d = await DocumentModel.load({
      read: async () => {
        const data = await api(`/api/file?path=${encodeURIComponent(rel)}`);
        rel = data.path;
        return data;
      },
      write: snapshot => postJson("/api/save", { path: rel, ...snapshot })
    });
    // A second open may have completed while this request was in flight.
    if (!state.docs.has(rel)) state.docs.set(rel, Object.assign(d, {
      path: rel
    }));
    if (request === openRevision) switchDoc(rel);
  } catch (error) { note(error.message); }
}
async function openSiblingFile(direction) {
  if (!state.path) return note("Open a file first");
  const current = doc();
  if (current?.dirty) {
    try {
      await current.saveUntilClean();
      markDirty();
    } catch (error) {
      note(`自动保存失败：${error.message}`);
      return;
    }
  }
  const parts = state.path.split("/");
  const currentName = parts.pop();
  const dir = parts.join("/");
  try {
    const data = await api(`/api/tree?path=${encodeURIComponent(dir)}`);
    const files = data.entries.filter(entry => entry.type === "file");
    const currentIndex = files.findIndex(entry => entry.name === currentName);
    if (currentIndex < 0 || files.length < 2) return note("No other file in this folder");
    const target = files[(currentIndex + direction + files.length) % files.length];
    await openFile(target.path);
  } catch (e) {
    note(e.message);
  }
}

function openFileWindow() {
  if (!state.path) return note("Open a file first");
  const url = new URL(location.href);
  url.searchParams.set("file", state.path);
  url.searchParams.delete("readerSession");
  window.open(url, "_blank");
}
async function save() {
  const d = doc();
  if (!d) return note("Open a file first");
  const savedText = d.content;
  try {
    const data = await d.save(savedText);
    if (d.path === state.path) markDirty(true);
    else renderTabs();
    note(`Saved ${data.path}${d.dirty ? "; newer edits remain unsaved" : ""}`);
  } catch (e) {
    note(e.message);
  }
}
async function saveAll() {
  for (const d of [...state.docs.values()]) {
    if (!d.dirty) continue;
    const savedText = d.content;
    try {
      await d.save(savedText);
    } catch (e) {
      switchDoc(d.path); note(e.message); return;
    }
  }
  markDirty(true);
  note([...state.docs.values()].some(d => d.dirty) ? "Saved snapshots; newer edits remain unsaved" : "Saved all");
}
function refreshPreview() {
  clearTimeout(previewTimer);
  if (!state.path) return;
  $("preview").hidden = false;
  const dir = state.path.split("/").slice(0, -1).join("/");
  const { bg, ink } = themeColors();
  const css = `${state.cssText ? `<style>${state.cssText}</style>` : '<link rel="stylesheet" href="/mewde.css">'}<style>body{background:${bg};color:${ink}}</style>`;
  const baseUrl = window.MEWBackend?.rawUrl(dir, true) || `/raw/${encodeURI(dir)}${dir ? "/" : ""}`;
  const base = `<base href="${baseUrl}">`;
  $("preview").srcdoc = base + css + editor.getValue();
}
function openRaw() {
  if (state.path) {
    const { bg, ink } = themeColors();
    if (window.MEWBackend) return window.MEWBackend.openRaw(state.path, editor.getValue(), state.cssText, { bg, ink });
    window.open(`/raw/${encodeURI(state.path)}?bg=${encodeURIComponent(bg)}&fg=${encodeURIComponent(ink)}`, "_blank");
  }
}

function buildTagEdit(text, start, end, tag) {
  const elements = tagPairs(text);
  const selected = text.slice(start, end);
  const name = /^<([A-Za-z][\w:-]*)\b/.exec(tag.open)?.[1].toLowerCase();
  const simple = name && tag.close.toLowerCase() === `</${name}>`;
  const complete = start < end && isCompleteSelection(text, elements, start, end);
  const exact = complete && elements.find(element => element.start === start && element.end === end);

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

  const block = blockTagIds.has(tag.id) && innermost(elements.filter(element => blockTagNames.has(element.name)), start, end);
  if (block) return changeWrapper(text, block, start, end, blockId(block) === tag.id ? undefined : tag);

  const same = simple && innermost(elements.filter(element => element.name === name), start, end);
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
    .filter(element => (start === end && element.start < start && start < element.openEnd) ||
      (element.openEnd <= start && end <= element.closeStart))
    .reduce((inner, element) => !inner || element.end - element.start < inner.end - inner.start ? element : inner, undefined);
}

function isCompleteSelection(text, elements, start, end) {
  let cursor = start, found = false;
  while (cursor < end && /\s/.test(text[cursor])) cursor += 1;
  while (cursor < end) {
    const outer = elements
      .filter(element => element.start === cursor && element.end <= end)
      .reduce((root, element) => !root || element.end > root.end ? element : root, undefined);
    if (!outer) return false;
    found = true;
    cursor = outer.end;
    while (cursor < end && /\s/.test(text[cursor])) cursor += 1;
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
      const open = stack[stack.length - 1];
      if (open?.name !== name) {
        const crossed = stack.findLastIndex(item => item.name === name);
        // 交叉标签截断栈；没有同名开始标签时，按最近的开始标签容错配对。
        if (crossed >= 0) { stack.length = crossed; continue; }
      }
      if (open) {
        stack.pop();
        pairs.push({ name: open.name, closeName: name, start: open.start, openEnd: open.end, closeStart: match.index, end: tagPattern.lastIndex, open: open.token });
        if (name === rawName) rawName = undefined;
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


function buildTagBar() {
  $("tagBar").innerHTML = [
    ...tags.map((tag, i) => `<button class="tag" data-i="${i}" title="${esc(tag.title)}">${esc(tag.label)}</button>`),
    '<span class="spacer"></span>',
    ...attrs.map((attr, i) => `<button class="tag attrTag" data-attr="${i}" title="${esc(attr.title)}">${esc(attr.label)}</button>`),
    '<span class="spacer"></span>',
    '<button id="tagPrevFileBtn" class="tag attrTag tagFileNav" data-nav="-1" title="上一文件；切换前自动保存">←</button>',
    '<button id="tagNextFileBtn" class="tag attrTag tagFileNav" data-nav="1" title="下一文件；切换前自动保存">→</button>'
  ].join("");
  $("tagBar").onclick = e => {
    const tag = e.target.closest("button[data-i]");
    const attr = e.target.closest("button[data-attr]");
    const nav = e.target.closest("button[data-nav]");
    if (tag) editTag(tags[Number(tag.dataset.i)]);
    if (attr) insertAttr(attrs[Number(attr.dataset.attr)]);
    if (nav) openSiblingFile(Number(nav.dataset.nav));
  };
}

function setupTagPanel() {
  const pane = document.querySelector(".editorPane");
  const panel = $("tagPanel");
  const grip = $("tagPanelGrip");
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(TAG_PANEL_KEY) || "{}"); } catch {}

  const clamp = (value, min, max) => Math.min(Math.max(value, min), Math.max(min, max));
  const persist = dock => localStorage.setItem(TAG_PANEL_KEY, JSON.stringify({ dock, x: panel.offsetLeft, y: panel.offsetTop }));
  const placeFloating = (x, y) => {
    const maxX = pane.clientWidth - panel.offsetWidth - 8;
    const maxY = pane.clientHeight - panel.offsetHeight - 8;
    panel.style.left = `${clamp(x, 8, maxX)}px`;
    panel.style.top = `${clamp(y, 8, maxY)}px`;
  };
  const setDock = (dock, x = saved.x ?? 16, y = saved.y ?? 50) => {
    if (!["top", "bottom", "floating"].includes(dock)) dock = "top";
    panel.className = `tagPanel ${dock === "floating" ? "floating" : `dock-${dock}`}`;
    panel.style.left = panel.style.top = "";
    if (dock === "floating") requestAnimationFrame(() => {
      placeFloating(x, y);
      persist(dock);
    });
    panel.querySelectorAll("[data-tag-dock]").forEach(button => button.classList.toggle("active", button.dataset.tagDock === dock));
    if (dock !== "floating") persist(dock);
  };

  panel.addEventListener("click", event => {
    const button = event.target.closest("[data-tag-dock]");
    if (button) setDock(button.dataset.tagDock);
  });
  grip.addEventListener("pointerdown", event => {
    if (event.button !== 0 || event.target.closest("button")) return;
    event.preventDefault();
    const paneRect = pane.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    const dx = event.clientX - panelRect.left;
    const dy = event.clientY - panelRect.top;
    if (!panel.classList.contains("floating")) setDock("floating", panelRect.left - paneRect.left, panelRect.top - paneRect.top);
    grip.setPointerCapture(event.pointerId);
    const move = moveEvent => placeFloating(moveEvent.clientX - paneRect.left - dx, moveEvent.clientY - paneRect.top - dy);
    const up = () => {
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", up);
      grip.removeEventListener("pointercancel", up);
      persist("floating");
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", up);
    grip.addEventListener("pointercancel", up);
  });
  window.addEventListener("resize", () => {
    if (panel.classList.contains("floating")) placeFloating(panel.offsetLeft, panel.offsetTop);
  });
  setDock(saved.dock || "top", saved.x, saved.y);
}
const externalCheckTimers = new Map();
let treeRefreshTimer = 0;
async function checkExternalUpdate(path) {
  const d = state.docs.get(path);
  if (!d) return;
  try {
    const result = await d.refresh();
    if (state.docs.get(path) !== d) return;
    if (result === "conflict") note(`External update pending for ${d.path}; close and reopen to reload`);
    else if (result === "updated") applyExternalUpdate(d);
    else if (result === "saved") {
      if (d.path === state.path) markDirty(true);
      else renderTabs();
    }
  } catch (e) {
    note(`External file unavailable: ${d.path}`);
  }
}
function scheduleExternalUpdate(path) {
  clearTimeout(externalCheckTimers.get(path));
  externalCheckTimers.set(path, setTimeout(() => {
    externalCheckTimers.delete(path);
    checkExternalUpdate(path);
  }, 80));
}
function connectFileEvents() {
  const handleChange = change => {
    if (change.event === "ready") return;
    if (change.path === "mewde.css") checkCssUpdate();
    if (state.docs.has(change.path)) scheduleExternalUpdate(change.path);
    if (change.event === "change" && change.path) return;
    clearTimeout(treeRefreshTimer);
    treeRefreshTimer = setTimeout(refreshTree, 80);
  };
  if (window.MEWBackend) return window.MEWBackend.connectEvents(handleChange);
  const events = new EventSource("/api/events");
  events.onmessage = event => {
    let change;
    try { change = JSON.parse(event.data); } catch { return; }
    handleChange(change);
  };
}
async function checkCssUpdate() {
  try {
    const text = await api("/mewde.css", { cache: "no-store" });
    const changed = text !== state.cssText;
    state.cssText = text;
    if (changed) refreshPreview();
  } catch {}
}
function toggleFull() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen();
}
function closeMenus(except) {
  document.querySelectorAll(".menu[open]").forEach(menu => {
    if (menu !== except) menu.open = false;
  });
}

// Each opened file owns one Monaco model and view state. The workbench's tree,
// tabs, preview and commands all address this same document registry.
function languageForPath(path) {
  const name = String(path).replaceAll("\\", "/").split("/").pop().toLowerCase();
  const languages = monaco.languages.getLanguages();
  const named = languages.find(language => language.filenames?.some(filename => filename.toLowerCase() === name));
  if (named) return named.id;
  let match = null;
  for (const language of languages) {
    for (const extension of language.extensions || []) {
      const suffix = extension.toLowerCase();
      if (name.endsWith(suffix) && (!match || suffix.length > match.suffix.length)) match = { id: language.id, suffix };
    }
  }
  return match?.id || "plaintext";
}
function languageLabel(id) {
  const language = monaco.languages.getLanguages().find(item => item.id === id);
  return language?.aliases?.[0] || id;
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
function modelFor(d) {
  if (!d.model) {
    d.model = monaco.editor.createModel(d.content, languageForPath(d.path), monaco.Uri.from({ scheme: 'mew', path: '/' + d.path }));
    d.listener = d.model.onDidChangeContent(() => {
      d.content = d.textFromEditor(d.model.getValue());
      if (d === doc()) { markDirty(true); scheduleEditorRefresh(); }
      else renderTabs();
    });
  }
  return d.model;
}
function themeColors() {
  const style = getComputedStyle(document.body);
  return { bg: style.getPropertyValue('--bg').trim(), ink: style.getPropertyValue('--ink').trim() };
}
function saveEditorView() {
  const d = doc();
  if (!d || editor.getModel() !== d.model) return;
  d.viewState = editor.saveViewState();
}
function markDirty() {
  const d = doc();
  $('fileName').textContent = d ? d.path + (d.dirty ? ' *' : '') : 'No file open';
  const tagTitle = $('tagPanelTitle');
  tagTitle.textContent = d ? `标签 · ${fileLabel(d.path)}` : '标签';
  tagTitle.title = d?.path || '';
  $('tagPrevFileBtn').disabled = !d;
  $('tagNextFileBtn').disabled = !d;
  renderTabs();
  announceEditorPage();
}
function renderTabs() {
  const tabs = $('tabs');
  tabs.innerHTML = [...state.docs.values()].map(d => `<button class="tab${d === doc() ? ' active' : ''}" data-path="${esc(d.path)}" title="${esc(d.path)}"><span class="tabName">${esc(fileLabel(d.path))}${d.dirty ? ' *' : ''}</span><span class="tabClose" data-close="${esc(d.path)}" title="Close">×</span></button>`).join('');
  tabs.querySelector('.tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}
function setActiveTreePath(path = '') {
  document.querySelectorAll('#tree .item').forEach(row => {
    row.classList.toggle('active', row.dataset.path === path);
    row.setAttribute('aria-selected', String(row.dataset.path === path));
  });
}
function switchDoc(path) {
  saveEditorView();
  const d = state.docs.get(path);
  if (!d) return;
  state.path = path;
  editor.setModel(modelFor(d));
  const language = d.model.getLanguageId();
  editor.updateOptions({
    readOnly: !d.editable,
    colorDecorators: ["html", "css", "scss", "less"].includes(language),
    defaultColorDecorators: language === "html" ? "never" : "auto"
  });
  $('languageInfo').textContent = `${languageLabel(language)} · UTF-8`;
  if (d.viewState) editor.restoreViewState(d.viewState);
  setActiveTreePath(path); markDirty(); refreshPreview(); editor.focus();
}
function scheduleEditorRefresh() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(refreshPreview, PREVIEW_DELAY);
}
function applyExternalUpdate(d) {
  // Also update inactive models; otherwise switching tabs could restore stale text.
  if (d.model && d.model.getValue() !== d.content) {
    const view = d === doc() ? editor.saveViewState() : null;
    d.model.setValue(d.content);
    if (view) editor.restoreViewState(view);
  }
  markDirty();
  if (d === doc()) refreshPreview();
  note(`Updated ${d.path}`);
}
function offsets() {
  const model = editor.getModel(), selection = editor.getSelection();
  return [model.getOffsetAt(selection.getStartPosition()), model.getOffsetAt(selection.getEndPosition())];
}
function applyEdit(start, end, text, selectStart, selectEnd) {
  if (!doc()?.editable) return;
  const model = editor.getModel();
  const range = monaco.Range.fromPositions(model.getPositionAt(start), model.getPositionAt(end));
  editor.pushUndoStop();
  editor.executeEdits('mew.tag', [{ range, text, forceMoveMarkers: true }], () => [
    monaco.Selection.fromPositions(model.getPositionAt(start + selectStart), model.getPositionAt(start + selectEnd))
  ]);
  editor.pushUndoStop(); editor.focus();
  editor.revealRangeInCenterIfOutsideViewport(editor.getSelection());
}
function editTag(tag) {
  if (!doc()) return note('Open a file first');
  const [start, end] = offsets();
  const op = buildTagEdit(editor.getValue(), start, end, tag);
  applyEdit(op.start, op.end, op.text, op.selectStart, op.selectEnd);
}
function insertAttr(attr) {
  if (!doc()) return note('Open a file first');
  const [a, b] = offsets();
  applyEdit(a, b, attr.text, attr.cursorOffset, attr.cursorOffset);
}
function undo() { editor.trigger('mew', 'undo'); editor.focus(); }
function redo() { editor.trigger('mew', 'redo'); editor.focus(); }
function toggleFindReplace() {
  if (!editor) return;
  const findWidget = editor.getDomNode()?.querySelector('.find-widget');
  if (findWidget?.classList.contains('visible')) {
    editor.trigger('mew', 'closeFindWidget');
    return;
  }
  editor.focus();
  editor.getAction('editor.action.startFindReplaceAction')?.run();
}
function askClose(d) {
  $('closeMessage').textContent = `${d.path} 有未保存的修改，是否保存？`;
  const dialog = $('closeDialog');
  return new Promise(resolve => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue), { once: true });
    dialog.returnValue = 'cancel'; dialog.showModal();
  });
}
async function closeDocs(paths) {
  if (closing) return;
  closing = true;
  ++openRevision;
  try {
    for (const path of paths) {
      const d = state.docs.get(path);
      if (!d) continue;
      if (d.dirty) {
        const choice = await askClose(d);
        if (choice === 'cancel' || !choice) break;
        if (choice === 'save') {
          try { await d.saveUntilClean(); }
          catch (error) { note(error.message); break; }
        }
      }
      if (state.docs.get(path) !== d) continue;
      if (doc() === d) { editor.setModel(null); state.path = ''; }
      state.docs.delete(path);
      d.listener?.dispose(); d.model?.dispose();
    }
    if (!doc()) {
      const next = state.docs.keys().next().value;
      if (next) switchDoc(next);
      else {
        editor.setModel(null);
        $('preview').hidden = true;
        $('preview').srcdoc = '';
        setActiveTreePath();
      }
    }
    markDirty();
  } finally { closing = false; }
}
function closeAll(savedOnly = false) {
  return closeDocs([...state.docs.values()].filter(d => !savedOnly || !d.dirty).map(d => d.path));
}
function filterTree() {
  const q = $('treeFilter').value.toLowerCase();
  document.querySelectorAll('#tree .item').forEach(row => {
    row.hidden = row.dataset.type !== 'dir' && !row.dataset.path.toLowerCase().includes(q);
  });
}
async function revealFile() {
  const parts = state.path.split('/'); parts.pop();
  let path = '';
  for (const part of parts) {
    path += (path ? '/' : '') + part;
    const row = document.querySelector(`#tree .item[data-path="${CSS.escape(path)}"]`);
    if (row && !row.nextElementSibling?.classList.contains('indent')) await toggleDir(row, path);
  }
  $('treeFilter').value = ''; filterTree(); setActiveTreePath(state.path);
  document.querySelector('#tree .active')?.scrollIntoView({ block: 'nearest' });
}

function setDark(on) {
  document.body.classList.toggle('dark', on);
  localStorage.setItem('mewDark', on ? '1' : '0');
  $('darkBtn').textContent = on ? 'Light' : 'Dark';
  const style = getComputedStyle(document.body);
  const color = name => style.getPropertyValue('--' + name).trim().replace(/^#([a-f0-9])([a-f0-9])([a-f0-9])$/i, '#$1$1$2$2$3$3');
  monaco.editor.defineTheme('mew', {
    base: on ? 'vs-dark' : 'vs', inherit: true,
    rules: [
      { token: 'tag', foreground: color('tag').slice(1) },
      { token: 'attribute.name', foreground: color('attr').slice(1) },
      { token: 'attribute.value', foreground: color('string').slice(1) },
      { token: 'comment', foreground: color('comment').slice(1) }
    ],
    colors: { 'editor.background': color('bg'), 'editor.foreground': color('text'),
      'editor.selectionBackground': color('sel'), 'editorLineNumber.foreground': color('muted'),
      'editorWidget.background': color('panel'), 'editorWidget.border': color('line'),
      'input.background': color('field'), 'input.foreground': color('ink'),
      'editorCursor.foreground': color('ink') }
  });
  monaco.editor.setTheme('mew'); refreshPreview();
}

function initialize(api) {
  monaco = api;
  registerHtmlStyleColorProvider(monaco);
  const scale = editorScale();
  editor = monaco.editor.create($('monacoEditor'), {
    model: null, automaticLayout: true, fontFamily: 'Consolas, "Cascadia Mono", monospace',
    fontSize: 14 * scale, lineHeight: Math.round(21 * scale), tabSize: 2, wordWrap: 'on', minimap: { enabled: false },
    find: { addExtraSpaceOnTop: false },
    // 0.55.1 occurrence requests can reject on rapid model switches.
    occurrencesHighlight: 'off', scrollBeyondLastLine: false, padding: { top: 14, bottom: 14 }
  });
  editor.onDidChangeCursorPosition(event => {
    $('positionInfo').textContent = `Ln ${event.position.lineNumber}, Col ${event.position.column}`;
  });
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, save);
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyS, saveAll);
  // Capture only tag shortcuts. Monaco handles typing, IME, undo and find itself.
  $('monacoEditor').addEventListener('keydown', event => {
    if (event.isComposing || event.ctrlKey || event.metaKey || !editor.hasTextFocus()) return;
    if (!event.altKey && !$('instant').checked) return;
    const tag = tagMap.get(event.key.toLowerCase());
    const br = event.altKey && event.key === 'Enter';
    if (tag || br) {
      event.preventDefault(); event.stopPropagation();
      if (tag) editTag(tag); else insertAttr(attrs.find(attr => attr.id === 'BR'));
    }
  }, true);
  document.addEventListener('keydown', handleSaveAllChord, true);
  document.addEventListener('keydown', event => {
    if (!event.defaultPrevented && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault(); if (event.shiftKey) saveAll(); else save();
    }
  });
  buildTagBar(); setupTagPanel();
  $('saveBtn').onclick = save; $('saveAllBtn').onclick = saveAll;
  $('undoBtn').onclick = undo; $('redoBtn').onclick = redo;
  $('findBtn').onclick = toggleFindReplace;
  $('prevFileBtn').onclick = () => openSiblingFile(-1); $('nextFileBtn').onclick = () => openSiblingFile(1);
  $('newWinBtn').onclick = openFileWindow; $('closeSavedBtn').onclick = () => closeAll(true); $('closeAllBtn').onclick = () => closeAll();
  $('darkBtn').onclick = () => setDark(!document.body.classList.contains('dark'));
  $('fullBtn').onclick = toggleFull;
  $('refreshBtn').onclick = refreshPreview; $('openRawBtn').onclick = openRaw;
  $('treeRefreshBtn').onclick = refreshTree;
  $('treeCollapseBtn').onclick = () => {
    document.querySelectorAll('#tree > .indent').forEach(el => el.remove());
    document.querySelectorAll('#tree .item[data-type="dir"]').forEach(row => { row.firstChild.textContent = '+'; row.setAttribute('aria-expanded', 'false'); });
  };
  $('treeRevealBtn').onclick = () => revealFile().catch(error => note(error.message));
  $('treeFilter').oninput = filterTree;
  $('tabs').onclick = event => {
    const close = event.target.closest('[data-close]');
    if (close) return closeDocs([close.dataset.close]);
    const tab = event.target.closest('[data-path]');
    if (tab) { ++openRevision; switchDoc(tab.dataset.path); }
  };
  $('fileMenu').onclick = event => { if (event.target.closest('button')) $('fileMenu').open = false; };
  document.addEventListener('pointerdown', event => closeMenus(event.target.closest('.menu')));
  if (window.MEWBackend) {
    $('submitChangeBtn').hidden = $('gitConfigBtn').hidden = false;
    $('submitChangeBtn').onclick = () => window.MEWBackend.submitChanges().catch(error => note(error.message));
    $('gitConfigBtn').onclick = () => { location.href = '../git-editor.html'; };
  }
  setDark(localStorage.getItem('mewDark') === '1');
  startReaderSync();
  refreshTree(); connectFileEvents(); checkCssUpdate();
  const file = new URLSearchParams(location.search).get('file');
  if (file) openFile(file);
  window.addEventListener('beforeunload', event => {
    readerChannel?.postMessage({ source: 'editor', type: 'editor-closed', path: state.path });
    if ([...state.docs.values()].some(d => d.dirty)) { event.preventDefault(); event.returnValue = ''; }
  });
  window.mewWorkbench = { editor, documents: state.docs, openFile };
}
if (typeof require === 'function') {
  require.config({ paths: { vs: '/monaco/min/vs' } });
  require(['vs/editor/editor.main'], initialize, error => { $('status').textContent = `Monaco 加载失败：${error.message || error}`; });
} else $('status').textContent = 'Monaco 加载失败，请检查本地 monaco/min/vs 目录。';
