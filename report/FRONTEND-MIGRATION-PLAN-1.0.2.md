# Doge IDE+ 1.0.2 前端重构迁移计划

制定日期：2026-09-28
输入：`edit/1.0.2/doge-ide-modern-ui.html`（交互原型，1486 行）、`edit/1.0.2/IDE-功能迁移说明.md`（入口迁移说明）
改造对象：仓库根 `doge-ide.html`（当前 2915 行，APK 与桌面版共用）
状态：计划，尚未改代码

## 1. 目标与范围

目标：

1. 按原型把前端换成“菜单栏 + 活动栏 + 网格工作台 + 两级底部面板 + 状态栏 + 命令面板”的结构。
2. 把当前界面的字体和配色完整保存为「经典」主题，新设计为「现代」主题，可在设置里切换，切换即时生效并持久化。
3. 前几轮已修好的 APK 行为（Tab 输入、停止按钮、超时熔断、增量输出等）一条不丢。

不在本次范围：

- CodeMirror 5 → 6 升级。原型“关于”里写的是 CodeMirror 6，但仓库实际是 CodeMirror 5.65.18（`web/codemirror/codemirror.min.js`），Tab 输入修复依赖 CM5 的 `inputStyle:'textarea'`，本次不换编辑器内核。
- 原型里的演示数据（示例项目、假输出、假任务、假终端）一律不搬，全部接真实数据。
- 旧布局不保留。“经典”只保留字体与配色，布局统一用新结构。
- Java / native 侧不改（桥接接口不变）。

## 2. 现状核对（本次已读到的事实）

| 事项 | 事实 | 来源 |
|---|---|---|
| 页面打包 | `syncWebapp` 把 `doge-ide.html`（改名 `index.html`）和 `web/**` 打进 APK | `android/app/build.gradle:99-108` |
| 桌面版共用 | Go 外壳 `//go:embed doge-ide.html` 与 `all:web` | `main.go:43-47` |
| 字体 | Geist（`web/fonts/geist.css`）+ Maple Mono（`web/fonts/maple-mono-var.woff2`）已离线内置，原型用的也是这两套 | `doge-ide.html:11-29` |
| 编辑器 | CodeMirror 5.65.18；已内置 addon 只有 hint / closebrackets / matchbrackets / active-line，没有 search | `web/codemirror/` |
| 设备 WebView | Chrome WebView 140.0.7339.207（平板 `HA2K9X7F`） | `dumpsys webviewupdate` |
| 平板视口 | 物理 3504×2190、360dpi → CSS 约 1557×973；分屏窗口实测 2170px 宽 → 约 964 CSS px | `wm size`、`wm density`、窗口快照 |
| 输出数据 | `outputData` 已经是 `{stdout, stderr, info}` 三个桶 | `doge-ide.html:520` |
| 调试 | `debugBtn` 与 debug 输出标签在标记里都是 `hidden`，没有代码把它们放出来，当前版本调试入口实际关闭 | `doge-ide.html:348`、`:397` |
| 项目目录 | 新建文件不允许目录路径，但打开已有目录时 `scanSourceFiles` 会递归读入子目录文件，路径可能带 `/` | `newProjectFile`、`MainActivity.scanSourceFiles` |

### 2.1 设计文档需要修正的地方

这几条和当前代码对不上，迁移时以代码为准：

1. **Ctrl+Space 不是“没绑定”**：它绑在 CodeMirror 的 `extraKeys` 里（`'Ctrl-Space': () => triggerCompletion()`），编辑器有焦点时生效，只是全局没绑。新版补全局绑定即可。
2. **输出不是“单个全局字符串”**：已经分成三个桶。真正缺的是“每个流各自的滚动位置”，以及增量渲染状态只记最后一个流。
3. **`brand-spec.md` 不存在**：仓库里找不到。令牌以原型 `:root` 为准。
4. **原型用了 `window.prompt` / `window.confirm`**：APK 的 WebView 没有 `WebChromeClient`，这两个不可用（`dogeConfirm` 的注释就是因为这个才写的）。新版必须继续用 `dogeInput` / `dogeConfirm`。
5. **原型运行时禁用运行按钮**（`runBtn.disabled = true`）：和已修好的 F2 冲突，运行中按钮必须保持可点、显示“停止”。
6. **38 条命令里有几条没有后端**：退出、格式化文档、源代码管理、扩展、终端、查找/替换（缺 search addon）。处理方式见 §3 D5。

## 3. 关键决策（默认方案，有不同意见可以直接改）

| # | 决策 | 理由 |
|---|---|---|
| D1 | 主题 = 一个设置项「外观」：`现代`（默认）/ `经典`。切换同时换界面令牌、编辑器语法配色、字体参数 | 用户要求“保存原来的字体和配色，后面可以切换”；一个开关比界面/编辑器分开两个开关好理解 |
| D2 | 仍然是单文件 `doge-ide.html` | APK 与桌面版的打包、`LocalServer`/Go 路由都按单文件 + `web/**` 设计；拆文件收益小、改动面大 |
| D3 | 颜色令牌写成 **hex**，不直接用 `oklch()` / `color-mix()`；原型里的混色预先算成 rgba | minSdk 24，旧设备的 WebView 可能不支持 oklch（Chrome 111+）；本机 WebView 140 支持，但不能只看本机 |
| D4 | 保留 CodeMirror 5，多标签用 `CodeMirror.Doc` + `swapDoc` 实现 | 每个文件独立撤销历史，且不影响 Tab/IME 修复 |
| D5 | 没有后端的命令不上菜单：退出、格式化、源代码管理、扩展、终端先不做；查找/替换在补齐 CM5 search addon 后再上；调试菜单跟随现有调试开关（当前关闭则整组隐藏） | 不放点了没反应的入口 |
| D6 | “以任务方式运行”不单独做：APK 的运行本来就走任务队列 | 两个命令在 APK 里行为完全相同 |
| D7 | 项目内搜索（活动栏第 2 格，`Ctrl+Shift+F`）做一个内存搜索：在 `project.files` 里按文本查找、结果可点跳行 | 数据都在内存里，不需要索引服务 |
| D8 | 经典主题的 localStorage 旧键全部保留，新增键统一加 `doge-ide-` 前缀 | 回退旧版本不丢配置 |

## 4. 主题系统

### 4.1 机制

- `<html data-theme="modern|classic">`，所有组件只引用语义令牌（`--bg`、`--surface`、`--fg`、`--accent` 等），不再直接写色值。
- 编辑器主题：经典沿用现有 `cm-s-doge`（原样搬，不改一个值）；现代新增 `cm-s-doge-modern`。切换时 `editor.setOption('theme', ...)`。
- 切换入口：设置对话框「外观」下拉、命令面板「切换主题」、视图菜单「主题」。
- 持久化：`doge-ide-theme`，默认 `modern`。页面最早期（`<head>` 内联一小段脚本）就设好 `data-theme`，避免首屏闪一下另一套配色。

### 4.2 经典主题（从当前代码原样冻结）

界面令牌（`doge-ide.html:22-29`）：

| 令牌 | 值 | 用途 |
|---|---|---|
| `--bg` | `#1a1b26` | 画布 |
| `--bg2` | `#16161e` | 顶栏 / 次级底色 |
| `--bg3` | `#24283b` | 面板、按钮 |
| `--bg4` | `#292e42` | 悬停 |
| `--fg` / `--fg2` / `--fg3` | `#c0caf5` / `#a9b1d6` / `#565f89` | 主 / 次 / 弱文本 |
| `--accent` / `--accent2` | `#7aa2f7` / `#2ac3de` | 强调 |
| `--green` / `--red` / `--orange` / `--purple` / `--cyan` | `#9ece6a` / `#f7768e` / `#ff9e64` / `#bb9af7` / `#7dcfff` | 状态色；运行按钮为绿色 |
| `--border` | `#3b4261` | 分割线 |
| `--radius` | `8px` | 圆角 |
| `--font-sans` | `"Geist Sans","Geist",system-ui,…,"PingFang SC","Microsoft YaHei",sans-serif` | 界面 |
| `--font-mono` | `"Maple Mono","Geist Mono",ui-monospace,…` | 代码 / 输出 |

