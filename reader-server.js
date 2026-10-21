// Compatibility entry point: the reader HTTP backend now lives in Python.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const child = spawn(process.env.PYTHON || 'python', [
  fileURLToPath(new URL('./reader-server.py', import.meta.url)), ...process.argv.slice(2)
], { stdio: ['pipe', 'inherit', 'inherit'], windowsHide: true,
  env: { ...process.env, MEW_READER_LAUNCHER: '1' } });
child.on('error', error => {
  console.error(`Cannot start Python reader backend: ${error.message}`);
  process.exitCode = 1;
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('exit', code => { process.exitCode = code ?? 1; });
