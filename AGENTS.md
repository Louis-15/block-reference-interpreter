# AGENTS.md

VS Code 扩展「块引用解读工具」：解析 Tine / Logseq 笔记中的 `((uuid))` 块引用，
使编辑器与 AI 都能读到被引用块的完整内容，并复刻 Tine 的反链面板。
已上架扩展市场，发版全自动。

面向用户的功能说明、安装、配置与排查见 [README.md](README.md)。本文件只写
代码改动与发布所需的工作约定——那些读一遍仓库也看不出来的东西。

## 硬约束

**读路径只读，写路径只有一条。** AI 工具与所有渲染/查询路径都不修改笔记：
输出落到网页面板、虚拟文档、输出面板或工具返回值。

唯一允许写笔记的入口是用户主动执行的 **「块引用：复制当前块的引用 / 嵌入引用」**
（`src/vscode/blockIdService.ts`）：目标块没有 `id::` 时插入一行 `id::` 并保存文档，
然后复制引用。

AI 自由路径（`#blockMakeRef`、`#blockLink`）**只返回补丁文本**，由 AI 用自己的编辑工具
落盘。这不是为了保守，而是因为 **Copilot 的「接受 / 拒绝」栏只覆盖 AI 的编辑工具**：
工具私自写文件不会出现在那里，用户想撤销只能 Ctrl+Z 或查 git diff，事后根本分不清
哪次改动是 AI 干的。把落盘交给编辑工具，用户点一下「不接受」就能全撤。

不要在任何文档里写「全程只读，绝不修改任何笔记」这种绝对表述——它与上述命令冲突。
也不要为了「更快」把写盘搬进工具：省下的是几次工具往返，赔上的是用户的撤销能力。

用户的真实笔记库 `d:\扁舟听雨工作室\网文创作理论` 只作为验证对象，
不是项目代码，改动它等于破坏用户数据。冒烟测试只读不写。

**发版由用户指令触发。** 改完代码并通过验证就是本次任务的终点：汇报改动范围、
建议版本号、changelog 草稿，然后停下。用户在同一轮对话里明确要求发布后，才执行
打标签与推送。

**文件写入走 edit / create 工具。** PowerShell 的 `>`、`>>`、`Out-File` 会按本地
代码页落盘，中文注释变乱码。必须经 shell 读取文件时用
`[System.IO.File]::ReadAllText($path, [System.Text.Encoding]::UTF8)`。

## 架构

两层，由一条约定隔开：**`src/core/` 中任何文件都不 import `vscode`**。

- `src/core/` 纯解析与渲染：块树、引用扫描、索引、反链报告、HTML 生成、图谱探测。
- `src/vscode/` 适配层：工具、命令、悬停、行内渲染、反链徽章与面板。

约定带来的直接好处是 `src/test/` 能在 plain Node 下跑完全部测试，不需要启动
VS Code 宿主。往 core 里塞 `vscode` 依赖会一次性摧毁这个能力——需要宿主能力时，
把判断需要的信息作为参数传进来，而不是 import。

**回车 / 块内换行**也遵守这条边界：判断逻辑在 `src/core/blockSplit.ts`（纯函数），
`src/vscode/enterBehavior.ts` 只负责接收命令、执行编辑。新增按键行为时先写 core
计划函数与单测，再在适配层接线。

**不要拦截全局 `type` 命令来实现按键行为。** `type` 是全局命令，触发时不带
「哪个控件按的键」这一信息，而 `window.activeTextEditor` 只反映最后获得焦点的
文本编辑器。光标在 Copilot 聊天输入框里按回车时，聊天框派发 `type`，但
`activeTextEditor` 仍指向中间的 Markdown 文档，换行就被写进了笔记（实测造成
十几行空块）。正确做法是注册独立命令 + 在 `package.json` 的 `keybindings` 里用
`editorTextFocus` 限定作用域；条件不满足时回退 `default:type` 保留原生行为。

构建用 esbuild 打成单文件 CJS，`vscode` 保持 external（宿主提供）。

**工具设计以「往返次数」为第一指标。** 每次工具调用对模型都是一轮完整响应，
真实耗时远大于工具本身的执行时间。所以：能一次算完的不要拆成两次，
但也不要为了合并而在一个工具里塞进互相独立的职责。

由此产生两个约定：

