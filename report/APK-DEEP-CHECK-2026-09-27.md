# APK 深度检查报告

检查日期：2026-09-27  
检查范围：仅 Android APK 工程、APK 内本地运行时、Android Java/JNI、LocalServer、共享 WebView 前端和发布配置。  
检查方式：源码审查、APK 结构检查、Gradle 构建、JNI/CMake 构建、前端 JavaScript 语法检查。

## 结论

当前项目可以构建 ARM64 debug APK，本地 C/C++ 编译运行链路已经形成，但仍存在会影响连续使用、取消任务、项目保存和代码智能的高风险问题。当前环境没有可用 `adb` 或连接设备，因此大输入、超时取消竞态、Activity 销毁、SAF 慢速 provider、clangd 真机行为和多 Android 版本兼容仍未完成实机验证。

## 已确认的高风险 Bug

### P0-1 任务取消会误取消其他任务

`TaskRegistry.cancel(id)` 无论目标任务是排队、运行还是已完成，都会调用 `LocalCompiler.cancelActive()`。取消排队任务 B 时，会终止当前运行任务 A；取消已完成任务也会返回成功。

涉及：`android/app/src/main/java/com/doge/ide/TaskRegistry.java`

### P0-2 任务历史永久增长，运行 20 次后 Run 永久返回 429

任务上限检查使用 `tasks.size()`，但已完成任务从不移除。前端只裁剪显示历史，后端内存中的任务仍然永久保留。

涉及：`TaskRegistry.java`

### P0-3 native stdin 写线程在取消/超时边界可能阻塞

stdin 写线程可能阻塞在 pipe `write()`；主线程随后无超时地 `pthread_join()`。大输入与超时、取消组合需要 native 压力测试和可取消写入机制。

涉及：`android/app/src/main/cpp/wasm_runner.c`

### P0-4 targetSdk 固定为 28

当前依赖旧 target 行为允许从应用私有目录执行导入工具链，但会带来新 Android 兼容风险，并不满足现代商店 target SDK 要求。需要长期替代方案，不能作为正式发布配置长期保留。

涉及：`android/app/build.gradle`、`AndroidManifest.xml`

## P1 Bug 和稳定性问题

### P1-1 项目保存在 WebView bridge 调用线程同步执行

SAF 目录查询、文件写入、旧文件删除和清单写入全部在 `DogeNative.saveProject()` 调用中同步执行。大项目或慢速 provider 可能造成 WebView 卡顿甚至 ANR。

涉及：`MainActivity.java`、`doge-ide.html`

### P1-2 Activity 销毁后异步任务仍可能访问 WebView

工具链导入、依赖导入、项目打开/创建和进度回调的线程可能晚于 `onDestroy()` 完成。部分回调直接调用 `web.evaluateJavascript()`，生命周期保护不完整。

涉及：`MainActivity.java`

### P1-3 clangd 路径校验允许绝对路径

`ClangdService.syncWorkspace()` 只检查字符和 `..`，未拒绝 `/absolute/path`、目录路径等情况，随后直接 `new File(root, path)` 写文件。应统一使用 canonical path 和安全相对路径校验。

涉及：`ClangdService.java`

### P1-4 clangd LSP 通信缺少超时和 stderr 排空

clangd stderr 没有读取，可能填满 pipe；LSP 响应读取没有超时，clangd 异常时请求可能永久挂起。通知、崩溃重启、didChange/didClose 也不完整。

涉及：`ClangdService.java`

### P1-5 依赖包安装后没有正确映射到编译路径

依赖安装在 `files/packages/<name>-<version>`，但 `LocalCompiler` 把配置路径按当前运行目录解析，没有通过 registry 或 `DependencyManager.packageRoot()` 接入实际包目录。导入成功不等于编译可用。

涉及：`DependencyManager.java`、`LocalCompiler.java`

### P1-6 编译运行临时目录不清理

