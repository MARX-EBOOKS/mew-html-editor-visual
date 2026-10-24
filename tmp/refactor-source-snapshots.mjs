import fs from 'node:fs';
import {typescript as ts} from '../node_modules/monaco-editor/esm/vs/language/typescript/lib/typescriptServices.js';
const path='public/pdfdiff/pdf-review-provider.js';
let source=fs.readFileSync(path,'utf8');
for(const name of ['pdf-review-provider.js','pdf-selection.js','replacement-review.js']) fs.writeFileSync('tmp/snapshot-before-'+name,fs.readFileSync('public/pdfdiff/'+name,'utf8'));
const ast=ts.createSourceFile(path,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
const klass=ast.statements.find(n=>ts.isClassDeclaration(n)&&n.name.text==='PdfLocator');
const bindings={sourcePageScope:'index',anchorMatches:'index',normalizedRange:'index',rememberConnection:'source',connectedRange:'source'};
const moving=new Set([...Object.keys(bindings),'matches','locate','patchedWords']);
const methods=[];const removals=[];
for(const method of klass.members.filter(n=>ts.isMethodDeclaration(n)&&moving.has(n.name.text))) {
 const name=method.name.text; let text=method.getText(ast); const edits=[];
 const binding=bindings[name];
 if(binding) {
  const param=method.parameters[0], next=method.parameters[1];
  edits.push([param.getStart(ast),next.getStart(ast),'']);
 }
 function visit(n) {
  if(binding&&ts.isIdentifier(n)&&n.text===binding&&n!==method.parameters[0].name) {
   const p=n.parent;
   if(ts.isPropertyAccessExpression(p)&&p.name===n) return;
   if(ts.isPropertyAssignment(p)&&p.name===n) return;
   if(ts.isShorthandPropertyAssignment(p)) edits.push([n.getStart(ast),n.end,`${binding}: this`]);
   else edits.push([n.getStart(ast),n.end,'this']);
  }
  ts.forEachChild(n,visit);
 }
 visit(method.body);
 const base=method.getStart(ast);
 for(const [a,b,t] of edits.sort((a,b)=>b[0]-a[0])) text=text.slice(0,a-base)+t+text.slice(b-base);
 text=text.replace(/this\.(normalized|lowerBound|approximateMatches)\(/g,'this.locator.$1(').replaceAll('this.options','this.locator.options');
 if(name==='matches') text=text.replace('matches(raw, queries, haystack = this.locator.normalized(raw))','matches(queries, haystack = this.normalized)');
 if(name==='locate') {
  text=text.replace('locate(raw, entry, haystack = this.locator.normalized(raw), fuzzyOnly = false) {',`locate(entry, scope = null, fuzzyOnly = false) {\n    const offset = scope?.start || 0, haystack = scope?.normalized || this.normalizedRange(offset, scope?.end ?? this.raw.length);`);
  text=text.replace('this.matches(raw, [entry.text], haystack)','this.matches([entry.text], haystack)').replace('this.locate(raw, entry, haystack, true)','this.locate(entry, scope, true)').replace('return tied ? null : best;', 'return tied ? null : { ...best, start: best.start + offset, end: best.end + offset };');
 }
 if(name==='patchedWords') text=text.replace('patchedWords(entry, target)','patchedWords(text, target)').replace('entry.index?.connections','this.connections').replace('const text = this.locator.normalized(entry.text)', 'const patched = this.locator.normalized(text)').replace("return [...new Set(text.match", "return [...new Set(patched.match");
 methods.push('  '+text);
 removals.push([method.getFullStart(),method.end,'']);
}
for(const [a,b,t] of removals.sort((a,b)=>b[0]-a[0])) source=source.slice(0,a)+t+source.slice(b);
const snapshot=`class PdfSourceIndex {\n  source;\n  raw;\n  connections = new WeakMap();\n  pageScopes = new WeakMap();\n\n  constructor(locator, values) {\n    this.locator = locator;\n    Object.assign(this, values);\n    this.normalized ||= locator.normalized(this.raw);\n  }\n\n  rawRange(start, end) {\n    return { start: this.locator.lowerBound(this.ends, start + 1), end: this.locator.lowerBound(this.starts, end) };\n  }\n\n  partsInRange(start, end) {\n    const first = Math.min(this.parts.length - 1, this.locator.lowerBound(this.parts, start + 1, part => part.end));\n    const last = start === end ? first : this.locator.lowerBound(this.parts, end, part => part.end);\n    return this.parts.slice(first, last + 1);\n  }\n\n${methods.join('\n')}\n}\n`;
source=source.replace('class PdfLocator {',snapshot+'class PdfLocator {');
source=source.replace('const template = this.document.createElement("template"), starts = [], ends = [], formats = [];','const template = this.template ||= this.document.createElement("template");\n    const starts = [], ends = [], formats = [];');
source=source.replace('return { source, raw, starts, ends, formats, normalized: this.normalized(raw), pageScopes: new WeakMap(), connections: new WeakMap() };','return new PdfSourceIndex(this, { source, raw, starts, ends, formats });');
source=source.replace('const index = { version, ...this.sourceIndex(source) };','const index = Object.assign(this.sourceIndex(source), { version });');
source=source.replace('cached.index = { raw, pages, normalized: mapped, connections: new WeakMap(), pageScopes: new WeakMap() };','cached.index = new PdfSourceIndex(this, { raw, pages, normalized: mapped });');
source=source.replace('    PdfLocator, connectionDiff,','    PdfLocator, PdfSourceIndex, connectionDiff,');
source=source.replace('    document, lowerBound: fallbackLocator.lowerBound,','    document,');
fs.writeFileSync(path,source);
// Rewrite calls with an explicit source argument as methods of that snapshot.
for(const name of ['pdf-review-provider.js','pdf-selection.js']) {
 const path='public/pdfdiff/'+name; let code=fs.readFileSync(path,'utf8');
 const file=ts.createSourceFile(path,code,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
 const edits=[];
 const sourced=new Set(Object.keys(bindings));
 function render(n) {
  if(ts.isCallExpression(n)&&ts.isPropertyAccessExpression(n.expression)&&sourced.has(n.expression.name.text)) {
   const args=[...n.arguments]; const first=args.shift();
   return `${render(first)}.${n.expression.name.text}(${args.map(render).join(', ')})`;
  }
  const children=[];ts.forEachChild(n,c=>{children.push(c);});
  let text=n.getText(file),base=n.getStart(file);
  for(const c of children.reverse()) text=text.slice(0,c.getStart(file)-base)+render(c)+text.slice(c.end-base);
  return text;
 }
 // Transform only calls to the old service methods, not new snapshot calls already in moved method text.
 function visit(n) {
  if(ts.isCallExpression(n)&&ts.isPropertyAccessExpression(n.expression)&&sourced.has(n.expression.name.text)) {
   edits.push([n.getStart(file),n.end,render(n)]);return;
  }
  ts.forEachChild(n,visit);
 }
 visit(file);
 for(const [a,b,t] of edits.sort((a,b)=>b[0]-a[0])) code=code.slice(0,a)+t+code.slice(b);
 fs.writeFileSync(path,code);
}