- **`#blockLink` 是引用任务的默认入口**。它把「定位 → 生成 UUID → 算 `id::` 补丁
  → 算引用落点补丁」压成一次调用。拆分版（`#blockFind` + `#blockMakeRef` +
  手写引用）只保留给「只想补 ID、不写落点」这类单一需求。
- **寻找结构不要靠模型扫文件**。`#blockFind` 的 `headingsOnly` + `headingLevel`
  就是为此存在；模型用终端 grep 或 powershell 扫全库，既慢又容易漏。

反过来，工具**不**替模型做需要判断的事：引用写在哪一段、用不用 embed、
说明文字写什么，都必须由调用方传参。工具只消除机械步骤和格式风险。

## 验证

改完必须让 `npm run typecheck` 与 `npm test` 全绿——两者都通过才算完成。

**真实笔记库测试是这套测试里最有价值的部分。** `src/test/realGraph.smoke.test.ts`
用 `TINE_GRAPH_ROOT` 环境变量指定图谱，缺省为上述用户笔记库路径；目录不存在时
整个 describe 自动 skip，所以 CI 上这项不跑而其余照常。涉及解析、缩进、反链或
渲染的改动，在本地跑一遍真实库测试能抓出自造样例永远遇不到的边界。

新增行为时补几条聚焦用例，放进对应的既有 `*.test.ts`。这些测试断言的是
「真实笔记库上仍然可读且层级正确」，不是实现细节。

**临时验证脚本放 `d:/Projects/Intermediate Products`，不要放进仓库。**
需要拿真实库跑一次性验证（例如演算插入计划、对比补丁）时，用 esbuild 把
一个 `.ts` 探针打包成 CJS 再 `node` 执行，跑完删目录。探针只读，不许写笔记库。

`docs/PLAN.md` 记录着里程碑与开发期的完整踩坑经过，但它在 `.gitignore` 里，
只有本机存在。新克隆的仓库没有这份文件。

## 发版

唯一路径是推标签，其余由 `.github/workflows/release.yml` 完成。

用户授权发布后：

1. 改 `package.json` 的 `version`，在 `CHANGELOG.md` 顶部补条目。两者版本号必须一致，
   工作流第一步就会校验，不一致直接失败。
2. 提交并推送到 `main`。
3. 打标签并推送：

   ```bash
   git tag -a v0.3.7 -m "v0.3.7"
   git push origin refs/tags/v0.3.7
   ```

推送标签后工作流依次执行：校验版本一致 → 类型检查 → 单元测试 → 构建 → 打包 →
发布扩展市场 → 创建 GitHub Release 并上传 `*.vsix` 与 `notebook-instructions.zip`。
约一两分钟结束。**完成判据是工作流结论为 `success`，且市场版本列表与 Release 附件
都出现了新版本号**——只看工作流绿灯不够，市场端还要通过一次自动安全扫描才算真正
生效，此时商店状态会从 `Verifying` 变为可用。

认证走 **Trusted Publishing（OIDC 联邦身份）**，仓库内没有任何长期凭据。发布者端的
政策已配置为 `release.yml`，改动工作流文件名会让认证失效。微软已宣布 Azure DevOps
全局 PAT 于 2026-12-01 退役，因此本项目采用 OIDC 而非 PAT。

两个容易卡住的点：

- **市场发布成功但 Release 创建失败** 时，重推标签会被「版本已存在」挡下。此时手动
  补建 Release 即可，不要为了重跑工作流去 force push 标签。
- **扩展 ID `louis-15.block-reference-interpreter` 与 `publisher: louis-15` 都不可变更**，
  上架后改 ID 会让现有安装全部失效、旧链接 404。改名只动 `displayName`。

## 平台限制

这些是 VS Code 扩展 API 的硬边界，遇到需求时先确认可行性再动手：

| 机制 | 显示图标 | 左键单击 | 备注 |
|---|---|---|---|
| `InlayHint` | 否，label 只接受纯文本 | 否，强制 Ctrl | 挂 `command` 会自动追加「执行命令 (ctrl + 点击)」一行 |
| `DocumentLink` | 否 | 否，强制 Ctrl | 单击在编辑器里代表定位光标 |
| `TextEditorDecorationType` | 是，`contentIconPath` | 否 | 支持 `hoverMessage` |
| Webview 的 `<a>` | 是 | 是 | 需要 CSP nonce |

