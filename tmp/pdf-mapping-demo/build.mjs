import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';

const root = new URL('../../', import.meta.url);
const demo = new URL('./', import.meta.url);
const read = path => readFile(new URL(path, root), 'utf8');
const originalDiff = await read('public/pdfdiff/pdf-selection-diff.js');
const originalProvider = await read('public/pdfdiff/pdf-review-provider.js');
await mkdir(new URL('baseline/', demo), { recursive: true });
await writeFile(new URL('baseline/pdf-selection-diff.js', demo), originalDiff);
await writeFile(new URL('baseline/pdf-review-provider.js', demo), originalProvider);

let classes = originalProvider.slice(originalProvider.indexOf('class PdfSourceIndex {'),
  originalProvider.indexOf('// Shared popup and session initialization.'));
// Mapping and comparison now share lexical functions rather than a mutable toolbox.
classes = classes.replaceAll('toolbox.', '');

const oldTransfer = `        const retained = (previous.connections.get(target) || []).flatMap(item => {
          const delta = shift(item);
          return delta === null ? [] : [{ ...item, start: item.start + delta, end: item.end + delta }];
        });
        if (retained.length) index.connections.set(target, retained);
        const reverse = (target.connections?.get(previous) || []).flatMap(item => {
          const delta = shift({ start: item.targetStart, end: item.targetEnd });
          return delta === null ? [] : [{ ...item, targetStart: item.targetStart + delta, targetEnd: item.targetEnd + delta }];
        });
        if (reverse.length) target.connections.set(index, reverse);`;
const newTransfer = `        const retained = (previous.connections.get(target) || []).flatMap(item => shift(item));
        if (retained.length) index.connections.set(target, retained);
        const reverse = (target.connections?.get(previous) || []).flatMap(item => shift(item, 'targetStart', 'targetEnd'));
        if (reverse.length) target.connections.set(index, reverse);`;
// Normalize CRLF before applying structural changes; retain all comments and blank lines.
classes = classes.replaceAll('\r\n', '\n');
if (!classes.includes(oldTransfer)) throw new Error('Connection transfer source changed');
classes = classes.replace(oldTransfer, newTransfer);
classes = classes.replace('      const shift = range => range && (range.end <= start ? 0 : range.start >= oldEnd ? newEnd - oldEnd : null);',
`      const shift = (item, a = 'start', b = 'end') => {
        const delta = item[b] <= start ? 0 : item[a] >= oldEnd ? newEnd - oldEnd : null;
        return delta === null ? [] : [{ ...item, [a]: item[a] + delta, [b]: item[b] + delta }];
      };`);
classes = classes.replace(`        const cached = previous.pageScopes.get(target), delta = shift(cached?.scope);
        if (cached?.scope && delta !== null) index.pageScopes.set(target, {
          ...cached, scope: { ...cached.scope, start: cached.scope.start + delta, end: cached.scope.end + delta }
        });`,
`        const cached = previous.pageScopes.get(target), scope = cached?.scope && shift(cached.scope)[0];
        if (scope) index.pageScopes.set(target, { ...cached, scope });`);

// Resolve both cancellation and failures in the shared task, once for every caller.
classes = classes.replace('    cached.task = (async () => {', '    return cached.task = (async () => {');
classes = classes.replace(`    })().catch(error => {
      this.documents.delete(pdf);
      throw error;
    });
    const index = await cached.task;
    if (!index) this.documents.delete(pdf);
    return index;`,
`    })().then(index => {
      if (!index) this.documents.delete(pdf);
      return index;
    }, error => {
      this.documents.delete(pdf);
      throw error;
    });`);

let diff = originalDiff.replaceAll('\r\n', '\n');
diff = diff.replace('window.PdfSelectionDiff = {', classes + 'window.PdfSelectionDiff = {\n  PdfLocator, PdfSourceIndex,');
let provider = originalProvider.slice(0, originalProvider.indexOf('class PdfSourceIndex {'))
  + originalProvider.slice(originalProvider.indexOf('// Shared popup and session initialization.'));
provider = provider.replace('let host, toolbox, textDiff, significantText, formatDifferences, fallbackLocator, highlights;',
  'let host, toolbox, textDiff, significantText, formatDifferences, PdfLocator, PdfSourceIndex, fallbackLocator, highlights;');
provider = provider.replace('({ textDiff, significantText, formatDifferences } = toolbox);',
  '({ textDiff, significantText, formatDifferences, PdfLocator, PdfSourceIndex } = toolbox);');
await writeFile(new URL('pdf-selection-diff.js', demo), diff);
await writeFile(new URL('pdf-review-provider.js', demo), provider);
for (const name of ['pdf-selection.js', 'replacement-review.js'])
  await copyFile(new URL('public/pdfdiff/' + name, root), new URL(name, demo));
console.log('Demo created; production files were not written.');
