import fs from 'node:fs';
import {typescript as ts} from '../node_modules/monaco-editor/esm/vs/language/typescript/lib/typescriptServices.js';
for (const name of fs.readdirSync('tests').filter(n=>/\.(mjs|js)$/.test(n))) {
  const path='tests/'+name;
  let source=fs.readFileSync(path,'utf8');
  if (!source.includes('createLocator')) continue;
  const ast=ts.createSourceFile(path,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS), edits=[];
  function visit(node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text==='createLocator') {
      const owner=node.expression.expression.getText(ast);
      edits.push([node.expression.getStart(ast),node.expression.end,`new (${owner}.PdfLocator)`]);
    }
    if (ts.isBinaryExpression(node) && ts.isPropertyAccessExpression(node.left) && node.left.name.text==='createLocator' && ts.isArrowFunction(node.right)) {
      edits.push([node.left.name.getStart(ast),node.left.name.end,'PdfLocator']);
      edits.push([node.right.getStart(ast),node.right.end,`class { constructor() { return ${node.right.body.getText(ast)}; } }`]);
    }
    ts.forEachChild(node,visit);
  }
  visit(ast);
  for (const [a,b,text] of edits.sort((a,b)=>b[0]-a[0])) source=source.slice(0,a)+text+source.slice(b);
  source=source.replaceAll('  // Source/PDF mapping and candidate generation.','// Source/PDF mapping and candidate generation.').replaceAll('  // Shared popup and session initialization.','// Shared popup and session initialization.');
  source=source.replaceAll("typeof PdfReviewProvider.createLocator", "typeof PdfReviewProvider.PdfLocator").replaceAll("'createLocator' in PdfSelectionDiff", "'PdfLocator' in PdfSelectionDiff");
  if (name==='pdf-selection-diff.test.mjs' || name==='pdf-selection-highlight.test.mjs') {
    const a=source.indexOf('const mappingSource ='), b=source.indexOf('const ',source.indexOf("+ selectionMapping);",a)+20);
    const end=source.indexOf("+ selectionMapping);",a)+"+ selectionMapping);".length;
    if (end<20) throw new Error('harness not found '+name);
    const mapping=name==='pdf-selection-diff.test.mjs'?'mappingSection':"fullReviewSource.split('// Source/PDF mapping and candidate generation.')[1].split('// Shared popup and session initialization.')[0]";
    source=source.slice(0,a)+`const mappingSource = '(() => {\\nconst toolbox = window.PdfSelectionDiff;\\n' + ${mapping} + '\\nwindow.PdfReviewProvider = { PdfLocator, connectionDiff, textDifferences, reviewCandidates };\\n})();';
// Attach the private selection helpers while retaining the production locator class.
const selectionMappingSource = mappingSource.replace('window.PdfReviewProvider =', \`class SelectionLocator extends PdfLocator {
  constructor(options = {}, environment = {}) {
    super(options, environment);
    const diff = this;
    \${selectionMapping}
    Object.assign(this, { findLocations, locateSource, locateLayer });
  }
}
window.PdfReviewProvider =\`).replace('{ PdfLocator, connectionDiff,', '{ PdfLocator: SelectionLocator, connectionDiff,');`+source.slice(end);
    // Class methods need their receiver when tests use them as standalone helpers.
    source=source.replace('const { normalized, rememberConnection, connectedRange } = new (api.PdfLocator)();', 'const mapping = new (api.PdfLocator)();\n  const normalized = mapping.normalized.bind(mapping), rememberConnection = mapping.rememberConnection.bind(mapping), connectedRange = mapping.connectedRange.bind(mapping);');
  } else if (name==='pdf-review-pattern.test.mjs') {
    source=source.replace("const mappingSource = '(() => {\\n'", "const mappingSource = '(() => {\\nconst toolbox = window.PdfSelectionDiff;\\n'").replace("+ '\\n})();';", "+ '\\nwindow.PdfReviewProvider = { PdfLocator, connectionDiff, textDifferences, reviewCandidates };\\n})();';");
  }
  fs.writeFileSync(path,source);
}
