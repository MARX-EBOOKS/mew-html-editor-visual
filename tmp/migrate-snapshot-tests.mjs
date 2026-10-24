import fs from 'node:fs';
import {typescript as ts} from '../node_modules/monaco-editor/esm/vs/language/typescript/lib/typescriptServices.js';
const sourced=new Set(['sourcePageScope','anchorMatches','normalizedRange','rememberConnection','connectedRange']);
for(const filename of ['pdf-selection-diff.test.mjs','pdf-selection-highlight.test.mjs','pdf-review-pattern.test.mjs','pdf-cache-browser.mjs','replacement-review-browser.mjs']) {
 const path='tests/'+filename; let source=fs.readFileSync(path,'utf8');
 fs.writeFileSync('tmp/snapshot-before-'+filename,source);
 // Export the snapshot class from isolated mapping harnesses.
 source=source.replaceAll('{ PdfLocator, connectionDiff,','{ PdfLocator, PdfSourceIndex, connectionDiff,').replaceAll('{ PdfLocator: SelectionLocator, connectionDiff,','{ PdfLocator: SelectionLocator, PdfSourceIndex, connectionDiff,');
 // Use complete provider code in browser harnesses.
 if(filename==='pdf-selection-diff.test.mjs') source=source.replace("reviewFile.replace(mappingSection, '')",'reviewFile');
 if(filename==='pdf-selection-highlight.test.mjs') {
  const start=source.indexOf('const providerSource ='),end=source.indexOf('const source =',start);
  source=source.slice(0,start)+"const providerSource = popupSource + '\\n' + fullReviewSource;\n"+source.slice(end);
  source=source.replace('const { locate, matches, rememberConnection, connectedRange, normalized, sourcePageScope, patchedWords } = locator();','const testLocator = locator();\nconst normalized = testLocator.normalized.bind(testLocator);');
 }
 if(filename==='pdf-selection-diff.test.mjs') source=source.replace('  const normalized = mapping.normalized.bind(mapping), rememberConnection = mapping.rememberConnection.bind(mapping), connectedRange = mapping.connectedRange.bind(mapping);','  const normalized = mapping.normalized.bind(mapping);');
 const ast=ts.createSourceFile(path,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
 function render(n) {
  if(ts.isCallExpression(n)) {
   const prop=ts.isPropertyAccessExpression(n.expression),name=prop?n.expression.name.text:ts.isIdentifier(n.expression)?n.expression.text:'';
   const args=[...n.arguments];
   if(sourced.has(name)) {const first=args.shift();return `${render(first)}.${name}(${args.map(render).join(', ')})`;}
   if(['locate','matches'].includes(name)) {
    const raw=args.shift(),owner=prop?render(n.expression.expression):'testLocator';
    const snapshot=`new PdfReviewProvider.PdfSourceIndex(${owner}, { raw: ${render(raw)} })`;
    // Old locate's haystack described a whole input; the snapshot computes it once.
    if(name==='locate'&&args.length>1) args.splice(1,1);
    return `${snapshot}.${name}(${args.map(render).join(', ')})`;
   }
   if(name==='patchedWords') {const entry=args.shift();const e=render(entry);return `${e}.index.patchedWords(${e}.text, ${args.map(render).join(', ')})`;}
  }
  let text=n.getText(ast),base=n.getStart(ast);const children=[];ts.forEachChild(n,c=>{children.push(c);});
  for(const child of children.reverse()) text=text.slice(0,child.getStart(ast)-base)+render(child)+text.slice(child.end-base);
  // Snapshot fixtures should exercise the same methods as production indexes.
  if(ts.isObjectLiteralExpression(n)&&n.properties.some(p=>p.name?.getText(ast)==='raw')&&
    (ts.isVariableDeclaration(n.parent)||ts.isParenthesizedExpression(n.parent)))
    text=`new PdfReviewProvider.PdfSourceIndex(new PdfReviewProvider.PdfLocator(), ${text})`;
  return text;
 }
 source=render(ast);
 // Module-level aliases are also available as browser globals inside page.evaluate.
 if(filename==='pdf-selection-diff.test.mjs') source=source.replace('function reviewProvider(', 'const PdfReviewProvider = engine();\nfunction reviewProvider(');
 if(filename==='pdf-selection-highlight.test.mjs') source=source.replace('const testLocator = locator();','const testLocator = locator();\nconst PdfReviewProvider = { PdfLocator: testLocator.constructor, PdfSourceIndex: testLocator.sourceIndex(\'\').constructor };');
 fs.writeFileSync(path,source);
}
