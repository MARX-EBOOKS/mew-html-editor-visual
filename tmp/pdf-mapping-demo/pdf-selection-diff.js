"use strict";
let computer = null, monacoTask = null;
const pageTexts = new WeakMap();
const fontPages = new WeakMap(), pageFontItems = new WeakMap();
// 粗体／斜体：字体读取、区间归并、摘要、替换编辑与差异比较。
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
      let style = fonts.get(item.fontName);
      if (!style) {
        const id = item.fontName, font = id && page.commonObjs?.has(id) ? page.commonObjs.get(id) : null;
        style = fontStyle(font, id || '');
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
      const count = item.str?.replace(/\s/g, '').length || 0;
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
  for (const part of index.parts || index.pages?.filter(page => start < page.end && end > page.start).flatMap(page => page.parts) || []) {
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
  const states = [], reasons = [...new Set(runs.map(run => run.reason).filter(Boolean))];
  for (const key of ['italic', 'bold']) {
    const values = new Set(runs.map(run => run[key]));
    const state = !values.size || values.has(null) ? '未知' : values.size > 1 ? '混合' : values.has(true) ? '是' : '否';
    states.push(`${key === 'italic' ? '斜体' : '粗体'}：${state}`);
  }
  return states.join('；') + (reasons.length ? `（${reasons.join('；')}）` : '');
}
function fontEdits(index, start, end, font) {
  while (start < end && /\s/u.test(index.raw[start])) start++;
  while (end > start && /\s/u.test(index.raw[end - 1])) end--;
  if (start >= end) return [];
  const keys = ['italic', 'bold'].filter(key => typeof font[key] === 'boolean'
    && index.formats.slice(start, end).some((style, i) => !/\s/u.test(index.raw[start + i])
      && (style[key] !== font[key] || !font[key] && style.tags?.some(tag => typeof tag[key] === 'boolean'))));
  if (!keys.length) return [];
  const tags = [...new Set(index.formats.slice(start, end).flatMap(style => style.tags || []))]
    .filter(tag => keys.some(key => typeof tag[key] === 'boolean'))
    .sort((a, b) => a.openStart - b.openStart);
  if (tags.some(tag => tag.closeStart === undefined || !['i', 'em', 'b', 'strong', 'span'].includes(tag.name))) return [];
  // Move adjacent boundaries when adding a single format to unwrapped text.
  if (!tags.length && keys.length === 1 && font[keys[0]]) {
    const key = keys[0], pattern = key === 'italic' ? 'i|em' : 'b|strong';
    const adjacent = before => {
      let at = before ? start - 1 : end;
      while (at >= 0 && at < index.raw.length && /[^\S\r\n]/u.test(index.raw[at])) at += before ? -1 : 1;
      return index.formats[at]?.tags?.findLast(tag => tag[key] === true
        && new RegExp(`^<(${pattern})>$`, 'i').test(tag.opening)
        && tag.closeStart !== undefined && (before ? tag.rawEnd <= start : tag.rawStart >= end)
        && /^[^\S\r\n]*$/u.test(index.source.slice(before ? tag.closeEnd : index.ends[end - 1],
          before ? index.starts[start] : tag.openStart)));
    };
    const left = adjacent(true), candidate = adjacent(false);
    const right = candidate && (!left || candidate.opening === left.opening) ? candidate : null;
    if (left || right) {
      const a = left ? left.closeStart : index.starts[start], b = right ? right.openEnd : index.ends[end - 1];
      const text = (left ? index.source.slice(left.closeEnd, index.starts[start]) : right.opening)
        + index.source.slice(index.starts[start], index.ends[end - 1])
        + (right ? index.source.slice(index.ends[end - 1], right.openStart) : left.closing);
      return [{ start: a, end: b, expected: index.source.slice(a, b), text }];
    }
  }
  let a = index.starts[start], b = index.ends[end - 1];
  // Include complete wrappers, including whitespace at their edges.
  for (const tag of tags) {
    if (!index.raw.slice(tag.rawStart, start).trim()) a = Math.min(a, tag.openStart);
    if (!index.raw.slice(end, tag.rawEnd).trim()) b = Math.max(b, tag.closeEnd);
  }
  const removed = tags.flatMap(tag => [
    { start: tag.openStart, end: tag.openEnd }, { start: tag.closeStart, end: tag.closeEnd }
  ]).filter(tag => tag.start >= a && tag.end <= b).sort((a, b) => b.start - a.start);
  const strip = (from, to) => {
    let text = index.source.slice(from, to);
    for (const tag of removed) if (tag.start >= from && tag.end <= to)
      text = text.slice(0, tag.start - from) + text.slice(tag.end - from);
    return text;
  };
  // Use source coordinates so whitespace entities also stay outside the tags.
  const leading = strip(a, index.starts[start]), trailing = strip(index.ends[end - 1], b);
  let text = strip(index.starts[start], index.ends[end - 1]);
  for (const key of keys) if (font[key]) {
    const name = key === 'italic' ? 'i' : 'b';
    text = `<${name}>${text}</${name}>`;
  }
  text = leading + text + trailing;
  // Keep the portions of enclosing wrappers outside the selected words.
  const left = tags.filter(tag => tag.openStart < a), right = tags.filter(tag => tag.closeEnd > b);
  const before = index.source.slice(0, a).match(/\s*$/u)[0];
  const after = index.source.slice(b).match(/^\s*/u)[0];
  if (left.length) { a -= before.length; text = left.slice().reverse().map(tag => tag.closing).join('') + before + text; }
  if (right.length) { b += after.length; text += after + right.map(tag => tag.opening).join(''); }
  return [{ start: a, end: b, expected: index.source.slice(a, b), text }];
}
// Compare formatting only where unchanged text confirms character correspondence.
function formatDifferences(index, connections) {
  if (!index.formats) return [];
  const items = new Map();
  for (const [connection, target, diff] of connections) {
    const runs = fontRuns(target, connection.targetStart, connection.targetEnd);
    let left = connection.start, right = connection.targetStart, run = 0;
    for (const part of (diff || textDiff(index, target, connection))?.parts || []) {
      while (run < runs.length && runs[run].end <= right) run++;
      for (let i = run; i < runs.length && runs[i].start < right + part.pdf.length; i++) {
        const font = runs[i];
        const a = Math.max(right, font.start), b = Math.min(right + part.pdf.length, font.end);
        if (a >= b) continue;
        // Changed text has no character alignment; compare its complete span only with a uniform PDF font.
        if (part.changed && (font.start > right || font.end < right + part.pdf.length)) continue;
        let start = part.changed ? left : left + a - right;
        const end = part.changed ? left + part.html.length : left + b - right;
        while (start < end) {
          const htmlFont = index.formats[start];
          let stop = start + 1;
          while (stop < end && index.formats[stop] === htmlFont) stop++;
          const differs = htmlFont && ['italic', 'bold'].some(key => typeof font[key] === 'boolean' && font[key] !== htmlFont[key]);
          if (differs) {
            const text = index.raw.slice(start, stop), a = start + (text.match(/^\s*/)?.[0].length || 0),
              b = stop - (text.match(/\s*$/)?.[0].length || 0), id = `font:${a}:${b}`;
            if (a < b && !items.has(id)) items.set(id, { sourceStart: a, sourceEnd: b, font, htmlFont,
              formats: [{ font, htmlFont }] });
          }
          start = stop;
        }
      }
      left += part.html.length;
      right += part.pdf.length;
    }
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
    if (!joins) { merged.push(item); continue; }
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
function layerFonts(view, layer, refresh) {
  const page = view?.pdfPage, objects = page?.commonObjs, fonts = new Map();
  if (page?.getTextContent && !pageFontItems.has(page)) {
    pageFontItems.set(page, { items: [], fonts: new Map() });
    readPageText(page).then(async content => {
      const items = content.items.filter(item => item.str?.length);
      const fonts = await readPageFonts(page, items);
      pageFontItems.set(page, { items, fonts }); refresh();
    }).catch(() => pageFontItems.delete(page));
  }
  const data = pageFontItems.get(page), items = data?.items || [];
  const spans = (view?._textHighlighter?.textDivs || [...layer.querySelectorAll('span[role="presentation"]')]).filter(span => span.textContent);
  const names = new Map();
  if (spans.length === items.length && spans.every((span, i) => span.textContent === items[i].str))
    spans.forEach((span, i) => names.set(span, items[i]));
  return element => {
    const css = element.ownerDocument.defaultView.getComputedStyle(element), family = css.fontFamily;
    const item = names.get(element);
    const observed = item && textItemFont(data?.fonts, item);
    if (observed) return observed;
    const id = item?.fontName || element.dataset?.fontName;
    const key = `${id}:${family}:${css.fontStyle}:${css.fontWeight}`;
    if (!fonts.has(key)) {
      const font = id && objects?.has(id) ? objects.get(id) : objects && [...objects].map(([, value]) => value)
        .find(value => value.loadedName && family.includes(value.loadedName));
      const style = data?.fonts.get(id) || fontStyle(font, family, css);
      fonts.set(key, page?.getTextContent && !data?.fonts.has(id)
        ? { ...style, bold: null, italic: null, reason: '字体渲染模式检查中' } : style);
    }
    return fonts.get(key);
  };
}
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
function rangeAt(model, start, end) {
  const a = model.getPositionAt(start), b = model.getPositionAt(end);
  return { startLineNumber: a.lineNumber, startColumn: a.column,
    endLineNumber: b.lineNumber, endColumn: b.column };
}
function sourceSegments(index, start, end, includeWhitespace = false) {
  const segments = [];
  for (let at = start; at < end; at++) {
    const a = index.starts[at], b = index.ends[at], last = segments.at(-1);
    const text = index.source?.slice(a, b);
    if (/^</.test(text) || !includeWhitespace && /^\s*$/.test(text)) continue;
    if (last && a <= last.end) last.end = Math.max(last.end, b);
    else segments.push({ start: a, end: b });
  }
  return segments;
}
function insertionSegment(index, start) {
  const at = index.starts[start] ?? index.ends[start - 1] ?? 0;
  return { start: at, end: at };
}
function sourceDecorations(index, connections, model) {
  const differences = [], comparisons = [];
  for (const [connection, target] of connections) {
    const diff = textDiff(index, target, connection);
    comparisons.push([connection, target, diff]);
    let end = connection.start;
    for (const part of diff?.parts || []) {
      const start = end;
      end += part.html.length;
      if (!part.changed || significantText(part.html, index, start) === significantText(part.pdf)) continue;
      const escape = text => JSON.stringify(text.trim() ? text : '').replace(/[\\`*_{}\[\]()#+.!<>|~-]/g, '\\$&');
      differences.push({
        start, end, text: true,
        insertions: sourceSegments(index, start, end).length ? [] : [start],
        messages: ['HTML: ' + escape(part.html) + '\n\nOCR: ' + escape(part.pdf)]
      });
    }
  }
  for (const item of formatDifferences(index, comparisons)) {
    const formats = item.formats || [item];
    differences.push({
      start: item.sourceStart, end: item.sourceEnd, font: true, insertions: [],
      messages: [`HTML ${fontSummary(formats.map(value => value.htmlFont))}\n\nPDF ${fontSummary(formats.map(value => value.font))}`]
    });
  }
  // Group visible ranges first so touching changes also join across HTML tags.
  const merged = [];
  for (const item of differences.sort((a, b) => a.start - b.start || b.end - a.end)) {
    const previous = merged.at(-1);
    if (!previous || previous.end < item.start) { merged.push(item); continue; }
    previous.end = Math.max(previous.end, item.end);
    previous.text ||= item.text;
    previous.font ||= item.font;
    previous.messages.push(...item.messages);
    previous.insertions.push(...item.insertions);
  }
  const decorations = [];
  for (const item of merged) {
    let description = 'PDF OCR text difference';
    if (item.text && item.font) description = 'PDF text and font difference';
    else if (item.font) description = 'PDF font difference';
    const tooltips = [];
    if (item.text) tooltips.push('Text differs from PDF OCR');
    if (item.font) tooltips.push('粗体／斜体与 PDF 不一致');
    const options = {
      description, linesDecorationsClassName: 'mew-ocr-diff-line', stickiness: 1,
      inlineClassName: item.font ? 'mew-ocr-diff-text mew-font-diff-text' : 'mew-ocr-diff-text',
      hoverMessage: { value: [...new Set(item.messages)].join('\n\n'), isTrusted: false },
      linesDecorationsTooltip: tooltips.join('；')
    };
    for (const segment of sourceSegments(index, item.start, item.end, Boolean(item.font))) {
      decorations.push({ ...segment, options });
    }
    for (const start of new Set(item.insertions)) {
      decorations.push({ ...insertionSegment(index, start),
        options: { ...options, inlineClassName: undefined, beforeContentClassName: 'mew-ocr-diff-insert' } });
    }
  }
  decorations.sort((a, b) => a.start - b.start || b.end - a.end);
  return decorations.map(({ start, end, options }) => ({ range: rangeAt(model, start, end), options }));
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
function textDiff(left, right, details = false, limit = Infinity) {
  // Index pairs reuse the connection's original-text alignment for review and highlights.
  if (details && typeof details === 'object') {
    const connection = details;
    return connection.editorDiff ||= textDiff(left.raw.slice(connection.start, connection.end),
      right.raw.slice(connection.targetStart, connection.targetEnd), true);
  }
  if (left === right) return { distance: 0, parts: details ? (left ? [{ html: left, pdf: right, changed: false }] : []) : undefined };
  // A bounded match cannot span more extra characters than its edit limit.
  if (Number.isFinite(limit) && Math.abs(Array.from(left).length - Array.from(right).length) > limit)
    return { distance: limit + 1, parts: details ? [{ html: left, pdf: right, changed: true }] : undefined };
  // Bounded anchor checks and unavailable Monaco use the local engine directly.
  if (!computer || !details && Number.isFinite(limit)) return localTextDiff(left, right, details, limit);
  const fallback = details ? localTextDiff(left, right, true, 128) : null;
  if (fallback?.distance <= 128) return fallback;
  try {
    const result = computer.computeDiff(left.split("\n"), right.split("\n"), {
      ignoreTrimWhitespace: false, maxComputationTimeMs: 1000,
      computeMoves: false, extendToSubwords: false
    });
    if (result.hitTimeout) throw new Error("Monaco diff timed out");
    const offsets = text => {
      const starts = [0];
      for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
      return range => starts[range.startLineNumber - 1] + range.startColumn - 1;
    };
    const offsetA = offsets(left), offsetB = offsets(right), parts = [];
    let a = 0, b = 0, distance = 0;
    for (const change of result.changes) {
      if (!change.innerChanges?.length) throw new Error("Missing Monaco character ranges");
      for (const { originalRange: x, modifiedRange: y } of change.innerChanges) {
        const startA = offsetA(x), startB = offsetB(y);
        const endA = offsetA({ startLineNumber: x.endLineNumber, startColumn: x.endColumn });
        const endB = offsetB({ startLineNumber: y.endLineNumber, startColumn: y.endColumn });
        if (![startA, endA, startB, endB].every(Number.isInteger) || startA < a || startB < b
          || endA < startA || endB < startB || endA > left.length || endB > right.length
          || left.slice(a, startA) !== right.slice(b, startB)) throw new Error("Invalid Monaco ranges");
        let changeDistance = Math.max(Array.from(left.slice(startA, endA)).length, Array.from(right.slice(startB, endB)).length);
        if (details) {
          appendPart(parts, left.slice(a, startA), right.slice(b, startB), false);
          // Refine each hunk even when the whole passage exceeds the edit budget.
          const html = left.slice(startA, endA), pdf = right.slice(startB, endB);
          const refined = localTextDiff(html, pdf, true, 128);
          if (refined.distance <= 128) changeDistance = refined.distance;
          for (const part of refined.parts) appendPart(parts, part.html, part.pdf, part.changed);
        }
        distance += changeDistance;
        a = endA; b = endB;
      }
    }
    if (left.slice(a) !== right.slice(b)) throw new Error("Incomplete Monaco ranges");
    if (details) appendPart(parts, left.slice(a), right.slice(b), false);
    return { distance, parts: details ? parts : undefined };
  } catch { /* Retry Monaco on the next comparison. */ }
  return fallback && limit >= 128 ? fallback : localTextDiff(left, right, details, limit);
}
// A Levenshtein wavefront skips equal runs; traceback grows with edits, not file area.
function localTextDiff(left, right, details = false, limit = Infinity) {
  const originalA = [...left], originalB = [...right];
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
function changedRange(before, after) {
  let start = 0, oldEnd = before.length, newEnd = after.length;
  while (start < oldEnd && start < newEnd && before[start] === after[start]) start++;
  while (oldEnd > start && newEnd > start && before[oldEnd - 1] === after[newEnd - 1]) { oldEnd--; newEnd--; }
  return { start, oldEnd, newEnd };
}
function appendPart(parts, html, pdf, changed) {
  const last = parts.at(-1), previous = parts.at(-2);
  if (changed && !pdf && last?.changed === false && previous?.changed && !previous.pdf && /^[\p{L}\p{N}]+$/u.test(last.html) && html.endsWith(last.html)) previous.html += last.html + html.slice(0, -last.html.length);
  else if (last?.changed === changed) { last.html += html; last.pdf += pdf; }
  else if (html || pdf) parts.push({ html, pdf, changed });
}
function useMonaco(value) { computer = value; }
async function loadMonaco() {
  if (computer) return Promise.resolve(true);
  return monacoTask ||= import("/monaco/esm/vs/editor/common/diff/defaultLinesDiffComputer/defaultLinesDiffComputer.js")
    .then(({ DefaultLinesDiffComputer }) => {
      computer = new DefaultLinesDiffComputer();
      return true;
    }).catch(() => false);
}
class PdfSourceIndex {
  connections = new WeakMap();
  pageScopes = new WeakMap();
  constructor(locator, values) {
    Object.assign(this, { locator }, values);
    this.normalized ||= locator.normalized(this.raw);
  }
  rawRange(start, end, mapped = this) {
    return { start: this.locator.lowerBound(mapped.ends, start + 1), end: this.locator.lowerBound(mapped.starts, end) };
  }
  partsInRange(start, end) {
    const first = Math.min(this.parts.length - 1, this.locator.lowerBound(this.parts, start + 1, part => part.end));
    return this.parts.slice(first, (start === end ? first : this.locator.lowerBound(this.parts, end, part => part.end)) + 1);
  }
  sourcePageScope(page, connect = false) {
    const cached = this.pageScopes.get(page);
    if (cached && (!connect || cached.prepared)) return cached.scope;
    const from = page.normalized, to = this.normalized, text = from.text;
    let scope = this.locate({ text: page.raw, before: "", after: "" });
    if (scope && connect) this.rememberConnection(scope.start, scope.end, page, { start: 0, end: page.raw.length });
    for (const prepare of connect ? [true, false] : [false]) {
      if (scope) break;
      const size = Math.min(prepare ? 32 : 96, text.length), anchors = [];
      // Overlap prepared anchors so nearby OCR errors cannot hide a clean passage between samples.
      const positions = prepare ? Array.from({ length: Math.ceil((text.length - size) / 16) + 1 }, (_, i) => Math.min(i * 16, text.length - size))
        : [0, .25, .5, .75, 1].map(ratio => Math.floor((text.length - size) * ratio));
      if (size >= 24) for (const at of new Set(positions)) {
        const hits = this.matches([text.slice(at, at + size)], to, prepare && size >= 31 && !this.locator.options.wholeWords);
        if (hits.length === 1) anchors.push({ at, start: this.locator.lowerBound(to.starts, hits[0].start), end: this.locator.lowerBound(to.starts, hits[0].end) });
      }
      if (anchors.length < 2) continue;
      if (prepare) {
        const confirmed = [];
        for (let i = 1; i < anchors.length; i++) {
          const a = anchors[i - 1], b = anchors[i];
          if (b.start <= a.start) continue;
          const left = from.text.slice(a.at, b.at + size), right = to.text.slice(a.start, b.end);
          const range = { start: from.starts[a.at], end: from.ends[b.at + size - 1], hit: { start: to.starts[a.start], end: to.ends[b.end - 1] } };
          const reused = this.connectedRange(page, range.hit.start, range.hit.end), previous = confirmed.at(-1);
          const limit = Math.min(32, Math.max(12, Math.floor(left.length * .08)));
          if (left.length > 2048) continue;
          const distance = reused?.start === range.start && reused.end === range.end ? 0 : textDiff(left, right, false, limit).distance;
          if (distance > limit) continue;
          if (previous && previous.end >= range.start && previous.hit.end >= range.hit.start && previous.distance + distance <= 96) {
            previous.end = range.end;
            previous.hit.end = range.hit.end;
            previous.distance += distance;
          } else confirmed.push({ ...range, distance });
        }
        for (const range of confirmed) {
          let a = this.locator.lowerBound(from.starts, range.start), b = this.locator.lowerBound(from.ends, range.end) + 1,
            x = this.locator.lowerBound(to.starts, range.hit.start), y = this.locator.lowerBound(to.ends, range.hit.end) + 1;
          // Extend confirmed passages through matching edges, never estimated context padding.
          while (a && x && from.text[a - 1] === to.text[x - 1]) { a--; x--; }
          while (b < from.text.length && y < to.text.length && from.text[b] === to.text[y]) { b++; y++; }
          this.rememberConnection(to.starts[x], to.ends[y - 1], page, { start: from.starts[a], end: from.ends[b - 1] });
        }
      }
      if (!anchors.every((anchor, i) => !i || anchor.start > anchors[i - 1].start)) continue;
      const first = anchors[0], last = anchors.at(-1);
      const start = Math.max(0, first.start - first.at - 32), end = Math.min(to.text.length, last.end + text.length - last.at - size + 32);
      // Context padding must stay within the PDF pages confirmed by the anchors.
      const firstPage = this.pages?.find(page => to.starts[first.start] >= page.start && to.starts[first.start] < page.end);
      const lastPage = this.pages?.find(page => to.starts[last.end - 1] >= page.start && to.starts[last.end - 1] <= page.end);
      scope = { start: Math.max(to.starts[start], firstPage?.start ?? 0), end: Math.min(to.ends[end - 1], lastPage?.end ?? this.raw.length) };
    }
    if (scope) scope.normalized = this.normalizedRange(scope.start, scope.end);
    this.pageScopes.set(page, { scope, prepared: connect });
    return scope;
  }
  *matchPositions(needle, { text }, anchors) {
    if (!anchors) {
      for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + 1)) yield at;
      return;
    }
    // Index aligned 16-character blocks to find 32-character anchors without full rescans.
    this.anchorBlocks ||= Map.groupBy(Array.from({ length: Math.floor(text.length / 16) }, (_, i) => i * 16),
      at => text.slice(at, at + 16));
    for (let offset = 0; offset < 16 && offset + 16 <= needle.length; offset++) {
      for (const position of this.anchorBlocks.get(needle.slice(offset, offset + 16)) || []) {
        const at = position - offset;
        if (at >= 0 && text.startsWith(needle, at)) yield at;
      }
    }
  }
  matches(queries, haystack = this.normalized, anchors = false) {
    const found = new Map(), word = char => !!char && /[\p{L}\p{N}_]/u.test(char);
    for (const query of queries) {
      const needle = anchors ? query : this.locator.normalized(query).text.trim();
      if (!needle) continue;
      for (const at of this.matchPositions(needle, haystack, anchors)) {
        const end = at + needle.length;
        const before = [...haystack.text.slice(Math.max(0, at - 2), at)].pop(), after = [...haystack.text.slice(end, end + 2)][0];
        if (!this.locator.options.wholeWords || ((!word(needle[0]) || !word(before)) && (!word([...needle].pop()) || !word(after)))) {
          const start = haystack.starts[at], stop = haystack.ends[end - 1];
          found.set(`${start}:${stop}`, { start, end: stop });
          if (anchors && found.size > 1) return [...found.values()]; // Only unique anchors are useful.
        }
      }
    }
    return [...found.values()];
  }
  normalizedRange(start, end) {
    return start === 0 && end === this.raw.length ? this.normalized : this.locator.normalized(this.raw.slice(start, end));
  }
  locate(entry, scope = null, fuzzyOnly = false) {
    const offset = scope?.start || 0, haystack = scope?.normalized || this.normalizedRange(offset, scope?.end ?? this.raw.length);
    const before = this.locator.normalized(entry.before).text.trim(), after = this.locator.normalized(entry.after).text.trim();
    const exact = fuzzyOnly ? [] : this.matches([entry.text], haystack);
    const hits = exact.length ? exact : this.locator.approximateMatches(entry.text, before, after, haystack);
    if (!hits.length) return null;
    let best = null, tied = false;
    for (const hit of hits) {
      const begin = this.locator.lowerBound(haystack.starts, hit.start), end = this.locator.lowerBound(haystack.starts, hit.end);
      const left = haystack.text.slice(Math.max(0, begin - 400), begin).trim();
      const right = haystack.text.slice(end, end + 400).trim();
      let a = 0, b = 0;
      while (a < before.length && a < left.length && before.at(-a - 1) === left.at(-a - 1)) a++;
      while (b < after.length && b < right.length && after[b] === right[b]) b++;
      const score = a + b;
      if (!best || score > best.score) { best = { ...hit, score }; tied = false; }
      else if (score === best.score) tied = true;
    }
    const required = Math.min(24, before.length + after.length);
    if (required && best.score < required) return exact.length ? this.locate(entry, scope, true) : null;
    return tied ? null : { ...best, start: best.start + offset, end: best.end + offset };
  }
  rememberConnection(start, end, target, hit, alignment) {
    const cached = this.connections.get(target) || [];
    const existing = cached.find(item => item.start === start && item.end === end
      && item.targetStart === hit.start && item.targetEnd === hit.end);
    if (existing) return existing;
    const left = alignment?.left || this.normalizedRange(start, end),
      right = alignment?.right || target.normalizedRange(hit.start, hit.end);
    if (!left.text && !right.text) return null;
    const diff = alignment?.diff || textDiff(left.text, right.text, true, 128);
    if (diff.distance > 128) return null;
    const connection = { start, end, targetStart: hit.start, targetEnd: hit.end, left, right, distance: diff.distance, spans: diff.parts, patches: [] };
    let a = 0;
    for (const span of connection.spans) {
      if (span.changed) {
        let begin = a, stop = a + span.html.length;
        while (begin && /[\p{L}\p{N}]/u.test(left.text[begin - 1])) begin--;
        while (stop < left.text.length && /[\p{L}\p{N}]/u.test(left.text[stop])) stop++;
        const from = left.text.slice(begin, stop);
        const mapped = from && this.connectedRange(target, start + left.starts[begin], start + left.ends[stop - 1], false, connection);
        const to = mapped && this.locator.normalized(target.raw.slice(mapped.start, mapped.end)).text;
        if (to && !/\s/.test(from + to)) connection.patches.push([from, to]);
      }
      a += span.html.length;
    }
    this.connections.set(target, [connection, ...cached.filter(item => item.start !== start || item.end !== end)].slice(0, Math.max(16, Math.ceil(this.raw.length / 64))));
    return connection;
  }
  patchedWords(text, target) {
    const patches = new Map();
    for (const connection of this.connections.get(target) || []) for (const [from, to] of connection.patches)
      patches.set(from, patches.has(from) && patches.get(from) !== to ? null : to);
    const patched = this.locator.normalized(text).text.replace(/[\p{L}\p{N}]+/gu, word => patches.get(word) || word);
    return [...new Set(patched.match(/[\p{L}\p{N}]+(?:[-/'\\][\p{L}\p{N}]+)*/gu) || [])];
  }
  connectedRange(target, start, end, reverse = false, connection, marked = false) {
    connection ||= (this.connections.get(target) || []).find(item => start >= (reverse ? item.targetStart : item.start)
      && end <= (reverse ? item.targetEnd : item.end));
    if (!connection || start > end) return null;
    const needsRaw = (marked || start === end) && !reverse;
    const raw = needsRaw && textDiff(this, target, connection);
    if (needsRaw && !raw) return null;
    const from = reverse ? connection.right : connection.left, to = reverse ? connection.left : connection.right;
    const offset = reverse ? connection.targetStart : connection.start,
      targetOffset = reverse ? connection.start : connection.targetStart;
    const { start: a, end: b } = raw ? { start: start - offset, end: end - offset } : this.rawRange(start - offset, end - offset, from);
    let first = Infinity, last = -1, cursorA = 0, cursorB = 0;
    for (const span of raw ? raw.parts : connection.spans) {
      const left = cursorA, right = cursorA += span[reverse ? 'pdf' : 'html'].length,
        targetLeft = cursorB, targetRight = cursorB += span[reverse ? 'html' : 'pdf'].length;
      if (raw && a === b ? !span.changed || a < left || a > right || left !== right
        && !(marked && !span.html.trim() && significantText(span.pdf)) : right <= a || left >= b) continue;
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
    return { ...hit, approximate: significantText((reverse ? target : this).raw.slice(start, end))
      !== significantText((reverse ? this : target).raw.slice(hit.start, hit.end)) };
  }
}
class PdfLocator {
  documents = new WeakMap();
  sourceIndexes = new WeakMap();
  reviewAnchors = new WeakMap();
  noPdf = {};

  constructor(options = {}, environment = {}) {
    this.options = options;
    this.environment = environment;
    this.document = environment.document || window.document;
  }

  comparisonParts(value, parts) {
    const { html, pdf } = value;
    if (value.comparisonDiff?.html !== html || value.comparisonDiff.pdf !== pdf)
      value.comparisonDiff = { html, pdf, parts: parts || textDiff(html, pdf, true)?.parts || [{ html, pdf, changed: false }] };
    return value.comparisonDiff.parts;
  }
  comparisonRows(value, compact = true) {
    if (typeof value?.html !== 'string' || typeof value?.pdf !== 'string') return [];
    let parts = this.comparisonParts(value);
    if (compact) {
      const first = parts.findIndex(part => part.changed), last = parts.findLastIndex(part => part.changed);
      if (first >= 0) {
        // Keep every changed run, including unchanged text between distant edits.
        // Reuse the original character diff rather than computing it again on a crop.
        const before = parts.slice(0, first).map(part => part.html).join('');
        const after = parts.slice(last + 1).map(part => part.html).join('');
        const prefix = (before.length > 45 ? '…' : '') + before.slice(-45);
        const suffix = after.slice(0, 45) + (after.length > 45 ? '…' : '');
        parts = [...(prefix ? [{ html: prefix, pdf: prefix, changed: false }] : []),
        ...parts.slice(first, last + 1), ...(suffix ? [{ html: suffix, pdf: suffix, changed: false }] : [])];
      }
    }
    return ['html', 'pdf'].map(side => ({
      label: side.toUpperCase(), parts: parts.map(part => {
        const missing = part.changed && !part[side].trim() && !!part[side === 'html' ? 'pdf' : 'html'].trim();
        return { text: missing ? '' : part[side], changed: part.changed };
      })
    }));
  }
  sourceIndex(source) {
    const template = this.template ||= this.document.createElement("template");
    const starts = [], ends = [], formats = [];
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
          stack.push({
            name, definition, italic: definition.italic ?? inherited.italic, bold: definition.bold ?? inherited.bold,
            tags: definition.italic !== null || definition.bold !== null ? [...inherited.tags, definition] : inherited.tags
          });
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
    return new PdfSourceIndex(this, { source, raw, starts, ends, formats });
  }
  editorSourceIndex(model, targets = []) {
    // One source snapshot per model/PDF pair, shared by selection and review.
    let pairs = this.sourceIndexes.get(model);
    if (!pairs) this.sourceIndexes.set(model, pairs = new WeakMap());
    const pdf = this.environment.getPdf?.() || this.noPdf;
    const previous = pairs.get(pdf), version = model.getVersionId?.();
    if (version !== undefined && previous?.version === version) return previous;
    const source = model.getValue();
    if (previous?.source === source && previous.version === version) return previous;
    const index = Object.assign(this.sourceIndex(source), { version });
    if (previous) {
      const { start, oldEnd, newEnd } = changedRange(previous.raw, index.raw);
      const shift = (item, a = 'start', b = 'end') => {
        const delta = item[b] <= start ? 0 : item[a] >= oldEnd ? newEnd - oldEnd : null;
        return delta === null ? [] : [{ ...item, [a]: item[a] + delta, [b]: item[b] + delta }];
      };
      // Keep confirmed, unchanged passages; only edited passages need a new diff.
      for (const target of new Set([...targets, ...(this.environment.getTargets?.() || []), this.getDocumentIndex(pdf)].filter(Boolean))) {
        const retained = (previous.connections.get(target) || []).flatMap(item => shift(item));
        if (retained.length) index.connections.set(target, retained);
        const reverse = (target.connections?.get(previous) || []).flatMap(item => shift(item, 'targetStart', 'targetEnd'));
        if (reverse.length) target.connections.set(index, reverse);
        const cached = previous.pageScopes.get(target), scope = cached?.scope && shift(cached.scope)[0];
        if (scope) index.pageScopes.set(target, { ...cached, scope });
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
  reviewAnchor(item, currentIndex) {
    const source = item?.pdfSource;
    if (!source) return null;
    let anchors = this.reviewAnchors.get(item);
    if (!anchors) this.reviewAnchors.set(item, anchors = new WeakMap());
    // Read the candidate's confirmed diff, including after its HTML offsets move.
    // Popup layout must never search again or prepare another source mapping.
    for (const { index } of this.environment.getVisiblePages?.() || []) {
      if (!index?.layer?.isConnected) continue;
      const connections = source.index.connections.get(index), currentConnections = currentIndex?.connections.get(index);
      let cached = anchors.get(index);
      if (!cached || cached.connections !== connections || cached.currentIndex !== currentIndex || cached.currentConnections !== currentConnections) {
        const hit = source.index.connectedRange(index, source.start, source.end, false, undefined, true)
          || currentIndex && currentIndex !== source.index && currentIndex.connectedRange(index, item.sourceStart, item.sourceEnd, false, undefined, true);
        cached = { connections, currentIndex, currentConnections, hit };
        anchors.set(index, cached);
      }
      const hit = cached.hit;
      if (!hit) continue;
      const layer = index.layer.getBoundingClientRect();
      if (cached.bounds) return {
        left: layer.left + cached.bounds.left * layer.width,
        top: layer.top + cached.bounds.top * layer.height, bottom: layer.top + cached.bounds.bottom * layer.height
      };
      const end = index.raw.slice(hit.start, hit.end).trim() ? hit.end : hit.start;
      const bounds = { left: Infinity, top: Infinity, bottom: -Infinity };
      const range = this.document.createRange();
      for (const part of index.partsInRange(hit.start, end)) {
        range.setStart(part.node, Math.max(0, Math.min(part.node.length, hit.start - part.start)));
        range.setEnd(part.node, Math.max(0, Math.min(part.node.length, end - part.start)));
        for (const box of range.getClientRects()) if (box.height) {
          bounds.left = Math.min(bounds.left, box.left);
          bounds.top = Math.min(bounds.top, box.top);
          bounds.bottom = Math.max(bounds.bottom, box.bottom);
        }
      }
      if (bounds.bottom !== -Infinity) {
        if (layer.width && layer.height) cached.bounds = {
          left: (bounds.left - layer.left) / layer.width,
          top: (bounds.top - layer.top) / layer.height, bottom: (bounds.bottom - layer.top) / layer.height
        };
        return bounds;
      }
    }
    return null;
  }
  normalized(raw, result = { text: "", starts: [], ends: [] }, base = 0) {
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
  approximateMatches(query, before, after, haystack) {
    const needle = this.normalized(query).text.trim();
    const size = [...needle].length, long = needle.length > 128;
    if (size && size < 3 || !size && (before.length < 4 || after.length < 4) || needle.length > 2048 || before.length + after.length < 8 || (long && (before.length < 12 || after.length < 12))) return [];
    const limit = !size ? 0 : long ? Math.min(32, Math.max(3, Math.floor(size * 0.05)))
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
        if (size && !distance || distance > limit) continue;
        const start = haystack.starts[begin], stop = size ? haystack.ends[end - 1] : start;
        found.set(`${start}:${stop}`, { start, end: stop, approximate: true, distance });
      }
    }
    return [...found.values()];
  }
  lowerBound(values, value, key = entry => entry) {
    let low = 0, high = values.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (key(values[mid]) < value) low = mid + 1; else high = mid;
    }
    return low;
  }
  async indexDocument(pdf) {
    if (this.documents.has(pdf)) return this.documents.get(pdf).task;
    const cached = {};
    this.documents.set(pdf, cached);
    return cached.task = (async () => {
      let raw = "", mappedStart = 0;
      const pages = [], mapped = { text: "", starts: [], ends: [] };
      for (let number = 1; number <= pdf.numPages; number++) {
        if (!this.environment.isCurrent(pdf)) return null;
        await this.environment.waitForIdle(pdf);
        if (!this.environment.isCurrent(pdf)) return null;
        const page = await pdf.getPage(number), content = await readPageText(page);
        if (!this.environment.isCurrent(pdf)) return null;
        const start = raw.length, parts = [];
        let previous = null, pageRaw = "";
        for (const item of content.items.filter(item => item.str?.trim()).sort((a, b) =>
          Math.round((b.transform[5] - a.transform[5]) / Math.max(a.height, b.height)) || a.transform[4] - b.transform[4])) {
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
          this.normalized(raw.slice(mappedStart), mapped, mappedStart); mappedStart = raw.length;
        }
      }
      this.normalized(raw.slice(mappedStart), mapped, mappedStart);
      cached.index = new PdfSourceIndex(this, { raw, pages, normalized: mapped });
      if (this.environment.isCurrent(pdf)) this.environment.onIndexed?.();
      return cached.index;
    })().then(index => {
      if (!index) this.documents.delete(pdf);
      return index;
    }, error => {
      this.documents.delete(pdf);
      throw error;
    });
  }
  getDocumentIndex(pdf) { return this.documents.get(pdf)?.index; }
  async indexFonts(pdf, source, signal) {
    const index = await this.indexDocument(pdf);
    if (!index || signal?.aborted) return null;
    const ranges = source?.connections.get(index);
    for (const entry of index.pages) {
      if (source && !ranges?.some(hit => hit.targetStart < entry.end && hit.targetEnd > entry.start)
        || entry.parts.every(part => part.font)) continue;
      if (signal?.aborted || !this.environment.isCurrent(pdf)) return null;
      // Share in-flight work too; separate reviews can request the same page.
      await (entry.fontTask ||= (async () => {
        await this.environment.waitForIdle(pdf);
        if (!this.environment.isCurrent(pdf)) return;
        const page = await pdf.getPage(entry.number);
        if (!this.environment.isCurrent(pdf)) return;
        const fonts = await readPageFonts(page, entry.parts.map(part => part.item));
        if (!this.environment.isCurrent(pdf)) return;
        for (const part of entry.parts) part.font = textItemFont(fonts, part.item);
        index.fontVersion = (index.fontVersion || 0) + 1;
      })().finally(() => { entry.fontTask = null; }));
    }
    return !signal?.aborted && this.environment.isCurrent(pdf) ? index : null;
  }
  prepareSource(source, pages, pdf) {
    if (!source) return;
    pages = [...new Set([...pages, ...(this.environment.getTargets?.() || [])])].filter(Boolean);
    const full = this.getDocumentIndex(pdf);
    const prepared = source.preparation;
    if (prepared && prepared.pdf === pdf && prepared.full === full && prepared.pages.length === pages.length
      && pages.every((page, i) => page === prepared.pages[i] && source.connections.get(page) === prepared.connections[i])) return;
    if (full && source.preparedDocument !== full) {
      full.sourcePageScope(source, true);
      for (const item of full.connections.get(source) || [])
        source.rememberConnection(item.targetStart, item.targetEnd, full, { start: item.start, end: item.end }, {
          left: item.right, right: item.left, diff: {
            distance: item.distance,
            parts: item.spans.map(span => ({ html: span.pdf, pdf: span.html, changed: span.changed }))
          }
        });
      source.preparedDocument = full;
    }
    for (const page of pages) if (page !== source.preparedDocument) source.sourcePageScope(page, true);
    // Prefer whole-passage mappings over shorter quotations on adjacent pages.
    const connections = pages.flatMap(page =>
      (source.connections.get(page) || []).map(connection => ({ page, connection })));
    for (const page of pages) {
      const previous = source.connections.get(page) || [];
      const retained = previous.filter(item => !connections.some(other => other.page !== page
        // Whole-document text extraction does not carry the rendered page's fonts.
        && other.page !== full
        && other.connection.start <= item.start && other.connection.end >= item.end
        && other.connection.end - other.connection.start > item.end - item.start));
      if (retained.length !== previous.length) source.connections.set(page, retained);
    }
    source.preparation = { pdf, full, pages, connections: pages.map(page => source.connections.get(page)) };
    source.preparedPdf = pdf;
  }
}
window.PdfSelectionDiff = {
  PdfLocator, PdfSourceIndex,
  textDiff, sourceDecorations, sourceSegments, insertionSegment, layerFonts, fontStyle, fontRuns, fontSummary, formatDifferences, readPageFonts, readPageText, textItemFont,
  textEdits, fontEdits, validateEdits, previewEdits, applyEdits, rangeAt, significantText, changedRange, htmlFontDefinition,
  get monacoAvailable() { return !!computer; },
  useMonaco, loadMonaco
};
