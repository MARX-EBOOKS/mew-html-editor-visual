const fs = require('node:fs');
const cp = require('node:child_process');
for (const name of ['pdf-review-provider.js', 'pdf-selection-diff.js', 'pdf-selection.js', 'replacement-review.js']) {
  const file = `public/pdfdiff/${name}`;
  const diff = cp.execFileSync('git', ['diff', '--no-ext-diff', '--unified=3', 'HEAD~2', 'HEAD', '--', file], { encoding: 'utf8' });
  const sections = diff.split(/(?=^@@ )/m);
  const header = sections.shift();
  const hunks = sections.filter(hunk => {
    if (name === 'pdf-review-provider.js') return !hunk.includes('function sourceDecorations(');
    if (name === 'pdf-selection-diff.js') return !hunk.includes('function* comparisonRanges(') && !hunk.includes('+  textDiff, sourceSegments, insertionSegment, layerFonts');
    return true;
  });
  if (hunks.length) cp.execFileSync('git', ['apply', '--ignore-space-change', '--whitespace=nowarn', '-'], { input: header + hunks.join('') });
  console.log(`${name}: applied ${hunks.length} selected hunks`);
}