反链徽章与面板、展开全文都因此选了对应的机制——需要左键单击能力的地方必须用
Webview，代价是失去 Ctrl+F 与自由复制。

## 陷阱

每条都是实际踩过并修复的，重犯会得到同样的失败。

**装饰器的 `contentText` 属于装饰类型级属性。** 每个不同的引用计数都要单独
`createTextEditorDecorationType`，按计数缓存复用。想用一个类型改数字改不动。

**零宽装饰 range 落在行尾。** 写成 `(line, 0)` 会让 `after` 内容跑到整行文字前面。
正确位置是 `new Position(line, lineText.length)`。

**`contentIconPath` 在当前 `@types/vscode` 里只接受单个 `string | Uri`。** 深浅色双图标
要自己按 `activeColorTheme.kind` 选一个，并监听 `onDidChangeActiveColorTheme` 重建。

**悬停提示只挂一处。** `hint.tooltip` 与 `InlayHintLabelPart.tooltip` 同时设置，
或图标装饰与数字装饰都挂 `hoverMessage`，同一段文字会显示两遍。

**command 链接需要两个条件同时满足**，缺一个就静默失效：
`markdown.isTrusted = { enabledCommands: [...] }`，以及参数用
`encodeURIComponent(JSON.stringify(args))` 编码。

**CSP 的 `style-src 'nonce-...'` 会拦掉内联 style 属性。** 缩进层级、颜色等一律写成
预定义 class（`.d1`~`.d8`、`.lv1`~`.lv8`），不能用 `style="..."`。

**模板字符串内的 CSS 注释不能出现反引号。** `const STYLES = \`...\`` 里的 CSS 注释写了
反引号会提前终止字符串，报出的是一串看似无关的算术类型错误。

**渲染输出换算层级时跟随 `indentUnit`。** `renderBlockTree` 每行以 `indentUnit`
个空格表示一级，默认 2；`Math.floor(前导空格列数 / indentUnit)` 得到 depth。
调用方若显式传了别的 `indentUnit`，换算处要同步改，写死除数会错位。

**工具名有两套。** `registerTool` 用 `tineBlockRef_readBlock` 这类内部名，
模型与用户看到的是 `blockRef` / `blockNote` / `blockBacklinks` / `blockNewId` /
`blockFind` / `blockLink` / `blockMakeRef` / `blockCheck`。写指令、写文档、
让 AI 引用时用后者，前者只在源码里出现。

**块引用前面必须有空白，这是 Tine / Logseq 的原生规则。** 只识别「行首」或
「空白之后」的 `((uuid))` 与 `{{embed`，`参考：((uuid))` 这种紧贴前文的写法在
本扩展里能扫到（所以 VS Code 里看着正常），粘回 Tine 却是死链。审计用
`reference-tight-prefix` 警告覆盖它。

判定时有个坑：正则只从内层 `((` 开始匹配，而 `{{embed ((uuid))}}` 的内层前面
永远是空格，直接看 `((` 前一个字符会漏判。必须先回退到 `{{` 的位置再判
（`refAuditScan.ts` 里的 `macro` 匹配）。生成侧则由 `buildRefBlockPlan` 在代码里
保证空格，不依赖模型手写。

**排除块外引用时不要用块下标当 key。** 反链合并曾用 `blockIndex` 作 key，
块外引用全是 -1，于是几十条被合并成「同块内重复引用 N 次」。必须区分
`block:{i}` 与 `line:{n}`。

**属性键的字符集必须收紧。** `[^\s:]+` 会把中文正文里的 `::` 当成属性行，
`id::` 就被插到正文后面去了。正确的是 `[A-Za-z0-9_./-]+`（真实库只有
`collapsed` / `id` / `tags` / `numbering` / `title` / `tine/*` / `heading` 等 ASCII 键）。
`refAuditScan.ts` 与 `render.ts` 里的属性正则必须与 `blockParser.ts` 保持一致，
否则会出现「解析器不认为是属性，渲染层却把该行隐藏了」的不一致。

**隐藏哪些属性只在 `hiddenProperties.ts` 维护一份。** 清单与 Tine 的
`BUILTIN_HIDDEN`（`crates/tine-outline/src/property_visibility.rs`）对齐，共 30 多项。
两处容易踩：`package.json` 的 `tineBlockRef.hideProperties` 默认值要跟着改，
否则「没配置」和「显式配置成旧默认」结果不同；键名比对要先过
`normalizePropertyKey`（小写 + `_`/空格→`-`），否则 `created_at::` 会漏隐藏。

