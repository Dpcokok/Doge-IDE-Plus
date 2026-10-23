# Backspace 后的 Android 原生输入连接同步

日期：2026-10-12（Asia/Shanghai）。

后续真实诊断揭示：搜狗用空 insertText 先删除选区，再发 Backspace，1.1.6 的同步识别遗漏此路径。已在 1.1.7 修复，见 `SOGOU-EMPTY-COMMIT-2026-10-12.md`。

## 用户反馈与验证边界

用户在 Android 平板、外接键盘、鼠标拖选、搜狗输入法下确认：1.1.5 选择多个字符后按 Backspace 仍然无法输入。

之前的 Edge/CDP 检查继续把文字送到网页，覆盖了网页内部状态，却无法验证搜狗在实际 WebView 上是否还继续送出输入。当前没有连接的平板，不能宣称已经复现或最终解决这个设备故障。

本轮优先处理“网页删除选区并重置 textarea 后，输入法仍持有旧原生选区/连接”的可能路径。新增测试明确模拟原生连接停止投递 DOM 事件，直到应用请求重新同步；这是连接调用边界的回归，不是实际搜狗输入法的实现。

## 改动

- 选区删除和空符号对删除完成后，请求 Android InputMethodManager.restartInput(WebView)，重新建立真实 InputConnection。覆盖 CodeMirror 处理 Backspace/Delete 的路径，也覆盖输入法直接发送 delete 类型事件、没有网页 keydown 的路径。
- 普通单字符 Backspace、只读文档不触发重建。同步前在网页重新核对请求 ID、文件、文档版本、选区、焦点和组字状态；新输入、新光标、新文件或弹窗令旧请求失效。
- 同步不重新创建 WebView 或编辑器，不清空文档、不改变源码。保持现有网页输入恢复逻辑。
- 新增 EditorWebView，透传 InputConnection 方法的参数、返回值和硬件按键，保留最近 100 条原生输入事件元数据。网页同样保留最近 100 条状态记录。
- 帮助 → 输入诊断 → 复制诊断：包含版本、WebView/Android/输入法信息、原生连接事件以及网页输入状态。不记录源码、项目名称、文件路径、候选文字或实际输入文字；记录只存在内存，复制由用户主动操作。
- 编辑 → 恢复编辑器输入：手动重新同步焦点、网页输入缓冲和 Android 输入连接。

## 验证

- 新增 Android 原生同步浏览器测试：修复前选区/空对删除不请求连接重建，模拟连接停止投递后文档无法继续输入；修复后 30 项通过，包含无 keydown 的输入法删除、迟到请求、诊断无源码、手动恢复与弹窗焦点。
- 生产 EditorWebView 的 JVM 边界检查 21 项通过：方法参数与返回值透传、失败不被掩盖、原始 key event 对象保持、焦点保护、诊断不含文字及有界事件历史。
- Android 选区输入 121 项、原有输入 66 项、符号/删除输入 347 项、动画 37 项、补全选择 29 项、完整补全 70 项、工作台 66 项通过。
- 前端基线 596 项通过；JavaScript/PowerShell 语法和 git diff --check 通过。
- assembleDebug、lintDebug 通过，lint 0 errors / 11 warnings。APK assets/index.html 与当前源码 SHA-256 一致。

这些检查证明连接同步调用、状态保护和事件记录按设计工作，不能代替实际搜狗与 Android WebView 的验收。

## APK

路径：android/app/build/outputs/apk/debug/app-debug.apk。

版本：1.1.6-debug，versionCode 10。

大小：1,285,730 字节。

SHA-256：FBDBBF8DD46840727B0C8A7CE7511A178769E96B4648762E6D218349FDE74E2E。

## 真机验收与后续定位

覆盖安装后，鼠标选中多个字符，按 Backspace，再输入两三个字符。检查原文删除正确、后续字符保留、撤销历史正常，重复几次。

如果仍无法输入，先打开“帮助 → 输入诊断”，复制记录后再尝试“编辑 → 恢复编辑器输入”。不要先重启应用：重启会清空这次的内存事件记录。

对比原生 hardware-key/ime-key/commit-text/compose-text 与网页 keydown/input，可区分输入连接不再投递、焦点离开、网页收到文字却没有写入文档三种故障。
