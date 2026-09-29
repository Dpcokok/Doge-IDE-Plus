# Doge IDE+ 1.0.2 功能入口基线

采集日期：2026-09-28
采集设备：Lenovo `TB376FC`（序列号 `HA2K9X7F`），横屏全屏，Chrome WebView 140
采集方式：`adb shell uiautomator dump` + `screencap`（同目录 `ui-dump-landscape.xml`、`ui-visible-labels.txt`、`screenshot-landscape.png`）

用途：作为 1.0.2 → 1.1.0 前端重构的基线。重构每个批次结束后，下面每一个入口都必须在新界面能找到、且行为一致。

## 顶栏（`.header`）

| 入口 | 触发函数 | 备注 |
|---|---|---|
| Files 按钮 | `toggleProjectPanel()` | 与项目面板头 `‹` 同功能 |
| 导入运行库 按钮 | `pickToolchain()` | 常驻按钮 |
| ⚙ 设置 | `toggleSettings()` | 右侧滑出面板 |
| Run 按钮 | `runCode()` | 运行中变“停止”，可点击 |
| Debug 按钮 | `debugCode()` | 标记 `hidden`，当前不显示 |
| Ctrl+Enter 运行 提示文字 | — | 纯文字 |

## 项目面板头（`.project-head`）

| 入口 | 触发函数 |
|---|---|
| 项目名（可点击重命名） | `renameProject()` |
| New | `showCreateProject()` |
| Open | `openProject()` |
| Save | `saveProjectToDisk()` |
| ＋ | `newProjectFile()` |
| −（危险色） | `deleteProjectFile()` |
| ‹ | `toggleProjectPanel()` |

## 编辑器工具条（`.editor-tools`）

| 入口 | 触发函数 |
|---|---|
| 补全 按钮 `#completeBtn` | `triggerCompletion()` |

## 输出面板（`.output-panel`）5 个平级标签

| 标签 | 触发 |
|---|---|
| stdout | `switchOutputTab('stdout')` |
| stderr（带计数角标） | `switchOutputTab('stderr')` |
| info | `switchOutputTab('info')` |
| Tasks | `switchOutputTab('tasks')` |
| debug | `switchOutputTab('debug')`（`hidden`） |

## 设置面板（`#settingsPanel`）

Timeout `#timeoutInput` / 导入资源包 `pickToolchain()` / 编辑器字号 `#codeSizeInput` / 构建档 `#optimizationInput` / 宏 `#definesInput` / include `#includesInput` / 链接库 `#librariesInput` / 依赖记录 `#dependenciesInput` / 导入离线依赖包 `pickDependencyPackage()` / Cancel `toggleSettings()` / Save `saveSettings()`

## 弹层与其他

| 入口 | 触发 |
|---|---|
| 快捷键弹窗 | `#shortcutModal` / `closeModal()` |
| 新建项目弹层 | `showCreateProject` / `createProjectFromForm` / `closeCreateProject` |
| 导入进度遮罩 | `pickToolchain` / `dismissImportProgress` / `startImportWatchdog` |
| stdin 折叠头 | `toggleStdin()` |
| 项目面板拖拽 | `initResize()` / `initProjectLayout()` |

## 快捷键（`initKeybindings()`）

`Ctrl+Enter` 运行 · `Ctrl+S` 保存 · `Ctrl+L` 清空输出 · `Ctrl+I` 切换 stdin · `Esc` 关闭最上层浮层 / 运行中取消。
编辑器内（CodeMirror `extraKeys`）：`Ctrl+Space` 补全（仅编辑器有焦点时）。

## 桥接接口（DogeNative.* ↔ Java @JavascriptInterface）

前端调用：`createProject` `isToolchainReady` `openProject` `pickDependency` `pickToolchain` `reportSoftwareError` `saveProject`
Java 额外提供（前端暂未全用）：`hasProjectWorkspace` `listDependencies` `removeDependency`
原生 → 前端回调：`projectOpened` `projectSaveResult` `projectError` `toolchainImported` `toolchainProgress` `dependencyImported`

以上契约由 `test/frontend-baseline.mjs` 的 bridge / callback 断言守护。

## localStorage 键

`doge-ide-project-v1`（项目草稿）· `doge-ide-last-lang` · `doge-ide-breakpoints` · `doge-ide-project-width` · `doge-ide-project-collapsed` · `doge-ide-timeout` · `doge-ide-codeSize`

重构新增键统一加 `doge-ide-` 前缀，旧键保留不动（回退不丢配置）。

## 采集到的可见文本（去重）

见同目录 `ui-visible-labels.txt`（32 条）。
