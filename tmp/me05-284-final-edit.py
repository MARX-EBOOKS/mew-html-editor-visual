from pathlib import Path
p=Path('public/pdfdiff/pdf-selection-diff.js');s=p.read_text(encoding='utf-8')
s=s.replace('          while (a && x && (from.text[a - 1] === to.text[x - 1] || word(from.text, a) && word(to.text, x))) { a--; x--; }','''          while (a && x) {
            if (from.text[a - 1] === to.text[x - 1] || word(from.text, a) && word(to.text, x)) { a--; x--; }
            else if (from.text[a - 1] === ' ' && word(to.text, x)) a--;
            else if (to.text[x - 1] === ' ' && word(from.text, a)) x--;
            else break;
          }''')
start=s.index('      const projection = [];');end=s.index('      for (const part of parts || []) {',s.index('      const project =',start));s=s[:start]+s[end:]
start=s.index("          const lineStart = pdfRaw.lastIndexOf");end=s.index('          const before =',start);s=s[:start]+'''          const a = Math.max(0, from - 45), b = Math.min(this.raw.length, end + 45);
'''+s[end:]
s=s.replace("const add = (start, parts, pdfRaw = '', pdfStart = 0) => {",'const add = (start, parts) => {').replace('const from = start, end = start += part.html.length, at = pdfStart;\n        pdfStart += part.pdf.length;','const from = start, end = start += part.html.length;').replace('add(connection.start, this.connectionDiff(target, connection).parts, target.raw, connection.targetStart);','add(connection.start, this.connectionDiff(target, connection).parts);')
p.write_text(s,encoding='utf-8')
