package com.doge.ide;

import org.json.JSONArray;
import org.json.JSONObject;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.Future;

/** In-memory queued task model for Android execution jobs. */
final class TaskRegistry {
    private static final int MAX_HISTORY = 20;
    private final LocalCompiler compiler;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final AtomicLong sequence = new AtomicLong();
    private final Map<String, Task> tasks = new LinkedHashMap<>();
    /** worker 当前正在执行的任务 ID。 */
    private volatile String runningTaskId;

    private final PythonRunner python;

    TaskRegistry(LocalCompiler compiler, PythonRunner python) { this.compiler = compiler; this.python = python; }

    private static boolean isPython(String body) {
        try { return "python".equals(new JSONObject(body).optString("language", "")); }
        catch (Exception e) { return false; }
    }

    /** 运行中输入：只投递给正在运行的目标任务。text 为 null 表示 EOF。 */
    boolean sendInput(String id, String text) {
        try { Task task; synchronized (this) { task = tasks.get(id); }
            return task != null && task.session.legacyInput(text).optBoolean("ok", false);
        } catch (Exception e) { return false; }
    }

    synchronized JSONObject input(String id, String sessionId, long seq, String text) throws Exception {
        Task task = tasks.get(id);
        return task == null ? null : task.session.input(sessionId, seq, text);
    }
    synchronized JSONObject events(String id, long after) throws Exception {
        Task task = tasks.get(id);
        return task == null ? null : task.session.events(after).put("task_id", id);
    }

    /** 当前直连执行（/api/v1/execution/run）对应的任务 ID，供 /execution/cancel 精准取消。 */
    private volatile String directTaskId;

    synchronized String submit(String body) throws Exception {
        return submitTask(body).id;
    }

    /**
     * 直连执行：进入同一个单线程 worker 排队，阻塞等待结果。
     * 这样直连执行不会与队列任务并发编译，也就不会共享进程集合被互相取消。
     */
    String runBlocking(String body, long waitMs) throws Exception {
        Task task;
        synchronized (this) { task = submitTask(body); }
        directTaskId = task.id;
        try {
            long deadline = System.currentTimeMillis() + waitMs;
            synchronized (task) {
                while (!"finished".equals(task.phase)) {
                    long left = deadline - System.currentTimeMillis();
                    if (left <= 0) break;
                    task.wait(left);
                }
                if ("finished".equals(task.phase)) return resultOf(task);
            }
            cancel(task.id);
            return new JSONObject().put("status", "timeout").put("message", "等待本地执行结果超时").toString();
        } finally {
            if (task.id.equals(directTaskId)) directTaskId = null;
        }
    }

    boolean cancelDirect() {
        String id = directTaskId;
        return id != null && cancel(id);
    }

    private static String resultOf(Task task) throws Exception {
        if (task.result != null && !task.result.isEmpty()) return task.result;
        return new JSONObject().put("status", task.status).put("stdout", task.stdout)
                .put("stderr", task.stderr).put("message", task.stderr).toString();
    }

    private Task submitTask(String body) throws Exception {
        pruneFinished();
        int unfinished = 0;
        for (Task existing : tasks.values()) {
            synchronized (existing) {
                if (!"finished".equals(existing.phase)) unfinished++;
            }
        }
        if (unfinished >= 20) throw new IllegalStateException("任务队列已满");
        String id = "t" + sequence.incrementAndGet();
        JSONObject request = new JSONObject(body);
        Task task = new Task(id, body, "interactive".equals(request.optString("run_mode")) || request.optBoolean("interactive", false));
        tasks.put(id, task);
        task.future = worker.submit(() -> run(task));
        return task;
    }

    private void run(Task task) {
        synchronized (task) {
            if (task.cancelRequested) { task.finish("canceled", "任务已取消"); return; }
            // 在任务锁内登记，保证 cancel() 看到 running 时一定也能看到 runningTaskId
            runningTaskId = task.id;
            task.phase = "running";
        }
        try {
            runLocked(task);
        } finally {
            runningTaskId = null;
        }
    }

