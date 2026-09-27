package com.doge.ide;

import org.json.JSONArray;
import org.json.JSONObject;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicLong;

/** In-memory queued task model for Android execution jobs. */
final class TaskRegistry {
    private final LocalCompiler compiler;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final AtomicLong sequence = new AtomicLong();
    private final Map<String, Task> tasks = new LinkedHashMap<>();

    TaskRegistry(LocalCompiler compiler) { this.compiler = compiler; }

    synchronized String submit(String body) throws Exception {
        if (tasks.size() >= 20) throw new IllegalStateException("任务队列已满");
        String id = "t" + sequence.incrementAndGet();
        Task task = new Task(id, body);
        tasks.put(id, task);
        worker.submit(() -> run(task));
        return id;
    }

    private void run(Task task) {
        synchronized (task) { if (task.cancelRequested) { task.finish("canceled", "任务已取消"); return; } task.phase = "running"; }
        String result = compiler.execute(task.body);
        synchronized (task) {
            try {
                JSONObject value = new JSONObject(result);
                task.status = value.optString("status", "runtime_error");
                task.stdout = value.optString("stdout", "");
                task.stderr = value.optString("stderr", value.optString("message", ""));
                task.result = result;
            } catch (Exception e) { task.finish("runtime_error", e.toString()); return; }
            task.phase = "finished";
        }
    }

    synchronized JSONObject list() throws Exception {
        JSONArray values = new JSONArray();
        for (Task task : tasks.values()) values.put(task.snapshot());
        return new JSONObject().put("tasks", values);
    }

    synchronized JSONObject get(String id) throws Exception {
        Task task = tasks.get(id); return task == null ? null : task.snapshot();
    }

    synchronized boolean cancel(String id) {
        Task task = tasks.get(id); if (task == null) return false;
        synchronized (task) { task.cancelRequested = true; }
        LocalCompiler.cancelActive();
        return true;
    }

    synchronized String output(String id) {
        Task task = tasks.get(id); return task == null ? null : task.stdout + task.stderr;
    }

    void close() { LocalCompiler.cancelActive(); worker.shutdownNow(); }

    private static final class Task {
        final String id, body;
        String phase = "queued", status = "queued", stdout = "", stderr = "", result = "";
        boolean cancelRequested;
        Task(String id, String body) { this.id = id; this.body = body; }
        void finish(String value, String message) { status = value; stderr = message; phase = "finished"; }
        JSONObject snapshot() throws Exception {
            return new JSONObject().put("task_id", id).put("phase", phase).put("status", status)
                    .put("stdout", stdout).put("stderr", stderr).put("result", result);
        }
    }
}
