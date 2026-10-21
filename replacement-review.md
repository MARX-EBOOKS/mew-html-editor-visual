# 编辑器审阅弹窗与前后条导航

`index.html` 和 `reader.html` 共用“审阅 / 批量替换”菜单。

- `public/pdfdiff/pdf-review-provider.js`：统一加载入口，管理共用弹窗、会话、前后条导航、保存、分窗切换、PDF 文字/格式候选、差异标记和替换操作；保留 `ReplacementReview` 注册接口，供各功能提交展示数据和操作。
- `public/pdfdiff/pdf-selection-diff.js`：文字比较、规范化搜索、映射、字体元数据、统一差异遍历及编辑事务都在同一个脚本中。读取 OCR 页数据时同步启动字体探测；源码与 PDF 文字完成对齐后才比较样式。文字候选、格式候选与高亮共用遍历结果；替换直接使用已生成的候选编辑。
- `public/pdfdiff/pdf-selection.js`：PDF 与源码选区的双向定位、选区跟踪和滚动；发布已准备好的映射数据，不创建弹窗或判断字体差异。

Provider 统一管理 PDF 高亮区域的测量、合并、绘制、缓存与清理；选区模块仅传入映射后的范围。

各功能只提交展示数据与操作回调，不创建自己的弹窗。PDF 紧凑弹窗保留对照、替换和前后条；分窗时仍可切换“查看PDF / 查看HTML”，携带当前候选与选择，不重新计算、不替换内容。

## 注册接口

```javascript
ReplacementReview.register({
  id: 'format-rule', label: '格式替换',
  provide(context) {
    // 由功能脚本发现候选、校验编辑坐标。
    return [{ id: 'example', options: [{ id: 'fix', label: '修正' }] }];
  },
  content(state, item) {
    return {
      message: item ? '检查本条格式' : '没有候选。',
      options: item?.options || [],
      comparison: [{ label: '说明', parts: [{ text: '由功能脚本生成的内容', changed: false }] }],
      range: item?.range,
      applyLabel: '修正', expanded: false, advance: false
    };
  },
  apply(state, all) {
    // 功能脚本调用编辑器或 toolbox.applyEdits，负责校验、撤销与剩余候选。
    // 返回更新后的 items、choices、position、source、version 等会话字段。
    return state;
  }
});
```

`provide(context)` 接收 `editor/model/source/version/signal/toolbox/request`，返回候选数组或 `{ items }`。每个候选有唯一字符串 `id`，每个选项有唯一字符串 `id`。首项默认选中，选择保存于 `state.choices`。

`content(state, item)` 定义弹窗内容；没有当前候选时 `item` 为 `undefined`。`comparison` 是行数组，每行包含 `label` 和 `parts: [{ text, changed }]`，由公共弹窗以纯文本渲染。`range` 控制源码选区。`options` 定义显示的单选项；`applyLabel` 定义操作文字；`advance/expanded/all: false` 可隐藏对应操作。`title` 可覆盖注册名称。公共模块不推导 HTML/PDF 对照、替换范围或裁剪方式。

`apply(state, all)` 可以同步或异步返回更新后的会话字段。`state` 包含当前编辑器、模型、原文与版本、候选数组、当前 `position`、选项 `choices` 和发现上下文 `context`。功能脚本负责实际修改、只读与冲突检查，以及候选移除和坐标维护；公共模块只防止重复操作、更新返回的会话、渲染结果或显示错误。`all` 仅表示当前文件全部候选，不批量改写其他文件。

需要展开 diff 时，提供 `preview(state, wholeFile)`，返回 `{ before, after, language }`；公共模块只负责 Monaco diff 渲染和模型释放。业务脚本负责生成预览内容。

可选接口保留 `isEnabled/setEnabled/available/isCurrent/onSelect/presentation`。`focusIndex(items, request)` 决定选区请求的候选回退位置，`containsSelection(item, request)` 判断选区是否属于当前候选。仅有 `setEnabled` 的功能注册为独立开关。`ReplacementReview.invalidate(id)` 使外部依赖变化后的会话失效并自动重新计算。

## 当前文件前后条

公共弹窗仅在当前文件的候选中移动，到首尾后禁用对应方向；没有候选时禁用前后条。不读取全局文件列表，也不自动打开其他文件。

切换编辑器模型或整体载入文件内容时关闭旧弹窗，不显示旧会话的“重新计算”提示。点击当前高亮差异内或手动修改文本时保留弹窗；点击其他位置关闭弹窗。同一文件内的普通编辑自动更新候选，输入停顿 300 毫秒后计算，输入法组合期间等待组合结束。检测到手动修改后显示保存提醒，按钮改为“保存修改”，仅保存当前内容，不替换下一条；保存成功后恢复“替换&保存”。正常的“替换&保存”先替换当前候选，成功后保存，替换失败时不保存。手动修改仅更新已有候选：删除已修正项、平移其他项坐标，未完全修正时只对该候选重新比较，不重新发现全文件候选。对照 PDF 变化也自动重新计算。PDF 单条替换继续使用当前候选，不重新提取全文，更新剩余候选的源码坐标；与修改冲突的候选移除。

独立 `html_pattern_review/` 页面及其 Python 保存接口保持原有工作流。

验证入口：`node tests/replacement-review-browser.mjs`（编辑器、阅读器、当前文件前后条及边界、换文件关闭弹窗、共享弹窗、PDF 替换及分窗）；`node --test tests/pdf-selection-diff.test.mjs tests/pdf-selection-highlight.test.mjs`（定位与高亮）。浏览器 PDF 差异测试使用受控文字层，不代表整卷扫描 PDF 验证。