每次运行创建 `files/runs/<id>`，编译成功、失败、超时和取消后均没有统一删除，长期使用会耗尽应用私有空间。

涉及：`LocalCompiler.java`

### P1-7 单阶段 timeout 被每个源文件、链接和运行重复使用

多文件项目每个编译、链接、WASM 运行都最多等待整个 timeout。默认 30 秒的项目可能实际运行数分钟，前端显示与用户设置不一致。

涉及：`LocalCompiler.java`

### P1-8 工具链替换不是原子操作

导入完成时先删除旧 `toolchain`，再将 staging 重命名为正式目录。重命名失败会丢失原本可用的工具链，缺少回滚。

涉及：`MainActivity.java`

### P1-9 工具链和依赖包缺少完整性/可信来源校验

目前检查 ZIP 路径、体积、条目数和基本 manifest，但没有 SHA-256、签名、逐文件校验、版本兼容或 ABI 检查。

涉及：`MainActivity.java`、`DependencyManager.java`

### P1-10 `allowBackup=true` 未定义备份范围

应用私有目录包含工具链、用户源码、依赖和缓存，当前 Manifest 没有排除规则，系统备份/恢复可能造成大体积备份和状态不一致。

涉及：`AndroidManifest.xml`

### P1-11 release 构建可静默回退 debug 签名

没有 `keystore.properties` 时，`assembleRelease` 使用 debug key。产物名称看似 release，但不适合作为正式发布包。

涉及：`app/build.gradle`、`android/README.md`

### P1-12 lint 错误不阻断 release

`abortOnError=false`、`checkReleaseBuilds=false` 会让发布构建忽略静态检查问题。

涉及：`app/build.gradle`

## P2 功能不足

1. 没有交互式终端、运行中输入、EOF、Ctrl+C 和增量 stdout/stderr。
2. 任务轮询只得到结束后的整体输出，不能实时显示。
3. 没有增量编译、CMake/Make、文件监听、构建缓存和完整工程模型。
4. 保存过程没有事务、冲突检测或外部修改合并，部分写入失败可能留下半更新项目。
5. 项目文件删除缺少回收站/撤销；文件重命名和目录级操作不完整。
6. clangd 工作区不清理旧文件，项目切换、内存压力和进程崩溃恢复不足。
7. 只有 `arm64-v8a` ABI，模拟器和其他 ABI 无法运行，启动时也没有明确诊断。
8. 任务 body、输出、clangd 工作区和运行内存缺少完整总量限制。
9. 工具链/依赖导入没有取消、恢复、持久授权和完整空间回滚流程。
10. 真实 C/C++ 调试器、断点、单步、调用栈和变量查看尚未实现。
11. Git、项目导入导出、模板管理、无障碍、国际化和诊断日志导出尚未实现。
12. Manifest 保留 INTERNET 和站外跳转能力，需要明确离线产品边界并做 URL allowlist 评估。

## 验证记录

- `:app:assembleDebug`：通过。
- CMake/JNI ARM64 构建：通过。
- Java 编译：通过。
- 抽取 `doge-ide.html` 的 JavaScript 后 `node --check`：通过。
- `git diff --check`：通过。
- APK 包含 `libiwasm.so`、`libdoge_wasm_jni.so`、`classes.dex`、`assets/index.html` 和 Web 资源。
- 未完成：真实设备安装、`adb` 回归、大 stdin、超时/取消压力、Activity 销毁、SAF 慢速 provider、clangd 实机启动和多 Android 版本验证。

## 修复分组和顺序

第一组：任务取消状态机、任务历史回收、项目异步保存与 Activity 生命周期、clangd 路径/LSP 稳定性。  
第二组：native stdin 取消回收、运行目录清理、统一总 deadline、工具链原子替换。  
第三组：依赖包真实编译接入、项目保存事务、导入完整性校验、导入取消和空间回滚。  
第四组：release 签名门禁、lint 发布门禁、备份范围、ABI/启动诊断。  
第五组：交互终端、增量输出、增量构建、工程模型和调试能力。

