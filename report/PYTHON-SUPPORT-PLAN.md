# Doge IDE+ Python 支持规划

日期：2026-10-02
状态：规划，待确认 §8 的几项取舍后开工。

## 1. 目标

在平板上像写 C/C++ 一样写 Python：新建 Python 项目、编辑、离线运行、看输出和报错。和 C/C++ 一样遵循 **本地运行就绪**：导入资源后不依赖网络。

首版不做：交互式终端、pip 联网安装、调试器、科学计算库（numpy 等需要原生扩展）。

## 2. 现状（已核实）

**运行侧（Android）**

- C/C++：`LocalCompiler` 用资源包里的 clang 编译成 WASM，再交给 `NativeWasmRunner`（WAMR，**只有解释器，没有 AOT / JIT**；WASI 不预开任何目录；堆 8 MB）运行。
- 资源包导入 `MainActivity.installToolchain`：只认 `manifest.json` 里的 `clang` + `sysroot`，解压到 `files/toolchain/`，上限 1 GB。
- `targetSdk 28`，所以可以从 `files/` 下直接执行二进制（clang、clangd 现在就是这样跑的）。
- 语言门槛：`LocalCompiler.java:58`「仅支持 C 和 C++」；`MainActivity` 新建项目（369–374）、项目清单（548）、可打开/保存的文件扩展名 `isSourceFile`（658）都只认 C/C++。
- 设备：Lenovo TB376FC，arm64-v8a，Android 14+；App `minSdk 24`。

**前端**

- 所有逻辑按 `currentLang ∈ {c, cpp}` 写死，约 20 处 `project.language === 'cpp' ? … : 'c'`。
- 从云端版继承来的 Python 代码都还在，但全部走不到：`COMPLETE_WORDS.python`、`MODULE_MEMBERS.python`、`LINT_KNOWN.python`、`collectDefs` 的 Python 分支、调试用的 `buildPythonHarness`（`sys.settrace`）。
- `web/codemirror/mode/python/python.min.js` 在磁盘上，但页面没加载。

**官方 Python for Android（已下载核对）**

- python.org 提供官方 Android 包，CPython 3.13 起 Android 是 Tier 3 平台；当前稳定版 **3.14.8**（2026-09-30），`python-3.14.8-aarch64-linux-android.tar.gz` 22.9 MB，SHA-256 `11324313…EACF9A33`。
- 里面是 **可嵌入的** `libpython3.14.so`（5.8 MB）+ 标准库 + OpenSSL / SQLite 动态库，**没有 `python` 可执行文件**；官方做法是 App 自己 dlopen 并调用 `Py_InitializeFromConfig`。官方 testbed 的 `minSdk` 为 24，与本 App 一致。
- 在 Android 上，Python 会通过 `_android_support.init_streams` 把 `sys.stdout / sys.stderr` 重定向到 logcat，`sys.stdin` 恒为 EOF —— 直接嵌入的话看不到输出，必须自己处理（见 §3.2）。
- 去掉 `test`、`idlelib`、`tkinter`、`turtledemo`、`ensurepip`、`lib2to3`、`pydoc_data` 并预编译 `.pyc` 后：1200 个文件，解压 39.6 MB，**zip 14.1 MB**（实测）。

## 3. 运行方案

### 3.1 候选

| 方案 | 做法 | 速度 | 隔离 / 停止 | 结论 |
|---|---|---|---|---|
| A 原生子进程 | 自带一个小启动器（NDK 编译，链接 `libpython3.14.so`），像 clang 一样用 `ProcessBuilder` 启动 | 原生速度 | 独立进程，超时 / 停止直接杀进程；崩溃不影响 App | **推荐** |
| B 进程内嵌入 | JNI 里 dlopen libpython，在 App 进程里跑 | 原生速度 | `while True` 停不下来；`os._exit`、段错误会带崩整个 App；全局状态在多次运行间残留 | 不采用 |
| C CPython-WASI | 用官方 WASI 版 python.wasm 跑在现有 WAMR 里 | WAMR 只有解释器，等于“解释器里跑解释器”，预计慢 1～2 个数量级，启动也慢；还要给 WAMR 加目录预开、调大堆 | 与 C 同一沙箱 | 备选（只在 A 被设备拦截时考虑） |
| D Pyodide | WebView 里跑 WASM 版 Python | 中 | 卡 UI 线程、体积大、离线麻烦 | 不采用 |

