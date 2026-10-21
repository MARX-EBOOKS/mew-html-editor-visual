from pathlib import Path
p=Path('public/pdfdiff/pdf-selection-diff.js');s=p.read_text(encoding='utf-8')
s=s.replace('''          if (failed) {
            style.bold = style.italic = null;
            style.reason = '字体读取失败';
          } else if (invisibleFonts.has(id)) {''','''          if (failed) Object.assign(style, { bold: null, italic: null, reason: '字体读取失败' });
          else if (invisibleFonts.has(id)) {''')
s=s.replace('''        if (signal?.aborted || !environment.isCurrent(pdf)) return null;
        // Share in-flight work too; separate reviews can request the same page.
        await (entry.fontTask ||= (async () => {''','''        if (signal?.aborted || !environment.isCurrent(pdf)) return null;
        await (entry.fontTask ||= (async () => {''')
s=s.replace('''          if (!environment.isCurrent(pdf)) return;
          const fonts = await readPageFonts(page, entry.parts.map(part => part.item));''','''          const fonts = environment.isCurrent(pdf) && await readPageFonts(page, entry.parts.map(part => part.item));''')
p.write_text(s,encoding='utf-8')
# Isolated and browser tests load the reusable host without relying on a test-page module URL.
for name in ['tests/pdf-selection-diff.test.mjs','tests/pdf-selection-highlight.test.mjs']:
 p=Path(name);s=p.read_text(encoding='utf-8')
 needle="const localDiffSource = await readFile(new URL('../public/pdfdiff/local-text-diff.js', import.meta.url), 'utf8');"
 helper="""const reviewHostSource = await readFile(new URL('../public/pdfdiff/replacement-review.js', import.meta.url), 'utf8');
async function readReviewProvider() {
  return (await readFile(new URL('../public/pdfdiff/pdf-review-provider.js', import.meta.url), 'utf8'))
    .replace("if (!window.ReplacementReview) await import('./replacement-review.js');", reviewHostSource);
}
"""
 assert needle in s;s=s.replace(needle,helper+needle)
 # Skip replacing the helper's own filesystem read.
 head,tail=s.split(needle,1)
 tail=tail.replace("await readFile(new URL('../public/pdfdiff/pdf-review-provider.js', import.meta.url), 'utf8')",'await readReviewProvider()')
 s=head+needle+tail
 p.write_text(s,encoding='utf-8')
print('engine lines',len(Path('public/pdfdiff/pdf-selection-diff.js').read_text(encoding='utf-8').splitlines()))
