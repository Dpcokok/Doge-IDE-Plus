package com.doge.ide;

import android.content.Context;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.File;
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

    public static void main(String[] args) throws Exception {
        root = new File(args[0], "runtime");
        root.mkdirs();
        PythonRunner runner = pythonRunner(Path.of(args[0], "RuntimeChild.exe"));
        if (args[1].equals("stdin") || args[1].equals("all")) stdinTests(runner);
        else throw new IllegalArgumentException("Unknown case: " + args[1]);
        System.out.println("Runtime regression: " + passed + " passed, " + failed + " failed");
        if (failed != 0) System.exit(1);
    }
}
