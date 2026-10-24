from pathlib import Path
p=Path('public/pdfdiff/pdf-selection-diff.js');s=Path('tmp/me05-284-before-diff.js').read_text(encoding='utf-8')
s='\n'.join(line for line in s.split('\n') if not any(v in line for v in ['while (a && /\\p{L}{2}', 'while (x && /\\p{L}{2}', 'while (b < from.text.length && /\\p{L}{2}', 'while (y < to.text.length && /\\p{L}{2}']))
p.write_text(s,encoding='utf-8')