编辑器（`cm-s-doge`，`doge-ide.html:95-143`）：底 `#181818`、字 `#d6d6dd`，关键字 `#82d2ce`、字符串 `#e394dc`、数字 `#ebc88d`、注释 `#f0f0f099` 斜体、预处理 `#a8cc7c`、内建 `#f8c762`、属性 `#aaa0fa`、错误 `#f14c4c`，补全弹层同色。行高 1.6，触控默认字号 15px。

### 4.3 现代主题（取自原型 `:root`，hex 化）

| 令牌 | hex | 用途 |
|---|---|---|
| `--bg` | `#1a1b26` | 画布 / 编辑器底 |
| `--surface` | `#24283b` | 菜单栏、面板、浮层 |
| `--fg` / `--muted` | `#c0caf5` / `#a9b1d6` | 主 / 次文本 |
| `--border` | `#3b4261` | 发丝线 |
| `--accent` | `#7aa2f7` | 唯一强调：运行按钮、焦点环、选中指示 |
| `--hover` / `--sunken` | `#292e42` / `#16161e` | 悬停面 / 输入槽、活动栏、状态栏 |
| `--ok` / `--err` / `--warn` / `--info` / `--hint` | 由原型 oklch 换算（批次 1 用脚本换算并写入） | 状态色、语法色 |
| `--accent-soft` / `--fg-soft` / `--scrim` | 原型 `color-mix` 预算为 rgba | 选中底、弱底、遮罩 |

编辑器语法映射（原型 `tk-*` → CM5 类）：关键字 → `--hint`，预处理 `cm-meta` → `--err`，字符串 → `--ok`，数字 → `--warn`，注释 → `--muted` 斜体，类型 / 内建 → `--info`，运算符与标点 → `--muted`。行高 1.65。

### 4.4 两套主题共用的派生令牌

为了让组件只写一次，两套主题都要提供这组语义令牌（经典主题用自己的值填）：`--bg --surface --sunken --hover --fg --muted --border --accent --accent-ink --run-bg --run-fg --ok --err --warn --info --scrim --shadow --radius --font-sans --font-mono --code-line-height --editor-bg --editor-fg`。例如运行按钮：经典 `--run-bg: var(--green)`，现代 `--run-bg: var(--accent)`。

## 5. 目标结构

### 5.1 页面骨架

```
.menubar      品牌 · 菜单(文件/编辑/运行/视图/调试*/帮助) · 状态胶囊 · 调试* · 运行/停止
.workbench    网格：活动栏 | 资源管理器 | 竖把手 | 编辑区列(标签栏/面包屑/编辑器/stdin 抽屉)
                                               | 横把手
                                               | 底部面板(问题/输出[stdout|stderr|info]/调试控制台*/任务)
.statusbar    保存 · 问题数 · Ln/Col · A+ A− · UTF-8 · 空格=4 · 版本
#layer        浮层容器：菜单 / 命令面板 / 对话框 / 右键菜单（同一时间只有一个）
#toast        提示条
```
带 `*` 的跟随调试开关，当前隐藏。

### 5.2 命令注册表

一张 `COMMANDS` 表同时驱动菜单栏、命令面板、快捷键表、右键菜单：

```js
// id: 唯一命令 id；run: 调用现有函数；when: 可用条件；key: 快捷键显示
{ id: 'file.newFile', label: '新建文件', menu: 'file', key: 'Ctrl+N',
  run: () => newProjectFile(), when: () => !!project }
```

所有入口只调 `runCommand(id)`，行为函数（`runCode`、`newProjectFile`、`saveProjectToDisk` 等）不动。

### 5.3 键盘路由（规则写死，逐条可测）

1. 浮层打开时：只处理 `Esc`（关最上层）和浮层内部按键，其余全部放行给浮层。
2. `event.defaultPrevented` 为真时直接返回——CodeMirror 已处理的键（撤销、`Ctrl+Space`、Tab）不会被二次执行。
3. 焦点在 `INPUT/TEXTAREA/SELECT`（含 CodeMirror 的隐藏 textarea）时，不响应 `Delete`、`F2` 这类单键命令。
4. `Esc` 无浮层时：只有 `isRunning` 为真才取消执行。
5. `Ctrl+I` 保持旧语义（切换 stdin），设置里给一个关闭开关（部分输入法用它切中英文）。

### 5.4 浮层

一个 `#layer`，四类浮层互斥（打开新的先关旧的），统一：`role` 语义、`Esc` 关闭、焦点在浮层内循环、关闭后焦点回到原处。现有 `openDynamicDialog` / `closeTopOverlay` 改造成这套，`dogeInput` / `dogeConfirm` / 新建项目弹层 / 导入进度都挂到上面。

## 6. 功能迁移对照（按新入口汇总）

| 能力 | 现有函数 | 新入口 | 状态 |
|---|---|---|---|
| 运行 / 停止 | `runCode` / `cancelExecution` / `setRunButtonState` | 顶栏主按钮、运行菜单、`Ctrl+Enter`、`Esc`（运行中） | 保留，状态胶囊读 `setRunButtonState` |
| 清空控制台 | `initKeybindings` 内 | 运行菜单、面板“清空”、`Ctrl+L` | 保留，一次清空全部流 |
| 新建 / 打开 / 保存 / 重命名项目 | `showCreateProject` / `openProject` / `saveProjectToDisk` / `renameProject` | 文件菜单、`Ctrl+Shift+N` / `Ctrl+O` / `Ctrl+S`、双击项目名 | 保留 |
| 新建 / 删除文件 | `newProjectFile` / `deleteProjectFile` | 文件菜单、资源管理器头图标、右键、`Ctrl+N` / `Delete` | 保留 |
| 重命名文件 | 无 | 文件菜单、右键、`F2` | **新增** `renameProjectFile`，同目录，校验同 `newProjectFile`，同步断点与打开的标签 |
| 关闭文件 / 多标签 | 无（单文件） | 标签 ×、`Ctrl+W` | **新增**，`CodeMirror.Doc` 按文件缓存 |
| 未保存标记 | 无 | 标签与文件树圆点 | **新增**：记录上次成功 `projectSaveResult(true)` 时各文件内容的哈希，不同即为未保存 |
| 文件树 | `renderProjectFiles` | 资源管理器 | 改为按路径分目录，支持折叠、右键、选中态 |
| 显示 / 隐藏资源管理器 | `toggleProjectPanel` | 视图菜单、活动栏、头部图标、`Ctrl+B` | 改为 `setExplorerVisible(bool)`，三处状态同步 |
| 底部面板 | `switchOutputTab` / `renderOutput` | 面板视图 + 输出内分段 | 拆成 `switchPanelView` / `switchStream`，每个流独立滚动状态 |
| 问题 | `requestClangdDiagnostics` / stderr 诊断链接 | 「问题」视图，状态栏计数 | **新增**：统一问题模型，来源为 clangd 诊断 + 编译 stderr（`DIAGNOSTIC_PATTERN`），点击跳行 |
| 任务 | `renderTaskList` / `pollTask` | 「任务」视图 | 提为一级视图，运行开始时不强制切过去（只在出错时切到问题/输出） |
| 补全 | `triggerCompletion` | 编辑菜单、全局 `Ctrl+Space` | 保留；`#completeBtn` 废弃，触控补全入口改为编辑菜单 + 状态栏按钮（保证平板无键盘可用） |
| stdin | `toggleStdin` | 视图菜单、抽屉头、`Ctrl+I` | 保留 |
| 字号 | `applyCodeSize` | 状态栏 A+/A−、视图菜单、`Ctrl+=` / `Ctrl+-`、设置 | 保留，复用钳制逻辑 11-24 |
| 设置 | `toggleSettings` / `saveSettings` | 帮助菜单、`Ctrl+,`，居中对话框 | 容器换成对话框，输入框 id 不变，新增「外观」 |
| 导入运行库 / 依赖包 | `pickToolchain` / `pickDependencyPackage` | 帮助菜单、设置对话框 | 保留；未导入时状态胶囊显示“运行库未导入”并可点击导入 |
| 快捷键表 | `#shortcutModal` | 帮助菜单 | 内容由 `COMMANDS` 生成，不再手写 |
| 命令面板 | 无 | `Ctrl+Shift+P`、菜单 | **新增** `openCommandPalette` |
| 项目内搜索 | 无 | 活动栏、`Ctrl+Shift+F` | **新增**（D7） |
| 主题切换 | 无 | 设置、视图菜单、命令面板 | **新增**（§4） |
| 调试 | `debugCode` 等 | 调试菜单、F5/F9/F10 | 代码保留，入口跟随调试开关（当前隐藏） |
| 退出 / 格式化 / 源代码管理 / 扩展 / 终端 | 无 | — | 不做（D5） |
| 查找 / 替换 | `editorSearch` | 编辑菜单、`Ctrl+F` / `Ctrl+H` | 已上线（批次 5）：CodeMirror 5.65.18 `addon/search/*`、`addon/dialog/*` 离线放进 `web/codemirror/` |

