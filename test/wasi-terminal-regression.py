"""Verify guest stdio wrapping with real runtime-package headers/libs and host WASI.

This is a Node WASI portability test, not Android WAMR device validation.
"""
import argparse
import pathlib
import queue
import re
import subprocess
import tempfile
import threading
import zipfile

parser = argparse.ArgumentParser()
parser.add_argument('--package', default='release/1.1.2/doge-cpp-arm64-0.1.0.zip')
parser.add_argument('--bin', default=r'E:\androidSDK\ndk\27.2.12479018\toolchains\llvm\prebuilt\windows-x86_64\bin')
parser.add_argument('--cpp', action='store_true', help='Require the C++ check; needs host Clang >=19 matching the runtime libc++ headers')
args = parser.parse_args()
def checked(command):
    result = subprocess.run(command, capture_output=True, text=True, encoding='utf-8', errors='replace')
    if result.returncode:
        raise RuntimeError(result.stderr)
    return result
repo = pathlib.Path(__file__).resolve().parent.parent
source = (repo/'android/app/src/main/java/com/doge/ide/LocalCompiler.java').read_text(encoding='utf-8')
helper_block = source.split('RuntimeCompat.writeBytes(helper, (', 1)[1].split('.getBytes(StandardCharsets.UTF_8)', 1)[0]
import json
helper = ''.join(json.loads(token) for token in re.findall(r'"(?:[^"\\]|\\.)*"', helper_block))
bindir = pathlib.Path(args.bin)
with tempfile.TemporaryDirectory(prefix='doge-real-wasi-') as temp:
    root = pathlib.Path(temp)
    with zipfile.ZipFile(repo/args.package) as package:
        for name in package.namelist():
            if name.endswith('/'):
                continue
            if name.startswith('wasi-sysroot/') or name == 'lib/clang/21/lib/wasm32-wasip1/libclang_rt.builtins.a':
                file = root/name
                if not file.resolve().is_relative_to(root.resolve()):
                    raise ValueError('Unsafe archive path')
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_bytes(package.read(name))
    sysroot = root/'wasi-sysroot'
    libs = sysroot/'lib/wasm32-wasip1'
    (root/'helper.c').write_text(helper, encoding='utf-8')
    (root/'runner.mjs').write_text("import {WASI} from 'node:wasi';import{readFileSync}from'node:fs';const w=new WASI({version:'preview1',args:['main'],env:{},preopens:{}});const m=await WebAssembly.compile(readFileSync(process.argv[2]));const i=await WebAssembly.instantiate(m,{wasi_snapshot_preview1:w.wasiImport});w.start(i);", encoding='utf-8')
    cc = [str(bindir/'clang.exe'), '--target=wasm32-wasip1', '--sysroot='+str(sysroot), '-c']
    checked(cc+[str(root/'helper.c'), '-o', str(root/'helper.o')])
    version = checked([str(bindir/'clang.exe'), '--version']).stdout
    major = int(re.search(r'clang version (\d+)', version).group(1))
    if args.cpp and major < 19:
        raise RuntimeError('C++ runtime headers require host Clang >=19; current host is '+str(major))
    cases = ['void', 'int argc, char** argv'] + (['cpp'] if major >= 19 else [])
    if major < 19:
        print('SKIP C++ host execution: NDK host Clang '+str(major)+' cannot compile runtime libc++ 21 headers; Android runtime uses Clang 21')
    for signature in cases:
        cpp = signature == 'cpp'
        code = ('#include <iostream>\nint main(){std::cout<<"PROMPT:";int n=0;std::cin>>n;std::cout<<"VALUE:"<<n<<"\\n";return 0;}' if cpp else '#include <stdio.h>\nint main('+signature+'){printf("PROMPT:");int n=0;if(scanf("%d",&n)!=1)return 2;printf("VALUE:%d\\n",n);return 0;}')
        (root/'main.c').write_text(code, encoding='utf-8')
        extra = ['-x','c++','-std=c++20','-fno-exceptions','-fno-rtti','-I'+str(sysroot/'include/wasm32-wasip1/c++/v1')] if cpp else []
        checked(cc+extra+[str(root/'main.c'), '-o', str(root/'main.o')])
        libraries = ['-lc++','-lc++abi','-lc'] if cpp else ['-lc']
        checked([str(bindir/'wasm-ld.exe'), '--entry=_start', '--wrap=__main_void', str(root/'main.o'), str(root/'helper.o'), str(libs/'crt1-command.o'), '-L'+str(libs)]+libraries+[str(root/'lib/clang/21/lib/wasm32-wasip1/libclang_rt.builtins.a'), '-o', str(root/'main.wasm')])
        child = subprocess.Popen(['node', '--no-warnings', str(root/'runner.mjs'), str(root/'main.wasm')], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        output = queue.Queue()
        def read():
            while byte := child.stdout.read(1):
                output.put(byte)
        reader = threading.Thread(target=read, daemon=True)
        reader.start()
        try:
            prefix = b''.join(output.get(timeout=5) for _ in range(7))
            if prefix != b'PROMPT:':
                raise AssertionError('Prompt was not flushed before input: '+repr(prefix))
            child.stdin.write(b'42\n'); child.stdin.flush(); child.stdin.close()
            child.wait(timeout=5); reader.join(2)
            tail = b''
            while not output.empty():
                tail += output.get_nowait()
            if child.returncode or tail != b'VALUE:42\n':
                raise AssertionError('Guest execution failed: '+repr(tail)+repr(child.stderr.read()))
            print('PASS real WASI prompt before stdin: main('+signature+')')
        finally:
            if child.poll() is None:
                child.kill(); child.wait()
print('Real WASI stdio: executed cases passed (Node host; Android WAMR remains unverified)')
