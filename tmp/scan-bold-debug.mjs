import test from 'node:test'; import assert from 'node:assert/strict'; import vm from 'node:vm'; import {readFile} from 'node:fs/promises';
const src = await readFile('public/pdf-selection-diff.js','utf8');
function engine() { const window={}; vm.runInNewContext(src.replace('catch { /* Missing/unsupported scan data leaves the declarations unknown. */ }', 'catch (err) { throw err; }').replace('for (const sample of samples) {','console.log(samples); for (const sample of samples) {'),{window,console}); return window.PdfSelectionDiff; }
test('dominant bold declarations use native scan strokes per text item and abstain without a body baseline', async () => {
  for (const uniform of [false, true]) {
    const api = engine(), width = 600, height = 600, data = new Uint8Array(width * height / 8).fill(255);
    const items = Array.from({ length: 12 }, (_, i) => ({ str: 'abcdefghijklmnopqrst', fontName: i === 11 ? 'regular' : 'bold',
      transform: [24, 0, 0, 24, 50, 550 - i * 40], height: 24, width: 400 }));
    for (const [i, item] of items.entries()) {
      const thickness = uniform || i === 2 ? 5 : 2, top = height - item.transform[5] - 18;
      for (let glyph = 0; glyph < 20; glyph++) for (let y = top; y < top + 18; y++)
        for (let x = 55 + glyph * 18; x < 55 + glyph * 18 + thickness; x++)
          data[y * (width / 8) + (x >> 3)] &= ~(128 >> (x & 7));
    }
    const page = { commonObjs: new Map([['bold', { name: 'Same-Bold', bold: true, italic: false }],
      ['regular', { name: 'Same-Regular', bold: false, italic: false }]]),
      objs: { get: (id, resolve) => resolve({ data, width, height, kind: 1 }) },
      getOperatorList: async () => ({ fnArray: [10, 12, 85, 11, 37, 38, 44],
        argsArray: [[], [600, 0, 0, 600, 0, 0], ['scan'], [], ['bold', 24], [3], []] }),
      getTextContent: async () => ({ items }) };
    const pdf = { numPages: 1, getPage: async () => page };
    const locator = api.createLocator({}, { isCurrent: () => true, waitForIdle: async () => {} });
    const index = await locator.indexFonts(pdf), fonts = await api.readPageFonts(page, items);
    assert.equal(fonts.get('bold').bold, null, 'character-weighted dominant declaration is not trusted');
    assert.equal(index.pages[0].parts[0].font.bold, null, 'baseline text is not guessed regular');
    assert.equal(index.pages[0].parts[11].font.bold, false, 'minority regular metadata survives');
    if (uniform) assert.equal(fonts.has(items[2]), false, 'a uniformly heavy scan cannot establish contrast');
    else {
      assert.equal(fonts.get(items[2]).bold, true, 'same declared font can have a different observed weight');
      assert.equal(index.pages[0].parts[2].font.bold, true);
      assert.match(index.pages[0].parts[2].font.reason, /扫描笔画/);
    }
  }
});

