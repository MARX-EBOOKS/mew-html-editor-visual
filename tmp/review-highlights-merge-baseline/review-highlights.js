// Reusable text-range overlays and Monaco decoration lifecycle. No PDF or review dependencies.
(() => {
  'use strict';
  window.ReviewHighlights = { create };
  function create({ document = window.document, lowerBound, classes = {} }) {
    const { selection: selectionClass = 'review-highlight', pointer: pointerClass = 'review-pointer',
      caret: caretClass = 'review-caret' } = classes;
    const selectionAreas = new Map(), pointerAreas = new Map(), marks = new Map();
    return { measureHighlights, paintHighlight, clearHighlights, clearMarks, updateSource, selectionRange,
      getHighlight: (div, pointer = false) => (pointer ? pointerAreas : selectionAreas).get(div),
      dispose() { clearHighlights(); clearHighlights(true); clearMarks(); } };
    function measureHighlights(div, index, hits, focusHit) {
      // Measure the indexed text nodes in their reading order.
      const { parts } = index;
      const boxes = [], notices = [];
      let range;
      const union = (a, b) => {
        const left = Math.min(a.left, b.left), top = Math.min(a.top, b.top), right = Math.max(a.right, b.right);
        return { left, top, right, width: right - left, height: Math.max(a.top + a.height, b.top + b.height) - top };
      };
      let focus = null;
      for (const hit of hits) {
        let noticeBox = null;
        const caret = hit.start === hit.end || !!hit.difference && !index.raw.slice(hit.start, hit.end).trim();
        // Reading order can differ from DOM order; measure the indexed text nodes.
        const first = Math.min(parts.length - 1, lowerBound(parts, hit.start + 1, part => part.end));
        const last = caret ? first : lowerBound(parts, hit.end, part => part.end);
        for (const part of parts.slice(first, last + 1)) {
          range ||= (div.ownerDocument || document).createRange();
          range.setStart(part.node, Math.max(0, hit.start - part.start));
          range.setEnd(part.node, Math.max(0, Math.min(part.node.length, (caret ? hit.start : hit.end) - part.start)));
          for (let box of range.getClientRects()) if ((box.width || caret) && box.height) {
            // Collapsed ranges can have a fractional width in Chromium. Always
            // draw missing text as a visible caret at the insertion point.
            if (caret) box = { left: box.left, right: box.left + 2, top: box.top, width: 2, height: box.height, caret: true };
            const previous = boxes.at(-1);
            // Range rects can include both a span and its text, or adjoining spans.
            if (previous && !previous.caret && !box.caret && Math.abs(previous.top - box.top) < .5 && Math.abs(previous.height - box.height) < .5
              && box.left >= previous.left && box.left <= previous.right + .5) {
              boxes[boxes.length - 1] = union(previous, box);
            } else boxes.push(box);
            noticeBox = noticeBox ? union(noticeBox, box) : box;
            if (hit === focusHit && !focus) focus = box;
          }
        }
        if (noticeBox) notices.push({ box: noticeBox, ...hit.difference, target: { index, start: hit.start, end: hit.end }, source: hit.source });
      }
      const pageBox = div.getBoundingClientRect();
      const sx = pageBox.width / div.offsetWidth, sy = pageBox.height / div.offsetHeight;
      const relative = box => ({
        x: (box.left - pageBox.left - div.clientLeft * sx) / (div.clientWidth * sx),
        y: (box.top - pageBox.top - div.clientTop * sy) / (div.clientHeight * sy),
        w: box.width / (div.clientWidth * sx), h: box.height / (div.clientHeight * sy), caret: !!box.caret
      });
      return { count: hits.length, focus: focus && relative(focus), boxes: boxes.map(relative), notices: notices.map(notice => ({ ...notice, box: relative(notice.box) })) };
    }
    function paintHighlight(div, boxes, color, pointer = false) {
      const store = pointer ? pointerAreas : selectionAreas;
      const previous = store.get(div);
      if (previous?.boxes === boxes && previous.node.isConnected) return previous;
      if (!boxes.length) {
        previous?.node.remove();
        store.delete(div);
        return;
      }
      const overlay = previous?.node.isConnected ? previous.node : document.createElement("div");
      if (!overlay.isConnected) {
        overlay.className = selectionClass + (pointer ? ' ' + pointerClass : '');
        overlay.style.cssText = "position:absolute;inset:0;pointer-events:none;z-index:20;overflow:hidden;contain:strict;";
        div.append(overlay);
      }
      for (let i = 0; i < boxes.length; i++) {
        const box = boxes[i];
        let mark = overlay.children[i];
        if (!mark) {
          mark = document.createElement("div");
          mark.setAttribute("aria-hidden", "true");
          overlay.append(mark);
        }
        mark.style.cssText = `position:absolute;left:${box.x * 100}%;top:${box.y * 100}%;width:${box.w * 100}%;height:${box.h * 100}%;border-radius:2px;pointer-events:none;`;
        mark.style.background = box.caret ? '#d58b24' : color;
        mark.classList.toggle(caretClass, box.caret);
      }
      while (overlay.children.length > boxes.length) overlay.lastElementChild.remove();
      const painted = { node: overlay, boxes };
      store.set(div, painted);
      return painted;
    }
    function clearHighlights(pointer = false, visible = new Set()) {
      const areas = pointer ? pointerAreas : selectionAreas;
      for (const [div, painted] of areas) if (!visible.has(div)) {
        painted.node.remove(); areas.delete(div);
      }
    }
    function clearMarks() {
      for (const state of marks.values()) { state.collection.clear(); state.dispose?.(); state.style.remove(); }
      marks.clear();
    }
    function updateSource(editor, key, decorations, css) {
      let state = marks.get(editor);
      if (!state) {
        const doc = editor.getDomNode()?.ownerDocument || document, style = doc.createElement('style');
        style.textContent = css;
        doc.head.append(style);
        state = { collection: editor.createDecorationsCollection(), style };
        const subscription = editor.onDidChangeModel?.(() => { state.key = null; state.collection.clear(); });
        state.dispose = () => subscription?.dispose();
        marks.set(editor, state);
      }
      if (state.key?.length === key.length && key.every((value, i) => value === state.key[i])) return;
      state.collection.set(decorations());
      state.key = key;
    }
    function selectionRange(editor, event, range) {
      // A text drag owns its full range, even when it ends on a diff marker.
      if (!event?.lineRange && !range.isEmpty?.()) return null;
      const collection = marks.get(editor)?.collection, position = event?.position || range.getStartPosition();
      for (let i = 0; i < (collection?.length || 0); i++) {
        const mark = collection.getRange(i);
        if (event?.lineRange ? mark?.intersectRanges(event.lineRange) : mark?.containsPosition(position)) return mark;
      }
      return null;
    }
  }
})();

