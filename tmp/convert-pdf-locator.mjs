import fs from 'node:fs';
import { typescript as ts } from '../node_modules/monaco-editor/esm/vs/language/typescript/lib/typescriptServices.js';
const path = 'public/pdfdiff/pdf-review-provider.js';
const source = fs.readFileSync(path, 'utf8');
fs.writeFileSync('tmp/pdf-locator-before-class.js', source);
const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const factory = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name.text === 'createLocator');
const methods = factory.body.statements.filter(ts.isFunctionDeclaration);
const names = new Set(methods.map(n => n.name.text));
const fields = new Set(['documents', 'sourceIndexes', 'noPdf', 'reviewAnchors', 'document', 'environment', 'options']);
let edits = [];
for (const method of methods) {
  edits.push([method.getStart(ast), method.name.getStart(ast), method.modifiers?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword) ? 'async ' : '']);
  const visit = node => {
    if (ts.isIdentifier(node) && (names.has(node.text) || fields.has(node.text))) {
      const parent = node.parent;
      if (parent === method && parent.name === node) return;
      if (ts.isPropertyAccessExpression(parent) && parent.name === node) return;
      if ((ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent)) && parent.name === node) return;
      if (ts.isShorthandPropertyAssignment(parent)) edits.push([node.getStart(ast), node.end, `${node.text}: this.${node.text}`]);
      else edits.push([node.getStart(ast), node.end, `this.${node.text}`]);
    }
    ts.forEachChild(node, visit);
  };
  visit(method);
}
const header = `class PdfLocator {\n  documents = new WeakMap();\n  sourceIndexes = new WeakMap();\n  reviewAnchors = new WeakMap();\n  noPdf = {};\n\n  constructor(options = {}, environment = {}) {\n    this.options = options;\n    this.environment = environment;\n    this.document = environment.document || window.document;\n  }\n\n  `;
edits.push([factory.getStart(ast), methods[0].getStart(ast), header]);
let result = source;
for (const [a, b, text] of edits.sort((a,b) => b[0]-a[0])) result = result.slice(0,a)+text+result.slice(b);
result = result.replace('fallbackLocator = createLocator(', 'fallbackLocator = new PdfLocator(').replace('    createLocator, connectionDiff,', '    PdfLocator, connectionDiff,');
fs.writeFileSync(path, result);
const selectionPath = 'public/pdfdiff/pdf-selection.js';
let selection = fs.readFileSync(selectionPath, 'utf8').replace('review.createLocator(', 'new review.PdfLocator(').replace('  const { sourceIndex, editorSourceIndex, normalized, lowerBound } = diff;\n', '');
selection = selection.replace(/(?<![\w.])(?:sourceIndex|editorSourceIndex|normalized|lowerBound)(?=\()/g, match => `diff.${match}`);
fs.writeFileSync(selectionPath, selection);
for (const doc of ['pdf-selection.md', 'replacement-review.md']) {
  const text = fs.readFileSync(doc, 'utf8').replaceAll('PdfReviewProvider.createLocator(', 'new PdfReviewProvider.PdfLocator(');
  fs.writeFileSync(doc, text);
}
