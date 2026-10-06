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
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

/** Compiles a small local C/C++ project to a WASI module. */
final class LocalCompiler {
    interface ProgressListener { void onUpdate(String phase, String stdout, String stderr); }
    private static final long MAX_OUTPUT = 2L * 1024L * 1024L;
    private static final long MAX_CACHE_BYTES = 128L * 1024L * 1024L;
    private final File filesDir;
    private final DependencyManager dependencies;
    private static final Set<Process> ACTIVE_PROCESSES = ConcurrentHashMap.newKeySet();
    private static final java.util.concurrent.atomic.AtomicBoolean RUNS_CLEANED = new java.util.concurrent.atomic.AtomicBoolean(false);

    LocalCompiler(Context context) {
        filesDir = context.getApplicationContext().getFilesDir();
        dependencies = DependencyManager.get(context);
        // 进程被系统杀掉时 finally 不会执行，runs/ 下会留下孤儿编译目录；每个进程启动时清理一次
        if (RUNS_CLEANED.compareAndSet(false, true)) deleteTree(new File(filesDir, "runs"));
    }

    static void cancelActive() {
        for (Process process : ACTIVE_PROCESSES) RuntimeCompat.terminate(process);
        NativeWasmRunner.cancel();
    }

    String execute(String requestJson) { return execute(requestJson, (phase, stdout, stderr) -> {}); }

    String execute(String requestJson, ProgressListener listener) {
        return execute(requestJson, listener, null);
    }

    String execute(String requestJson, ProgressListener listener, RunSession session) {
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
            JSONObject build = request.optJSONObject("build");
            int timeout = Math.max(1000, Math.min(30000, request.optInt("timeout_ms", 30000)));
            boolean interactive = session != null && session.interactive;
            if (interactive) timeout = Math.max(1000, Math.min(120000, request.optInt("compile_timeout_ms", 30000)));
            int runTimeout = Math.max(1000, Math.min(3600000, request.optInt("run_timeout_ms", 600000)));
            long deadlineNanos = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeout);
            if (!"c".equals(language) && !"cpp".equals(language)) {
                return error("invalid_request", "仅支持 C 和 C++");
            }
            File toolchain = new File(filesDir, "toolchain");
            File manifest = new File(toolchain, "manifest.json");
            if (!manifest.isFile()) {
                return error("runtime_not_ready", "请先导入 C/C++ 资源包");
            }
            JSONObject meta = new JSONObject(new String(RuntimeCompat.readBytes(manifest), StandardCharsets.UTF_8));
            String clangRelative = meta.optString("clang", "bin/clang");
            String sysrootRelative = meta.optString("sysroot", "wasi-sysroot");
            File clang = safeChild(toolchain, clangRelative);
            File sysroot = safeChild(toolchain, sysrootRelative);
            if (!clang.isFile() || !sysroot.isDirectory()) return error("runtime_not_ready", "资源包缺少 Clang 或 WASI sysroot");
            for (String executable : new String[]{"clang", "clang++", "clang-21", "clang++-21", "clangd", "wasm-ld", "ld.lld"}) {
                File candidate = new File(toolchain, "bin/" + executable);
                if (candidate.isFile()) candidate.setExecutable(true, false);
            }
            String fingerprint = cacheFingerprint(request, toolchain);
            File work = new File(new File(filesDir, "runs"), Long.toHexString(System.nanoTime()) + "-" + Thread.currentThread().getId());
            if (!work.isDirectory() && !work.mkdirs()) return error("runtime_error", "无法创建编译目录");
            File wasm = new File(work, "main.wasm");
            RuntimeCompat.deleteIfExists(wasm);
            writeCompileCommands(request, files, build, toolchain, sysroot);

