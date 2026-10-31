import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { launchBrowser } from './support/browser.mjs';

import { textEditFixture } from './support/pdf-harness.mjs';

const scripts = new Map(await Promise.all([
  'pdf-selection-diff.js', 'pdf-review-provider.js', 'replacement-review.js', 'pdf-selection.js'
].map(async name => [name, await readFile(new URL(`../public/pdfdiff/${name}`, import.meta.url), 'utf8') + (name === 'pdf-selection-diff.js' ? textEditFixture : '')])));

test('diff engine stays within 930 physical lines', () => {
  const source = scripts.get('pdf-selection-diff.js');
  assert.ok(source.split(/\r?\n/).length - Number(source.endsWith('\n')) <= 930);
});

for (const order of [
  ['pdf-review-provider.js', 'pdf-selection.js'],
  ['replacement-review.js', 'pdf-review-provider.js', 'pdf-selection.js'],
  ['pdf-selection.js']
]) {
  test(`real provider API and callbacks: ${order.join(' → ')}`, async () => {
    const browser = await launchBrowser();
    try {
      const page = await browser.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', event => { if (event.type() === 'error') errors.push(event.text()); });
      await page.route('http://review.test/**', async route => {
        const url = new URL(route.request().url());
        if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body:
          '<body><div id="replacementFeatures"></div>' + order.map(name => `<script src="/pdfdiff/${name}"></script>`).join('') });
        if (url.pathname === '/api/reader/settings') return route.fulfill({ json: {} });
        // Exercise the supported local-diff fallback without a Monaco server.
        if (url.pathname.startsWith('/monaco/')) return route.fulfill({ contentType: 'text/javascript', body: 'throw new Error("Monaco unavailable in API fixture");' });
        const source = scripts.get(url.pathname.replace('/pdfdiff/', ''));
        assert.ok(source, `unexpected request: ${url.pathname}`);
        return route.fulfill({ contentType: 'text/javascript', body: source });
      });
      await page.goto('http://review.test/');
      await page.waitForFunction(() => window.PdfSelection);
      const result = await page.evaluate(async () => {
        const api = await window.PdfReviewReady;
        const methods = ['measureHighlights', 'paintHighlight', 'clearHighlights', 'getHighlight', 'selectionRange'];
        if (api !== window.PdfReviewProvider || typeof api.PdfLocator !== 'function' ||
          methods.some(name => typeof api.highlights[name] !== 'function' || name in api))
          throw new Error('Highlights must be accessed through their owning instance');
        if (typeof PdfSelectionDiff.PdfSourceIndex.prototype.sourceDecorations !== 'function' || 'sourceDecorations' in PdfSelectionDiff || 'sourceDecorations' in api)
          throw new Error('Source decorations must belong to PdfSourceIndex');
        if ('connectionDiff' in api || 'textDifferences' in api) throw new Error('Obsolete diff helpers remain exported');
        if ('PdfSourceIndex' in api || 'reviewCandidates' in api) throw new Error('Index operations must belong to the diff engine');
        if (['normalized', 'lowerBound', 'htmlFontDefinition'].some(name =>
          typeof PdfSelectionDiff[name] !== 'function' || name in PdfSelection.locator || name in PdfSelectionDiff.PdfSourceIndex))
          throw new Error('Stateless helpers must remain outside the class without locator wrappers');
        if (['reviewCandidates', 'connectionPairs', 'connectionDiff', 'fontRuns', 'fontEdits', 'formatDifferences', 'sourceSegments', 'sourceDecorations', 'textEdits']
          .some(name => typeof PdfSelectionDiff.PdfSourceIndex.prototype[name] !== 'function' || name in PdfSelectionDiff))
          throw new Error('Index operations must be exported on the complete class');
        if (['readPageText', 'readPageFonts', 'layerFonts'].some(name =>
          typeof api.PdfLocator.prototype[name] !== 'function' || name in PdfSelectionDiff || name in api))
          throw new Error('Data reading must belong to PdfLocator');
        if (['fontStyle', 'textItemFont', 'textItemBaseline', 'sourceHover'].some(name =>
          typeof api.locator[name] !== 'function' || name in api || name in PdfSelectionDiff))
          throw new Error('Font metadata and hover methods must be accessed through PdfLocator');
        if (!(PdfSelection.locator instanceof api.PdfLocator)) throw new Error('Selection uses a different provider');
        let value = '<p>Before WRONG after.</p>', version = 1;
        const model = { getValue: () => value, getVersionId: () => version,
          getPositionAt: offset => ({ lineNumber: 1, column: offset + 1 }),
          getOffsetAt: position => position.column - 1 };
        const noop = () => ({ dispose() {} });
        const editor = { getModel: () => model, getDomNode: () => document.body, getOption: () => false,
          onDidChangeModel: noop, onDidChangeModelContent: noop, onDidScrollChange: noop,
          getSelection: () => null, setSelection() {}, revealRangeInCenterIfOutsideViewport() {}, pushUndoStop() {}, focus() {},
          executeEdits(origin, edits) {
            for (const edit of [...edits].reverse()) value = value.slice(0, edit.range.startColumn - 1)
              + edit.text + value.slice(edit.range.endColumn - 1);
            version++; return true;
          } };
        let currentToolbox;
        const unregister = ReplacementReview.register({ id: 'api-context', label: 'API context',
          provide(context) { currentToolbox = context.toolbox; return []; } });
        await ReplacementReview.open('api-context', editor);
        if (currentToolbox !== window.PdfSelectionDiff) throw new Error('Popup captured an unavailable toolbox');
        ReplacementReview.close(); unregister();
        const locator = PdfSelection.locator, index = locator.editorSourceIndex(model);
        const target = locator.sourceIndex('<p>Before RIGHT after.</p>');
        const connection = index.rememberConnection(0, index.raw.length, target, { start: 0, end: target.raw.length });
        const marks = index.sourceDecorations(index.reviewCandidates(null, true, false, true, [], [[connection, target]]), true, true, undefined, model);
        const combined = [
          ['<i>heine</i>', 'keine'], ['<i>keXne</i>', 'keine'], ['<i>keinX</i>', 'keine'],
          ['<i>heeine</i>', 'keine'], ['<i>heine Worte</i>', 'keine Worte'],
          ['<i>he<b>in</b>e</i>', 'keine'], ['heine', 'keine'], ['<i>keine</i>', 'keine'],
          ['<i>heine</i>', 'keine+'], ['<i>keineX</i>', 'keine'], ['<i>Xkeine</i>', 'keine'],
          ['<i> </i><b> </b>', 'XYZ']
        ].map(([markup, raw]) => {
          const source = locator.sourceIndex(markup);
          const pdf = new PdfSelectionDiff.PdfSourceIndex(locator, { raw,
            parts: [{ start: 0, end: raw.length, font: { italic: false, bold: false } }] });
          const pair = source.rememberConnection(0, source.raw.length, pdf, { start: 0, end: raw.length });
          const decorations = source.sourceDecorations(source.reviewCandidates(null, true, false, true, [pdf], [[pair, pdf]]), true, true, item => PdfReviewProvider.locator.sourceHover(item, model), model);
          const text = source.reviewCandidates(null, false, true, true, [pdf]);
          return { ranges: decorations.map(({ range }) => markup.slice(range.startColumn - 1, range.endColumn - 1)),
            textRanges: decorations.filter(mark => mark.options.inlineClassName === 'mew-ocr-diff-text')
              .map(({ range }) => markup.slice(range.startColumn - 1, range.endColumn - 1)),
            fontRanges: decorations.filter(mark => mark.options.inlineClassName?.includes('mew-font-diff-text'))
              .map(({ range }) => markup.slice(range.startColumn - 1, range.endColumn - 1)),
            combined: decorations.filter(mark => mark.options.description === 'PDF text and font difference')
              .every(mark => mark.options.hoverMessage.value.includes('PDF:') && mark.options.hoverMessage.value.includes('斜体')),
            duplicateRanges: decorations.some((mark, at) => !mark.options.before?.inlineClassName
              && decorations.slice(at + 1).some(other => !other.options.before?.inlineClassName
                && mark.range.startColumn === other.range.startColumn && mark.range.endColumn === other.range.endColumn)),
            hover: decorations.flatMap(mark => [mark.options.hoverMessage].flat().map(message => message.value)),
            carets: decorations.filter(mark => mark.options.before?.inlineClassName).length,
            replaced: PdfSelectionDiff.applyTextEdits(markup, text.flatMap(item => item.options[0].edits)) };
        });
        const pdf = {};
        window.ReaderUI = { getPdfViewer: () => ({ pdfDocument: pdf }) };
        const start = index.raw.indexOf('WRONG'), end = start + 5;
        const request = { pdf, targets: [target], notice: { html: 'WRONG', pdf: 'RIGHT', source: { index, start, end },
          target: { index: target, start, end } } };
        await ReplacementReview.open('pdf-ocr', editor, `${start}:${end}`, 0, request);
        const panel = document.querySelector('.replacement-review');
        const comparison = [...panel.querySelectorAll('[data-comparison] mark')].map(node => node.textContent);
        panel.querySelector('[data-apply]').click();
        await new Promise(resolve => setTimeout(resolve, 0));
        const position = panel.querySelector('[data-position]').textContent;
        ReplacementReview.close();
        return { value, comparison, position, marks: marks.length, combined };
      });
      assert.equal(result.value, '<p>Before RIGHT after.</p>');
      assert.deepEqual(result.comparison, ['WRONG', 'RIGHT']);
      assert.equal(result.position, '0 / 0', 'provider refresh removes the applied candidate');
      assert.ok(result.marks > 0, 'public provider creates source decorations');
      assert.deepEqual(result.combined.map(item => item.fontRanges), [
        ['heine'], ['keXne'], ['keinX'], ['heeine'], ['heine Worte'],
        ['he', 'in', 'e'], [], ['keine'], ['heine'], ['keineX'], ['Xkeine'], []
      ], 'continuous text and font discrepancies share the complete range');
      assert.ok(result.combined.every(item => item.combined && !item.duplicateRanges),
        'combined decorations include both hover details without duplicate ranges');
      assert.deepEqual(result.combined.slice(0, 3).map(item => item.textRanges), [['heine'], ['keXne'], ['keinX']],
        'text discrepancies highlight the whole overlapping font segment');
      assert.deepEqual(result.combined[6].textRanges, ['h'], 'text-only differences remain highlighted');
      assert.deepEqual(result.combined[7].textRanges, [], 'font-only differences create no text decoration');
      assert.ok(result.combined[0].hover.some(value => value.includes('PDF:')));
      assert.ok(result.combined[0].hover.some(value => value.includes('PDF: 斜体')));
      assert.equal(result.combined[8].carets, 1, 'overlapping font differences preserve the missing-text caret');
      assert.equal(result.combined[0].replaced, '<i>keine</i>', 'text edits retain their original precise range');
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
  });
}