    private void runLocked(Task task) {
        LocalCompiler.ProgressListener listener = (phase, stdout, stderr) -> {
            synchronized (task) {
                if (!"finished".equals(task.phase)) task.phase = phase;
                task.append(stdout, stderr);
                task.session.output(phase, stdout, stderr);
            }
        };
        String result = isPython(task.body) ? python.execute(task.body, listener, task.session) : compiler.execute(task.body, listener, task.session);
        synchronized (task) {
            if (task.cancelRequested && !"canceled".equals(task.status)) {
                task.finish("canceled", "任务已取消");
                return;
            }
            int exitCode = -1;
            try {
                JSONObject value = new JSONObject(result);
                exitCode = value.optInt("exit_code", -1);
                task.status = value.optString("status", "runtime_error");
                String finalStdout = value.optString("stdout", "");
                String finalStderr = value.optString("stderr", value.optString("message", ""));
                boolean completeOutput = value.optBoolean("output_complete", false);
                // Streaming runners have already published output; nonstreamed failure messages still need an event.
                if (value.has("message")) task.session.output(task.phase, "", value.optString("message", ""));
                else if (!completeOutput && !task.session.interactive) task.session.output(task.phase, finalStdout, finalStderr);
                else if (!completeOutput && task.session.interactive) {
                    task.session.output(task.phase, finalStdout.isEmpty() || task.stdout.contains(finalStdout) ? "" : finalStdout,
                            finalStderr.isEmpty() || task.stderr.contains(finalStderr) ? "" : finalStderr);
                }
                task.stdout = appendBounded(completeOutput ? "" : task.stdout, finalStdout);
                task.stderr = appendBounded(completeOutput ? "" : task.stderr, finalStderr);
                // 直连接口和任务快照使用同一份最终输出，保留其他执行元数据。
                value.put("stdout", task.stdout).put("stderr", task.stderr);
                task.result = value.toString();
            } catch (Exception e) { task.finish("runtime_error", e.toString()); return; }
            task.phase = "finished";
            task.session.finish(task.status, exitCode);
            task.notifyAll();
        }
        synchronized (this) { pruneFinished(); }
    }

    synchronized JSONObject list() throws Exception {
        pruneFinished();
        JSONArray values = new JSONArray();
        for (Task task : tasks.values()) values.put(task.snapshot());
        return new JSONObject().put("tasks", values);
    }

    synchronized JSONObject get(String id) throws Exception {
        pruneFinished();
        Task task = tasks.get(id); return task == null ? null : task.snapshot();
    }

    synchronized boolean cancel(String id) {
        Task task = tasks.get(id); if (task == null) return false;
        synchronized (task) {
            if ("finished".equals(task.phase)) return false;
            task.cancelRequested = true;
            task.session.cancel();
            if ("queued".equals(task.phase)) {
                if (task.future != null) task.future.cancel(false);
                task.finish("canceled", "任务已取消");
                return true;
            }
        }
        // worker 为单线程，同一时刻只有一个任务在编译/运行；只有目标任务正在运行时才终止当前进程
        if (id.equals(runningTaskId)) { LocalCompiler.cancelActive(); PythonRunner.cancelActive(); }
        return true;
    }

    synchronized JSONObject output(String id, int stdoutOffset, int stderrOffset) throws Exception {
        Task task = tasks.get(id);
        if (task == null) return null;
        synchronized (task) {
            return new JSONObject().put("task_id", id).put("phase", task.phase).put("status", task.status)
                    .put("stdout", slice(task.stdout, stdoutOffset)).put("stderr", slice(task.stderr, stderrOffset))
                    .put("stdout_offset", task.stdout.length()).put("stderr_offset", task.stderr.length());
        }
    }

    void close() { LocalCompiler.cancelActive(); PythonRunner.cancelActive(); worker.shutdownNow(); }

    private static final class Task {
        final String id, body;
        final RunSession session;
        String phase = "queued", status = "queued", stdout = "", stderr = "", result = "";
        boolean cancelRequested;
        Future<?> future;
        Task(String id, String body, boolean interactive) { this.id = id; this.body = body; session = new RunSession(interactive); }
        // 调用方必须持有本对象锁
        void finish(String value, String message) { status = value; stderr = message; phase = "finished"; session.finish(value, -1); notifyAll(); }
        void append(String out, String err) { stdout = appendBounded(stdout, out); stderr = appendBounded(stderr, err); }
        JSONObject snapshot() throws Exception {
            return new JSONObject().put("task_id", id).put("phase", phase).put("status", status)
                    .put("stdout", stdout).put("stderr", stderr).put("result", result);
        }
    }

    private static String appendBounded(String current, String addition) {
        if (addition == null || addition.isEmpty()) return current;
        int maxChars = 1024 * 1024;
        if (current.length() >= maxChars) return current;
        int keep = Math.min(addition.length(), maxChars - current.length());
        return current + addition.substring(0, keep);
    }

    private static String slice(String value, int offset) {
        int safeOffset = Math.max(0, Math.min(offset, value.length()));
        return value.substring(safeOffset);
    }

    private void pruneFinished() {
        int finished = 0;
        for (Task task : tasks.values()) {
            synchronized (task) {
                if ("finished".equals(task.phase)) finished++;
            }
        }
        while (finished > MAX_HISTORY) {
            String oldest = null;
            for (Map.Entry<String, Task> entry : tasks.entrySet()) {
                synchronized (entry.getValue()) {
                    if ("finished".equals(entry.getValue().phase)) {
                        oldest = entry.getKey();
                        break;
                    }
                }
            }
            if (oldest == null) break;
            tasks.remove(oldest);
            finished--;
        }
    }
}
