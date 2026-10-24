from pathlib import Path
import re

root = Path('tests')
for name in ['document-browser', 'pdf-review-popup-browser', 'replacement-review-browser']:
    file = root / f'{name}.mjs'
    text = file.read_text('utf-8')
    text = text.replace("import { spawn } from 'node:child_process';\n", '')
    text = text.replace("import { launchBrowser }", "import { launchBrowser, startServer, stopServer }")
    start = text.index('async function start(')
    end = text.index('\n}', start) + 2
    text = text[:start] + '''async function start(script, port, args) {
  servers.push(await startServer(script, port, args));
}''' + text[end:]
    if name == 'document-browser':
        text = text.replace("import { fileURLToPath } from 'node:url';\n", '')
        text = text.replace("const root = fileURLToPath(new URL('..', import.meta.url));\n", '')
        text = re.sub(r'  await Promise.all\(servers.map\(child => new Promise\(resolve => \{.*?\n  \}\)\)\);', '  await Promise.all(servers.map(stopServer));', text, flags=re.S)
    else:
        text = text.replace('  servers.forEach(server => server.kill());', '  await Promise.all(servers.map(stopServer));')
    file.write_text(text, 'utf-8')

for name, port in [('layout-browser', 41873), ('monaco-browser', 41874), ('editor-input-browser', 41879), ('pdf-cache-browser', 41886)]:
    file = root / f'{name}.mjs'
    text = file.read_text('utf-8')
    text = text.replace("import { spawn } from 'node:child_process';\n", '')
    text = text.replace("import { spawn, execFileSync }", "import { execFileSync }")
    text = text.replace("import { launchBrowser }", "import { launchBrowser, startServer, stopServer }")
    if name == 'pdf-cache-browser':
        start = text.index('  server = spawn(')
        end = text.index('  browser = await launchBrowser();', start)
        text = text[:start] + f"  server = await startServer('reader-server.js', {port}, ['-c', path.join(fixture, 'config.json')]);\n" + text[end:]
        text = text.replace('  server?.kill();', '  await stopServer(server);')
    else:
        start = text.index('const server = spawn(')
        end = text.index('  browser = await launchBrowser();', start)
        arg = "'public'" if name == 'layout-browser' else 'fixture'
        text = text[:start] + f"let server, browser;\ntry {{\n  server = await startServer('server.js', {port}, ['-r', {arg}]);\n" + text[end:]
        text = text.replace('  server.kill();', '  await stopServer(server);')
        text = text.replace("  await new Promise(resolve => server.exitCode !== null ? resolve() : server.once('exit', resolve));\n", '')
    file.write_text(text, 'utf-8')

file = root / 'document-model.test.mjs'
text = file.read_text('utf-8')
start, end = text.index('const sources ='), text.index('const defer =')
text = text[:start] + '''const window = {};
vm.runInNewContext(await readFile(new URL('../public/editor-core.js', import.meta.url), 'utf8'), { window });
const Model = window.MewEditorCore.DocumentModel;
''' + text[end:]
start, end = text.index("test('undo/redo"), text.index("test('queued saves")
text = text[:start] + r'''test('loading retains disk text and version for the next save', async () => {
  const d = await Model.load({ read: async () => ({ text: 'disk\r\n', mtime: 7 }) });
  assert.equal(d.content, 'disk\r\n');
  assert.equal(d.savedContent, d.content);
  assert.equal(d.mtime, 7);
  assert.equal(d.dirty, false);
});

test('editor normalization preserves line endings and dirty follows saved text', () => {
  const d = new Model({ text: 'a\r\n' });
  assert.equal(d.textFromEditor('a\n'), 'a\r\n');
  d.update('ab');
  assert.equal(d.dirty, true);
  assert.equal(d.revision, 1);
  assert.equal(d.textFromEditor('a\n'), 'a\r\n');
  d.update(d.textFromEditor('a\n'));
  assert.equal(d.dirty, false);
  assert.equal(d.revision, 2);
  d.update(d.content);
  assert.equal(d.revision, 2, 'identical editor updates retain the revision');
});

''' + text[end:]
text = text.replace('clean reload clears history', 'clean reload advances revision')
text = text.replace("d.remember({ text: 'a' }); d.update('local');", "d.update('local');")
text = text.replace('d.undoStack.length, 1', 'd.reloadRevision, 0')
text = text.replace('d.undoStack.length, 0', 'd.reloadRevision, 1')
file.write_text(text, 'utf-8')