## 第一组修复记录

本轮已完成：

- 任务取消区分排队、运行和已完成状态；取消排队任务不再终止当前运行任务。
- 任务提交只限制未完成任务数量，并自动回收超出上限的最旧完成任务。
- 项目保存改为后台执行，通过 `window.projectSaveResult` 异步反馈结果。
- 工具链、依赖、项目和进度回调统一经过 WebView 生命周期保护，Activity 销毁后不再向已销毁 WebView 回调。
- clangd 文件路径改为安全相对路径并执行 canonical path 校验。
- clangd 增加 stderr 排空和 5 秒 LSP 请求超时，超时自动销毁进程。

本组验证：`assembleDebug`、前端 JavaScript `node --check`、`git diff --check` 均通过。未完成真机压力回归。

## 第二组修复记录

本轮已完成：

- Android NDK 不支持 `pthread_cancel`，改为 stdin pipe 非阻塞写入、原子取消标志和短间隔重试；执行结束/取消后设置标志并 join 输入线程，cleanup handler 负责关闭写端。
- 编译、链接、WASM 运行共享同一个总 deadline，不再为每个源文件重复完整 timeout。
- 每次运行目录在 `finally` 中递归清理，异常和编译失败也执行清理。
- 工具链替换先把当前版本改名为备份，再切换新版本；切换失败恢复旧目录，成功后删除备份。

本组验证：`assembleDebug`（包含 JNI/CMake）通过，前端 JavaScript `node --check` 通过，`git diff --check` 通过。native 大 stdin/取消行为、文件系统重命名失败回滚仍需真机验证。

## 第三组修复记录

本轮已完成：

- 依赖设置中的 `name@version` 在运行请求中转换为结构化坐标；编译器通过 registry 安全解析实际依赖目录，并自动加入 `include/` 与 `lib/` 搜索路径。缺少已安装依赖时返回明确错误。
- 依赖导入计算解压内容 SHA-256 并写入包元数据/registry；限制包大小、条目数、重复路径和可用空间；替换版本前保留旧包，registry 写入失败时回滚。
- 项目保存先备份被覆盖文件和旧 manifest；文件写入或 manifest 提交失败时尝试恢复旧文件、删除新建文件并恢复清单。旧文件清理移到 manifest 提交后，删除失败只记录日志，不回滚已提交项目。
- 工具链 manifest 支持可选 `sha256` 文件校验表，并对 manifest 提供的 clang/sysroot 路径做安全路径验证。
- 依赖导入成功后自动加入当前项目的依赖列表。

注意：现有 0.1.0 工具链 manifest 不带 SHA-256 表，因此兼容旧包时只能做结构校验；要获得内容完整性校验，需要在后续资源包版本生成 manifest 的 `sha256` 字段。

本组验证：`assembleDebug`、前端 JavaScript `node --check`、`git diff --check` 均通过。未执行 SAF provider 故障注入和依赖真实编译真机测试。

## 第四组修复记录

本轮已完成：

- release 签名不再回退 debug key；没有 `android/keystore.properties` 时在 `preReleaseBuild` 明确失败。
- 打开 release lint 阻断（`abortOnError=true`、`checkReleaseBuilds=true`）。
- 关闭 Android 自动备份并添加 Android 12+ extraction rules，明确排除应用私有工具链、项目缓存、依赖和偏好数据。
- native 库改为延迟加载；启动时检测 `arm64-v8a` ABI。ABI 不兼容或 native 库加载失败时显示可读错误页和 Toast。
- README 更新 release 签名说明。

本组验证：JDK 21 下 `assembleDebug` 通过；无签名时 `assembleRelease` 在 `preReleaseBuild` 明确失败。启用 lint 后，离线 release 构建在 lint 阶段因本机 Gradle 缓存缺少 `com.android.tools.lint:lint-gradle:31.7.3` 而无法完成；联网获取该依赖后需补跑 release lint。前端语法与 `git diff --check` 通过。

