(() => {
  "use strict";
  window.PdfSelectionDiff = {
    textDiff, readPageText, readPageFonts, textItemFont, fontStyle, connectionDiff, differences, sourceSegments, insertionSegment, createLocator, layerFonts, fontRuns, fontSummary, formatDifferences,
    textEdits, fontEdits, validateEdits, previewEdits, applyEdits, rangeAt, reviewCandidates, significantText, changedRange
  };
  // 粗体／斜体：字体读取、区间归并、摘要、替换编辑与差异比较。
  function fontRuns(index, start = 0, end = index.raw.length) {
    const runs = [];
    const pages = index.formatted ? [{ parts: index.formatted }] : index.parts ? [index] : index.pages || [];
    for (let page = lowerBound(pages, start + 1, page => page.end ?? index.raw.length);
      page < pages.length && (pages[page].start ?? 0) < end; page++) {
      const parts = pages[page].parts;
      for (let i = lowerBound(parts, start + 1, part => part.end); i < parts.length && parts[i].start < end; i++) {
        const part = parts[i], a = Math.max(start, part.start), b = Math.min(end, part.end);
        if (a >= b || !index.raw.slice(a, b).trim()) continue;
        const saved = index.fonts?.[part.fontIndex];
        // Compare canonical <i>/<b> runs, then verify each state against its saved font index.
        const style = part.font || (saved && { ...saved,
          italic: typeof saved.italic === 'boolean' && saved.italic === /^(?:<b>)?<i>/.test(part.text) ? saved.italic : null,
          bold: typeof saved.bold === 'boolean' && saved.bold === /^<b>/.test(part.text) ? saved.bold : null
        }) || { name: '', italic: null, bold: null }, last = runs.at(-1);
        if (last && ['italic', 'bold', 'name', 'size', 'color', 'alpha', 'flags', 'ascender', 'descender']
          .every(key => last[key] === style[key])
          && !index.raw.slice(last.end, a).trim()) last.end = b;
        else runs.push({ ...style, start: a, end: b });
      }
    }
    return runs;
  }
  function fontSummary(runs) {
    const states = [], reasons = [...new Set(runs.map(run => run.reason).filter(Boolean))];
    for (const key of ['italic', 'bold']) {
      const values = new Set(runs.map(run => run[key]));
      const state = !values.size || values.has(null) ? '未知' : values.size > 1 ? '混合' : values.has(true) ? '是' : '否';
      states.push(`${key === 'italic' ? '斜体' : '粗体'}：${state}`);
    }
    return states.join('；') + (reasons.length ? `（${reasons.join('；')}）` : '');
  }
  function fontEdits(index, start, end, font) {
    const keys = ['italic', 'bold'];
    while (start < end && /\s/u.test(index.raw[start])) start++;
    while (end > start && /\s/u.test(index.raw[end - 1])) end--;
    if (start >= end || !keys.some(key => typeof font[key] === 'boolean'
      && index.formats.slice(start, end).some(style => style[key] !== font[key]))) return [];
    // Read the existing tag names once; clear the area before adding its format.
    const tags = [...new Set(index.formats.slice(start, end).flatMap(style => style.tags))]
      .sort((a, b) => b.openStart - a.openStart);
    if (tags.some(tag => tag.closeStart === undefined || !['i', 'em', 'b', 'strong', 'span'].includes(tag.name))) return [];
    let a = index.starts[start], b = index.ends[end - 1];
    const removals = tags.flatMap(tag => [
      { start: tag.openStart, end: tag.openEnd, text: '' },
      { start: tag.closeStart, end: tag.closeEnd, text: '' }
    ]).filter(edit => edit.start >= a && edit.end <= b);
    let text = previewEdits(index.source.slice(a, b), removals.map(edit =>
      ({ ...edit, start: edit.start - a, end: edit.end - a })));
    for (const key of keys) {
      const desired = typeof font[key] === 'boolean' ? font[key] : index.formats[start][key];
      if (!desired) continue;
      const name = tags.find(tag => tag[key] === true && tag.name !== 'span')?.name || (key === 'italic' ? 'i' : 'b');
      text = `<${name}>` + text + `</${name}>`;
    }
    // Remove complete wrappers first, preserving their surrounding whitespace.
    let left = '', right = '';
    for (const tag of tags) {
      if (tag.openEnd <= a && !index.raw.slice(tag.rawStart, start).trim()) {
        left = index.source.slice(tag.openEnd, a) + left; a = tag.openStart;
      }
      if (tag.closeStart >= b && !index.raw.slice(end, tag.rawEnd).trim()) {
        right += index.source.slice(b, tag.closeStart); b = tag.closeEnd;
      }
    }
    // Split remaining wrappers beside words, leaving spaces outside the tags.
    let previous = start - 1, next = end;
    while (previous >= 0 && /[ \t]/.test(index.raw[previous])) previous--;
    while (next < index.raw.length && /[ \t]/.test(index.raw[next])) next++;
    const leftSpace = index.source.slice(index.ends[previous] ?? 0, a).match(/[ \t]*$/)[0];
    const rightSpace = index.source.slice(b, index.starts[next] ?? index.source.length).match(/^[ \t]*/)[0];
    a -= leftSpace.length; b += rightSpace.length;
    left = tags.filter(tag => tag.openEnd <= a).map(tag => tag.closing).join('') + left;
    right += tags.filter(tag => tag.closeStart >= b).reverse().map(tag => tag.opening).join('');
    return [{ start: a, end: b, expected: index.source.slice(a, b), text: left + leftSpace + text + rightSpace + right }];
  }
  const analyses = new WeakMap();
  function differences(index, target, connection) {
    const diff = connectionDiff(index, target, connection);
    const cached = analyses.get(connection);
    if (cached?.index === index && cached.target === target && cached.diff === diff
      && cached.fontVersion === target.fontVersion) return cached;
    const result = { index, target, diff, fontVersion: target.fontVersion, end: connection.end, text: [], fonts: [], spans: [] };
    const runs = index.formats ? fontRuns(target, connection.targetStart, connection.targetEnd) : [];
    let left = connection.start, right = connection.targetStart, run = 0;
    for (const part of diff?.parts || []) {
      const end = left + part.html.length, stop = right + part.pdf.length;
      const span = { ...part, start: left, end, pdfStart: right, pdfEnd: stop };
      if (part.pdf.length) result.spans.push(span);
      if (part.changed) {
        if (significantText(part.html, index, left) !== significantText(part.pdf)) result.text.push(span);
      } else {
        while (run < runs.length && runs[run].end <= right) run++;
        for (let i = run; i < runs.length && runs[i].start < stop; i++) {
          const font = runs[i], limit = left + Math.min(stop, font.end) - right;
          let start = left + Math.max(right, font.start) - right;
          while (start < limit) {
            const htmlFont = index.formats[start];
            let end = start + 1;
            while (end < limit && index.formats[end] === htmlFont) end++;
            if (htmlFont && ['italic', 'bold'].some(key => typeof font[key] === 'boolean' && font[key] !== htmlFont[key])) {
              const text = index.raw.slice(start, end);
              const a = start + text.length - text.trimStart().length, b = end - text.length + text.trimEnd().length;
              if (a < b) result.fonts.push({ sourceStart: a, sourceEnd: b, font, htmlFont, formats: [{ font, htmlFont }] });
            }
            start = end;
          }
        }
      }
      left = end;
      right = stop;
    }
    analyses.set(connection, result);
    return result;
  }
  function formatDifferences(index, connections) {
    const items = new Map();
    for (const [connection, target] of connections)
      for (const item of differences(index, target, connection).fonts)
        if (!items.has(`${item.sourceStart}:${item.sourceEnd}`)) items.set(`${item.sourceStart}:${item.sourceEnd}`, item);
    // Merge adjacent format changes, or bridge punctuation with the same mismatch.
    const merged = [];
    for (const item of [...items.values()].sort((a, b) => a.sourceStart - b.sourceStart || a.sourceEnd - b.sourceEnd)) {
      const previous = merged.at(-1), gap = previous && index.raw.slice(previous.sourceEnd, item.sourceStart);
      const joins = previous && item.sourceStart >= previous.sourceEnd && !/[\r\n]/.test(gap)
        && previous.htmlFont.tags === item.htmlFont.tags
        && ['italic', 'bold'].every(key => previous.font[key] === item.font[key] && previous.htmlFont[key] === item.htmlFont[key])
        && (!gap.trim() || !(/\s/u.test(gap) && /[\p{L}\p{N}]/u.test(gap)) && ['italic', 'bold'].some(key =>
          typeof previous.font[key] === 'boolean'
          && index.formats.slice(previous.sourceEnd, item.sourceStart).every((style, i) =>
            /\s/u.test(gap[i]) || (style && style[key] !== previous.font[key]))));
      if (!joins) { merged.push({ ...item, formats: [...item.formats] }); continue; }
      previous.sourceEnd = item.sourceEnd;
      previous.formats.push(...item.formats);
    }
    return merged.map(item => ({ ...item, id: `font:${item.sourceStart}:${item.sourceEnd}`,
      text: index.raw.slice(item.sourceStart, item.sourceEnd),
      options: [{ id: 'format', edits: fontEdits(index, item.sourceStart, item.sourceEnd, item.font) }] }));
  }
  function htmlFontDefinition(name, text, rawStart, openStart) {
    const style = /\bstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(text);
    const declarations = style ? style[1] ?? style[2] : '';
    const italic = /(?:^|;)\s*font-style\s*:\s*([^;!]+)/i.exec(declarations)?.[1].trim();
    const bold = /(?:^|;)\s*font-weight\s*:\s*([^;!]+)/i.exec(declarations)?.[1].trim();
    return { name, opening: text, rawStart, openStart, openEnd: openStart + text.length,
      italic: italic && /^(normal|italic|oblique)\b/i.test(italic) ? !/^normal$/i.test(italic) : /^(i|em)$/.test(name) ? true : null,
      bold: bold && /^(normal|bold|[1-9]00)$/i.test(bold) ? /bold/i.test(bold) || Number(bold) >= 600 : /^(b|strong)$/.test(name) ? true : null };
  }
  function layerFonts(view, layer, refresh, savedPage, savedIndex) {
    if (savedPage && savedIndex) {
      // Display spans are only anchors. Prefer styles from the saved sequence.
      const highlighter = view?._textHighlighter;
      const spans = highlighter?.textDivs || [...layer.querySelectorAll('span[role="presentation"]')];
      const fonts = new WeakMap();
      let cursor = savedPage.start;
      for (const [divIdx, span] of spans.entries()) {
        const text = highlighter?.textContentItemsStr?.[divIdx] ?? span.textContent;
        if (!text) continue;
        const start = savedIndex.raw.indexOf(text, cursor), end = start + text.length;
        if (start < cursor || end > savedPage.end) continue;
        cursor = end;
        const first = lowerBound(savedPage.parts, start + 1, part => part.end);
        const parts = savedPage.parts.slice(first, lowerBound(savedPage.parts, end, part => part.start));
        const font = parts[0]?.font;
        if (font && parts.every(part => part.font === font)) fonts.set(span, font);
      }
      return element => fonts.get(element) || { name: '', italic: null, bold: null, reason: '等待本地 OCR 序列定位' };
    }
    return window.LocalOcrTextReader.layerFonts(view, layer, refresh);
  }
  function significantText(text, index, start = 0) {
    return text.replace(/[\s\-\u00ad\u2010\u2011\d]/g, (char, offset) => /\d/.test(char)
      && !(index?.formats?.[start + offset]?.name === 'a'
        && /\bhref\s*=\s*(["'])#Z?F\d+\1/i.test(index.formats[start + offset].definition.opening)) ? char : '');
  }
  function connectionDiff(source, target, connection) {
    const diff = connection.editorDiff ||= textDiff(source.raw.slice(connection.start, connection.end),
      target.raw.slice(connection.targetStart, connection.targetEnd), true);
    // Exceeding the traceback budget is not a confirmed whole-passage replacement.
    return diff.distance > 128 ? null : diff;
  }
  function reviewCandidates(index, targets = [], notice = null, selectedParts = null) {
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
    const add = (data, pdfRaw = '') => {
      const project = (offset, endBias) => {
        const spans = data.spans;
        let low = 0, high = spans.length;
        while (low < high) {
          const middle = (low + high) >>> 1;
          if (spans[middle].pdfEnd < offset) low = middle + 1; else high = middle;
        }
        const hit = spans[low];
        if (!hit) return data.end;
        if (!hit.changed) return hit.start + Math.max(0, offset - hit.pdfStart);
        return offset <= hit.pdfStart ? hit.start : endBias || offset === hit.pdfEnd ? hit.end : hit.start;
      };
      for (const { start, end, html: from, pdf, pdfStart } of data.text) {
        if (!claim(start, end)) continue;
        const lineStart = pdfRaw.lastIndexOf('\n', Math.max(0, pdfStart - 1)) + 1;
        const nextLine = pdfRaw.indexOf('\n', pdfStart + pdf.length);
        const a = Math.max(0, pdfRaw ? Math.min(start, project(lineStart, false)) : index.raw.lastIndexOf('\n', Math.max(0, start - 1)) + 1);
        const lineEnd = pdfRaw ? project(nextLine < 0 ? pdfRaw.length : nextLine, true) : index.raw.indexOf('\n', end);
        const b = Math.min(index.raw.length, lineEnd < 0 ? index.raw.length : Math.max(end, lineEnd));
        const html = index.raw.slice(a, b);
        items.push({ id: `${start}:${end}`, sourceStart: start, sourceEnd: end, previewStart: a, previewEnd: b,
          preview: { html, pdf: index.raw.slice(a, start) + pdf + index.raw.slice(end, b) },
          comparison: { html: from, pdf }, options: [{ id: 'pdf', label: '替换', edits: textEdits(index, start, end, pdf) }] });
      }
    };
    for (const target of targets.filter(Boolean)) for (const connection of index.connections.get(target) || [])
      add(differences(index, target, connection), target.raw);
    if (notice?.source && index.raw.slice(notice.source.start, notice.source.end) === notice.html)
      add(differences(index, { raw: notice.pdf }, { start: notice.source.start, end: notice.source.end,
        targetStart: 0, targetEnd: notice.pdf.length, editorDiff: { parts: selectedParts || textDiff(notice.html, notice.pdf, true)?.parts } }));
    return items.sort((a, b) => a.sourceStart - b.sourceStart || a.sourceEnd - b.sourceEnd);
  }
  function readPageText(page) { return window.LocalOcrTextReader.readPageText(page); }
  function readPageFonts(...args) { return window.LocalOcrTextReader.readPageFonts(...args); }
  function textItemFont(...args) { return window.LocalOcrTextReader.textItemFont(...args); }
  function fontStyle(...args) { return window.LocalOcrTextReader.fontStyle(...args); }
  function changedRange(before, after) {
    let start = 0, oldEnd = before.length, newEnd = after.length;
    while (start < oldEnd && start < newEnd && before[start] === after[start]) start++;
    while (oldEnd > start && newEnd > start && before[oldEnd - 1] === after[newEnd - 1]) { oldEnd--; newEnd--; }
    return { start, oldEnd, newEnd };
  }
  function appendPart(parts, html, pdf, changed) {
    if (!html && !pdf) return;
    const last = parts.at(-1);
    if (last?.changed === changed) {
      last.html += html;
      last.pdf += pdf;
    }
    else parts.push({ html, pdf, changed });
  }
  // A Levenshtein wavefront skips equal runs; traceback grows with edits, not file area.
  function textDiff(left, right, details = false, limit = Infinity) {
    if (left === right) return { distance: 0, parts: details ? (left ? [{ html: left, pdf: right, changed: false }] : []) : undefined };
    const originalA = [...left], originalB = [...right];
    if (Math.abs(originalA.length - originalB.length) > limit)
      return { distance: limit + 1, parts: details ? [{ html: left, pdf: right, changed: true }] : undefined };
    const { start, oldEnd: endA, newEnd: endB } = changedRange(originalA, originalB);
    const a = originalA.slice(start, endA), b = originalB.slice(start, endB), n = a.length, m = b.length;
    const bound = Math.min(limit, details ? 128 : Infinity, Math.max(n, m));
    let previous = new Int32Array([0]), distance = 0;
    const waves = details ? [{ row: previous, trace: null }] : null;
    for (; distance < bound && previous[n - m + distance] !== n; ) {
      const score = ++distance, row = new Int32Array(2 * score + 1).fill(-1);
      const trace = details ? new Uint8Array(row.length) : null;
      for (let k = -score; k <= score; k++) {
        const at = k + score - 1;
        let x = -1, move = 0, candidate = previous[at];
        if (candidate >= 0 && candidate < n && candidate - k < m) x = candidate + 1;
        candidate = previous[at - 1];
        if (candidate >= 0 && candidate < n && candidate - k + 1 <= m && candidate + 1 > x) {
          x = candidate + 1;
          move = 1;
        }
        candidate = previous[at + 1];
        if (candidate >= 0 && candidate <= n && candidate - k - 1 < m && candidate > x) {
          x = candidate;
          move = 2;
        }
        if (x < 0) continue;
        let y = x - k;
        while (x < n && y < m && a[x] === b[y]) { x++; y++; }
        row[k + score] = x;
        if (trace) trace[k + score] = move;
      }
      previous = row;
      if (details) waves.push({ row, trace });
    }
    if (previous[n - m + distance] !== n) return { distance: bound + 1, parts: details ? [{ html: left, pdf: right, changed: true }] : undefined };
    if (!details) return { distance };
    const reversed = [];
    let x = n, k = n - m;
    for (let score = distance; score > 0; score--) {
      const move = waves[score].trace[k + score], previousK = k + (move === 1 ? -1 : move === 2 ? 1 : 0);
      const previousX = waves[score - 1].row[previousK + score - 1], previousY = previousX - previousK;
      const fromX = previousX + (move !== 2), fromY = previousY + (move !== 1);
      if (x > fromX) reversed.push({ html: a.slice(fromX, x).join(''), pdf: b.slice(fromY, x - k).join(''), changed: false });
      reversed.push({ html: move === 2 ? '' : a[previousX], pdf: move === 1 ? '' : b[previousY], changed: true });
      x = previousX; k = previousK;
    }
    const parts = [];
    appendPart(parts, originalA.slice(0, start).join(''), originalB.slice(0, start).join(''), false);
    for (const part of reversed.reverse()) appendPart(parts, part.html, part.pdf, part.changed);
    appendPart(parts, originalA.slice(endA).join(''), originalB.slice(endB).join(''), false);
    return { distance, parts };
  }

  function validateEdits(source, edits) {
    const sorted = edits.map(edit => ({ ...edit })).sort((a, b) => a.start - b.start || a.end - b.end);
    let previous = null;
    for (const edit of sorted) {
      if (!Number.isInteger(edit.start) || !Number.isInteger(edit.end) || edit.start < 0
        || edit.end < edit.start || edit.end > source.length || typeof edit.text !== 'string') throw new Error('无效的替换范围');
      if (previous && (edit.start < previous.end || edit.start === previous.start)) throw new Error('替换范围重叠，请逐条处理');
      if (edit.expected !== undefined && source.slice(edit.start, edit.end) !== edit.expected) throw new Error('原文已变化，无法应用旧修改');
      previous = edit;
    }
    return sorted;
  }
  function previewEdits(source, edits) {
    const sorted = validateEdits(source, edits);
    return sorted.map((edit, i) => source.slice(sorted[i - 1]?.end ?? 0, edit.start) + edit.text).join('')
      + source.slice(sorted.at(-1)?.end ?? 0);
  }
  function rangeAt(model, start, end) {
    const a = model.getPositionAt(start), b = model.getPositionAt(end);
    return { startLineNumber: a.lineNumber, startColumn: a.column,
      endLineNumber: b.lineNumber, endColumn: b.column };
  }
  function applyEdits(editor, model, version, source, edits, origin = 'review-replacement') {
    if (editor.getModel() !== model || model.getValue() !== source
      || (version !== undefined && model.getVersionId?.() !== version)) throw new Error('编辑器内容已变化，无法应用旧修改');
    const api = editor.getDomNode?.()?.ownerDocument.defaultView.monaco;
    if (editor.getOption?.(api?.editor.EditorOption.readOnly ?? 104)) throw new Error('当前文件只读');
    const checked = validateEdits(source, edits);
    if (!checked.length) return;
    editor.pushUndoStop?.();
    const applied = editor.executeEdits(origin, checked.map(edit => ({ range: rangeAt(model, edit.start, edit.end), text: edit.text, forceMoveMarkers: true })));
    editor.pushUndoStop?.();
    if (applied === false) throw new Error('编辑器未能应用替换');
  }
  function lowerBound(values, value, key = entry => entry) {
    let low = 0, high = values.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (key(values[mid]) < value) low = mid + 1; else high = mid;
    }
    return low;
  }
  function sourceSegments(index, start, end) {
    const segments = [];
    for (let at = start; at < end; at++) {
      const a = index.starts[at], b = index.ends[at], last = segments.at(-1);
      if (/^\s*$|^</.test(index.source?.slice(a, b))) continue;
      if (last && a <= last.end) last.end = Math.max(last.end, b);
      else segments.push({ start: a, end: b });
    }
    return segments;
  }
  function insertionSegment(index, start) {
    const at = index.starts[start] ?? index.ends[start - 1] ?? 0;
    return { start: at, end: at };
  }
  function textEdits(index, start, end, replacement) {
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start
      || end > index.raw.length || typeof replacement !== 'string') throw new Error('无效的可见文字替换范围');
    const segments = sourceSegments(index, start, end);
    if (!segments.length) segments.push(insertionSegment(index, start));
    const text = replacement.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return segments.map((segment, i) => ({ ...segment, text: i ? '' : text,
      expected: index.source.slice(segment.start, segment.end) }));
  }
  function createLocator(options = {}, environment = {}) {
    const documents = new WeakMap(), sourceIndexes = new WeakMap(), noPdf = {};
    const reviewAnchors = new WeakMap();
    const document = environment.document || window.document;
    return { sourceIndex, editorSourceIndex, sourcePageScope, normalized, matches, locate,
      normalizedRange, approximateMatches, lowerBound, rememberConnection, patchedWords,
      connectedRange, reviewAnchor, indexDocument, indexFonts, getDocumentIndex, findLocations, prepareSource, locateSource, locateLayer };
    function anchorMatches(index, needle) {
      // Index aligned 16-character blocks to find 32-character anchors without full rescans.
      const mapped = index.normalized, text = mapped.text, found = new Map();
      if (!index.anchorBlocks) {
        const blocks = index.anchorBlocks = new Map();
        for (let at = 0; at + 16 <= text.length; at += 16) {
          const key = text.slice(at, at + 16), positions = blocks.get(key);
          if (positions) positions.push(at); else blocks.set(key, [at]);
        }
      }
      for (let offset = 0; offset < 16 && offset + 16 <= needle.length; offset++) {
        for (const position of index.anchorBlocks.get(needle.slice(offset, offset + 16)) || []) {
          const at = position - offset;
          if (at >= 0 && text.startsWith(needle, at)) {
            const start = mapped.starts[at], end = mapped.ends[at + needle.length - 1];
            found.set(`${start}:${end}`, { start, end });
            if (found.size > 1) return [...found.values()]; // Only unique anchors are useful.
          }
        }
      }
      return [...found.values()];
    }
    function normalized(raw, result = { text: "", starts: [], ends: [] }, base = 0) {
      let previous = result.text.at(-1) || "";
      const units = [], { starts, ends } = result;
      for (const match of raw.matchAll(/((?<=[\p{L}\p{N}])[-\u2010\u2011]\s*\n\s*(?=[\p{L}\p{N}]))|[\s\S]/gu)) {
        const char = match[0], start = base + match.index, offset = start + char.length;
        if (match[1] || char === "\u00ad") continue;
        const value = char.normalize("NFKC").toLowerCase().replace(/ſ/g, "s").replace(/ß/g, "ss")
          .replace(/[‘’‚]/g, "'").replace(/[“”„]/g, '"').replace(/\s/g, " ");
        for (const unit of value) {
          if (unit === " " && previous === " ") {
            ends[ends.length - 1] = offset;
            continue;
          }
          units.push(unit); previous = unit;
          for (let i = 0; i < unit.length; i++) { starts.push(start); ends.push(offset); }
        }
      }
      result.text += units.join("");
      return result;
    }
    function matches(raw, queries, haystack = normalized(raw)) {
      const found = new Map(), word = char => !!char && /[\p{L}\p{N}_]/u.test(char);
      for (const query of queries) {
        const needle = normalized(query).text.trim();
        if (!needle) continue;
        let at = 0;
        while ((at = haystack.text.indexOf(needle, at)) !== -1) {
          const end = at + needle.length;
          const before = [...haystack.text.slice(Math.max(0, at - 2), at)].pop(), after = [...haystack.text.slice(end, end + 2)][0];
          if (!options.wholeWords || ((!word(needle[0]) || !word(before)) && (!word([...needle].pop()) || !word(after)))) {
            const start = haystack.starts[at], stop = haystack.ends[end - 1];
            found.set(`${start}:${stop}`, { start, end: stop });
          }
          at++;
        }
      }
      return [...found.values()];
    }
    function normalizedRange(index, start, end) {
      return start === 0 && end === index.raw.length && index.normalized
        ? index.normalized : normalized(index.raw.slice(start, end));
    }
    function locate(raw, entry, haystack = normalized(raw), fuzzyOnly = false) {
      const before = normalized(entry.before).text.trim(), after = normalized(entry.after).text.trim();
      const exact = fuzzyOnly ? [] : matches(raw, [entry.text], haystack);
      const hits = exact.length ? exact : approximateMatches(entry.text, before, after, haystack);
      if (!hits.length) return null;
      const scored = hits.map(hit => {
        const begin = lowerBound(haystack.starts, hit.start), end = lowerBound(haystack.starts, hit.end);
        const left = haystack.text.slice(Math.max(0, begin - 400), begin).trim();
        const right = haystack.text.slice(end, end + 400).trim();
        let a = 0, b = 0;
        while (a < before.length && a < left.length && before.at(-a - 1) === left.at(-a - 1)) a++;
        while (b < after.length && b < right.length && after[b] === right[b]) b++;
        return { ...hit, score: a + b };
      }).sort((a, b) => b.score - a.score);
      const required = Math.min(24, before.length + after.length);
      if (required && scored[0].score < required) return exact.length ? locate(raw, entry, haystack, true) : null;
      return scored.length === 1 || scored[0].score > scored[1].score ? scored[0] : null;
    }
    function approximateMatches(query, before, after, haystack) {
      const needle = normalized(query).text.trim();
      const size = [...needle].length, long = needle.length > 128;
      if (size < 3 || needle.length > 2048 || before.length + after.length < 8 || (long && (before.length < 12 || after.length < 12))) return [];
      const limit = long ? Math.min(32, Math.max(3, Math.floor(size * 0.05)))
        : Math.min(3, Math.max(1, Math.floor(size * 0.2)));
      const starts = new Set(), ends = new Set(), found = new Map(), text = haystack.text;
      for (const [context, left] of [[before, true], [after, false]]) {
        if (context.length < 4) continue;
        for (const size of [...new Set([Math.min(24, context.length), Math.min(12, context.length), ...(long ? [] : [4])])]) {
          const anchor = left ? context.slice(-size) : context.slice(0, size);
          let at = -1, anchored = false;
          while ((at = text.indexOf(anchor, at + 1)) !== -1) {
            anchored = true;
            let boundary = left ? at + anchor.length : at;
            if (left) {
              while (text[boundary] === ' ') boundary++;
              starts.add(boundary);
            } else {
              while (boundary && text[boundary - 1] === ' ') boundary--;
              if (long) ends.add(boundary);
              else for (let delta = -limit; delta <= limit; delta++) starts.add(boundary - needle.length + delta);
            }
            if (starts.size > 200 || ends.size > 200) return [];
          }
          if (anchored) break;
        }
      }
      for (const begin of starts) {
        const candidates = long ? ends : Array.from({ length: limit * 2 + 1 }, (_, i) => begin + needle.length - limit + i);
        for (const end of candidates) {
          if (Math.abs(end - begin - needle.length) > limit
            || begin < 0 || end > text.length || text[begin] === ' ' || text[end - 1] === ' ') continue;
          // Never cut a normalized glyph (e.g. a ligature or a surrogate pair).
          if ((begin && haystack.starts[begin] === haystack.starts[begin - 1]) || (end < text.length && haystack.starts[end] === haystack.starts[end - 1])) continue;
          const distance = textDiff(needle, text.slice(begin, end), false, limit).distance;
          if (!distance || distance > limit) continue;
          const start = haystack.starts[begin], stop = haystack.ends[end - 1];
          found.set(`${start}:${stop}`, { start, end: stop, approximate: true, distance });
        }
      }
      return [...found.values()];
    }
    function sourceIndex(source) {
      const template = document.createElement("template"), starts = [], ends = [], formats = [];
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
            const definition = htmlFontDefinition(name, text, raw.length, token.index);
            stack.push({ name, definition, italic: definition.italic ?? inherited.italic, bold: definition.bold ?? inherited.bold,
              tags: definition.italic !== null || definition.bold !== null ? [...inherited.tags, definition] : inherited.tags });
          }
          value = (tag[1] && /^(p|div|li|h[1-6])$/.test(name)) || name === "br" ? "\n" : "";
          encoded = true;
        } else if (text.startsWith("<!")) value = "";
        else if (text.startsWith("&") && text.endsWith(";")) {
          template.innerHTML = text;
          value = template.content.textContent;
          encoded = value !== text;
        }
        raw += value;
        for (let i = 0; i < value.length; i++) {
          starts.push(token.index + (encoded ? 0 : i));
          ends.push(token.index + (encoded ? text.length : i + 1));
          formats.push(stack.at(-1));
        }
      }
      return { source, raw, starts, ends, formats, normalized: normalized(raw), pageScopes: new WeakMap(), connections: new WeakMap() };
    }
    function editorSourceIndex(model, targets = []) {
      // One source snapshot per model/PDF pair, shared by selection and review.
      let pairs = sourceIndexes.get(model);
      if (!pairs) sourceIndexes.set(model, pairs = new WeakMap());
      const pdf = environment.getPdf?.() || noPdf;
      const previous = pairs.get(pdf), version = model.getVersionId?.();
      if (version !== undefined && previous?.version === version) return previous;
      const source = model.getValue();
      if (previous?.source === source && previous.version === version) return previous;
      const index = { version, ...sourceIndex(source) };
      if (previous) {
        const { start, oldEnd, newEnd } = changedRange(previous.raw, index.raw);
        const shift = range => range && (range.end <= start ? 0 : range.start >= oldEnd ? newEnd - oldEnd : null);
        // Keep confirmed, unchanged passages; only edited passages need a new diff.
        for (const target of new Set([...targets, ...(environment.getTargets?.() || []), getDocumentIndex(pdf)].filter(Boolean))) {
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
            ...cached, scope: { ...cached.scope, start: cached.scope.start + delta, end: cached.scope.end + delta }
          });
          // Formatting edits retain the same text coordinates in both directions.
          // Reuse the reverse scope too, so prepareSource does not rematch the volume.
          if (previous.raw === index.raw) {
            const reverseScope = target.pageScopes?.get(previous);
            if (reverseScope) target.pageScopes.set(index, reverseScope);
          }
        }
      }
      pairs.set(pdf, index);
      return index;
    }
    function reviewAnchor(item, currentIndex) {
      const source = item?.pdfSource;
      if (!source) return null;
      let anchors = reviewAnchors.get(item);
      if (!anchors) reviewAnchors.set(item, anchors = new WeakMap());
      // Read the candidate's confirmed diff, including after its HTML offsets move.
      // Popup layout must never search again or prepare another source mapping.
      for (const { index } of environment.getVisiblePages?.() || []) {
        if (!index?.layer?.isConnected) continue;
        const connections = source.index.connections.get(index), currentConnections = currentIndex?.connections.get(index);
        let cached = anchors.get(index);
        if (!cached || cached.connections !== connections || cached.currentIndex !== currentIndex || cached.currentConnections !== currentConnections) {
          const hit = connectedRange(source.index, index, source.start, source.end, false, undefined, true)
            || currentIndex && currentIndex !== source.index && connectedRange(currentIndex, index, item.sourceStart, item.sourceEnd, false, undefined, true);
          cached = { connections, currentIndex, currentConnections, hit };
          anchors.set(index, cached);
        }
        const hit = cached.hit;
        if (!hit) continue;
        const anchor = environment.reviewAnchor?.(index, hit);
        if (anchor) return anchor;
      }
      return null;
    }
    function sourcePageScope(index, page, connect = false) {
      const cached = index.pageScopes.get(page);
      if (cached && (!connect || cached.prepared)) return cached.scope;
      let scope = locate(index.raw, { text: page.raw, before: "", after: "" }, index.normalized);
      if (!scope) {
        const text = page.normalized.text, size = Math.min(connect ? 32 : 96, text.length), anchors = [];
        // Overlap prepared anchors so nearby OCR errors cannot hide a clean passage between samples.
        const positions = connect ? Array.from({ length: Math.ceil((text.length - size) / 16) + 1 }, (_, i) => Math.min(i * 16, text.length - size))
          : [0, .25, .5, .75, 1].map(ratio => Math.floor((text.length - size) * ratio));
        if (size >= 24) for (const at of new Set(positions)) {
          const hits = connect && size >= 31 && !options.wholeWords ? anchorMatches(index, text.slice(at, at + size))
            : matches(index.raw, [text.slice(at, at + size)], index.normalized);
          if (hits.length === 1) anchors.push({ at, start: lowerBound(index.normalized.starts, hits[0].start), end: lowerBound(index.normalized.starts, hits[0].end) });
        }
        if (anchors.length >= 2) {
          if (connect) {
            const confirmed = [], from = page.normalized, to = index.normalized;
            for (let i = 1; i < anchors.length; i++) {
              const a = anchors[i - 1], b = anchors[i];
              if (b.start <= a.start) continue;
              const left = from.text.slice(a.at, b.at + size), right = to.text.slice(a.start, b.end);
              const range = { start: from.starts[a.at], end: from.ends[b.at + size - 1], hit: { start: to.starts[a.start], end: to.ends[b.end - 1] } };
              const reused = connectedRange(index, page, range.hit.start, range.hit.end), previous = confirmed.at(-1);
              const limit = Math.min(32, Math.max(12, Math.floor(left.length * .08)));
              if (left.length > 2048) continue;
              const distance = reused?.start === range.start && reused.end === range.end ? 0 : textDiff(left, right, false, limit).distance;
              if (distance <= limit) {
                if (previous && previous.end >= range.start && previous.hit.end >= range.hit.start && previous.distance + distance <= 96) {
                  previous.end = range.end;
                  previous.hit.end = range.hit.end;
                  previous.distance += distance;
                } else confirmed.push({ ...range, distance });
              }
            }
            for (const range of confirmed) rememberConnection(index, range.hit.start, range.hit.end, page, range, null, true);
          }
          if (anchors.every((anchor, i) => !i || anchor.start > anchors[i - 1].start)) {
            const first = anchors[0], last = anchors.at(-1), mapped = index.normalized;
            const start = Math.max(0, first.start - first.at - 32), end = Math.min(mapped.text.length, last.end + text.length - last.at - size + 32);
            scope = { start: mapped.starts[start], end: mapped.ends[end - 1] };
            // Context padding must stay within the PDF pages confirmed by the anchors.
            const firstPage = index.pages?.find(page => mapped.starts[first.start] >= page.start && mapped.starts[first.start] < page.end);
            const lastPage = index.pages?.find(page => mapped.starts[last.end - 1] >= page.start && mapped.starts[last.end - 1] <= page.end);
            if (firstPage) scope.start = Math.max(scope.start, firstPage.start);
            if (lastPage) scope.end = Math.min(scope.end, lastPage.end);
          }
        }
      }
      if (scope) {
        scope.normalized = normalizedRange(index, scope.start, scope.end);
        if (connect) rememberConnection(index, scope.start, scope.end, page, { start: 0, end: page.raw.length }, null, true);
      }
      if (!scope && connect) scope = sourcePageScope(index, page);
      index.pageScopes.set(page, { scope, prepared: connect });
      return scope;
    }
    function rememberConnection(source, start, end, target, hit, alignment, prepared = false) {
      const cached = source.connections.get(target) || [];
      const existing = cached.find(item => item.start === start && item.end === end
        && item.targetStart === hit.start && item.targetEnd === hit.end);
      if (existing) { if (prepared) existing.prepared = true; return existing; }
      const left = alignment?.left || normalizedRange(source, start, end),
        right = alignment?.right || normalizedRange(target, hit.start, hit.end);
      if (!left.text && !right.text) return null;
      const diff = alignment?.diff || textDiff(left.text, right.text, true, 128);
      if (diff.distance > 128) return null;
      const connection = { prepared, start, end, targetStart: hit.start, targetEnd: hit.end, left, right, distance: diff.distance, spans: diff.parts, patches: [] };
      let a = 0;
      for (const span of connection.spans) {
        if (span.changed) {
          let begin = a, stop = a + span.html.length;
          while (begin && /[\p{L}\p{N}]/u.test(left.text[begin - 1])) begin--;
          while (stop < left.text.length && /[\p{L}\p{N}]/u.test(left.text[stop])) stop++;
          const from = left.text.slice(begin, stop);
          const mapped = from && connectedRange(source, target, start + left.starts[begin], start + left.ends[stop - 1], false, connection);
          const to = mapped && normalized(target.raw.slice(mapped.start, mapped.end)).text;
          if (to && !/\s/.test(from + to)) connection.patches.push([from, to]);
        }
        a += span.html.length;
      }
      // Prepared passage mappings are document data; only transient selection mappings are evicted.
      let selections = prepared ? 0 : 1;
      source.connections.set(target, [connection, ...cached.filter(item => (item.start !== start || item.end !== end)
        && (item.prepared || ++selections <= 128))]);
      return connection;
    }
    function patchedWords(entry, target) {
      const patches = new Map();
      for (const [from, to] of (entry.index?.connections.get(target) || []).flatMap(connection => connection.patches))
        patches.set(from, patches.has(from) && patches.get(from) !== to ? null : to);
      const text = normalized(entry.text).text.replace(/[\p{L}\p{N}]+/gu, word => patches.get(word) || word);
      return [...new Set(text.match(/[\p{L}\p{N}]+(?:[-/'\\][\p{L}\p{N}]+)*/gu) || [])];
    }
    function connectedRange(source, target, start, end, reverse = false, connection, marked = false) {
      connection ||= (source.connections.get(target) || []).find(item => start >= (reverse ? item.targetStart : item.start)
        && end <= (reverse ? item.targetEnd : item.end));
      if (!connection || start > end) return null;
      const needsRaw = (marked || start === end) && !reverse;
      const raw = needsRaw && connectionDiff(source, target, connection);
      if (needsRaw && !raw) return null;
      const from = reverse ? connection.right : connection.left, to = reverse ? connection.left : connection.right;
      const offset = reverse ? connection.targetStart : connection.start,
        targetOffset = reverse ? connection.start : connection.targetStart;
      const a = raw ? start - offset : lowerBound(from.ends, start - offset + 1),
        b = raw ? end - offset : lowerBound(from.starts, end - offset);
      let first = Infinity, last = -1, cursorA = 0, cursorB = 0;
      for (const span of raw ? raw.parts : connection.spans) {
        const left = cursorA, right = cursorA += span[reverse ? 'pdf' : 'html'].length,
          targetLeft = cursorB, targetRight = cursorB += span[reverse ? 'html' : 'pdf'].length;
        if (raw && a === b ? !span.changed || left !== a || right !== a : right <= a || left >= b) continue;
        // A changed run has no reliable per-character correspondence; include its whole counterpart.
        first = Math.min(first, span.changed ? targetLeft : targetLeft + Math.max(a, left) - left);
        last = Math.max(last, span.changed ? targetRight : targetLeft + Math.min(b, right) - left);
      }
      if (last === first && !reverse) {
        const anchor = targetOffset + (raw ? first : to.starts[first] ?? to.ends[first - 1] ?? 0);
        return { start: anchor, end: anchor, connection, approximate: true };
      }
      if (last <= first) return null;
      const hit = { start: targetOffset + (raw ? first : to.starts[first]), end: targetOffset + (raw ? last : to.ends[last - 1]), connection };
      // Search alignment folds case; review must compare the original mapped text.
      const selected = (reverse ? target : source).raw.slice(start, end),
        mapped = (reverse ? source : target).raw.slice(hit.start, hit.end);
      hit.approximate = significantText(selected) !== significantText(mapped);
      return hit;
    }
    async function readDocument(pdf) {
      try {
        if (!pdf.ocrTextUrl) throw new Error('No generated text JSON URL');
        const manifestUrl = new URL(pdf.ocrTextUrl, location.href);
        const readJson = async url => {
          const response = await fetch(url);
          if (!response.ok) throw new Error('PDF OCR cache request failed');
          return response.json();
        };
        const { schema, page_count, pages: entries, fonts, document_id, text_length } = await readJson(manifestUrl);
        if (!environment.isCurrent(pdf)) return null;
        if (schema !== 7 || page_count !== pdf.numPages || !Array.isArray(entries)
          || entries.length !== pdf.numPages || !Array.isArray(fonts))
          throw new Error('PDF OCR cache does not match the current document');
        // Load page results with bounded concurrency, retaining the PDF reading order.
        const results = new Array(entries.length);
        let next = 0;
        await Promise.all(Array.from({ length: Math.min(4, results.length) }, async () => {
          while (next < results.length && environment.isCurrent(pdf)) {
            const i = next++, entry = entries[i];
            const pageFile = `page-${String(i + 1).padStart(5, '0')}.json`;
            if (entry.page_index !== i || ![pageFile, `${pageFile}.gz`].includes(entry.file))
              throw new Error('Invalid OCR page file');
            await environment.waitForIdle(pdf);
            if (!environment.isCurrent(pdf)) return;
            results[i] = await readJson(new URL(entry.file, manifestUrl));
          }
        }));
        if (!environment.isCurrent(pdf)) return null;
        let raw = '', point = 0;
        const pages = results.map((result, i) => {
          const entry = entries[i], { comparison, parsing_res_list: blocks } = result, start = raw.length;
          if (result.schema !== 7 || result.document_id !== document_id || result.page_index !== i
            || result.page_label !== entry.page_label || result.page_count !== page_count || entry.start !== point
            || !Array.isArray(blocks) || entry.end < point || comparison?.offset_unit !== 'utf16'
            || typeof comparison.raw !== 'string' || comparison.start !== start
            || comparison.end !== start + comparison.raw.length || !Array.isArray(comparison.parts))
            throw new Error('Invalid prepared OCR comparison');
          let cursor = start;
          const parts = comparison.parts.map(part => {
            if (!Number.isInteger(part.start) || !Number.isInteger(part.end) || part.start < cursor
              || part.end <= part.start || part.end > comparison.end
              || !Number.isInteger(part.fontIndex) || !fonts[part.fontIndex])
              throw new Error('Invalid prepared OCR font run');
            cursor = part.end;
            return { ...part, font: fonts[part.fontIndex] };
          });
          raw += comparison.raw; point = entry.end;
          return { number: i + 1, label: entry.page_label, start, end: raw.length, parts,
            blocks, fontTask: Promise.resolve() };
        });
        if (point !== text_length) throw new Error('Incomplete OCR document');
        return { raw, fonts, pages, fontVersion: 1 };
      } catch (error) {
        if (!environment.isCurrent(pdf)) return null;
        throw new Error(`PDF text data unavailable. Run pdf_text_backend.py with the reader config, then reload. ${error.message}`);
      }
    }
    async function indexDocument(pdf) {
      if (documents.has(pdf)) return documents.get(pdf).task;
      const cached = {};
      documents.set(pdf, cached);
      cached.task = (async () => {
        const index = await readDocument(pdf);
        if (!index) return null;
        if (!environment.isCurrent(pdf)) return null;
        index.connections = new WeakMap();
        index.pageScopes = new WeakMap();
        for (const page of index.pages) page.normalized = normalized(index.raw.slice(page.start, page.end));
        index.normalized = normalized(index.raw);
        cached.index = index;
        if (environment.isCurrent(pdf)) environment.onIndexed?.();
        return cached.index;
      })().then(index => {
        if (!index) documents.delete(pdf);
        return index;
      }, error => { documents.delete(pdf); throw error; });
      return cached.task;
    }
    function findLocations(pdf, entries) {
      const documentIndex = documents.get(pdf)?.index;
      const visible = environment.getVisiblePages?.() || [];
      for (const source of new Set(entries.map(entry => entry.index).filter(Boolean)))
        prepareSource(source, visible.map(page => page.index), pdf);
      const locations = entries.map(entry => {
        let index = documentIndex, hit = null, number;
        for (const page of index ? [] : visible) {
          hit = page.index && entry.index && connectedRange(entry.index, page.index, entry.start, entry.end, false, undefined, entry.marked);
          if (hit) {
            index = page.index;
            number = page.number;
            break;
          }
        }
        if (!hit && index) hit = (entry.index && connectedRange(entry.index, index, entry.start, entry.end, false, undefined, entry.marked)) || locate(index.raw, entry, index.normalized);
        if (!hit) return { entry, targets: [], queries: index ? patchedWords(entry, index) : [entry.text] };
        const connection = hit.connection || (entry.index && rememberConnection(entry.index, entry.start, entry.end, index, hit));
        const pages = index.pages || [{ number, start: 0, end: index.raw.length, parts: index.parts }];
        const targets = pages.filter(page => hit.start === hit.end ? hit.start >= page.start && hit.start <= page.end
          : hit.start < page.end && hit.end > page.start).map(page => {
          const start = Math.max(hit.start, page.start), end = Math.min(hit.end, page.end);
          const target = { pageNumber: page.number,
            difference: hit.approximate || entry.marked && entry.text !== index.raw.slice(hit.start, hit.end)
              ? { html: entry.text, pdf: index.raw.slice(hit.start, hit.end) } : null,
            marked: entry.marked, text: index.raw.slice(start, end), before: index.raw.slice(Math.max(page.start, start - 160), start),
            after: index.raw.slice(end, Math.min(page.end, end + 160)) };
          if (target.difference && entry.index) target.source = { index: entry.index, start: entry.start, end: entry.end };
          const sourceRange = entry.marked || entry.start === entry.end ? entry : connection && connectedRange(entry.index, index, start, end, true, connection);
          if (sourceRange || hit.start === hit.end) Object.assign(target, { index: entry.index,
            start: sourceRange?.start ?? entry.start, end: sourceRange?.end ?? entry.end });
          return target;
        });
        return { entry, targets };
      });
      if (documentIndex || locations.every(location => location.targets.length)) return locations;
      return indexDocument(pdf).then(index => index ? findLocations(pdf, entries) : locations);
    }
    function getDocumentIndex(pdf) { return documents.get(pdf)?.index; }
    async function indexFonts(pdf, source, signal) {
      const index = await indexDocument(pdf);
      if (!index || signal?.aborted) return null;
      if (!index.textLayer) return index;
      const ranges = source?.connections.get(index);
      const pages = source ? index.pages.filter(entry => ranges?.some(hit => hit.targetStart < entry.end && hit.targetEnd > entry.start)) : index.pages;
      return window.LocalOcrTextReader.readDocumentFonts(index, pdf, environment, signal, pages);
    }
    function prepareSource(source, pages, pdf) {
      if (!source) return;
      pages = [...new Set([...pages, ...(environment.getTargets?.() || [])])].filter(Boolean);
      const full = getDocumentIndex(pdf);
      const prepared = source.preparation;
      if (prepared && prepared.pdf === pdf && prepared.full === full && prepared.connections.size === pages.length
        && pages.every(page => prepared.connections.has(page) && source.connections.get(page) === prepared.connections.get(page))) return;
      if (full && source.preparedDocument !== full) {
        sourcePageScope(full, source, true);
        for (const item of full.connections.get(source) || [])
          rememberConnection(source, item.targetStart, item.targetEnd, full, { start: item.start, end: item.end }, {
            left: item.right, right: item.left, diff: { distance: item.distance,
              parts: item.spans.map(span => ({ html: span.pdf, pdf: span.html, changed: span.changed })) }
          }, true);
        source.preparedDocument = full;
      }
      for (const page of pages) if (page !== source.preparedDocument) sourcePageScope(source, page, true);
      // Sweep containing passages once; keep the two furthest covers from distinct pages.
      const connections = pages.flatMap(page => (source.connections.get(page) || []).map(item => ({ page, ...item, item })))
        .sort((a, b) => a.start - b.start || b.end - a.end);
      const covers = [], discarded = new Map();
      for (const hit of connections) {
        if (covers.some(other => other.page !== hit.page && other.end >= hit.end
          && other.end - other.start > hit.end - hit.start)) {
          if (!discarded.has(hit.page)) discarded.set(hit.page, new Set());
          discarded.get(hit.page).add(hit.item);
        }
        if (hit.page === full || covers.some(other => other.page === hit.page && other.end >= hit.end)) continue;
        const previous = covers.findIndex(other => other.page === hit.page);
        if (previous >= 0) covers.splice(previous, 1);
        covers.push(hit);
        covers.sort((a, b) => b.end - a.end || a.start - b.start);
        if (covers.length > 2) covers.pop();
      }
      for (const [page, removed] of discarded)
        source.connections.set(page, source.connections.get(page).filter(item => !removed.has(item)));
      source.preparation = { pdf, full, connections: new Map(pages.map(page => [page, source.connections.get(page)])) };
      source.preparedPdf = pdf;
    }
    function locateSource(index, chunks) {
      // Prefer saved page text; retain the original text layer when no saved index exists.
      chunks = chunks.map(chunk => {
        const full = chunk.index.savedIndex;
        if (!full) return chunk;
        const page = full.pages.find(page => page.number === chunk.index.number);
        if (!page) return null;
        const hit = locate(full.raw.slice(page.start, page.end), {
          text: chunk.index.raw.slice(chunk.start, chunk.end),
          before: chunk.index.raw.slice(Math.max(0, chunk.start - 160), chunk.start),
          after: chunk.index.raw.slice(chunk.end, chunk.end + 160)
        }, page.normalized);
        return hit && { ...chunk, index: full, start: page.start + hit.start, end: page.start + hit.end };
      });
      if (chunks.some(chunk => !chunk)) return { hit: null, difference: { message: 'No reliable cached OCR match' } };
      const first = chunks[0], last = chunks.at(-1);
      prepareSource(index, chunks.map(chunk => chunk.index), environment.getPdf?.());
      const entry = {
        text: chunks.map(({ index, start, end }) => index.raw.slice(start, end)).join("\n"),
        before: first.index.raw.slice(Math.max(0, first.start - 160), first.start),
        after: last.index.raw.slice(last.end, last.end + 160)
      };
      const left = sourcePageScope(index, first.index, true), right = sourcePageScope(index, last.index, true);
      let hit = chunks.length === 1 && connectedRange(index, first.index, first.start, first.end, true);
      if (!hit) {
        const scope = left && right && left.start <= right.start ? { start: left.start, end: right.end } : null;
        const local = scope && locate(index.raw.slice(scope.start, scope.end), entry, left === right ? left.normalized : undefined);
        hit = local ? { ...local, start: local.start + scope.start, end: local.end + scope.start }
          : scope ? null : locate(index.raw, entry, index.normalized);
      }
      const html = hit && index.raw.slice(hit.start, hit.end);
      const differs = hit && (hit.connection ? hit.approximate
        : significantText(html) !== significantText(entry.text));
      const difference = !hit ? { message: "No reliable HTML match" } : differs ? { html, pdf: entry.text } : null;
      if (chunks.length === 1 && hit && !hit.connection)
        rememberConnection(index, hit.start, hit.end, first.index, { start: first.start, end: first.end });
      return { hit, difference };
    }
    function locateLayer(index, queries, targets = []) {
      const { raw } = index;
      const hits = [];
      let focusHit = null;
      for (const target of targets) {
        const connection = target.index && connectedRange(target.index, index, target.start, target.end, false, undefined, target.marked);
        const hit = target.range || connection || locate(raw, target, index.normalized);
        if (hit) {
          if (target.index && !connection) rememberConnection(target.index, target.start, target.end, index, hit);
          hit.difference = target.difference || (!index.savedIndex && hit.approximate ? { html: target.text, pdf: raw.slice(hit.start, hit.end) } : null);
          hit.source = target.source || target.index && { index: target.index, start: target.start, end: target.end };
          if (!focusHit) focusHit = hit;
        }
        // Retain exact fallback highlights when rendered spacing prevents confirmation.
        for (const match of hit ? [hit] : matches(raw, target.index ? patchedWords(target, index) : [target.text], index.normalized))
          if (!hits.some(other => other.start === match.start && other.end === match.end)) hits.push(match);
      }
      for (const match of matches(raw, queries, index.normalized))
        if (!hits.some(hit => hit.start === match.start && hit.end === match.end)) hits.push(match);
      return { hits, focusHit };
    }
  }
})();
