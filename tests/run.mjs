import { readdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

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
    const timer = setTimeout(() => { child.kill(); }, 300000);
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
  await run('unit', process.execPath, ['--test', ...files.filter(name => name.endsWith('.test.mjs') && !name.endsWith('.browser.test.mjs')).map(name => `tests/${name}`)]);
}
if (mode === 'browser' || mode === 'all') {
  // Serial browser files avoid CPU contention in latency assertions.
  await run('browser contracts', process.execPath, ['--test', '--test-concurrency=1', ...files.filter(name => name.endsWith('.browser.test.mjs')).map(name => `tests/${name}`)]);
  for (const name of files.filter(name => name.endsWith('-browser.mjs'))) {
    await run(name, process.execPath, [`tests/${name}`]);
  }
}
if (mode === 'backend' || mode === 'all') {
  await run('backend', process.env.PYTHON || 'python', ['-B', '-m', 'unittest', 'discover', '-s', 'tests', '-p', 'test_*.py', '-v']);
}
console.table(results);
const report = process.argv.find(arg => arg.startsWith('--report='));
if (report) await writeFile(report.slice('--report='.length), JSON.stringify({ node: process.version, results }, null, 2) + '\n');
process.exitCode = results.some(result => result.exitCode !== 0) ? 1 : 0;
