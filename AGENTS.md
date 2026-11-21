# AGENTS.md

VS Code 扩展「块引用解读工具」：解析 Tine / Logseq 笔记中的 `((uuid))` 块引用，
使编辑器与 AI 都能读到被引用块的完整内容，并复刻 Tine 的反链面板。
已上架扩展市场，发版全自动。

面向用户的功能说明、安装、配置与排查见 [README.md](README.md)。本文件只写
代码改动与发布所需的工作约定——那些读一遍仓库也看不出来的东西。

## 硬约束

**笔记库保持只读。** 需要展示内容时，输出落到网页面板、虚拟文档、输出面板或
工具返回值。用户的真实笔记库 `d:\扁舟听雨工作室\网文创作理论` 只作为验证对象，
不是项目代码，改动它等于破坏用户数据。

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

约定带来的直接好处是 `src/test/` 能在 plain Node 下跑完 320 项测试，不需要启动
VS Code 宿主。往 core 里塞 `vscode` 依赖会一次性摧毁这个能力——需要宿主能力时，
把判断需要的信息作为参数传进来，而不是 import。

构建用 esbuild 打成单文件 CJS，`vscode` 保持 external（宿主提供）。

## 验证

改完必须让 `npm run typecheck` 与 `npm test` 全绿——两者都通过才算完成。

**真实笔记库测试是这套测试里最有价值的部分。** `src/test/realGraph.smoke.test.ts`
用 `TINE_GRAPH_ROOT` 环境变量指定图谱，缺省为上述用户笔记库路径；目录不存在时
整个 describe 自动 skip，所以 CI 上这项不跑而其余照常。涉及解析、缩进、反链或
渲染的改动，在本地跑一遍真实库测试能抓出自造样例永远遇不到的边界。

新增行为时补几条聚焦用例，放进对应的既有 `*.test.ts`。这些测试断言的是
「真实笔记库上仍然可读且层级正确」，不是实现细节。

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
模型与用户看到的是 `blockRef` / `blockNote` / `blockBacklinks`。写指令、写文档、
让 AI 引用时用后者，前者只在源码里出现。

## 体量

`src/vscode/indexService.ts`（685 行）与 `src/core/backlinkReport.ts`（623 行）
已超过 600 行红线，`src/core/backlinkHtml.ts`（424 行）接近 400 行警戒线。
新功能另开文件；要往这几个文件里加逻辑时，先提出拆分方案再动手。
拆分时同步拆对应的 `src/test/*.test.ts`，保持覆盖率不变。

## 会被打进扩展包的东西

`.vscodeignore` 决定包内内容。`templates/github/instructions/` 里的指令模板必须
随包分发（用户在笔记库中引用它），`.github/`、`src/`、`docs/` 与测试不进包。
`notebook-instructions.zip` 不入库也不进包，由工作流在发布时从 `templates/`
现场生成——压缩包内必须是 `.github/instructions/文件名` 三层，多一层会让用户
解压后指令不生效。