            String target = "wasm32-wasip1";
            StringBuilder compileError = new StringBuilder();
            listener.onUpdate("compiling", "", "");
            java.util.ArrayList<File> objects = new java.util.ArrayList<>();
            String effectiveLanguage = language;
            boolean entryFound = false;
            try {
            for (int i = 0; i < files.length(); i++) {
                if (session != null && session.isCanceled()) return result("canceled", "", "任务已取消", -1);
                JSONObject file = files.optJSONObject(i);
                if (file == null) continue;
                String relative = file.optString("path", "").replace('\\', '/');
                if (ProjectFiles.isInternalManifestPath(relative)) continue;
                if (!relative.matches("[A-Za-z0-9._/-]+") || relative.startsWith("/") || relative.contains("..") || relative.startsWith(".") || relative.endsWith("/")) {
                    return error("invalid_request", "项目文件路径无效: " + relative);
                }
                if (relative.equals(entry)) entryFound = true;
                File projectFile = safeChild(work, relative);
                File projectParent = projectFile.getParentFile();
                if (projectParent != null) projectParent.mkdirs();
                RuntimeCompat.writeBytes(projectFile, file.optString("code", "").getBytes(StandardCharsets.UTF_8));
            }
            if (!entryFound) return error("invalid_request", "入口文件不存在: " + entry);

            // 头文件和数据文件必须全部落盘，再逐个编译源文件；文件排列不应影响构建。
            for (int i = 0; i < files.length(); i++) {
                JSONObject file = files.optJSONObject(i);
                if (file == null) continue;
                String relative = file.optString("path", "").replace('\\', '/');
                if (ProjectFiles.isInternalManifestPath(relative)) continue;
                String lower = relative.toLowerCase(java.util.Locale.ROOT);
                File projectFile = safeChild(work, relative);
                if (!lower.endsWith(".c") && !lower.endsWith(".cc") && !lower.endsWith(".cpp") && !lower.endsWith(".cxx")) continue;
                if (lower.endsWith(".cc") || lower.endsWith(".cpp") || lower.endsWith(".cxx")) effectiveLanguage = "cpp";
                File source = projectFile;
                File object = new File(work, relative + ".o");
                object.getParentFile().mkdirs();
                File cachedObject = new File(new File(filesDir, "build-cache/" + fingerprint), relative + ".o");
                File objectParent = object.getParentFile();
                if (objectParent != null) objectParent.mkdirs();
                RuntimeCompat.deleteIfExists(object);
                if (cachedObject.isFile()) {
                    RuntimeCompat.copyFile(cachedObject, object);
                    objects.add(object);
                    continue;
                }
                File compilerFile = new File(toolchain, "bin/" + (lower.endsWith(".c") ? "clang" : "clang++"));
                listener.onUpdate("compiling", "", "编译 " + relative + "\n");
                ProcessBuilder compiler = new ProcessBuilder(
                        compilerFile.getAbsolutePath(), "--target=" + target, "--sysroot=" + sysroot.getAbsolutePath(),
                        "-O2", "-std=" + (lower.endsWith(".c") ? "c17" : "c++20"),
                        "-fno-exceptions", "-fno-rtti", "-c", source.getAbsolutePath(), "-o", object.getAbsolutePath());
                applyBuildOptions(compiler, build, work, sysroot, dependencies);
                configureEnvironment(compiler, toolchain, work);
            ProcessResult compiled = runProcess(compiler, remainingMillis(deadlineNanos), (out, err) -> {
                    if (!out.isEmpty() || !err.isEmpty()) listener.onUpdate("compiling", out, err);
                });
                if (!compiled.finished) return result("timeout", "", compiled.stderr, -1);
                compileError.append(compiled.stderr);
                if (compiled.exitCode != 0 || !object.isFile()) return result("compile_error", "", compileError.toString(), compiled.exitCode);
                objects.add(object);
                File cacheParent = cachedObject.getParentFile();
                if (cacheParent != null) cacheParent.mkdirs();
                RuntimeCompat.copyFile(object, cachedObject, true);
            }
            if (objects.isEmpty()) return error("invalid_request", "项目中没有 C/C++ 源文件");

            if (interactive) {
                File helper = new File(work, ".doge-terminal.c"), helperObject = new File(work, ".doge-terminal.o");
                // WASI crt1 calls __main_void (which dispatches argc/argv main when necessary), not main.
                RuntimeCompat.writeBytes(helper, ("#include <stdio.h>\nextern int __real___main_void(void);\n"
                        + "int __wrap___main_void(void){setvbuf(stdout,0,_IONBF,0);setvbuf(stderr,0,_IONBF,0);return __real___main_void();}\n").getBytes(StandardCharsets.UTF_8));
                ProcessBuilder helperCompiler = new ProcessBuilder(clang.getAbsolutePath(), "--target=" + target,
                        "--sysroot=" + sysroot.getAbsolutePath(), "-c", helper.getAbsolutePath(), "-o", helperObject.getAbsolutePath());
                configureEnvironment(helperCompiler, toolchain, work);
                ProcessResult helperResult = runProcess(helperCompiler, remainingMillis(deadlineNanos), (out, err) -> listener.onUpdate("compiling", out, err));
                if (!helperResult.finished) return result("timeout", "", "终端初始化编译超时", -1);
                if (helperResult.exitCode != 0) return result("compile_error", "", helperResult.stderr, helperResult.exitCode);
                objects.add(helperObject);
            }

            File linker = new File(toolchain, "bin/wasm-ld");
            if (session != null && session.isCanceled()) return result("canceled", "", "任务已取消", -1);
            listener.onUpdate("linking", "", "");
            File wasiLib = new File(sysroot, "lib/wasm32-wasip1");
            File crt = new File(wasiLib, "crt1-command.o");
            File builtins = new File(toolchain, "lib/clang/21/lib/wasm32-wasip1/libclang_rt.builtins.a");
            java.util.ArrayList<String> linkArgs = new java.util.ArrayList<>();
            linkArgs.add(linker.getAbsolutePath()); linkArgs.add("--entry=_start");
            if (interactive) linkArgs.add("--wrap=__main_void");
            for (File object : objects) linkArgs.add(object.getAbsolutePath());
            linkArgs.add(crt.getAbsolutePath()); linkArgs.add("-L" + wasiLib.getAbsolutePath());
            if ("cpp".equals(effectiveLanguage)) {
                linkArgs.add("-lc++"); linkArgs.add("-lc++abi"); linkArgs.add("-lc"); linkArgs.add(builtins.getAbsolutePath()); linkArgs.add("-o"); linkArgs.add(wasm.getAbsolutePath());
            } else {
                linkArgs.add("-lc"); linkArgs.add(builtins.getAbsolutePath()); linkArgs.add("-o"); linkArgs.add(wasm.getAbsolutePath());
            }
            applyLinkOptions(linkArgs, build, work, sysroot, dependencies);
            ProcessBuilder link = new ProcessBuilder(linkArgs);
            configureEnvironment(link, toolchain, work);
            listener.onUpdate("linking", "", "");
            ProcessResult linked = runProcess(link, remainingMillis(deadlineNanos), (out, err) -> {
                if (!err.isEmpty() || !out.isEmpty()) listener.onUpdate("linking", out, err);
            });
            if (!linked.finished) return result("timeout", "", "链接超时", -1);
            compileError.append(linked.stderr);
            if (linked.exitCode != 0 || !wasm.isFile()) return result("compile_error", "", compileError.toString(), linked.exitCode);
            listener.onUpdate("running", "", "");
            String run = interactive
                    ? NativeWasmRunner.runInteractive(RuntimeCompat.readBytes(wasm), runTimeout, session)
                    : NativeWasmRunner.run(RuntimeCompat.readBytes(wasm), stdin.getBytes(StandardCharsets.UTF_8), remainingMillis(deadlineNanos));
            trimBuildCache();
            JSONObject response = new JSONObject(run);
            if (interactive) response.put("output_complete", true);
            response.put("compile_stderr", compileError.toString());
            return response.toString();
            } finally {
                if (session != null) session.closeInput();
                deleteTree(work);
            }
        } catch (TimeoutException e) {
            return result("timeout", "", e.getMessage(), -1);
        } catch (Exception e) {
            return error("runtime_error", e.toString());
        }
    }

    private void writeCompileCommands(JSONObject request, JSONArray files, JSONObject build, File toolchain, File sysroot) {
        try {
            File root = new File(filesDir, "workspace/current");
            if (!root.isDirectory()) root.mkdirs();
            JSONArray commands = new JSONArray();
            for (int i = 0; i < files.length(); i++) {
                JSONObject file = files.optJSONObject(i); if (file == null) continue;
                String path = file.optString("path", "").replace('\\', '/');
                String lower = path.toLowerCase(java.util.Locale.ROOT);
                if (!(lower.endsWith(".c") || lower.endsWith(".cc") || lower.endsWith(".cpp") || lower.endsWith(".cxx"))) continue;
                File source = safeChild(root, path); File parent = source.getParentFile(); if (parent != null) parent.mkdirs();
                RuntimeCompat.writeBytes(source, file.optString("code", "").getBytes(StandardCharsets.UTF_8));
                JSONArray args = new JSONArray().put(new File(toolchain, "bin/" + (lower.endsWith(".c") ? "clang" : "clang++")).getAbsolutePath())
                        .put("--target=wasm32-wasip1").put("--sysroot=" + sysroot.getAbsolutePath()).put("-O" + (build == null ? "2" : build.optString("optimization", "2")))
                        .put("-std=" + (lower.endsWith(".c") ? "c17" : "c++20")).put("-fno-exceptions").put("-fno-rtti")
                        .put("-iquote").put(root.getAbsolutePath()).put("-c").put(source.getAbsolutePath());
                JSONArray defines = build == null ? null : build.optJSONArray("defines");
                if (defines != null) for (int d = 0; d < defines.length(); d++) args.put("-D" + defines.optString(d));
                JSONArray includes = build == null ? null : build.optJSONArray("include_paths");
                if (includes != null) for (int p = 0; p < includes.length(); p++) args.put("-I" + new File(root, includes.optString(p)).getAbsolutePath());
                commands.put(new JSONObject().put("directory", root.getAbsolutePath()).put("file", source.getAbsolutePath()).put("arguments", args));
            }
            RuntimeCompat.writeBytes(new File(root, "compile_commands.json"), commands.toString(2).getBytes(StandardCharsets.UTF_8));
        } catch (Exception ignored) { }
    }

    private static void applyBuildOptions(ProcessBuilder process, JSONObject build, File work, File sysroot, DependencyManager dependencyManager) throws Exception {
        java.util.List<String> command = process.command();
        // #include "…" 除了源文件所在目录，也在项目根目录查找（子目录里的源文件可以直接 include 根目录的头文件）。
        // 用 -iquote 而不是 -I：不影响 #include <…>，项目里的 math.h 不会挡住标准库的 <math.h>
        command.add("-iquote"); command.add(work.getAbsolutePath());
        if (build == null) return;
        String opt = build.optString("optimization", "2");
        for (int i = 0; i < command.size(); i++) if ("-O2".equals(command.get(i))) command.set(i, "-O" + (opt.matches("[0-3s]") ? opt : "2"));
        JSONArray defines = build.optJSONArray("defines");
        if (defines != null) for (int i = 0; i < defines.length(); i++) {
            String value = defines.optString(i, ""); if (value.matches("[A-Za-z_][A-Za-z0-9_]*(=.*)?")) command.add("-D" + value);
        }
            JSONArray includes = build.optJSONArray("include_paths");
        if (includes != null) for (int i = 0; i < includes.length(); i++) {
            String path = safeRelative(includes.optString(i, "")); if (path != null) command.add("-I" + new File(work, path).getAbsolutePath());
        }
        JSONArray dependencies = build.optJSONArray("dependencies");
        if (dependencies != null) for (int i = 0; i < dependencies.length(); i++) {
            JSONObject dep = dependencies.optJSONObject(i);
            String name = dep == null ? "" : dep.optString("name", "");
            String version = dep == null ? "" : dep.optString("version", "");
            if (name.isEmpty() || version.isEmpty()) {
                String[] coordinate = dependencies.optString(i, "").split("@", 2);
                if (coordinate.length == 2) { name = coordinate[0]; version = coordinate[1]; }
            }
            File packageRoot = name.isEmpty() || version.isEmpty() ? null : dependencyManager.resolvePackage(name, version);
            if (packageRoot == null) throw new IOException("依赖未安装或 registry 无效: " + name + "@" + version);
            File include = new File(packageRoot, "include");
            if (include.isDirectory()) command.add("-I" + include.getAbsolutePath());
        }
    }

    private static void applyLinkOptions(java.util.ArrayList<String> args, JSONObject build, File work, File sysroot, DependencyManager dependencyManager) throws Exception {
        if (build == null) return;
        JSONArray libraryPaths = build.optJSONArray("library_paths");
        if (libraryPaths != null) for (int i = 0; i < libraryPaths.length(); i++) {
            String path = safeRelative(libraryPaths.optString(i, "")); if (path != null) args.add("-L" + new File(work, path).getAbsolutePath());
        }
        JSONArray libraries = build.optJSONArray("libraries");
        if (libraries != null) for (int i = 0; i < libraries.length(); i++) {
            String name = libraries.optString(i, ""); if (name.matches("[A-Za-z0-9_+.-]+")) args.add("-l" + name);
        }
        JSONArray deps = build.optJSONArray("dependencies");
        if (deps != null) for (int i = 0; i < deps.length(); i++) {
            JSONObject dep = deps.optJSONObject(i);
            String coordinate = deps.optString(i, "");
            String name = dep == null ? "" : dep.optString("name", "");
            String version = dep == null ? "" : dep.optString("version", "");
            if (name.isEmpty() || version.isEmpty()) { String[] parts = coordinate.split("@", 2); if (parts.length == 2) { name = parts[0]; version = parts[1]; } }
            File packageRoot = name.isEmpty() || version.isEmpty() ? null : dependencyManager.resolvePackage(name, version);
            if (packageRoot == null) throw new IOException("依赖未安装或 registry 无效: " + name + "@" + version);
            File lib = new File(packageRoot, "lib");
            if (lib.isDirectory()) args.add("-L" + lib.getAbsolutePath());
        }
    }

    private static String safeRelative(String path) {
        return path != null && path.matches("[A-Za-z0-9._/-]+") && !path.startsWith("/") && !path.contains("..") ? path : null;
    }

    private String cacheFingerprint(JSONObject request, File toolchain) throws Exception {
        java.security.MessageDigest hash = java.security.MessageDigest.getInstance("SHA-256");
        fingerprintField(hash, "compiler-cache-v2".getBytes(StandardCharsets.UTF_8));
        fingerprintField(hash, request.toString().getBytes(StandardCharsets.UTF_8));
        fingerprintField(hash, RuntimeCompat.readBytes(new File(toolchain, "manifest.json")));
        File generation = new File(toolchain, ".doge-runtime.json");
        fingerprintField(hash, generation.isFile() ? RuntimeCompat.readBytes(generation) : new byte[0]);
        JSONObject build = request.optJSONObject("build");
        JSONArray requested = build == null ? null : build.optJSONArray("dependencies");
        if (requested != null) for (int i = 0; i < requested.length(); i++) {
            JSONObject dependency = requested.optJSONObject(i);
            String name = dependency == null ? "" : dependency.optString("name", "");
            String version = dependency == null ? "" : dependency.optString("version", "");
            if (name.isEmpty() || version.isEmpty()) {
                String[] coordinate = requested.optString(i, "").split("@", 2);
                if (coordinate.length == 2) { name = coordinate[0]; version = coordinate[1]; }
            }
            File packageRoot = dependencies.resolvePackage(name, version);
            if (packageRoot == null) throw new IOException("依赖未安装或 registry 无效: " + name + "@" + version);
            File metadata = new File(packageRoot, ".doge-package.json");
            // 无法识别安装内容时保守地不复用缓存，编译本身仍可进行。
            fingerprintField(hash, metadata.isFile() ? RuntimeCompat.readBytes(metadata)
                    : java.util.UUID.randomUUID().toString().getBytes(StandardCharsets.UTF_8));
        }
        byte[] digest = hash.digest();
        StringBuilder value = new StringBuilder();
        for (byte b : digest) value.append(String.format(java.util.Locale.ROOT, "%02x", b & 0xff));
        return value.toString();
    }

    private static void fingerprintField(java.security.MessageDigest hash, byte[] bytes) {
        for (int shift = 24; shift >= 0; shift -= 8) hash.update((byte) (bytes.length >>> shift));
        hash.update(bytes);
    }

    private void trimBuildCache() {
        File root = new File(filesDir, "build-cache");
        File[] entries = root.listFiles();
        if (entries == null) return;
        long total = 0;
        for (File entry : entries) total += treeSize(entry);
        if (total <= MAX_CACHE_BYTES) return;
        java.util.Arrays.sort(entries, java.util.Comparator.comparingLong(File::lastModified));
        for (File entry : entries) {
            // 必须在删除前取大小，删除后 treeSize 恒为 0，会导致整份缓存被清空
            long size = treeSize(entry);
            deleteTree(entry);
            total -= size;
            if (total <= MAX_CACHE_BYTES) break;
        }
    }

    private static long treeSize(File file) {
        if (file.isFile()) return file.length();
        File[] children = file.listFiles();
        if (children == null) return 0;
        long size = 0; for (File child : children) size += treeSize(child); return size;
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

    private static ProcessResult runProcess(ProcessBuilder builder, int timeout) throws Exception { return runProcess(builder, timeout, (out, err) -> {}); }

    private static ProcessResult runProcess(ProcessBuilder builder, int timeout, ProcessListener listener) throws Exception {
        Process process = builder.redirectErrorStream(false).start();
        ACTIVE_PROCESSES.add(process);
        ByteArrayOutputStream stdout = new ByteArrayOutputStream();
        ByteArrayOutputStream stderr = new ByteArrayOutputStream();
        Thread outReader = drain(process.getInputStream(), stdout, listener, true);
        Thread errReader = drain(process.getErrorStream(), stderr, listener, false);
        boolean finished = RuntimeCompat.waitFor(process, timeout, TimeUnit.MILLISECONDS);
        if (!finished) RuntimeCompat.terminate(process);
        outReader.join(1000); errReader.join(1000);
        if (outReader.isAlive() || errReader.isAlive()) {
            // 子进程被杀后流未关闭时，主动关流让读取线程退出，避免线程滞留累积
            closeQuietly(process.getInputStream());
            closeQuietly(process.getErrorStream());
        }
        ACTIVE_PROCESSES.remove(process);
        return new ProcessResult(finished, finished ? process.exitValue() : -1, stderr.toString(StandardCharsets.UTF_8.name()));
    }

    private static int remainingMillis(long deadlineNanos) throws TimeoutException {
        long remaining = deadlineNanos - System.nanoTime();
        if (remaining <= 0) throw new TimeoutException("执行超时");
        return (int) Math.max(1, Math.min(Integer.MAX_VALUE, TimeUnit.NANOSECONDS.toMillis(remaining)));
    }

    private static void deleteTree(File file) {
        if (file == null || !file.exists()) return;
        File[] children = file.listFiles();
        if (children != null) for (File child : children) deleteTree(child);
        if (!file.delete() && file.exists()) file.deleteOnExit();
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

    private interface ProcessListener { void onChunk(String stdout, String stderr); }

    private static Thread drain(InputStream input, ByteArrayOutputStream output, ProcessListener listener, boolean stdout) {
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
                    if (allowed > 0) {
                        String text = new String(buffer, 0, allowed, StandardCharsets.UTF_8);
                        listener.onChunk(stdout ? text : "", stdout ? "" : text);
                    }
                }
            } catch (IOException ignored) { }
        }, "doge-process-reader");
        thread.setDaemon(true);
        thread.start();
        return thread;
    }

    private static void closeQuietly(java.io.Closeable closeable) {
        try { if (closeable != null) closeable.close(); } catch (IOException ignored) { }
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
