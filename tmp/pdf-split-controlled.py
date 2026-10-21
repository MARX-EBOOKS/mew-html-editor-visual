from pathlib import Path
p=Path('tests/replacement-review-browser.mjs');s=p.read_text(encoding='utf-8')
a=s.index("      await page.evaluate(() => {\n        const viewer = ReaderUI.getPdfViewer(), div = viewer.getPageView(0).div;")
b=s.index("      await page.waitForFunction(() => window.splitTargetIndex",a)
s=s[:a]+'''      await page.evaluate(() => {
        const stage = document.createElement('div');
        stage.style.cssText = 'position:fixed;left:400px;top:60px;width:400px;height:500px;overflow:auto';
        stage.innerHTML = '<div class="pdfViewer"><div class="page" style="position:relative;height:500px"><div class="textLayer"><span style="position:absolute;left:80px;top:100px;font-size:20px">RIGHT</span></div></div></div>';
        document.body.append(stage);
        const div = stage.querySelector('.page'), layer = div.querySelector('.textLayer');
        window.addEventListener('pdf-selection-sources', event => {
          const target = event.detail.targets.find(target => target.layer === layer);
          if (target) window.splitTargetIndex = target;
        });
        const viewer = { container: stage, viewer: stage.firstChild, currentPageNumber: 1,
          _getVisiblePages: () => ({ views: [{ id: 1 }] }), getPageView: () => ({ div }), eventBus: { on() {}, off() {} },
          pdfDocument: { numPages: 1, async getPage() { return { async getTextContent() {
            return { items: [{ str: 'RIGHT', transform: [1,0,0,1,0,500], width: 50, height: 20 }] };
          } }; } } };
        ReaderUI.getPdfViewer = () => viewer;
        PdfSelection.attachViewer(viewer);
      });
'''+s[b:];p.write_text(s,encoding='utf-8')
