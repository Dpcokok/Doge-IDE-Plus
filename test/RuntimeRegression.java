package com.doge.ide;

import android.content.Context;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.File;
import java.lang.reflect.Method;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

/** Executes production runtime classes against real, controlled child processes. */
public final class RuntimeRegression {
    private static int passed, failed;
    private static File root;

    private static void check(String name, boolean condition) {
        if (condition) { passed++; System.out.println("PASS " + name); }
        else { failed++; System.err.println("FAIL " + name); }
    }

    private static void write(File base, String path, String text) throws Exception {
        File file = new File(base, path);
        file.getParentFile().mkdirs();
        Files.writeString(file.toPath(), text);
    }

    private static JSONObject pythonRequest(String entry, int timeout, String stdin) {
        return new JSONObject().put("language", "python").put("entry", entry)
                .put("timeout_ms", timeout).put("stdin", stdin)
                .put("files", new JSONArray().put(new JSONObject().put("path", entry).put("code", "pass")));
    }

    private static PythonRunner pythonRunner(Path child) throws Exception {
        write(root, "python/manifest.json", "{\"python\":\"bin/doge-python.exe\",\"home\":\"prefix\",\"lib\":\"prefix/lib\"}");
        new File(root, "python/prefix/lib").mkdirs();
        new File(root, "python/bin").mkdirs();
        Files.copy(child, new File(root, "python/bin/doge-python.exe").toPath(), StandardCopyOption.REPLACE_EXISTING);
        return new PythonRunner(new Context(root));
    }

    private static void stdinTests(PythonRunner runner) throws Exception {
        long start = System.nanoTime();
        JSONObject result = new JSONObject(runner.execute(pythonRequest("slow.py", 1000, "x".repeat(1024 * 1024)).toString(), (p, o, e) -> {}));
        long elapsed = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - start);
        check("unread preset stdin still times out", "timeout".equals(result.optString("status")));
        check("unread preset stdin returns within bounded cleanup (elapsed=" + elapsed + "ms)", elapsed < 5000);

        String input = "first\n中文\n";
        StringBuffer output = new StringBuffer();
        result = new JSONObject(runner.execute(pythonRequest("echo.py", 3000, input).toString(), (p, o, e) -> output.append(o)));
        check("noninteractive input reaches the child and closes at EOF", "success".equals(result.optString("status")) && input.equals(output.toString()));

