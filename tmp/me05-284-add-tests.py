from pathlib import Path
p=Path('tests/pdf-selection-diff.test.mjs');s=p.read_text(encoding='utf-8');at=s.index("test('ME05-281")
s=s[:at]+'''test('ME05-284 wrapped words and dash variants do not create text highlights', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/pdf-selection-me05-284.json', import.meta.url), 'utf8'));
  for (const source of [fixture.source, fixture.source.replace(/\\r\\n/g, '\\n')]) {
    const api = engine(), locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
    const target = new api.PdfSourceIndex(locator, { raw: fixture.pdf,
      pages: [{ start: 0, end: fixture.pdf.length }] });
    locator.getDocumentIndex = () => target;
    const pdf = {}, index = locator.sourceIndex(source);
    locator.prepareSource(index, [target], pdf);
    const candidates = index.reviewCandidates([target]);
    assert.ok(candidates.length, 'real OCR errors remain reviewable');
    for (const item of candidates) {
      assert.ok(!/Wo|ist|dem|–/.test(item.comparison.html + item.comparison.pdf),
        JSON.stringify(item.comparison));
    }
    const corrected = api.previewEdits(source, candidates.flatMap(item => item.options[0].edits));
    const model = { getValue: () => corrected, getVersionId: () => 2,
      getPositionAt: offset => ({ lineNumber: 1, column: offset + 1 }) };
    const revised = locator.editorSourceIndex(model, [target]);
    locator.prepareSource(revised, [target], pdf);
    assert.equal(revised.reviewCandidates([target]).length, 0, 'replaced text stays corrected after remapping');
    assert.equal(revised.sourceDecorations(revised.connectionPairs([target]), model).length, 0);
  }
});

test('ME05-284 a real missing letter disappears from review after replacement', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/pdf-selection-me05-284.json', import.meta.url), 'utf8'));
  const api = engine(), locator = new api.PdfLocator({}, { document: { createElement: () => ({}) } });
  const target = new api.PdfSourceIndex(locator, { raw: fixture.pdf });
  locator.getDocumentIndex = () => target;
  let source = fixture.source.replace('Kölnischen Zeitung', 'Kölnische Zeitung'), version = 1;
  const model = { getValue: () => source, getVersionId: () => version };
  const pdf = {}, index = locator.editorSourceIndex(model, [target]);
  locator.prepareSource(index, [target], pdf);
  const missing = index.reviewCandidates([target]).find(item => item.comparison.pdf === 'n');
  assert.ok(missing, 'a real missing letter must still be detected');
  source = api.previewEdits(source, missing.options[0].edits); version++;
  assert.ok(source.includes('Kölnischen Zeitung'));
  const revised = locator.editorSourceIndex(model, [target]);
  locator.prepareSource(revised, [target], pdf);
  assert.equal(revised.reviewCandidates([target]).some(item => item.comparison.pdf === 'n'), false);
});

'''+s[at:];p.write_text(s,encoding='utf-8')
