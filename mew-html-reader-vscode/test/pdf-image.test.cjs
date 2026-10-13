const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const script = fs.readFileSync(path.join(__dirname, '../reader-pdf.js'), 'utf8');
const source = script.slice(script.indexOf('async function currentImageBlob('), script.indexOf('async function copyCurrentImage('));

function fixture(images) {
  let pixels;
  const canvas = { getContext: () => ({
    createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
    putImageData: value => { pixels = Array.from(value.data); }
  }), toBlob: callback => callback({ width: canvas.width, height: canvas.height, pixels }) };
  const context = vm.createContext({ config: { pdfjs: {
    OPS: { paintImageXObject: 1, paintImageXObjectRepeat: 2, paintInlineImageXObject: 3 },
    ImageKind: { GRAYSCALE_1BPP: 1, RGB_24BPP: 2, RGBA_32BPP: 3 }
  } }, document: { createElement: () => canvas } });
  const extract = vm.runInContext(source + '\ncurrentImageBlob', context);
  const pdf = { getPage: async () => ({ getOperatorList: async () => ({
    fnArray: images.map(() => 3), argsArray: images.map(image => [image])
  }) }) };
  return () => extract(pdf, 1);
}
test('copy chooses largest embedded image and preserves RGB pixels', async () => {
  const result = await fixture([
    { width: 1, height: 1, kind: 2, data: [0, 0, 0] },
    { width: 2, height: 1, kind: 2, data: [255, 0, 0, 0, 127, 255] }
  ])();
  assert.equal(result.width, 2);
  assert.deepEqual(result.pixels, [255, 0, 0, 255, 0, 127, 255, 255]);
});
test('one-bit scan rows preserve byte padding and black/white polarity', async () => {
  const result = await fixture([{ width: 1, height: 2, kind: 1, data: [128, 0] }])();
  assert.deepEqual(result.pixels, [255, 255, 255, 255, 0, 0, 0, 255]);
});
test('page without embedded images reports an error instead of taking a screenshot', async () => {
  await assert.rejects(fixture([]), /本页没有可复制/);
});
