package com.doge.ide;

import android.content.Context;
import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.concurrent.TimeUnit;

/** Runs a Python project with the imported runtime (files/python) in a child process. */
final class PythonRunner {
    /** 引导脚本检测到语法错误时的退出码，映射为 compile_error。 */
    static final int SYNTAX_EXIT = 65;
    private static final long MAX_OUTPUT = 2L * 1024L * 1024L;
    private static volatile Process active;
    private static volatile OutputStream activeStdin;

    // 先编译全部 .py（语法错误统一报告），再以 __main__ 运行入口；traceback 去掉引导帧
    static final String BOOT =
        "import sys, os, runpy, traceback\n" +
        "entry = sys.argv[1]\n" +
        "bad = False\n" +
        "for root, dirs, names in os.walk('.'):\n" +
        "    dirs[:] = [d for d in dirs if not d.startswith('.') and d != '__pycache__']\n" +
        "    for n in sorted(names):\n" +
        "        if not n.endswith('.py') or n == '.doge_boot.py': continue\n" +
        "        p = os.path.relpath(os.path.join(root, n)).replace(os.sep, '/')\n" +
        "        try:\n" +
        "            with open(p, encoding='utf-8') as f: compile(f.read(), p, 'exec')\n" +
        "        except SyntaxError as e:\n" +
        "            bad = True\n" +
        "            traceback.print_exception(type(e), e, None)\n" +
        "if bad: sys.exit(" + SYNTAX_EXIT + ")\n" +
        "sys.argv = [entry]\n" +
        "sys.path[0] = os.getcwd()\n" +
        "try:\n" +
        "    runpy.run_path(entry, run_name='__main__')\n" +
        "except SystemExit:\n" +
        "    raise\n" +
        "except BaseException as e:\n" +
        "    tb = e.__traceback__\n" +
        "    skip = (os.path.abspath(__file__), runpy.__file__)\n" +
        "    while tb is not None and (tb.tb_frame.f_code.co_filename in skip or 'runpy' in tb.tb_frame.f_code.co_filename):\n" +
        "        tb = tb.tb_next\n" +
        "    text = ''.join(traceback.format_exception(type(e), e, tb))\n" +
        "    sys.stderr.write(text.replace(os.getcwd() + '/', ''))\n" +
        "    sys.stderr.flush()\n" +
        "    os._exit(1)\n";

    private final File filesDir;

    PythonRunner(Context context) { filesDir = context.getApplicationContext().getFilesDir(); }

    static void cancelActive() {
        Process p = active;
        if (p != null) p.destroyForcibly();
    }

    /** 运行中输入：写入当前 Python 进程的 stdin。text 为 null 表示关闭输入（EOF）。 */
    static boolean sendInput(String text) {
        OutputStream in = activeStdin;
        if (in == null) return false;
        try {
            if (text == null) { in.close(); activeStdin = null; }
            else { in.write(text.getBytes(StandardCharsets.UTF_8)); in.flush(); }
            return true;
        } catch (IOException e) { return false; }
    }

    String execute(String requestJson, LocalCompiler.ProgressListener listener) {
        File work = null;
        try {
            JSONObject request = new JSONObject(requestJson);
            JSONArray files = request.optJSONArray("files");
            if (files == null) files = new JSONArray().put(new JSONObject().put("path", "main.py").put("code", request.optString("code", "")));
            String entry = request.optString("entry", "main.py");
            boolean interactive = request.optBoolean("interactive", false);
            // 交互运行要等用户输入，超时放宽到 10 分钟；非交互与 C 一致最多 30 秒
            int maxTimeout = interactive ? 600000 : 30000;
            int timeout = Math.max(1000, Math.min(maxTimeout, request.optInt("timeout_ms", maxTimeout)));
            File runtime = new File(filesDir, "python");
            File manifest = new File(runtime, "manifest.json");
            if (!manifest.isFile()) return error("runtime_not_ready", "请先导入 Python 运行库");
            JSONObject meta = new JSONObject(new String(Files.readAllBytes(manifest.toPath()), StandardCharsets.UTF_8));
            File python = safeChild(runtime, meta.optString("python", "bin/doge-python"));
            File home = safeChild(runtime, meta.optString("home", "prefix"));
            File lib = safeChild(runtime, meta.optString("lib", "prefix/lib"));
            if (!python.isFile()) return error("runtime_not_ready", "Python 运行库缺少启动器");
            python.setExecutable(true, false);

            work = new File(new File(filesDir, "runs"), "py-" + Long.toHexString(System.nanoTime()));
            if (!work.mkdirs()) return error("runtime_error", "无法创建运行目录");
            boolean entryFound = false;
            for (int i = 0; i < files.length(); i++) {
                JSONObject file = files.optJSONObject(i);
                if (file == null) continue;
                String relative = file.optString("path", "").replace('\\', '/');
                if (!relative.matches("[A-Za-z0-9._/-]+") || relative.startsWith("/") || relative.contains("..") || relative.startsWith(".") || relative.endsWith("/"))
                    return error("invalid_request", "项目文件路径无效: " + relative);
                if (relative.equals(entry)) entryFound = true;
                File target = safeChild(work, relative);
                File parent = target.getParentFile();
                if (parent != null) parent.mkdirs();
                Files.write(target.toPath(), file.optString("code", "").getBytes(StandardCharsets.UTF_8));
            }
            if (!entryFound || !entry.toLowerCase(java.util.Locale.ROOT).endsWith(".py")) return error("invalid_request", "入口文件不存在: " + entry);
            File boot = new File(work, ".doge_boot.py");
            Files.write(boot.toPath(), BOOT.getBytes(StandardCharsets.UTF_8));

            ProcessBuilder builder = new ProcessBuilder(python.getAbsolutePath(), "-u", "-B", boot.getAbsolutePath(), entry);
            builder.directory(work);
            java.util.Map<String, String> env = builder.environment();
            env.put("PYTHONHOME", home.getAbsolutePath());
            env.put("LD_LIBRARY_PATH", lib.getAbsolutePath());
            env.put("HOME", work.getAbsolutePath());
            env.put("TMPDIR", work.getAbsolutePath());
            env.put("PWD", work.getAbsolutePath());
            env.put("PYTHONUNBUFFERED", "1");
            env.put("PYTHONUTF8", "1");
            env.put("PYTHONIOENCODING", "utf-8");
            env.put("PYTHONDONTWRITEBYTECODE", "1");
            env.remove("PYTHONPATH");

            listener.onUpdate("running", "", "");
            Process process = builder.start();
            active = process;
            ByteArrayOutputStream stdout = new ByteArrayOutputStream();
            ByteArrayOutputStream stderr = new ByteArrayOutputStream();
            Thread outReader = drain(process.getInputStream(), stdout, listener, true);
            Thread errReader = drain(process.getErrorStream(), stderr, listener, false);
            OutputStream stdin = process.getOutputStream();
            String preset = request.optString("stdin", "");
            try {
                if (!preset.isEmpty()) { stdin.write(preset.getBytes(StandardCharsets.UTF_8)); stdin.flush(); }
                if (interactive) activeStdin = stdin; else stdin.close();
            } catch (IOException ignored) { /* 进程已退出 */ }
            boolean finished = process.waitFor(timeout, TimeUnit.MILLISECONDS);
            if (!finished) process.destroyForcibly();
            process.waitFor(2, TimeUnit.SECONDS);
            outReader.join(1000); errReader.join(1000);
            activeStdin = null;
            active = null;
            closeQuietly(stdin);
            String out = stdout.toString("UTF-8"), err = stderr.toString("UTF-8");
            if (!finished) return result("timeout", out, err, -1);
            int code = process.exitValue();
            String status = code == 0 ? "success" : code == SYNTAX_EXIT ? "compile_error" : "runtime_error";
            // 已经通过 listener 增量推送过输出，TaskRegistry 会再追加 final 输出；这里只返回状态
            return result(status, "", "", code);
        } catch (Exception e) {
            return error("runtime_error", e.getMessage() == null ? e.toString() : e.getMessage());
        } finally {
            activeStdin = null;
            active = null;
            deleteTree(work);
        }
    }