### 3.2 方案 A 的细节

- **启动器** `doge-python`：几十行 C，`PyConfig_InitIsolatedConfig` → 设 `home` 指向资源目录 → `Py_InitializeFromConfig` → 运行引导脚本。用 NDK 27（`E:\androidSDK\ndk\27.2.12479018`，已在本机）交叉编译，`rpath` 指向自己的 `lib/`，不依赖 `LD_LIBRARY_PATH`。
- **输出走管道而不是 logcat**：引导脚本第一步用 `open(1, 'w', buffering=1, encoding='utf-8', errors='backslashreplace')` 等把 `sys.stdout / stderr / stdin` 换回真正的文件描述符 0/1/2。这样不管 `_android_support` 有没有生效，结果都一致。（P0 在真机确认）
- **引导脚本**（随资源包）：
  1. 先对项目里所有 `.py` 做 `compile()`，有语法错误就按固定格式写到 stderr 并以“编译错误”结束 —— 前端“问题”视图沿用现在的流程；
  2. 用 `runpy.run_path(entry, run_name='__main__')` 运行入口文件，`sys.path[0]` 设为项目目录，`sys.argv = [entry]`；
  3. 未捕获异常时打印 traceback，并去掉引导脚本自己的帧。
- **状态映射**（与 C 的接口一致，前端不用分支）：语法错误 → `compile_error`；退出码 0 → `success`；非 0 或异常 → `runtime_error`；超时 → `timeout`；取消 → `canceled`。stdout/stderr 沿用现有 2 MB 上限与增量轮询。
- **环境**：工作目录为本次运行的临时目录；`HOME`、`TMPDIR` 指向它；`PYTHONUNBUFFERED=1`、`PYTHONUTF8=1`、`PYTHONNOUSERSITE=1`、`PYTHONDONTWRITEBYTECODE=1`。

### 3.3 资源包

- 新的资源包 `doge-python-arm64-3.14.8.zip`（约 14 MB），和 C/C++ 资源包（235 MB）**分开导入、分开存放**：`files/python/`，互不覆盖。
- `manifest.json` 加 `kind` 字段：`"cpp-toolchain"`（旧包没有这个字段，按它处理）/ `"python"`。导入时按 `kind` 决定解压到哪里、校验什么（Python 包校验 `bin/doge-python`、`lib/libpython3.14.so`、标准库目录 + `sha256`）。
- 打包脚本放进仓库（`tools/build-python-runtime.ps1`）：下载官方包并核对 SHA-256 → 裁剪 → 用本机 Python 3.14 预编译 `.pyc` → NDK 编译启动器 → 生成 manifest 与校验和 → 打 zip。可重复构建。

## 4. 前端改动

