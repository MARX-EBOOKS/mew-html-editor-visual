from pathlib import Path
root = Path('public/pdfdiff')
engine = (root/'pdf-selection-diff.js').read_text(encoding='utf-8')
provider = (root/'pdf-review-provider.js').read_text(encoding='utf-8')
local = (root/'local-text-diff.js').read_text(encoding='utf-8')
# The generic review host has no PDF-specific state; providers register through its existing API.
marker = '// PDF comparison is one review provider. Selection synchronization remains independent.'
head, tail = provider.split(marker)
shell = head[head.index('  const toolbox ='):]
(root/'replacement-review.js').write_text("// Shared review session, popup and provider registration.\n(() => {\n  'use strict';\n" + shell + '})();\n', encoding='utf-8')
provider = "// PDF review owns candidate actions, popup content and highlights.\nwindow.PdfReviewReady = (async () => {\n  'use strict';\n  if (!window.PdfSelectionDiff) await import('./pdf-selection-diff.js');\n  await window.PdfSelectionDiff.loadMonaco();\n  if (!window.ReplacementReview) await import('./replacement-review.js');\n\n" + marker + tail
(root/'pdf-review-provider.js').write_text(provider, encoding='utf-8')
# Matching and both text-comparison implementations share the existing local text helper.
a = engine.index('    function anchorMatches(')
b = engine.index('    function rememberConnection(', a)
matcher = engine[a:b]
engine = engine[:a] + engine[b:]
a = engine.index('  function textDiff(')
b = engine.index('  function createLocator(', a)
comparison = engine[a:b]
comparison = comparison[:comparison.index('  function changedRange(')]
comparison = comparison.replace('function monacoTextDiff(left, right, details = false)', 'function monacoTextDiff(computer, left, right, details = false)')
comparison = comparison.replace('function textDiff(left, right, details = false, limit = Infinity)', 'function compare(computer, left, right, details = false, limit = Infinity)')
comparison = comparison.replace('monacoTextDiff(left, right, details)', 'monacoTextDiff(computer, left, right, details)')
comparison = comparison.replace('window.PdfLocalTextDiff.textDiff(', 'textDiff(')
engine = engine[:a] + "  function textDiff(...args) { return window.PdfLocalTextDiff.compare(computer, ...args); }\n  function changedRange(...args) { return window.PdfLocalTextDiff.changedRange(...args); }\n" + engine[b:]
engine = engine.replace('    const reviewAnchors = new WeakMap();', '''    const reviewAnchors = new WeakMap();
    const { anchorMatches, normalized, matches, normalizedRange, locate, approximateMatches, lowerBound }
      = window.PdfLocalTextDiff.createMatcher(options, textDiff);''')
local = local.replace('window.PdfLocalTextDiff = { textDiff, changedRange, appendPart };',
  'window.PdfLocalTextDiff = { textDiff, compare, changedRange, appendPart, createMatcher };')
local = local.rsplit('})();',1)[0] + comparison + '''  function createMatcher(options, textDiff) {
    return { anchorMatches, normalized, matches, normalizedRange, locate, approximateMatches, lowerBound };
''' + matcher + '  }\n})();\n'
(root/'local-text-diff.js').write_text(local, encoding='utf-8')
(root/'pdf-selection-diff.js').write_text(engine, encoding='utf-8')
for p in root.glob('*.js'):
 print(p.name, len(p.read_text(encoding='utf-8').splitlines()))