## 7. 必须保留的 APK 行为（回归清单）

每个批次结束都要逐条过：

1. CodeMirror `inputStyle: 'textarea'`；Tab 后连续输入不丢字。
2. ~~APK 内不自动弹出补全~~ → 1.1.1 起 APK 内也在输入时自动弹出补全（见 §19）；`inputStyle: 'textarea'` 必须保留，它才是 Tab 吞字的真正修复。
3. `toolchainReady()` 判断运行库；未就绪时运行给出“请先导入运行库”。
4. 运行中按钮可点并显示“停止”，点击后进入“正在停止...”。
5. 任务请求 8 秒超时、连续 5 次失败熔断、总时长上限、停止后 10 秒兜底。
6. 输出每流 512K 字符上限、增量追加、贴底才自动滚动。
7. 导入进度 90 秒无进度可“后台继续”。
8. 无文件时编辑器只读并显示提示。
9. 软键盘弹出时（`kb-open`）让出空间、光标滚入可视区；旋转时重新测量基准高度。
10. 原生回调名不变：`projectOpened`、`projectSaveResult`、`projectError`、`toolchainImported`、`toolchainProgress`、`dependencyImported`；`DogeNative.*` 调用不变。
11. 全局错误上报 `reportSoftwareError` 保留。
12. 触控目标 ≥44px；长按不弹 WebView 菜单（文件树行除外，要让右键菜单能用长按打开）。

## 8. 布局预算（按平板实测视口算）

全屏横屏 CSS 视口约 1557×973：

- 竖向：菜单栏 44（触控下原型的 40 不够 44，改为 44）+ 状态栏 24 = 68 → 工作台 905。编辑区列内：标签栏 36 + 面包屑 30 + stdin 头 32 + stdin 76 = 174；底部面板 232 + 横把手 7 = 239 → 编辑器可见高度 905 − 174 − 239 = **492px**，约 29 行（15px × 1.65 ≈ 24.75px/行）。
- 横向：活动栏 48 + 资源管理器 264 + 竖把手 ≈ 313 → 编辑区列 **1244px**。
- 分屏 964 宽：仍大于原型断点 920，资源管理器保持内嵌，编辑区列 **651px**；再窄才改为覆盖层。

需要处理的一处：原型 `.workbench` 有 `min-height:520px`。软键盘弹出后可视高度会明显变小（键盘高度未测，批次 6 真机测），工作台会被撑出屏幕。改法：`kb-open` 时去掉最小高度，并临时收起底部面板与状态栏。

## 9. 分批实施

每批完成后都执行“通用验证”（§10），并过一遍 §7 回归清单，通过后才进下一批。

| 批次 | 内容 | 成功判据 | 验证方式 |
|---|---|---|---|
| 0 基线 | 记录当前界面的 UI dump、功能入口清单；把现有纯函数单测整理成可重复运行的脚本 | 基线文件留档，脚本可重跑 | `node` 跑单测；`uiautomator dump` 存档 |
| 1 主题层 ✅ | CSS 全部改为语义令牌；经典主题按 §4.2 原值冻结；新增现代令牌；`data-theme` 早期设置；设置里加「外观」 | 经典主题下界面与改前**无可见差异**（旧布局上验证）；切换即时生效、重启保持 | 已完成，见 §13 |
| 2 骨架 ✅ 已完成 | 菜单栏、活动栏、网格工作台、状态栏、`#layer`；`COMMANDS` 注册表；旧顶栏按钮与项目面板头按钮接到命令后删除 | 旧入口每一个都能在新界面找到并行为一致 | UI dump 核对每个命令入口；单测覆盖 `COMMANDS` 完整性（每条 `run` 存在、快捷键不重复） |
| 3 编辑区 ✅ 已完成 | 多标签（Doc 缓存）、面包屑、stdin 抽屉、文件树（分目录/右键/选中/未保存点）、`renameProjectFile` | 切标签撤销历史独立；重命名后断点、标签、保存结果正确；Tab/IME 正常 | 单测：路径分组、重命名校验、未保存判定；真机：Tab 输入、切文件、重命名后保存到目录再重新打开 |
| 4 底部面板 ✅ 已完成 | 面板视图/分段两级；问题视图与统一问题模型；任务视图；每流滚动状态 | `Ctrl+L` 清空全部流；切流不丢滚动位置；问题点击跳到对应文件对应行 | 单测：stderr 诊断解析成问题条目；真机：编译错误程序、长输出程序 |
| 5 浮层与键盘 ✅ 已完成 | 统一浮层栈；命令面板；设置 / 快捷键 / 关于对话框；键盘路由 §5.3；项目内搜索 | Esc 逐层关闭；焦点不逃出对话框；编辑器内撤销不被抢 | 单测：键盘路由决策函数（输入键 + 焦点 + 浮层状态 → 动作）；有外接键盘时真机逐键验证 |
| 6 响应式与收尾 ✅ 已完成（真机待验证） | 窄屏覆盖层；`kb-open` 适配；触控尺寸；`prefers-reduced-motion`；删掉废弃 id 与死代码；版本升 **1.1.0（versionCode 4）**；打包 `release/1.1.0` | 分屏与全屏都无横向滚动；键盘弹出不溢出；§7 全部通过 | 真机全屏 / 分屏 / 键盘弹出三种状态 UI dump；logcat 无报错 |

## 10. 验证方式

通用验证（每批都跑）：

```powershell
# 1. 前端语法
$text = Get-Content -Raw doge-ide.html
$script = [regex]::Match($text, '<script>([\s\S]*)</script>').Groups[1].Value
# 写入临时 js 后 node --check

# 2. 纯函数单测（抽取函数到 node 执行，批次 0 整理成脚本）

# 3. APK 构建与安装
$env:JAVA_HOME = 'D:\java\jdk-21.0.7'; $env:ANDROID_SDK_ROOT = 'E:\androidSDK'
.\.gradle-dist\gradle-8.11.1\bin\gradle.bat --offline -p . :app:assembleDebug   # android/ 下
adb install -r app\build\outputs\apk\debug\app-debug.apk

# 4. 真机：冷启动 + UI dump + logcat 过滤 Uncaught/TypeError/ReferenceError/FATAL

# 5. 桌面版编译（共用同一 html）
go build ./...
```

说明：我这边读不了截图，界面外观（尤其批次 1 的“经典主题无可见差异”）需要你在平板上目测确认；结构和入口我用 UI dump 核对。

## 11. 风险与对策

