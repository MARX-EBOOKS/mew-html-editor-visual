import fs from 'node:fs';
const path = 'public/pdfdiff/pdf-selection.js';
fs.writeFileSync(path, fs.readFileSync(path, 'utf8').replace(/  const \{ sourceIndex, editorSourceIndex, normalized, lowerBound \} = diff;\r?\n/, ''));
