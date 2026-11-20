# 块引用解释器（Block Reference Interpreter）

让 VS Code 里的 AI 读懂 **Tine / Logseq** 笔记中的 `((uuid))` 块引用。

---

# 第一部分 · 这个插件是干什么的

## 它解决什么问题

Tine 和 Logseq 用 `((uuid))` 引用其他块。对人没问题，因为软件会把引用渲染成真实内容；但 AI 在 VS Code 里读 `.md` 时，只能看到一串 UUID：

```
- 参见 ((66c73a56-ddda-44d2-80dd-009e44406fd4))
```

它不知道这个 UUID 指向的是「3.1 棋子觉醒/背叛」那一整节。于是整理笔记时就会漏掉上下文、给出片面的结论。

本插件在本地解析整个图谱，把「UUID → 块及其全部子块」的能力交给 AI 和你自己。

## 支持的引用形式

| 形式 | 示例 | 说明 |
|---|---|---|
| 行内引用 | `((66c73a56-...))` | 最常见 |
| 嵌入引用 | `{{embed ((66c73a56-...))}}` | Tine / Logseq 的 embed 语法 |
| 全角括号 | `（（66c73a56-...））` | 中文输入法容易打成全角 |
| 带空白变体 | `{{ embed (( uuid )) }}` | 宽容处理，不影响标准写法 |

四种形式在**行内渲染**、**悬停预览**、**AI 工具**、**展开全文**里行为一致：

- 行内渲染把**整个表达式**替换成目标块标题（包括 `{{embed ...}}` 外壳），不会残留 `{{embed 标题}}` 这种残骸。
- 悬停时，鼠标放在 `{{embed` 前缀、UUID、或结尾 `}}` 上都能触发预览。

## 能力一览

| 能力 | 说明 |
|---|---|
| 索引 | 后台扫描 `pages/` 与 `journals/`，建立 UUID → 块、UUID → 引用的内存索引 |
| AI 工具（3 个） | 让 Copilot Chat 在后台直接读到块内容，**不产生任何文件** |
| 行内渲染 | 把 `((uuid))` 直接显示成目标块标题，类似笔记软件原生效果 |
| 悬停预览 | 鼠标停在引用上即显示块 + 全部子块 |
| 展开全文 | 整篇 / 光标处 / 按 UUID 三种粒度，输出到只读标签页 |
| 反向链接 | 列出所有引用位置，选中即跳转 |

---

# 第二部分 · 怎么安装

安装分两步，**两步都做完才算装好**。

- 第一步：装 VS Code 扩展（让编辑器认识块引用）
- 第二步：给你的笔记库放一份系统提示词（让 AI 知道有这些工具）

第二步常被跳过，但不做的话 AI 大概率不会主动调用工具——这是本插件最常见的「装了没效果」。

## 第一步：安装 VS Code 扩展

**方式一：从 Release 安装（推荐）**

1. 到 [Releases](../../releases) 页面下载最新的 `block-reference-interpreter-x.y.z.vsix`
2. `Ctrl+Shift+P` → **Extensions: Install from VSIX...** → 选中下载的文件
3. `Ctrl+Shift+P` → **Reload Window**

或直接用命令行：

```bash
code --install-extension block-reference-interpreter-0.2.1.vsix
```

**方式二：从源码构建**

```bash
npm install
npm run build
npx vsce package --allow-missing-repository
code --install-extension block-reference-interpreter-*.vsix
```

## 第二步：给笔记库加系统提示词 ⚠️

**这一步不做，AI 大概率不会主动调用工具。**

原因：VS Code 扩展**无法拦截** Copilot 内置的文件读取。AI 读 `.md` 时默认走的是内置读文件，看到的就是一串 `((uuid))`。它不会「自己想到」还有别的工具能解开它——除非有人明确告诉它。

所以要往**你的笔记库**里放一份指令文件，把「看到块引用必须调工具」写成硬规则。

### 文件从哪来

Release 页面提供一个单独的压缩包 **`notebook-instructions.zip`**，解压到**笔记库根目录**即可，它会自动展开成下面的目录结构。

也可以从仓库的 `templates/github/instructions/` 里复制同名文件，手动放到下面这个位置。

### 放在哪里

```
<你的笔记库根目录>/
└── .github/
    └── instructions/
        └── block-reference.instructions.md    ← 文件名必须以此结尾
```

以本项目的示例笔记库为例，完整路径是：

```
d:\扁舟听雨工作室\网文创作理论\.github\instructions\block-reference.instructions.md
```

### 三个必须核对的地方

