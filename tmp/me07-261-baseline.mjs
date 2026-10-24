import { readFile, writeFile, unlink } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
let provider = (await readFile('public/pdfdiff/pdf-review-provider.js', 'utf8')).replace(/\r\n/g, '\n');
provider = provider.replace("if (raw && a === b ? !span.changed || right !== a || left !== a\n          && !(marked && !span.html.trim() && significantText(span.pdf)) : right <= a || left >= b) continue;", "if (raw && a === b ? !span.changed || left !== a || right !== a : right <= a || left >= b) continue;");
provider = provider.replace("const segments = toolbox.sourceSegments(index, cursor, end);\n          const insertion = !segments.length;\n          if (insertion) segments.push(toolbox.insertionSegment(index, end));", "const segments = cursor === end ? [toolbox.insertionSegment(index, cursor)] : toolbox.sourceSegments(index, cursor, end);");
provider = provider.replace("inlineClassName: insertion ? undefined : 'mew-ocr-diff-text',", "inlineClassName: part.html.length ? 'mew-ocr-diff-text' : undefined,").replace("beforeContentClassName: insertion ? 'mew-ocr-diff-insert' : undefined,", "beforeContentClassName: part.html.length ? undefined : 'mew-ocr-diff-insert',");
await writeFile('tmp/me07-261-baseline-provider.js', provider);
for (const [file, pattern] of [['pdf-selection-diff.test.mjs', 'ME07-261|ME07-066'], ['pdf-selection-highlight.test.mjs', 'empty PDF counterparts']]) {
  const path = `tests/me07-261-baseline-${file}`;
  const test = (await readFile(`tests/${file}`, 'utf8')).replace('../public/pdfdiff/pdf-review-provider.js', '../tmp/me07-261-baseline-provider.js');
  try {
    await writeFile(path, test);
    const result = spawnSync(process.execPath, ['--test', '--test-name-pattern', pattern, path], { encoding: 'utf8', windowsHide: true });
    console.log(result.stdout, result.stderr);
  } finally { await unlink(path); }
}
