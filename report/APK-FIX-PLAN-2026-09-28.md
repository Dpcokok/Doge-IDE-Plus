# APK 问题修复计划

制定日期：2026-09-28
适用范围：仅 Android APK 本地运行版（`doge-ide.html` 前端 + `android/` 工程）
状态说明：本文档记录本轮审查确认的问题清单与修复计划。已核实源码位置的问题按优先级排列。

## 背景

上一轮已确认并修复：Tab 输入根因（强制 `inputStyle:'textarea'`）、更新缓存（`Cache-Control: no-store` + `LOAD_NO_CACHE`）、无文件只读空状态、C++ 语言显示、空文件不带示例代码、软件错误弹窗。

本轮对 `doge-ide.html`（2526 行）与全部 Java / native / gradle / manifest 做了完整只读审查，并逐条核实关键项的源码位置。

## 本次计划修复的批次（前端，一次构建即可真机验证）

### F1. 工具链就绪判断写错（最高优先）

- 位置：`doge-ide.html:1957`
- 问题：`if (window.DogeNative && DogeNative.isToolchainReady)` 用的是函数引用，永远为真。对比正确写法 `doge-ide.html:1114` 的 `!DogeNative.isToolchainReady()`。
- 后果：工具链尚未导入就绪也会走 `runAsTask`，点 Run 会失败但缺少“请先导入运行库”的明确提示；补全路径同样受影响。
- 修复：统一改为 `DogeNative.isToolchainReady && DogeNative.isToolchainReady()`，并用 try 包裹；未就绪时给出明确提示。

### F2. 运行中在触控下无法取消（最高优先）

- 位置：`doge-ide.html:42`、`doge-ide.html:46`（`.run-btn.running / .debug-btn.running { pointer-events:none }`），取消逻辑 `runCode()` 开头 `doge-ide.html:1945`
- 问题：运行态给按钮设了 `pointer-events:none`，唯一取消入口 Ctrl+Enter 在平板上不可用。
- 后果：点 Run 后无法中止，只能等超时。
- 修复：运行态保留 Run 按钮可点击并显示为“停止”，去掉 `pointer-events:none`，点击触发 `cancelExecution()`。

### F3. APK 主运行路径无 fetch 超时 / 无熔断（最高优先）

- 位置：`runAsTask` `doge-ide.html:2109`、`pollTask` `doge-ide.html:2142`；超时逻辑仅存在于降级路径 `execFetch` `doge-ide.html:1996`
- 问题：APK 走 task 路径，所有 fetch 无 `AbortController` 超时，`pollTask` 为 `while(true)`。
- 后果：本地 HTTP 服务无响应时永久卡住，`isRunning` 一直为真。
- 修复：给 task 路径所有 fetch 加超时；`pollTask` 加连续失败计数 / 最大轮询时长熔断，失败时 break 并复位 `isRunning`。

### F4. 项目工具栏按钮触控过小、易误删（最高优先）

- 位置：按钮定义 `doge-ide.html:57`（26×26px），coarse-pointer 媒体查询 `doge-ide.html:280-304` 未覆盖 `.project-actions button`
- 问题：New/Open/Save/`+`/删除`−`/`‹` 六个挤在一起，删除键紧挨新建键，平板易误触。
- 修复：coarse 媒体查询里把 `.project-actions button` 放大到 ≥44px，拉开删除键间距或加危险色。

### F5. 语言 Tab 运行后丢高亮（中优先）

- 位置：`buildTabs` `doge-ide.html:1229` 未设 `dataset.lang`；`doge-ide.html:1953`、`doge-ide.html:1517` 用 `t.dataset.lang === currentLang` toggle `active`
- 问题：`undefined !== 'c'` 恒成立，运行或切文件后标签变灰。
- 修复：`buildTabs` 里加 `tab.dataset.lang = lang.id;`。

### F6. 横竖屏旋转被误判为软键盘弹出（中优先）

- 位置：`initTabletUX` `doge-ide.html:2270`
- 问题：`vv.height < base-120` 判断键盘，`base` 只增不减，横屏被误判，footer / stdin 被隐藏且恢复不了。
- 修复：`orientationchange` / 尺寸变化时重置 `base`。

### F7. Settings 的 timeout / codeSize 保存未钳制上界（中优先）

- 位置：`saveSettings` `doge-ide.html:2387`
- 问题：`parseInt||default` 只挡空值，用户输入超大值原样存入，`attemptTimeoutMs` 会异常巨大。
- 修复：保存前 `Math.min/Math.max` 钳制到合法区间。

## 后续批次（本轮先记录，暂不实施）

### 前端中优先

