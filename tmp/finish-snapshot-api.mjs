import fs from 'node:fs';
let path='public/pdfdiff/pdf-selection.js',s=fs.readFileSync(path,'utf8').replace(/\bdiff\b/g,'locator').replace('locator: locator,','locator,');fs.writeFileSync(path,s);
for(const path of ['tests/pdf-selection-diff.test.mjs','tests/pdf-selection-highlight.test.mjs']) {
 const s=fs.readFileSync(path,'utf8').replace('    const diff = this;','    const locator = this;');fs.writeFileSync(path,s);
}
path='pdf-selection.md';s=fs.readFileSync(path,'utf8');
s=s.replace('model/PDF pair owns one current source snapshot. The environment supplies the current PDF, rendered page', 'model/PDF pair owns one current `PdfSourceIndex` snapshot. Each snapshot exposes\n`source`, `raw`, normalized text, offsets, fonts, and connection caches. Mapping\nmethods operate on their owning snapshot: `index.connectedRange(target, ...)`,\n`index.rememberConnection(...)`, `index.locate(entry, scope)`, and `index.matches(queries)`.\nScoped locations already return absolute offsets. Editor, full-PDF, and rendered-page\nindexes use the same class; `rawRange()` and `partsInRange()` own coordinate lookups.\nThe reader locator retains model/PDF caches, indexing, and preparation. Its HTML\nentity-decoding template is reused across source snapshots.\nThe environment supplies the current PDF, rendered page');
fs.writeFileSync(path,s);
path='replacement-review.md';s=fs.readFileSync(path,'utf8');s=s.replace('调用前等待 `PdfReviewReady` 完成初始化。', '调用前等待 `PdfReviewReady` 完成初始化。`PdfLocator` 管理读取和缓存，每个 `PdfSourceIndex` 保存自己的公开 `source/raw`、坐标和连接；定位调用改为 `index.locate()`、`index.connectedRange()` 等实例方法。\n\n`ReviewHighlights.measureHighlights()` 通过索引的 `partsInRange(start, end)` 获取文字节点范围，复用弹窗锚点的坐标查找；`ReviewHighlights.create()` 不再接收 `lowerBound`。公共高亮模块只依赖这个索引接口，不导入 PDF 类。');
fs.writeFileSync(path,s);
