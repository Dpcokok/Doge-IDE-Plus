# Doge IDE+ — Android 平板版

> 本地 C/C++ 执行已接入：导入 ARM64 工具链资源包后，编译和运行全部在设备私有目录内完成，
> 不访问云端。下文出现的云端代理、API Key 与 `X-Doge-Upstream` 只属于原云端版迁移背景，
> 不代表当前行为；历史构建校验数据也已单独标注。

把桌面版（Go + WebView2 + 单页 `doge-ide.html`）搬到 Android 平板上：
**Java WebView 壳 + 进程内本地运行时**，不引入第三方 Gradle 依赖，一个进程、一个 APK，
没有多余后台服务；唯一的 native 组件是随包发布的 WAMR（`libiwasm.so`）。

- 目标设备：13 英寸平板，**强制横屏**（`sensorLandscape`）
- 最低系统：Android 7.0（API 24）
- `compileSdk 35`，但 `targetSdk` 刻意压到 **28**：target 29+ 会禁止从应用私有目录执行
  导入的工具链，而本地编译正依赖这一行为
- 包名：`com.doge.ide.plus`

## 目录结构

```
android/
  settings.gradle              仓库源（含阿里云镜像注释）
  build.gradle                 AGP 8.7.3
  gradle.properties            JVM 参数 / 关闭 AndroidX（本工程零依赖）
  build-apk.ps1                一键构建脚本（见下）
  app/
    build.gradle               签名、assets 同步（syncWebapp）
    src/main/AndroidManifest.xml
    src/main/cpp/wasm_runner.c  WAMR JNI 执行入口（WASI stdin/stdout/stderr 与超时）
    src/main/jniLibs/arm64-v8a/libiwasm.so
    src/main/java/com/doge/ide/
      MainActivity.java        WebView、沉浸式全屏、返回键、资源包导入、SAF 项目目录
      LocalServer.java         127.0.0.1 迷你 HTTP 服务
      LocalCompiler.java       调用资源包里的 Clang / wasm-ld 编译并链接 WASI
      NativeWasmRunner.java    加载 native 库，桥接 WAMR 执行 wasm
    src/main/res/...           主题、颜色、文案、启动图标、网络安全配置
```

## 构建

前置条件：**JDK 17～21**（AGP 8.7 要求；JDK 25 之类的版本会被 Gradle 拒绝）。
Android SDK 不需要预先装好，脚本可以按需下载。

```powershell
# 交互式：缺什么装什么，然后构建 release
pwsh -File android\build-apk.ps1

# 只构建 debug
pwsh -File android\build-apk.ps1 -Task assembleDebug

# 指定 SDK / JDK，跳过自动安装
pwsh -File android\build-apk.ps1 -SdkRoot "D:\Android\Sdk" -JdkPath "C:\Program Files\Java\jdk-17"

# 允许脚本下载 commandline-tools 并接受 licenses
pwsh -File android\build-apk.ps1 -InstallSdk
```

脚本做的事：

1. 校验 JDK 主版本在 17～21；
2. 找 `ANDROID_SDK_ROOT` / `local.properties` / 常见安装路径，没有就（可选）下载 commandline-tools 到 `%LOCALAPPDATA%`；
3. 安装 `platform-tools`、`platforms;android-35`、`build-tools;35.0.0`，写 `android/local.properties`；
4. 找 Gradle ≥ 8.9，没有就下载发行版到 `android/.gradle-dist`；
5. 跑 `gradle -p android <Task>`，打印 APK 路径、大小和 `adb install` 命令。

产物：`assembleRelease` 输出 `android/app/build/outputs/apk/release/app-release.apk`，
`assembleDebug` 输出 `android/app/build/outputs/apk/debug/app-debug.apk`。本地运行版打进
了 `libiwasm.so` 等 native 库，体积明显大于早期只含 `web/` 的云端壳；具体大小以
`release/<版本>/RELEASE-NOTES.md` 记录为准。

## 正式签名

`app/build.gradle` 会自动读 `android/keystore.properties`（该文件已在 `.gitignore` 里）：

```properties
storeFile=doge-release.jks
storePassword=******
keyAlias=doge
keyPassword=******
```

`storeFile` 相对 `android/` 解析，所以上面这个写法指的就是 `android/doge-release.jks`。

没有这个文件时 `assembleRelease` 会失败，防止意外产出 debug 签名的 release APK。测试构建请使用 `assembleDebug`。生成 keystore：

```powershell
keytool -genkeypair -v -keystore android\doge-release.jks -alias doge `
        -keyalg RSA -keysize 2048 -validity 10000