- P-F8 平板补全基本不可用：`bindAutoComplete` `doge-ide.html:788` 在 APK 里整体 return，只剩 Ctrl+Space。建议加触控可点的“补全”按钮调 `cm.showHint`。
- P-F9 本地 lint 对 C/C++ 大量误报：`lintDocument` `doge-ide.html:900+` 只认手工符号表。建议 clangd 可用时对 C/C++ 关闭本地“未定义名”下划线。
- P-F10 输出无限增长 + stderr 每 250ms 全量重渲染：`pollTask` `doge-ide.html:2150`、`renderOutput` `doge-ide.html:2204`。建议加输出上限并改增量渲染。
- P-F11 导入进度遮罩可能永久卡死：`toolchainProgress` `doge-ide.html:2427`。建议加取消 / 超时兜底。

### 前端低优先

- 软键盘弹出时编辑器光标不自动滚入可视区 `doge-ide.html:2280`
- Header 窄竖屏可能溢出 `doge-ide.html:35`（加 flex-wrap）
- 依赖坐标 `split('@',2)` 丢多余段 `doge-ide.html:2119`
- `jumpToDiagnostic` 的 `endsWith('/'+fileName)` 可能命中错误文件 `doge-ide.html:2232`
- 各弹窗 Esc / Enter / 遮罩关闭不一致
- `editor._clangdTimer` 切文件时未清理 `doge-ide.html:1285` / `doge-ide.html:1498`
- 图标按钮缺 `aria-label`，`user-scalable=no` 禁用缩放 `doge-ide.html:5`

### Java / native 侧（稳定性与数据安全）

- P-J1（高）并发保存可能损坏 SAF 目录 / 丢文件：`saveProject` 用 cachedThreadPool `MainActivity.java:81`，`writeProject` 多步非原子。建议串行化或加锁。
- P-J2（高）两个 DependencyManager 实例导致 registry.json 读写竞态：`MainActivity.java:114` 与 `LocalCompiler.java:30`，实例级锁互不可见。建议改单例。
- P-J3（高）直连 `/execution/run` 与队列任务可并发，共享固定路径且全局杀进程：`LocalServer.java:378`，`workspace/current` 固定路径，`cancelActive()` 杀全部进程。建议移除或串行化。
- P-J4（中）build-cache 清理逻辑 bug：`LocalCompiler.java:265` 先删后取 size，`total` 永不下降，超限会清空整份缓存。
- P-J5（中）native fd 泄漏：`wasm_runner.c:226`（busy 分支）、`wasm_runner.c:209`（pipe 短路），错误路径未 close。
- P-J6（中）编译输出读取线程非 daemon 且超时后可能滞留：`LocalCompiler.java:339`。
- P-J7（中）`runs/` 临时目录被 SIGKILL 后残留：`LocalCompiler.java:166`，建议启动时清空。
- 其余：clangd didOpen/version 处理、SAF 权限失效判断、超大项目单字符串 OOM、缓存指纹粒度过粗、keep-alive 畸形 Content-Length、accept/close 字段竞态、死代码清理等，见审查记录。

## F1-F7 实施记录（2026-09-28，已完成）

- F1：新增 `toolchainReady()`（真正调用 `DogeNative.isToolchainReady()` 并 try 包裹），替换 `runCode`、`clangdCompletions`、`bindAutoComplete`、`requestClangdDiagnostics` 四处判断。APK 未就绪时不再发任务，stderr 显示“请先点击顶部‘导入运行库’”并弹提示。
- F2：去掉 `.run-btn.running` 的 `pointer-events:none`；新增 `setRunButtonState('idle'|'running'|'stopping')`，运行中按钮显示“停止”可点击，点击后进入“正在停止...”（仅此状态禁用点击）。浏览器路径与 task 路径共用。
- F3：新增 `fetchJsonWithTimeout()`（8s 超时）。`runAsTask` 创建任务、`pollTask` 轮询、`cancelExecution` 取消全部走超时；`pollTask` 连续 5 次失败熔断、总时长上限为“运行超时 + 120s”、请求停止后 10s 未确认即退出等待；失败信息写入 stderr 并提示，`finally` 统一复位运行状态。
- F4：coarse-pointer 下 `.project-actions button` 为 44px（wide 按钮最小宽 44px），工具栏可换行；删除按钮加 `danger` 红色并左侧额外 10px 间距，补 `aria-label`；窄屏下项目面板高度改为自适应（最大 240px）。
- F5：`buildTabs` 给固定语言标签设置 `data-lang`，运行/切文件后高亮不再丢失。
- F6：键盘判断基于当前方向的基准高度；可视宽度变化 >40px 或 `orientationchange` 时重新测量基准；只有焦点在输入控件时才判定键盘弹出；`focusout` 后重新同步。
- F7：`saveSettings` 钳制 timeout 到 1000-30000、codeSize 到 11-24，并把钳制后的值回填输入框。

