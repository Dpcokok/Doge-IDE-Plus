# 构建 Doge IDE+ Python 运行库包（doge-python-arm64-<版本>.zip），可重复执行。
# 用法：pwsh -File tools/python-runtime/build-python-runtime.ps1 [-Ndk <ndk 根目录>] [-HostPython <python.exe>] [-OutDir release/python]
param(
    [string]$Ndk = 'E:\androidSDK\ndk\27.2.12479018',
    [string]$HostPython = 'python',
    [string]$OutDir = (Join-Path $PSScriptRoot '..\..\release\python')
)
$ErrorActionPreference = 'Stop'
$Version = '3.14.8'
$Short = '3.14'
$Url = "https://www.python.org/ftp/python/$Version/python-$Version-aarch64-linux-android.tar.gz"
$Sha = '11324313957DA3736F44E90257304D288864321A4DD376ED0CC35A54EACF9A33'
# 平板用不到、体积大的标准库目录
$Drop = 'test', 'idlelib', 'tkinter', 'turtledemo', 'ensurepip', 'lib2to3', 'pydoc_data', '__phello__', 'turtle.py'

$work = Join-Path ([IO.Path]::GetTempPath()) "doge-python-build"
$tar = Join-Path $work "python-$Version.tar.gz"
$src = Join-Path $work 'src'
$stage = Join-Path $work 'stage'
New-Item -ItemType Directory -Force $work | Out-Null

# 1. 下载并核对官方包
if (!(Test-Path $tar) -or (Get-FileHash $tar -Algorithm SHA256).Hash -ne $Sha) {
    Write-Host "下载 $Url"
    Invoke-WebRequest -Uri $Url -OutFile $tar -TimeoutSec 600
}
if ((Get-FileHash $tar -Algorithm SHA256).Hash -ne $Sha) { throw "官方包 SHA-256 不符" }
Remove-Item -Recurse -Force $src, $stage -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $src, "$stage/bin", "$stage/prefix/lib" | Out-Null
# Windows 的 tar 建不了符号链接（libsqlite3.so.0、pkgconfig/*.pc），这些用不到；
# 所以不看退出码，只检查真正需要的文件
tar -xzf $tar -C $src 2>$null
$prefix = Join-Path $src 'prefix'
foreach ($need in "lib/libpython$Short.so", "lib/libsqlite3_python.so", "lib/libssl_python.so", "lib/python$Short/os.py", "include/python$Short/Python.h") {
    if (!(Test-Path (Join-Path $prefix $need))) { throw "解压后缺少 $need" }
}

# 2. 编译启动器
$cc = Join-Path $Ndk 'toolchains\llvm\prebuilt\windows-x86_64\bin\aarch64-linux-android24-clang.cmd'
if (!(Test-Path $cc)) { throw "找不到 NDK clang: $cc" }
& $cc (Join-Path $PSScriptRoot 'launcher.c') -O2 -o "$stage/bin/doge-python" "-I$prefix/include/python$Short" "-L$prefix/lib" "-lpython$Short" -llog '-Wl,-rpath,$ORIGIN/../prefix/lib'
if ($LASTEXITCODE -ne 0) { throw "启动器编译失败" }

# 3. 共享库 + 裁剪后的标准库
Get-ChildItem "$prefix/lib" -Filter '*.so' | Copy-Item -Destination "$stage/prefix/lib"
Copy-Item -Recurse "$prefix/lib/python$Short" "$stage/prefix/lib/python$Short"
foreach ($d in $Drop) { Remove-Item -Recurse -Force "$stage/prefix/lib/python$Short/$d" -ErrorAction SilentlyContinue }
Get-ChildItem "$stage/prefix/lib/python$Short" -Recurse -Directory -Filter '__pycache__' | Remove-Item -Recurse -Force

# 4. 预编译 .pyc（本机 Python 必须同一个小版本，否则 .pyc 不会被使用）
$hostVer = (& $HostPython -c 'import sys; print("%d.%d" % sys.version_info[:2])').Trim()
if ($hostVer -ne $Short) { throw "本机 Python 是 $hostVer，需要 $Short 才能预编译 .pyc" }
& $HostPython -m compileall -q -j 0 -o 0 --invalidation-mode unchecked-hash -d "/prefix/lib/python$Short" "$stage/prefix/lib/python$Short" | Out-Null
if ($LASTEXITCODE -ne 0) { throw "compileall 失败" }

# 5. manifest（关键文件带 SHA-256）
$checked = @('bin/doge-python', "prefix/lib/libpython$Short.so", "prefix/lib/python$Short/os.py", "prefix/lib/python$Short/site.py")
$sums = [ordered]@{}
foreach ($rel in $checked) { $sums[$rel] = (Get-FileHash (Join-Path $stage $rel) -Algorithm SHA256).Hash.ToLower() }
$manifest = [ordered]@{
    format = 1; kind = 'python'; name = 'Doge Python'; version = $Version; abi = 'arm64-v8a'
    python = 'bin/doge-python'; home = 'prefix'; lib = 'prefix/lib'; sha256 = $sums
}
($manifest | ConvertTo-Json -Depth 4) | Set-Content -Encoding utf8NoBOM (Join-Path $stage 'manifest.json')

# 6. 打包
New-Item -ItemType Directory -Force $OutDir | Out-Null
$zip = Join-Path (Resolve-Path $OutDir) "doge-python-arm64-$Version.zip"
Remove-Item -Force $zip -ErrorAction SilentlyContinue
Add-Type -AssemblyName System.IO.Compression.FileSystem
[IO.Compression.ZipFile]::CreateFromDirectory($stage, $zip, [IO.Compression.CompressionLevel]::Optimal, $false)
$files = (Get-ChildItem $stage -Recurse -File).Count
"{0}`n  文件 {1} 个，{2:N1} MB，SHA-256 {3}" -f $zip, $files, ((Get-Item $zip).Length / 1MB), (Get-FileHash $zip -Algorithm SHA256).Hash
