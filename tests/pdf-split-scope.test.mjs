import assert from 'node:assert/strict';
import test from 'node:test';
import { locator } from './support/pdf-harness.mjs';

test('file comparison uses its bounded PDF cache even when a volume cache is warm', async () => {
  const pdf = { numPages: 2, async getPage(number) { return { async getTextContent() {
    return { items: [{ str: `Independent passage for page ${number} with enough context for a unique source match.`, transform: [1, 0, 0, 1, 0, 100], width: 500, height: 12 }] };
  } }; } };
  const diff = locator({}, { getPdf: () => pdf, getSourcePages: () => [2], isCurrent: () => true, waitForIdle: async () => {} });
  const volume = await diff.indexDocument(pdf);
  const page = await diff.indexDocument(pdf, [2]);
  const empty = await diff.indexDocument(pdf, []);
  assert.notEqual(empty, volume, 'an empty page range must not reuse the whole volume');
  assert.equal(empty.pages.length, 0);
  assert.equal(diff.getDocumentIndex(pdf), volume);
  assert.equal(diff.getDocumentIndex(pdf, []), empty);
  const source = diff.sourceIndex('<p>Independent passage for page 2 with enough context for a unique source match.</p>');
  source.diff([page], pdf);
  assert.equal(source.preparation.full, page, 'page preparation uses only the corresponding file range');
  assert.equal(source.connections.has(volume), false, 'whole-volume mappings cannot enter the file comparison');
});
