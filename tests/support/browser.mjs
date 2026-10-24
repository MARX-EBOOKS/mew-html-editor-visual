import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../../', import.meta.url));

export async function launchBrowser() {
  const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
  const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  const executablePath = process.env.EDGE_PATH || (existsSync(edge) ? edge : undefined);
  return chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
}

export async function stopServer(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill();
  await exited;
}

export async function startServer(script, port, args = []) {
  const child = spawn(process.execPath, [script, '-p', String(port), ...args], {
    cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '', failure;
  child.on('error', error => { failure = error; });
  child.stdout.on('data', data => { output = (output + data).slice(-8000); });
  child.stderr.on('data', data => { output = (output + data).slice(-8000); });
  try {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      if (failure) throw failure;
      if (child.exitCode !== null) throw new Error(`Server exited (${child.exitCode}): ${output}`);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(500) });
        await response.body?.cancel();
        if (response.ok) return child;
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`Server startup timed out: ${output}`);
  } catch (error) {
    await stopServer(child);
    throw error;
  }
}