## 第五组修复记录与整体进度

本轮已完成/补强：

- 增加 `/api/v1/tasks/{id}/output?stdout_offset=&stderr_offset=` 增量输出接口，stdout/stderr 分流并返回新游标。
- Clang/链接子进程输出逐块进入任务缓冲，前端轮询仅追加新片段；任务输出缓存每流限制 1 MiB。
- 任务 phase 增加 `compiling`、`linking`、`running` 阶段，前端显示阶段和编译文件信息。
- 增加以完整构建请求 SHA-256 隔离的对象文件缓存，并限制缓存总量为 128 MiB。此为保守缓存基础：仅完整请求完全一致时复用，不代表已实现按文件依赖图的高命中增量构建。
- 明确 Debug 为插桩轨迹回放；Android APK 中触发该入口时提示当前没有真实 C/C++ 调试器。

仍未完成：

- WASM/WAMR 运行阶段的 stdout/stderr 仍在模块结束后返回；需要把 native WASI pipe reader 接入任务增量缓冲，才能完成运行时实时输出。
- 交互式 stdin、运行中输入、EOF 和终端 UI 未完成。
- 对象缓存尚未做按源文件 hash/头文件依赖的增量失效；当前只对相同完整请求复用。
- 真实 LLDB 调试器、断点/单步/调用栈/变量查看未实现；资源包缺少 LLDB 组件。
- CMake/Make 工程模型、文件监听、多项目工作区、Git、崩溃恢复和真机压力验收仍未完成。

截至本组，已处理前四组列出的第一组至第四组主要高优先级 APK 缺陷，并完成第五组中的输出游标、编译阶段可见性和保守构建缓存基础。整体定位仍是 Android ARM64 本地 C/C++ 多文件轻量 IDE 原型，未达到具有交互终端、工程构建系统和真实调试器的完整 IDE。

本组验证：JDK 21 下 `assembleDebug`（含 JNI/CMake）通过，前端 JavaScript `node --check` 通过，`git diff --check` 通过。尚未完成设备侧轮询延迟/输出截断测试和对象缓存命中实测。

## 实机测试前修复

### 新建项目 `Invalid URI`

原因是 `ACTION_OPEN_DOCUMENT_TREE` 返回的是 tree URI，但新建项目流程直接把它传给 `DocumentsContract.createDocument()`。部分 Android SAF provider 不接受这种 URI 形态，返回 `Invalid URI`。

已修复：先用 `buildDocumentUriUsingTree(parent, getTreeDocumentId(parent))` 转换为 document URI，再创建项目目录。新 APK 需要重新安装后测试新建项目流程。

### 软件自身错误自动反馈

APK 现在捕获并处理：

- Java 未捕获异常；
- WebView JavaScript 全局错误；
- 未处理 Promise rejection；
- JavaScript 到 Android 的异常报告桥接。

发生软件错误时会：

1. 生成来源、错误消息和完整堆栈；
2. 自动复制到系统剪贴板；
3. 弹出错误详情对话框；
4. 提供“再次复制”按钮。

C/C++ 编译错误仍走编辑器 stderr 诊断，不会被误判成软件自身错误。

本次验证：JDK 21 + `E:\androidSDK` 下 `assembleDebug` 通过；前端 JavaScript 语法检查和 `git diff --check` 通过。尚未在真机触发 SAF provider 和异常弹窗回归。

## 真机反馈修复：clangd diagnostics 函数缺失

实机键入时 `editor.on('change')` 调用未定义的 `requestClangdDiagnostics()`，造成 `ReferenceError` 并触发软件异常报告。已补充该函数：仅在 APK 且工具链就绪时请求 `/api/v1/intel/diagnostics`，渲染 clangd 范围标记；新请求会使旧响应失效，clangd 不可用时静默降级，避免影响编辑和本地 lint。

