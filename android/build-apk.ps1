<#
.SYNOPSIS
    构建 Doge IDE 的 Android APK（13 寸平板横屏版）。

.DESCRIPTION
    自动完成：JDK 检查 -> Android SDK 定位/安装 -> Gradle 定位/下载 -> 打包 -> 打印 APK 路径。
    页面与 web 资源由 Gradle 的 syncWebapp 任务从仓库根目录直接打进 APK。

.PARAMETER Task
    Gradle 任务，默认 assembleRelease；调试用 assembleDebug。

.PARAMETER SdkRoot
    Android SDK 路径。缺省按 $env:ANDROID_SDK_ROOT -> $env:ANDROID_HOME -> %LOCALAPPDATA%\Android\Sdk 查找。

.PARAMETER JdkPath
    JDK 根目录（需含 bin\java.exe，17~21）。缺省用 $env:JAVA_HOME 或 PATH 上的 java。

.PARAMETER InstallSdk
    本机没有 SDK 时，自动下载 command-line tools 并安装 platform-tools / android-35 / build-tools。

.PARAMETER GradleVersion
    需要下载的 Gradle 版本（PATH 上的 gradle 低于 8.9 时才下载）。默认 8.11.1。

.EXAMPLE
    pwsh -File android\build-apk.ps1
.EXAMPLE
    pwsh -File android\build-apk.ps1 -InstallSdk -Task assembleDebug
