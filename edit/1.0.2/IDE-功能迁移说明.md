# Doge IDE+ 界面迁移说明

> 旧版：`doge-ide.html`（2915 行，单文件 WebView）
> 新版参考原型：`doge-ide-modern-ui.html`（可直接打开操作，含完整交互）
> 视觉令牌：`brand-spec.md`
>
> 本文回答一个问题：**旧版每个能力现在搬到哪了、要改哪个函数。**

---

## 0. 一句话

旧版把 11 个能力入口散在顶栏和项目面板头部，新版收进**一条六组菜单栏**和**一个命令面板**；输出区从 5 个平级标签改成「5 个面板视图 + 输出视图内 3 个分段」的两级结构；行为层 36 个函数保持不变，9 个需要重构，4 个是新增。

---

## 1. 旧版的结构性问题

| 问题 | 位置 | 后果 |
|---|---|---|
| 同一条能力有两个入口 | `projectToggle`（顶栏 Files）与 `project-head` 的 `‹` 都调 `toggleProjectPanel()` | 用户不知道哪个是「正式」入口 |
| 无键盘路径 | `initKeybindings()` 只绑了 4 组快捷键 + `Esc`，新建/删除/打开项目全部只能点按钮 | 触屏与纯键盘用户被排除 |
| 按钮无语义 | `＋` `−` `‹` 是纯字符，宽度挤在一行，读不出功能 | 可发现性差 |
| 图标用 emoji | `⚙`（设置）、`📥`（stdin） | 跨平台字形不一致，不可换色 |
| 输出区扁平 | 5 个平级 tab：`stdout / stderr / info / Tasks / debug` | 编译诊断和运行结果混在一起，诊断被 stdout 淹没 |
| 声明了不存在的快捷键 | `补全` 按钮 `title` 写「Ctrl+Space」，但 `initKeybindings()` **没有绑定它** | 点提示无效 |
| 无命令面板 | 全部靠记忆 | 长尾操作不可发现 |

---

## 2. 入口迁移对照

### 2.1 顶栏（`.header`）

| 旧入口 | 旧函数 | 新入口 | 处理 |
|---|---|---|---|
| `Files` 按钮 | `toggleProjectPanel()` | 视图 › 资源管理器 `Ctrl+B` ＋ 活动栏第 1 格 | **合并**，改由状态驱动 |
| `导入运行库` 按钮 | `pickToolchain()` | 帮助 › 导入本地运行库 | 降级为菜单项 |
| `⚙` 按钮 | `toggleSettings()` | 帮助 › 设置… `Ctrl+,` | emoji 换 SVG + 改对话框 |
| `Doge IDE+` 文字 + `Ctrl+Enter 运行` 提示 | — | 品牌区保留；快捷键提示移到运行按钮内 | 精简 |
| `Run` 按钮 | `runCode()` | 顶栏**唯一主按钮** ＋ 运行 › 运行当前文件 `Ctrl+Enter` | 保留 |
| `Debug` 按钮（初始 `hidden`） | `debugCode()` | 顶栏次按钮（轮廓样式）＋ 调试 › 开始调试 `F5` | 保留条件显示 |

> 顶栏右侧最终只有 **1 个实心主按钮**（运行）。调试是轮廓按钮，导入运行库不再是按钮。

### 2.2 项目面板头（`.project-head`）

| 旧入口 | 旧函数 | 新入口 | 处理 |
|---|---|---|---|
| `projectName` 文字 | `renameProject()` | 文件 › 重命名项目… ＋ 双击项目名 | 保留 |
| `New` | `showCreateProject()` | 文件 › 新建项目… `Ctrl+Shift+N` | 保留 |
| `Open` | `openProject()` | 文件 › 打开项目… `Ctrl+O` | 保留 |
| `Save` | `saveProjectToDisk()` | 文件 › 保存项目到目录 `Ctrl+S` | 保留 |
| **`＋`** | **`newProjectFile()`** | **文件 › 新建文件 `Ctrl+N`** ＋ 面板头图标 ＋ 文件右键 › 新建文件 | **本条是迁移的典型例子**：`＋` 从「猜格式的图标」升级为「菜单里写明动作、带快捷键、三个入口等价」 |
| **`−`** | **`deleteProjectFile()`** | **文件 › 删除当前文件** ＋ 文件右键 › 删除 ＋ `Delete` 键 | 同上，补二次确认 |
| `‹` | `toggleProjectPanel()` | 视图 › 资源管理器 `Ctrl+B` | 与顶栏 `Files` 合并，删掉重复入口 |

