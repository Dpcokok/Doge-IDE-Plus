# 保存生成副本修复报告

日期：2026-10-07（Asia/Shanghai）

## 现象

编辑并保存 `main.py` 后，目录中出现 `main.py.txt`、`main.py (1).txt` 等文件，原来的 `main.py` 没有被覆盖。C/C++、JSON 等带扩展名的项目文件也可能出现同样问题。

## 根因

Android 的 SAF 文件提供器在 `DocumentsContract.createDocument()` 收到 `text/plain` 和 `main.py` 这类扩展名不匹配的参数时，会把文件名改成 `main.py.txt`。IDE 后续仍按 `main.py` 查询，查询不到就再次创建文件，形成副本。

## 修复

- 按文件扩展名选择 MIME 类型，源码、头文件和常见数据文件不再统一使用 `text/plain`。
- 创建后核验提供器返回的显示名称；提供器改名时调用 `renameDocument()` 恢复原文件名。
- 提供器无法保留原文件名时删除刚创建的文件并报告保存失败，避免静默产生副本。
- 保存回滚按实际创建的文档 URI 删除，避免同名副本导致回滚删错文件。
- 目录查询返回空结果时视为查询失败，取消保存，避免把已有文件误判为不存在。

旧目录中的副本不会自动删除，避免误删其中可能保留的代码；确认内容后可手动清理。

## 验证

- 保存专项回归：37 项通过，覆盖 Python、C、C++、头文件、JSON、CSV、Markdown、TXT、大小写扩展名、重复保存、重新打开、重命名失败、目录查询失败和部分保存回滚。
- 完整 JVM 运行时回归：127 项通过；API 兼容回归：30 项通过。
- 前端基线：590 项通过；符号与括号浏览器专项：87 项通过；Python 编辑/保存浏览器专项：27 项通过。
- Android `:app:assembleDebug` 与 `:app:lintDebug` 通过，lint 0 errors。
- 测试 APK：`android/app/build/outputs/apk/debug/app-debug.apk`
- SHA-256：`747DED0516100AB53D31C2E19E33CE82E33C116DB8F8C9DC0D2EF953698632E6`

当前没有连接 Android 真机，因此尚未在平板的实际 SAF 提供器上覆盖安装验收；本地回归使用了模拟 SAF 边界并复现了修复前的 `main.py.txt` / `main.py (1).txt` 行为。