验证：

- 前端 `node --check`：通过。
- `assembleDebug`（JDK 21 + `E:\androidSDK`）：通过；`adb install -r` 覆盖安装成功（缓存修复已生效，未卸载）。
- 真机 `HA2K9X7F`（density 360）：项目工具栏按钮实测约 45×45 CSS px（如 `New [231,398][350,500]`）；点击 Run 任务正常完成（`✓ Task completed`）；logcat 无 `Uncaught/TypeError/ReferenceError`。
- 未在真机验证：F2 停止按钮（示例程序瞬间结束，未抓到运行态）、F3 服务无响应熔断（需人为让服务失联）、F6 旋转（Manifest 为 `sensorLandscape`，本机不会进入竖屏）、F1 未就绪提示（设备已导入运行库）。以上均为代码路径推导。

## P-J1 ~ P-J7 实施记录（2026-09-28，已完成）

- P-J1 项目保存串行化：`MainActivity` 新增单线程 `projectExecutor`，`saveProject` 改走它（FIFO，最后一次保存最终落盘）；`writeProject` 外包 `projectWriteLock`，新建项目线程与保存线程也互斥。`onDestroy` 对其 `shutdown()`（不中断进行中的 SAF 写入）。
- P-J2 DependencyManager 单例：构造函数私有化，新增 `DependencyManager.get(context)`；`MainActivity` 与 `LocalCompiler` 共用同一实例和同一把锁。`writeRegistry` 改为先写 `registry.json.tmp` 再 rename，避免进程被杀留下半截文件。
- P-J3 直连执行串行化：`/api/v1/execution/run` 不再在 HTTP worker 上直接编译，改为 `TaskRegistry.runBlocking()` 进入同一个单线程 worker 排队并等待（上限 180s）；`/api/v1/execution/cancel` 改为 `cancelDirect()`，只取消直连任务。`TaskRegistry.cancel()` 只有目标任务正是当前运行任务时才调用 `LocalCompiler.cancelActive()`，排队任务取消不再误杀正在运行的任务。`runningTaskId` 在任务锁内登记，避免取消竞态。
- P-J4 build-cache 清理：删除条目前先取 `treeSize`，再 `total -= size`，超限时只删最旧条目直到回到 128 MiB 以内。
- P-J5 native fd 泄漏：新增 `close_pipe_pair()`；三组管道初始化为 -1，`pipe()` 部分失败时关闭已创建的管道；`runner busy` 分支关闭全部 6 个 fd。
- P-J6 读取线程：`drain` 线程设为 daemon；`join(1000)` 后仍存活则主动关闭子进程 stdout/stderr 流，让线程退出。
- P-J7 启动清理：`LocalCompiler` 构造时（每个进程一次，`AtomicBoolean` 保护）删除 `files/runs/`。

验证：

- `assembleDebug`（含 CMake 重新编译 `wasm_runner.c`）：通过；`adb install -r`：成功。
- 真机 `HA2K9X7F`，通过 `adb forward tcp:18787 tcp:8787` 直接调用本地 API：
  - P-J7：在 `files/runs/orphan-test/` 放入孤儿文件后冷启动，`files/runs` 已被删除。
  - P-J3：任务 A（死循环）运行中时发起直连执行 B，B 进入队列；调用 `/execution/cancel` 后 B 返回 `canceled`（1.8s），A 仍为 `phase=running`，未被误杀。随后 `/tasks/t1/cancel` 使 A 结束为 `finished/canceled`。
  - 空闲时直连执行 `hello` 返回 `success`、`stdout=hello-direct`（0.2s），相同代码再次运行 0.1s（命中对象缓存）。
  - logcat 无 `FATAL EXCEPTION` / `Uncaught`。
- 未在真机触发：P-J1 并发保存（需要连续快速保存大量文件）、P-J2 安装依赖与编译同时进行、P-J4 缓存超过 128 MiB、P-J5 的 pipe 失败与 runner busy 分支（串行化后正常路径不会进入 busy）、P-J6 子进程流不关闭的情况。这些为代码路径推导。

## 前端中优先 P-F8 ~ P-F11 与前端低优先项实施记录（2026-09-28，已完成）

中优先：