### 2.3 编辑器工具条（`.editor-tools`）

| 旧入口 | 旧函数 | 新入口 | 处理 |
|---|---|---|---|
| `补全` 文字按钮 | `triggerCompletion()` | 编辑 › 代码补全 `Ctrl+Space` | 保留，**并把 `Ctrl+Space` 真正绑上**（旧版缺失） |

### 2.4 输出面板（`.output-panel`）

| 旧入口 | 旧函数 | 新入口 | 处理 |
|---|---|---|---|
| `stdout` tab | `switchOutputTab('stdout')` | 面板视图「输出」→ 分段 `stdout` | **两级化重构** |
| `stderr` tab + `#stderrCount` | `switchOutputTab('stderr')` / `updateStderrCount()` | 面板视图「输出」→ 分段 `stderr`；数量角标升级为面板视图「问题」的角标 | 重构 |
| `info` tab | `switchOutputTab('info')` | 面板视图「输出」→ 分段 `info` | 重构 |
| `Tasks` tab + `#taskList` | `switchOutputTab('tasks')` / `renderTaskList()` / `pollTask()` | **独立面板视图「任务」** | 提升为一级 |
| `debug` tab（初始 `hidden`）+ `#debugCount` | `switchOutputTab('debug')` / `renderDebugPanel()` / `clearDebugPanel()` | **独立面板视图「调试控制台」** | 提升为一级 |
| `#outputMeta` 元信息 | `renderOutput()` 内拼 | 移入菜单栏右侧状态胶囊 | 重构 |
| `#statusDot` 状态点 | `setRunButtonState()` | 菜单栏状态胶囊的彩色点 | 保留 |

**新结构**：

```
底部面板
├── 问题        ← 新增：编译诊断（来自 lintDocument / requestClangdDiagnostics）
├── 输出
│   ├── stdout   ← runCode 输出
│   ├── stderr   ← 编译器诊断原文
│   └── info     ← 工具链 / 目标 / 宏 / 注入 stdin 摘要
├── 调试控制台   ← 旧 debug tab
├── 任务         ← 旧 Tasks tab
└── 终端         ← 新增占位（当前版本无 PTY，先留视图位）
```

### 2.5 设置

| 旧入口 | 旧函数 / id | 新入口 |
|---|---|---|
| `⚙` → 右侧滑出面板 | `toggleSettings()` / `#settingsPanel` | 帮助 › 设置… `Ctrl+,` → 居中对话框 |
| Timeout | `#timeoutInput` | 对话框「超时 timeout」 |
| Editor font size | `#codeSizeInput` | 对话框「编辑器字号」 |
| Build profile | `#optimizationInput` | 对话框「构建档」 |
| 宏 / include / 链接库 | `#definesInput` `#includesInput` `#librariesInput` | 对话框同名字段 |
| 依赖记录 + 导入离线依赖包 | `#dependenciesInput` / `pickDependencyPackage()` | 对话框「离线依赖包」 |
| 导入资源包 (.zip) | `pickToolchain()` | 对话框「本地运行库」＋ 帮助 › 导入本地运行库 |
| `#toolchainHint` `#codeSizeHint` | `toggleSettings()` 内写 | 对话框行内说明文字 |
| Cancel / Save | `toggleSettings()` / `saveSettings()` | 对话框「取消」/「保存」 |

> 落盘逻辑（`getSetting` / `setSetting` / `saveSettings` 里的 `clampInt` 与 `ensureBuildModel`）**一行不用改**，只换外层容器与读写时机。

### 2.6 弹层与其他

