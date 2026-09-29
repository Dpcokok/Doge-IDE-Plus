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

    TaskRegistry(LocalCompiler compiler) { this.compiler = compiler; }

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
        Task task = new Task(id, body);
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
        String result = compiler.execute(task.body, (phase, stdout, stderr) -> {
            synchronized (task) {
                if (!"finished".equals(task.phase)) task.phase = phase;
                task.append(stdout, stderr);
            }
        });
        synchronized (task) {
            if (task.cancelRequested && !"canceled".equals(task.status)) {
                task.finish("canceled", "任务已取消");
                return;
            }
            try {
                JSONObject value = new JSONObject(result);
                task.status = value.optString("status", "runtime_error");
                String finalStdout = value.optString("stdout", "");
                String finalStderr = value.optString("stderr", value.optString("message", ""));
                task.stdout = appendBounded(task.stdout, finalStdout);
                task.stderr = appendBounded(task.stderr, finalStderr);
                task.result = result;
            } catch (Exception e) { task.finish("runtime_error", e.toString()); return; }
            task.phase = "finished";
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
            if ("queued".equals(task.phase)) {
                if (task.future != null) task.future.cancel(false);
                task.finish("canceled", "任务已取消");
                return true;
            }
        }
        // worker 为单线程，同一时刻只有一个任务在编译/运行；只有目标任务正在运行时才终止当前进程
        if (id.equals(runningTaskId)) LocalCompiler.cancelActive();
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

    void close() { LocalCompiler.cancelActive(); worker.shutdownNow(); }

    private static final class Task {
        final String id, body;
        String phase = "queued", status = "queued", stdout = "", stderr = "", result = "";
        boolean cancelRequested;
        Future<?> future;
        Task(String id, String body) { this.id = id; this.body = body; }
        // 调用方必须持有本对象锁
        void finish(String value, String message) { status = value; stderr = message; phase = "finished"; notifyAll(); }
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