1. **语言表驱动**：`LANGUAGES` 加 `python`（`mode: 'python'`、`version: 'Python 3.14'`、示例程序、`runtime: 'python'`，C/C++ 为 `runtime: 'cpp'`）；加载 `python.min.js`。把约 20 处 `=== 'cpp' ? … : 'c'` 收成 `projectLang()` 一个入口。
2. **文件与项目**：`validateFileName` / `languageForPath` / 新建文件默认名按语言（`main.py`）；新建项目对话框加“Python 3.14”，模板“空项目 / 示例”；`projectOpened` / `loadProject` 保留 `python`。
3. **运行库状态**：`toolchainReady()` 改为按当前项目语言判断对应资源包；菜单栏状态胶囊、帮助菜单分别显示“C/C++ 运行库”“Python 运行库”及导入入口。
4. **设置**：构建组（优化级别 / 宏 / include / 链接库）只在 C/C++ 项目显示；Python 项目显示运行相关的少量选项（首版只有超时）。
5. **补全与检查**：C 专用逻辑（`#include`、`->`、`::`、项目头文件、clangd）只在 C/C++ 启用；Python 用已有的关键字 / 内建 / 常用模块成员 / 文档标识符，补上 `import` 后的模块名补全；本地“未定义名”检查用已有的 Python 分支。
6. **问题视图**：新增纯函数解析 Python traceback（取项目文件里最内层的 `File "x.py", line N`）和 `SyntaxError`（文件、行、列）；点击跳转与 C 相同。
7. **文案**：标题、关于、提示里“C/C++”改为按语言显示；`CONTEXT.md` 的“本地运行就绪”定义从“C/C++ 代码”扩到“C/C++ 与 Python 代码”。

## 5. 原生侧改动

1. `TaskRegistry` / `/api/v1/execution/run`：按 `language` 分派到 `LocalCompiler`（c/cpp）或新的 `PythonRunner`（python）。取消、超时、输出上限复用同一套。
2. `PythonRunner`：写项目文件到临时目录 → 启动 `doge-python` → 管道读 stdout/stderr → 映射状态（§3.2）。
3. `MainActivity`：资源包按 `kind` 导入；新建 Python 项目模板；项目清单与可打开/保存的文件扩展名加 `.py`（以及 `.txt` / `.json` / `.csv` 这类程序会读的数据文件 —— 见 §8）；`isRuntimeReady(kind)`。
4. 桌面版 `main.go`：现在把运行请求转发到云端服务，不在本次范围；保持可编译即可。

## 6. 分阶段

| 阶段 | 内容 | 完成标准 |
|---|---|---|
| **P0 真机验证**（先做，约半天） | 编启动器 + 裁剪包，`adb push` 到 App 目录手动运行 | 真机上 `print`、读 stdin、异常 traceback、`import json/sqlite3/ssl` 都正常，输出走管道；记录冷启动耗时 |
| **P1 能跑起来** | 打包脚本、资源包导入、`PythonRunner`、任务分派、前端语言表 / 新建项目 / 运行 / 问题视图 | 新建 Python 项目 → 运行 → 看到输出；语法错误和运行时错误能在问题视图点到行 |
| **P2 编辑体验** | Python 补全（关键字 / 内建 / 模块 / 成员 / import）、本地检查、设置分语言、文案 | 补全与检查在 Python 项目里有用、在 C 项目里行为不变 |
| **P3 交互输入**（可选） | 运行中把 stdin 输入实时送进进程（`input()` 边运行边输入） | 需要改任务接口；C 的 WASM 运行器也可以同步支持 |
| **P4 包与语言服务**（可选） | 离线导入纯 Python 的 wheel（复用依赖包机制）；jedi + pyflakes 常驻进程做语义补全 / 跳转 / 诊断 | 单独规划 |

P1 + P2 合起来作为 **1.2.0**。

## 7. 测试

- **纯函数单测**（`frontend-baseline.mjs`）：语言表、文件名校验（`.py`）、traceback / SyntaxError 解析、Python 补全触发、引导脚本输出格式解析。
- **浏览器冒烟**：Python 项目的新建、编辑、补全、问题视图（运行接口用模拟，与 clangd 模拟同一方式）。
- **引导脚本**：在本机 Python 3.14.2 上直接跑（与设备同一个大版本），覆盖语法错误、异常、`sys.exit(n)`、stdin、大输出、编码。
- **真机**：P0 验证项 + 每阶段的冒烟（安装、导入资源包、运行示例、超时、停止）。
- **回归**：现有 515 项基线、三组浏览器冒烟、`batch-verify.ps1` 全部保持通过。

