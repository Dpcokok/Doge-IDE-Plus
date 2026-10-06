# `.doge-project.json` 误作为项目文件

日期：2026-10-06（Asia/Shanghai）
状态：已修复，待设备覆盖安装验证。

## 现象

打开之前创建的 Python 项目后，运行终端显示：

```text
项目文件路径无效: .doge-project.json
[程序结束：invalid_request，退出码 -1]
```

C/C++ 项目有时也会出现相同问题。

## 根因

项目目录扫描原本只识别 C/C++ 文件；支持 `.json` 数据文件后，
`MainActivity.isSourceFile()` 将应用自己的 `.doge-project.json` 也放进了 `project.files`。
此外，旧版本写入 `localStorage` 的草稿可能已经包含该清单。运行器出于安全原因拒绝
点号开头的项目路径，于是打开项目成功、运行阶段失败。

## 修复

- 新增 `ProjectFiles.isInternalManifestPath()`，大小写不敏感识别根目录或子目录中的
  `.doge-project.json`，同时继续拒绝绝对路径和 `..` 穿越路径。
- Android SAF 扫描排除内部清单；读取清单仍由 `readManifest()` 专门处理。
- Android 保存忽略内部清单条目，不覆盖或删除应用管理的清单。
- `LocalCompiler` 和 `PythonRunner` 兼容旧请求：即使旧客户端仍把内部清单带入，
  也会跳过它，不影响普通 `config.json`、`data.csv` 等用户数据文件。
- 前端 `loadProject()` / `projectOpened()` 清理旧 localStorage 和重开项目数据，并立即
  把清理后的草稿写回；C、C++、Python 共用同一规则。

## 验证

- JVM manifest 回归：14 项通过。覆盖 Python、C、C++ 旧请求，扫描策略、大小写变体、
  嵌套路径、普通 JSON 保留和路径穿越拒绝。
- 前端基线：574 项通过。
- Android debug APK：构建通过；lint `0 errors / 11 warnings`。
- 目标设备未连接，尚未完成真实 SAF 目录重新打开和覆盖安装运行验证。

测试 APK：`android/app/build/outputs/apk/debug/app-debug.apk`
