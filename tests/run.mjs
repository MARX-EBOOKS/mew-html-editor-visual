import { readdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { stopServer } from './support/browser.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const files = (await readdir(new URL('./', import.meta.url))).sort();
const mode = process.argv[2] || 'unit';
if (!['unit', 'browser', 'backend', 'all'].includes(mode)) {
  throw new Error('Usage: node tests/run.mjs [unit|browser|backend|all] [--report=path.json]');
}
const results = [];
async function run(name, command, args) {
  const start = performance.now();
  const result = await new Promise(resolve => {
    const child = spawn(command, args, { cwd: root, windowsHide: true, stdio: 'inherit' });
    const timer = setTimeout(() => { void stopServer(child); }, 60000);
    child.once('error', error => {
      clearTimeout(timer);
      console.error(error.message);
      resolve({ exitCode: 1, error: error.message });
    });
    child.once('exit', (exitCode, signal) => {
      clearTimeout(timer);
      resolve({ exitCode: exitCode ?? 1, ...(signal ? { signal } : {}) });
    });
  });
  results.push({ name, ...result, durationMs: Math.round(performance.now() - start) });
}
if (mode === 'unit' || mode === 'all') {
  for (const name of files.filter(name => name.endsWith('.test.mjs') && !name.endsWith('.browser.test.mjs'))) {
    await run(name, process.execPath, ['--max-old-space-size=512', '--test', '--test-concurrency=1', `tests/${name}`]);
    if (results.at(-1).exitCode !== 0) break;
  }
}
if ((mode === 'browser' || mode === 'all') && results.every(result => result.exitCode === 0)) {
  // Serial browser files avoid CPU contention in latency assertions.
  for (const name of files.filter(name => name.endsWith('.browser.test.mjs'))) {
    await run(name, process.execPath, ['--max-old-space-size=512', '--test', '--test-concurrency=1', `tests/${name}`]);
    if (results.at(-1).exitCode !== 0) break;
  }
  for (const name of files.filter(name => name.endsWith('-browser.mjs'))) {
    if (results.at(-1)?.exitCode) break;
    await run(name, process.execPath, ['--max-old-space-size=512', `tests/${name}`]);
  }
}
if ((mode === 'backend' || mode === 'all') && results.every(result => result.exitCode === 0)) {
  await run('backend', process.env.PYTHON || 'python', ['-B', '-m', 'unittest', 'discover', '-s', 'tests', '-p', 'test_*.py', '-v']);
}
console.table(results);
const report = process.argv.find(arg => arg.startsWith('--report='));
if (report) await writeFile(report.slice('--report='.length), JSON.stringify({ node: process.version, results }, null, 2) + '\n');
process.exitCode = results.some(result => result.exitCode !== 0) ? 1 : 0;
