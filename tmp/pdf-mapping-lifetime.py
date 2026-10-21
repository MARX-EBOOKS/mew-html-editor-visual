from pathlib import Path
p=Path('public/pdfdiff/pdf-selection-diff.js');s=p.read_text(encoding='utf-8')
s=s.replace('function rememberConnection(source, start, end, target, hit, alignment)', 'function rememberConnection(source, start, end, target, hit, alignment, prepared = false)')
s=s.replace('      if (existing) return existing;','      if (existing) { if (prepared) existing.prepared = true; return existing; }')
s=s.replace('const connection = { start, end, targetStart:', 'const connection = { prepared, start, end, targetStart:')
s=s.replace('''      source.connections.set(target, [connection, ...cached.filter(item => item.start !== start || item.end !== end)].slice(0, 128));''','''      // Prepared passage mappings are document data; only transient selection mappings are evicted.
      let selections = prepared ? 0 : 1;
      source.connections.set(target, [connection, ...cached.filter(item => (item.start !== start || item.end !== end)
        && (item.prepared || ++selections <= 128))]);''')
s=s.replace('for (const range of confirmed) rememberConnection(index, range.hit.start, range.hit.end, page, range);',
 'for (const range of confirmed) rememberConnection(index, range.hit.start, range.hit.end, page, range, null, true);')
s=s.replace('if (connect) rememberConnection(index, scope.start, scope.end, page, { start: 0, end: page.raw.length });',
 'if (connect) rememberConnection(index, scope.start, scope.end, page, { start: 0, end: page.raw.length }, null, true);')
s=s.replace('''          });
        source.preparedDocument = full;''','''          }, true);
        source.preparedDocument = full;''')
p.write_text(s,encoding='utf-8')
p=Path('tests/replacement-review-browser.mjs');s=p.read_text(encoding='utf-8')
s=s.replace("      assert.equal(await page.evaluate(() => testEditor.getModel().getValueInRange(testEditor.getSelection())), 'X');", "      assert.equal(await page.evaluate(() => testEditor.getSelection().isEmpty()), true, 'opening review preserves the click caret');")
p.write_text(s,encoding='utf-8')