```

## 运行时结构

APK 里的 assets 就是仓库根目录的 `doge-ide.html`（构建时改名为 `index.html`）
加 `web/**`，由 Gradle 的 `syncWebapp` 任务同步，改前端只需要重新跑一次构建，不必手动复制。

页面请求的 `/api/v1/execution/run` 由同源的 `LocalServer` 交给 `LocalCompiler` 在本机执行：
按 `entry` 定位入口文件，逐个源文件调用资源包里的 Clang 编成对象文件，再用 `wasm-ld`
统一链接成 WASI 模块，最后交给 `NativeWasmRunner`（WAMR）在设备上运行，把 stdout /
stderr 和退出码回传页面。资源包未导入时返回 `runtime_not_ready`（HTTP 503），页面据此
提示先导入；编译、链接、运行都带超时，避免界面一直转。

`MainActivity` 启动后拉起 `LocalServer`，然后让 WebView 打开
`http://127.0.0.1:8787`（8787 被占用时自动退到随机端口）。这样做的好处：

- 页面与接口**同源**，不触发 CORS，也不用给 `file://` 放开跨域；
- `localStorage`、缓存、`fetch` 行为跟桌面版一致；
- 执行发生在设备本地，页面不需要 API Key 或自定义 endpoint，接口路径与桌面版保持一致。

`LocalServer` 只监听 `127.0.0.1`，8 个工作线程，HTTP/1.1 keep-alive，
静态资源带 `max-age=86400`，API 响应 `no-store`。

## 项目工作区

`local-runtime` 已加入本地项目基础模型：WebView 使用 `localStorage` 保存草稿文件列表
和内容，编辑器左侧显示文件列表，支持切换、新建和删除 C/C++ 源文件或头文件。执行器
会把全部项目文件写入工作目录，只编译 `.c/.cc/.cpp/.cxx`，头文件供 `#include` 使用，
再统一链接为 WASI 程序。

Android 版支持通过 Storage Access Framework 的“打开项目”选择真实目录。目录访问权限
会持久化，打开时先递归扫描目录里的 `.c/.cc/.cpp/.cxx/.h/.hh/.hpp/.hxx`，再按
`.doge-project.json` 清单补充文件顺序和项目名（清单外新增的源文件/头文件也会被合并进
来，不会重复）；清单缺失或损坏时直接以扫描结果降级打开，不会卡死。“保存项目”会把
当前文件写回该目录，并删除上一份清单中已从项目移除的旧文件（清单损坏时无从判断归属，
不执行删除，保存会重写清单），不需要申请传统存储权限。

当前仍是轻量工作区：尚未接入增量编译、CMake、clangd 或 Git 操作。默认项目包含
`main.c`、`math.c` 和 `math.h`，用于验证多文件编译链路。

## 平板适配要点（`doge-ide.html`）

- viewport 锁定缩放，`viewport-fit=cover` + `interactive-widget=resizes-content`；
- 布局高度用 `100dvh`，禁用 overscroll 回弹；
- `@media (pointer: coarse)` 放大点击区域（≥ 44px）、隐藏键位提示、禁用 hover 效果；
- `visualViewport` 监听软键盘，弹键盘时给 `<body>` 加 `kb-open` 让输出区自动让位；
- 视口 ≤ 900px 时左右面板改为上下堆叠；高度 ≤ 560px 时进一步压缩；
- 编辑器字号可在设置里调（触摸设备默认 15px，桌面 14px），写入 `localStorage`；
- CodeMirror 关掉 `dragDrop`（否则平板长按拖拽会乱跳）、留 30 行预渲染；
- 输出面板改用 Pointer Events，鼠标 / 触摸 / 触控笔都能拖。

## 已验证 / 未验证

> 下面“整包构建”和 APK 校验的记录来自**原云端版**（release 产物 targetSdk 35、约
> 0.36 MB），只说明当时的 WebView 壳能构建；本地运行时加入 native 库、资源包导入和
> 项目目录工作区后，产物与校验项都已变化。local-runtime 的当前状态与验证见
> `release/1.0.1/RELEASE-NOTES.md` 和 `report/IDE-GAP-REPORT-1.0.0.md`。

**整包构建已在 Windows 上实际跑通**：`build-apk.ps1` 从零装好 SDK 并完成
`assembleDebug` 与 `assembleRelease`（已知可用组合：JDK 21 Zulu 21.0.8 +
Android SDK 35 + Gradle 8.11.1 + AGP 8.7.3，构建全程无本工程自身的弃用警告）。

对云端版 `app-release.apk`（372,571 字节）做过这些校验：

- `aapt2 dump badging`：`com.doge.ide`、minSdk 24、targetSdk 35（云端版）、横屏、
  入口 `MainActivity`、label `Doge IDE`；
- `apksigner verify`：v2 签名校验通过（未配置 keystore 时用的是 debug 证书）；
- APK 内 20 个 assets 与仓库文件一一对应，且 `assets/index.html` 的 SHA-256
  与 `doge-ide.html` 完全一致；
- `dexdump`：`MainActivity` / `LocalServer` 及其内部类都在 `classes.dex` 里。

`LocalServer` 另用 Android stub 编译（`javac` 0 error）并在普通 JVM 上跑通：

- 静态资源：`/`、CSS、JS、WOFF2 的状态码与 MIME 正确，404 / 405 / 路径穿越正确；
- keep-alive：单连接连续 6 个请求（POST + GET 混排）全部正常，`Connection: close` 正常；
- 并发：8 个并发 POST 无串包。

`proxy.py` / `proxy.mjs`（桌面浏览器开发模式用的本地代理，**不是 Android 路径**）
保留 `X-Doge-Upstream` 与 `Authorization` 转发能力，行为和桌面 Go 壳一致。

**尚未验证**：真机或模拟器上的实际运行（当前没有连接设备）、触摸手势手感、
软键盘弹出时的布局表现，以及首次冷启动耗时。
