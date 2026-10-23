# Android 外接键盘输入恢复

日期：2026-10-11（Asia/Shanghai）

## 复现和原因

用户确认故障发生在 Android 平板外接键盘上。目前没有连接的平板，尚未取得设备发生故障时的输入事件。

在真实 Edge 中切换为 Android user agent，并重放窗口失焦、恢复焦点事件：隐藏 textarea 始终是 `document.activeElement`，但 CodeMirror 的窗口失焦处理把 `editor.state.focused` 置为 false。窗口恢复没有触发新的 textarea focus，CodeMirror 也没有窗口 focus 恢复处理。

此时通过 CDP 连续发送真实 keydown/char/keyup，textarea 收到 `xy`，文档仍为 `keep`。组字、只读、disableInput、快捷键序列、上下文菜单和重置状态均没有阻断输入；单独结束组字不能恢复。通过 textarea 的 focus 事件调用 CodeMirror 自身处理后，文档正常成为 `keepxy`。

这复现了“输入无反应”的一种具体路径；尚不能确认用户设备上的所有输入卡住都来自这个路径。

## 修复

- 窗口恢复或页面重新可见时，仅在 textarea 仍是当前焦点、CodeMirror 内部却未聚焦时恢复其 focus 处理，重启输入轮询和光标状态。
- 若 WebView 没有先发送窗口 focus，首次 keydown、beforeinput 或 input 也能恢复。input 已到达时保留原生文字、输入差分基线和原生选区，避免丢失第一批文字或重复插入。
- 窗口失焦和页面隐藏时结束旧组字；窗口 blur 使用捕获阶段，在 CodeMirror 清除聚焦状态前保存组字文字。
- 恢复不改变文档选区和撤销历史；搜索框、弹窗及只读文档保留原本行为。
- 批次验证脚本加入 Android user agent 的输入回归。

## 验证

- 修复前新增的两个焦点恢复断言失败：文档仍为 `keep`，内部焦点状态为 false。
- `node test/browser-smoke-input.mjs --android`：66 项通过。
- `node test/browser-smoke-input.mjs`：66 项通过。
- 前端基线：590 项通过；弹窗和快捷键：66 项通过；符号和括号：87 项通过。
- 完整补全测试：68 个断言通过，随后 `Input.dispatchTouchEvent` 通信超时，整套未通过。此前 `EDITOR-INPUT-FIX-2026-10-07.md` 也记录了同一测试超时。
- 内联 JavaScript、输入测试和批次验证 PowerShell 语法检查及 `git diff --check` 通过。
- Android `assembleDebug` 和 `lintDebug` 通过；lint 0 errors / 11 warnings。
- APK 内 `assets/index.html` 的 SHA-256 与当前 `doge-ide.html` 完全一致。
- 临时诊断脚本已删除。

APK：`android/app/build/outputs/apk/debug/app-debug.apk`，1,321,606 字节；版本仍为 `1.1.2-debug`，本次未更改版本号。

SHA-256：`D01BFC1144362B8178378EBE779742969609E9792540BD2CE24FB985E8FEB935`。

`adb devices` 没有设备，未进行真机安装与外接键盘验收。设备验收应覆盖切回应用、切换中英文、补全、选区替换、切文件和撤销，并检查是否丢失或重复字符。

预防措施：保留窗口焦点事件的回归场景，核对 DOM 焦点与编辑器输入轮询状态的一致性；普通 textarea 失焦测试无法覆盖这一场景。
