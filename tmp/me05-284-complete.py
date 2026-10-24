from pathlib import Path
p=Path('public/pdfdiff/pdf-selection-diff.js');s=p.read_text(encoding='utf-8')
s=s.replace("else if (from.text[a - 1] === ' ' && word(to.text, x)) a--;", "else if (from.text[a - 1] === ' ' && from.text[a - 2] === to.text[x - 1]) a--;").replace("else if (to.text[x - 1] === ' ' && word(from.text, a)) x--;", "else if (to.text[x - 1] === ' ' && to.text[x - 2] === from.text[a - 1]) x--;\n            else if (word(from.text, a)) a--;\n            else if (word(to.text, x)) x--;")
s=s.replace("else if (from.text[b] === ' ' && word(to.text, y)) b++;", "else if (from.text[b] === ' ' && from.text[b + 1] === to.text[y]) b++;").replace("else if (to.text[y] === ' ' && word(from.text, b)) y++;", "else if (to.text[y] === ' ' && to.text[y + 1] === from.text[b]) y++;\n            else if (word(from.text, b)) b++;\n            else if (word(to.text, y)) y++;")
s=s.replace(r'\u2010\u2011\d]',r'\u2010-\u2014\d]')
p.write_text(s,encoding='utf-8')
