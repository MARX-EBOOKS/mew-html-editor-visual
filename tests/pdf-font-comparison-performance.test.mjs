import assert from 'node:assert/strict';
import test from 'node:test';
import { engine } from './support/pdf-harness.mjs';

test('unknown PDF styles do not scan HTML formats while text differences remain visible', () => {
  const api = engine(), locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
  const source = locator.sourceIndex('<p><b>Wrong word</b></p>');
  const target = new api.PdfSourceIndex(locator, { raw: 'Right word', parts: [
    { start: 0, end: 10, font: { italic: null, bold: null } }
  ] });
  const connection = source.rememberConnection(0, source.raw.length, target, { start: 0, end: target.raw.length });
  let reads = 0;
  source.formats = new Proxy(source.formats, { get(values, key) {
    if (/^\d+$/.test(String(key))) reads++;
    return Reflect.get(values, key);
  } });
  const model = { getPositionAt: offset => ({ lineNumber: 1, column: offset + 1 }) };
  const marks = source.sourceDecorations([[connection, target]], model);
  assert.ok(marks.some(mark => mark.options.description === 'PDF OCR text difference'));
  assert.equal(reads, 0, 'unknown PDF styles cannot establish a format mismatch');
  target.parts[0].font.bold = false;
  assert.ok(source.formatDifferences([[connection, target]]).length);
  assert.ok(reads > 0, 'known styles still compare against HTML formatting');
});
