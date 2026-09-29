# 批次验证脚本 (每个重构批次结束后运行)
# 用法:
#   pwsh -File test/batch-verify.ps1            # 全部检查
#   pwsh -File test/batch-verify.ps1 -SkipApk   # 跳过构建/安装(只跑前端与桌面)
param([switch]$SkipApk, [switch]$SkipDesktop)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$fail = 0
function Step($name, [scriptblock]$body) {
  Write-Host "── $name ──" -ForegroundColor Cyan
  try { & $body; Write-Host "  OK" -ForegroundColor Green }
  catch { $script:fail++; Write-Host "  FAIL: $_" -ForegroundColor Red }
}

# 1. 前端 JS 语法检查
Step '前端 node --check' {
  $t = [IO.File]::ReadAllText((Join-Path $root 'doge-ide.html'))
  # 取最后一个(主)内联脚本；<head> 里的早期主题脚本不做语法检查
  $ms = [regex]::Matches($t, '<script>([\s\S]*?)</script>')
  if ($ms.Count -eq 0) { throw 'no <script> block' }
  $body = ($ms | Sort-Object { $_.Groups[1].Value.Length } | Select-Object -Last 1).Groups[1].Value
  $tmp = Join-Path $env:TEMP 'doge-batch-check.js'
  [IO.File]::WriteAllText($tmp, $body, (New-Object Text.UTF8Encoding $false))
  & node --check $tmp
  if ($LASTEXITCODE -ne 0) { throw "node --check exit $LASTEXITCODE" }
  Remove-Item $tmp -ErrorAction SilentlyContinue
}

# 2. 前端基线单测 + 接口契约 + 行为不变量
Step '前端基线测试' {
  & node (Join-Path $root 'test/frontend-baseline.mjs')
  if ($LASTEXITCODE -ne 0) { throw "baseline exit $LASTEXITCODE" }
}

# 2b. 浏览器冒烟(headless Edge/Chrome 真实驱动；找不到浏览器时自动跳过)
#     b5：浮层栈、键盘路由、设置/快捷键/关于、查找、项目搜索
#     b6：多视口布局、触控尺寸、窄屏覆盖层、软键盘、默认主题
Step '浏览器冒烟测试' {
  foreach ($t in 'browser-smoke-b5.mjs', 'browser-smoke-b6.mjs') {
    & node (Join-Path $root "test/$t")
    if ($LASTEXITCODE -ne 0) { throw "$t exit $LASTEXITCODE" }
  }
}

# 3. 桌面版离线编译(共用同一 html)
if (-not $SkipDesktop) {
  Step '桌面版 go build (离线)' {
    $go = Join-Path $root 'exe\.toolchain\go\bin\go.exe'
    if (-not (Test-Path $go)) { throw "go 工具链缺失: $go" }
    $env:GOMODCACHE = Join-Path $root 'exe\.tmp\gomodcache'
    $env:GOPATH = Join-Path $root 'exe\.tmp\gopath'
    $env:GOPROXY = 'off'; $env:GOFLAGS = '-mod=mod'
    $out = Join-Path $env:TEMP 'doge-desktop-check.exe'
    & $go build -o $out $root
    if ($LASTEXITCODE -ne 0) { throw "go build exit $LASTEXITCODE" }
    Remove-Item $out -ErrorAction SilentlyContinue
  }
}

# 4. APK 构建 + 安装 + 冷启动 logcat
if (-not $SkipApk) {
  Step 'APK assembleDebug' {
    $env:JAVA_HOME = 'D:\java\jdk-21.0.7'
    $env:PATH = "$env:JAVA_HOME\bin;$env:PATH"
    $env:ANDROID_SDK_ROOT = 'E:\androidSDK'; $env:ANDROID_HOME = 'E:\androidSDK'
    Push-Location (Join-Path $root 'android')
    try {
      & .\.gradle-dist\gradle-8.11.1\bin\gradle.bat --offline -q -p . :app:assembleDebug
      if ($LASTEXITCODE -ne 0) { throw "gradle exit $LASTEXITCODE" }
    } finally { Pop-Location }
  }
  Step 'APK 安装 + 冷启动无 JS 错误' {
    $adb = 'E:\androidSDK\platform-tools\adb.exe'
    $apk = Join-Path $root 'android\app\build\outputs\apk\debug\app-debug.apk'
    $dev = (& $adb devices) -match '\tdevice$'
    if (-not $dev) { Write-Host '  (无连接设备，跳过安装)' -ForegroundColor Yellow; return }
    & $adb install -r $apk | Out-Null
    & $adb logcat -c
    & $adb shell am force-stop com.doge.ide.plus.debug | Out-Null
    & $adb shell monkey -p com.doge.ide.plus.debug -c android.intent.category.LAUNCHER 1 2>&1 | Out-Null
    Start-Sleep -Seconds 5
    $bad = (& $adb logcat -d) | Select-String -Pattern 'Uncaught|TypeError|ReferenceError|FATAL EXCEPTION'
    if ($bad) { throw "启动日志出现错误: $($bad[0])" }
  }
}

Write-Host ''
if ($fail) { Write-Host "批次验证: $fail 项失败" -ForegroundColor Red; exit 1 }
Write-Host '批次验证: 全部通过' -ForegroundColor Green
