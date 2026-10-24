from pathlib import Path
import re

root = Path('tests')
support = root / 'support'
support.mkdir(exist_ok=True)
diff = (root / 'pdf-selection-diff.test.mjs').read_text('utf-8')
highlight = (root / 'pdf-selection-highlight.test.mjs').read_text('utf-8')
# One source adapter for the private production helpers used by these regressions.
header = diff[diff.index('const reviewFile ='):diff.index("test('concurrent font")]
header = header.replace("new URL('../public/", "new URL('../../public/")
header = header.replace('const PdfReviewProvider = engine();\n', '')
header = header.replace('const fullProviderSource = fullReviewSource;\n', '')
header = header.replace(".match(/<button id=\"diffHighlightBtn\".*?<\\/button>/)[0]", ".match(/<button id=\"diffHighlightBtn\".*?<\\/button>/)[0]")
extra = '''
const countedEngineSource = engineSource.replace('function textDiff(left, right, details = false, limit = Infinity) {',
  '$& window.diffCalls = (window.diffCalls || 0) + 1;');
function locator(options = {}, environment = {}, script = engineSource, globals = {}) {
  const window = { document: { createElement: () => ({}) } };
  vm.runInNewContext(script, { window, ...globals });
  return new window.PdfReviewProvider.PdfLocator(options, environment);
}
export { reviewFile, popupSource, diffSource, mappingSource, engineSource, highlightSource,
  providerSource, fullReviewSource, fullReviewSource as fullProviderSource, source, readerMenu,
  countedEngineSource, engine, locator, reviewProvider };
'''
(support / 'pdf-harness.mjs').write_text("import { readFile } from 'node:fs/promises';\nimport vm from 'node:vm';\n\n" + header + extra, 'utf-8')

common = """import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';
"""
diff_imports = """import { reviewFile, popupSource, diffSource, engineSource, highlightSource, providerSource,
  fullReviewSource, fullProviderSource, source, readerMenu, engine, reviewProvider } from './support/pdf-harness.mjs';
const PdfReviewProvider = engine();
"""
highlight_imports = """import { engineSource, countedEngineSource, source, locator, engine } from './support/pdf-harness.mjs';
const testLocator = locator();
const engineWindow = { PdfSelectionDiff: engine() };
const PdfReviewProvider = engineWindow.PdfSelectionDiff;
const normalized = engineWindow.PdfSelectionDiff.normalized;
const { textDiff } = engineWindow.PdfSelectionDiff;
""" + highlight[highlight.index('// ME34-014'):highlight.index("test('source edits")]

for name, original, imports in [('pdf-selection-diff', diff, diff_imports), ('pdf-selection-highlight', highlight, highlight_imports)]:
    starts = list(re.finditer(r'^test\(', original, re.M))
    unit, browser = [], []
    for i, start in enumerate(starts):
        block = original[start.start():starts[i + 1].start() if i + 1 < len(starts) else len(original)]
        (browser if 'chromium.launch(' in block else unit).append(block)
    (root / f'{name}.test.mjs').write_text(common + imports + '\n' + ''.join(unit), 'utf-8')
    (root / f'{name}.browser.test.mjs').write_text(common + "import { launchBrowser } from './support/browser.mjs';\n" + imports + '\n' + ''.join(browser), 'utf-8')

pattern_path = root / 'pdf-review-pattern.test.mjs'
pattern = pattern_path.read_text('utf-8')
pattern = pattern[:pattern.index('const diffSource =')] + "import { diffSource, mappingSource, providerSource } from './support/pdf-harness.mjs';\n\n" + pattern[pattern.index("for (const kind"):]
pattern = pattern.replace("import { readFile } from 'node:fs/promises';\n", '')
pattern_path.write_text(pattern, 'utf-8')
for name in ['pdf-review-api', 'review-highlights']:
    (root / f'{name}.test.mjs').rename(root / f'{name}.browser.test.mjs')

# All browser suites use the same configurable browser selection.
for file in root.glob('*.mjs'):
    text = file.read_text('utf-8')
    text = re.sub(r"import \{ chromium \} from 'playwright';", "import { launchBrowser } from './support/browser.mjs';", text)
    if "const { chromium } = require(" in text:
        text = re.sub(r"(?m)^import \{ createRequire \} from 'node:module';\n", '', text)
        text = re.sub(r"(?m)^const require = createRequire\(import.meta.url\);\nconst \{ chromium \} = require\([^\n]+\n", "import { launchBrowser } from './support/browser.mjs';\n", text)
    text = re.sub(r'chromium\.launch\(\{[^{}]*?headless: true\s*\}\)', 'launchBrowser()', text)
    file.write_text(text, 'utf-8')
