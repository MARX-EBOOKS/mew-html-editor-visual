import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../public/git-platform.js', import.meta.url), 'utf8');

function fakeIndexedDb() {
  const records = new Map();
  return {
    open() {
      const request = {};
      queueMicrotask(() => {
        const db = {
          createObjectStore() {},
          close() {},
          transaction() {
            const transaction = {
              objectStore() {
                const operation = (result, change) => {
                  const request = {};
                  queueMicrotask(() => {
                    change?.();
                    request.result = typeof result === 'function' ? result() : result;
                    request.onsuccess?.();
                    queueMicrotask(() => transaction.oncomplete?.());
                  });
                  return request;
                };
                return {
                  get: id => operation(() => records.get(id)),
                  put: value => operation(value.id, () => records.set(value.id, structuredClone(value))),
                  delete: id => operation(undefined, () => records.delete(id)),
                  getAll: () => operation(() => [...records.values()].map(value => structuredClone(value)))
                };
              }
            };
            return transaction;
          }
        };
        request.result = db;
        request.onupgradeneeded?.();
        request.onsuccess?.();
      });
      return request;
    }
  };
}

function jsonResponse(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });
}

function loadBackend(config, routes) {
  const storage = new Map([
    ['mew.git.config', JSON.stringify(config)],
    ['mew.git.token', 'test-token']
  ]);
  const requests = [];
  const opened = [];
  const button = { disabled: false, textContent: '' };
  const context = {
    URL, URLSearchParams, TextEncoder, TextDecoder, Response, Headers, Blob,
    atob, btoa, structuredClone, queueMicrotask, setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1,
    crypto: { randomUUID: () => '12345678-1234-1234-1234-123456789abc' },
    console,
    location: { href: 'https://editor.example/public/index.html?git=1', search: '?git=1', replace() { throw new Error('unexpected redirect'); } },
    sessionStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    indexedDB: fakeIndexedDb(),
    document: { hidden: false, title: '', getElementById: () => button, addEventListener() {} },
    prompt: message => message.includes('标题') ? 'Update document' : 'Edited in visual editor.',
    alert() {},
    fetch: async (url, options = {}) => {
      const parsed = new URL(url);
      const entry = { method: options.method || 'GET', path: parsed.pathname + parsed.search, body: options.body ? JSON.parse(options.body) : undefined, headers: options.headers };
      requests.push(entry);
      const response = await routes(entry);
      if (!response) throw new Error(`Unexpected request: ${entry.method} ${entry.path}`);
      return response;
    }
  };
  context.window = context;
  context.window.addEventListener = () => {};
  context.window.open = url => opened.push(url);
  vm.runInNewContext(source, context, { filename: 'git-platform.js' });
  return { backend: context.MEWBackend, requests, opened };
}

test('GitHub stages locally, then creates one commit and a pull request', async () => {
  const encoded = btoa('old');
  const { backend, requests, opened } = loadBackend({ provider: 'github', repository: 'owner/repo', branch: 'main' }, entry => {
    if (entry.method === 'GET' && entry.path === '/repos/owner/repo/contents/doc.html?ref=main') return jsonResponse({ type: 'file', content: encoded, sha: 'blob-old' });
    if (entry.method === 'GET' && entry.path === '/repos/owner/repo/git/ref/heads/main') return jsonResponse({ object: { sha: 'base-sha' } });
    if (entry.method === 'GET' && entry.path === '/repos/owner/repo/contents/doc.html?ref=base-sha') return jsonResponse({ sha: 'blob-old' });
    if (entry.method === 'GET' && entry.path === '/repos/owner/repo/git/commits/base-sha') return jsonResponse({ tree: { sha: 'tree-old' } });
    if (entry.method === 'GET' && entry.path === '/repos/owner/repo/git/trees/tree-old?recursive=1') return jsonResponse({ truncated: false, tree: [{ path: 'doc.html', mode: '100644' }] });
    if (entry.method === 'GET' && entry.path === '/repos/owner/repo') return jsonResponse({ full_name: 'owner/repo', name: 'repo', owner: { login: 'owner' }, permissions: { push: true } });
    if (entry.method === 'GET' && entry.path === '/user') return jsonResponse({ login: 'owner' });
    if (entry.method === 'POST' && entry.path === '/repos/owner/repo/git/blobs') return jsonResponse({ sha: 'blob-new' }, 201);
    if (entry.method === 'POST' && entry.path === '/repos/owner/repo/git/trees') return jsonResponse({ sha: 'tree-new' }, 201);
    if (entry.method === 'POST' && entry.path === '/repos/owner/repo/git/commits') return jsonResponse({ sha: 'commit-new' }, 201);
    if (entry.method === 'POST' && entry.path === '/repos/owner/repo/git/refs') return jsonResponse({}, 201);
    if (entry.method === 'POST' && entry.path === '/repos/owner/repo/pulls') return jsonResponse({ html_url: 'https://github.example/pr/1' }, 201);
  });

  const file = await backend.api('/api/file?path=doc.html');
  assert.equal(file.text, 'old');
  await backend.api('/api/save', { method: 'POST', body: JSON.stringify({ path: 'doc.html', text: 'new', mtime: file.mtime }) });
  assert.equal(requests.filter(item => item.method === 'POST').length, 0, 'Save must not write to the Git platform');
  await backend.submitChanges();

  const commit = requests.find(item => item.path === '/repos/owner/repo/git/commits' && item.method === 'POST');
  const pull = requests.find(item => item.path === '/repos/owner/repo/pulls' && item.method === 'POST');
  assert.deepEqual(commit.body.parents, ['base-sha']);
  assert.equal(pull.body.base, 'main');
  assert.equal(pull.body.maintainer_can_modify, true);
  assert.match(pull.body.head, /^owner:mew-edit-/);
  assert.deepEqual(opened, ['https://github.example/pr/1']);
});

