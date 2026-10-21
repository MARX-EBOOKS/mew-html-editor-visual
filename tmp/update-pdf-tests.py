from pathlib import Path
p=Path('tests/pdf-selection-diff.test.mjs');s=p.read_text(encoding='utf-8')
s=s.replace("providerSource.replace('window.PdfReviewProvider = {', 'window.PdfReviewProvider = { sourceDecorations,')",'providerSource')
s=s.replace('api.sourceDecorations(', 'reviewProvider(api).sourceDecorations(')
s=s.replace('PdfSelectionDiff.sourceDecorations(', 'PdfReviewProvider.sourceDecorations(')
needle="test('Monaco standalone renders native source-line and exact character decorations'"
a=s.index(needle);b=s.index("test('browser loads Monaco ESM",a)
block=s[a:b]
block=block.replace("    await page.addScriptTag({ content: engineSource });\n    await page.evaluate(async () => {", "    await page.addScriptTag({ content: engineSource });\n    await page.addScriptTag({ content: fullProviderSource });\n    await page.evaluate(async () => {\n      await PdfReviewReady;",1)
block=block.replace("      window.ReplacementReview = { register: () => () => {}, refreshMenu() {}, invalidate() {},\n        isOpenFor: () => false, openForSelection() {}, showNotice() {} };\n",'')
s=s[:a]+block+s[b:];p.write_text(s,encoding='utf-8')
p=Path('tests/replacement-review-browser.mjs');s=p.read_text(encoding='utf-8')
needle="    await page.evaluate(() => testEditor.executeEdits('test', [{ range: testEditor.getModel().getFullModelRange(), text: testOriginal + '\\n<!-- changed -->' }]));"
assert needle in s
s=s.replace(needle,"    const callsBeforeEdit = await page.evaluate(() => fixtureCalls);\n"+needle)
s=s.replace("    assert.equal(await popup.locator('[data-apply]').isDisabled(), true, 'external edits invalidate candidates');\n    assert.match(await popup.locator('[data-status]').textContent(), /正在自动重新计算/);", "    await page.waitForFunction(previous => fixtureCalls > previous && !document.querySelector('[data-apply]').disabled, callsBeforeEdit);\n    assert.match(await popup.locator('[data-status]').textContent(), /内容已修改，请保存/);")
p.write_text(s,encoding='utf-8')