| 旧入口 | 旧函数 | 新入口 |
|---|---|---|
| `#shortcutModal` | `closeModal()` | 帮助 › 键盘快捷键，内容重写为完整映射表 |
| `#projectCreateModal` | `showCreateProject` / `createProjectFromForm` / `closeCreateProject` | 文件 › 新建项目…，仍用原弹层 |
| `#importProgress*` | `pickToolchain` / `hideImportProgress` / `dismissImportProgress` / `startImportWatchdog` | 原样保留，菜单项触发 |
| `📥 stdin` 折叠头 | `toggleStdin()` | 视图 › 标准输入 `Ctrl+I` ＋ 抽屉头 |
| `#projectResize` `#resizeHandle` | `initResize()` | 网格把手（`.vsplit` / `.hsplit`） |
| `initTabletUX()` | — | 复核窄屏覆盖层行为 |
| — | — | **新增：命令面板 `Ctrl+Shift+P`、文件右键菜单、活动栏、快捷键对话框** |

---

## 3. 键盘映射表

### 3.1 旧版已有（必须保留，行为不变）

| 键 | 旧行为 | 新位置 |
|---|---|---|
| `Ctrl+Enter` | `runCode()` | 运行 › 运行当前文件 ＋ 顶栏运行按钮 |
| `Ctrl+S` | `saveProjectToDisk()` | 文件 › 保存项目到目录 ＋ 状态栏 |
| `Ctrl+L` | 清空输出 + `clearDebugPanel()` | 运行 › 清空控制台 |
| `Ctrl+I` | `toggleStdin()` | 视图 › 标准输入 |
| `Esc` | `closeTopOverlay()` | 关闭最上层浮层（菜单 → 命令面板 → 对话框 → 右键菜单，按 z 序） |

### 3.2 新版新增

| 键 | 命令 | 说明 |
|---|---|---|
| `Ctrl+Shift+P` | 命令面板 | 38 条命令全量可搜 |
| `Ctrl+N` | 新建文件 | 替代面板头 `＋` |
| `Ctrl+Shift+N` | 新建项目 | 替代面板头 `New` |
| `Ctrl+O` | 打开项目 | 替代面板头 `Open` |
| `Ctrl+W` | 关闭文件 | 标签页 × |
| `F2` | 重命名当前文件 | **新版新增能力** |
| `Delete` | 删除当前文件 | 替代面板头 `−`，带确认 |
| `Ctrl+B` | 资源管理器 | 合并顶栏 `Files` 与面板头 `‹` |
| `Ctrl+J` | 底部面板 | — |
| `Ctrl+,` | 设置 | 替代 `⚙` |
| `F5` | 开始调试 | 替代顶栏 `Debug` |
| `F9` | 切换断点 | — |
| `F10` | 下一断点 | — |
| `Ctrl+Shift+B` | 以任务方式运行 | 写入「任务」视图 |
| `Ctrl+Shift+F` | 项目内搜索 | 活动栏第 2 格 |
| `Ctrl+Shift+D` | 运行和调试 | 活动栏第 4 格 |
| `Ctrl+Space` | 代码补全 | **补上旧版缺失的绑定** |
| `Ctrl+=` / `Ctrl+-` | 增/减编辑器字号 | 替代设置面板里的数字框 |
| `Esc` | 取消执行（无浮层时） | — |

### 3.3 交给 CodeMirror，不要重复绑定

`Ctrl+Z` / `Ctrl+Shift+Z`（撤销重做）、`Ctrl+F` / `Ctrl+H`（查找替换）、`Ctrl+A`、`Ctrl+C/V/X`、
`Tab` / `Shift+Tab`（缩进）、`Ctrl+/`（注释）。

> 新版 `initKeybindings()` 必须在 CodeMirror 初始化**之后**注册，或在处理前检查
> `document.activeElement` 是否落在编辑器内，否则会抢走编辑器的撤销。

---

## 4. 需要改动的函数

### 4.1 保持原样（18 个，只换触发方式）