| 风险 | 对策 |
|---|---|
| 重构中丢掉已修好的 APK 行为 | §7 回归清单每批必过；行为函数不改签名，只换触发方式 |
| 快捷键和 CodeMirror / 输入法冲突 | §5.3 路由规则 + 单测；`Ctrl+I` 可关闭 |
| 旧 WebView 不支持新 CSS | 令牌写 hex、不用 `color-mix`；`dvh` 保留 `vh` 兜底 |
| 多标签 Doc 缓存占内存 | 只缓存打开的标签；关闭即释放；单文件已有 2MB 上限（原生侧） |
| `prompt/confirm` 在 WebView 不可用 | 全部走 `dogeInput` / `dogeConfirm` |
| 经典主题还原不准 | 值从现有 CSS 原样复制，不重新取色；批次 1 在旧布局上先对比 |
| 单文件继续变大 | 按区块分段注释（令牌 / 布局 / 组件 / 命令 / 面板 / 浮层），函数就近放 |
| 桌面版被影响 | 每批跑 `go build`；`DogeNative` 不存在时的分支保留 |
| 长按弹右键菜单与“禁止长按菜单”冲突 | 放行文件树行的 `contextmenu`，其余区域维持现状 |

## 12. 不做 / 后续

- CodeMirror 6 升级。
- 交互式终端（需要原生 PTY 或交互 stdin 支持）。
- 格式化文档（需确认资源包里是否带 `clang-format`，未确认）。
- 源代码管理、扩展。
- 跨目录重命名 / 移动文件。
- ~~查找替换~~：批次 5 已上线。


## 13. 批次 1 实施记录（2026-09-28，已完成）

改动全部在 `doge-ide.html`，未动布局，只做主题层。

做法：

- `<head>` 加早期内联脚本，在首屏前根据 `localStorage['doge-ide-theme']` 设置 `document.documentElement.dataset.theme`，默认 `classic`，避免加载后配色闪一下。
- `:root` 保留 1.0.x 全部原始色板与字体，逐值冻结；另抽出语义令牌（`--on-accent` `--run-bg` `--scrim` `--bp-glow` `--debug-line` `--toast-*` `--code-line-height` 与整套编辑器 `--ed-*`），数值与原来完全一致。
- 新增 `[data-theme="modern"]` 覆盖块，取自 `edit/1.0.2` 原型并把 OKLch 预换算成 hex（兼容旧 WebView，minSdk 24）。
- 编辑器主题 `cm-s-doge` 全部改用 `--ed-*` 令牌，切换 `data-theme` 即换编辑器配色，无需另建 CM 主题类；行高改用 `--code-line-height`（经典 1.6 / 现代 1.65）。
- 组件里散落的裸色值（run/debug 按钮、断点、调试行、toast、遮罩、确认框按钮等）全部改引用令牌。
- 富文本复制（贴到 Word 的带色 HTML）：经典保持原固定色；现代主题从当前 `--ed-*` 令牌实时取色，屏幕与粘贴一致。
- 设置面板加「外观主题」下拉（经典/现代）；`saveSettings` 写入并 `applyTheme` 即时生效；`toggleSettings` 打开时回填当前主题；`init` 启动即 `applyTheme(currentTheme())`。
- 默认仍为经典。批次 6 新布局落地后再把默认切到现代。

验证：

- `test/frontend-baseline.mjs`：56 项全通过，其中批次 1 新增 11 项（早期脚本、modern 覆盖块、applyTheme/currentTheme、init 调用、saveSettings 写入、themeInput、经典令牌逐值保留、**组件 CSS 无裸 hex/rgba**）。
- `test/batch-verify.ps1`：前端语法、基线测试、桌面版离线 `go build`、APK `assembleDebug`、安装 + 冷启动无 JS 错误，全通过。
- 真机 `HA2K9X7F`：经典主题主界面可见标签与批次 0 基线逐条一致（`report/baseline-1.0.2/ui-visible-labels.txt`）。
- 未在真机交互验证：现代主题实际观感、设置面板内切换（采集时设备正被用户用于其他应用，未强制抢占前台）。切换逻辑由单测覆盖。

注意：`test/batch-verify.ps1` 的语法检查改为取「最长的内联 script」，避免把 `<head>` 里的早期主题脚本和主脚本一起截取导致误报。


## 14. 批次 2 实施记录（骨架，已完成）

改动全部在 doge-ide.html，布局从旧的「顶栏 + 三栏 flex」换成原型的「菜单栏 + 网格工作台 + 状态栏」。行为函数签名未变，只换触发方式与容器。

结构：
- 菜单栏 `.menubar`：品牌 + 六组菜单（文件/编辑/运行/视图/调试*/帮助，调试组随 debugBtn 隐藏而隐藏）+ 状态胶囊 `#runState` + 运行/停止按钮 + 调试按钮。
- 网格工作台 `.workbench`：活动栏 `.rail`（资源管理器、运行和调试两格）| 资源管理器 `.explorer`（项目名/新建/保存/删除/收起 + 文件列表 + 文件数）| 竖把手 `.vsplit` | 编辑器列（标签栏 + 面包屑 `#breadcrumb` + 编辑器 + stdin 抽屉）| 横把手 `.hsplit` | 底部面板 `#outputPanel`（原五标签保留，加面板动作：状态点/清空/收起）。
- 状态栏 `.statusbar`：保存、问题计数、字号 A+/A−、UTF-8、空格=4、版本（点开快捷键）。
- 浮层容器 `#layer`：承载下拉菜单与命令面板，互斥、点遮罩关闭、Esc 关最上层。

命令注册表：
- `COMMANDS` 21 条 + `MENUS` 六组 + `RAIL` 两格；所有入口只调 `runCommand(id)`，行为函数不变。
- 新增 `Ctrl+Shift+P` 命令面板（模糊搜索、上下键选择、回车执行）。
- 快捷键补齐：Ctrl+N/Ctrl+Shift+N/Ctrl+O/Ctrl+B/Ctrl+J/Ctrl+=/Ctrl+-/Ctrl+, 及 F5（调试开启时）；旧的 Ctrl+Enter/S/L/I/Esc 行为不变。
- 键盘路由按 §5.3：浮层打开只吞 Esc；`e.defaultPrevented` 早退（不抢 CodeMirror 的撤销/Ctrl+Space/Tab）；单键命令在输入控件内不触发。

替换/新增函数：
- `setExplorerVisible/toggleExplorer`（合并旧 Files 与 ‹）、`setPanelOpen/togglePanel`、`initWorkbenchLayout` + `bindSplitter`（取代旧 `initResize` 的输出面板拖拽，改为网格把手，宽/高持久化到 `doge-ide-explorer-w` / `doge-ide-panel-h`）。
- `buildMenubar/openMenu`、`buildRail/syncRailActive`、`openCommandPalette`、`closeLayer/addScrim/layerOpen`。
- `updateRunState`（状态胶囊：运行中/停止中/运行库就绪或未导入可点击导入）、`updateBreadcrumb`（面包屑 + 文件数）、`clearConsole`、`adjustFont`、`toggleTheme`、`openSettings`、`openShortcuts`。
- `toggleProjectPanel` 保留为兼容别名转调 `toggleExplorer`；`initResize` 保留为转调 `initWorkbenchLayout`。
- `setRunButtonState` 现在同时刷新状态胶囊；`updateStderrCount` 现在同时更新状态栏问题数。

保留（未改）：五个输出标签与其两级重构留到批次 4；调试入口仍随 `debugBtn` 隐藏。

验证：
- 基线测试 `test/frontend-baseline.mjs`：124 项全过（新增布局节点存在、旧布局已移除、20 个关键行为函数仍在、COMMANDS 完整性、菜单项均有命令、快捷键无重复、键盘路由三条规则）。
- `test/batch-verify.ps1`：前端语法、基线、桌面 go build、APK assembleDebug、安装 + 冷启动无 JS 错误，全过。
- 真机 `HA2K9X7F` 冷启动无 Uncaught/TypeError/ReferenceError/FATAL。UI dump 观感待用户目测（采集时设备正被用于微信，未强制抢占前台）。



## 15. 批次 3 实施记录（编辑区 + 两处用户反馈，已完成）

### 用户反馈修复

