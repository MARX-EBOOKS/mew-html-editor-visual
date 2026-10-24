from pathlib import Path
p=Path('public/pdfdiff/pdf-selection-diff.js');s=p.read_text(encoding='utf-8')
a=s.index('          while (a && x && from.text');b=s.index('          this.rememberConnection',a)
s=s[:a]+'''          // Extend both ends together; PDF line breaks may split a matching word.
          const word = (text, at) => /\\p{L}{2}/u.test(text.slice(at - 1, at + 1));
          while (a && x && (from.text[a - 1] === to.text[x - 1] || word(from.text, a) && word(to.text, x))) { a--; x--; }
          while (b < from.text.length && y < to.text.length) {
            if (from.text[b] === to.text[y] || word(from.text, b) && word(to.text, y)) { b++; y++; }
            else if (from.text[b] === ' ' && word(to.text, y)) b++;
            else if (to.text[y] === ' ' && word(from.text, b)) y++;
            else break;
          }
'''+s[b:]
p.write_text(s,encoding='utf-8')