test('GitLab batches staged files into one commit before creating an MR', async () => {
  const { backend, requests, opened } = loadBackend({ provider: 'gitlab', repository: 'group/project', branch: 'main', apiUrl: 'https://gitlab.example/api/v4' }, entry => {
    if (entry.method === 'GET' && entry.path === '/api/v4/projects/group%2Fproject/repository/files/doc.html?ref=main') return jsonResponse({ content: btoa('old'), last_commit_id: 'file-base' });
    if (entry.method === 'GET' && entry.path === '/api/v4/projects/group%2Fproject/repository/branches/main') return jsonResponse({ commit: { id: 'base-sha' } });
    if (entry.method === 'GET' && entry.path === '/api/v4/projects/group%2Fproject/repository/files/doc.html?ref=base-sha') return jsonResponse({ last_commit_id: 'file-base' });
    if (entry.method === 'GET' && entry.path === '/api/v4/projects/group%2Fproject') return jsonResponse({ id: 7, permissions: { project_access: { access_level: 30 } }, namespace: { id: 9 } });
    if (entry.method === 'GET' && entry.path === '/api/v4/user') return jsonResponse({ id: 2, namespace_id: 9 });
    if (entry.method === 'POST' && entry.path === '/api/v4/projects/7/repository/commits') return jsonResponse({ id: 'commit-new' }, 201);
    if (entry.method === 'POST' && entry.path === '/api/v4/projects/7/merge_requests') return jsonResponse({ web_url: 'https://gitlab.example/mr/1' }, 201);
  });

  const file = await backend.api('/api/file?path=doc.html');
  await backend.api('/api/save', { method: 'POST', body: JSON.stringify({ path: 'doc.html', text: 'new', mtime: file.mtime }) });
  await backend.submitChanges();

  const commit = requests.find(item => item.path === '/api/v4/projects/7/repository/commits');
  const mergeRequest = requests.find(item => item.path === '/api/v4/projects/7/merge_requests');
  assert.equal(commit.body.actions.length, 1);
  assert.deepEqual(commit.body.actions[0], { action: 'update', file_path: 'doc.html', content: 'new', encoding: 'text', last_commit_id: 'file-base' });
  assert.equal(mergeRequest.body.target_project_id, 7);
  assert.equal(mergeRequest.body.allow_collaboration, true);
  assert.deepEqual(opened, ['https://gitlab.example/mr/1']);
});

test('full-page preview keeps repository HTML inside an opaque sandbox', async () => {
  const { backend, opened } = loadBackend({ provider: 'github', repository: 'owner/repo', branch: 'main' }, () => undefined);
  backend.openRaw('doc.html', '<script>top.sessionStorage.clear()</script>', '', { bg: '#fff', ink: '#000' });
  const shell = await fetch(opened[0]).then(response => response.text());
  assert.match(shell, /<iframe sandbox="allow-scripts"/);
  assert.doesNotMatch(shell, /<script>top\.sessionStorage/);
  URL.revokeObjectURL(opened[0]);
});