验证：前端 JavaScript 语法检查、`git diff --check`、JDK 21 + `E:\androidSDK` 的 `assembleDebug` 均通过。新 debug APK 已生成，待实机确认连续输入不再出现该 ReferenceError。

## 用户体验修复：固定项目语言与持久错误弹窗

- 新建项目向导现在必须选择 C 或 C++；项目写入 `language` 属性，创建后编辑器只显示当前语言和“项目语言固定”提示。
- 删除编辑器语言切换的实际入口和 Ctrl+1/Ctrl+2 快捷键；打开旧项目时按清单语言或入口文件扩展名兼容推断。
- 新建源文件默认使用项目语言扩展名，源文件扩展名与项目语言不一致时拒绝创建；头文件仍允许创建。
- `ACTION_OPEN_DOCUMENT_TREE` 权限缺失、项目目录创建失败等应用错误改为持久化错误详情、自动复制剪贴板并弹出不会自动消失的对话框。
- Java 未捕获异常也会保存到 `files/last-software-error.txt`、复制并弹出“软件崩溃”对话框，用户确认后才退出。

本次验证：JDK 21 + `E:\androidSDK` 下 `assembleDebug` 通过，前端 JavaScript 语法检查和 `git diff --check` 通过。仍需真机验证不同 SAF provider 的授权 flags 和新建项目语言闭环。

## 真机反馈修复：SAF 子目录权限模型

错误根因：`ACTION_OPEN_DOCUMENT_TREE` 授权的是用户选择的父目录 tree URI；创建项目子目录后，旧实现把子目录 document URI 拼成新的 tree URI，并用它查询 `/children`。Android `ExternalStorageProvider` 因没有该伪 tree URI 的授权而抛出 `SecurityException: Permission Denial`。

已修复：

- 持久化用户真正授权的父 tree URI；
- 单独持久化新建项目目录的 document ID；
- 打开、扫描、保存、清单读写、删除和回滚全部使用父 tree URI + 项目 root document ID；
- 不再对未授权的子目录伪 tree URI 查询；
- 项目清单现在也保存/恢复 `language` 属性；
- 内置服务、工具链导入、依赖导入和项目错误统一走持久化错误弹窗，避免短 Toast 消失。

## 本次完整 APK 复查

- Java 编译：通过。
- JNI/CMake ARM64 构建：通过。
- `assembleDebug`：通过。
- 前端 JavaScript `node --check`：通过。
- `git diff --check`：通过。
- APK v2 签名验证：通过。
- APK 包含 `lib/arm64-v8a/libiwasm.so`、`libdoge_wasm_jni.so`、`classes.dex` 和 `assets/index.html`。
- AAPT 核对：包名 `com.doge.ide.plus.debug`、minSdk 24、targetSdk 28、native ABI `arm64-v8a`、入口 `MainActivity`。

静态复查仍确认的产品限制：只有 ARM64、targetSdk 28、WAMR 运行输出非实时、没有交互式 stdin/终端、没有真实 LLDB 调试器、没有完整 CMake/工程构建系统。SAF 新建项目、重启恢复和不同文件 provider 仍需在设备上回归。

## 真机反馈修复：项目语言显示和空文件内容

- 编辑器初始化、项目打开、文件切换和运行入口统一使用 `project.language`，不再被当前文件扩展名覆盖；C++ 项目会稳定显示 `C++ · C++20`。
- 新文件切换时从 `file.code || lang.sample` 改为 `file.code ?? ''`，空文件保持空白；只有新建“示例项目”时才写入示例代码。
- 删除项目最后一个文件时也保留当前项目语言显示。

验证：JDK 21 + `E:\androidSDK` 下 `assembleDebug` 通过，前端 JavaScript 语法检查和 `git diff --check` 通过。待真机确认 C++ 项目创建/重启和空 C/C++ 文件显示为空。

