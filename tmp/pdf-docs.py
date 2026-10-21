from pathlib import Path
p=Path('pdf-selection.md');s=p.read_text(encoding='utf-8')
s=s.replace('''`pdf-review-provider.js` imports `pdf-selection-diff.js`, which loads the Monaco
diff engine and imports `local-text-diff.js` only if that load fails.
One cached initialization selects the engine for every `textDiff()` caller;
selection, review, mapping, and distance scoring use that same choice.''','''`pdf-review-provider.js` loads the mapping engine, the shared text toolbox, and
`replacement-review.js`, which owns the reusable review session and popup shell.
`local-text-diff.js` contains normalization/search, edit transactions, and both text
comparison implementations. Bounded OCR changes use its local comparison; larger
changes use Monaco when available and fall back locally on failure.''')
s=s.replace('Review UI and PDF provider callbacks share `pdf-review-provider.js`, documented in [replacement-review.md](replacement-review.md).',
 'The provider supplies PDF content and actions to the shared popup host, documented in [replacement-review.md](replacement-review.md).')
s=s.replace('''Font comparison calls text alignment directly.''','''`differences()` classifies text changes and unchanged font runs in one traversal
per connection; candidates and decorations reuse that result until the source,
connection diff, or PDF font version changes.''')
s=s.replace('''`pdf-selection.js`; popup state and provider actions live in `pdf-review-provider.js`.''','''`pdf-review-provider.js`; popup session state lives in `replacement-review.js`.
Rendered layer indexes use a 24-page LRU; evicted layer observers are disconnected.
Each retained page keeps at most 32 geometry results. Per-target transient selection
mappings keep at most 128 entries, while required prepared passage mappings remain
available. Page preparation ignores LRU ordering and prunes contained mappings with
a sorted sweep instead of comparing every pair.''')
p.write_text(s,encoding='utf-8')
p=Path('replacement-review.md');s=p.read_text(encoding='utf-8')
s=s.replace('- `public/pdfdiff/pdf-review-provider.js`：统一注册入口、弹窗、会话、前后条导航及分窗位置；PDF 文字/格式候选、差异标记、替换和剩余坐标更新。原 `replacement-review.js` 已合并到这里，保留 `ReplacementReview` 注册接口供其他审阅功能共用。',
 '- `public/pdfdiff/pdf-review-provider.js`：统一加载入口，提供 PDF 文字/格式候选、弹窗内容、分窗位置、差异标记和替换操作。\n- `public/pdfdiff/replacement-review.js`：共用弹窗、会话、前后条导航、保存及分窗切换；通过 `ReplacementReview` 注册接口接收各功能的展示数据和操作。')
s=s.replace('- `public/pdfdiff/pdf-selection-diff.js`：共用定位、文字与字体差异、字体缓存和源码编辑工具；紧密耦合的粗斜体逻辑合并在同一闭包内，由 provider 统一加载。',
 '- `public/pdfdiff/pdf-selection-diff.js`：定位、映射、字体元数据和统一差异遍历；文字候选、格式候选与高亮共用遍历结果。\n- `public/pdfdiff/local-text-diff.js`：共用文字比较、规范化搜索、编辑校验和 Monaco 编辑事务；替换直接使用已生成的候选编辑。')
p.write_text(s,encoding='utf-8')