1. **输出面板收起后无法展开**：根因是面板上的收起按钮写死为 `setPanelOpen(false)`，只能关不能开。改为 `togglePanel()`（按钮加 `id="panelToggle"`，图标随状态旋转 180°，标题在“隐藏面板/显示面板”之间切换）；另外面板收起时点任意输出标签也会自动展开。已在平板上实测：收起 → 点按钮 → 恢复展开，标签栏位置与按钮文案都正确变化。
2. **stdin 并入输出面板**：编辑器列下方的 stdin 抽屉删除，改为底部面板的第一个标签 `stdin`，与 stdout / stderr / info / Tasks 一起切换。输入框保留 `id="stdinInput"`（运行、调试读取逻辑不用改），标签上显示已输入字符数，面板内带“清空”按钮。`Ctrl+I` 在 stdin 与上一个输出标签之间切换并聚焦输入框。软键盘弹出且焦点在面板内时保留面板、临时收起编辑区（新增 `body.kb-panel`），避免在 stdin 里打字时面板被隐藏。

### 编辑区

- **多标签**：标签栏改为“打开的文件”，每个标签有未保存点和关闭按钮；`Ctrl+W` 关闭当前文件。每个文件一份 `CodeMirror.Doc`，切换用 `swapDoc`，**撤销历史按文件独立**。打开的标签持久化到 `doge-ide-open-files`。原来的固定语言标签移到面包屑右侧的语言标记。
- **面包屑**：`项目 › 目录 › 文件`，逐段显示。
- **文件树**：按路径分目录（`buildFileTree`），目录可折叠且折叠状态持久化；文件图标区分源文件与头文件；当前文件高亮；未保存文件显示圆点；右键（平板长按）菜单：打开 / 新建文件 / 重命名 / 复制相对路径 / 删除。
- **重命名文件**：新增 `renameProjectFile`（`F2`、文件菜单、右键）。只改名不移动目录；校验与新建共用 `validateFileName`；同步更新打开的标签、文档缓存、断点。改名后的文件显示未保存，保存项目后写入目录。
- **未保存标记**：发起保存时对所有文件内容做哈希快照，保存成功回调时才把快照记为基线，因此保存过程中继续输入的内容仍显示未保存。基线持久化到 `doge-ide-saved-hashes`；首次升级没有记录时把当前内容视为已保存，避免所有文件一上来都标红。只在 APK 内启用（浏览器预览没有“项目目录”概念）。
- **断点按文件存储**：此前断点按语言（`breakpoints['c']`）存，同一项目所有文件共用一份，多标签后会串文件。改为按文件路径存，旧数据首次读取时迁到当前文件。
- 顺手删除：`runCode` 与 `switchProjectFile` 里按 `data-lang` 切换 `.tab` 激活态的代码（文件标签没有 `data-lang`，会把激活态清掉）；无用变量 `stdinVisible`。

### 验证

- 基线测试 159 项全过。本批新增：`buildFileTree`（根文件、目录排序、目录内排序、嵌套、空列表）、`validateFileName`（9 例，含语言一致性、目录路径、`..`、空名、非源码扩展名）、`hashText`（3 例）的纯函数单测；面板按钮为切换且无写死的 `setPanelOpen(false)`、点标签会展开；stdin 位于面板内且编辑器列已无 stdin；切换文件使用 `swapDoc`；断点按文件路径存储；保存快照在发起保存时生成。
- `test/batch-verify.ps1` 全过（前端语法、基线、桌面 go build、APK 构建、安装 + 冷启动无 JS 错误）。
- 真机：面板收起/展开两个方向均实测通过；文件标签、文件树、面包屑、stdin 标签均出现在 UI dump 中。
- 未在真机实测：stdin 标签内打字（采集中途设备切到了其他应用且弹出输入法，未强制抢回前台）、重命名、多标签撤销、右键菜单、未保存点。



## 16. 批次 4 实施记录（底部面板两级重构，已完成）

### 结构

底部面板从“五个平级标签”改为两级：

- **面板视图**（第一级）：问题 · 输出 · 任务 · 调试控制台（调试控制台随调试开关显示，当前隐藏）。
- **输出视图内分段**（第二级）：stdin · stdout · stderr · info。批次 3 用户要求的“stdin 与输出一起切换”保留在这里。
- 新增 `switchPanelView(view)` 与 `switchStream(stream)`，两级状态分开保存；`switchOutputTab(tab)` 保留为兼容入口，流名转 `switchStream`、视图名转 `switchPanelView`，旧调用点不用改。
- 每个视图一个容器（`#problemsView` `#outputView` `#tasksView` `#debugView`），`#taskList` 改为常驻节点，不再每次切标签时动态创建。

### 问题视图

- `parseCompilerDiagnostics`：解析 clang 的 `file:line:col: 级别: 消息`（error / warning / note / fatal error），跳过源码回显行、插入符与 “N errors generated” 汇总；另外识别没有文件位置的 `wasm-ld: error:` / `clang: error:` 链接和驱动错误。有具体链接错误时去掉 “linker command failed” 汇总行，避免重复计数；最多 500 条、同一条去重。
- `normalizeClangdDiagnostic`：LSP 诊断转统一问题项（0 基行列转 1 基，severity 1/2/3–4 → 错误/警告/提示）。
- `mergeProblems` + `collectProblems`：合并“本次运行的编译问题”与“各文件的 clangd 实时诊断”，同文件同行同级同消息去重；编译问题里编译目录下的绝对路径用 `findDiagnosticFile` 映射回项目内路径。
- 按文件分组，当前文件排在最前，链接/构建错误单独一组排最后；点击有位置的条目跳到对应文件对应行，链接错误不可点击。
- 面板“问题”标签显示错误+警告数（有错误时标红）；状态栏的问题按钮改为分别显示错误数与警告数，点击打开问题视图。
- 运行结束（`onRunFinished`）：编译错误且解析出问题时自动切到问题视图；其它失败且当前停在 stdout 时切到 stderr；成功不切换。浏览器直连与 APK 任务两条运行路径都走这里。
- clangd 结果写入 `clangdProblems[path]`；重命名、删除文件、换项目时同步清理。

### 输出与滚动

- 每个输出流单独记住滚动位置（`streamScroll`，按运行 `runId` 失效）：切流、切到别的视图再回来都恢复原位置；新一次运行从底部开始。追加输出时仍是“贴底才自动滚动”。
- `Ctrl+L` / 面板清空：一次清空全部输出流、本次运行的问题与滚动记录；clangd 诊断保留（它反映的是当前源码，不是某次运行）。
- 运行开始 `beginRun`：清掉上一次的问题和滚动记录，停在问题视图或 stdin 上时切回 stdout。

### 任务视图

- 每条记录显示文件、语言、中文状态（排队中 / 运行中 / 成功 / 编译错误 / 运行错误 / 超时 / 已取消 / 运行库未就绪）与耗时；面板“任务”标签显示进行中的任务数；没有记录时显示空状态说明。

### 顺手修复

- **`clearConsole` 的 ReferenceError**：批次 2 写的 `clearConsole` 用了 `outputRenderId++`，但这个变量在 P-F10 清理时已被删除且没有重新声明，Ctrl+L 和面板“清空”按钮点下去会直接抛错。本批重新声明 `outputRenderId` 并用于滚动记录失效，测试加了守护。
- 删除 `runCode` / `debugCode` 里手写的 `.output-tab` 激活态切换与重复的 stderr 计数代码，统一走 `switchStream` / `updateStderrCount`。

### 验证