    private static Thread drain(InputStream input, ByteArrayOutputStream output, LocalCompiler.ProgressListener listener, boolean isStdout) {
        Thread thread = new Thread(() -> {
            byte[] buffer = new byte[8192];
            long total = 0;
            int read;
            // UTF-8 多字节字符可能被切断：保留不完整的尾部，留到下次拼接
            byte[] pending = new byte[0];
            try {
                while ((read = input.read(buffer)) >= 0) {
                    if (read == 0) continue;
                    int allowed = (int) Math.min(read, Math.max(0, MAX_OUTPUT - total));
                    total += read;
                    if (allowed <= 0) continue;
                    output.write(buffer, 0, allowed);
                    byte[] chunk = new byte[pending.length + allowed];
                    System.arraycopy(pending, 0, chunk, 0, pending.length);
                    System.arraycopy(buffer, 0, chunk, pending.length, allowed);
                    int cut = utf8Boundary(chunk);
                    pending = java.util.Arrays.copyOfRange(chunk, cut, chunk.length);
                    String text = new String(chunk, 0, cut, StandardCharsets.UTF_8);
                    if (!text.isEmpty()) listener.onUpdate("running", isStdout ? text : "", isStdout ? "" : text);
                }
                if (pending.length > 0) {
                    String text = new String(pending, StandardCharsets.UTF_8);
                    listener.onUpdate("running", isStdout ? text : "", isStdout ? "" : text);
                }
            } catch (IOException ignored) { }
        }, "doge-python-reader");
        thread.setDaemon(true);
        thread.start();
        return thread;
    }

    /** 返回最后一个完整 UTF-8 字符之后的位置。 */
    static int utf8Boundary(byte[] data) {
        int n = data.length;
        int i = n - 1, back = 0;
        while (i >= 0 && back < 4 && (data[i] & 0xC0) == 0x80) { i--; back++; }
        if (i < 0) return n;
        int lead = data[i] & 0xFF;
        int need = lead < 0x80 ? 1 : lead >= 0xF0 ? 4 : lead >= 0xE0 ? 3 : lead >= 0xC0 ? 2 : 1;
        return (n - i) >= need ? n : i;
    }

    private static File safeChild(File root, String relative) throws IOException {
        File child = new File(root, relative);
        if (!child.getCanonicalPath().startsWith(root.getCanonicalPath() + File.separator)) throw new IOException("路径无效: " + relative);
        return child;
    }

    private static void closeQuietly(java.io.Closeable c) { try { if (c != null) c.close(); } catch (IOException ignored) { } }

    private static void deleteTree(File file) {
        if (file == null || !file.exists()) return;
        File[] children = file.listFiles();
        if (children != null) for (File child : children) deleteTree(child);
        file.delete();
    }

    private static String result(String status, String stdout, String stderr, int exitCode) {
        try { return new JSONObject().put("status", status).put("stdout", stdout).put("stderr", stderr).put("exit_code", exitCode).toString(); }
        catch (Exception e) { return "{\"status\":\"runtime_error\"}"; }
    }

    private static String error(String status, String message) {
        try { return new JSONObject().put("status", status).put("message", message).toString(); }
        catch (Exception e) { return "{\"status\":\"runtime_error\"}"; }
    }
}
