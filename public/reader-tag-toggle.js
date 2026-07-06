(() => {
  const blockNames = new Set(["p", "div", "h1", "h2", "h3", "h4", "h5", "h6"]);

  const openInfo = (open) => {
    const match = String(open).match(/^<([a-z][\w:-]*)([^>]*)>/i);
    if (!match) return null;
    const name = match[1].toLowerCase();
    const align = match[2].match(/\balign\s*=\s*["']?([^"'\s>]+)/i)?.[1]?.toLowerCase() || "";
    return { name, kind: name === "p" && align ? `p:${align}` : name, block: blockNames.has(name) };
  };

  const elementKind = (element) => {
    const name = element.tagName.toLowerCase();
    const align = (element.getAttribute("align") || "").toLowerCase();
    return name === "p" && align ? `p:${align}` : name;
  };

  const findContainer = (text, start, end, names) => {
    const pattern = /<\/?([A-Za-z][\w:-]*)\b(?:[^>"']|"[^"]*"|'[^']*')*>/g;
    const stack = [];
    const candidates = [];
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
      const contains = open.end <= start && end <= close.start;
      const selectedWhole = open.start === start && close.end === end;
      if (contains || selectedWhole) candidates.push({ open, close, selectedWhole });
    }
    return candidates.sort((a, b) => (a.close.end - a.open.start) - (b.close.end - b.open.start))[0] || null;
  };

  const removeSourceWrapper = (editor, container) => {
    const { open, close, selectedWhole } = container;
    const inner = editor.value.slice(open.end, close.start);
    const start = editor.selectionStart;
    const end = editor.selectionEnd;
    const relativeStart = selectedWhole ? 0 : start - open.end;
    const relativeEnd = selectedWhole ? inner.length : end - open.end;
    editor.setRangeText(inner, open.start, close.end, "select");
    editor.setSelectionRange(open.start + relativeStart, open.start + relativeEnd);
  };

  const replaceSourceWrapper = (editor, container, openTag, closeTag) => {
    const { open, close, selectedWhole } = container;
    const inner = editor.value.slice(open.end, close.start);
    const start = editor.selectionStart;
    const end = editor.selectionEnd;
    const relativeStart = selectedWhole ? 0 : start - open.end;
    const relativeEnd = selectedWhole ? inner.length : end - open.end;
    editor.setRangeText(openTag + inner + closeTag, open.start, close.end, "select");
    editor.setSelectionRange(
      open.start + openTag.length + relativeStart,
      open.start + openTag.length + relativeEnd
    );
  };

  const unwrapVisual = (element, doc) => {
    const parent = element.parentNode;
    const first = element.firstChild;
    const last = element.lastChild;
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
  };

  const replaceVisual = (element, open, doc) => {
    const template = doc.createElement("template");
    template.innerHTML = open;
    const replacement = template.content.firstElementChild;
    if (!replacement) return;
    while (element.firstChild) replacement.append(element.firstChild);
    element.replaceWith(replacement);
    const range = doc.createRange();
    range.selectNodeContents(replacement);
    const selection = doc.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  };

  const toggleVisual = (open, close, info) => {
    const doc = document.getElementById("visualEditor").contentDocument;
    if (!doc?.body || !state.editable) return;
    remember();
    const selection = doc.getSelection();
    const anchor = selection?.anchorNode?.nodeType === Node.ELEMENT_NODE
      ? selection.anchorNode
      : selection?.anchorNode?.parentElement;
    const selector = info.block ? "p,div,h1,h2,h3,h4,h5,h6" : info.name;
    const container = anchor?.closest?.(selector);
    if (container && doc.body.contains(container)) {
      if (elementKind(container) === info.kind) unwrapVisual(container, doc);
      else if (info.block) replaceVisual(container, open, doc);
      else container.remove();
    } else {
      const selected = selection?.rangeCount ? selection.getRangeAt(0).cloneContents() : null;
      const holder = doc.createElement("div");
      if (selected) holder.append(selected);
      doc.execCommand("insertHTML", false, open + holder.innerHTML + close);
    }
    markDirty();
    doc.body.focus();
  };

  insert = function toggleTag(open, close = "", offset = null) {
    const info = openInfo(open);
    if (state.mode === "visual" && info) return toggleVisual(open, close, info);

    const editor = document.getElementById("editor");
    remember();
    if (info && close) {
      const names = info.block ? blockNames : new Set([info.name]);
      const container = findContainer(editor.value, editor.selectionStart, editor.selectionEnd, names);
      if (container) {
        const current = openInfo(container.open.token);
        if (current?.kind === info.kind) removeSourceWrapper(editor, container);
        else if (info.block) replaceSourceWrapper(editor, container, open, close);
        else removeSourceWrapper(editor, container);
      } else {
        const start = editor.selectionStart;
        const end = editor.selectionEnd;
        const selected = editor.value.slice(start, end);
        editor.setRangeText(open + selected + close, start, end, "end");
        if (!selected) editor.setSelectionRange(start + open.length, start + open.length);
      }
    } else {
      const start = editor.selectionStart;
      const end = editor.selectionEnd;
      editor.setRangeText(open, start, end, "end");
      if (offset != null) editor.setSelectionRange(start + offset, start + offset);
    }
    state.source = editor.value;
    markDirty();
    updateHighlight();
    editor.focus();
  };
})();
