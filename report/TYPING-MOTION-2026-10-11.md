# 平滑打字光标

日期：2026-10-11（Asia/Shanghai）

## 参考与行为

参考：https://uapis.cn/tools/run-cpp

已在浏览器中实际输入并检查该页面：编辑器使用独立的平滑光标，位移过渡为 80ms、`cubic-bezier(.25,.1,.25,1)`，高度过渡为 80ms。当前页面的文字没有字符弹跳动画。此次匹配的是该页面实际使用的平滑光标效果。

- 打字、方向键和鼠标定位时，光标平滑跟随文字位置。
- 滚动、切换文件、字号和布局变化时直接对齐，避免光标跨视口滑动。
- 有文字选区或多个光标时使用 CodeMirror 原生显示；对话框、搜索框获得焦点时隐藏编辑器动画光标。
- 系统要求减少动态效果时自动使用原生光标；恢复系统设置后自动恢复动画。
- 设置 → 编辑 → 平滑打字光标，默认开启，保存后立即生效并持久化。

动画只更新独立光标元素的位置，不改写文档、组字状态、输入框和撤销历史。所有坐标由现有 CodeMirror 计算，沿用项目字体和主题。

## 验证与构建

- 新增 `test/browser-smoke-motion.mjs`：桌面与 Android user agent 各 37 项通过，验证实际 CSS 过渡、最终位置、宽字符、选区替换、撤销、多光标、滚动、字号、减少动态效果、设置持久化和窗口恢复。
- 此前的 Android 输入恢复回归：66 项通过。
- 前端基线：590 项通过；弹窗和快捷键：66 项通过。
- JavaScript 和 PowerShell 语法检查、`git diff --check` 通过。
- `assembleDebug`、`lintDebug` 通过；lint 0 errors / 11 warnings。
- 浏览器截图已检查；APK 中 `assets/index.html` 与当前源码的 SHA-256 一致。
- 本轮没有重跑完整补全测试；上一轮触控通信超时仍记录在输入修复报告中。

APK：`android/app/build/outputs/apk/debug/app-debug.apk`。

版本：`1.1.3-debug`，versionCode 7；包含同日的外接键盘输入恢复修复。

SHA-256：`3C16577B8916FE43CDB1B801CC5CE28CA8685C9EAD5BD6C49FCC5BD9A407F996`。

浏览器中的 Android 模拟不能替代真实平板与输入法验收，当前没有连接的 Android 设备。