| 项目 | 要求 | 常见错误 |
|---|---|---|
| 目录 | `.github/instructions/` | ❌ 放到 `.github/` 根下（不生效） |
| 文件名 | `*.instructions.md` | ❌ 用 `copilot-instructions.md`（不带点，不在识别列表里） |
| frontmatter | 必须有 `applyTo` | ❌ 漏掉，文件不会被自动加载 |

文件开头必须是这样：

```yaml
---
name: '块引用必须展开'
description: '读 Tine/Logseq 笔记、遇到 ((uuid)) 或 {{embed ((uuid))}} 块引用时使用。'
applyTo: '**'
---
```

> `.instructions.md` 这类文件靠 `applyTo` glob 决定作用范围。`applyTo: '**'` 表示对所有文件生效。
> 如果文件名不是以 `.instructions.md` 结尾，或者缺少 `applyTo`，VS Code 不会把它当作可自动加载的指令。

### 它规定了什么

那份指令文件的核心内容：

1. 读到 `((uuid))` 或 `{{embed ((uuid))}}`，**必须调用 `#blockRef`**，不许猜、不许跳过。
2. 要理解整篇笔记，**优先用 `#blockNote`** 而不是普通读文件。
3. 想知道谁引用了某个块，用 `#blockBacklinks`。
4. `#blockNote` 引用多时先用 `mode: "list"` 拿清单，再用 `#blockRef` 逐个读——避免一次性展开几十处被输出上限截断。
5. 工具说「未找到」就如实告知用户，不许编造内容。

---

# 第三部分 · 怎么确认装好了

按顺序做完这 5 项，全部通过才算真正可用。

## 1. 扩展是否装上

`Ctrl+Shift+P` → **Extensions: Show Installed Extensions** → 搜索 `块引用`，应看到「块引用解释器」。

或命令行：

```bash
code --list-extensions --show-versions | Select-String block-reference
```

## 2. 索引是否建起来

打开笔记库工作区，`Ctrl+Shift+P` → **块引用：重建索引**。

**期望**：右下角提示「索引完成：N 个文件 / M 个带 ID 块 / K 处引用」。

如果提示 0 个文件，说明图谱目录没识别对 → 运行 **块引用：选择 Tine 图谱目录**，选那个同时含 `pages/` 和 `logseq/` 的文件夹。

## 3. System prompt 是否生效

`Ctrl+Shift+P` → **Chat: Open Customizations** → 展开 **Instructions** → **Workspace**。

**期望**：能看到一条名为「块引用必须展开」的指令。

如果这里是 0 条，说明路径或文件名不对 → 回到「三个必须核对的地方」逐项检查。

## 4. 行内渲染是否生效

打开任意一篇含 `((uuid))` 的笔记。

**期望**：`((uuid))` 不再显示成一串 ID，而是显示成目标块的标题（蓝色下划线）。

如果仍是裸 UUID → 检查设置 `tineBlockRef.inlineRender.enabled` 是否被关掉。

## 5. AI 是否真的会调工具

在 Chat 里问：

```
这篇笔记第 33 行的块引用指的是什么内容？
```

**期望**：Chat 里出现一张工具调用卡片，写着「正在读取 N 个块引用的内容」。

如果 AI 直接回答却没调工具 → 见「注意事项 · 排查 AI 不调工具」。

---

# 第四部分 · 怎么用

## AI 工具

装好插件并 Reload 后，Copilot Chat 的 agent 模式会自动获得三个工具。它们只在内存里计算，**不会创建或修改任何文件**。

| `#` 引用名 | 用途 |
|---|---|
| `#blockRef` | 按 UUID 读取块及其全部子块 |
| `#blockNote` | 读取整篇笔记并展开其中的块引用 |
| `#blockBacklinks` | 查询谁引用了这个块 |

### `#blockNote` 的三种模式

| mode | 输出 | 何时用 |
|---|---|---|
| `list` | 只给清单（行号 + UUID + 目标块首行） | **引用多时优先用这个**，通常几 KB |
| `expand`（默认） | 整篇展开 | 引用少、需要完整上下文 |
| `both` | 清单 + 展开 | 两者都要 |

引用超过 8 处时 `expand` 会自动附带清单；超出输出预算的部分不会展开，并在末尾列出未展开的行号。

### 手动触发示例

```
用 #blockNote 读 pages/2驱动方分类、剧情模式.md，告诉我第 33 行那个块引用讲的是什么
```

```
#blockRef 66c73a56-ddda-44d2-80dd-009e44406fd4
```

## 行内渲染

默认开启。编辑器里的 `((uuid))` 会直接显示成目标块的首行文本：

```
原文：  参见 ((66c73a56-ddda-44d2-80dd-009e44406fd4))
显示为：参见 3.1 棋子觉醒/背叛
```

