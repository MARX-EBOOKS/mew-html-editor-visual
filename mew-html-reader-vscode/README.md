# MEW HTML / PDF Reader

这是从 `mew-html-editor-vscode` 标签编辑扩展继续开发的独立 VS Code 扩展。HTML 使用 VS Code 原生文本编辑器；PDF 像 `mathematic.vscode-pdf` 一样注册为 VS Code 只读 Custom Editor，并在其中运行 PDF.js。标签页被用户执行“移到新窗口”后仍会继续接收同步消息；重新打开工作区/文件夹时，由 VS Code 根据真实 PDF URI 恢复另窗编辑器，扩展再恢复对应 HTML 和页码映射。

## 配置

标签栏中的“另窗打开 ↗”（或命令 `MEW Reader: 在新窗口打开标签插入栏`）会创建独立浮动窗口并默认启用 VS Code 紧密模式。拖动、缩放窗口，并在窗口标题栏选择“Set Always on Top / 置顶”，即可悬浮在文件上方。标签和属性仍作用于最后激活的文本编辑器及其选区；先在目标文件选择文字，再点击浮动栏即可。

另窗与停靠标签栏互斥：另窗打开时，无论停靠栏位于底部、左侧还是右侧都会自动隐藏；按 `Ctrl+Alt+M` 或点击编辑器右上角的标签栏图标（`MEW Reader: Show Tag Bar`）会将已打开的独立窗口唤到前台；没有独立窗口时显示停靠栏。点击“返回标签栏 ↙”会关闭另窗并恢复原停靠位置。VS Code 负责保存并恢复另窗的位置、大小和紧密状态，扩展在恢复时重新绑定标签栏内容及互斥状态；这些窗口布局不写入工作区 JSON。

把 `mew-reader.example.json` 复制为 HTML 项目中的 `.mew-reader.json`。扩展从当前 HTML 所在目录向上查找配置，直到工作区根目录。也可以设置 `mewReader.configFile` 指定 JSON；相对路径以所属工作区文件夹为基准。

如果一路找不到 JSON，或者当前文件不属于配置中的卷册，标签栏仍按原 `mew-html-editor-vscode` 的方式工作：前后按钮按 VS Code Explorer 排序切换同目录普通文件，并在首尾循环。

单卷配置示例见 `mew-reader.example.json`。多卷配置使用 `{ "volumes": [ ... ] }`，每个条目可配置 `id`、`title`、`shortTitle`、`htmlRoot`、`pdf`、`pagePattern` 和 `pageLabel`。

- `pagePattern` 必须包含命名捕获组 `(?<page>...)`，或把页码放在第一个捕获组。
- `pageLabel` 默认 `{page}`，用来把 HTML 页码映射到 PDF Page Label。
- 相对路径均以 JSON 文件所在目录为基准。
- 上一页/下一页只走实际存在的匹配 HTML 页面，不首尾循环；切换文件时保留 VS Code 的未保存状态，由 VS Code 统一管理保存。
- PDF 内滚动到带数字前缀的 Page Label 时会直接反向打开相应 HTML，不再触发保存或等待保存。
- PDF 页眉提供左右/上下翻页模式、扫描件亮度与背景/文字颜色、反色、页码跳转、前后页和缩放控件；这些显示设置保存在 PDF Webview 状态中。
- 本地 PDF（≤128 MiB）由扩展直接读取，通过二进制消息交给 PDF.js Worker；避免 Webview 文件服务中转和 Base64 编码。更大的文件和非本地 URI 使用显式 Range 读取；不支持 Range 的文件提供方只读取一次完整响应。翻页和重复同步同一卷复用已打开文档，页面按需渲染。
- Worker 源码在 Webview 中读取，再从 Blob 启动真实后台线程；字体、图片解码 WASM 由所属 Webview 代理读取，ICC 色彩配置预先准备为本地 Blob。这样避开 VS Code 对 Worker 资源请求的约 30 秒超时，并保留 PDF.js 的图像解码和色彩管理。

## PDF 差异审阅

PDF 文本映射、差异计算和字体检测复用当前 `pdf-selection-diff.js` 与 `pdf-review-provider.js`。扩展内的 `replacement-review.js`、`pdf-selection.js` 是 VS Code 专用实现，分别负责审阅操作与选区、高亮同步；两者同时提供扩展宿主入口和 PDF Webview 入口，复用同一份探测候选。

`editor-core.js` 的 `VSCodeController` 负责在 Webview 中接收源码快照、发送原生操作请求。`replacement-review.js` 直接注册 VS Code 悬浮提示、代码操作、补全和原生 diff 预览，执行带文件、版本校验的编辑和保存；`pdf-selection.js` 直接订阅文档及选区变化并设置原生高亮。`extension.cjs` 只加载模块，不保留 `PdfReview` 类。设置保存在扩展 `globalState`。`prepare-assets.mjs` 只同步通用探测文件和样式，不覆盖这两个专用模块。

## 性能验证

`node test/pdf-vscode.mjs <PDF绝对路径>` 启动独立 VS Code 开发实例，测试从 PDF Webview 启动到第 300 页完成渲染的时间，并检查真实 Worker、翻页、同卷复用、100% 缩放、翻页方向与显示设置。通过标准为目标页小于 5 秒；不包括 VS Code 应用本身的冷启动。结果和截图写入 `test/artifacts/`。

2026-09-09，本机 VS Code 1.136.2：69.9 MB / 935 页原来约 31 秒，修复后约 1 秒；54.1 MB / 1,016 页约 1.6 秒；两卷真实扫描页合成的 95.4 MB / 1,763 页测试文件约 2.1 秒。未清空操作系统文件缓存，不代表所有机器、网络文件或复杂单页都能达到相同耗时。源 PDF 内容不改写、不降采样。

## 开发与安装

```powershell
npm install
npm run check
npm run package
```

然后在 VS Code 中安装生成的 `.vsix`。首次创建 PDF 页签的位置由 `mewReader.pdfOpenLocation` 控制：`beside` 为右侧、`active` 为当前编辑器组、`newWindow` 会调用当前 VS Code 的原生“将编辑器移到新窗口”命令。创建后也可随时手动移动 PDF 页签；后续同步不会调用 `reveal()` 把它移回。

右上角“复制本页图片”复制当前页像素面积最大的内嵌图片，按图片自身尺寸解码为 PNG 写入剪贴板，不截取页面、不应用阅读配色或缩放。无内嵌图片时提示。图片读取和编码仅在点击时执行。

扩展宿主重启恢复：若 VS Code 保留了未重新绑定的 PDF 页签，插件会在原编辑器组内自动重建它，并保留独立窗口。页码、缩放和翻页方向等恢复状态保存在当前工作区的 `workspaceState`（`mewReader.pdfSession`）；扫描显示设置仍保存在全局 `globalState`。网页模板、恢复辅助逻辑、标签定义、标签编辑与同步控制都在 `extension.cjs`，配置与排序辅助逻辑在 `reader-core.cjs`。


### 0.1.5 窗口与焦点修复

PDF 自动同步 HTML 保留当前焦点，过期的文件打开请求会被丢弃。修复恢复未知类型标签时的启动错误。

标签栏首次另窗打开使用 VS Code 原生普通窗口和紧密模式，不强制调整尺寸或置顶，不运行外部脚本。标题栏中间按钮由 VS Code 原生处理最大化和向下还原。再次显示标签栏时复用已有窗口；重启后优先接管 VS Code 恢复的标签栏，保留其大小、位置及窗口状态，不重新创建或重设。这一复用范围是所属 VS Code 主窗口及其辅助窗口，不是跨独立工作区共享同一个窗口。