```
runCode            debugCode            cancelExecution
newProjectFile     deleteProjectFile    renameProject
showCreateProject  createProjectFromForm closeCreateProject
openProject        saveProjectToDisk    persistProject / flushProjectSave / scheduleProjectSave
pickToolchain      pickDependencyPackage parseDependencyCoordinate
triggerCompletion  toggleStdin          toggleBreakpoint / debugNextBp / debugNav
getSetting / setSetting / saveSettings  applyCodeSize
renderProjectFiles requestExecution    lintDocument
jumpToDiagnostic   findDiagnosticFile   requestClangdDiagnostics
getSavedCode       saveCode             saveCurrentFile / saveCurrentLang
```

### 4.2 必须重构（9 个）

| 函数 | 现状 | 改法 |
|---|---|---|
| `switchOutputTab(tab)` | 5 个平级字符串分支 | 拆成 `switchPanelView(view)`（5 视图）与 `switchStream(stream)`（3 分段），两级状态互不干扰 |
| `initOutputPanel()` | 建 5 个平级 tab | 改 `initPanel()`：建 5 个面板视图 tab ＋ 输出视图内 1 条 `streamBar` |
| `renderOutput()` | 渲染单个 `#outputContent` | 改 `renderStream(stream)`，按当前流取数据桶 |
| `appendOutputText()` / `appendBoundedOutput()` | 写进全局 `outputData` 字符串 | 必须按 `stdout / stderr / info` 分桶写入，切流时各自保留滚动位置与历史 |
| `updateStderrCount()` | 更新 stderr tab 上的 `#stderrCount` | 改更新「问题」面板视图的角标；`stderr` 分段上的角标改为「本次运行的新增条数」 |
| `renderTaskList()` / `pollTask()` | 渲染到 `#taskList`，藏在一个 tab 里 | 直接渲染到「任务」视图；`runAsTask()` 成功后自动切到该视图 |
| `renderDebugPanel()` / `clearDebugPanel()` / `parseDebugOutput()` | 渲染到 debug tab | 改渲染到「调试控制台」视图；`debugCode()` 启动后自动切过去 |
| `toggleProjectPanel()` | `classList.toggle('show')` | 改 `setExplorerVisible(bool)`：同时同步活动栏选中态、`Ctrl+B` 勾选态、面板头图标态，并把结果写进 `setSetting('explorerVisible')` |
| `closeTopOverlay()` | 单一遮罩栈 | 支持四种浮层（菜单 / 命令面板 / 对话框 / 右键菜单）按 z 序关闭，`Esc` 只关最上层 |

### 4.3 新增（4 个）

| 函数 | 用途 | 复用旧有逻辑 |
|---|---|---|
| `openCommandPalette()` | `Ctrl+Shift+P` 全量命令搜索 | 数据源复用菜单模型，新旧共用一份命令表 |
| `renameProjectFile()` | `F2` / 右键重命名 | 与 `renameProject()` 共用校验、提示与 `persistProject()` |
| `openProjectFileContextMenu()` | 文件树右键 | 复用 `newProjectFile` / `deleteProjectFile` / `renameProjectFile` |
| `renderProjectTree()` | 支持未保存圆点、右键、选中态 | 基于 `renderProjectFiles()` 改，不重写 |

### 4.4 顺手修掉的旧问题

1. `补全` 按钮 `title` 声明 `Ctrl+Space` 但 `initKeybindings()` 未绑定 → 补上。
2. `renderOutput()` 的 `outputRenderState` 只记住**最后一个**流，追加优化也以 `outputData` 对象身份为条件；来回切流时会整块重写 `#outputContent`，滚动位置被重置。新版每个流各存一份 `{ content, scrollTop, atBottom }`。
3. `project-head` 上 3 个入口挤在 264px 内，窄屏会截断 → 新版图标 + 完整 `title` + 菜单兜底。
4. `⚙` `📥` emoji 图标 → 1.6 描边 SVG。
5. 输出区没有「问题」概念，编译诊断混在 stderr 字符串里 → 新增问题视图，条目可点击跳行。

---

## 5. DOM id 迁移表

