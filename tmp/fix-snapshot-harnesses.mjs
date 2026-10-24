import fs from 'node:fs';
for(const name of ['pdf-selection-diff.test.mjs','pdf-review-pattern.test.mjs']) {
 const path='tests/'+name;let s=fs.readFileSync(path,'utf8');
 const a=s.indexOf('const providerSource ='),b=s.indexOf(" + '\\n})();';",a)+" + '\\n})();';".length;
 if(b<20) throw new Error(name);
 const full=name==='pdf-selection-diff.test.mjs'?'reviewFile':'fullReviewSource';
 s=s.slice(0,a)+`const providerSource = highlightSource + '\\n(() => {\\nconst { PdfLocator, PdfSourceIndex, connectionDiff, textDifferences, reviewCandidates } = window.PdfReviewProvider;\\n' + ${full}
  .split('// PDF comparison is one review provider. Selection synchronization remains independent.')[1]
  .replace("window.PdfReviewReady = (async () => {", '(() => {')
  .replace(/  (?:if \\(!window\\.PdfSelectionDiff\\)|await window\\.PdfSelectionDiff\\.loadMonaco|if \\(!window\\.ReplacementReview).*\\r?\\n/g, '') + '\\n})();';`+s.slice(b);
 s=s.replace(/\{ source: (html|fixture\.html), \.\.\.locator\.sourceIndex\(\1\) \}/g,'locator.sourceIndex($1)');
 fs.writeFileSync(path,s);
}
const path='tests/review-highlights.test.mjs';let s=fs.readFileSync(path,'utf8');
s=s.replace(/      const lowerBound = [\s\S]*?      };\r?\n/,'').replaceAll('document, lowerBound','document');
s=s.replace('parts: [{ node, start: 0, end: node.length }]','parts: [{ node, start: 0, end: node.length }], partsInRange() { return this.parts; }');
fs.writeFileSync(path,s);
