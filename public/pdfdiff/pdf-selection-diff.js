(() => {
  "use strict";
  const fontPages = new WeakMap(), pageTexts = new WeakMap();
  window.PdfSelectionDiff = {
    textDiff, connectionDiff, sourceDecorations, createLocator, fontStyle, fontRuns, fontSummary, formatDifferences, readPageFonts, readPageText, textItemFont,
    textEdits, fontEdits, validateEdits, previewEdits, applyEdits, rangeAt, reviewCandidates, significantText, changedRange
  };
  function readPageText(page) {
    if (!pageTexts.has(page)) pageTexts.set(page, Promise.resolve().then(() => page.getTextContent())
      .catch(error => {
        pageTexts.delete(page);
        throw error;
      }));
    return pageTexts.get(page);
  }

  function significantText(text, index, start = 0) {
    return text.replace(/[\s\-\u00ad\u2010\u2011\d]/g, (char, offset) => /\d/.test(char)
      && !(index?.formats?.[start + offset]?.name === 'a'
        && /\bhref\s*=\s*(["'])#Z?F\d+\1/i.test(index.formats[start + offset].definition.opening)) ? char : '');
  }
  function connectionDiff(index, target, connection) {
    const cached = connection.editorDiff;
    if (cached?.index === index && cached.target === target && cached.fontVersion === target.fontVersion
      && cached.start === connection.start && cached.end === connection.end
      && cached.targetStart === connection.targetStart && cached.targetEnd === connection.targetEnd) return cached;
    return connection.editorDiff = textDiff(index.raw.slice(connection.start, connection.end),
      target.raw.slice(connection.targetStart, connection.targetEnd), true, Infinity, { index, target, connection, alignment: cached });
  }
  // Generated PDF.js CSS families can hide intrinsic bold/italic faces.
  function fontStyle(font, fallback = '', css = {}) {
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
  function textItemFont(fonts, item) {
    return fonts?.get(JSON.stringify([item.fontName, item.str, item.transform, item.width])) || fonts?.get(item.fontName);
  }
  async function readPageFonts(page, items) {
    if (fontPages.has(page)) return fontPages.get(page);
    fontPages.set(page, (async () => {
      const ops = window.pdfjsLib?.OPS || { save: 10, restore: 11, setFont: 37, setTextRenderingMode: 38,
        showText: 44, showSpacedText: 45, nextLineShowText: 46, nextLineSetSpacingShowText: 47 };
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
          else if ([ops.showText, ops.showSpacedText, ops.nextLineShowText, ops.nextLineSetSpacingShowText].includes(fn)
            && (mode & 3) === 3) invisibleFonts.add(fontId);
        }
      } catch {
        failed = true; /* Text comparison remains available. */
      }
      const fonts = new Map(), textFonts = new Set();
      let letters = 0, boldLetters = 0;
      for (const item of items) {
        const id = item.fontName;
        if (!fonts.has(id)) {
          const font = id && page.commonObjs?.has(id) ? page.commonObjs.get(id) : null;
          const style = fontStyle(font, id || '');
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
        const count = item.str?.replace(/\s/g, '').length || 0, style = fonts.get(id);
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
  function fontRuns(index, start = 0, end = index.raw.length) {
    const runs = [];
    for (const part of index.parts || index.pages?.flatMap(page => page.parts) || []) {
      const a = Math.max(start, part.start), b = Math.min(end, part.end);
      if (a >= b || !index.raw.slice(a, b).trim()) continue;
      const style = part.font || { name: '', italic: null, bold: null }, last = runs.at(-1);
      if (last && last.italic === style.italic && last.bold === style.bold && last.name === style.name
        && !index.raw.slice(last.end, a).trim()) last.end = b;
      else runs.push({ ...style, start: a, end: b });
    }
    return runs;
  }
  function fontSummary(runs) {
    const state = key => {
      const values = new Set(runs.map(run => run[key]));
      return !values.size || values.has(null) ? '未知' : values.size > 1 ? '混合' : values.has(true) ? '是' : '否';
    };
    const reasons = [...new Set(runs.map(run => run.reason).filter(Boolean))];
    return `斜体：${state('italic')}；粗体：${state('bold')}` + (reasons.length ? `（${reasons.join('；')}）` : '');
  }
  function fontEdits(index, start, end, font) {
    const original = index.formats[start], keys = ['italic', 'bold'];
    const changes = keys.filter(key => typeof font[key] === 'boolean' && font[key] !== original[key]);
    if (!changes.length) return [];
    const tags = (original.tags || []).filter(tag => changes.some(key =>
      typeof tag[key] === 'boolean' && tag[key] !== font[key])).sort((a, b) => b.openStart - a.openStart);
    if (tags.some(tag => tag.closeStart === undefined || !/^<(i|em|b|strong)>$/i.test(tag.opening))) return [];
    let a = index.starts[start], b = index.ends[end - 1], text = index.source.slice(a, b);
    for (const key of keys) {
      const desired = typeof font[key] === 'boolean' ? font[key] : original[key];
      if (desired && (changes.includes(key) || tags.some(tag => tag[key] === true))) {
        const pattern = key === 'italic' ? 'i|em' : 'b|strong';
        // Extend a nearby wrapper rather than adding another pair of tags.
        // Removed wrappers keep their own boundary handling below.
        const nearby = !tags.length && changes.length === 1;
        let left = nearby && new RegExp(`</(${pattern})>([ \\t]*)$`, 'i').exec(index.source.slice(0, a));
        if (left && !index.formats[start - left[2].length - 1]?.tags.some(tag =>
          tag.closeEnd === a - left[2].length && tag[key] === true
          && tag.opening.toLowerCase() === `<${tag.name}>`
          && keys.every(other => other === key || tag[other] === null || tag[other] === original[other]))) left = null;
        const name = left?.[1] || (key === 'italic' ? 'i' : 'b');
        const right = nearby && new RegExp(`^([ \\t]*)<(${left ? name : pattern})>`, 'i').exec(index.source.slice(b));
        const wrapper = left?.[1] || right?.[2] || name;
        if (left) a -= left[0].length;
        if (right) b += right[0].length;
        text = (left ? left[2] : `<${wrapper}>`) + text + (right ? right[1] : `</${wrapper}>`);
      }
    }
    // Delete a whole wrapper, or move its closing/opening tag to the selection.
    for (const tag of tags) {
      const before = index.source.slice(tag.openEnd, a), after = index.source.slice(b, tag.closeStart);
      if (!index.raw.slice(tag.rawStart, start).trim()) { a = tag.openStart; text = before + text; }
      else {
        const space = before.match(/[ \t]*$/)[0];
        a -= space.length; text = tag.closing + space + text;
      }
      if (!index.raw.slice(end, tag.rawEnd).trim()) { b = tag.closeEnd; text += after; }
      else {
        const space = after.match(/^[ \t]*/)[0];
        b += space.length; text += space + tag.opening;
      }
    }
    if (changes.some(key => !font[key]) && !tags.length) return [];
    return [{ start: a, end: b, expected: index.source.slice(a, b), text }];
  }
  // Compare formatting only where unchanged text confirms character correspondence.
  function formatDifferences(index, connections) {
    if (!index.formats) return [];
    const items = new Map();
    for (const [connection, target] of connections) {
      for (const item of connectionDiff(index, target, connection).fonts)
        if (!items.has(`font:${item.sourceStart}:${item.sourceEnd}`)) items.set(`font:${item.sourceStart}:${item.sourceEnd}`, item);
    }
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
    const definition = { name, opening: text, rawStart, openStart, openEnd: openStart + text.length,
      italic: italic && /^(normal|italic|oblique)\b/i.test(italic) ? !/^normal$/i.test(italic) : /^(i|em)$/.test(name) ? true : null,
      bold: bold && /^(normal|bold|[1-9]00)$/i.test(bold) ? /bold/i.test(bold) || Number(bold) >= 600 : /^(b|strong)$/.test(name) ? true : null };
    return definition;
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
      add(connectionDiff(index, target, connection), target.raw);
    if (notice?.source && index.raw.slice(notice.source.start, notice.source.end) === notice.html)
      add(textDiff(notice.html, notice.pdf, true, Infinity, { index, target: { raw: notice.pdf },
        connection: { start: notice.source.start, end: notice.source.end, targetStart: 0, targetEnd: notice.pdf.length },
        alignment: selectedParts && { parts: selectedParts, leftText: notice.html, rightText: notice.pdf } }));
    return items.sort((a, b) => a.sourceStart - b.sourceStart || a.sourceEnd - b.sourceEnd);
  }
  function rangeAt(model, start, end) {
    const a = model.getPositionAt(start), b = model.getPositionAt(end);
    return { startLineNumber: a.lineNumber, startColumn: a.column,
      endLineNumber: b.lineNumber, endColumn: b.column };
  }
  function sourceSegments(index, start, end, includeWhitespace = false) {
    const segments = [];
    for (let at = start; at < end; at++) {
      const a = index.starts[at], b = index.ends[at], last = segments.at(-1);
      const source = index.source?.slice(a, b);
      if (source?.startsWith('<') || !includeWhitespace && source !== undefined && /^\s*$/.test(source)) continue;
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
    const segments = sourceSegments(index, start, end, true);
    if (!segments.length) segments.push(insertionSegment(index, start));
    const text = replacement.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return segments.map((segment, i) => ({ ...segment, text: i ? '' : text,
      expected: index.source.slice(segment.start, segment.end) }));
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
  function textDiff(left, right, details = false, limit = Infinity, context = null) {
    if (context?.alignment?.leftText === left && context.alignment.rightText === right)
      return finish(context.alignment);
    const originalA = [...left], originalB = [...right];
    if (Math.abs(originalA.length - originalB.length) > limit)
      return finish({ distance: limit + 1, parts: details ? [{ html: left, pdf: right, changed: true }] : undefined });
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
    if (previous[n - m + distance] !== n) return finish({ distance: bound + 1, parts: details ? [{ html: left, pdf: right, changed: true }] : undefined });
    if (!details) return finish({ distance });
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
    return finish({ distance, parts });
    function finish(alignment) {
      if (!context) return alignment;
      const { index, target, connection } = context;
      const result = { ...alignment, index, target, fontVersion: target.fontVersion,
        leftText: left, rightText: right, start: connection.start, end: connection.end,
        targetStart: connection.targetStart, targetEnd: connection.targetEnd, text: [], fonts: [], spans: [] };
      if (alignment.distance > 128) return result;
      const runs = index.formats ? fontRuns(target, connection.targetStart, connection.targetEnd) : [];
      let cursorA = connection.start, cursorB = connection.targetStart, run = 0;
      // Classify text and style in the same walk over the aligned spans.
      for (const part of alignment.parts || []) {
        const end = cursorA + part.html.length, stop = cursorB + part.pdf.length;
        const span = { ...part, start: cursorA, end, pdfStart: cursorB, pdfEnd: stop };
        if (part.pdf.length) result.spans.push(span);
        if (part.changed) {
          if (significantText(part.html, index, cursorA) !== significantText(part.pdf)) result.text.push(span);
        } else {
          while (run < runs.length && runs[run].end <= cursorB) run++;
          for (let i = run; i < runs.length && runs[i].start < stop; i++) {
            const font = runs[i], limit = cursorA + Math.min(stop, font.end) - cursorB;
            let start = cursorA + Math.max(cursorB, font.start) - cursorB;
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
        cursorA = end; cursorB = stop;
      }
      return result;
    }
  }
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
  function sourceDecorations(index, connections, model) {
    const decorations = [], seen = new Set();
    const add = (segments, prefix, options) => {
      for (const { start, end } of segments) {
        const key = `${prefix}${start}:${end}`;
        if (seen.has(key)) continue;
        seen.add(key);
        decorations.push({ range: rangeAt(model, start, end), options: {
          linesDecorationsClassName: 'mew-ocr-diff-line', stickiness: 1, ...options
        } });
      }
    };
    for (const [connection, target] of connections) {
      let cursor = connection.start;
      for (const part of connectionDiff(index, target, connection).text) {
        cursor = part.start;
        const end = part.end;
        {
          const escape = text => JSON.stringify(text).replace(/[\\`*_{}\[\]()#+.!<>|~-]/g, '\\$&');
          const segments = cursor === end ? [insertionSegment(index, cursor)] : sourceSegments(index, cursor, end);
          add(segments, '', {
            description: 'PDF OCR text difference',
            inlineClassName: part.html.length ? 'mew-ocr-diff-text' : undefined,
            beforeContentClassName: part.html.length ? undefined : 'mew-ocr-diff-insert',
            hoverMessage: { value: 'HTML: ' + escape(part.html) + '\n\nOCR: ' + escape(part.pdf), isTrusted: false },
            linesDecorationsTooltip: 'Text differs from PDF OCR'
          });
        }
        cursor = end;
      }
    }
    for (const item of formatDifferences(index, connections)) {
      const formats = item.formats || [item];
      add(sourceSegments(index, item.sourceStart, item.sourceEnd), 'font:', {
        description: 'PDF font difference', inlineClassName: 'mew-ocr-diff-text mew-font-diff-text',
        hoverMessage: { value: `HTML ${fontSummary(formats.map(value => value.htmlFont))}\n\nPDF ${fontSummary(formats.map(value => value.font))}`, isTrusted: false },
        linesDecorationsTooltip: '粗体／斜体与 PDF 不一致'
      });
    }
    return decorations;
  }
  function createLocator(options = {}, environment = {}) {
    const documents = new WeakMap(), sourceIndexes = new WeakMap(), reviewAnchors = new WeakMap(), noPdf = {};
    const document = environment.document || window.document;
    return { sourceIndex, editorSourceIndex, sourcePageScope, normalized, matches, locate,
      normalizedRange, approximateMatches, lowerBound, rememberConnection, patchedWords,
      connectedRange, reviewAnchor, indexDocument, indexFonts, getDocumentIndex, findLocations, prepareSource, locateSource, locateLayer };
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
      // Read the candidate's confirmed diff, including after its HTML offsets move.
      // Popup layout must never search again or prepare another source mapping.
      for (const { index } of environment.getVisiblePages?.() || []) {
        if (!index?.layer?.isConnected) continue;
        const connections = source.index.connections.get(index), current = currentIndex?.connections.get(index);
        const cached = reviewAnchors.get(item), page = index.layer.getBoundingClientRect();
        if (cached?.index === index && cached.connections === connections && cached.current === current && cached.source === currentIndex) {
          return { left: page.left + cached.left * page.width, top: page.top + cached.top * page.height,
            bottom: page.top + cached.bottom * page.height };
        }
        const hit = connectedRange(source.index, index, source.start, source.end, false, undefined, true)
          || currentIndex && connectedRange(currentIndex, index, item.sourceStart, item.sourceEnd, false, undefined, true);
        if (!hit) continue;
        const first = index.parts[Math.min(index.parts.length - 1, lowerBound(index.parts, hit.start + 1, part => part.end))];
        const last = hit.start === hit.end ? first : index.parts[lowerBound(index.parts, hit.end, part => part.end)];
        if (!first || !last) continue;
        const range = document.createRange();
        range.setStart(first.node, Math.max(0, Math.min(first.node.length, hit.start - first.start)));
        range.setEnd(last.node, Math.max(0, Math.min(last.node.length, hit.end - last.start)));
        const boxes = [...range.getClientRects()].filter(box => box.height);
        if (boxes.length) {
          const bounds = { left: Math.min(...boxes.map(box => box.left)),
            top: Math.min(...boxes.map(box => box.top)), bottom: Math.max(...boxes.map(box => box.bottom)) };
          if (page.width && page.height) reviewAnchors.set(item, { index, connections, current, source: currentIndex,
            left: (bounds.left - page.left) / page.width, top: (bounds.top - page.top) / page.height, bottom: (bounds.bottom - page.top) / page.height });
          return bounds;
        }
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
        const retained = connect && connectedRange(index, page, 0, page.raw.length, true);
        if (retained && retained.start >= scope.start && retained.end <= scope.end)
          scope = { ...scope, start: retained.start, end: retained.end };
        scope.normalized = normalizedRange(index, scope.start, scope.end);
        if (connect) rememberConnection(index, scope.start, scope.end, page, { start: 0, end: page.raw.length }, null, true);
      }
      if (!scope && connect) scope = sourcePageScope(index, page);
      index.pageScopes.set(page, { scope, prepared: connect });
      return scope;
    }
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
      let exact = fuzzyOnly ? [] : matches(raw, [entry.text], haystack);
      if (!fuzzyOnly && entry.text === '' && before.length + after.length >= 24) {
        // Missing PDF text has a position, not a searchable character. Recover
        // that boundary from its confirmed surrounding text when a layer was rebuilt.
        const anchor = after ? after.slice(0, 24) : before.slice(-24);
        exact = matches(raw, [anchor], haystack).flatMap(hit => {
          const point = after ? hit.start : hit.end, at = lowerBound(haystack.starts, point);
          const left = haystack.text.slice(Math.max(0, at - before.length - 32), at).trimEnd();
          const right = haystack.text.slice(at, at + after.length + 32).trimStart();
          return (before && !left.endsWith(before.slice(-24)) || after && !right.startsWith(after.slice(0, 24)))
            ? [] : [{ start: point, end: point, approximate: true }];
        });
      }
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
    function lowerBound(values, value, key = entry => entry) {
      let low = 0, high = values.length;
      while (low < high) {
        const mid = (low + high) >>> 1;
        if (key(values[mid]) < value) low = mid + 1; else high = mid;
      }
      return low;
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
      if (needsRaw && (!raw || raw.distance > 128)) return null;
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
    async function indexDocument(pdf) {
      if (documents.has(pdf)) return documents.get(pdf).task;
      const cached = {};
      documents.set(pdf, cached);
      cached.task = (async () => {
        let raw = "", mappedStart = 0;
        const pages = [], mapped = { text: "", starts: [], ends: [] };
        for (let number = 1; number <= pdf.numPages; number++) {
          if (!environment.isCurrent(pdf)) return null;
          await environment.waitForIdle(pdf);
          if (!environment.isCurrent(pdf)) return null;
          const page = await pdf.getPage(number), content = await readPageText(page);
          if (!environment.isCurrent(pdf)) return null;
          const start = raw.length, parts = [];
          let previous = null, pageRaw = "";
          for (const item of content.items) {
            if (typeof item.str !== "string") continue;
            if (previous && !pageRaw.endsWith("\n")) {
              const lineBreak = Math.abs(item.transform[5] - previous.transform[5]) > Math.max(item.height, previous.height) * 0.5;
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
            normalized(raw.slice(mappedStart), mapped, mappedStart); mappedStart = raw.length;
          }
        }
        normalized(raw.slice(mappedStart), mapped, mappedStart);
        cached.index = { raw, pages, fontVersion: 0, normalized: mapped, connections: new WeakMap(), pageScopes: new WeakMap() };
        if (environment.isCurrent(pdf)) environment.onIndexed?.();
        return cached.index;
      })().catch(error => {
        documents.delete(pdf);
        throw error;
      });
      const index = await cached.task;
      if (!index) documents.delete(pdf);
      return index;
    }
    function findLocations(pdf, entries) {
      const documentIndex = documents.get(pdf)?.index;
      const visible = environment.getVisiblePages?.() || [];
      for (const source of new Set(entries.map(entry => entry.index).filter(Boolean)))
        prepareSource(source, visible.map(page => page.index), pdf);
      const locations = entries.map(entry => {
        let index = documentIndex, hit = null, number;
        for (const page of visible) {
          if (page.index && entry.index) sourcePageScope(entry.index, page.index, true);
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
          const target = { pageNumber: page.number, item: page.parts.find(part => part.end > start)?.item,
            difference: hit.approximate || entry.marked && entry.text !== index.raw.slice(hit.start, hit.end)
              ? { html: entry.text, pdf: index.raw.slice(hit.start, hit.end) } : null,
            marked: entry.marked, text: index.raw.slice(start, end), before: index.raw.slice(Math.max(page.start, start - 160), start),
            after: index.raw.slice(end, Math.min(page.end, end + 160)) };
          if (target.difference && entry.index) {
            target.source = { index: entry.index, start: entry.start, end: entry.end };
            target.target = { index, start: hit.start, end: hit.end };
          }
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
    async function indexFonts(pdf) {
      const index = await indexDocument(pdf);
      if (!index) return null;
      const cached = documents.get(pdf);
      return cached.fontTask ||= (async () => {
        for (const entry of index.pages) {
          await environment.waitForIdle(pdf);
          if (!environment.isCurrent(pdf)) return null;
          const page = await pdf.getPage(entry.number);
          const fonts = await readPageFonts(page, entry.parts.map(part => part.item));
          for (const part of entry.parts) part.font = textItemFont(fonts, part.item);
          index.fontVersion++;
        }
        return environment.isCurrent(pdf) ? index : null;
      })();
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
          hit.difference = target.difference || (hit.approximate ? { html: target.text, pdf: raw.slice(hit.start, hit.end) } : null);
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