- P-F8 平板补全入口：编辑器标签栏右侧新增“补全”按钮（`#completeBtn`，`pointerdown` 阻止抢焦点），调用新函数 `triggerCompletion()`：运行库就绪时先显示本地候选，clangd 结果回来且光标/文本未变时替换；否则走本地补全；无候选时提示。Ctrl+Space 也改走同一函数。无文件时按钮禁用。输入即弹出的自动补全仍在 APK 中关闭（避免 IME 冲突）。
- P-F9 C/C++ lint 误报：`scheduleLint()` 在 C/C++ 且 `toolchainReady()` 时清除本地“未定义名”标记并跳过本地检查，由 clangd 诊断接管；运行库导入成功后立即切换。运行库未就绪时仍保留本地检查。
- P-F10 输出增长与渲染：新增 `appendBoundedOutput()`，前端 stdout/stderr 各上限 512K 字符，超出截断并追加“输出过长，已截断”；`renderOutput()` 改为增量追加（同一个 `outputData` 对象、同一标签、开头一致且只变长时只追加新文本；stderr 仅在上次末尾为换行时追加，保证诊断行完整），诊断链接改为输出区一次性事件委托；只有贴底时才自动滚动，向上翻看时不被打断；stderr 计数统一由 `updateStderrCount()` 维护。
- P-F11 导入遮罩兜底：导入进度加 90 秒无进度检测，超时显示“长时间没有进度更新”与“后台继续”按钮，可关闭遮罩（导入仍在后台，完成后照常提示）；进度框补 `role="dialog"`、`progressbar`、`aria-live`。

低优先：

- 键盘弹出时编辑器光标：焦点在编辑器且键盘弹出时 `refresh()` 并把光标滚入可视区。
- Header 窄屏溢出：`.header`、`.header-right` 加 `flex-wrap`；触控下 Files / 导入运行库按钮最小高度 44px。
- 依赖坐标：新增 `parseDependencyCoordinate()`，按最后一个 `@` 拆分（兼容 `@scope/name@1.0`）。
- 诊断跳转：新增 `findDiagnosticFile()`，按“后缀路径段最长匹配”定位文件；只匹配到同名文件名且有多个候选时，优先当前文件，否则提示存在同名文件，不再跳错。
- 弹窗一致性：新增 `openDynamicDialog()`（`role="dialog"`、`aria-modal`、焦点在弹窗内循环、关闭后焦点返回），`dogeConfirm`/`dogeInput` 统一使用；确认框默认聚焦“取消”；全局 Esc 关闭最上层弹窗/新建项目/快捷键/设置面板；新建项目表单 Enter 提交；静态弹窗点击遮罩关闭；设置面板点击外部关闭。
- `_clangdTimer`：切换文件时清除诊断定时器、关闭补全候选并作废进行中的诊断请求。
- 可访问性：图标/文字按钮补中文 `aria-label`。页面缩放（`user-scalable=no`）保持禁用：放开会与编辑器双击、捏合手势冲突，字号改由设置里的编辑器字号控制。
- 清理：删除 `window.__dogeLintCount`、Ctrl+D 主题占位与快捷键表中的 Toggle theme（改列 Ctrl+Space 补全与 Esc 关闭）、调试面板中不存在的 Ctrl+Shift+Enter 提示。
- Toast：窄屏（≤900px）改为底部居中提示条，不再遮挡 Run/设置。
- 初始化竞态：APK 下“新建项目”延迟 800ms 且再次确认仍无文件才弹出；`projectOpened` 开头关闭新建项目弹窗。

验证：

- 前端 `node --check`：通过。
- 纯函数单测（node 抽取函数执行）：`parseDependencyCoordinate`（普通、带 scope、无版本、空版本）、`appendBoundedOutput`（截断长度、截断后不再追加）、`findDiagnosticFile`（绝对路径后缀匹配、精确匹配、同名歧义返回 null、歧义时优先当前文件、不存在返回 null）全部通过。
- `assembleDebug`：通过；`adb install -r`：成功。
- 真机 `HA2K9X7F` 冷启动：UI dump 可见“代码补全”按钮与各按钮 `aria-label`（新建项目、打开项目目录、删除文件等）；logcat 无 `Uncaught/TypeError/ReferenceError/FATAL EXCEPTION`。
- 未在真机交互验证：补全按钮弹出候选、增量渲染与截断（需大输出程序）、导入遮罩 90 秒兜底、Esc/遮罩关闭、键盘弹出光标滚动。验证时设备正处于用户使用中（自由窗口模式，前台为其他应用），未继续自动点击。

## 验证方式

- 前端：抽取 `<script>` 后 `node --check`。
- 构建：`$env:JAVA_HOME='D:\java\jdk-21.0.7'` + `E:\androidSDK`，`android/` 下 `.\.gradle-dist\gradle-8.11.1\bin\gradle.bat --offline -p . :app:assembleDebug`。
- 安装：`adb install -r` 到设备 `HA2K9X7F`（缓存修复生效后覆盖安装即可，无需卸载）。
- 真机回归：F1 未就绪提示、F2 运行中停止、F3 服务无响应熔断、F4 按钮尺寸、F5 tab 高亮、F6 横竖屏、F7 设置钳制。
