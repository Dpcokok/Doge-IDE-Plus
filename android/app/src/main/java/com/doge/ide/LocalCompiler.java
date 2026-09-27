package com.doge.ide;

import android.content.Context;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.concurrent.TimeUnit;

/** Compiles one C/C++ source file to a WASI module using the imported toolchain. */
final class LocalCompiler {
    private static final long MAX_OUTPUT = 2L * 1024L * 1024L;
    private final File filesDir;

    LocalCompiler(Context context) {
        filesDir = context.getApplicationContext().getFilesDir();
    }

    String execute(String requestJson) {
        try {
            JSONObject request = new JSONObject(requestJson);
            String language = request.optString("language", "");
            String code = request.optString("code", "");
            String stdin = request.optString("stdin", "");
            int timeout = Math.max(1000, Math.min(30000, request.optInt("timeout_ms", 30000)));
            if (!"c".equals(language) && !"cpp".equals(language)) {
                return error("invalid_request", "仅支持 C 和 C++");
            }
            File toolchain = new File(filesDir, "toolchain");
            File manifest = new File(toolchain, "manifest.json");
            if (!manifest.isFile()) {
                return error("runtime_not_ready", "请先导入 C/C++ 资源包");
            }
            JSONObject meta = new JSONObject(new String(Files.readAllBytes(manifest.toPath()), StandardCharsets.UTF_8));
            String clangRelative = meta.optString("clang", "bin/clang");
            String sysrootRelative = meta.optString("sysroot", "wasi-sysroot");
            File clang = safeChild(toolchain, clangRelative);
            File sysroot = safeChild(toolchain, sysrootRelative);
            if (!clang.isFile() || !sysroot.isDirectory()) return error("runtime_not_ready", "资源包缺少 Clang 或 WASI sysroot");
            for (String executable : new String[]{"clang", "clang++", "clang-21", "clang++-21", "wasm-ld", "ld.lld"}) {
                File candidate = new File(toolchain, "bin/" + executable);
                if (candidate.isFile()) candidate.setExecutable(true, false);
            }
            File work = new File(filesDir, "runs");
            if (!work.isDirectory() && !work.mkdirs()) return error("runtime_error", "无法创建编译目录");
            File source = new File(work, "main." + ("cpp".equals(language) ? "cpp" : "c"));
            File object = new File(work, "main.o");
            File wasm = new File(work, "main.wasm");
            Files.write(source.toPath(), code.getBytes(StandardCharsets.UTF_8));
            Files.deleteIfExists(object.toPath());
            Files.deleteIfExists(wasm.toPath());

            String target = "wasm32-wasip1";
            File clangExecutable = new File(toolchain, "bin/" + ("cpp".equals(language) ? "clang++" : "clang"));
            ProcessBuilder compiler = new ProcessBuilder(
                    clangExecutable.getAbsolutePath(), "--target=" + target, "--sysroot=" + sysroot.getAbsolutePath(),
                    "-O2", "-std=" + ("cpp".equals(language) ? "c++20" : "c17"),
                    "-fno-exceptions", "-fno-rtti", "-c", source.getAbsolutePath(), "-o", object.getAbsolutePath());
            compiler.directory(work);
            compiler.environment().put("HOME", filesDir.getAbsolutePath());
            compiler.environment().put("TMPDIR", work.getAbsolutePath());
            compiler.environment().put("PATH", new File(toolchain, "bin").getAbsolutePath());
            compiler.environment().put("LD_LIBRARY_PATH", new File(toolchain, "lib").getAbsolutePath());
            compiler.environment().put("PWD", work.getAbsolutePath());
            compiler.environment().put("LLVM_CONFIG_FILE", new File(toolchain, "lib/llvm-config").getAbsolutePath());
            Process process = compiler.redirectErrorStream(false).start();
            ByteArrayOutputStream stdout = new ByteArrayOutputStream();
            ByteArrayOutputStream stderr = new ByteArrayOutputStream();
            Thread outReader = drain(process.getInputStream(), stdout);
            Thread errReader = drain(process.getErrorStream(), stderr);
            boolean finished = process.waitFor(timeout, TimeUnit.MILLISECONDS);
            if (!finished) {
                process.destroyForcibly();
                outReader.join(1000); errReader.join(1000);
                return result("timeout", "", stderr.toString(StandardCharsets.UTF_8), -1);
            }
            outReader.join(1000); errReader.join(1000);
            String compileError = stderr.toString(StandardCharsets.UTF_8);
            if (process.exitValue() != 0 || !object.isFile()) return result("compile_error", "", compileError, process.exitValue());
            File linker = new File(toolchain, "bin/wasm-ld");
            File wasiLib = new File(sysroot, "lib/wasm32-wasip1");
            File crt = new File(wasiLib, "crt1-command.o");
            File builtins = new File(toolchain, "lib/clang/21/lib/wasm32-wasip1/libclang_rt.builtins.a");
            ProcessBuilder link;
            if ("cpp".equals(language)) {
                link = new ProcessBuilder(linker.getAbsolutePath(), "--entry=_start", object.getAbsolutePath(), crt.getAbsolutePath(),
                        "-L" + wasiLib.getAbsolutePath(), "-lc++", "-lc++abi", "-lc", builtins.getAbsolutePath(), "-o", wasm.getAbsolutePath());
            } else {
                link = new ProcessBuilder(linker.getAbsolutePath(), "--entry=_start", object.getAbsolutePath(), crt.getAbsolutePath(),
                        "-L" + wasiLib.getAbsolutePath(), "-lc", builtins.getAbsolutePath(), "-o", wasm.getAbsolutePath());
            }
            link.directory(work);
            link.environment().put("LD_LIBRARY_PATH", new File(toolchain, "lib").getAbsolutePath());
            link.environment().put("HOME", filesDir.getAbsolutePath());
            link.environment().put("TMPDIR", work.getAbsolutePath());
            link.environment().put("PWD", work.getAbsolutePath());
            Process linkProcess = link.redirectErrorStream(false).start();
            ByteArrayOutputStream linkError = new ByteArrayOutputStream();
            Thread linkReader = drain(linkProcess.getErrorStream(), linkError);
            boolean linkFinished = linkProcess.waitFor(timeout, TimeUnit.MILLISECONDS);
            if (!linkFinished) { linkProcess.destroyForcibly(); return result("timeout", "", "链接超时", -1); }
            linkReader.join(1000);
            compileError += linkError.toString(StandardCharsets.UTF_8);
            if (linkProcess.exitValue() != 0 || !wasm.isFile()) return result("compile_error", "", compileError, linkProcess.exitValue());
            String run = NativeWasmRunner.run(Files.readAllBytes(wasm.toPath()), stdin.getBytes(StandardCharsets.UTF_8), timeout);
            JSONObject response = new JSONObject(run);
            response.put("compile_stderr", compileError);
            return response.toString();
        } catch (Exception e) {
            return error("runtime_error", e.toString());
        }
    }

