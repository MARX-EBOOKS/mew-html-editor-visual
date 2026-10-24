import fs from 'node:fs';
const path='tests/pdf-review-pattern.test.mjs';let s=fs.readFileSync(path,'utf8').replace('const api = Object.assign(window.PdfReviewProvider, window.PdfSelectionDiff), providers = new Map();','const api = Object.assign(window.PdfReviewProvider, window.PdfSelectionDiff), providers = new Map();\n    const PdfReviewProvider = api;');fs.writeFileSync(path,s);