## 真机反馈修复：Tab 输入冲突与无文件空状态

- Tab 仍插入四个空格，但现在会立即关闭补全候选并取消待触发的补全；APK 自动弹出补全暂停，Ctrl+Space 手动补全保留。异步 clangd 补全只在同一文件、文本和光标未变化时才显示，以避免 Android 输入法与旧补全结果争用光标。
- 无文件时 CodeMirror 变为只读，编辑区域显示“请先新建文件或者选择要编辑的文件”；新建或选择文件后恢复可编辑。
- 空项目本地草稿现在能正常恢复，避免重启后读取不存在的 `project.files[0]`。删除最后一个文件、打开空项目和新建空项目均会刷新只读状态。
- CodeMirror 的只读选项只在文件可用状态变化时更新，避免编辑过程中反复重置输入状态。

验证：前端 JavaScript `node --check`、`git diff --check` 和 JDK 21 + `E:\androidSDK` 的 `assembleDebug` 均通过。当前 `adb devices` 无连接设备，Tab/软键盘行为还需真机回归。

## 真机联合调试：Tab 输入与空项目状态

设备：Lenovo `TB376FC`，序列号 `HA2K9X7F`。已通过 ADB 安装并启动最新 debug APK。

真机确认：

- 空项目编辑器显示“请先新建文件或者选择要编辑的文件”，并处于只读状态。
- 已存在 C++ 项目顶部显示 `C++ · C++20`，底部语言显示一致。
- 无设备日志显示新的 JavaScript ReferenceError 或启动崩溃。

Tab 输入修复进一步调整：自定义 `cm.replaceSelection('    ', ...)` 改为 CodeMirror 原生 `cm.execCommand('insertTab')`，并在 Tab/输入法事件中关闭补全候选；APK 端停用自动弹出补全，保留 Ctrl+Space 手动补全，避免 WebView Android IME 与异步补全抢占光标。

最新真机安装包已重新构建并安装。仍需在有实际源文件的编辑器中由用户进行一次 Tab 后连续输入回归，确认具体输入法设置下不再出现字符被删除。

## 真机联合调试：Tab 根因修复与更新缓存（已确认通过）

在设备 `HA2K9X7F` 上多轮回归后确认，Tab 后输入被删除的真正根因是 **CodeMirror 在 Android WebView 上默认使用 contenteditable 输入模式**，与系统输入法（IME）的 composition 状态相互干扰，导致后续字符替换掉刚插入的缩进。之前围绕补全候选、`replaceSelection`、原生 `insertTab`、捕获阶段拦截的多轮尝试都无法根治。

最终修复：

- 编辑器强制 `inputStyle: 'textarea'`，用隐藏 textarea 替代 contenteditable，这是 CodeMirror 官方推荐的移动端 / IME 兼容方案。真机确认 Tab 后连续输入恢复正常。
- 顺带修复 `getInputField().value.length` 在 contenteditable 模式下抛出的 `Uncaught TypeError: Cannot read properties of undefined (reading 'length')`；keyup 选区折叠逻辑加类型守卫。

更新后仍是旧版本（必须卸载重装才能更新）根因与修复：

- `LocalServer` 之前对 `index.html` 和静态资源返回 `Cache-Control: public, max-age=86400`，配合 WebView `LOAD_DEFAULT` 缓存模式，导致覆盖安装后 WebView 仍加载缓存的旧页面。
- 修复：静态资源改为 `Cache-Control: no-store`（`LocalServer.java`），WebView 缓存模式改为 `WebSettings.LOAD_NO_CACHE`（`MainActivity.java`）。此后覆盖安装即可获取最新页面（本次修复本身仍需最后手动重装一次生效）。

验证：前端 `node --check`、Gradle `assembleDebug`、覆盖安装均通过；真机确认 Tab 输入正常、无 JS 崩溃。