    private static File safeChild(File root, String relative) throws IOException {
        File child = new File(root, relative);
        if (!child.getCanonicalPath().startsWith(root.getCanonicalPath() + File.separator)) throw new IOException("资源包路径无效");
        return child;
    }

    private static Thread drain(InputStream input, ByteArrayOutputStream output) {
        Thread thread = new Thread(() -> {
            byte[] buffer = new byte[8192];
            int read;
            long total = 0;
            try {
                while ((read = input.read(buffer)) >= 0) {
                    if (read == 0) continue;
                    int allowed = (int) Math.min(read, Math.max(0, MAX_OUTPUT - total));
                    if (allowed > 0) output.write(buffer, 0, allowed);
                    total += read;
                }
            } catch (IOException ignored) { }
        }, "doge-process-reader");
        thread.start();
        return thread;
    }

    private static String result(String status, String stdout, String stderr, int exitCode) {
        try {
            JSONObject result = new JSONObject();
            result.put("status", status); result.put("stdout", stdout); result.put("stderr", stderr); result.put("exit_code", exitCode);
            return result.toString();
        } catch (Exception e) { return "{\"status\":\"runtime_error\",\"message\":\"result failed\"}"; }
    }

    private static String error(String status, String message) {
        try { return new JSONObject().put("status", status).put("message", message).toString(); }
        catch (Exception e) { return "{\"status\":\"runtime_error\"}"; }
    }
}