- **子块不在行内显示**（会把行撑爆），鼠标悬停时才展开块 + 子块。
- 标题的 `#` / `##` 标记默认去掉（`tineBlockRef.render.stripHeadingMarks`），画面更干净。
- 目标块不存在时显示 `⚠ 块不存在`，一眼就能发现失效引用。
- 同一 UUID 重复定义时显示 `标题（N 处重复）`。
- 行内文字是纯展示，不可点击；要看完整内容请悬停后点「展开全文」。

### 两种模式

| 模式 | 效果 | 适用 |
|---|---|---|
| `replace`（默认） | 隐藏原文，只显示标题 | 最接近笔记软件原生观感 |
| `append` | 保留原文，后面追加 `〔标题〕` | 光标行为完全正常，编辑时更顺手 |

**`replace` 模式的固有代价**：原文的字符宽度被压成 0，所以光标经过引用时会「看不见」。复制粘贴拿到的仍是原文 `((uuid))`（这是对的）。如果你经常需要直接编辑引用本身，建议切到 `append`。

切换方式：设置里搜 `tineBlockRef.inlineRender.mode`，或直接关闭 `tineBlockRef.inlineRender.enabled` 回到裸 UUID。

> **关于 embed 的显示**：Tine 原生的 embed 会展开显示整个块的内容。本插件的行内渲染只显示**首行标题**——因为多行内容塞进一行会破坏笔记排版。需要看完整内容时，悬停即可看到块 + 子块。

## 悬停预览

把鼠标停在任意块引用上，会弹出：

- 目标块的来源文件与行号
- 子树规模（多少行、多少字符）
- 块首行标题 + 前 6 行内容（含子块层级）
- 【展开全文】链接，点击打开完整内容

预览行数刻意压得较短（`tineBlockRef.hoverPreviewLines`，默认 6）：VS Code 的悬停框高度有限，内容一长底部按钮就会被滚动隐藏。行数少一点，按钮就始终可见。

悬空引用会显示「未找到该块」，重复 ID 会列出全部候选——不会静默失败。

## 展开全文

「展开全文」打开的是**只读标签页**（自定义 `tine-blockref:` 虚拟文档）：

- 有关键字高亮、查找、选中复制，体验与普通编辑器一致；
- **关闭时不会问「是否保存」**——因为它是只读的，永远不会变「脏」；
- 不产生任何磁盘文件。

也可以从命令面板直接触发整篇展开：

```markdown
- 1、如果主角决定对抗导演……参见 ((66c73a56-ddda-44d2-80dd-009e44406fd4))

── 块引用 ((66c73a56-ddda-44d2-80dd-009e44406fd4)) 展开 ──
### 块 `66c73a56-ddda-44d2-80dd-009e44406fd4`
来源：`pages/多驱动方的第三方分类、剧情模式.md` 第 131–177 行
规模：48 行 / 1240 字符

## 3.1 棋子觉醒/背叛
这种棋子也可以看作是一种变形者。
...
── 展开结束 ──
```

## 命令一览

| 命令 | 何时用 |
|---|---|
| 块引用：展开当前笔记为 AI 可读版 | 想整篇喂给 AI |
| 块引用：展开光标处的块引用 | 只想看某一个引用 |
| 块引用：按 UUID 展开单个块 | 已知 UUID，直接查 |
| 块引用：查看光标处块引用的反向链接 | 想知道这条内容被谁引用 |
| 块引用：查看块的反向链接 | 手动输入 UUID 查 |
| 块引用：重建索引 | 索引疑似过期 |
| 块引用：选择 Tine 图谱目录 | 自动探测失败 |
| 块引用：显示日志 | 排查问题 |

## 首次使用要设置图谱目录

打开命令面板（`Ctrl+Shift+P`），运行：

- **块引用：选择 Tine 图谱目录**

选择那个同时包含 `pages/` 和 `logseq/` 的文件夹。插件也会自动探测，探测成功就不用手动设。

---

# 第五部分 · 注意事项

## 排查：AI 不调工具

按顺序排查：

1. **System prompt 没生效** → 回到「第三部分 · 第 3 项」，确认 Workspace 下有 1 条。
2. **换了新对话** → 指令按对话加载，改完文件后需要新开一个会话。
3. **模型对工具调用不积极** → 直接在问题里带工具名，例如：`用 #blockNote 读这篇笔记`。
4. **工具被禁用** → Chat 输入框上方点工具图标，确认 `blockRef` / `blockNote` / `blockBacklinks` 三个都勾选。
5. **引用太多被截断** → 改用 `#blockNote` 的 `mode: "list"`，再用 `#blockRef` 逐个读。

