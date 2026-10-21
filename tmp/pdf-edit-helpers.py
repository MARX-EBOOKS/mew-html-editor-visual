from pathlib import Path
p=Path('public/pdfdiff/pdf-selection-diff.js');s=p.read_text(encoding='utf-8')
# Keep generic Monaco edit transactions beside preview/validation in the shared text toolbox.
helpers=[]
for start,end,name in [('  function rangeAt(', '  function sourceSegments(', 'rangeAt'),
                        ('  function applyEdits(', '  function textDiff(', 'applyEdits')]:
 a=s.index(start);b=s.index(end,a);helpers.append(s[a:b]);s=s[:a]+f'  function {name}(...args) {{ return window.PdfLocalTextDiff.{name}(...args); }}\n'+s[b:]
s=s.replace('const runs = [], { lowerBound } = window.PdfLocalTextDiff.createMatcher({}, textDiff);','const runs = [], { lowerBound } = window.PdfLocalTextDiff;')
s=s.replace('''    if (!pageTexts.has(page)) pageTexts.set(page, Promise.resolve().then(() => page.getTextContent())
      .catch(error => {
        pageTexts.delete(page);
        throw error;
      }));''','''    if (!pageTexts.has(page)) pageTexts.set(page, Promise.resolve().then(() => page.getTextContent())
      .catch(error => { pageTexts.delete(page); throw error; }));''')
s=s.replace('    const definition = { name, opening: text, rawStart, openStart, openEnd: openStart + text.length,','    return { name, opening: text, rawStart, openStart, openEnd: openStart + text.length,')
s=s.replace('    return definition;\n','')
p.write_text(s,encoding='utf-8')
p=Path('public/pdfdiff/local-text-diff.js');s=p.read_text(encoding='utf-8')
s=s.replace('createMatcher, validateEdits, previewEdits };','createMatcher, validateEdits, previewEdits, rangeAt, applyEdits, lowerBound };')
a=s.index('    function lowerBound(');b=s.index('  }\n',a)
# This function is last in createMatcher; locate its closing line exactly.
b=s.index('    }\n',a)+6
bound=s[a:b];s=s[:a]+s[b:]
s=s.rsplit('})();',1)[0]+''.join(helpers)+bound+'})();\n';p.write_text(s,encoding='utf-8')
print('engine lines',len(Path('public/pdfdiff/pdf-selection-diff.js').read_text(encoding='utf-8').splitlines()))
