import { readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
const source = await readFile('tests/replacement-review-browser.mjs', 'utf8');
await writeFile('tmp/pdf-popup-baseline-run.mjs', source.replace("    await page.route('**/api/reader/settings'", "    await page.route('**/pdfdiff/pdf-review-provider.js', async route => route.fulfill({ contentType: 'application/javascript', body: await readFile('tmp/pdf-review-provider.before-perf.js', 'utf8') }));\n    await page.route('**/pdfdiff/pdf-selection-diff.js', async route => route.fulfill({ contentType: 'application/javascript', body: await readFile('tmp/pdf-selection-diff.before-perf.js', 'utf8') }));\n    await page.route('**/api/reader/settings'"));
const result = spawnSync(process.execPath, ['tmp/pdf-popup-baseline-run.mjs'], { stdio: 'inherit', windowsHide: true });
process.exitCode = result.status;
