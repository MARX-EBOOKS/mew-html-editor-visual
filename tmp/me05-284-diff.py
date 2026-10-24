from pathlib import Path
b=Path('tmp/me05-284-before-diff.js').read_text(encoding='utf-8');a=Path('public/pdfdiff/pdf-selection-diff.js').read_text(encoding='utf-8');import difflib
print('LINES',len(b.splitlines()),len(a.splitlines()))
print(''.join(difflib.unified_diff(b.splitlines(True),a.splitlines(True))))