## 排查：索引为空

- 确认图谱目录选对（必须同时含 `pages/` 和 `logseq/`）
- 打开「块引用：显示日志」，看是否有「图谱根目录下没有匹配到任何 Markdown 文件」
- 检查设置 `tineBlockRef.graphRoot` 是否指向了一个失效路径

## 安全性

**本插件全程只读**：不修改、不格式化、不重写任何笔记文件。所有结果都输出到：

- 只读虚拟文档标签页（关闭时不会提示保存）
- 输出面板日志
- 工具返回值与悬停提示

## 已知限制

- 只索引 `pages/` 与 `journals/`；`logseq/` 下的回收站与备份不参与索引。
- 悬空引用（目标块已被删除）会明确标注为「未找到」，不会静默失败。
- 重复 ID（同一 UUID 出现在多个文件）会列出全部候选并提示歧义。
- Tine 自带的 `tine block show` 命令在 Windows 上不可用（`cannot reach a graph's owner`），因此本插件自己实现解析，不依赖 CLI。
- 行内渲染在 `replace` 模式下会把原文 UUID 的字符宽度压成 0，光标经过引用时看不见原文。需要频繁直接编辑引用的话请切到 `append` 模式。

## 配置项

| 配置 | 默认值 | 说明 |
|---|---|---|
| `tineBlockRef.graphRoot` | 自动探测 | 图谱根目录 |
| `tineBlockRef.include` | `pages/**/*.md`, `journals/**/*.md` | 参与索引的文件 |
| `tineBlockRef.exclude` | `logseq/**`, `.tine-trash/**` 等 | 排除的路径 |
| `tineBlockRef.maxDepth` | `3` | 嵌套引用展开层数 |
| `tineBlockRef.maxOutputChars` | `20000` | 单次输出字符预算 |
| `tineBlockRef.hideProperties` | `id`, `collapsed` | 渲染时隐藏的属性 |
| `tineBlockRef.inlineRender.enabled` | `true` | 是否把 `((uuid))` 显示成块标题 |
| `tineBlockRef.inlineRender.mode` | `replace` | `replace` 隐藏原文 / `append` 追加标题 |
| `tineBlockRef.inlineRender.maxTitleLength` | `60` | 行内标题最大长度 |
| `tineBlockRef.inlineRender.showMissing` | `true` | 悬空引用显示 `⚠ 块不存在` |
| `tineBlockRef.render.stripHeadingMarks` | `true` | 渲染时去掉标题的 `#` 标记 |
| `tineBlockRef.hoverPreviewLines` | `6` | 悬停预览行数 |

---

# 附 · 开发

```bash
npm install
npm run build      # 打包到 dist/
npm test           # 单元测试 + 真实库冒烟测试
npm run typecheck  # 类型检查
```

核心解析逻辑在 `src/core/`，刻意不依赖 `vscode` 模块，可在普通 Node 环境直接测试。

## 目录说明

```
src/core/       纯解析层（块树、引用扫描、索引、渲染），不依赖 vscode
src/vscode/     VS Code 适配层（工具、命令、悬停、行内渲染）
src/test/       单元测试与真实库冒烟测试
templates/      分发给用户的模板文件（笔记库指令）
docs/           开发者内部文档（已 gitignore，不对外）
```

## 笔记库指令模板

指令文件的**唯一来源**是：

```
templates/github/instructions/block-reference.instructions.md
```

发布 Release 时需要单独打一个压缩包，内部结构必须是：

```
notebook-instructions.zip
└── .github/
    └── instructions/
        └── block-reference.instructions.md
```

生成方式（PowerShell，显式写入条目名以避免路径分隔符差异）：

```powershell
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::Open('notebook-instructions.zip','Create')
$entry = $zip.CreateEntry('.github/instructions/block-reference.instructions.md')
$stream = $entry.Open()
$bytes = [System.IO.File]::ReadAllBytes('templates/github/instructions/block-reference.instructions.md')
$stream.Write($bytes, 0, $bytes.Length)
$stream.Dispose(); $zip.Dispose()
```

打包后**务必解压验证**：确认 `.github` 目录未被隐藏、文件 hash 与模板一致、首字节不是 BOM。

## 工具内部名与引用名

容易搞混，所以单独说明：

| `registerTool` 内部名 | `toolReferenceName`（用户与模型看到的） |
|---|---|
| `tineBlockRef_readBlock` | `blockRef` |
| `tineBlockRef_readNote` | `blockNote` |
| `tineBlockRef_findBacklinks` | `blockBacklinks` |

**写文档、写指令、让 AI 引用时必须用右列。** 左列只在扩展源码里出现，模型完全看不到。