- 基线测试 208 项全过。本批新增 47 项：`parseCompilerDiagnostics`（按 clang 真实输出格式：绝对路径、警告/错误/提示/错误四条、行列、消息、忽略回显行与汇总行、fatal error、wasm-ld 链接错误、只有汇总行时保留、去重、空输入、运行时输出不算问题）、`normalizeClangdDiagnostic`（0 基转 1 基、三种级别、缺字段）、`mergeProblems`/`problemCounts`；以及两级面板结构、每流滚动恢复、`outputRenderId` 声明、Ctrl+L 清空问题、运行结束解析问题、编译错误自动切换、两条运行路径都调用、clangd 写入问题模型、问题点击跳行、状态栏错误/警告数。
- `test/batch-verify.ps1`：前端语法、基线、桌面版离线 go build、APK `assembleDebug` 全过。
- **未在真机验证**：本批结束时平板已断开 ADB（`adb devices` 为空），APK 已构建但未安装；也未能从设备抓取真实 clang/wasm-ld 输出，解析器测试样例按 clang 的标准输出格式编写。重新连接后需要：安装、写一个有编译错误和链接错误的程序实际跑一次，确认问题视图的条目、分组、跳转与状态栏计数。


## 17. 批次 5 实施记录（浮层与键盘，已完成）

### 浮层栈

- `#layer`（下拉菜单 / 命令面板 / 右键菜单）保持互斥；新增对话框栈 `overlayStack`。新建项目、设置、快捷键三个静态弹窗走 `openModal` / `hideModal`，`dogeConfirm` / `dogeInput` / 关于三个动态弹窗走 `openDynamicDialog`，全部入栈。
- 打开对话框时先关掉下拉 / 命令面板（`pushOverlay` → `closeLayer`）。
- `Esc` 逐层关闭：先 `#layer`，再栈顶对话框。叠在设置上的确认框按一次 Esc 只关确认框，不执行确认回调。
- `Tab` / `Shift+Tab` 在栈顶对话框内循环；焦点被程序移出对话框时（`focusin`）拉回；关闭后焦点回到打开前的位置，原位置已不在页面上时交给下一层对话框。
- 导入进度遮罩：导入进行中 Esc 不能关掉；出现“长时间没有进度”时，Esc 等同“后台继续”。
- 三个静态弹窗都补了 `role="dialog"` `aria-modal` `aria-labelledby`。

### 对话框

- **设置**：从右上角浮动面板改为居中对话框 `#settingsModal`，分“外观 / 运行 / 构建 / 键盘”四组，文案改为中文。所有输入框 id 不变，保存逻辑不变（`saveSettings` 仍用同一套钳制）。初始焦点放在主题下拉框上，平板上打开时不会弹出软键盘。新增“Ctrl+I 切换标准输入”开关（§5.3 规则 5），存为 `doge-ide-ctrlIStdin`。
- **快捷键**：内容由 `COMMANDS` 按菜单分组生成（`buildShortcutGroups`），另附 CodeMirror 自带的撤销 / 查找下一个 / 缩进等；调试关闭时不列 F5；Ctrl+I 关闭时标注“已在设置中关闭”。原来手写的 7 行英文表删除。
- **关于**：新增。显示版本、运行环境、运行库是否就绪、CodeMirror 与 WebView 版本、当前项目。状态栏右侧的版本号改为打开“关于”；版本号取自 `APP_VERSION`，单测保证它与 `android/app/build.gradle` 的 `versionName` 一致。

### 键盘路由（§5.3）

- 纯函数 `routeKey(event, ctx)` → `none | closeOverlay | cancelRun | command`，`initKeybindings` 只负责取上下文和分发。原来 18 条手写的 `if (mod && k === ...)` 删除；快捷键只在 `COMMANDS.key` 写一次，菜单、命令面板、快捷键表、键盘路由共用（`buildKeyBindings`），单测保证每个 `key` 都能路由到自己的命令。
- 规则落地：浮层打开时只处理 Esc；`defaultPrevented` 的键不二次执行（编辑器内 Ctrl+Z / Ctrl+Space / Tab / Ctrl+F 不被抢）；单键命令（F2、F5）不在输入框里触发，F2 标 `inEditor` 允许在编辑器里用；Esc 无浮层时只在运行中停止；Ctrl+I 可关闭；输入法组字中（`isComposing` / keyCode 229）不处理。
- 修正一处设计缺陷：CodeMirror 对**每个** Esc 都会 `preventDefault`（默认键位 `Esc: singleSelection`），按规则 2 丢弃的话，焦点在编辑器里时 Esc 就停不了程序。改为 Esc 单独判断，用捕获阶段记录的状态识别“这个 Esc 已被用掉”（关补全列表、关命令面板、关查找条），这种情况下不再停止运行或关下一层。
- Ctrl+Space、Ctrl+F、Ctrl+H 标 `skipInField`：在编辑器以外的输入框里放行（不少输入法用 Ctrl+Space 切换）。
- `Shift+=` 产生的 `+`、`Shift+-` 产生的 `_` 按原键处理；Cmd 视为 Ctrl。

### 查找 / 替换（编辑器内）

- 新增 CodeMirror **5.65.18** 的 `addon/search/search.min.js`、`addon/search/searchcursor.min.js`、`addon/dialog/dialog.min.js`、`addon/dialog/dialog.min.css`，从 cdnjs 的固定版本路径下载，离线放在 `web/codemirror/` 下（APK 打包 `web/**`，桌面版 `//go:embed all:web`，两边都带上）。
- `Ctrl+F` 查找、`Ctrl+H` 替换（覆盖 pcDefault 里的删除前一字符）、`Ctrl+G` / `Ctrl+Shift+G` 下一个 / 上一个、`Ctrl+Shift+R` 全部替换。addon 默认把 `Shift-Ctrl-F` 绑成替换，这里让给项目内搜索。对话框文案通过 `phrases` 中文化，配色走令牌。
- 编辑菜单加“查找 / 替换”，触控设备无键盘也能用。

### 项目内搜索（D7）

- 活动栏第 2 格、视图菜单、命令面板、`Ctrl+Shift+F`（编辑器里选中的单行文字会带入搜索框）。搜索视图与文件树共用侧栏（`#explorer[data-view]`），活动栏按当前视图高亮；再点当前视图收起侧栏，Ctrl+B 回到文件视图。
- 纯函数 `searchProjectFiles` 在内存里的 `project.files` 中逐行查找：区分大小写 / 全字匹配 / 正则三个开关（记在 `doge-ide-search-opts`）；无效正则给出错误；跳过零宽匹配防死循环；最多 1000 个结果，超出时截断并提示。
- 结果按文件分组、可折叠，行预览去掉缩进并高亮匹配；点击打开文件并选中匹配处。输入 220ms 去抖；搜索视图可见时，编辑内容或文件列表变化后自动刷新并保持滚动位置。

### 验证

- 基线测试 208 → **340** 项全过。新增：`routeKey` 34 条用例（覆盖 §5.3 五条规则、Esc 的各种情况、输入法组字、Shift 变体、Cmd），每个 `COMMANDS.key` 都能路由到自己的命令，`buildShortcutGroups`，`searchProjectFiles` / `searchHitPreview` 16 条，版本号与 gradle 一致，四个 addon 文件存在且按依赖顺序引用，三个弹窗的 dialog 语义，以及浮层栈接线。
- 新增 `test/browser-smoke-b5.mjs`：用本机 headless Edge 154（CDP，Node 24 自带 WebSocket，不加依赖）加载真实页面，发送真实键盘事件，**66 项全过**，无 JS 异常。覆盖：设置对话框打开 / 初始焦点 / Tab 循环 / 焦点拉回 / 叠确认框后 Esc 逐层关 / 保存生效 / 焦点归还；Ctrl+I 开关；快捷键表内容；关于；命令面板 Esc 在运行中只关面板；打开对话框先关下拉；编辑器内输入后 Ctrl+Z 撤销；编辑器内 F2 重命名、输入框内 F2 不叠层；编辑器内运行中 Esc 停止、空闲不停止；Ctrl+F 查找条（中文）、Enter 选中、Esc 关查找条且不停止运行；替换；Ctrl+Shift+F 搜索视图、结果数、分组、搜索框内 F2 / Ctrl+F 放行、点击跳转选中、全字 / 正则 / 无效正则、编辑后自动刷新；活动栏切换与 Ctrl+B；导入进度遮罩 Esc 行为；设置对话框在 1557×973 视口内。已加进 `test/batch-verify.ps1`。
- `test/batch-verify.ps1`：前端语法、基线、浏览器冒烟、桌面版离线 go build、APK `assembleDebug` 全过。
- **未在真机验证**：平板仍未连接 ADB（`adb devices` 为空），批次 4、5 的 APK 都已构建但未安装。重连后需要：安装后冷启动看 logcat；外接键盘逐键过一遍 §5.3；触控下打开设置 / 快捷键 / 关于 / 查找条 / 搜索视图，确认尺寸与软键盘行为；中文输入法下 Ctrl+Space、Ctrl+I 是否冲突。


