import fs from 'node:fs';
let path='tests/pdf-selection-highlight.test.mjs',s=fs.readFileSync(path,'utf8');
s=s.replace('  const window = {};\n  vm.runInNewContext(script', '  const window = { document: { createElement: () => ({}) } };\n  vm.runInNewContext(script');
s=s.replaceAll('const index = raw => (new PdfReviewProvider.PdfSourceIndex(countedLocator, { raw, normalized: normalized(raw), connections: new WeakMap(), pageScopes: new WeakMap() }));','const index = raw => countedLocator.sourceIndex(raw);');
s=s.replace("{ raw: html, connections: new WeakMap() }.rememberConnection(0, html.length, { raw: pdf },", "new PdfReviewProvider.PdfSourceIndex(testLocator, { raw: html }).rememberConnection(0, html.length, new PdfReviewProvider.PdfSourceIndex(testLocator, { raw: pdf }),");
fs.writeFileSync(path,s);
path='tests/pdf-selection-diff.test.mjs';s=fs.readFileSync(path,'utf8');
s=s.replace("'      connection ||= (source.connections.get(target)'", "'    connection ||= (this.connections.get(target)'").replace("'      window.mappingCalls = (window.mappingCalls || 0) + 1; connection ||= (source.connections.get(target)'", "'    window.mappingCalls = (window.mappingCalls || 0) + 1; connection ||= (this.connections.get(target)'");
s=s.replace("  .split('// PDF comparison is one review provider. Selection synchronization remains independent.')[1]\n", "  .split('// PDF comparison is one review provider. Selection synchronization remains independent.')[1]\n  .replace('    PdfLocator, PdfSourceIndex, connectionDiff,', '    PdfLocator, PdfSourceIndex, sourceDecorations, connectionDiff,')\n");
s=s.replaceAll("'  function sourceDecorations('","'function sourceDecorations('").replaceAll("'  function onSources('","'function onSources('");
// Verify the source stays attached to the snapshot that owns its coordinates.
s=s.replace('  const before = locator.editorSourceIndex(model);','  const before = locator.editorSourceIndex(model);\n  assert.ok(before instanceof api.PdfSourceIndex);\n  assert.equal(before.source, source);');
s=s.replace('  assert.notEqual(after, before);\n  assert.equal(after.connections', '  assert.notEqual(after, before);\n  assert.equal(after.source, source);\n  assert.notEqual(before.source, after.source);\n  assert.equal(after.raw, before.raw);\n  assert.equal(after.connections');
fs.writeFileSync(path,s);
