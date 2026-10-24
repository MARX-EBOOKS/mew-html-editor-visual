import { launchBrowser } from './support/browser.mjs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const real = process.argv.includes('--real');
const styles = process.argv.includes('--styles');
const code = `
import sys, json
from pathlib import Path
sys.path.insert(0, 'html_pattern_scripts')
from html_pattern_review import Review, make_handler, PROVIDERS
from http.server import ThreadingHTTPServer
if ${real ? 'True' : 'False'}:
    review = Review(Path('../MEW_BRIEF/16'))
else:
    from test_html_pattern_review import OcrReviewTests, OcrStyleReviewTests, BusinessOptions
    fixture = ${styles ? 'OcrStyleReviewTests' : 'OcrReviewTests'}()
    fixture.setUp()
    if ${styles ? 'True' : 'False'}:
        fixture.styled_pdf()
    config_path = fixture.root / '.mew-reader.json'
    config_path.write_text(json.dumps({'htmlRoot': 'html', 'pdf': 'pdf/mew_band16.pdf',
                                       'pagePattern': r'^ME16-(?<page>\\d+)\\.html?$'}), 'utf-8')
    review = Review(config_path=config_path, data_dir=fixture.root / 'data', providers=[*PROVIDERS, BusinessOptions()])
server = ThreadingHTTPServer(('127.0.0.1', 0), make_handler(review))
print(json.dumps({'url': f'http://127.0.0.1:{server.server_port}'}), flush=True)
try:
    server.serve_forever()
finally:
    server.server_close()
`;
const server = spawn(process.env.PYTHON || 'python', ['-u', '-B', '-c', code], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let output = '';
const ready = new Promise((resolve, reject) => {
  server.stdout.on('data', chunk => {
    output += chunk;
    if (output.includes('\n')) {
      try { resolve(JSON.parse(output.split('\n')[0]).url); } catch (e) { reject(e); }
    }
  });
  server.once('exit', code => reject(new Error(`Server exited ${code}: ${output}`)));
  server.stderr.on('data', chunk => { if (String(chunk).includes('Traceback')) console.error(String(chunk)); });
});
let browser;
try {
  const base = await ready;
  browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', e => { errors.push(e.message); console.error(e.stack); });
  await page.goto(base);
  async function choosePurpose(value) {
    await page.waitForSelector(`#purpose input[value="${value}"]`);
    await page.locator(`#purpose input[value="${value}"]`).check();
    const checked = await page.locator('#purpose input:checked').evaluateAll(inputs => inputs.map(input => input.value));
    for (const id of checked) if (id !== value) await page.locator(`#purpose input[value="${id}"]`).uncheck();
  }
  if (styles) {
    await choosePurpose('ocr-styles');
  }
  await page.waitForFunction(() => document.querySelector('#matches .match'));
  if (!real) {
    await page.waitForFunction(() => !comparing);
    const before = await page.evaluate(() => ({ purpose: selectedPurpose(), path: state.path,
      files: JSON.parse(JSON.stringify(state.files)) }));
    const requests = [];
    const record = request => { if (request.url().includes('/api/document?')) requests.push(request.url()); };
    page.on('request', record);
    const listing = page.waitForResponse(response => response.url().includes('/api/files?'));
    await page.reload();
    assert.equal((await (await listing).json()).restored, true);
    await page.waitForFunction(() => state.document && !element('refresh').disabled);
    assert.equal(await page.evaluate(() => selectedPurpose()), before.purpose);
    assert.equal(await page.evaluate(() => state.path), before.path);
    assert.deepEqual(await page.evaluate(() => state.files), before.files);
    assert.equal(requests.length, 1, 'reload only checks the active document');
    page.off('request', record);
    const freshListing = page.waitForResponse(response => response.url().includes('/api/files?'));
    await page.locator('#refresh').click();
    assert.equal((await (await freshListing).json()).restored, undefined);
    await page.waitForFunction(() => state.document && !comparing && !element('refresh').disabled);
  }
  await page.locator('#toggle-findings').click();
  assert(await page.locator('#findings').isVisible());
  // Opening the page populates both the first document and file counts automatically.
  if (!real) {
    await page.waitForFunction(() => document.querySelector('#compare').textContent === '比较当前筛选的文件');
    assert.equal(await page.locator('#files .badge').filter({ hasText: '待比较' }).count(), 0);
  }
  const pathChecks = await page.evaluate(() => {
    const paths = ['16/ME16-009.html', '16/nested/ME16-011.html', '25/ME25-100.html', 'index.htm'];
    return [
      '', '**/*.html', '16/*.html', '**/16/**/*.html',
      '**/ME16-0{09,11}.html', '**/ME16-0[01]?.html',
      '25/**, index.htm', '**/*.{html,htm}, !16/**',
      '16\\ME16-*.html', 'ME16-009', '**/[z-a].html', '**/unfinished{',
    ].map(query => paths.filter(pathFilter(query)));
  });
  assert.deepEqual(pathChecks, [
    ['16/ME16-009.html', '16/nested/ME16-011.html', '25/ME25-100.html', 'index.htm'],
    ['16/ME16-009.html', '16/nested/ME16-011.html', '25/ME25-100.html'],
    ['16/ME16-009.html'],
    ['16/ME16-009.html', '16/nested/ME16-011.html'],
    ['16/ME16-009.html', '16/nested/ME16-011.html'],
    ['16/ME16-009.html', '16/nested/ME16-011.html'],
    ['25/ME25-100.html', 'index.htm'],
    ['25/ME25-100.html', 'index.htm'],
    ['16/ME16-009.html'], ['16/ME16-009.html'], [], [],
  ]);
  if (!real) {
    const fileCount = await page.locator('#files .file').count();
    await page.locator('#search').fill('**/ME16-0{09,11}.html, !**/*011.html');
    assert.equal(await page.locator('#files .file').count(), 1);
    assert.equal(await page.locator('#files .file span').first().textContent(), 'ME16-009.html');
    await page.locator('#search').fill('');
    assert.equal(await page.locator('#files .file').count(), fileCount);
  }
  if (real) {
    await page.locator('#search').fill('ME16-009');
    await page.waitForFunction(() => document.querySelector('#filename').textContent === 'ME16-009.html'
      && document.querySelectorAll('#matches .match').length === 6);
  }
  await page.waitForFunction(() => [...document.querySelectorAll('#crops img')].some(i => i.complete && i.naturalWidth));
  assert(await page.locator('#review-pane').isVisible());
  assert(await page.locator('#crops img').count() > 0);
  await page.locator('#show-originals').click();
  await page.waitForSelector('#originals-pane figure');
  assert(await page.locator('#review-pane').isHidden());
  assert(await page.locator('#source-pane').isHidden());
  assert.deepEqual(await page.locator('#originals-pane figcaption').allTextContents(),
    await page.evaluate(() => state.document.pages.map(p => `PDF ${p.label} · 物理页 ${p.page}`)));
  for (const image of await page.locator('#originals-pane img').all()) {
    await image.scrollIntoViewIfNeeded();
    await image.evaluate(img => img.complete && img.naturalWidth ? undefined : new Promise((resolve, reject) => {
      img.addEventListener('load', resolve, { once: true });
      img.addEventListener('error', () => reject(new Error('Original scan failed to load')), { once: true });
    }));
  }
  await page.locator('#show-review').click();
  await page.waitForFunction(() => document.querySelector('#crops .scan-highlight'));
  if (!real) {
    const imageRequests = [];
    const recordImage = request => { if (request.resourceType() === 'image') imageRequests.push(request.url()); };
    page.on('request', recordImage);
    await page.evaluate(() => {
      window.reviewScan = element('crops').querySelector('img');
      const page = state.hits[state.hit].crops[0].page;
      const next = state.hits.findIndex((hit, index) => index !== state.hit && hit.crops?.[0]?.page === page);
      selectHit(next < 0 ? state.hit : next);
    });
    await page.waitForFunction(() => document.querySelector('#crops .scan-highlight'));
    assert(await page.evaluate(() => element('crops').querySelector('img') === window.reviewScan));
    assert.deepEqual(imageRequests, []);
    const scan = await page.locator('#crops').evaluate(box => {
      const frame = box.getBoundingClientRect(), mark = box.querySelector('.scan-highlight').getBoundingClientRect();
      return { height: frame.height, visible: mark.top < frame.bottom && mark.bottom > frame.top,
        width: box.querySelector('img').naturalWidth };
    });
    assert(scan.height <= 92 && scan.visible && scan.width === 600, JSON.stringify(scan));
    await page.screenshot({ path: 'tmp/html-review-page-scan.png' });
    page.off('request', recordImage);
    await page.evaluate(() => { selectHit(0); delete window.reviewScan; });
  }
  await page.locator('#show-source').click();
  assert(await page.locator('#source').isVisible());
  await page.locator('#show-preview').click();
  assert(await page.locator('#preview').isVisible());
  await page.locator('#show-review').click();
  await page.locator('#theme').selectOption('light');
  assert.equal(await page.evaluate(() => getComputedStyle(document.body).color), 'rgb(51, 51, 51)');
  await page.locator('#theme').selectOption('dark');

  if (!real && !styles) {
    await page.waitForFunction(() => proposalReady);
    const original = await page.evaluate(() => state.document.source);
    await page.evaluate(async () => {
      state.document.source = '<p>上文 context 😀</p>\n'.repeat(300) + '<p>wrld</p>\n' + '<p>下文 context</p>\n'.repeat(300);
      const updated = new Promise(resolve => {
        const listener = proposalEditor.onDidUpdateDiff(() => { listener.dispose(); resolve(); });
      });
      showProposal(state.document.source.replace('wrld', 'world'));
      element('proposal-diff').hidden = false;
      proposalEditor.layout();
      await updated;
    });
    await page.waitForFunction(() => proposalEditor.getLineChanges()?.length === 1
      && document.querySelector('#proposal-diff .char-insert'));
    const rows = await page.evaluate(() => {
      const change = proposalEditor.getLineChanges()[0];
      return {
        original: change.originalEndLineNumber - change.originalStartLineNumber + 1,
        modified: change.modifiedEndLineNumber - change.modifiedStartLineNumber + 1,
        text: proposalModels.original.getValue() === state.document.source,
        proposal: proposalModels.modified.getValue() === state.document.source.replace('wrld', 'world'),
      };
    });
    assert.deepEqual(rows, { original: 1, modified: 1, text: true, proposal: true });
    await page.waitForFunction(() => document.querySelector('#proposal-diff').textContent.includes('hidden lines'));
    await page.screenshot({ path: 'tmp/html-review-folded-context.png' });
    const placement = await page.locator('#proposal-diff').evaluate(box => {
      const frame = box.getBoundingClientRect();
      const red = box.querySelector('.char-delete').getBoundingClientRect();
      const green = box.querySelector('.char-insert').getBoundingClientRect();
      return { height: frame.height, offset: (red.top + green.bottom) / 2 - frame.top };
    });
    assert(placement.height > 180);
    assert(placement.offset > 0 && placement.offset < placement.height, JSON.stringify(placement));
    const fold = page.locator('#proposal-diff [title="Show Unchanged Region"]').first();
    await fold.click();
    await page.waitForFunction(() => document.querySelectorAll('#proposal-diff [title="Show Unchanged Region"]').length === 1);
    const foldBack = page.locator('#proposal-diff .fold-unchanged:visible').first();
    await foldBack.click();
    await page.waitForFunction(() => document.querySelectorAll('#proposal-diff [title="Show Unchanged Region"]').length === 2);
    for (const [before, after] of [['', 'INSERT 😀'], ['DELETE 😀', '']]) {
      await page.evaluate(async ([before, after]) => {
        const prefix = '<p>' + 'context '.repeat(200), suffix = ' context'.repeat(200) + '</p>';
        state.document.source = prefix + before + suffix;
        const updated = new Promise(resolve => {
          const listener = proposalEditor.onDidUpdateDiff(() => { listener.dispose(); resolve(); });
        });
        showProposal(prefix + after + suffix);
        await updated;
      }, [before, after]);
      await page.waitForFunction(() => proposalEditor.getLineChanges()?.length === 1);
      if (before) {
        await page.waitForFunction(() => [...document.querySelectorAll('#proposal-diff .inline-deleted-text')]
          .some(node => node.textContent.includes('DELETE')
            && getComputedStyle(node).backgroundColor === 'rgba(241, 76, 76, 0.35)'));
      }
      assert.equal(await page.evaluate(() => {
        const change = proposalEditor.getLineChanges()[0];
        return change.originalEndLineNumber - change.originalStartLineNumber === 0
          && change.modifiedEndLineNumber - change.modifiedStartLineNumber === 0;
      }), true);
    }
    await page.evaluate(original => { state.document.source = original; }, original);
    await page.evaluate(() => updateProposal());
  }

  await page.locator('#advanced-filters').evaluate(node => { node.open = true; });
  if (styles) {
    assert.equal(await page.locator('#matches .match').count(), 3);
    assert.equal(await page.locator('[name=choice][value=custom]').count(), 0);
    await page.locator('[name=choice][value=ocr]').check();
    await page.locator('#save').click();
    await page.waitForFunction(() => sourceEditor.getValue().includes('<i>Italic &amp;</i>'));
    await page.locator('#kind').selectOption('missing');
    assert.equal(await page.locator('#matches .match').count(), 1);
    await page.locator('[name=choice][value=ocr]').check();
    await page.locator('#save').click();
    await page.waitForFunction(() => document.querySelectorAll('#matches .match').length === 0);
    await page.locator('#kind').selectOption('matched');
    assert.equal(await page.locator('#matches .match').count(), 3);
    assert.equal(await page.locator('[name=choice][value=ocr]').count(), 0);
    await page.locator('#compare').click();
    await page.waitForFunction(() => document.querySelector('#compare').textContent === '比较当前筛选的文件');
  } else if (!real) {
    assert.equal(await page.locator('[name=choice][value=next], [name=choice][value=previous]').count(), 0);
    await page.waitForFunction(() => proposalReady);
    assert(await page.locator('#save').isEnabled());
    await page.locator('#hit-next').click();
    await page.waitForFunction(() => document.querySelectorAll('#matches .match')[1]?.classList.contains('active'));
    assert.equal(await page.locator('#save-status').textContent(), '');
    await page.locator('#hit-previous').click();
    await page.waitForFunction(() => document.querySelector('#matches .match')?.classList.contains('active'));
    assert.equal(await page.locator('#save-status').textContent(), '');
    await page.locator('#matches .match').first().click();
    await page.locator('[name=choice][value=ocr]').check();
    await page.locator('#save').click();
    await page.waitForFunction(() => sourceEditor.getValue().includes('<i>world</i>'));
    await page.locator('[name=choice][value=custom]').check();
    assert(await page.locator('#custom-source-slot .monaco-editor').isVisible());
    const originalSource = await page.evaluate(() => state.document.source);
    const editedSource = await page.evaluate(() => {
      const model = sourceEditor.getModel(), selection = sourceEditor.getSelection();
      const hit = state.hits[state.hit];
      const assertSelection = model.getValueInRange(selection) === Array.from(state.document.source).slice(hit.start, hit.end).join('');
      if (!assertSelection) throw new Error('Source selection missed current difference');
      sourceEditor.executeEdits('browser-test', [{ range: selection, text: '<b>New &amp; input 😀</b>' }]);
      return sourceEditor.getValue();
    });
    await page.waitForFunction(() => proposalReady);
    assert.equal(await page.evaluate(() => state.document.source), originalSource);
    await page.locator('#search').fill('ME16-009');
    assert.equal(await page.evaluate(() => sourceEditor.getValue()), editedSource);
    assert.equal(await page.locator('[name=choice]:checked').inputValue(), 'custom');
    await page.locator('#search').fill('');
    await page.locator('#show-source').click();
    assert(await page.locator('#source-pane .monaco-editor').isVisible());
    assert.equal(await page.evaluate(() => sourceEditor.getValue()), editedSource);
    await page.locator('#show-review').click();
    assert(await page.locator('#custom-source-slot .monaco-editor').isVisible());
    await page.locator('#save').click();
    await page.waitForFunction(() => sourceEditor.getValue().includes('<b>New &amp; input 😀</b>'));
    await page.locator('#compare').click();
    await page.waitForFunction(() => document.querySelector('#compare').textContent === '比较当前筛选的文件');
    await choosePurpose('patterns');
    await page.waitForFunction(() => document.querySelector('#show-review').hidden);
    await choosePurpose('ocr');
    await page.waitForFunction(() => document.querySelector('#matches .match'));
  }
  if (!real) {
    await choosePurpose('business-options');
    await page.waitForFunction(() => document.querySelectorAll('[name=choice]').length === 4);
    assert.deepEqual(await page.locator('#decision-options label').allTextContents(), ['接受', '略过', '稍后', '添加备注']);
    await page.locator('[name=choice][value=append-note]').check();
    assert(await page.locator('#custom-text').isVisible());
    await page.locator('#custom-text').fill('<business note>');
    await page.locator('#save').click();
    await page.waitForFunction(() => sourceEditor.getValue().includes('&lt;business note&gt;'));
    assert.equal(await page.locator('#save-status').textContent(), '');
    if (await page.locator('#files .file').count() > 1) {
      const firstFile = await page.locator('#filename').textContent();
      await page.locator('#hit-next').click();
      await page.waitForFunction(first => document.querySelector('#filename').textContent !== first
        && document.querySelectorAll('[name=choice]').length === 4, firstFile);
      await page.locator('#hit-previous').click();
      await page.waitForFunction(first => document.querySelector('#filename').textContent === first
        && document.querySelectorAll('[name=choice]').length === 4, firstFile);
    }
  }
  if (!real) {
    await choosePurpose('regex');
    await page.locator('#regex-query').fill('<p>');
    await page.locator('#regex-replacement').fill('<p class="reviewed">');
    await page.locator('#regex-replacement').press('Enter');
    await page.waitForFunction(() => proposalReady && !document.querySelector('#proposal-diff').hidden);
    assert(await page.locator('.scan-reference').isHidden());
    await page.locator('#regex-replacement').fill('<p class="checked">');
    assert(await page.locator('#save').isDisabled());
    await page.locator('#regex-run').click();
    await page.waitForFunction(() => proposalReady);
    assert(await page.locator('#save').isEnabled());
  }
  // Keyboard navigation works after a button click and stops at boundaries.
  await page.locator('#show-review').focus();
  await page.evaluate(() => selectHit(0));
  await page.keyboard.press('Shift+F4');
  assert.equal(await page.evaluate(() => state.hit), 0);
  await page.keyboard.press('F4');
  assert.equal(await page.evaluate(() => state.hit), await page.evaluate(() => Math.min(1, state.hits.length - 1)));
  await page.locator('#search').fill('no-such-review-file');
  assert(await page.locator('#files .empty-state').isVisible());
  await page.locator('#reset-filters').click();
  await page.waitForFunction(() => state.document && state.hits.length);
  assert.equal(await page.locator('#search').inputValue(), '');
  await page.locator('#toggle-findings').click();
  assert(await page.locator('#findings').isHidden());
  await page.locator('#advanced-filters').evaluate(node => { node.open = false; });
  const artifacts = await mkdtemp(path.join(tmpdir(), 'html-pattern-review-qa-'));
  await page.screenshot({ path: path.join(artifacts, 'desktop.png') });
  await page.locator('#show-originals').click();
  await page.waitForSelector('#originals-pane figure');
  await page.screenshot({ path: path.join(artifacts, 'originals-desktop.png') });
  await page.setViewportSize({ width: 640, height: 1000 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: path.join(artifacts, 'originals-mobile.png'), fullPage: true });
  await page.locator('#show-review').click();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: path.join(artifacts, 'mobile.png'), fullPage: true });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, real, styles, screenshots: artifacts }));
} finally {
  await browser?.close();
  server.kill();
  if (server.exitCode === null) await once(server, 'exit');
}