**顶格 `# 标题` 是块，缩进的不是。** Tine / lsdoc 把行首无缩进的 `# 标题`
当作和 `- ` 并列的独立块，可以挂 `id::`、可以被引用。本插件原先只在文件开头
识别它，文件中部出现的第二个顶格标题会被丢弃，导致后一个标题下的子块并进
前一个标题的子树、`id::` 挂到错误的块——这是**同 UUID 在两边指向不同块**的隐患。
判定条件必须同时满足「行首无缩进」与「`#` 后是空白或行尾」：放宽前者会把
续行误判成块，放宽后者会把 `#标签` 当成标题。

**lsdoc 还会把缩进的 `# 标题` 当成 heading 块。** 本插件把它当父块续行，
两者不一致。真实笔记库中该写法为 0 例，所以暂不对齐；若将来出现，
先统计「这些行下面有没有 `id::`」再决定，别直接照搬 lsdoc 的行为。

**页面名优先 `title::`，其次文件名。** Tine 的规则是取**前言区**第一个非空
`title::`（`page_title_from_preamble`）。前言区由 `preamble.ts` 界定，止于第一个块，
所以块内部的 `title::` 属于那个块、不是页面名。页面名由 `buildBacklinkReport`
一次算好塞进 `BacklinkGroup.pageName`，四个渲染层直接读——不要在渲染层各自推导，
否则「面板显示标题、悬停显示文件名」会重新出现。

## 体量

`src/vscode/indexService.ts`（711 行）已超过 600 行红线；
`src/core/backlinkHtml.ts`（452 行）超过 400 行警戒线，`src/vscode/inlineRenderer.ts`（394 行）
就在线上。
新功能另开文件；要往这几个文件里加逻辑时，先提出拆分方案再动手。
拆分时同步拆对应的 `src/test/*.test.ts`，保持覆盖率不变。

`src/core/blockParser.ts` 一度因新增「顶格标题是块」涨到 445 行，已按职责拆出
`src/core/preamble.ts`（frontmatter + 页面属性 → 第一个块的位置）与
`src/core/hiddenProperties.ts`（属性隐藏清单），并把「行形态识别」（`splitLines`、
`isAtxHeadingLine`）归到 `src/core/blockLine.ts`，主文件回落到 381 行。
`blockParser` 仍 re-export `splitLines`，老调用方不用改。

`backlinkReport.ts` 曾经是 670 行，已按「类型 / 文本 / 渲染」拆成
`backlinkReport.ts` + `backlinkReportTypes.ts` + `backlinkReportText.ts` +
`backlinkReportRender.ts`，对应测试也从单个 532 行的文件拆成
`backlinkReport.test.ts` + `backlinkReportRender.test.ts` + `backlinkReportFixture.ts`。
这次拆分可以作为后续拆分的模板：先按职责切成纯函数模块，再让原文件只保留编排。

## 会被打进扩展包的东西

`.vscodeignore` 决定包内内容。`templates/github/instructions/` 里的指令模板必须
随包分发（用户在笔记库中引用它），`.github/`、`src/`、`docs/` 与测试不进包。

`notebook-instructions.zip` 不入库也不进包，由工作流在发布时从 `templates/`
现场生成——压缩包内必须是 `.github/instructions/文件名` 三层，多一层会让用户
解压后指令不生效。**本地那份 zip 会被 gitignore，容易忘记更新**：曾出现模板已改、
本地 zip 仍是两个版本前的情况，用户解压后拿到的是旧规则。

**指令文件装在用户笔记库里，扩展升级不会更新它。** 改了模板必须提醒用户重新
解压覆盖；判断依据是文件里有没有最新章节标题。这条要写进 CHANGELOG 与
README 的升级说明，否则用户会以为「装了新版本但 AI 不会用」是插件坏了。

模板内容有三条硬性要求，改动时不能丢：

1. frontmatter 的 `description` 必须同时覆盖「读」和「写」，否则 AI 写笔记时匹配不到该指令；
2. 必须写明 `((` / `{{embed` 前面要有空格，且要给出正误对照；
3. 必须写明「最短路径」：禁止用终端读文件、禁止反复回读验证、整篇只跑一次 `#blockCheck`。
