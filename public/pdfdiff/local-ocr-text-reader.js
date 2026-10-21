(() => {
  "use strict";
  const pageTexts = new WeakMap(), fontPages = new WeakMap(), pageFontItems = new WeakMap();
  window.LocalOcrTextReader = { readDocument, readDocumentFonts, readPageText, readPageFonts, textItemFont, fontStyle, layerFonts };
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
  function layerFonts(view, layer, refresh, savedPage, savedIndex) {
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

  async function readDocumentFonts(index, pdf, environment, signal, pages = index.pages) {
    if (signal?.aborted || !environment.isCurrent(pdf)) return null;
    // Generated font metadata is complete; PDF.js extraction is only a fallback.
    if (index.textLayer) for (const entry of pages) {
      if (signal?.aborted || !environment.isCurrent(pdf)) return null;
      if (!entry.fontTask) entry.fontTask = (async () => {
        await environment.waitForIdle(pdf);
        if (!environment.isCurrent(pdf)) return;
        const fonts = await readPageFonts(entry.pdfPage, entry.parts.map(part => part.item));
        if (!environment.isCurrent(pdf)) return;
        for (const part of entry.parts) part.font = textItemFont(fonts, part.item);
        index.fontVersion++;
      })().catch(error => { entry.fontTask = null; throw error; });
      await entry.fontTask;
    }
    return !signal?.aborted && environment.isCurrent(pdf) ? index : null;
  }

  // Fallback only: extract the original embedded PDF text when JSON is unavailable.
  async function readDocument(pdf, environment) {
    let raw = '';
    const pages = [];
    for (let number = 1; number <= pdf.numPages; number++) {
      if (!environment.isCurrent(pdf)) return null;
      await environment.waitForIdle(pdf);
      if (!environment.isCurrent(pdf)) return null;
      const pdfPage = await pdf.getPage(number), content = await readPageText(pdfPage);
      if (!environment.isCurrent(pdf)) return null;
      const start = raw.length, parts = [];
      let pageRaw = '', divIdx = 0;
      for (const item of content.items) {
        if (typeof item.str !== 'string') continue;
        parts.push({ start: start + pageRaw.length, end: start + pageRaw.length + item.str.length, divIdx: divIdx++, item });
        pageRaw += item.str;
      }
      pages.push({ number, start, end: start + pageRaw.length, parts, pdfPage });
      raw += pageRaw + '\n';
    }
    return { raw, pages, textLayer: true, fontVersion: 0 };
  }
})();