#>
[CmdletBinding()]
param(
    [string]$Task = 'assembleRelease',
    [string]$SdkRoot,
    [string]$JdkPath,
    [switch]$InstallSdk,
    [string]$GradleVersion = '8.11.1'
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$androidDir = $PSScriptRoot
$repoRoot = Split-Path -Parent $androidDir
$distDir = Join-Path $androidDir '.gradle-dist'
$minGradle = [version]'8.9'

function Write-Step($msg) { Write-Host "`n== $msg" -ForegroundColor Cyan }
function Get-JavaMajor($javaExe) {
    try {
        $line = (& $javaExe -version 2>&1 | Select-Object -First 1) -join ''
        if ($line -match '"(\d+)') { return [int]$Matches[1] }
    } catch { }
    return 0
}

# ---------------------------------------------------------------- JDK
Write-Step '检查 JDK'
$javaHome = $JdkPath
if (-not $javaHome) {
    if ($env:JAVA_HOME) { $javaHome = $env:JAVA_HOME }
    else {
        $javaCmd = Get-Command java -ErrorAction SilentlyContinue
        if ($javaCmd) { $javaHome = Split-Path -Parent (Split-Path -Parent $javaCmd.Source) }
    }
}
if (-not $javaHome -or -not (Test-Path (Join-Path $javaHome 'bin\java.exe'))) {
    throw '找不到 JDK。请安装 17~21：winget install Microsoft.OpenJDK.21，或用 -JdkPath 指定路径。'
}
$javaMajor = Get-JavaMajor (Join-Path $javaHome 'bin\java.exe')
if ($javaMajor -lt 17 -or $javaMajor -gt 21) {
    throw "需要 JDK 17~21（当前 $javaMajor）。AGP 8.7 不支持更高版本：winget install Microsoft.OpenJDK.21，或用 -JdkPath 指定。"
}
$env:JAVA_HOME = $javaHome
Write-Host "JAVA_HOME = $javaHome (JDK $javaMajor)"

# ---------------------------------------------------------------- Android SDK
Write-Step '定位 Android SDK'
if (-not $SdkRoot) {
    foreach ($candidate in @($env:ANDROID_SDK_ROOT, $env:ANDROID_HOME, (Join-Path $env:LOCALAPPDATA 'Android\Sdk'))) {
        if ($candidate -and (Test-Path $candidate)) { $SdkRoot = $candidate; break }
    }
}

$cmdlineUrl = 'https://dl.google.com/android/repository/commandlinetools-win-11076708_latest.zip'
if ($SdkRoot -and (Test-Path $SdkRoot) -and (Test-Path (Join-Path $SdkRoot 'platforms\android-35')) -and
    (Get-ChildItem (Join-Path $SdkRoot 'build-tools') -ErrorAction SilentlyContinue)) {
    Write-Host "SDK 就绪：$SdkRoot"
} else {
    if (-not $InstallSdk) {
        throw "未找到可用的 Android SDK（需要 platform android-35 与 build-tools）。`n请安装 Android Studio，或用 -InstallSdk 让本脚本自动下载安装。"
    }
    if (-not $SdkRoot) { $SdkRoot = Join-Path $env:LOCALAPPDATA 'Android\Sdk' }
    Write-Step "安装 Android SDK -> $SdkRoot"
    New-Item -ItemType Directory -Force -Path $SdkRoot | Out-Null

    $sdkManager = Join-Path $SdkRoot 'cmdline-tools\latest\bin\sdkmanager.bat'
    if (-not (Test-Path $sdkManager)) {
        $zip = Join-Path $env:TEMP 'commandlinetools-win.zip'
        if (-not (Test-Path $zip)) {
            Write-Host "下载 $cmdlineUrl"
            Invoke-WebRequest -Uri $cmdlineUrl -OutFile $zip
        }
        # zip 内部多一层 cmdline-tools/：直接解到 SDK 下，再把该层改名成 latest
        $toolsRoot = Join-Path $SdkRoot 'cmdline-tools'
        New-Item -ItemType Directory -Force -Path $toolsRoot | Out-Null
        Expand-Archive -Path $zip -DestinationPath $toolsRoot -Force
        $staged = Join-Path $toolsRoot 'cmdline-tools'
        $latest = Join-Path $toolsRoot 'latest'
        if (Test-Path $latest) { Remove-Item -Recurse -Force $latest }
        Move-Item -Path $staged -Destination $latest
    }

    Write-Host '接受 licenses'
    1..40 | ForEach-Object { 'y' } | & $sdkManager "--sdk_root=$SdkRoot" --licenses | Out-Null
    Write-Host '安装 platform-tools / platforms;android-35 / build-tools;35.0.0'
    & $sdkManager "--sdk_root=$SdkRoot" 'platform-tools' 'platforms;android-35' 'build-tools;35.0.0'
    if ($LASTEXITCODE -ne 0) { throw "sdkmanager 失败（exit $LASTEXITCODE）" }
}

$localProps = Join-Path $androidDir 'local.properties'
$sdkDirEscaped = $SdkRoot.Replace('\', '\\')
# 明确用无 BOM 的 UTF-8，否则 Gradle 读 sdk.dir 会带上不可见字符
[System.IO.File]::WriteAllText($localProps, "sdk.dir=$sdkDirEscaped`n", (New-Object System.Text.UTF8Encoding $false))
Write-Host "local.properties -> sdk.dir=$SdkRoot"

# ---------------------------------------------------------------- Gradle
Write-Step '定位 Gradle'
$gradleCmd = $null
$onPath = Get-Command gradle -ErrorAction SilentlyContinue
if ($onPath) {
    try {
        $verLine = (& $onPath.Source --version 2>&1 | Select-String -Pattern '^Gradle\s+(\d+\.\d+)').Matches
        if ($verLine.Count -gt 0 -and [version]$verLine[0].Groups[1].Value -ge $minGradle) {
            $gradleCmd = $onPath.Source
            Write-Host "使用 PATH 上的 Gradle $($verLine[0].Groups[1].Value)"
        }
    } catch { }
}
if (-not $gradleCmd) {
    $gradleHome = Join-Path $distDir "gradle-$GradleVersion"
    $gradleCmd = Join-Path $gradleHome 'bin\gradle.bat'
    if (-not (Test-Path $gradleCmd)) {
        $zip = Join-Path $distDir "gradle-$GradleVersion-bin.zip"
        New-Item -ItemType Directory -Force -Path $distDir | Out-Null
        if (-not (Test-Path $zip)) {
            $url = "https://services.gradle.org/distributions/gradle-$GradleVersion-bin.zip"
            Write-Host "下载 $url"
            Invoke-WebRequest -Uri $url -OutFile $zip
        }
        Write-Host '解压 Gradle'
        Expand-Archive -Path $zip -DestinationPath $distDir -Force
    }
    Write-Host "使用本地 Gradle $GradleVersion"
}

# ---------------------------------------------------------------- Build
Write-Step "Gradle: $Task （首次构建会下载 AGP 等依赖）"
& $gradleCmd -p $androidDir $Task
if ($LASTEXITCODE -ne 0) { throw "Gradle 构建失败（exit $LASTEXITCODE）" }

$apk = Get-ChildItem -Path (Join-Path $androidDir 'app\build\outputs\apk') -Recurse -Filter '*.apk' -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $apk) { throw '构建结束但没有找到 APK，检查上面的日志。' }

$mb = [math]::Round($apk.Length / 1MB, 2)
Write-Host "`nAPK: $($apk.FullName)  ($mb MB)" -ForegroundColor Green
if (-not (Test-Path (Join-Path $androidDir 'keystore.properties')) -and $Task -eq 'assembleRelease') {
    Write-Host '注意：当前用 debug key 签名（仅自用可装；上架/长期使用请配置 keystore.properties）' -ForegroundColor Yellow
}
Write-Host "安装：adb install -r `"$($apk.FullName)`""
