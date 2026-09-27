# Doge IDE+ — Android 平板版

> local-runtime 分支正在迁移本地 C/C++ 执行。现阶段 Run 只访问本机接口，
> 执行器未接入前会明确报告未就绪；下文云端代理与已验证产物的描述属于原云端版历史记录。

把桌面版（Go + WebView2 + 单页 `doge-ide.html`）原样搬到 Android 平板上：
**纯 Java WebView 壳 + 零第三方依赖**，一个进程、一个 APK，没有多余后台服务。

- 目标设备：13 英寸平板，**强制横屏**（`sensorLandscape`）
- 最低系统：Android 7.0（API 24），目标 API 35
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
    src/main/java/com/doge/ide/
      MainActivity.java        WebView、沉浸式全屏、返回键、外部链接
       LocalServer.java         127.0.0.1 迷你 HTTP 服务
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

产物：`android/app/build/outputs/apk/release/app-release.apk`（约 0.36 MB，
绝大部分体积是 `web/` 里的 CodeMirror 与字体；debug 包约 0.38 MB）。

## 正式签名

`app/build.gradle` 会自动读 `android/keystore.properties`（该文件已在 `.gitignore` 里）：

```properties
storeFile=doge-release.jks
storePassword=******
keyAlias=doge
keyPassword=******
```

`storeFile` 相对 `android/` 解析，所以上面这个写法指的就是 `android/doge-release.jks`。

没这个文件时 release 包会退回用 debug 签名——**能装、能跑，但上架前必须换掉**。
生成 keystore：

```powershell
keytool -genkeypair -v -keystore android\doge-release.jks -alias doge `
        -keyalg RSA -keysize 2048 -validity 10000
```

## 运行时结构

APK 里的 assets 就是仓库根目录的 `doge-ide.html`（构建时改名为 `index.html`）
加 `web/**`，由 Gradle 的 `syncWebapp` 任务同步，改前端只需要重新跑一次构建，不必手动复制。

云端沙盒偶尔会返回 `tool_unavailable`（容器创建进程/线程被 cgroup 限制，报文里是
`Resource temporarily unavailable (os error 11)`）或 HTTP 429，页面会自动重试最多 5 次
（退避 0.4s 递增）；单次请求还有硬超时（设置里的执行超时 + 30s），超时即中止重试，
保证界面不会一直转，仍然失败才把原始错误显示到输出面板。

`MainActivity` 启动后拉起 `LocalServer`，然后让 WebView 打开
`http://127.0.0.1:8787`（8787 被占用时自动退到随机端口）。这样做的好处：

- 页面与接口**同源**，不触发 CORS，也不用给 `file://` 放开跨域；
- `localStorage`、缓存、`fetch` 行为跟桌面版一致；
- `/api/v1/execution/run` 由 `LocalServer` 用 `HttpURLConnection` 转发到云端沙盒，
  `Authorization`（API Key）与页面里设置的自定义 endpoint 都会带过去。

自定义 endpoint 通过同源请求头 `X-Doge-Upstream` 传给 `LocalServer`，
只接受 `http`/`https` 且长度 ≤ 2048，否则回落到默认地址。

`LocalServer` 只监听 `127.0.0.1`，8 个工作线程，HTTP/1.1 keep-alive，
静态资源带 `max-age=86400`，API 响应 `no-store`。

## 1.1 项目工作区（开发中）

`local-runtime` 的下一阶段已加入本地项目基础模型：WebView 使用 `localStorage`
保存项目文件列表和内容，编辑器左侧显示文件列表，支持切换、新建和删除 C/C++
源文件或头文件。Android 执行器会把头文件写入工作目录，逐个编译源文件，再统一
链接为 WASI 程序。

Android 版还支持通过 Storage Access Framework 的“打开项目”选择真实目录。目录
访问权限会持久化，打开时递归读取 `.c/.cc/.cpp/.cxx/.h/.hh/.hpp/.hxx` 文件，
“保存项目”会把当前文件内容写回该目录，不需要申请传统存储权限。

当前仍是轻量工作区：保存不会删除磁盘上已经移除的旧文件，尚未接入增量编译、
CMake、clangd 或 Git 操作。默认项目包含 `main.c`、`math.c` 和 `math.h`，用于
验证多文件编译链路。

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

**整包构建已在 Windows 上实际跑通**：`build-apk.ps1` 从零装好 SDK 并完成
`assembleDebug` 与 `assembleRelease`（已知可用组合：JDK 21 Zulu 21.0.8 +
Android SDK 35 + Gradle 8.11.1 + AGP 8.7.3，构建全程无本工程自身的弃用警告）。

对 `app-release.apk`（372,571 字节）做过这些校验：

- `aapt2 dump badging`：`com.doge.ide`、minSdk 24、targetSdk 35、横屏、
  入口 `MainActivity`、label `Doge IDE`；
- `apksigner verify`：v2 签名校验通过（未配置 keystore 时用的是 debug 证书）；
- APK 内 20 个 assets 与仓库文件一一对应，且 `assets/index.html` 的 SHA-256
  与 `doge-ide.html` 完全一致；
- `dexdump`：`MainActivity` / `LocalServer` 及其内部类都在 `classes.dex` 里。

`LocalServer` 另用 Android stub 编译（`javac` 0 error）并在普通 JVM 上跑通：

- 静态资源：`/`、CSS、JS、WOFF2 的状态码与 MIME 正确，404 / 405 / 路径穿越正确；
- 代理：POST 精确转发 body（长度逐字节一致）、`Authorization` 与 `X-Doge-Upstream` 正确、
  chunked 请求可用、上游挂掉时返回 502 JSON；
- keep-alive：单连接连续 6 个请求（POST + GET 混排）全部正常，`Connection: close` 正常；
- 并发：8 个并发 POST 无串包。

`proxy.py` / `proxy.mjs`（浏览器开发模式用的本地代理）也已同步支持
`X-Doge-Upstream` 与 `Authorization`，行为和 Go / Android 壳一致。

**尚未验证**：真机或模拟器上的实际运行（当前没有连接设备）、触摸手势手感、
软键盘弹出时的布局表现，以及首次冷启动耗时。
