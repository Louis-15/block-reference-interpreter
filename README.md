# Block Reference Interpreter（块引用解读工具）

Parses Tine / Logseq `((uuid))` block references inside VS Code, so both the editor and your AI assistant can read the real content behind them.

<a id="en"></a>

**English** ｜ [简体中文](#zh)

| Item | Detail |
|---|---|
| Extension ID | `louis-15.block-reference-interpreter` |
| Works with | Tine, Logseq, and other notes apps using the same block-reference syntax |
| Platforms | Windows / macOS / Linux |
| Data safety | AI tools and read paths are read-only. The only write path is the "Copy block reference / embed" command, which inserts one `id::` line when needed |
| License | MIT |

## Part 1 · What it does

### 1.1 The problem

Tine and Logseq render `((uuid))` as the referenced block's content, so reading is effortless inside those apps. The `.md` source, however, only keeps the UUID:

```markdown
- See ((3f7a1c2e-5b9d-4a11-8c3e-1d2f4b6a8c01)) for the implementation
```

Opening that file in VS Code leaves both you and the AI staring at a meaningless ID. Two things break:

- **Reading**: you have to jump back to the notes app to see what the reference points at.
- **AI analysis**: the model misses the referenced context and draws one-sided conclusions.

This extension indexes the whole graph locally, mapping every UUID to its block and all child blocks, and exposes that to the editor UI and to AI tools.

### 1.2 Backlinks

VS Code also lacks **backlinks** — where a block is referenced from. Tine and Logseq both ship a backlinks panel; this extension reproduces it, including the reference count badge, hover list, a full panel with restored indentation and expanded subtrees, collapsible branches, and click-to-jump. See [4.5 Backlinks](#45-backlinks).

### 1.3 Supported reference forms

| Form | Example | Notes |
|---|---|---|
| Inline | `((3f7a1c2e-5b9d-4a11-8c3e-1d2f4b6a8c01))` | The common case |
| Embed | `{{embed ((3f7a1c2e-5b9d-4a11-8c3e-1d2f4b6a8c01))}}` | Tine / Logseq embed syntax |
| Full-width brackets | `（（3f7a1c2e-...））` | Produced by Chinese IMEs |
| Spaced variant | `{{ embed (( 3f7a1c2e-... )) }}` | Tolerated; standard form unaffected |

All four behave identically in inline rendering, hover preview, AI tools and expanded views. Inline rendering replaces the **entire expression**, including the `{{embed ...}}` wrapper, so no `{{embed Title}}` residue is left behind.

**Leading space is mandatory.** Tine / Logseq only recognize a reference at the start of a line or **right after whitespace**. `参考：((uuid))` — glued to the preceding text or a full-width colon — still parses in this extension (so it looks fine in VS Code) but degrades to plain text once pasted back into Tine. The same applies to the `{{` of `{{embed`. `#blockCheck` reports this as a `reference-tight-prefix` warning, and `#blockLink` inserts the space for you.

### 1.4 Feature overview

| Feature | Description |
|---|---|
| Index | Background scan of `pages/` and `journals/`, building UUID → block and UUID → reference maps in memory. Built and maintained automatically as soon as a vault is opened |
| AI tools (8) | Read blocks, whole notes and backlinks; generate new block IDs, find blocks and outlines, link blocks in one call, prepare reference patches, and audit references |
| Block reference generation | AI writes valid `id::` and `((uuid))` via `#blockNewId`, `#blockFind`, `#blockLink`, `#blockMakeRef` and `#blockCheck`; you can also right-click and copy a reference or embed in one step |
| One-call linking | `#blockLink` adds any missing `id::`, computes indentation and level, and guarantees the leading space — the whole `find → makeRef → write` chain collapses into one call plus one audit |
| Inline rendering | Shows `((uuid))` as the target block's title, and reveals the real UUID on the line your cursor is on so it stays fully editable |
| Enter and soft line breaks | Enter splits blocks (empty blocks keep producing empty blocks); Shift+Enter inserts a soft line break inside a block, matching Tine / Logseq |
| Hover preview | Shows the target block and all of its children |
| Expanded view | Whole note, block at cursor, or block by UUID — rendered in a webview panel where every block is labelled with its source and clickable back to the original |
| Backlinks | Reference count at the end of the block line, hover list of referencing pages, and a full grouped panel with restored indentation, expanded subtrees, folding and click-to-jump. Also available to AI via `#blockBacklinks` |

## Part 2 · Installation

Two steps, **both required**:

1. Install the VS Code extension — teaches the editor to resolve block references.
2. Add an instructions file to your vault — tells the AI the tools exist.

Step 2 is easy to skip, and skipping it is the single most common reason the extension appears to "do nothing".

### 2.1 Step 1: install the extension

**From the Marketplace (recommended)** — search for "Block Reference Interpreter" in the Extensions view, or:

```bash
code --install-extension louis-15.block-reference-interpreter
```

Extension page: <https://marketplace.visualstudio.com/items?itemName=louis-15.block-reference-interpreter>

**From a VSIX** — download the `.vsix` from [Releases](https://github.com/Louis-15/block-reference-interpreter/releases), then `Ctrl+Shift+P` → **Extensions: Install from VSIX...**, and reload the window.

**From source**:

```bash
npm install
npm run build
npx vsce package --allow-missing-repository
code --install-extension block-reference-interpreter-*.vsix
```

> **Extension ID change**: versions up to 0.3.4 used the ID `local.block-reference-interpreter`. If you installed one of those, uninstall it first — otherwise two extensions activate at once and you get duplicate badges and panels.

### 2.2 Step 2: add the vault instructions

**Required.** Without it, the AI has no reason to call the tools.

VS Code extensions **cannot intercept** Copilot's built-in file reading. A plain read of a `.md` file shows the raw `((uuid))`, and the model will not guess that a resolver exists. It has to be told.

Download `notebook-instructions.zip` from the Release page and extract it into **your vault root**, or copy the file manually from `templates/github/instructions/` to:

```
<vault root>/.github/instructions/block-reference.instructions.md
```

Three things must be right:

| Item | Requirement | Common mistake |
|---|---|---|
| Directory | `.github/instructions/` | Putting it in `.github/` — silently ignored |
| Filename | must end with `.instructions.md` | Using `copilot-instructions.md` — not in the recognised list |
| Front matter | must contain `applyTo` | Omitting it — the file is never auto-loaded |

The instructions impose five rules: always call `#blockRef` on a block reference; prefer `#blockNote` over plain file reads; use `#blockBacklinks` for reverse lookups; use `mode: "list"` first when a note has many references; and never invent content when a tool reports "not found".

## Part 3 · Verifying the installation

Work through these six checks in order.

**3.1 Extension installed** — `Ctrl+Shift+P` → **Extensions: Show Installed Extensions** → search "Block Reference". Or `code --list-extensions --show-versions | Select-String block-reference`.

**3.2 Index built** — open your vault folder. You should see a notification such as `Block reference index built: 842 files / 917 blocks with ID / 1036 references (0.3s)`. If not, open the output channel and look for `[Index] Graph root:` — no such line means the vault was not detected (open the **folder**, not a single file, and make sure it contains both `pages/` and `logseq/`).

**3.3 Instructions loaded** — `Ctrl+Shift+P` → **Chat: Open Customizations** → **Instructions** → **Workspace** should list one entry.

**3.4 Inline rendering** — open a note with a `((uuid))`. It should display the target block's title instead of the raw ID.

**3.5 AI calls the tools** — ask "what does the block reference on line 33 point to?". A tool-call card should appear. If the model answers directly, see 5.1.

**3.6 Backlinks** — find a block with `id::` that is referenced elsewhere. A `🔗 N` badge appears at the end of its line; hovering lists the referencing pages; clicking "Open the full backlinks panel" shows the grouped panel.

## Part 4 · Usage

### 4.1 AI tools

| `#` name | Purpose |
|---|---|
| `#blockRef` | Read a block and all its children by UUID |
| `#blockNote` | Read a whole note with every block reference expanded |
| `#blockBacklinks` | Find where a block is referenced |
| `#blockNewId` | Generate fresh Tine / Logseq block IDs (UUID v4) with the exact `id::` line and reference text |
| `#blockFind` | Search blocks by title or body; also lists a note's outline in one call (`filePath` + `headingsOnly` + `headingLevel`) |
| `#blockLink` | Link one or more existing blocks into a note in a single call: adds missing `id::`, computes the exact reference blocks and returns every patch at once |
| `#blockMakeRef` | Produce a precise patch (`oldText` / `newText` plus unified diff) for a block without `id::` |
| `#blockCheck` | Audit `id::` placement, dangling references, duplicate UUIDs, malformed references, and references with no preceding space |

Reading and auditing tools are memory-only. `#blockLink` and `#blockMakeRef` return text; the AI applies it with its own editing tool, which keeps Copilot's accept/reject step in the loop.

`#blockLink` is the fast path: the whole `find → makeRef → write reference` chain collapses into one call (plus one `#blockCheck`). A typical "reference two blocks" task finishes in four tool calls, and the leading space that Tine / Logseq require before `((uuid))` is inserted by the tool, so it cannot be forgotten.

`#blockNote` has three modes: `list` (just the reference list — several KB, prefer it when there are many references), `expand` (default, full expansion), and `both`. Beyond eight references `expand` attaches the list automatically and reports any lines that exceeded the output budget.

#### Listing a note's structure

To reference "the second level-2 heading of a note", do not scan the file with a terminal. One call:

```text
#blockFind { filePath: "pages/note.md", headingsOnly: true, headingLevel: 2, limit: 200 }
```

Returns a numbered, single-line-per-hit outline in file order. Levels 1–6 all work; omit `headingLevel` to get every level. Leave `query` empty to skip keyword filtering — `filePath` is then required, since an empty query across the whole vault would dump every block.

```text
1. pages/note.md:5    # 11 Overview          no id
2. pages/note.md:53   # 12 Details           id: 68010957-…
```

#### Linking blocks in one call

```text
#blockLink {
  destination: { filePath: "pages/my-note.md", line: 6, expectedFirstLine: "References" },
  targets: [
    { filePath: "pages/note.md", line: 5,   expectedFirstLine: "# 11 Overview", label: "Overview" },
    { filePath: "pages/note.md", line: 387, expectedFirstLine: "# 13 Details",  label: "Details", kind: "embed" }
  ]
}
```

It generates a UUID and an `id::` patch for every target that lacks one, resolves the destination indentation from real child blocks in that file (tabs stay tabs), writes the leading space for you, and returns every patch plus the exact reference lines. You apply them with your editing tool and run `#blockCheck` once. `position: "sibling"` appends the references next to the destination block instead of inside it.

### 4.2 Inline rendering

`((uuid))` is replaced by the target block's first line. Child blocks are not shown inline — hover for those. Missing targets render as `⚠ Block not found`; duplicate UUIDs render as `Title (N duplicates)`.

Three modes (`tineBlockRef.inlineRender.mode`):

| Mode | Effect |
|---|---|
| `activeLine` (default) | Shows the target title everywhere, **but reveals the real `((uuid))` on the line your cursor is on**. This is the only mode where you can place the cursor to the right of a reference, select it, and edit it |
| `replace` | Always hides the raw UUID and shows only the title. Cleanest look, but VS Code compresses the UUID to zero width, so the cursor can no longer reach the right side of a reference |
| `append` | Keeps the raw UUID visible and appends `〔Title〕`. Cursor behaviour is always normal |

Why `activeLine` is the default: VS Code has no API to render replacement text, so the only way to show a title in place of `((uuid))` is a decoration that sets `font-size: 0` on the original characters. That also destroys the clickable area, which is why in `replace` mode pressing Enter on such a line produces a soft line break instead of a new block. `activeLine` sidesteps the problem by restoring the real characters on the line you are editing.

Copy-paste always yields the raw `((uuid))` text. Turn `tineBlockRef.inlineRender.enabled` off to see bare UUIDs everywhere.

> **About embeds**: Tine's native embed expands the whole block. Inline rendering here shows only the first line, because expanding many lines into one would break the note's layout. Hover to see the block and its children.

#### Editing: Enter and Shift+Enter

Inside the Tine graph (`pages/**`, `journals/**` only), typing is aligned with Tine / Logseq:

| Key | Behaviour |
|---|---|
| **Enter** | Splits the current block into two **sibling** blocks, keeping the original indentation. Empty blocks keep producing new empty blocks, so you can leave as many blank blocks as you like |
| **Enter** outside any block | Inserts a `- ` bullet, so the new line becomes an outline block. This applies to blank lines, top-level text, and files with no blocks yet |
| **Shift+Enter** | Inserts a **soft line break inside the block**: newline plus content indentation (block indent + two spaces), no new bullet |
| Both keys inside a code fence | Plain newline only. `Enter` does not add `- `, and `Shift+Enter` does not auto-indent, which would break indentation-sensitive languages such as Python |
| Both keys in frontmatter, page properties, tables, or with a selection | Not intercepted; VS Code behaves normally |

Only files inside the indexed graph are affected, so ordinary Markdown folders keep their default behaviour. Set `tineBlockRef.enterSplitBlock` to `false` to turn Enter handling off entirely.

### 4.3 Hover preview

Hovering a reference shows the source file and line, subtree size, the block title and its first six lines, plus an **Expand full text** link. The line count is deliberately short (`hoverPreviewLines`, default 6): VS Code's hover box has limited height and a long preview pushes the bottom buttons out of view.

### 4.4 Expanded view

"Expand full text" opens a **webview panel**, not a read-only text document, so every block's source is clickable. Clicking the source path opens that note and selects the block's first line — selecting the whole line rather than placing a bare cursor, because a thin caret is invisible against a wall of text.

Content uses small grey bullets rather than Markdown dashes, matching Tine / Logseq, with indentation restored level by level.

Why a webview: **links inside a text editor always require Ctrl+Click** (clicking means "place the cursor" in an editor). Webview links respond to a plain left click, which is what makes the panel feel like Tine. Set `tineBlockRef.backlinks.panel` to `text` if you would rather have Ctrl+F and free copying.

### 4.5 Backlinks

| Capability | Tine | This extension |
|---|---|---|
| Reference count near the block | Floating number, top-right | `🔗 N` badge at end of line |
| Hover to see referencing pages | Yes | Yes, each with a breadcrumb |
| Group all references by page | Yes | Yes, sorted by reference count |
| Show the section the reference lives in | `3 Performance › 3.2 Indexing` | Same breadcrumb path |
| Show the referencing block with its children | Yes | Full subtree, indentation restored |
| Fold / unfold children | Small triangle | `▾` / `▸` plus a collapse-all button |
| Click a title to jump | Yes | Plain left click, no Ctrl |
| Remember fold state | Yes | Survives switching tabs |
| **AI can query backlinks** | No | `#blockBacklinks` |

Two differences are unavoidable: the count sits at the end of the line rather than floating at the block's top-right, and the panel opens as a tab beside the editor rather than in a right-hand dock. Both are consequences of the VS Code extension model.

### 4.6 Language

`tineBlockRef.language` controls the language of messages, hovers, panels and tool results: `auto` (follow VS Code), `en`, or `zh-cn`. **Command titles and setting names follow the VS Code display language and cannot be overridden** — those strings are read by the editor itself when rendering the command palette and settings page.

### 4.7 Commands

All twelve commands live under "Block Reference:" in the command palette: expand current note, expand reference at cursor, expand block by UUID, show backlinks for reference at cursor, show backlinks for block, open backlinks panel, copy reference to current block, copy embed to current block, insert soft line break inside the block, enter (create a sibling block), rebuild index, select Tine graph directory, show log.

"Copy reference / embed to current block" behaves like Tine's *Copy block reference*: if the block has no `id::`, one is inserted, the note is saved, and `((uuid))` or `{{embed ((uuid))}}` is placed on the clipboard.

The two key commands are bound to shortcuts inside Tine notes only:

| Key | Command | Effect |
|---|---|---|
| `Enter` | Enter (Create a Sibling Block) | Splits the block; on an empty block it keeps producing empty blocks; in plain body text it inserts `- ` so the new line is an outline block |
| `Shift+Enter` | Insert Soft Line Break Inside the Block | Line break inside the same block, preserving indentation |

Both are scoped with `editorTextFocus && editorLangId == markdown`, so **pressing Enter in the Copilot chat box, the search box or any other input no longer writes into your note**. When the conditions are not met (not a Tine note, frontmatter, page properties, tables, an active selection, or the suggestion widget open) they fall back to VS Code's native behaviour.

"Rebuild index" and "Select Tine graph directory" are fallbacks, not daily steps.

### 4.8 Graph detection and index maintenance

Opening a folder that contains both `pages/` and `logseq/` triggers automatic detection — no configuration. Detection also accepts `logseq/config.edn` or `.tine-trash/`, and searches up to ten levels, so opening a subfolder works too.

The index updates automatically on: vault open, edits in Tine, saves in VS Code, **unsaved edits** (250 ms after you stop typing), file creation/deletion, external changes such as a git checkout, and setting changes.

## Part 5 · Notes

### 5.1 The AI does not call the tools

Check in order: the instructions file is loaded (3.3); you are in a new chat (instructions load per conversation); name the tool explicitly ("use #blockNote to read this note"); the tools are enabled in the chat tool picker; or the output was truncated (switch to `mode: "list"`).

### 5.2 Backlinks do not appear

If the badge is missing: `editor.inlayHints.enabled` may be off (badges vanish silently — set `backlinks.style` to `lens` to bypass); the block genuinely is not referenced; `backlinks.style` is `off`; or the index is still building. If the badge exists but the hover list is empty, the index is stale — rebuild it.

### 5.3 The index is empty

Check the `[Index] Graph root:` line in the output channel. The path must actually contain `pages/` with `.md` files. "Rebuild index" will not fix a detection failure — it only rescans the directory it already has.

### 5.4 Data safety

The AI tools and all read paths are **read-only**: they never modify, reformat, or rewrite notes. Everything they produce goes to webview panels, read-only virtual documents, the output channel, or tool return values.

There is exactly one write path, and you trigger it yourself: **Block Reference: Copy Reference / Copy Embed to Current Block**. When the target block has no `id::`, that command inserts a single `id::` line and saves the document before copying. No other command and no AI tool writes to your vault.

`#blockMakeRef` and `#blockLink` deliberately **return patches instead of writing them**. Copilot's accept/reject bar only covers the AI's own editing tool — anything a tool writes privately never shows up there, so you could not reject it and would have to fall back to Ctrl+Z or `git diff`. Keeping the write in the editing tool is what makes "reject" work.

### 5.5 Known limitations

Only `pages/` and `journals/` are indexed. Backlink badge position and panel placement differ from Tine for the reasons above. Badges depend on `editor.inlayHints.enabled`. The expanded view has no Ctrl+F (use the webview's own find). With several vaults open only one is indexed. Dangling references and duplicate IDs are reported explicitly rather than silently.

References glued to preceding text (`参考：((uuid))`) parse in this extension but do not render in Tine / Logseq. `#blockCheck` reports them as `reference-tight-prefix`; the fix is one space.

In `replace` inline-rendering mode the original UUID is compressed to zero width, so the cursor cannot reach the right side of a reference. Use the default `activeLine` mode (or `append`) if you edit references often.

### 5.6 Settings

See the settings page (search `tineBlockRef`). Every setting is documented inline. The two that affect editing:

| Setting | Default | Effect |
|---|---|---|
| `tineBlockRef.inlineRender.mode` | `activeLine` | `activeLine` reveals the raw UUID on the cursor line / `replace` always hides it / `append` keeps it visible and appends the title |
| `tineBlockRef.enterSplitBlock` | `true` | Enter splits blocks and Shift+Enter inserts a soft line break inside the Tine graph |

## Appendix · Development

```bash
npm install
npm run build      # bundle to dist/
npm test           # unit tests + real-vault smoke tests
npm run typecheck
```

Parsing logic lives in `src/core/` and deliberately does not import `vscode`, so all 320 tests run in plain Node. See [AGENTS.md](https://github.com/Louis-15/block-reference-interpreter/blob/main/AGENTS.md) for architecture notes, publishing flow and platform pitfalls.

---

<a id="zh"></a>

**[English](#en)** ｜ 简体中文

在 VS Code 中解析 Tine / Logseq 笔记的 `((uuid))` 块引用，使编辑器与 AI 均能读取被引用块的完整内容。

| 项目 | 说明 |
|---|---|
| 扩展 ID | `louis-15.block-reference-interpreter`（沿用早期命名，扩展上架后不可变更） |
| 适用笔记软件 | Tine、Logseq，以及采用相同块引用格式的同类实现 |
| 运行平台 | Windows / macOS / Linux |
| 数据安全 | AI 工具与读取路径只读；唯一写入路径是用户主动执行的「复制块引用 / 嵌入引用」，必要时插入一行 `id::` |
| 许可证 | MIT |

---

# 第一部分 · 功能说明

## 1.1 待解决的问题

Tine 与 Logseq 使用 `((uuid))` 表示对另一个块的引用。笔记软件会将该表达式渲染为被引用块的内容，人工阅读不存在障碍。但 `.md` 源文件中只保留 UUID 本身：

```markdown
- 具体实现参见 ((3f7a1c2e-5b9d-4a11-8c3e-1d2f4b6a8c01))
```

在 VS Code 中直接打开该文件时，编辑器与 AI 都只能看到这一串 UUID，无法得知它指向哪个块、该块包含哪些内容。由此产生两类问题：

- **人工阅读**：需要反复切换到笔记软件中确认引用内容，打断阅读连续性。
- **AI 分析**：AI 缺少引用上下文，整理或分析笔记时会遗漏关键信息，结论片面。

本插件在本地解析整个笔记图谱，建立「UUID → 被引用块及其全部子块」的映射，并将该能力同时提供给编辑器界面与 AI。

## 1.2 补齐反向链接能力

VS Code 中另有一项基础能力的缺失：**反向链接**，即某个块被哪些位置引用。

Tine 与 Logseq 均提供反链面板，VS Code 原生不具备。本插件的反链模块以 Tine 的表现作为设计基准，涵盖：块行尾引用计数、悬停列出引用页面、完整面板还原缩进并展开全部子块、子块折叠、单击跳转。详细说明见 [4.5 反向链接](#45-反向链接)。

## 1.3 支持的引用形式

| 形式 | 示例 | 说明 |
|---|---|---|
| 行内引用 | `((3f7a1c2e-5b9d-4a11-8c3e-1d2f4b6a8c01))` | 最常见形式 |
| 嵌入引用 | `{{embed ((3f7a1c2e-5b9d-4a11-8c3e-1d2f4b6a8c01))}}` | Tine / Logseq 的 embed 语法 |
| 全角括号 | `（（3f7a1c2e-5b9d-4a11-8c3e-1d2f4b6a8c01））` | 中文输入法下容易输出全角括号 |
| 含空白变体 | `{{ embed (( 3f7a1c2e-... )) }}` | 容错解析，标准写法不受影响 |

四种形式在行内渲染、悬停预览、AI 工具、展开全文四处行为保持一致：

- 行内渲染会将**整个表达式**替换为目标块标题，包括 `{{embed ...}}` 外层包裹，不会残留 `{{embed 标题}}` 之类的畸形结果。
- 悬停时，鼠标位于 `{{embed` 前缀、UUID 主体或结尾 `}}` 上均可触发预览。

### 引用前面必须有空白

这是 Tine / Logseq 的原生规则：只有「行首」或「空白之后」的 `((uuid))` 与 `{{embed` 才会被识别成引用。

| 写法 | 本扩展 | Tine / Logseq |
|---|---|---|
| `- 参考 ((uuid))` | ✅ | ✅ |
| `- ((uuid))`（行首） | ✅ | ✅ |
| `- 参考：((uuid))`（紧贴全角冒号） | ⚠️ 能解析，看着正常 | ❌ 不渲染，退化成普通文本 |
| `- 参考：{{embed ((uuid))}}` | ⚠️ 能解析 | ❌ 不渲染 |

这是最容易漏掉的一类坏引用：在 VS Code 里一切正常，粘回 Tine 才发现是死链。因此：

- `#blockCheck` 把它报为 `reference-tight-prefix` 警告；
- `#blockLink` 在生成引用行时由代码保证空格，不依赖模型手写。

## 1.4 功能一览

| 功能 | 说明 |
|---|---|
| 索引 | 后台扫描 `pages/` 与 `journals/`，建立 UUID → 块、UUID → 引用的内存索引。打开笔记库即自动建立并持续维护，无需手动操作 |
| AI 工具（8 个） | 读取块 / 整篇笔记 / 反链，生成新块 ID、查找块与大纲、一次链接多个块、准备引用补丁、校验引用 |
| 生成块引用 | AI 用 `#blockNewId`、`#blockFind`、`#blockLink`、`#blockMakeRef`、`#blockCheck` 写出合法的 `id::` 与 `((uuid))`；人工可通过右键菜单「复制当前块的引用 / 嵌入引用」一步完成 |
| 一次链接多个块 | `#blockLink` 自动补 `id::`、算好缩进层级、保证引用前的空格，把「查找 → 补 ID → 写引用」压成一次调用加一次校验 |
| 行内渲染 | 将 `((uuid))` 直接显示为目标块标题；光标所在行显示真实 UUID，可自由定位、选中与编辑 |
| 回车与块内换行 | 回车拆出同级块（空块继续产生空块），Shift+Enter 在块内软换行，与 Tine / Logseq 一致 |
| 悬停预览 | 鼠标悬停在引用上时显示目标块及其全部子块 |
| 展开全文 | 支持整篇、光标处、按 UUID 三种粒度，输出到网页面板；每个块标注来源，单击即可跳回原文 |
| 反向链接 | 块行尾显示引用计数，悬停列出引用页面，完整面板按页面分组、还原缩进、展示引用处的全部子块，支持折叠与单击跳转；AI 可通过 `#blockBacklinks` 查询 |

---

# 第二部分 · 安装

安装包含两个步骤，**两步均需完成**：

1. 安装 VS Code 扩展 —— 使编辑器能够解析块引用。
2. 为笔记库配置指令文件 —— 使 AI 知晓这些工具的存在。

第二步容易被忽略，但若跳过，AI 通常不会主动调用工具，表现为「已安装但无效果」。这是本插件最常见的使用障碍。

## 2.1 步骤一：安装扩展

### 方式一：从扩展市场安装（推荐）

在 VS Code 扩展面板中搜索「块引用解读工具」并安装，或执行：

```bash
code --install-extension louis-15.block-reference-interpreter
```

扩展主页：<https://marketplace.visualstudio.com/items?itemName=louis-15.block-reference-interpreter>

### 方式二：从 VSIX 安装

适用于扩展市场不可用、或需要安装特定版本的情形。

1. 从 [Releases](https://github.com/Louis-15/block-reference-interpreter/releases) 下载对应的 `.vsix` 文件。
2. `Ctrl+Shift+P` → **Extensions: Install from VSIX...** → 选择该文件。
3. `Ctrl+Shift+P` → **Developer: Reload Window**。

或使用命令行：

```bash
code --install-extension <下载的 vsix 文件名>.vsix
```

### 方式三：从源码构建

```bash
npm install
npm run build
npx vsce package --allow-missing-repository
code --install-extension block-reference-interpreter-*.vsix
```

> **扩展 ID 变更提醒**：早期版本（0.3.4 及以前）的扩展 ID 为 `local.block-reference-interpreter`，
> 与当前版本属于两个不同扩展。若曾安装旧版本，请先卸载再安装，否则两个扩展会同时激活，
> 导致徽章与面板重复出现。

## 2.2 步骤二：配置笔记库指令

**此步骤为必需项。** 若跳过，AI 通常不会主动调用工具。

原因在于 VS Code 扩展**无法拦截** Copilot 内置的文件读取行为。AI 读取 `.md` 文件时默认使用内置读取功能，看到的仍是 `((uuid))` 原文，不会自行推断存在其他可解析该表达式的工具，除非有明确指令告知。

因此需要在**笔记库**中放置一份指令文件，将「遇到块引用必须调用工具」确立为强制规则。

### 文件来源

Release 页面提供独立的压缩包 `notebook-instructions.zip`：解压至**笔记库根目录**即可，压缩包内已包含完整的目录结构。

下载直链（始终指向最新版本）：

```
https://github.com/Louis-15/block-reference-interpreter/releases/latest/download/notebook-instructions.zip
```

也可从仓库的 `templates/github/instructions/` 复制同名文件，手动放置到下述位置。

### 目标位置

```
<笔记库根目录>/
└── .github/
    └── instructions/
        └── block-reference.instructions.md    ← 文件名必须以此结尾
```

按操作系统举例：

| 系统 | 示例路径 |
|---|---|
| Windows | `D:\我的笔记库\.github\instructions\block-reference.instructions.md` |
| macOS / Linux | `~/notes/.github/instructions/block-reference.instructions.md` |

### 三项必须核对的内容

| 项目 | 要求 | 常见错误 |
|---|---|---|
| 目录 | `.github/instructions/` | 放置于 `.github/` 根目录下，不生效 |
| 文件名 | 必须以 `.instructions.md` 结尾 | 误用 `copilot-instructions.md`，该名称不在识别列表中 |
| 前置元数据 | 必须包含 `applyTo` 字段 | 遗漏该字段时文件不会被自动加载 |

文件开头应当为：

```yaml
---
name: '块引用：读取与生成'
description: '读或写 Tine/Logseq 笔记时使用。读：遇到 ((uuid)) 必须调用 #blockRef 展开真实内容；写：新建块用 #blockNewId，补 ID 用 #blockFind + #blockMakeRef，写完用 #blockCheck 校验。'
applyTo: '**'
---
```

`.instructions.md` 类文件依据 `applyTo` 的 glob 表达式决定作用范围，`applyTo: '**'` 表示对所有文件生效。

### 升级扩展后必须重新复制

**这一步最容易被忽略。** 指令文件放在**你的笔记库**里，不在扩展目录里，扩展升级不会自动更新它。

从 0.4.x 升级到 0.5.0 及以上时，旧指令文件只讲「怎么读块引用」，没有「怎么生成块引用」的规则。若不替换，AI 仍然不会调用 `#blockNewId` / `#blockFind` / `#blockLink` / `#blockMakeRef` / `#blockCheck`，表现为「装了新版本但 AI 还是不会写块引用」。

判断当前文件是否为新版：用文本编辑器打开，看是否有 `## 五、写笔记时如何生成块引用` 这一节。0.5.2 起还应包含 `## 六、最短路径：不要自己加验证`。缺任何一节都说明是旧版，按上面「文件来源」重新下载覆盖即可。

覆盖前注意：如果你曾在旧文件里加过自己的规则，请先把那些规则摘出来，覆盖后重新补进去。

### 指令文件的核心约束

1. 遇到 `((uuid))` 或 `{{embed ((uuid))}}`，**必须调用 `#blockRef`**，不得猜测，不得跳过。
2. 需要理解整篇笔记时，**应优先使用 `#blockNote`**，而非普通文件读取。
3. 需要确认某个块被哪些位置引用时，使用 `#blockBacklinks`。
4. `#blockNote` 在引用数量较多时应先以 `mode: "list"` 获取清单，再用 `#blockRef` 逐个读取，避免一次性展开数十处导致输出超出上限被截断。
5. 工具返回「未找到」时，应如实告知用户，不得编造内容。
6. 新建需要被引用的块时，必须用 `#blockNewId` 拿 UUID，不得自己编造。
7. **引用已有块时优先用 `#blockLink`**：一次调用就能拿到「补 `id::`」与「写引用」的全部补丁。只有只想补 ID、不写落点时，才用 `#blockMakeRef`。
8. 找「某篇笔记的第 N 个标题」这类位置时，用 `#blockFind` + `headingsOnly` + `headingLevel`，**不要用终端扫文件**。
9. 写完 `id::` 或 `((uuid))` 后必须调用 `#blockCheck` 校验，整篇只跑一次。
10. 区分「块内软换行」（缩进续行，不加 `- `）与「子块」（`- ` + 更深缩进），不要把同块多行写成多个块。
11. **`((` 与 `{{embed` 前面必须是行首或空格**。紧贴文字或中文标点的写法在 VS Code 里看着正常，但 Tine / Logseq 不会渲染。

---

# 第三部分 · 验证安装

按顺序完成以下 6 项检查，全部通过即表示安装完整。

## 3.1 扩展是否安装成功

`Ctrl+Shift+P` → **Extensions: Show Installed Extensions** → 搜索「块引用」，应能看到「块引用解读工具」。

或通过命令行确认：

```bash
code --list-extensions --show-versions | Select-String block-reference
```

预期输出形如 `louis-15.block-reference-interpreter@<版本号>`。

## 3.2 索引是否建立

**无需手动操作。** 打开笔记库文件夹时，插件会自动识别并建立索引，完成后在右下角显示提示：

```
块引用索引已建立：842 个文件 / 917 个带 ID 块 / 1036 处引用（0.3s）
```

出现该提示即表示索引正常。

**若未出现提示**，按顺序排查：

1. 打开「块引用：显示日志」，确认是否记录了 `[索引] 图谱根目录：...`。
   - **无此行** —— 未探测到笔记库。请确认打开的是**文件夹**而非单个文件，且该文件夹下同时存在 `pages/` 与 `logseq/`。
   - **有此行但文件数为 0** —— 路径正确但未匹配到笔记。检查 `tineBlockRef.graphRoot` 是否指向已失效的路径。
2. 若仍未解决，执行 **块引用：选择 Tine 图谱目录** 手动指定一次。

> **「重建索引」无法解决探测失败**。该命令仅重新扫描当前图谱目录；目录本身未正确识别时，重建多少次结果都是 0 个文件。

> 可通过 `tineBlockRef.showIndexNotification` 关闭该提示。关闭后索引仍会正常建立，仅不再弹出通知。

## 3.3 指令文件是否生效

`Ctrl+Shift+P` → **Chat: Open Customizations** → 展开 **Instructions** → **Workspace**。

**预期结果**：列表中显示一条名为「块引用必须展开」的指令。

若该处为空，说明路径或文件名不正确，请回到 [2.2 步骤二](#22-步骤二配置笔记库指令)逐项核对。

## 3.4 行内渲染是否生效

打开任意一篇包含 `((uuid))` 的笔记。

**预期结果**：`((uuid))` 不再显示为 ID 字符串，而是显示为目标块的标题；把光标移到那一行，标题会还原成真实的 `((uuid))`，此时可以正常选中、编辑。

若仍显示为裸 UUID，请检查设置 `tineBlockRef.inlineRender.enabled` 是否被关闭。

## 3.5 AI 是否会调用工具

在 Chat 中提问：

```
这篇笔记第 33 行的块引用指向什么内容？
```

**预期结果**：Chat 中出现工具调用卡片，显示正在读取块引用的内容。

若 AI 直接作答而未调用工具，请参阅 [5.1 排查：AI 不调用工具](#51-排查ai-不调用工具)。

## 3.6 反向链接是否生效

打开一篇笔记，找到包含 `id::` 且被其他位置引用过的块。

**预期结果**：该块所在行行尾出现 `🔗 N` 徽章。将鼠标悬停其上，会列出引用该块的页面。

点击悬停框最下方的「查看完整反链面板」，**预期结果**：在编辑器旁打开面板，按页面分组列出全部引用，每条包含面包屑、块标题与缩进的子块，标题左侧带有 `▾` 三角。点击蓝色标题，应直接跳转到对应笔记的对应行。

若看不到徽章，请参阅 [5.2 排查：反链不显示](#52-排查反链不显示)。

---

# 第四部分 · 使用说明

## 4.1 AI 工具

安装插件并重载窗口后，Copilot Chat 的 agent 模式会自动获得七个工具。读取与校验类工具仅在内存中计算，**不会创建或修改任何文件**；补丁类工具只返回文本，由 AI 用自己的编辑工具落盘。

| `#` 引用名 | 用途 |
|---|---|
| `#blockRef` | 按 UUID 读取块及其全部子块 |
| `#blockNote` | 读取整篇笔记并展开其中的块引用 |
| `#blockBacklinks` | 查询引用该块的位置 |
| `#blockNewId` | 生成新的 Tine / Logseq 块 ID（UUID v4），返回 `id::` 行与引用文本 |
| `#blockFind` | 按标题或正文搜索块；也可用 `filePath` + `headingsOnly` + `headingLevel` 一次列出整篇笔记的大纲 |
| `#blockLink` | 一次调用把若干已有块引用进笔记：补缺失的 `id::`、算好引用块的位置与缩进，一次性给出全部补丁 |
| `#blockMakeRef` | 为没有 `id::` 的块生成精确补丁（`oldText` / `newText` + unified diff） |
| `#blockCheck` | 校验 `id::` 位置、悬空引用、重复 UUID、畸形引用，以及引用前缺少空格 |

### 写笔记时的推荐顺序

1. 新建块并需要被引用：`#blockNewId` → 写入 `id::`；
2. **引用已有块（默认）**：`#blockFind` 定位（找结构用 `headingsOnly`）→ `#blockLink` 一次拿到全部补丁 → 应用补丁；
3. 只想补 ID、不写落点时，才用 `#blockMakeRef` 拿单个补丁；
4. 写完：`#blockCheck` 一次，有错误先修。

一次「引用 2 个块」的标准任务在 **4 次调用内**结束。`#blockLink` 会同时解决三件容易出错的事：补 `id::`、算出引用块的缩进层级、保证 `((uuid))` 前面有空格。

### `#blockNote` 的三种模式

| mode | 输出内容 | 适用场景 |
|---|---|---|
| `list` | 仅返回清单（行号 + UUID + 目标块首行） | **引用较多时优先使用**，输出通常仅数 KB |
| `expand`（默认） | 完整展开 | 引用较少、需要完整上下文 |
| `both` | 清单与展开内容 | 两者均需 |

引用超过 8 处时，`expand` 模式会自动附加清单；超出输出预算的部分不会被展开，并在末尾列出未展开的行号。

### 调用示例

```
用 #blockNote 读取 pages/项目说明.md，说明第 8 行的块引用指向什么内容
```

```
#blockRef 3f7a1c2e-5b9d-4a11-8c3e-1d2f4b6a8c01
```

### 列举笔记结构（找「第 N 个标题」）

要引用「某篇笔记的第 2 个二级标题」这类位置，**不要让 AI 用终端扫文件**。一次调用：

```
#blockFind { filePath: "pages/傲娇.md", headingsOnly: true, headingLevel: 2, limit: 200 }
```

返回按文件顺序编号、每条一行的清单，1–6 级标题都能查：

```
1. pages/傲娇.md:5    # 11 行为模式概括   no id
2. pages/傲娇.md:53   # 12 收到情感表达   id: 68010957-…
```

`headingLevel` 省略时返回全部层级；`query` 留空表示不按关键词过滤（此时必须给 `filePath`，否则会退化成「把全库块都倒出来」）。`limit` 上限为 200。

### 一次链接多个块

```
#blockLink {
  destination: { filePath: "pages/我的笔记.md", line: 6, expectedFirstLine: "引用区" },
  targets: [
    { filePath: "pages/傲娇.md", line: 5,   expectedFirstLine: "# 11 行为模式概括", label: "行为模式" },
    { filePath: "pages/傲娇.md", line: 387, expectedFirstLine: "# 13 产生情感需求", label: "情感需求", kind: "embed" }
  ]
}
```

它会：给每个没有 `id::` 的目标生成 UUID 与插入补丁；按目标文件里**真实的子块缩进**决定引用行的缩进（Tab 保持 Tab）；在引用前自动补空格；一次性返回全部补丁与最终会写入的引用行。

你只需用编辑工具原样应用，再跑一次 `#blockCheck`。`position: "sibling"` 可把引用写成落点块的同级块而不是子块。

## 4.2 行内渲染

默认启用。编辑器中的 `((uuid))` 会直接显示为目标块的首行文本：

```
原文：  具体实现参见 ((3f7a1c2e-5b9d-4a11-8c3e-1d2f4b6a8c01))
显示：  具体实现参见 增量索引
```

具体行为：

- **子块不在行内显示**，避免单行内容过长；鼠标悬停时才展开块及其子块。
- 标题的 `#` / `##` 标记默认去除（`tineBlockRef.render.stripHeadingMarks`），视觉更整洁。
- 目标块不存在时显示 `⚠ 块不存在`，便于及时发现失效引用。
- 同一 UUID 重复定义时显示 `标题（N 处重复）`。
- 行内文字为纯展示内容，不可点击；查看完整内容请悬停后点击「展开全文」。

### 三种渲染模式

| 模式 | 效果 | 适用场景 |
|---|---|---|
| `activeLine`（默认） | 平时显示标题；**光标所在行显示真实 `((uuid))`** | 唯一能自由定位光标、选中、编辑引用的模式 |
| `replace` | 始终隐藏原文，仅显示标题 | 视觉最接近笔记软件，但光标无法到达引用右侧 |
| `append` | 保留原文，在其后追加 `〔标题〕` | 任何时候都能精确点击，UUID 一直可见 |

为什么默认改成 `activeLine`：VS Code 没有「替换显示文本」的 API，只能把原文压缩成 0 宽度再用装饰层画标题。字符宽度归零后，鼠标再也点不到引用右侧，引用也选不中、编辑不了，行尾回车还会变成块内换行而不是新建块。`activeLine` 在你正在编辑的那一行还原真实字符，从根本上避开这个问题。

复制粘贴得到的仍然是原文 `((uuid))`，这一点是正确的。关闭 `tineBlockRef.inlineRender.enabled` 可恢复显示裸 UUID。

> **关于 embed 的显示**：Tine 原生的 embed 会展开显示整个块的内容。本插件的行内渲染仅显示首行标题，因为多行内容压入单行会破坏笔记排版。需要查看完整内容时，悬停即可看到块及其全部子块。

### 回车与块内换行

只对 Tine 图谱内（`pages/**`、`journals/**`）的 Markdown 生效，编辑手感与 Tine / Logseq 对齐：

| 按键 | 行为 |
|---|---|
| **回车** | 把当前块拆成两个**同级**块，保留原缩进 |
| **回车（空块）** | 继续产生新的空块，想空几行就空几行 |
| **回车（块外）** | 插入 `- `，让新行变成大纲块。块间空行、顶格文本、还没有块的新文件都适用 |
| **Shift+Enter** | **块内换行**：插入换行 + 内容缩进（块缩进 + 两个空格），不产生新块 |
| 两者在代码围栏内 | 只插入纯换行。回车不会加 `- `，Shift+Enter 也不会自动缩进，避免破坏 Python 等缩进敏感语言 |
| 两者在 frontmatter / 页面属性 / 表格 / 有选区时 | 不接管，保持 VS Code 原生行为 |

图谱外的普通 Markdown 完全不受影响。把 `tineBlockRef.enterSplitBlock` 设为 `false` 可整体关闭回车接管。

**只在你真正编辑文档时才生效。** 这两个键由 `editorTextFocus && editorLangId == markdown` 限定作用域，因此在 Copilot 聊天输入框、搜索框或任何其他输入控件里按回车，**不会**再往笔记里写空块。

> 0.5.1 及更早版本拦截的是全局 `type` 命令，而 `type` 不携带「哪个控件按的键」这一信息，`window.activeTextEditor` 又始终指向最后获得焦点的文本编辑器。结果是在聊天框里按回车，换行被写进了中间那份笔记（实测产生十几行空块）。0.5.2 改为独立命令 + 快捷键作用域后此问题消失。

## 4.3 悬停预览

将鼠标悬停在任意块引用上，会显示：

- 目标块的来源文件与行号
- 子树规模（行数、字符数）
- 块首行标题与前 6 行内容（含子块层级）
- 【展开全文】链接，点击后打开完整内容

预览行数经过刻意压缩（`tineBlockRef.hoverPreviewLines`，默认 6）：VS Code 的悬停框高度有限，内容过长会将底部按钮挤出可视区域。缩短行数可确保按钮始终可见。

悬空引用会显示「未找到该块」，重复 ID 会列出全部候选位置，不会静默失败。

## 4.4 展开全文

「展开全文」打开的是**网页面板**，位于编辑器旁侧，而非只读文本文档。这样设计的核心目的是使**每个块的来源均可点击跳转**。

### 单块展开

从悬停框点击「展开全文」，或在命令面板中按 UUID 展开：

```
块 3f7a1c2e-5b9d-4a11-8c3e-1d2f4b6a8c01
pages/术语表.md · 第 12–15 行
4 行 / 52 字符

点击块上方的「来源」链接，可打开对应笔记并跳转到该块。

┃ 增量索引    来源 pages/术语表.md 第 12–15 行    4 行 / 52 字符
┃ ┌──────────────────────────────────────┐
┃ │  · 只重新解析发生变化的文件           │
┃ │  · 未变化的文件复用上次解析结果       │
┃ └──────────────────────────────────────┘
```

**点击「来源」后的蓝色路径，将打开对应笔记的 Markdown 标签页，并跳转到块的首行（整行会被选中）。**

内容以**小灰点列表**呈现，与 Tine / Logseq 一致，不显示 Markdown 的减号标记——源码记号不属于阅读时应看到的内容。缩进层级逐级还原，子块的子块会再深一层。

### 整篇展开

通过命令面板「块引用：展开当前笔记为可读版」触发，或在笔记中执行：

```
笔记展开
pages/项目说明.md
共 3 处块引用

 1 │ tags: 性能
 2 │
 3 │ - # 3 性能优化
 …
 7 │ - 索引采用增量策略，细节参见 ((3f7a1c2e-5b9d-4a11-8c3e-1d2f4b6a8c01))
 8 │
 9 │ - 缓存失效条件另见 ((9c4d2b7a-1e83-4f56-b902-7a5c3d8e1f42))

┃ 增量索引    来源 pages/术语表.md 第 12–15 行    4 行 / 52 字符
┃ ┌──────────────────────────────┐
┃ │  · 只重新解析发生变化的文件   │
┃ │  · 未变化的文件复用上次结果   │
┃ └──────────────────────────────┘
```

原文按行号逐行列出，**包含块引用的行会高亮**；该行下方紧跟展开的块内容。

### 跳转时自动选中整行

反链面板的块标题、悬停列表的页面名、展开面板的「来源」链接，三者跳转行为一致：

**打开目标笔记的 Markdown 标签页 → 将光标定位到对应行 → 选中整行并滚动至视野中央。**

选择整行选中而非仅放置光标的原因：笔记正文通常为满屏文字，光标仅是一条细竖线，落入其中难以辨识。整行选中会显示整行背景色，可明确确认跳转位置是否正确。

### 采用网页面板的原因

只读文本文档有其优点（支持 Ctrl+F 查找、自由复制），但存在一项无法绕过的限制：

> **文本编辑器中的链接必须使用 Ctrl + 单击才能响应。**

而「点击来源跳回原文」是该面板的主要操作，每次都需要按 Ctrl 才生效，操作成本过高。网页中的链接是标准 `<a>` 元素，左键单击即可触发。

若更看重文本编辑器的查找与复制能力，反链面板仍保留 `tineBlockRef.backlinks.panel = text` 开关，可切回文本版；展开全文目前仅提供网页版。

## 4.5 反向链接

块引用是「从当前语句跳转到目标块」，反向链接方向相反：**目标块被哪些位置引用**。

Tine 与 Logseq 均提供该功能，VS Code 原生不具备。本插件的反链模块以 Tine 的表现作为设计基准：

| 能力 | Tine | 本插件 |
|---|---|---|
| 被引用块旁显示引用数 | 块右上角数字 | 行尾 `🔗 N` 徽章 |
| 悬停查看引用页面 | 支持 | 支持，每行附带面包屑 |
| 按页面分组列出全部引用 | 支持 | 支持，按引用条目数降序 |
| 显示引用所在小节 | `3 性能优化 › 3.2 索引策略` | 相同的面包屑路径 |
| 页面名 | 优先 `title::`，其次文件名 | 相同 |
| 完整展示引用块及其子块 | 支持 | 子树全展开，层级缩进还原 |
| 折叠 / 展开子块 | 小三角 | `▾` / `▸` 三角 + 全部折叠按钮 |
| 单击标题跳转到引用处 | 支持 | 左键单击直接跳转，无需 Ctrl |
| 记住折叠状态 | 支持 | 切换标签页后返回仍保持 |
| **AI 可查询反链** | 不支持 | 支持 `#blockBacklinks`（本插件独有） |

最后一项是 Tine 不具备的能力：Tine 不接入 AI，而本插件的主要目标正是让 AI 读懂笔记。

### 按场景选择入口

| 需求 | 入口 |
|---|---|
| 快速确认块的被引用次数 | 块行尾的 `🔗 N` 徽章 |
| 查看引用该块的页面 | 鼠标悬停在徽章上 |
| 跳转到某一处引用 | 悬停框中点击页面名（Ctrl + 单击） |
| 通读全部引用及其上下文 | 悬停框最下方「查看完整反链面板」，或命令面板「块引用：打开反链面板」 |
| 由 AI 分析引用关系 | 直接提问，AI 会调用 `#blockBacklinks` |

### 编辑器内：行尾徽章

每个**被引用过**的块，其所在行行尾会显示一个徽章：

```
- 增量索引  🔗 2
    id:: 3f7a1c2e-5b9d-4a11-8c3e-1d2f4b6a8c01
    collapsed:: true
```

仅显示真正被引用过的块。多数笔记不会出现任何徽章，只有包含被引用块的笔记才会多出这一标记。

徽章位于**块首行**行尾，而非 `id::` 所在行。因为 `id::` 只是属性声明，块的身份由其首行内容确定。

> 徽章使用 VS Code 的 InlayHint 机制，受全局设置 `editor.inlayHints.enabled` 控制。
> 若该设置为 `off`，徽章将不再显示。此时可将 `tineBlockRef.backlinks.style` 改为 `lens`，
> 改用「块上方独立一行」的方式显示。
>
> 三个可选值：`inline`（行尾徽章，默认）、`lens`（上方一行）、`off`（不显示）。

### 悬停：引用页面列表

鼠标悬停在徽章上时显示：

```
引用此块的页面（2 个引用块）

- 项目说明 · 3 性能优化 › 3.2 索引策略
- 架构决策 · 2 背景 › 2.1 选型依据

查看完整反链面板
```
每个页面一行，后接**引用发生的具体位置**。这一层信息用于在打开完整面板之前，先行判断是否存在目标条目。

一次最多列出 8 个页面，超出的部分显示为「还有 N 个页面未列出」，此时应打开完整面板查看。

**点击页面名将直接打开对应笔记并跳转到引用所在行。** 悬停框中的链接遵循 VS Code 的统一规则，需要 **Ctrl + 单击**，以避免鼠标划过时误触发跳转。

**徽章本身不可点击**。面板入口位于悬停框最下方，与鼠标位置距离极近，无需再增加一个需要 Ctrl 修饰的点击区域。

### 完整面板

点击「查看完整反链面板」，在旁侧打开独立标签页：

```
块 3f7a1c2e-5b9d-4a11-8c3e-1d2f4b6a8c01 的反向链接

定义位置：pages/术语表.md 第 12 行
块内容：增量索引
引用统计：2 个页面 / 2 个引用块

单击蓝色文字跳转到引用位置；点击左侧小三角可折叠或展开子块。

[全部折叠]

项目说明
pages/项目说明.md · 1 处引用

3 性能优化 › 3.2 索引策略                  ← ① 面包屑：引用所在小节
▾ 增量索引                                 ← ② 三角 + 块标题（可点击跳转）
    · 只重新解析发生变化的文件              ← ③ 该块的子块
    · 未变化的文件复用上次解析结果          ← ③ 该块的子块

架构决策
pages/架构决策.md · 1 处引用

2 背景 › 2.1 选型依据
▸ 增量索引
```

三层信息分别对应不同的判断需求：

| 层级 | 内容 | 回答的问题 |
|---|---|---|
| ① 面包屑 | `3 性能优化 › 3.2 索引策略` | 引用**出现在哪个小节**。同一块被引用在「3.2 索引策略」与「5.1 历史遗留问题」下，含义完全不同 |
| ② 块标题 | `增量索引` | 被引用的是**这个块**。左键单击直接跳转到引用所在行（整行会被选中） |
| ③ 缩进子块 | 带圆点的若干行 | 引用处可见的**完整内容**。无需打开笔记即可了解该处上下文 |

第三层是对齐 Tine 的关键：**子树完整展开，缩进层级逐级还原**，子块的子块会再深一级。

### 折叠子块

标题左侧的 `▾` / `▸` 控制子块显示：

- 点击三角折叠或展开该条目的子块。
- **仅确有子块的引用才显示三角**；无子块的条目保留等宽空位，确保标题左边缘对齐，不会左右错开。
- 顶部提供「全部折叠 / 全部展开」按钮，文案随当前状态切换。
- 折叠状态保存在面板内，切换到其他标签页后返回仍然保持。

三角为标准按钮元素，可通过 Tab 聚焦、回车触发，屏幕阅读器能够读取其展开/折叠状态。

### 跳转与排序

**点击蓝色块标题**将打开引用所在笔记，**选中引用所在行**并滚动至视野中央。面板不会关闭，可继续点击下一条。

面板按引用条目数**降序**排列，引用最多的页面位于最前（通常为主题页或索引页）。同一页面内按行号升序排列，符合阅读顺序。

两个上限可调整：

| 配置 | 默认值 | 作用 |
|---|---|---|
| `tineBlockRef.backlinks.subtreeLines` | `0`（不限） | 每个引用块最多展开多少行子树 |
| `tineBlockRef.backlinks.itemsPerPage` | `20` | 每个页面最多列出几条引用 |

关于子树上限：多数被引用块的子树规模在 20 行以内，因此默认不限制。但确实存在少数体量较大的块。若遇到显示过长的情况，将 `subtreeLines` 设为 `30` 即可截断，并在末尾提示剩余行数。

### 与 Tine 的两处差异

以下两处无法做到完全一致，此处如实说明：

| 项目 | Tine | 本插件 | 原因 |
|---|---|---|---|
| 引用数显示位置 | 块的右上角浮动数字 | 块首行行尾的徽章 | VS Code 的 InlayHint 只能插入行内文字流，不存在「块」这一布局概念 |
| 面板位置 | 页面右侧栏内嵌 | 编辑器旁的标签页 | VS Code 扩展没有合法的「在主编辑器右侧插入自有 UI」接口 |

功能层面一致，位置层面的差异由 VS Code 扩展模型决定，无法照搬。

### 由 AI 查询反向链接

```
这个块被哪些位置引用了？
```

AI 会调用 `#blockBacklinks`，获得与面板**完全相同**的分组、排序与面包屑路径（两者共用同一套数据整理逻辑，不会出现「面板显示 3 条、AI 显示 4 条」的不一致）。

面包屑对该用途尤为关键：AI 获得「引用出现在 `3.2 索引策略` 下」这一信息后，才能说明该块被用于哪些具体语境，而不只是罗列文件名。

### 另外两个查询入口

除面板外，命令面板还提供两个以跳转为目标的入口：

| 命令 | 用途 |
|---|---|
| 块引用：查看光标处块引用的反向链接 | 光标位于某个 `((uuid))` 上时，直接列出引用它的位置，选中即跳转 |
| 块引用：查看块的反向链接 | 手动输入 UUID 查询，同样选中即跳转 |

这两个入口使用 QuickPick 列表，与面板的分工为：**QuickPick 用于跳转到某一处，面板用于通读全部**。

## 4.6 界面语言

`tineBlockRef.language` 控制本扩展的运行时文案，取值 `auto`（跟随 VS Code 界面语言，默认）、`en`、`zh-cn`。切换后建议重载窗口，让已经渲染出来的内容一并更新。

**适用范围**：提示消息、悬停预览、反链面板、展开网页、AI 工具的返回内容。

**命令标题与设置项名称不在其列**——它们由 VS Code 在渲染命令面板与设置页时读取 `package.nls`，扩展没有运行时改写它们的接口。需要整界面统一时，请切换 VS Code 自身的显示语言。

另注：AI 工具的**描述**（`modelDescription` 与参数说明）固定为英文，因为模型对英文工具描述的理解更稳定；工具**返回内容**则跟随上述设置。

## 4.7 命令一览

| 命令 | 使用场景 |
|---|---|
| 块引用：展开当前笔记为可读版 | 需要将整篇笔记提供给 AI 阅读 |
| 块引用：展开光标处的块引用 | 只需查看某一个引用 |
| 块引用：按 UUID 展开单个块 | 已知 UUID，直接查询 |
| 块引用：查看光标处块引用的反向链接 | 确认某条内容的引用位置并跳转 |
| 块引用：查看块的反向链接 | 手动输入 UUID 查询并跳转 |
| 块引用：打开反链面板 | 通读完整反链（亦可从行尾徽章的悬停框进入） |
| 块引用：复制当前块的引用 | 像 Tine 的「复制块引用」：必要时补 `id::`、保存，再复制 `((uuid))` |
| 块引用：复制当前块的嵌入引用 | 同上，复制 `{{embed ((uuid))}}` |
| 块引用：回车（新建同级块） | 已绑定回车键：块内任意位置拆出同级块，块外插入 `- ` |
| 块引用：在当前块内换行（软换行） | 已绑定 Shift+Enter：块内换行，不产生新块 |
| 块引用：重建索引 | 兜底手段。日常无需使用，索引会自动维护 |
| 块引用：选择 Tine 图谱目录 | 自动探测失败时，或需要在多个笔记库间切换 |
| 块引用：显示日志 | 排查问题 |

> **「重建索引」与「选择 Tine 图谱目录」均为兜底手段**，不属于日常步骤。正常情况下安装完成并打开笔记库后，无需再操作这两项。

## 4.8 图谱目录识别

打开同时包含 `pages/` 与 `logseq/` 的文件夹，插件会自动识别并建立索引，**无需任何配置**。

判定依据（满足任一即认定）：

- 同时存在 `pages/` 与 `logseq/` —— Logseq / Tine 的标准布局
- 存在 `logseq/config.edn`
- 存在 `.tine-trash/` —— Tine 特有目录

向上查找最多 10 层，因此从 `pages/某个子目录/` 打开同样能够定位到根目录。

### 需要手动指定的情形

仅限以下两种：

1. **只打开了单个 `.md` 文件而未打开文件夹** —— VS Code 不会触发工作区变更事件，插件无法感知。
2. **需要临时切换到另一个笔记库** —— 自动识别的是「当前文件所属的图谱」，如需更换则手动指定。

手动指定一次后写入用户级配置，跨工作区保留：

`Ctrl+Shift+P` → **块引用：选择 Tine 图谱目录** → 选择同时包含 `pages/` 与 `logseq/` 的文件夹。

### 同时打开多个笔记库

仅索引**一个**：优先当前打开文件所属的图谱，其次为第一个工作区文件夹。需要更换时使用手动指定命令。

## 4.9 索引更新时机

全自动维护，无需记住任何操作：

| 时机 | 行为 |
|---|---|
| 打开 VS Code / 打开新的笔记库文件夹 | 全量建立，完成后右下角提示 |
| 在 Tine 中修改笔记 | 自动增量更新（Tine 保存即写盘，插件监听磁盘变化） |
| 在 VS Code 中保存 | 自动增量更新 |
| 在 VS Code 中编辑但尚未保存 | 自动增量更新，停止输入 0.25 秒后生效 |
| 新建 / 删除 `.md` 文件 | 自动增量更新 |
| 外部工具修改文件（git 切换分支、其他编辑器） | 自动增量更新 |
| 修改 `include` / `exclude` / `graphRoot` 设置 | 自动重建 |
| 关闭文件且放弃保存 | 回滚到磁盘内容 |

「编辑但未保存」这一项是刻意支持的：新增带 `id::` 的块或新增 `((uuid))` 引用后，无需先保存即可悬停查看展开结果。

---

# 第五部分 · 注意事项

## 5.1 排查：AI 不调用工具

按顺序排查：

1. **指令文件未生效** —— 回到 [3.3](#33-指令文件是否生效)，确认 Workspace 下存在 1 条指令。
2. **会话未刷新** —— 指令按会话加载，修改文件后需要新建会话。
3. **模型调用工具不积极** —— 在提问中直接指明工具名，例如：`用 #blockNote 读取这篇笔记`。
4. **工具被禁用** —— 点击 Chat 输入框上方的工具图标，确认 `blockRef` / `blockNote` / `blockBacklinks` 三项均已勾选。
5. **引用过多导致截断** —— 改用 `#blockNote` 的 `mode: "list"` 获取清单，再用 `#blockRef` 逐个读取。

## 5.2 排查：反链不显示

反链徽章不可见，或面板为空。

**徽章完全不可见**，按顺序排查：

1. **VS Code 全局关闭了行内提示** —— 设置中搜索 `editor.inlayHints.enabled`，若为 `off`，徽章必然消失且不会有任何提示。请开启该项，或将 `tineBlockRef.backlinks.style` 改为 `lens`。
2. **该块确实未被引用** —— 多数笔记中不存在被引用过的块，这类笔记不会显示任何徽章。可在其他笔记中搜索该 UUID 进行验证。
3. **相关设置被关闭** —— 检查 `tineBlockRef.backlinks.style` 不为 `off`。
4. **索引尚未建立** —— 打开「块引用：显示日志」，确认索引已完成。

**徽章存在但悬停列表为空** —— 索引已过期。执行「块引用：重建索引」，或在其他文件中做一次修改以触发增量更新。

**面板无法打开** —— 查看输出面板日志。若为 `webview` 相关错误，可临时将 `tineBlockRef.backlinks.panel` 改为 `text` 验证；若文本版可正常打开，说明问题出在网页面板。

**面板内点击链接无响应** —— 该文件可能已被移动或删除。面板内容是打开时的快照，不会自动跟随磁盘变化；重新打开面板即可。

## 5.3 排查：索引为空

出现「图谱目录里没有找到笔记」警告，或工具持续返回「未找到块」时：

1. 打开「块引用：显示日志」，确认 `[索引] 图谱根目录：` 后显示的是哪个路径。
2. 该路径下必须确实存在 `pages/`，且其中包含 `.md` 文件。
3. 路径为空或不正确 —— 执行 **块引用：选择 Tine 图谱目录** 重新指定。
4. 日志中出现「没有匹配到任何 Markdown 文件」 —— 检查 `tineBlockRef.include` 是否被误改（默认应为 `pages/**/*.md` 与 `journals/**/*.md`）。

**不要**依赖「重建索引」修复此问题。该命令仅重新扫描当前目录；目录本身未正确识别时，重建不会改变任何结果。

## 5.4 数据安全

**AI 工具与所有读取路径全程只读**：不修改、不格式化、不重写任何笔记文件。它们的输出全部指向以下位置：

- 网页面板（反链、展开全文；关闭时不会提示保存，也不产生磁盘文件）
- 只读虚拟文档（仅供 `backlinks.panel = text` 的文本版反链使用）
- 输出面板日志
- 工具返回值与悬停提示

只有一条写入路径，而且由你主动触发：**「块引用：复制当前块的引用 / 嵌入引用」**。当目标块没有 `id::` 时，该命令会插入一行 `id::` 并保存文档，然后复制引用。除此之外，任何命令与 AI 工具都不会写入笔记库。

`#blockMakeRef` 与 `#blockLink` 刻意**只返回补丁、不写文件**。原因是 Copilot 的「接受 / 拒绝」栏只覆盖 AI 自己的编辑工具：工具私自写盘不会出现在那里，你既无法拒绝，事后也分不清哪次改动是 AI 做的，只能靠 Ctrl+Z 或 `git diff` 兜底。把落盘交给编辑工具，才是「点不接受就全撤」能成立的前提。

## 5.5 已知限制

- 仅索引 `pages/` 与 `journals/`；`logseq/` 下的回收站与备份不参与索引。
- 反链的**引用数显示位置**为块首行行尾，而非 Tine 那样的块右上角浮动数字；**面板位置**为编辑器旁的标签页，而非 Tine 的右侧内嵌栏。功能一致，位置受 VS Code 扩展模型限制。
- 反链徽章依赖 `editor.inlayHints.enabled`；关闭后徽章消失且无提示（将 `backlinks.style` 改为 `lens` 可绕过）。
- 展开全文仅提供网页版，不支持 Ctrl+F 查找（网页内可使用浏览器自带的查找功能）。反链面板可通过 `backlinks.panel = text` 切回可查找的文本版。
- 同时打开多个笔记库时仅索引其中一个（当前文件所属者优先，其次为第一个工作区文件夹）。需要切换时使用「块引用：选择 Tine 图谱目录」。
- 悬空引用（目标块已被删除）会明确标注为「未找到」，不会静默失败。
- 重复 ID（同一 UUID 出现在多个文件）会列出全部候选并提示歧义。
- **页面名优先取前言的 `title::`**，没有时退回文件名，与 Tine 一致。块内部的 `title::` 属于那个块，不会被当成页面名。
- **顶格 `# 标题`（行首无缩进）会被当作独立块**，和 `- ` 列表块并列：可以挂 `id::`、可以被引用。文件开头、文件中部都支持。缩进的 `# 标题` 仍按父块的续行处理（Tine 的解析器会把这种情况也当成独立 heading，但真实笔记库中未出现该写法）。
- **紧贴前文的引用**（`参考：((uuid))`）本扩展能解析、在 VS Code 里显示正常，但 Tine / Logseq 不会把它渲染成引用。`#blockCheck` 会报 `reference-tight-prefix` 警告，修法是补一个空格。
- Tine 自带的 `tine block show` 命令在 Windows 上不可用（报错 `cannot reach a graph's owner`），因此本插件自行实现解析，不依赖该 CLI。
- 行内渲染在 `replace` 模式下会把原文 UUID 的字符宽度压缩为 0，光标无法到达引用右侧、也选不中引用。默认的 `activeLine` 模式已避开该问题；若仍需始终隐藏原文，可改用 `append`。
- 回车 / Shift+Enter 通过 `package.json` 里的快捷键绑定实现，作用域为 `editorTextFocus && editorLangId == markdown`。若其他扩展也绑定了同样的键与条件，后激活者生效。

## 5.6 配置参考

| 配置 | 默认值 | 说明 |
|---|---|---|
| `tineBlockRef.language` | `auto` | 运行时文案语言：`auto` 跟随 VS Code / `en` 英文 / `zh-cn` 简体中文。命令标题与设置项名称始终跟随 VS Code 界面语言 |
| `tineBlockRef.graphRoot` | 自动探测 | 图谱根目录 |
| `tineBlockRef.include` | `pages/**/*.md`, `journals/**/*.md` | 参与索引的文件 |
| `tineBlockRef.exclude` | `logseq/**`, `.tine-trash/**` 等 | 排除的路径 |
| `tineBlockRef.maxDepth` | `3` | 嵌套引用展开层数 |
| `tineBlockRef.maxOutputChars` | `20000` | 单次输出字符预算 |
| `tineBlockRef.hideProperties` | 与 Tine 内置隐藏表一致（`id`, `collapsed`, `heading`, `todo`, `created-at`, `logseq.*`, SRS 卡片属性等） | 渲染时隐藏的属性。默认值刻意与 Tine 的 `BUILTIN_HIDDEN` 对齐，避免把元数据当成块正文读给 AI |
| `tineBlockRef.inlineRender.enabled` | `true` | 是否将 `((uuid))` 显示为块标题 |
| `tineBlockRef.inlineRender.mode` | `activeLine` | `activeLine` 光标行显示原文 / `replace` 始终隐藏原文 / `append` 追加标题 |
| `tineBlockRef.enterSplitBlock` | `true` | 回车拆块、Shift+Enter 块内换行（仅 Tine 图谱内生效） |
| `tineBlockRef.inlineRender.maxTitleLength` | `60` | 行内标题最大长度 |
| `tineBlockRef.inlineRender.showMissing` | `true` | 悬空引用显示 `⚠ 块不存在` |
| `tineBlockRef.render.stripHeadingMarks` | `true` | 渲染时去除标题的 `#` 标记 |
| `tineBlockRef.hoverPreviewLines` | `6` | 悬停预览行数 |
| `tineBlockRef.showIndexNotification` | `true` | 索引建立完成后显示提示 |
| `tineBlockRef.backlinks.style` | `inline` | 反链标记呈现方式：`inline` 行尾徽章 / `lens` 上方一行 / `off` 不显示 |
| `tineBlockRef.backlinks.panel` | `html` | 反链面板形式：`html` 左键单击跳转 / `text` 只读文本（Ctrl+单击，可 Ctrl+F） |
| `tineBlockRef.backlinks.subtreeLines` | `0`（不限） | 反链面板中每个引用块最多展开的行数 |
| `tineBlockRef.backlinks.itemsPerPage` | `20` | 反链面板中每个页面最多显示的引用条数 |
| `tineBlockRef.backlinks.pathDepth` | `3` | 反链面板中面包屑保留的祖先层级数 |

---

# 附录 · 开发说明

```bash
npm install
npm run build      # 打包到 dist/
npm test           # 单元测试 + 真实笔记库冒烟测试
npm run typecheck  # 类型检查
```

核心解析逻辑位于 `src/core/`，刻意不依赖 `vscode` 模块，可在普通 Node 环境中直接测试。

架构约定、发布流程与平台限制的细节见仓库根目录的
[AGENTS.md](https://github.com/Louis-15/block-reference-interpreter/blob/main/AGENTS.md)。

## 目录结构

```
src/core/       纯解析层（块树、引用扫描、索引、反链报告、渲染、图谱探测与路径匹配），不依赖 vscode
src/vscode/     VS Code 适配层（工具、命令、悬停、行内渲染、反链徽章与面板）
src/test/       单元测试与真实笔记库冒烟测试
templates/      分发给用户的模板文件（笔记库指令）
docs/           开发者内部文档（已 gitignore，不对外发布）
```

## 笔记库指令模板

指令文件的**唯一来源**为：

```
templates/github/instructions/block-reference.instructions.md
```

发布 Release 时需单独打包一个压缩包，内部结构必须为：

```
notebook-instructions.zip
└── .github/
    └── instructions/
        └── block-reference.instructions.md
```

**该压缩包由 CI 自动生成**，无需本地打包。工作流 `.github/workflows/release.yml`
会在发布前从 `templates/` 现场构建，并打印压缩包内容以便核对层级。

需要在本地手动生成时（例如调试工作流），使用下述 PowerShell 脚本。显式写入
条目名可以规避不同平台间的路径分隔符差异：

```powershell
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::Open('notebook-instructions.zip','Create')
$entry = $zip.CreateEntry('.github/instructions/block-reference.instructions.md')
$stream = $entry.Open()
$bytes = [System.IO.File]::ReadAllBytes('templates/github/instructions/block-reference.instructions.md')
$stream.Write($bytes, 0, $bytes.Length)
$stream.Dispose(); $zip.Dispose()
```

打包后**必须解压验证**：压缩包内必须是三层路径 `.github/instructions/文件名`，
多一层目录会导致用户解压后指令不生效。

> **关于行尾符**：CI 在 Linux 上检出代码，生成的压缩包内文件为 LF 行尾；
> Windows 本地生成的为 CRLF。两者内容一致，功能无差异，因此无需强制统一。

> **本地那份 zip 容易被遗忘**：`notebook-instructions.zip` 在 `.gitignore` 里，
> 改完模板后本地这份不会自动更新。曾出现过模板已改、本地 zip 仍是两个版本前的情况，
> 用户解压后拿到的是旧规则。手动分发给他人之前，先核对 zip 内文件的大小与模板是否一致。

## 发版流程

版本号变更已全部自动化。发版只需三步：

1. 修改 `package.json` 的 `version`，并在 `CHANGELOG.md` 补充对应条目
2. 提交并推送到 `main`
3. 创建并推送标签：`git tag -a v0.4.0 -m "v0.4.0"; git push origin refs/tags/v0.4.0`

标签推送后，工作流会依次执行：校验标签与版本一致 → 类型检查 → 单元测试 →
构建 → 打包 → 发布扩展市场 → 创建 GitHub Release 并上传两个附件。

认证使用 **Trusted Publishing（OIDC 联邦身份）**，仓库中不存储任何长期凭据。
首次配置需在扩展市场发布者页面的 Trusted Publishing 中创建政策，填入仓库
owner、仓库名与工作流文件名（`release.yml`），三者须精确匹配。

> 微软已于 2026 年 12 月 1 日退役 Azure DevOps 全局 PAT，因此本项目不采用
> PAT 方案。若需了解背景，参见 Visual Studio Marketplace Trusted Publishing 文档。

## 工具内部名与引用名

两者容易混淆，此处单独说明：

| `registerTool` 内部名 | `toolReferenceName`（用户与模型可见） |
|---|---|
| `tineBlockRef_readBlock` | `blockRef` |
| `tineBlockRef_readNote` | `blockNote` |
| `tineBlockRef_findBacklinks` | `blockBacklinks` |
| `tineBlockRef_newId` | `blockNewId` |
| `tineBlockRef_findBlocks` | `blockFind` |
| `tineBlockRef_link` | `blockLink` |
| `tineBlockRef_makeRef` | `blockMakeRef` |
| `tineBlockRef_checkRefs` | `blockCheck` |

**编写文档、指令或让 AI 引用时必须使用右列。** 左列仅出现在扩展源码中，模型完全不可见。

## 为什么工具只返回补丁、不写文件

`#blockMakeRef` 与 `#blockLink` 都只计算补丁，落盘由 AI 的编辑工具完成。这样做的原因不是保守，而是**唯一能让「不接受」按钮生效的方式**：

Copilot 的接受/拒绝栏只覆盖 AI 自己的编辑工具所做的事。工具私自写盘的文件不会出现在那里——你既无法拒绝，事后也分不清哪次改动是 AI 干的，只能靠 Ctrl+Z 或 `git diff` 兜底。

代价是多一次工具往返。考虑到一次「引用 2 个块」的完整任务在 4 次调用内结束，这个代价换来的是随时可撤销，值得。