## 18. 批次 6 实施记录（响应式与收尾，已完成；真机待验证）

### 顺手发现并修复的布局问题

- **底部面板只有编辑区 40% 宽**：面板元素还带着旧类 `output-panel`，旧样式 `.output-panel{width:40%;min-width:280px}` 在新网格里依然生效，全屏横屏下面板只有 528px 宽（编辑区 1319px）。批次 2 起就存在，UI dump 只核对入口、看不出宽度，这次用浏览器量尺寸才发现。去掉旧类与旧样式后面板与编辑区同宽。
- **软键盘弹出且焦点在 stdin 时面板没占满**：编辑区隐藏后网格第一行仍按 `minmax(0,1fr)` 分走一半高度。`kb-panel` 时把网格改为 `0 0 minmax(0,1fr)`。

### 窄屏（≤ 920px：分屏 / 竖屏）

- 资源管理器改为覆盖层，下面加半透明遮罩 `#explorerScrim`；点遮罩、在文件树选中文件、点搜索结果、按 Esc 都会收起。Esc 在运行中也只收起覆盖层，不停止执行（`routeKey` 把覆盖层当作一层浮层）。
- 进入窄屏时覆盖层默认收起；窄屏里的开关**不写入**宽屏的显隐偏好，回到宽屏时恢复原状态。
- 菜单栏：原来整条菜单栏横向滚动，窄到一定程度运行按钮会被挤出视口。改为只有菜单部分滚动，品牌名与运行库状态胶囊隐藏，运行按钮始终可见（420px 宽实测可见）。
- 竖把手在窄屏隐藏（覆盖层宽度固定）。

### 触控尺寸（pointer:coarse）

- 目标：所有可见可点控件 ≥ 44×44px。菜单栏升到 48px，侧栏头、标签条、文件树行、搜索结果、对话框输入框与按钮、新建项目表单、导入进度按钮都调到 44px。
- 视觉上要保持小巧的控件（运行库状态胶囊、输出分段、标签关闭 ×、补全按钮、stdin「清空」）用透明 `::after` 把可点区域扩到 44px，外观不变。
- 拖拽把手：触控时可拖宽度 20px（竖）/ 27px（横），视觉线不变。
- 项目搜索框：触控下三个选项按钮移到输入框下方一行，各 44px。
- 例外：状态栏保持 30px 高。上面的每个操作（保存、问题数、A+/A−、关于）在菜单、面板或命令面板里都有 ≥ 44px 的入口。
- 鼠标设备不受影响（菜单栏 44px、图标按钮 30px、状态栏 26px，测试守护）。

### 软键盘

- 沿用 `kb-open`：收起底部面板、横把手、状态栏；焦点在底部面板（stdin）时改为收起编辑区（见上面的修复）。
- 键盘弹出时聚焦元素改用 `scrollIntoView({block:'nearest'})`，不再强制居中，减少布局跳动；键盘收起后复位被带偏的布局容器滚动（`resetLayoutScroll`）。
- 原计划 §8 提到的原型 `.workbench{min-height:520px}` 在正式代码里没有带进来，无需处理。

### 清理

- 删除旧布局 CSS：`.header` `.logo` `.main` `.project-panel` `.project-head` `.project-actions` `.project-resize` `.project-toggle` `.editor-panel` `.tab*` `.packs-toggle` `.output-header/title/meta` `.output-tab*` `.output-panel` `.resize-handle` `.footer` `.settings-btn` `.toolchain-btn` `.hotkey-hint` `.rail-badge/.rail-gap` `.file-dot` `.output-content.debug`，以及只作用于它们的触控 / 窄屏 / 矮屏媒体查询。
- 删除死函数：`toggleProjectPanel` `toggleExplorer` `initResize` `toggleSettings` `defaultProjectFiles` `storageKey` `saveCode` `getSavedCode` `loadSavedState` `saveCurrentLang`（逐个确认没有调用方；`switchOutputTab` `buildTabs` 仍有调用，保留）。
- `dogeInput` 的内联样式改为 `.dialog-input` 类；页面标题改为「Doge IDE+ · 本地 C/C++ 编程」（原来是云端版的「轻量在线编程工具」）。
- 新增测试守护：所有 `onclick="fn()"` 指向的函数必须存在，防止删死代码时误删。

### 默认主题与版本

- 默认主题改为「现代」：早期内联脚本、`currentTheme`、`applyTheme` 三处。已经在设置里选过经典的用户（`doge-ide-theme=classic`）保持经典；设置下拉把「现代（默认）」放在第一项。
- 版本 **1.1.0 / versionCode 4**：`android/app/build.gradle`、`APP_VERSION`、状态栏文案。单测保证 `APP_VERSION` 与 gradle 一致。

### 发布

- `release/1.1.0/`：`DogeIDEPlus-1.1.0-debug.apk`（1,027,034 字节，SHA-256 `801BA0E0…B575C6`，aapt2 确认 versionCode 4 / versionName 1.1.0-debug）、`doge-cpp-arm64-0.1.0.zip`（与 1.0.x 相同）、`SHA256SUMS.txt`、`RELEASE-NOTES.md`。已核对 APK 内 `assets/index.html` 与源码 `doge-ide.html` 逐字节一致，四个查找 addon 已打包。

### 验证

- 基线测试 340 → **415** 项全过（新增批次 6 结构断言、onclick 目标存在、死代码 / 死样式已删除、默认主题、版本号）。
- 新增 `test/browser-lib.mjs`（批次 5、6 共用的无依赖 CDP 驱动）与 `test/browser-smoke-b6.mjs`：**83 项全过**，无 JS 异常。覆盖：全新安装默认现代 / 选过经典保持经典；1557×973、964×973、920×900、720×973、600×960 五个视口下无横向滚动、无纵向溢出、运行按钮可见、状态栏贴底、面板与编辑区同宽、编辑器 ≥ 12 行、所有触控目标 ≥ 44px；窄屏覆盖层（真实触摸点遮罩、选文件、Esc、搜索跳转后收起，宽屏偏好不被覆盖）；420px 宽菜单滚动且运行按钮可见；模拟软键盘（编辑器 / stdin / 设置对话框三种焦点）下无溢出、光标行与输入框可见、收起后无残留滚动；设置 / 快捷键 / 新建项目 / 输入框 / 确认框 / 下拉菜单 / 命令面板的触控尺寸；鼠标设备保持紧凑尺寸；prefers-reduced-motion。
- 批次 5 冒烟 66 项仍全过。`test/batch-verify.ps1`：语法、基线、两组浏览器冒烟、桌面版离线 go build、APK `assembleDebug` 全过。
- **未在真机验证**：平板在批次 4–6 期间一直未连接 ADB。浏览器模拟覆盖了布局与交互逻辑，但以下只能在设备上确认：真实软键盘高度与 `visualViewport` 行为（模拟是缩小视口，不是真实 IME）、Android WebView 140 的触摸 / 长按、外接键盘逐键、中文输入法下 Ctrl+Space / Ctrl+I、分屏模式下 `sensorLandscape` 与 `resizeableActivity` 的实际尺寸、以及现代主题观感。


## 19. 1.1.1：输入时自动弹出补全

### 为什么现在可以在 APK 里打开

