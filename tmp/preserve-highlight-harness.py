from pathlib import Path
p = Path('tests/support/pdf-harness.mjs')
s = p.read_text('utf-8')
start = s.index('const source = ')
end = s.index('const readerMenu', start)
original = s[start:end]
duplicate = original.replace('const source = `if (!window.PdfReviewProvider?.measureHighlights) { ${fullReviewSource} }`', 'const highlightSelectionSource = fullReviewSource')
s = s[:end] + duplicate + s[end:]
s = s.replace('countedEngineSource, engine, locator, reviewProvider };', 'countedEngineSource, engine, locator, reviewProvider, highlightSelectionSource };')
p.write_text(s, 'utf-8')
for p in Path('tests').glob('pdf-selection-highlight*.mjs'):
 s = p.read_text('utf-8').replace('countedEngineSource, source, locator, engine', 'countedEngineSource, highlightSelectionSource as source, locator')
 s = s.replace('const engineWindow = { PdfSelectionDiff: engine() };\nconst PdfReviewProvider = engineWindow.PdfSelectionDiff;', 'const engineWindow = {};\nvm.runInNewContext(engineSource, { window: engineWindow });\nconst PdfReviewProvider = engineWindow.PdfReviewProvider;')
 p.write_text(s, 'utf-8')
