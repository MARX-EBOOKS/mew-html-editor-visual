import fs from 'node:fs';
const path='tests/pdf-selection-highlight.test.mjs';let s=fs.readFileSync(path,'utf8');
s=s.replace("const PdfReviewProvider = { PdfLocator: testLocator.constructor, PdfSourceIndex: testLocator.sourceIndex('').constructor };\n",'');
s=s.replace('const { textDiff } = engineWindow.PdfSelectionDiff;', 'const PdfReviewProvider = engineWindow.PdfReviewProvider;\nconst { textDiff } = engineWindow.PdfSelectionDiff;');
s=s.replace("const wholeWords = locator({ wholeWords: true }).matches;", "const wholeWords = (raw, queries) => new PdfReviewProvider.PdfSourceIndex(locator({ wholeWords: true }), { raw }).matches(queries);");
s=s.replaceAll('const countedScope = locator(', 'const countedLocator = locator(').replaceAll(' }).sourcePageScope;', ' });');
s=s.replaceAll('const index = raw => (new PdfReviewProvider.PdfSourceIndex(new PdfReviewProvider.PdfLocator(),', 'const index = raw => (new PdfReviewProvider.PdfSourceIndex(countedLocator,');
s=s.replace(/countedScope\((html|revised|changed), pdf, true\)/g,'$1.sourcePageScope(pdf, true)').replace("countedScope(index(html.raw + ' More edits.'), pdf, true)","index(html.raw + ' More edits.').sourcePageScope(pdf, true)").replace('countedScope(html, index(pdf.raw), true)','html.sourcePageScope(index(pdf.raw), true)');
s=s.replaceAll("'  function textDiff(left, right, details = false, limit = Infinity) {", "'function textDiff(left, right, details = false, limit = Infinity) {");
s=s.replace("'      let scope = locate(', '      countSearch(); let scope = locate('","'    let scope = this.locate(', '    countSearch(); let scope = this.locate('");
const a=s.indexOf('const countedEngineSource ='),b=s.indexOf('function locator(',a);
s=s.slice(0,a)+`const countedEngineSource = engineSource.replace('const toolbox = window.PdfSelectionDiff;',
  'const originalTextDiff = window.PdfSelectionDiff.textDiff; window.PdfSelectionDiff.textDiff = (...args) => { window.diffCalls = (window.diffCalls || 0) + 1; return originalTextDiff(...args); }; const toolbox = window.PdfSelectionDiff;');
`+s.slice(b);
fs.writeFileSync(path,s);