        ExecutorService executor = Executors.newSingleThreadExecutor();
        try {
            CountDownLatch waiting = new CountDownLatch(1);
            output.setLength(0);
            JSONObject request = pythonRequest("interactive.py", 3000, "first\n").put("interactive", true);
            Future<String> running = executor.submit(() -> runner.execute(request.toString(), (p, o, e) -> {
                output.append(o);
                if (output.indexOf("LINE:first") >= 0) waiting.countDown();
            }));
            check("interactive preset is delivered first", waiting.await(3, TimeUnit.SECONDS));
            check("live input is accepted after the preset", PythonRunner.sendInput("second\n"));
            result = new JSONObject(running.get(5, TimeUnit.SECONDS));
            check("interactive input remains ordered", "success".equals(result.optString("status")) && output.indexOf("LINE:first") < output.indexOf("LINE:second"));

            CountDownLatch started = new CountDownLatch(1);
            running = executor.submit(() -> runner.execute(pythonRequest("slow.py", 10000, "x".repeat(1024 * 1024)).toString(), (p, o, e) -> {
                if (o.contains("START")) started.countDown();
            }));
            check("child starts while preset input is blocked", started.await(3, TimeUnit.SECONDS));
            PythonRunner.cancelActive();
            running.get(3, TimeUnit.SECONDS);
            check("cancellation unblocks the task", true);
            long writers = Thread.getAllStackTraces().keySet().stream().filter(t -> t.isAlive() && t.getName().equals("doge-python-stdin")).count();
            check("input writer threads are cleaned up", writers == 0);
        } finally {
            PythonRunner.cancelActive();
            executor.shutdownNow();
        }
    }

    private static void compilerTests(Path child) throws Exception {
        for (boolean headerFirst : new boolean[] { false, true }) {
            File projectRoot = new File(root, "compiler-" + headerFirst);
            write(projectRoot, "toolchain/manifest.json", "{\"clang\":\"bin/clang\",\"sysroot\":\"wasi-sysroot\"}");
            new File(projectRoot, "toolchain/bin").mkdirs();
            new File(projectRoot, "toolchain/wasi-sysroot").mkdirs();
            for (String binary : new String[] { "clang", "clang++", "wasm-ld" }) {
                Files.copy(child, new File(projectRoot, "toolchain/bin/" + binary).toPath());
            }
            JSONObject source = new JSONObject().put("path", "main.c").put("code", "#include \"math.h\"\nint main(void){return add(1,2);}");
            JSONObject header = new JSONObject().put("path", "math.h").put("code", "int add(int,int);");
            JSONArray files = new JSONArray();
            if (headerFirst) files.put(header).put(source); else files.put(source).put(header);
            LocalCompiler compiler = new LocalCompiler(new Context(projectRoot));
            JSONObject request = new JSONObject().put("language", "c").put("entry", "main.c").put("files", files);
            JSONObject result = new JSONObject(compiler.execute(request.toString()));
            check("compile project regardless of header order (headerFirst=" + headerFirst + ")", "success".equals(result.optString("status")));

            files = new JSONArray().put(new JSONObject().put("path", "src/main.cpp").put("code", "#include \"include/util.h\"\nint main(){return 0;}"))
                    .put(new JSONObject().put("path", "include/util.h").put("code", "int utility();"));
            request = new JSONObject().put("language", "cpp").put("entry", "src/main.cpp").put("files", files);
            result = new JSONObject(compiler.execute(request.toString()));
            check("subdirectory C++ source sees headers written later", "success".equals(result.optString("status")));
        }
    }

    private static void outputTests(PythonRunner runner) throws Exception {
        TaskRegistry tasks = new TaskRegistry(new LocalCompiler(new Context(root)), runner);
        try {
            JSONObject result = new JSONObject(tasks.runBlocking(pythonRequest("main.py", 3000, "").toString(), 5000));
            check("direct task response includes streamed stdout", "HELLO".equals(result.optString("stdout").trim()));
            result = new JSONObject(tasks.runBlocking(pythonRequest("error.py", 3000, "").toString(), 5000));
            check("direct error response includes streamed stderr", "runtime_error".equals(result.optString("status")) && "PROBLEM".equals(result.optString("stderr").trim()));
            String id = tasks.submit(pythonRequest("slow.py", 1000, "").toString());
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
            JSONObject task;
            do {
                task = tasks.get(id);
                if ("finished".equals(task.optString("phase"))) break;
                Thread.sleep(50);
            } while (System.nanoTime() < deadline);
            check("timed out task output is present exactly once", "timeout".equals(task.optString("status")) && "START".equals(task.optString("stdout").trim()));
            JSONObject finalResult = new JSONObject(task.optString("result"));
            check("stored result agrees with streamed output", task.optString("stdout").equals(finalResult.optString("stdout")));
        } finally {
            tasks.close();
        }
    }

    private static void workspaceTests() throws Exception {
        File projectRoot = new File(root, "workspace-test");
        projectRoot.mkdirs();
        ClangdService service = new ClangdService(new Context(projectRoot));
        Method sync = ClangdService.class.getDeclaredMethod("syncWorkspace", JSONObject.class);
        sync.setAccessible(true);
        try {
            JSONObject source = new JSONObject().put("path", "main.c").put("code", "#include \"old.h\"");
            JSONObject header = new JSONObject().put("path", "old.h").put("code", "int old;");
            File workspace = (File) sync.invoke(service, new JSONObject().put("files", new JSONArray().put(source).put(header)));
            sync.invoke(service, new JSONObject().put("files", new JSONArray().put(source)));
            check("deleted project header is removed from clangd workspace", !new File(workspace, "old.h").exists());
            JSONObject next = new JSONObject().put("path", "src/next.cpp").put("code", "int main(){}");
            sync.invoke(service, new JSONObject().put("files", new JSONArray().put(next)));
            check("files from the previous project do not remain visible", !new File(workspace, "main.c").exists());
            check("current project and compilation database remain available", new File(workspace, "src/next.cpp").isFile() && new File(workspace, "compile_commands.json").isFile());
        } finally {
            service.close();
        }
    }

    public static void main(String[] args) throws Exception {
        root = new File(args[0], "runtime");
        root.mkdirs();
        PythonRunner runner = pythonRunner(Path.of(args[0], "RuntimeChild.exe"));
        if (args[1].equals("stdin") || args[1].equals("all")) stdinTests(runner);
        if (args[1].equals("compiler") || args[1].equals("all")) compilerTests(Path.of(args[0], "RuntimeChild.exe"));
        if (args[1].equals("output") || args[1].equals("all")) outputTests(runner);
        if (args[1].equals("workspace") || args[1].equals("all")) workspaceTests();
        if (!java.util.Set.of("stdin", "compiler", "output", "workspace", "all").contains(args[1])) throw new IllegalArgumentException("Unknown case: " + args[1]);
        System.out.println("Runtime regression: " + passed + " passed, " + failed + " failed");
        if (failed != 0) System.exit(1);
    }
}
