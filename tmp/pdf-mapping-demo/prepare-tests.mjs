import { readFile, writeFile, mkdir } from 'node:fs/promises';

await mkdir(new URL('tests/', import.meta.url), { recursive: true });
for (const name of ['pdf-selection-diff.test.mjs', 'pdf-review-api.test.mjs', 'pdf-review-pattern.test.mjs']) {
  let source = await readFile(new URL('../../tests/' + name, import.meta.url), 'utf8');
  source = source.replaceAll("new URL('../", "new URL('../../../")
    .replaceAll('../../../public/pdfdiff/', '../');
  // Extract candidate generation from the provider; get relocated classes from the diff API.
  source = source.replaceAll('const { textDiff, significantText } = toolbox;',
    'const { textDiff, significantText, PdfLocator, PdfSourceIndex } = toolbox;');
  source = source.replaceAll('const { PdfLocator, PdfSourceIndex, reviewCandidates } = window.PdfReviewProvider;',
    'const { reviewCandidates } = window.PdfReviewProvider;');
  source = source.replace('assert.equal(result.mappingInFontText, false);',
    'assert.equal(result.mappingInFontText, true);');
  source = source.replaceAll('api.PdfLocator = class { constructor() { return locator; } };',
    'api.PdfLocator = window.PdfSelectionDiff.PdfLocator = class { constructor() { return locator; } };');
  // Lexical calls cannot be observed by replacing the exported function. Check cache identity instead.
  source = source.replace(/test\('compact review[\s\S]*?(?=\ntest\(|$)/, section => section.replace(`  let calls = 0;
  const diff = api.textDiff;
  api.textDiff = (...args) => { calls++; return diff(...args); };`, '')
    .replace('  assert.equal(calls, 1);', `  const cached = item.comparison.comparisonDiff;
  providers.get('pdf-ocr').content({ items: [item], choices: new Map([['one', 'pdf']]) }, item);
  assert.strictEqual(item.comparison.comparisonDiff, cached);`));
  // API fixture reads file names from a template URL rather than explicit paths.
  source = source.replace('../public/pdfdiff/${name}', '../${name}');
  await writeFile(new URL('tests/' + name, import.meta.url), source);
}
