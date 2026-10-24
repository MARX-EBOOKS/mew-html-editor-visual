import { readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';

const document = new URL('./tests-clean-before/document-browser.mjs', import.meta.url);
await writeFile(document, (await readFile(document, 'utf8')).replace("new URL('..', import.meta.url)", "new URL('../..', import.meta.url)"));
const results = [];
for (const name of ['document', 'editor-input', 'html-pattern-review', 'layout', 'monaco', 'pdf-cache', 'pdf-review-popup', 'replacement-review']) {
  const started = performance.now();
  const code = await new Promise(resolve => {
    const child = spawn(process.execPath, [`tmp/tests-clean-before/${name}-browser.mjs`], { windowsHide: true, stdio: 'inherit' });
    child.on('error', error => { console.error(error); resolve(1); });
    child.on('exit', code => resolve(code));
  });
  results.push({ name, code, durationMs: Math.round(performance.now() - started) });
}
console.table(results);
await writeFile('tmp/tests-clean-baseline-browser.json', JSON.stringify(results, null, 2));
