# HTML pattern review

在 `mew-html-editor-visual` 目录运行：

```powershell
python -m pip install PyMuPDF Pillow
npm install
python -B html_pattern_scripts/html_pattern_review.py
```

打开 http://127.0.0.1:8765 。默认直接加载与 `reader-server.js` 相同的书库 JSON，
不再通过固定 `MEW_BRIEF` 目录和 `mew_bandXX.pdf` 文件名推测配置。

阅读器后端现已迁移到 `reader-server.py`，原 `reader-server.js` 保留为启动兼容入口。
两套审阅共用 `pdf_text_backend.py`，逐页输出采用
[PaddleOCR-VL-1.6 的文字结果接口](https://github.com/PaddlePaddle/PaddleOCR/blob/main/docs/version3.x/pipeline_usage/PaddleOCR-VL.en.md)，
本地缓存版本为 schema 6。每卷存入 `OCR_DATA/<PDF名>.<路径哈希>/`：
`manifest.json.gz` 保存共享字体表、PDF 身份和页文件索引；`page-00001.json.gz` 等逐页保存结果。
页面使用 `input_path`、`page_index`（从0开始）、`page_count`、`parsing_res_list`；
块使用 `block_id`、`block_order`、`block_label`、`block_content`，`block_bbox` 为 null，坐标由 PDF.js 提供。
在此基础上扩展块和行的页内码点 `start/end`，以及行内 `spans`（`length/font_index`）；
从行起点累加长度可精确还原任意文字片段的边界，行末保留一个换行。
文字只存于块内容，字体元数据保持原精度。这里提取 PDF 已有文字层，不运行模型，
不虚构标题/表格分类、置信度、图片或预处理结果。

全部页文件和清单的总量不得超过 5,000,000 字节；整卷在临时目录完成并验收体积后才替换，
清单最后发布。每页携带文档身份标记，防止新旧页数据混用。
前端通过 `pdfTextUrl` 取得 `/OCR_DATA/<卷目录>/manifest.json.gz`，最多4个请求并行加载页文件，
使用 `DecompressionStream('gzip')` 解压并转换为 UTF-16 索引。后端只发送压缩字节。
选区和高亮复用现有 diff 与 PDF.js/DOM 坐标，不另存位置索引。
Python 审阅仅在裁剪/上下文请求时读取对应页的原生坐标，不落盘。
原 PDF 和扫描图像不变。旧单文件缓存不再使用；格式升级后需重启阅读器并刷新。
可运行 `python pdf_text_backend.py -c CONFIG`，或 `python pdf_text_backend.py --pdf FILE`；
`--cache-dir DIRECTORY` 指定输出目录。阅读器启动时也会自动准备全部本地卷。

```powershell
python -B html_pattern_scripts/html_pattern_review.py --config ../MEW_BRIEF/.mew-reader.json --port 8766
```

查找顺序与 reader-server 一致：`-c/--config` → `CONFIG` 环境变量 → 从当前目录向上
寻找 `.mew-reader.json` 或 `mew-reader.json` → 项目目录及相邻的 `MEW_BRIEF`、
`MECW_reconv` 默认位置。端口支持 `-p/--port` 和 `PORT`，默认仍为 8765。

支持原有 JSON 的单卷和 `volumes` 多卷结构：`htmlRoot`、`pagePattern`、`pdf`
（字符串或 `{ "file": "..." }`）、`pageLabel`，以及 `pages.directory/pattern/list`。
支持 JavaScript 的 `(?<page>...)` 页码捕获组。JSON 内路径相对于 JSON 文件所在目录，
命令行路径相对于当前工作目录；本地 `file://` 路径也可使用。

只扫描各配置目录直接包含、符合规则和页码列表的 HTML，映射到该卷配置的 PDF。
多卷文件在列表中以相对于公共目录的路径区分，不要求 `ME16-009.html` 这类固定名称。
未列入配置的文件不能通过审阅接口读写；HTML/PDF 必须是本地资源，不支持 HTTP 书库。
修改配置后重启服务。功能模块仍由顶部 import 和 `PROVIDERS` 注册，JSON 不导入 Python 代码。

旧的手动目录方式仍可用（与 `--config` 互斥）：

```powershell
python -B html_pattern_scripts/html_pattern_review.py --root ../MEW_BRIEF/16 --pdf-root ../马恩全集德文
```

手动方式保留递归扫描和 `ME卷号-页码.html` → `mew_band卷号.pdf` 的旧映射规则。
`--data-dir` 仍可指定审阅日志与备份目录。

无需前端构建；Monaco 从项目现有 `node_modules/monaco-editor` 本地加载。
已安装项目依赖时无需再次运行 `npm install`。Ctrl+C 停止服务。
仅使用 HTML 格式模式时无需第三方 Python 包。

## 审阅界面与快捷键

左侧“审阅功能”支持勾选多个模块，至少保留一项。所选模块共同比较同一个 HTML，
结果按源码位置合并显示；匹配规则和差异类型注明所属模块，可继续分别筛选。
每条结果只显示其所属模块的修改方案，保存后重新计算全部所选模块，避免使用过期位置。
正则搜索可与 OCR 文字、字体及 HTML 格式模式共同使用；勾选后填写参数并点击
“搜索 / 更新提案”。仅当所选模块需要 PDF 时才读取 PDF。

默认采用文件结果树 + 提案预览两栏布局。点击“结果详情”展开当前文件的详细结果；
“更多筛选”按需展开，折叠时仍显示生效筛选数，“清除筛选”恢复全部文件与结果。
仅修改文件范围且当前文件仍可见时，保留当前结果及自行修改的草稿。

刷新浏览器页面时恢复当前标签页的审阅功能、搜索参数、筛选和文件位置，复用服务内
已有的文件列表及比较结果，不自动重新扫描或批量比较。当前打开的文件仍会重新读取并
检查版本。点击顶部“重新扫描”可更新整个列表；外部增删改文件后也应使用此按钮。
结果保存在服务内存中，重启服务或切换审阅条件后需要重新扫描。

前后条操作固定在审阅区顶部，“应用并保存”固定在滚动区域底部；
“应用并保存”以蓝色强调，生成提案或搜索条件过期时不可保存。
没有扫描坐标的结果隐藏原图参考区。空结果提供清除筛选提示。

F4 / Shift+F4 切换当前文件结果，到首尾停止；Alt+← / Alt+→ 切换文件。
原有 J / K、左右方向键与 R 标记快捷键保留，输入框与编辑器内不触发这些单键操作。
前后条按钮仍使用后端提供的导航，可在文件边界继续到相邻文件。

交互参考：[VS Code 搜索与结果上下文](https://code.visualstudio.com/docs/editing/codebasics)、
[VS Code F4 结果导航](https://code.visualstudio.com/docs/reference/default-keybindings)、
[JetBrains 替换前预览](https://www.jetbrains.com/help/idea/finding-and-replacing-text-in-project.html)。
继续使用现有 JavaScript / Python 和 Monaco，不引入额外 UI 框架。

## 文件分组与正则搜索

左侧结果按文件分组，显示文件名、目录和匹配数。点击文件前的箭头展开或折叠
匹配上下文，点击某条结果定位到对应位置。结果总数随当前筛选更新。
当前打开的文件自动展开，匹配文字高亮，选中的结果同步显示在文件分组内。
文件路径默认保留原有 glob 筛选；勾选“文件路径使用正则”后使用正则匹配路径。
“结果正则筛选”按匹配文字及上下文过滤当前模块的结果。两个筛选框使用浏览器
JavaScript 正则，忽略大小写；无效表达式会显示错误。

选择“正则搜索 / 替换”可独立搜索 HTML 源码，无需运行 OCR 或 HTML 格式模块，
也无需 PDF 或第三方 Python 包。该模块位于独立脚本 `regex_search.py`，仍通过
顶部 import 和 `PROVIDERS` 注册，不自行读写文件。

输入搜索表达式及替换文字后，点击“搜索 / 更新提案”（或按 Enter）。支持忽略
大小写、多行锚点、点号匹配换行；搜索和替换使用 Python `re` 语法，捕获组引用
使用 `\1`、`\g<1>` 或 `\g<name>`。替换文字留空表示删除；搜索留空时不产生结果。
例如搜索 `(?P<word>Text)`、替换为 `<b>\g<word></b>`。

选择结果后先显示当前这一处替换的修改提案，点击“应用并保存”才保存。
替换直接作用于 HTML 源码，允许插入标签，不自动转义。每次保存后重新搜索；
版本检查、编码、原文备份和日志复用原有后端。搜索参数按请求传入，彼此独立，
不会修改服务器注册的模块实例。
修改搜索表达式、替换文字或标志后，旧提案立即失效；再次点击“搜索 / 更新提案”
后才能应用。建议与原文相同的正则替换不能应用。搜索出错时清空旧结果。

## 修改提案

默认审阅页以修改提案为中心。Monaco 展示只读的行内 diff：原文在上、提案在下，
差异所在文本行紧邻显示并居中，框内按显示宽度分行；完整源码行作为上下文保留，
通过编辑器内的“隐藏的行”折叠条展开上文、下文。显示分行只用于预览，不写入源码。
提案与方案选择、自定义源码编辑共用一个外框。
原文差异行标红、提案差异行标绿，差异字符加深；其他上下文行保持普通背景。
显示的是当前 HTML 源码与当前选项生成的建议源码，不是 HTML 正文与 OCR 原文的直接比较。

选中差异后自动展示第一个可用方案。切换方案或填写自定义文字会更新提案；自定义
输入停顿约 300ms 后更新，中文输入法组词结束后再计算。提案生成失败时禁止应用。
没有可用方案或建议与原文相同时显示说明。源码和渲染预览仍可通过标签切换，
扫描原图位于提案上方，默认展开，并与候选导航一起固定在审阅区域顶部；滚动方案时仍可见。
黄框只标出当前差异的 OCR 坐标，不标出周围上下文；PDF 中无对应文字时，以虚线框显示相邻 OCR 定位参考。
高亮为浏览器覆盖层，不改动原图或 PDF。参考栏采用紧凑间距，原图超出显示区域时可滚动。

Source 标签也使用 Monaco 显示完整 HTML，自动选中并居中当前匹配位置。
文本差异的“自行修改”将同一个源码编辑器放入方案面板，可直接修改标签、实体及正文。
此时 Source 与提案标签之间切换保留当前编辑内容；停顿约 300ms 后更新修改提案，
中文输入法组词结束后再计算。点击“应用并保存”才写入完整源码，不再将输入转义为纯文字。
切换候选或文件会重新加载原文，应先应用需要保留的修改。

`/api/proposal` 复用后端 `decide()` 的 provider 编辑计算及版本校验，只返回建议源码，
不写 HTML、备份或决定日志。点击“应用并保存”才经原有 `/api/decision` 保存。
前端不自行推测 OCR 替换、实体转义或格式包装，展示和保存使用同一套 provider 规则。

## 功能模块与注册

`html_pattern_review.py` 是统一后端，负责目录扫描、文件读取、编码、PDF 页码映射、
原 OCR 字符/字体标志读取、缓存、原图裁剪、版本检查、备份、日志及原子保存。
比较模块只接收内存中的数据并返回候选，不自行读写文件。
`scan_for_box()`、`crop()` 原图裁剪工具也集中在后端；旧的
`ocr_patch_review.py` 引用后端的同一实现，不再保留一份裁剪逻辑。
不渲染 PDF 页面、不设置 DPI，不修改源 PDF 或其扫描图层。

已有功能：

- `html_patterns.py`：HTML 正则搜索。
- `regex_search.py`：交互式普通正则搜索及单处替换，不依赖 PDF。
- `ocr_diff.py`：原有 PDF OCR 文本 diff。
- `ocr_styles.py`：搜索 PDF 原 OCR 的粗体、斜体，并比较 HTML 格式。
- `review_provider.py`：统一输入 `ReviewContext` 和接口 `ReviewProvider`。
- `review_common.py`：可见文字、源码坐标及文本归一化工具。
- `diff_engine.py`：统一 PDF 文字索引、HTML/OCR 对齐和坐标投影；文字与格式模块共用。

增加功能只需在 `html_pattern_review.py` 顶部导入，并在 `PROVIDERS` 中注册实例：

```python
from my_search import MySearch

PROVIDERS = (OcrDiff(), HtmlPatterns(), OcrStyles(), MySearch())
```

注册实例提供以下属性及方法（`ReviewProvider` 是结构接口，无需继承）：

```python
id = 'my-search'            # 全局唯一，用于 purpose 参数
label = '自定义搜索'         # 前端自动显示
requires_pdf = True         # False 时不读取 PDF，也无需 PyMuPDF
reviewable = True           # 显示比较和保存面板；纯定位搜索设为 False
patterns = [{'id': 'item', 'label': '候选类别', 'regex': ''}]
kinds = {'missing': '缺少格式'}
actions = [{'id': 'accept', 'label': '接受建议'},
           {'id': 'note', 'label': '自行填写', 'input': 'text'}]

def compare(self, context):
    return {'matches': [...], 'alignment': 1.0}

def decide(self, context, hit, choice, text):
    # 业务脚本解释 choice，产生经过业务判断的源码修改。
    return {'edits': [...], 'text': '本次记录的文字',
            'message': '已处理', 'advance': False}
```

`context.source` 是原始 HTML 字符串；`ocr` 是原始 OCR 字符串；
`coordinates` 与 `styles` 和每个 OCR 字符一一对应，换行坐标为 `None`。
坐标元素是 `(物理页码, 页码标签, bbox)`；字体位 `2` 是斜体，`16` 是粗体。
`pdf_identity` 用于生成候选的稳定标识。模块不能打开输入文件或写输出文件。

普通搜索候选返回 `pattern/start/end/line/column/text/context`；支持 PDF 审阅的
候选还返回 `id/ocr/spans/crops/kind/decision`，详见 `review_provider.py`。
源码偏移使用 Python 字符索引，`end` 不包含在范围内。
`actions` 由业务脚本定义，数量、ID、显示文字均不限；`input: 'text'` 表示需要
填写文字；`input: 'source'` 使用完整 HTML Monaco 编辑器，将完整修改后源码作为
`text` 传给模块的 `decide()`，由模块返回源码编辑列表。候选的 `choices` 可限制允许的 action ID；省略时允许该模块的全部选项。
前端按当前候选动态生成选项，不显示不可用项。纯搜索模块提供 `actions = []`。
`html_pattern_review.py` 通过独立的 `navigation` 字段提供“上一条”（`previous`）
和“下一条”（`next`），前端显示为两个直接点击的按钮，不加入修改选项。
两者只导航，不记录已处理状态，不写入决定，不修改 HTML 或重新计算差异；
越过文件边界后分别展示前一个文件的末条或后一个文件的首条。页面不显示
“已处理”“已跳过”等成功提示，只在操作出错时显示错误。
业务脚本的 `decide()` 返回源码编辑列表 `(start, end, replacement)`，必须按位置
排序且互不重叠；纯文字修改应先转义 HTML。后端统一校验、应用、备份和记录，
不解释具体选项的业务含义。空 `edits` 只记录决定，`message` 和 `advance` 控制
保存提示及是否跳到下一项。原有文字模块继续保证纯文字转义，格式模块只补格式。

前端通过 `/api/providers` 获取功能列表，通过 `/api/files?purpose=...` 获取
类别和差异类型；`/api/document`、`/api/crop`、`/api/decision` 均传递 `purpose`。
旧调用省略保存和裁剪的 `purpose` 时仍默认使用文本 diff。
注册新比较模块不需要修改 HTTP 路由或前端的功能选项。
注册顺序决定功能复选框的顺序，页面默认勾选第一个模块，前端不指定业务模块 ID。
多个模块的 `purpose` 使用逗号分隔的注册 ID；原有单模块调用继续有效。
合并结果的规则、类型和操作 ID 带模块前缀；保存与日志仍交回原模块，
因此切回单模块也保留原有决定。每次应用只保存当前结果的方案。

打开页面后自动选中首个文件展示结果，并在后台逐个比较当前筛选的文件，更新
文件列表的结果数。可点击“停止比较”中止后台批次，之后仍可手动比较。
PDF 映射在实际读取该文件时验证，首次列出文件不逐个解析 PDF 路径。
同一目录中的已知文件路径直接比较，不对每个候选反复调用 `resolve()`；提取
`rawdict` 时关闭 `TEXT_PRESERVE_IMAGES`，只读取 OCR 和坐标，不提取扫描图片字节。

## 共享 diff 流程

后端读取 HTML 源码，将 PDF 路径和页码范围传给 `DiffEngine.read()`。
参照 `public/pdfdiff/pdf-selection-diff.js` 的 `indexDocument()`，首次使用某份 PDF 时
一次性读取整份 PDF 的文字、字体位和原始坐标，建立页码到文字偏移的索引；
之后按 HTML 所属页码范围切片，不再逐个文件重新打开 PDF 提取 OCR。
坐标以紧凑数值数组保存；PDF 索引最多保留两份，不长期持有打开的 PDF 文件。

业务脚本使用 `context.diff` 取得共享的 `visible/text/left/right/left_map/right_map`、
`matcher/aligned` 和 `crops()`。文字差异使用 opcodes，格式审阅使用相同 matcher
的 matching blocks；业务脚本不再各自解析、归一化和构建 SequenceMatcher。
同一 HTML 和 PDF 范围的输入及对齐结果复用，最多缓存 32 组。
修改 HTML 只重建对应的对齐，不重新提取 PDF；PDF 修改时间或大小变化后重建
索引和对应对齐。扫描预览通过现有 `/api/crop` 读取整页内嵌图像并缓存；切换差异只更新坐标和滚动位置，不进入 diff 计算。

## PDF OCR 粗体 / 斜体

筛选目的选择“PDF OCR 粗体 / 斜体”，可分别筛选粗体、斜体，以及
“HTML 缺少格式”“格式一致”“文字未可靠对齐”和“尚未处理”。结果包含
PDF 中所有已标记的粗体、斜体片段，而不仅是缺少格式的片段。

- 读取 PyMuPDF 原 OCR 字符跨度的字体 flags；不从扫描像素推测字体。
  若原 OCR 没有保存粗体、斜体标志，则不会生成字体候选。
- 识别 HTML 的 `i/em`、`b/strong` 和继承的行内 `font-style/font-weight`，
  包括子元素上的 `normal` 重置；不计算 class、样式表或外部 CSS。
- 使用与文本 diff 一致的空白、软连字符和行尾断词归一化规则对齐。
  文字未完整连续对齐时，只允许记录“保持原状”，需人工检查。
- 对“HTML 缺少格式”选择“按照 OCR 文字 / 格式修改”时，只给缺少格式的
  正文片段添加 `i` 或 `b`，不替换文字、实体、已有标签或属性。
  同时具有两种字体的片段会分别返回两类候选；每次保存后重新比较。
- “格式一致”只允许记录保持原状。此模式不支持手动替换文字，可切回文本
  diff 或使用源码编辑器处理。OCR 的字体标志仍是审阅线索，需结合扫描原图判断。

## PDF OCR 差异审阅

默认筛选目的为“PDF OCR 文本差异”。可按文件名、差异类型（文字不同、仅 OCR
有文字、仅 HTML 有文字、尚未处理）及文件审阅状态筛选。

- 打开文件时计算差异；未比较文件标为“待比较”，不会被“仅有匹配”误删。
- 点击“比较当前筛选的文件”逐个比较筛选中的文件，填充差异数量；再次点击停止。
  比较完成后，“仅有匹配”筛选显示实际存在差异的文件。重新扫描会清空前端数量，按需重新比较。
- PDF 页码归属与 `public/reader-app.js` 的最近前置 HTML 文件规则一致：
  从当前文件名的页码标签起，直到下一个同目录、同卷 HTML 文件名页码之前。
  配置方式按 `pagePattern` 提取页码、按 `pageLabel` 生成 PDF 标签。
  例如缺少 222–225 的独立 HTML 时，`ME16-221.html` 对应 221–225。
  最后一个 HTML 文件对应到 PDF 末页；筛选根目录应保留完整同卷文件列表。
  不读取任何外部页码组文件；页码标签缺失或重复时明确报错，不猜物理页偏移。
- Python `SequenceMatcher` 比较 HTML 正文与 PDF 原始 OCR 字符；忽略布局空白、
  软连字符及行尾断词，保留大小写和标点差异。页眉、脚注、阅读顺序不同可能产生额外差异，
  “对齐相似度”供判断定位质量；候选不代表 OCR 更正确。
- 每条候选显示当前选项的 HTML 源码修改提案；展开扫描原图参考可查看 PDF 页码、坐标和相邻扫描文字。
  后端 `image()` 返回整页内嵌扫描图及逆变换后的高亮坐标，前端复用图像并滚动到差异；
  不渲染 PDF 页面、不设置 DPI、不修改源 PDF。预览以 CSS 缩小显示，保留原图像素。
  无唯一覆盖扫描图时显示错误，不回退为页面截图。
- 选择当前候选支持的修改方案，检查行内 diff 后点击“应用并保存”。
  “自行修改”编辑完整 HTML 源码，标签和实体按输入保存；删除选中的源码可删除该处内容。
- 修改只替换正文字符跨度，保留原有标签和属性。跨标签候选把替换文字放在第一个
  被替换跨度中，后续标签仍保留，需通过源码或预览检查其格式归属。
- 保存检查内容版本；外部改动后拒绝旧页面写入。HTML 按原编码写入并原子替换，
  不改变 UTF-8 BOM 状态；无法用原编码表达的输入会报错并保留原文件。
- 后端 `html_pattern_scripts/review_data` 保存决定日志（`.json`）及首次修改前的
  HTML 原始字节备份（`.original`），文件名为源路径哈希。可用 `--data-dir` 改位置。
  “保持原状”也写入决定日志，重新打开后可见；PDF 或相应差异内容变化时需重新审阅。
- 文件级“已审阅”状态与主题偏好保存在浏览器；每条决定保存在后端。

## HTML 格式模式

切换筛选目的为“HTML 格式模式”，保留原有正则匹配审阅功能。
在 `html_pattern_scripts/html_patterns.py` 的 `DEFAULT_PATTERNS` 修改规则并重启。
每条规则有唯一 `id`、`label`、Python `regex` 和可选 `flags`；匹配原始 HTML（含标签）。
默认包含旧式 font 标签、空段落和 Unicode 替换字符。这些只是审阅候选，不自动修改。

源码可定位匹配；预览 iframe 使用 sandbox，阻止脚本、外部资源和表单。
文件列表每页 150 项，上一/下一文件可跨列表页。J/K 切换候选，左右键切换文件，R 标记审阅。

UI 使用与 `mew-html-reader-vscode` 相同的 `--vscode-*` 主题变量、34px 工具栏、
紧凑按钮和侧栏，可切换深浅色。服务只监听 `127.0.0.1`。

## 验证

```powershell
python -B -m unittest test_html_pattern_review -v
node --check html_pattern_review/app.js
node tests/html-pattern-review-browser.mjs
node tests/html-pattern-review-browser.mjs --styles
node tests/html-pattern-review-browser.mjs --real
```

Python 测试构造带 OCR 层和内嵌图片的 PDF，验证按相邻文件推算范围、原图裁剪、
三种保存选择、实体转义、标签保留、备份和版本冲突；另验证显式功能注册、
粗体/斜体读取与比较、格式保存、行内样式继承以及 PDF 字节保持不变；
验证 reader JSON 的查找顺序、单卷/多卷、自定义文件名、页码标签及配置访问边界。
两组浏览器夹具均通过 reader JSON 初始化后端。
浏览器测试使用本机 Edge；`EDGE_PATH` 可指定路径。
默认只修改临时夹具；`--real` 只读检查本地第 16 卷的真实差异、裁剪、主题和窄屏布局。