1.0.x 在 APK 里关掉自动补全（`bindAutoComplete` 遇到 `DogeNative` 直接返回），是因为当时 Tab 后连续输入会吞字，怀疑是异步补全和输入法抢光标。后来真机确认根因是 CodeMirror 在 Android WebView 默认用 contenteditable 输入模式，改成 `inputStyle: 'textarea'` 后 Tab 已经正常（见 `report/APK-DEEP-CHECK-2026-09-27.md`）。关掉自动补全的理由已经不存在，这一版把它打开，并保留设置开关。

### 行为

- **什么时候弹**（纯函数 `autoCompleteTrigger`）：输入满两个字母的标识符；`.` / `->` / `::` 之后；`#` 开头的预处理指令；`#include <` / `#include "` 之后。注释和字符串里、数字字面量（`0xff`、`1e10`）里、在一个词中间改字时不弹。
- **输入法**：Android 键盘在英文下也会组字，变更来源是 `*compose`，同样触发（旧代码只认 `+input`，在平板上本来也不会触发）。
- **列表打开后**：改用 show-hint 的异步 hint（`editorHint`），每次输入按当前光标重新计算，列表随输入收窄；输完整个词、离开这个词、没有候选时自动关闭。Enter / Tab 接受，Esc 关闭。
- **来源**：本地候选（语言关键字 + 文档里的标识符，成员访问时用文档里出现过的成员名）立即显示；运行库就绪时再请求 clangd，回来后合并并按 clangd 的 `sortText` 排序，显示函数签名与返回类型。
- **clangd 结果**：同一个词里继续输入时在本地筛选，不重复请求（`isIncomplete` 时除外）；请求带 6 秒超时；服务失败时这个词里只用本地候选。插入的是 `textEdit.newText` / `insertText`（名字本身），不再是带签名的 `label`——旧的手动补全会把 `printf(const char *restrict format, ...)` 整个插进去。
- **触控**：点选候选时阻止编辑器失焦，平板上软键盘不会收起再弹出；候选项 44px 高。
- **开关**：设置 → 编辑 →「输入时自动弹出补全」，编辑菜单也有同名勾选项；默认开启，存为 `doge-ide-autoComplete`。关闭后 Ctrl+Space / 编辑 → 代码补全仍可手动触发（手动时一个字母也能补全）。
- 编辑器标签栏右侧的「补全」按钮删除。
- 顺带修正：本地成员补全以前只认 `.` 和 `::`，`->` 不识别；输入 `q->y` 时会把光标处这个半截的 `y` 本身当成候选。
- Esc：只有“看得见的”补全列表才算被 Esc 用掉。没有候选时 show-hint 会留下一个不可见的补全状态，以前它会吞掉运行中按 Esc 停止的那一下。

### 验证

- 基线测试 415 → **470** 项全过：`autoCompleteTrigger` 27 条、`normalizeClangdCompletionItems` 8 条、`rankCompletions` 7 条、本地成员补全 4 条，以及接线断言。基线测试的函数抽取改为跳过字符串 / 正则 / 注释里的花括号（原来遇到含 `{` 的正则会截错）。
- 新增 `test/browser-smoke-completion.mjs`（**45 项全过**）：真实按键逐字输入、模拟输入法组字、列表随输入收窄、Tab / Enter 接受（Enter 不换行）、注释 / 字符串 / 数字不弹、`#inc` 与 `#include <st`、`p.` 与 `q->`、关闭开关后不弹但 Ctrl+Space 可用、Esc 与运行中停止的配合、clangd 模拟（先本地后合并、排序、类型说明、同词不重复请求、插名字不插签名、失败回落）、切换文件关闭列表、触控点选不失焦且 44px。已加进 `batch-verify.ps1`。另外修正了 `test/browser-lib.mjs` 的按键码：`.` 原来发的是 Delete 键码。
- `batch-verify.ps1` 全过；版本 1.1.1 / versionCode 5，打包 `release/1.1.1/`。
- **真机待验证**：平板未连接。需要确认中文输入法（拼音组字上屏英文时）与候选列表的配合、真实 clangd 的响应速度与候选质量。

## 20. 1.1.2：Tab 接受补全、项目头文件

### Tab 变成缩进（真机反馈）

桌面浏览器里 Tab 能接受候选，平板上变成缩进。桌面测试走的是“按键 → CodeMirror 键位表 → show-hint 的 Tab: pick”这一条路；平板上 Tab 可能在输入法组字中到达（`isComposing`），或者输入法根本不发 Tab 键、而是把 `\t` 当文字插入（keyCode 229），这两种都绕过了 show-hint 的键位表，落到默认的 `insertTab`。

改法（`bindAutoComplete`）：

- 在编辑器隐藏 textarea 上用**捕获阶段** keydown 拦 Tab：列表可见就 `preventDefault` 并直接 `widget.pick()`，不再依赖键位表。
- 组字中按 Tab：先记下，等 `compositionend`（最后一个字母上屏、列表按新前缀刷新）后再接受。
- 输入法把 `\t`（或 `字母+\t`）当文字送来：`beforeChange` 里取消这次插入，先插入字母，再接受候选；列表没打开时照常缩进。
- 列表不可见（`hintWidgetOpen` 为假）时一律不拦，Tab / Shift+Tab 行为不变。

### 项目头文件

- 新增纯函数：`normalizeProjectPath` / `resolveProjectInclude` / `projectHeaderChoices` / `reachableProjectHeaders` / `extractHeaderSymbols`。查找顺序与真实编译一致：源文件所在目录 → 项目根 → 构建配置 `include_paths`。
- `extractHeaderSymbols` 从头文件提取：函数（带签名，含 `const char *`、`std::vector<T>` 返回类型、`namespace` 与模板里的声明）、宏（跳过 include guard）、`struct/union/enum/class` 名与 `typedef`（含函数指针）、枚举常量、结构体成员、`extern` 变量。先把注释和字符串换成空格，避免扫出假符号；类里的成员函数不当成全局函数。按内容哈希缓存。
- 本地补全：普通候选合并当前文件能看到（递归 include，防环，最多 32 个）的头文件符号，排最前并显示签名与文件名；成员补全加入头文件里的结构体成员；`#include "` 列出项目头文件（就近目录的写法在前），接受时补收尾引号；`#inc` 的指令候选加了 `#include "`。
- 本地“未定义名”检查把头文件符号当作已知，不再标红。
- clangd：补全 / 诊断请求带上 `build`（构建配置）；`compile_commands.json` 为每个源文件加 `-iquote <项目根>`、`include_paths` 的 `-I`、`defines` 的 `-D`；内容变化时重写并重启 clangd，让新参数生效。
- 真实编译（`LocalCompiler.applyBuildOptions`）也加 `-iquote <项目根>`：以前子目录里的源文件 `#include "util.h"`（根目录的头文件）会编译失败。用 `-iquote` 而不是 `-I`，只影响双引号形式，项目里同名的 `math.h` 不会挡住 `<math.h>`（本机 gcc 验证过这个组合）。

### 验证

- 基线测试 470 → **515** 项全过：include 解析 13 条、头文件符号提取 19 条（含两份真实风格的 C / C++ 头文件）、递归收集 1 条、接线断言（含两处 Java 参数）。
- `test/browser-smoke-completion.mjs` 45 → **69** 项全过：Tab 在组字后 / 组字未上屏时 / 输入法送 `\t` / 输入法送 `字母+\t` 四种情况都能接受，没有列表时照常缩进，Shift+Tab 不接受；头文件函数（带签名和文件名）、宏、子目录头文件、递归 include 的枚举常量、没 include 的不提示、结构体成员、改头文件后候选即时更新、`#include "` 列表 / 子目录写法 / 收尾引号、未定义名检查。
- `batch-verify.ps1` 全过（含 APK 构建，Java 改动编译通过）。版本 1.1.2 / versionCode 6，打包 `release/1.1.2/`。
- **真机待验证**：平板未连接。需要确认你的输入法下 Tab 接受候选；clangd 在子目录 / include 路径下的头文件补全与诊断；子目录源文件 include 根目录头文件能编译运行。
