package com.doge.ide;

import android.content.Context;
import org.json.JSONObject;
import org.json.JSONArray;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.concurrent.TimeUnit;

/** Compiles a small local C/C++ project to a WASI module. */
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
            JSONArray files = request.optJSONArray("files");
            if (files == null) {
                files = new JSONArray();
                files.put(new JSONObject().put("path", "main." + ("cpp".equals(language) ? "cpp" : "c"))
                        .put("code", request.optString("code", "")));
            }
            String entry = request.optString("entry", "main." + ("cpp".equals(language) ? "cpp" : "c"));
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
            File work = new File(new File(filesDir, "runs"), Long.toHexString(System.nanoTime()) + "-" + Thread.currentThread().getId());
            if (!work.isDirectory() && !work.mkdirs()) return error("runtime_error", "无法创建编译目录");
            File wasm = new File(work, "main.wasm");
            Files.deleteIfExists(wasm.toPath());

            String target = "wasm32-wasip1";
            StringBuilder compileError = new StringBuilder();
            java.util.ArrayList<File> objects = new java.util.ArrayList<>();
            String effectiveLanguage = language;
            boolean entryFound = false;
            for (int i = 0; i < files.length(); i++) {
                JSONObject file = files.optJSONObject(i);
                if (file == null) continue;
                String relative = file.optString("path", "").replace('\\', '/');
                if (!relative.matches("[A-Za-z0-9._/-]+") || relative.startsWith("/") || relative.contains("..")) {
                    return error("invalid_request", "项目文件路径无效: " + relative);
                }
                String lower = relative.toLowerCase(java.util.Locale.ROOT);
                if (relative.equals(entry)) entryFound = true;
                File projectFile = safeChild(work, relative);
                File projectParent = projectFile.getParentFile();
                if (projectParent != null) projectParent.mkdirs();
                Files.write(projectFile.toPath(), file.optString("code", "").getBytes(StandardCharsets.UTF_8));
                if (!lower.endsWith(".c") && !lower.endsWith(".cc") && !lower.endsWith(".cpp") && !lower.endsWith(".cxx")) continue;
                if (lower.endsWith(".cc") || lower.endsWith(".cpp") || lower.endsWith(".cxx")) effectiveLanguage = "cpp";
                File source = projectFile;
                File object = new File(work, relative + ".o");
                File objectParent = object.getParentFile();
                if (objectParent != null) objectParent.mkdirs();
                Files.deleteIfExists(object.toPath());
                File compilerFile = new File(toolchain, "bin/" + (lower.endsWith(".c") ? "clang" : "clang++"));
                ProcessBuilder compiler = new ProcessBuilder(
                        compilerFile.getAbsolutePath(), "--target=" + target, "--sysroot=" + sysroot.getAbsolutePath(),
                        "-O2", "-std=" + (lower.endsWith(".c") ? "c17" : "c++20"),
                        "-fno-exceptions", "-fno-rtti", "-c", source.getAbsolutePath(), "-o", object.getAbsolutePath());
                configureEnvironment(compiler, toolchain, work);
                ProcessResult compiled = runProcess(compiler, timeout);
                if (!compiled.finished) return result("timeout", "", compiled.stderr, -1);
                compileError.append(compiled.stderr);
                if (compiled.exitCode != 0 || !object.isFile()) return result("compile_error", "", compileError.toString(), compiled.exitCode);
                objects.add(object);
            }
            if (objects.isEmpty()) return error("invalid_request", "项目中没有 C/C++ 源文件");
            if (!entryFound) return error("invalid_request", "入口文件不存在: " + entry);

            File linker = new File(toolchain, "bin/wasm-ld");
            File wasiLib = new File(sysroot, "lib/wasm32-wasip1");
            File crt = new File(wasiLib, "crt1-command.o");
            File builtins = new File(toolchain, "lib/clang/21/lib/wasm32-wasip1/libclang_rt.builtins.a");
            java.util.ArrayList<String> linkArgs = new java.util.ArrayList<>();
            linkArgs.add(linker.getAbsolutePath()); linkArgs.add("--entry=_start");
            for (File object : objects) linkArgs.add(object.getAbsolutePath());
            linkArgs.add(crt.getAbsolutePath()); linkArgs.add("-L" + wasiLib.getAbsolutePath());
            if ("cpp".equals(effectiveLanguage)) {
                linkArgs.add("-lc++"); linkArgs.add("-lc++abi"); linkArgs.add("-lc"); linkArgs.add(builtins.getAbsolutePath()); linkArgs.add("-o"); linkArgs.add(wasm.getAbsolutePath());
            } else {
                linkArgs.add("-lc"); linkArgs.add(builtins.getAbsolutePath()); linkArgs.add("-o"); linkArgs.add(wasm.getAbsolutePath());
            }
            ProcessBuilder link = new ProcessBuilder(linkArgs);
            configureEnvironment(link, toolchain, work);
            ProcessResult linked = runProcess(link, timeout);
            if (!linked.finished) return result("timeout", "", "链接超时", -1);
            compileError.append(linked.stderr);
            if (linked.exitCode != 0 || !wasm.isFile()) return result("compile_error", "", compileError.toString(), linked.exitCode);
            String run = NativeWasmRunner.run(Files.readAllBytes(wasm.toPath()), stdin.getBytes(StandardCharsets.UTF_8), timeout);
            JSONObject response = new JSONObject(run);
            response.put("compile_stderr", compileError.toString());
            return response.toString();
        } catch (Exception e) {
            return error("runtime_error", e.toString());
        }
    }

    private void configureEnvironment(ProcessBuilder process, File toolchain, File work) {
        process.directory(work);
        process.environment().put("HOME", filesDir.getAbsolutePath());
        process.environment().put("TMPDIR", work.getAbsolutePath());
        process.environment().put("PATH", new File(toolchain, "bin").getAbsolutePath());
        process.environment().put("LD_LIBRARY_PATH", new File(toolchain, "lib").getAbsolutePath());
        process.environment().put("PWD", work.getAbsolutePath());
        process.environment().put("LLVM_CONFIG_FILE", new File(toolchain, "lib/llvm-config").getAbsolutePath());
    }

    private static ProcessResult runProcess(ProcessBuilder builder, int timeout) throws Exception {
        Process process = builder.redirectErrorStream(false).start();
        ByteArrayOutputStream stdout = new ByteArrayOutputStream();
        ByteArrayOutputStream stderr = new ByteArrayOutputStream();
        Thread outReader = drain(process.getInputStream(), stdout);
        Thread errReader = drain(process.getErrorStream(), stderr);
        boolean finished = process.waitFor(timeout, TimeUnit.MILLISECONDS);
        if (!finished) process.destroyForcibly();
        outReader.join(1000); errReader.join(1000);
        return new ProcessResult(finished, finished ? process.exitValue() : -1, stderr.toString(StandardCharsets.UTF_8));
    }

    private static final class ProcessResult {
        final boolean finished; final int exitCode; final String stderr;
        ProcessResult(boolean finished, int exitCode, String stderr) { this.finished = finished; this.exitCode = exitCode; this.stderr = stderr; }
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