| 旧 id | 新状态 |
|---|---|
| `#projectToggle` `#projectName` `#projectList` | 保留在资源管理器内 |
| `#langTabs` | 保留在编辑器标签栏 |
| `#codeEditor` `#editorEmpty` | 保留（CodeMirror 挂载点） |
| `#completeBtn` | **废弃**（并入编辑菜单 + `Ctrl+Space`） |
| `#stdinHeader` `#stdinInput` | 保留在 stdin 抽屉 |
| `#outputPanel` `#outputContent` `#outputMeta` `#statusDot` | 拆分到面板视图容器，废弃单一流水线 |
| `#outputContent` | 改为「输出」视图内的 `#streamBody` |
| `#stderrCount` `#debugCount` | 迁到面板视图 tab 的角标 |
| `#taskList` | 迁到「任务」视图内 |
| `#settingsPanel` 及其 7 个 input | 改为对话框内同名字段，id 不变以便 `getElementById` 逻辑平移 |
| `#projectResize` `#resizeHandle` | 废弃，改为 `.vsplit` / `.hsplit`（保留 `initResize()` 的指针捕获逻辑） |
| `#shortcutModal` | 内容重写，触发方式改为帮助菜单 |
| `#toast` | 保留 |

---

## 6. 落地批次

**批次 1 · 骨架（零行为变化）**
加菜单栏与活动栏 → 工作台改网格 → 旧 11 个按钮逐个接到菜单项上 → 旧按钮全部删除。
验收：老用户用鼠标能摸到每一个旧功能；功能行为与迁移前逐条一致。

**批次 2 · 面板重构**
`switchOutputTab` 拆两级 → 输出分桶 → 调试控制台 / 任务提为一级视图 → 新增问题视图。
验收：`Ctrl+L` 仍能一次清空全部流；`pollTask` 的进度不再被 stdout 淹没。

**批次 3 · 新增能力**
命令面板 → 重命名文件 → 文件右键菜单 → 未保存圆点 → 快捷键对话框 → 补上 `Ctrl+Space`。
验收：38 条命令全部可达；新绑的键与 CodeMirror 无冲突。

**批次 4 · 响应式与无障碍**
窄屏资源管理器覆盖层 → 全部可聚焦元素补 `:focus-visible` → 触控目标 ≥44px → `prefers-reduced-motion`。
验收：375px 宽无横向滚动；触屏下菜单项与树行高度达标。

---

## 7. 风险清单

| 风险 | 说明 | 对策 |
|---|---|---|
| **快捷键与 CodeMirror 抢键** | 新增 20 组键，`Ctrl+F/Ctrl+H/Ctrl+Z` 属编辑器 | 键盘处理统一收口到 `initKeybindings()`，先判断焦点是否在编辑器内 |
| **`Ctrl+I` 语义冲突** | 旧版已占用；部分输入法用 `Ctrl+I` 切中英文 | 保留旧语义不动，另在设置里给出关闭项 |
| **输出分桶丢历史** | 旧版 `outputData` 是单个对象 | 分桶时把迁移前未落盘的尾部字符串并入对应桶 |
| **状态胶囊与 `#statusDot` 双源** | 同一状态两处渲染 | 统一到 `setRunButtonState()`，胶囊读它，不再单独维护 |
| **`renameProjectFile` 跨目录** | 旧版文件树只有一层 | 先限定同目录重命名，跨目录另开需求 |
| **持久化 schema 变化** | 新增 `explorerVisible` / `panelVisible` 等 | 走既有 `getSetting/setSetting`，旧 key 不删，避免回退丢配置 |

---

## 8. 验收清单

- [ ] 旧版 11 个散点入口全部有对应菜单项，且行为逐条一致
- [ ] `Ctrl+Enter` / `Ctrl+S` / `Ctrl+L` / `Ctrl+I` / `Esc` 五组旧键行为不变
- [ ] 命令面板能搜到全部 38 条命令
- [ ] 补全的 `Ctrl+Space` 真正生效（旧版缺失）
- [ ] 输出三级切换（面板视图 → 分段）互不串流
- [ ] 问题面板条目点击能跳到对应文件对应行
- [ ] 未保存文件在标签页与文件树都有标记
- [ ] 375px 宽无横向滚动；触控目标 ≥44px
- [ ] 所有浮层 `Esc` 逐层关闭，`Tab` 焦点不逃出对话框
- [ ] 全部颜色取自 `brand-spec.md` 六个令牌，无新增十六进制值
