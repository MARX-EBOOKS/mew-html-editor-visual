from pathlib import Path
p=Path('tests/pdf-selection-diff.test.mjs');s=p.read_text(encoding='utf-8')
s+=r'''

test('OCR page reads publish font styles into the same aligned spans without a separate font pass', async () => {
  const api = engine(), objects = new Map();
  let pageReads = 0, textReads = 0, operatorReads = 0, release, notifications = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const items = ['Regular', 'Styled', 'RIGHT'].map((str, i) => ({ str, fontName: i === 1 ? 'style' : 'regular',
    transform: [1, 0, 0, 1, i * 80, 100], width: 70, height: 12 }));
  const page = { commonObjs: objects,
    async getTextContent() { textReads++; return { items }; },
    async getOperatorList() {
      operatorReads++;
      await gate;
      objects.set('regular', { name: 'Times', bold: false, italic: false });
      objects.set('style', { name: 'Times-BoldItalic', bold: true, italic: true });
      return { fnArray: [37, 38, 44, 37, 44], argsArray: [['regular', 12], [3], [], ['style', 12], []] };
    }
  };
  const pdf = { numPages: 1, async getPage() { pageReads++; return page; } };
  const locator = api.createLocator({}, { document: { createElement: () => ({}) },
    isCurrent: () => true, waitForIdle: async () => {}, onIndexed: () => notifications++ });
  const target = await locator.indexDocument(pdf);
  const source = locator.sourceIndex('<p>Regular Styled WRONG</p>');
  const connection = locator.rememberConnection(source, 0, source.raw.length, target, { start: 0, end: target.raw.length });
  const before = api.differences(source, target, connection);
  assert.ok(before.text.length > 0, 'text comparison works while PDF font metadata is pending');
  assert.equal(before.fonts.length, 0, 'pending font data cannot create an automatic format edit');
  assert.equal(operatorReads, 1, 'font detection already started with the OCR page read');
  const alignment = connection.editorDiff;
  release();
  await target.pages[0].fontTask;
  const after = api.differences(source, target, connection);
  assert.equal(connection.editorDiff, alignment, 'font publication reuses the confirmed text alignment');
  assert.equal(after.fonts.length, 1);
  assert.equal(source.raw.slice(after.fonts[0].sourceStart, after.fonts[0].sourceEnd), 'Styled');
  assert.equal(after.fonts[0].font.bold, true);
  assert.equal(after.fonts[0].font.italic, true);
  assert.ok(notifications >= 2, 'late font metadata publishes an index update for existing highlights');
  const content = await api.readPageText(page);
  assert.equal(target.pages[0].parts[1].font, content.fonts.get('style'));
  const spans = items.map(item => ({ textContent: item.str,
    ownerDocument: { defaultView: { getComputedStyle: () => ({ fontFamily: 'serif' }) } } }));
  const view = { pdfPage: page, _textHighlighter: { textDivs: spans } };
  await new Promise(resolve => api.layerFonts(view, {}, resolve));
  assert.equal(api.layerFonts(view, {}, () => {})(spans[1]), target.pages[0].parts[1].font,
    'rendered OCR layers and the document index use the same detected style object');
  const changed = locator.sourceIndex('<p>Regular BADDDD RIGHT</p>');
  const mismatch = locator.rememberConnection(changed, 0, changed.raw.length, target, { start: 0, end: target.raw.length });
  assert.equal(api.formatDifferences(changed, [[mismatch, target]]).length, 0,
    'styled PDF text cannot be applied to a different HTML word without aligned characters');
  await locator.indexFonts(pdf);
  assert.deepEqual([pageReads, textReads, operatorReads], [1, 1, 1], 'review and native layers never reread this page');
});
'''
p.write_text(s,encoding='utf-8')
p=Path('pdf-selection.md');s=p.read_text(encoding='utf-8')
s=s.replace('''`local-text-diff.js` contains normalization/search, edit transactions, and both text
comparison implementations. Bounded OCR changes use its local comparison; larger
changes use Monaco when available and fall back locally on failure.''','''`pdf-selection-diff.js` contains normalization/search, edit transactions, and both
text comparison implementations in the same closure as font detection and alignment.
Bounded OCR changes use the embedded local comparison; larger changes use Monaco
when available and fall back locally on failure. There is no separate text-helper import.''')
s=s.replace('''Page-text requests are shared by indexing and native-layer font loading through
`PdfSelectionDiff.readPageText()`. Failed requests can retry; document mappings''','''`PdfSelectionDiff.readPageText()` shares one OCR page read and starts font detection
from those exact text items. The indexed parts and rendered layer consume that same
font task; late metadata updates the index font version and existing highlights.
`indexFonts()` only waits for these page-read tasks; it never fetches or scans pages
again. Font differences are emitted only for unchanged aligned characters.
Failed text requests can retry; document mappings''')
p.write_text(s,encoding='utf-8')
p=Path('replacement-review.md');s=p.read_text(encoding='utf-8')
s=s.replace('- `public/pdfdiff/pdf-selection-diff.js`：定位、映射、字体元数据和统一差异遍历；文字候选、格式候选与高亮共用遍历结果。\n- `public/pdfdiff/local-text-diff.js`：共用文字比较、规范化搜索、编辑校验和 Monaco 编辑事务；替换直接使用已生成的候选编辑。',
'- `public/pdfdiff/pdf-selection-diff.js`：文字比较、规范化搜索、映射、字体元数据、统一差异遍历及编辑事务都在同一个脚本中。读取 OCR 页数据时同步启动字体探测；源码与 PDF 文字完成对齐后才比较样式。文字候选、格式候选与高亮共用遍历结果；替换直接使用已生成的候选编辑。')
p.write_text(s,encoding='utf-8')