## 8. 需要你决定

1. **资源包怎么给**：
   - (a) **单独导入**（推荐，与 C/C++ 一致）：APK 保持约 1 MB，Python 包 14 MB 另外拷到平板导入；
   - (b) **打进 APK**：开箱即用，APK 变成约 15 MB，每次升级 App 都带着它。
2. **首版是否要“边运行边输入”**（`input()` 等用户敲键盘）。不要的话沿用现在“先在 stdin 里写好再运行”，P3 再做。初学者写 Python 很常用 `input()`，但会多改一轮任务接口。
3. **项目里允许哪些非代码文件**：Python 程序常读写 `data.txt` / `config.json` / `.csv`。建议允许 `.txt .json .csv .md`（只编辑，不运行）。C/C++ 项目是否一并放开？
4. **Python 版本**：建议锁 **3.14.8**（当前稳定版）；3.15 预计 10 月正式发布，届时可升级资源包，不影响 App。
5. **是否同时更新 `CONTEXT.md`** 的产品定位（“首期面向 C/C++”）。

## 8.1 已确认（2026-10-04）

单独导入；首版支持边运行边输入；允许 `.txt .json .csv .md`（C/C++ 一并放开）；锁 3.14.8；同步更新 `CONTEXT.md`。

## 8.2 P0 真机结果（TB376FC，2026-10-04）

启动器 `doge-python`（8.9 KB，NDK 27.2，`PyConfig_InitIsolatedConfig` + `parse_argv = 1`，初始化后把 `sys.stdin/stdout/stderr` 接回原始 fd 0/1/2）。

| 项 | 结果 |
|---|---|
| `print`（含中文） | 正常，走管道，不进 logcat |
| `json / ssl / sqlite3 / hashlib / decimal / ctypes / zlib / lzma / bz2` | 正常（OpenSSL 3.5.9，SQLite 3.53.4） |
| `input()` 读 stdin | 正常 |
| 异常 traceback / 语法错误 | 打到 stderr，退出码 1，文件和行号正确 |
| `sys.exit(3)` | 退出码 3 |
| stdout / stderr 分离 | 正常 |
| 10 万行输出 | 正常 |
| `kill -9` 停止死循环 | 正常，退出码 137 |
| 冷启动（App 用户身份，`run-as`） | `pass` 0.04 s；导入上面全部模块 0.09 s |

注意事项（P1 要处理）：

- 启动器的 `RUNPATH` 只对它自己生效；`_ssl`、`_sqlite3` 等扩展依赖的 `libssl_python.so`、`libsqlite3_python.so` 需要 **`LD_LIBRARY_PATH=<runtime>/prefix/lib`**，`PythonRunner` 启动时必须设置。
- 不设 `PYTHONHOME` 时启动器按 `<exe>/../prefix` 推算，已验证可用。
- `run-as` 的 SELinux 域是 `runas_app`，与 App 进程（`untrusted_app`）不完全相同；App 里 clang 已能从 `files/` 执行，预计一致，P1 接上后再确认一次。

## 9. 风险

| 风险 | 对策 |
|---|---|
| 个别设备禁止从 App 目录执行二进制 | 目前 `targetSdk 28` 允许（clang 已在用）；若将来升 targetSdk，改为把启动器放进 `jniLibs` 并开启 `useLegacyPackaging` 解压到 `nativeLibraryDir` 执行 |
| 输出被 Android 重定向到 logcat | 引导脚本强制换回 fd 1/2（§3.2）；P0 首先验证 |
| 用户代码能访问网络和 App 私有文件 | 与 C 的 WASM 沙箱不同，Python 以 App 身份运行；运行的是用户自己的代码，可接受，在关于 / 文档里写明 |
| 冷启动慢 | 预编译 `.pyc`、隔离模式减少启动时导入；P0 量实际耗时 |
| 一个项目里混写 C 和 Python | 不支持；一个项目一种语言 |