test('production modules share default marks, popup offsets and grouped replacements', async () => {
  const browser=await launchBrowser();
  try {
  const page=await browser.newPage({viewport:{width:1200,height:900}}), errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('http://shared-review.test/**',route=>{
   const p=new URL(route.request().url()).pathname;
   if(p==='/api/reader/settings')return route.fulfill({json:{diffHighlight:true,sourceDiffHighlight:true,selectionHighlight:false}});
   if(p.startsWith('/monaco/'))return route.fulfill({contentType:'text/javascript',body:'throw new Error("fallback fixture")'});
   return route.fulfill({contentType:'text/html',body:'<div id="editor" style="width:800px;height:400px"></div><div id="stage" style="position:relative;width:800px;height:300px;overflow:auto"><div class="pdfViewer"><div class="page" data-page-number="1" style="position:relative;width:800px;height:300px"><div class="textLayer"><span role="presentation">Alpha right beta right end.</span></div></div></div></div>'});
  });
  await page.goto('http://shared-review.test/');
  await page.evaluate(()=>{
   window.source='<p>Alpha wrong beta wrong end.</p>'; window.version=1; window.selections=[];
   const wrap=r=>({...r,isEmpty:()=>r.startColumn===r.endColumn,getPosition:()=>({lineNumber:1,column:r.endColumn}),equalsRange:other=>other?.startColumn===r.startColumn&&other?.endColumn===r.endColumn});
   const model={getValue:()=>source,getVersionId:()=>version,getPositionAt:offset=>({lineNumber:1,column:offset+1}),
    getOffsetAt:pos=>pos.column-1,validateRange:r=>r,getLanguageId:()=> 'html'};
   window.editor={getModel:()=>model,getDomNode:()=>document.getElementById('editor'),createDecorationsCollection:()=>({set(){},clear(){}}),
    setPosition() {},getSelection:()=>window.selected||null,setSelection(r){window.selected=wrap(r);selections.push([r.startColumn,r.endColumn]);},
    revealRangeInCenterIfOutsideViewport(){},getScrolledVisiblePosition:()=>({top:20,left:0,height:20}),getOption:()=>false,pushUndoStop(){},focus(){},
    executeEdits(origin,edits){for(const edit of [...edits].reverse())source=source.slice(0,edit.range.startColumn-1)+edit.text+source.slice(edit.range.endColumn-1);version++;return true;}};
   const item={str:'Alpha right beta right end.',transform:[1,0,0,1,0,280],width:240,height:20,fontName:'fixture'},
    pdfPage={getTextContent:async()=>({items:[item]}),commonObjs:new Map()};
   const div=document.querySelector('.page'), stage=document.getElementById('stage');
   window.mockViewer={container:stage,viewer:stage.firstChild,currentPageNumber:1,eventBus:{on(){},off(){}},
    pdfDocument:{numPages:1,getPage:async()=>pdfPage},_getVisiblePages:()=>({views:[{id:1}]}),scrollPageIntoView(){},
    getPageView:()=>({div,pdfPage,viewport:{width:800,height:300,scale:1,convertToViewportPoint:(x,y)=>[x,300-y]}})};
   window.ReaderUI={getPdfViewer:()=>mockViewer,getSourceEditor:()=>editor,getPdfSourcePages:()=>[1]};
  });
  for(const name of ['pdf-selection-diff.js','replacement-review.js','pdf-review-provider.js','pdf-selection.js'])
   await page.addScriptTag({type:'module',content:scripts.get(name)});
  await page.waitForFunction(()=>window.PdfSelection,{},{timeout:5000});
  await page.evaluate(()=>PdfSelection.refresh());
  await page.waitForFunction(()=>document.querySelector('.mew-pdf-review-pointer')?.children.length>0,{},{timeout:7000});
  await page.evaluate(async()=>{
   const locator=PdfSelection.locator,model=editor.getModel(),index=locator.editorSourceIndex(model),target=await locator.indexDocument(mockViewer.pdfDocument,[1]);
   const data=await locator.reviewItems({model,editor,source:model.getValue(),signal:new AbortController().signal});
   if(locator.model!==model||locator.index!==data.index||locator.reviewItems()!==data)throw new Error('Direct class entry must reuse prepared review data synchronously');
   await ReplacementReview.open('pdf-ocr',editor,'6:11',0,{pdf:mockViewer.pdfDocument,targets:[target],notice:{html:index.raw,pdf:'Alpha right beta right end.\nX',source:{index,start:0,end:index.raw.length}}});
  });
  const markCount=await page.locator('[data-comparison] mark').count();assert.ok(markCount>=2);
  const clicked=await page.evaluate(()=>{
   const captured=[];window.addEventListener('pdf-selection-difference',e=>{captured.push([e.detail.notices[0].source.start,e.detail.notices[0].source.end]);e.stopImmediatePropagation();},{capture:true});
   for(const mark of document.querySelectorAll('[data-comparison] mark'))mark.click();return captured;
  });
  assert.equal(clicked.length,markCount);
  assert.ok(clicked.some(([a,b])=>a===b),'an empty HTML counterpart retains its insertion offset');
  assert.deepEqual(clicked.slice(0,markCount/2),clicked.slice(markCount/2),'both rows carry the same source coordinates');
  await page.evaluate(async()=>{
    const locator=PdfSelection.locator,index=locator.editorSourceIndex(editor.getModel()),target=await locator.indexDocument(mockViewer.pdfDocument,[1]);
    await ReplacementReview.open('pdf-ocr',editor,'6:11',0,{pdf:mockViewer.pdfDocument,targets:[target],notice:{html:'wrong',pdf:'right',source:{index,start:6,end:11}}});
  });
  await page.evaluate(()=>document.querySelector('[data-advance]').click());
  await page.waitForFunction(()=>!source.includes('wrong'));
  assert.equal(await page.evaluate(()=>source),'<p>Alpha right beta right end.</p>');
  assert.deepEqual(errors,[]);
  await page.evaluate(()=>ReplacementReview.close(false,false));
  } finally { await browser.close(); }
});
