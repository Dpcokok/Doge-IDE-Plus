# 编辑器输入阻断修复

日期：2026-10-07（Asia/Shanghai）

## 已复现问题

1. CodeMirror 的隐藏 textarea 存在原生选区，但文档没有选区、`prevInput` 为空时，`TextareaInput.poll()` 会跳过读取。连续模拟三次已提交输入，焦点保持在编辑器、文件不是只读，源码仍为空。
2. 组字期间直接切换文件，CodeMirror 的组字标记仍属于旧文档，并没有在切换时结束。
3. 在编辑器打开命令面板后按 Esc 关闭，焦点落到 body，接着输入文字不会进入编辑器。

上述三个问题在真实 Edge/CodeMirror 中复现。它们可能解释用户的输入卡住现象，但尚未取得发生故障时的 Android 输入法和 WebView 状态，不能断言所有设备侧卡住都由这些条件造成。

## 修改

- 已提交的非组字输入被隐藏选区阻断时，收起隐藏选区并交给 CodeMirror 原来的读取方法处理。正常组字、文档选区、只读状态和原生上下文菜单不走该恢复逻辑。
- 编辑器失焦或切换文档前，通过 CodeMirror 自身的 compositionend 处理结束旧组字；保留当前文字和文档撤销历史。
- 括号与 Tab 的延迟操作核对文档和焦点，旧文档的输入处理不再作用于新文件。
- 输入法一次提交“末尾字母 + Tab”时，通过 beforeChange 更新本次输入，先保存字母，再异步接受补全，避免焦点变化时丢字。
- 关闭命令面板后恢复原控件焦点，支持编辑器和搜索框。

没有重新创建编辑器、清空代码或增加周期性强制重置。

## 验证

- 新增 `test/browser-smoke-input.mjs`：修复前 5 个断言失败；修复后扩展为 46 项通过。包括残留原生选区、组字中断、反复切文件、Unicode、普通选区替换、只读恢复、括号、Tab、补全和焦点恢复。
- 前端基线 590 项；工作台 66 项；平板布局 83 项；符号/括号 87 项；Python 编辑/保存 27 项；交互终端 23 项通过。
- 原有补全浏览器测试 68 项通过，末尾 `Input.dispatchTouchEvent` 通信超时，整套未通过。前一次编辑器功能验证已有同类超时记录，未关闭或忽略该用例。
- 内联 JavaScript 语法检查、`git diff --check` 通过。
- Android debug APK 构建和 lint 通过；lint 0 errors / 11 warnings。

APK：`android/app/build/outputs/apk/debug/app-debug.apk`，包含此前的保存副本修复。

SHA-256：`6ACB4533646AAE542A7FF48750D8D5CB963C1F6091A8157CC41F938B7DD50B02`。

当前 `adb devices` 没有设备，未做真机覆盖安装和具体输入法验收。浏览器原生 IME 模拟与 textarea 边界测试不能替代平板实际输入法验证。
