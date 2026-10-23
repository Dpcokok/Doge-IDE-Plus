# 搜狗空提交删除选区：真实诊断与修复

日期：2026-10-12（Asia/Shanghai）。

## 设备日志提供的证据

用户提交的 1.1.6 输入诊断：Android 16 / API 36，WebView 140.0.7339.207，搜狗 com.sohu.inputmethod.sogou/.SogouIME。

关键事件（网页时间，UTC）：

- 08:44:56.729：文档选区为第 0 行 [0,18]，textarea 长度 18，原生选区 [0,18]；网页收到 beforeinput，inputType 为 insertText。
- 08:44:56.732–.734：搜狗 commitText 长度为 0；文档 change origin 为 +input，选区被清空、光标到 0，textarea 长度变为 0。网页 inputType 仍为 insertText。
- 08:44:56.740：才收到 Backspace，此时已经没有选区；该按键在文档开头没有再次删字。
- 随后 8 次 commitText 长度为 1、返回 true，原生焦点正常；网页只有 keydown/keyup，没有 beforeinput/input，textarea 和已读基线都保持 0。
- 这段日志没有 native-sync 请求，也没有 restart-input 事件。

因此，故障日志支持“原生层继续收到提交，但 WebView 没有产生文字输入事件”。不是 CodeMirror 收到文字后只读/组字/焦点状态阻断。捕获时的失焦发生在打开诊断前，故障期间 focus 和 active 均为 true。

1.1.6 只识别 Backspace 对选区的删除，或 inputType 为 delete 的原生删除。搜狗先用空 insertText 删除，随后 Backspace 到来时选区已空，两条识别都错过。

## 修复

- beforeinput/input 阶段识别非组字的空 insertText/insertReplacementText 删除选区，覆盖 data 为空字符串及 input.value 为空但 data 缺失的情况。
- 删除完成后复用 Android 输入连接同步路径，直接请求重建真实 InputConnection。
- 同步选区保护改为比较实际 anchor/head 坐标。文档开头的无操作 Backspace 会换掉 CodeMirror 选区对象，即使坐标未变；旧对象身份比较会错误取消同步。
- 若后续 Backspace 确实再删掉一个字符，刷新待同步请求；新文字、新光标、换文件和弹窗仍使旧请求失效。
- keyup/input 后清理没有产生 changes 的删除标记，避免其误作用于下一次中文组字。无 Android 桥接时不执行原生同步专用的缓冲重置。
- 正常非空替换、未提交组字、单字符退格和只读文档保持原规则。
- 输入诊断补充 event.data 的长度与本次插入/删除长度，仍不记录文字内容。

## 回归

按真实事件顺序重放：选中 18 字符 → beforeinput insertText(data='') → textarea 清空 → input insertText → Backspace → 原生后续文字停止投递。修复前新增 5 个断言失败；修复后连接同步发生且模拟投递恢复。

- Android 原生同步回归：43 项通过，含真实日志顺序、空 input-only 提交、无操作 Backspace、普通替换、组字保护与旧标记清理。
- Android 选区输入：121 项通过；连续组字中发现旧删除标记可能影响后续输入，清理后回归通过。
- 原有 Android 输入：66 项；补全选择：29 项；完整补全：70 项通过。
- 前端基线：596 项；InputConnection JVM 透传边界：21 项通过。
- JS 语法、git diff --check、assembleDebug、lintDebug 通过；lint 0 errors / 11 warnings。
- APK assets/index.html 与当前源码 SHA-256 一致。

## 产物与限制

APK：android/app/build/outputs/apk/debug/app-debug.apk。

版本：1.1.7-debug，versionCode 11；大小 1,286,499 字节。

SHA-256：D45F81BF45E910FB5BF3F1369F176F1C766E9FC4FC691767AA1A5B4FB5D8B15F。

此次修复对应用户设备日志的明确识别缺口，回归重放证明同步不再遗漏。仍未在实际搜狗/WebView 140 的平板覆盖安装验收；若继续卡住，保留诊断可检查是否已有 native-sync-request、native-sync-confirm、restart-input 和新的 create-connection。
