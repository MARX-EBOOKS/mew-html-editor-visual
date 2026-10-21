from pathlib import Path
p=Path('tests/pdf-selection-diff.test.mjs');s=p.read_text(encoding='utf-8')
s+=r'''

test('passage pruning matches pairwise containment and ignores cache recency order', () => {
  const locator = engine().createLocator({}, { document: { createElement: () => ({}) } });
  let seed = 23;
  const random = max => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % max; };
  for (let round = 0; round < 80; round++) {
    const index = locator.sourceIndex('a'.repeat(500)), pdf = {};
    const pages = Array.from({ length: 8 }, () => locator.sourceIndex('Page'));
    for (const page of pages) {
      index.pageScopes.set(page, { prepared: true, scope: null });
      index.connections.set(page, Array.from({ length: 20 }, () => {
        const start = random(400); return { start, end: start + random(100) + 1 };
      }));
    }
    const all = pages.flatMap(page => index.connections.get(page).map(item => ({ page, item })));
    const expected = pages.map(page => index.connections.get(page).filter(item => !all.some(other => other.page !== page
      && other.item.start <= item.start && other.item.end >= item.end
      && other.item.end - other.item.start > item.end - item.start)));
    locator.prepareSource(index, pages, pdf);
    pages.forEach((page, i) => assert.deepEqual(index.connections.get(page), expected[i]));
    const preparation = index.preparation;
    locator.prepareSource(index, [...pages].reverse(), pdf);
    assert.equal(index.preparation, preparation, 'LRU recency changes do not invalidate prepared mappings');
  }
});
''';p.write_text(s,encoding='utf-8')
