# Doge IDE - build script (Windows)
# Usage:
#   pwsh -File exe/build.ps1            # release build -> exe/DogeIDE.exe
#   pwsh -File exe/build.ps1 -Debug     # console debug build -> exe/DogeIDE-debug.exe
param(
    [switch]$Debug,
    [switch]$SkipIcon
)

$ErrorActionPreference = 'Stop'
$exeDir = $PSScriptRoot
$root = Split-Path -Parent $exeDir
Set-Location $root

# --- Go toolchain: prefer the bundled one in exe/.toolchain, fall back to PATH ---
$go = Join-Path $exeDir '.toolchain\go\bin\go.exe'
if (-not (Test-Path $go)) {
    $cmd = Get-Command go -ErrorAction SilentlyContinue
    if (-not $cmd) { throw "Go toolchain not found. Run: winget install GoLang.Go  (or download portable Go into exe/.toolchain)" }
    $go = $cmd.Source
}

# --- Keep all caches inside exe/.tmp ---
$env:GOTOOLCHAIN = 'local'
if (-not $env:GOPROXY) { $env:GOPROXY = 'https://goproxy.cn,direct' }
$env:GOCACHE = Join-Path $exeDir '.tmp\gocache'
$env:GOMODCACHE = Join-Path $exeDir '.tmp\gomodcache'
$env:GOPATH = Join-Path $exeDir '.tmp\gopath'
New-Item -ItemType Directory -Force -Path (Join-Path $exeDir '.tmp') | Out-Null

# --- Fonts (vendored); fetch when missing ---
if (-not (Test-Path (Join-Path $root 'web\fonts\geist.css'))) {
    Write-Host 'Fetching fonts...'
    pwsh -NoProfile -File (Join-Path $exeDir 'fetch-fonts.ps1')
}

# --- Icon + version resources ---
if (-not $SkipIcon) {
    $icon = Join-Path $exeDir 'winres\icon.png'
    if (-not (Test-Path $icon)) {
        Write-Host 'Generating icon...'
        node (Join-Path $exeDir 'make-icon.mjs')
    }
    Write-Host 'Building Windows resources...'
    $outBase = Join-Path $exeDir '.tmp\rsrc'
    & $go run github.com/tc-hib/go-winres@latest make --in (Join-Path $exeDir 'winres\winres.json') --out $outBase
    $sysoFiles = @(Get-ChildItem (Join-Path $exeDir '.tmp') -Filter 'rsrc_windows_*.syso')
    if ($sysoFiles.Count -eq 0) { throw 'go-winres did not produce any .syso file' }
    foreach ($s in $sysoFiles) { Copy-Item $s.FullName (Join-Path $root $s.Name) -Force }
    $sysoNames = @($sysoFiles | ForEach-Object { $_.Name })
}

try {
    if ($Debug) {
        $target = Join-Path $exeDir 'DogeIDE-debug.exe'
        Write-Host "Building debug -> $target"
        & $go build -trimpath -o $target .
    } else {
        $target = Join-Path $exeDir 'DogeIDE.exe'
        Write-Host "Building release -> $target"
        & $go build -trimpath -ldflags '-s -w -H=windowsgui' -o $target .
    }
    if ($LASTEXITCODE -ne 0) { throw "go build failed ($LASTEXITCODE)" }
    $item = Get-Item $target
    Write-Host ("Done: {0} ({1:N2} MB)" -f $item.FullName, ($item.Length / 1MB))
} finally {
    if ($sysoNames) { foreach ($n in $sysoNames) { Remove-Item (Join-Path $root $n) -ErrorAction SilentlyContinue } }
}
