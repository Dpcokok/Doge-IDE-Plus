package com.doge.ide;

import org.json.JSONArray;
import org.json.JSONObject;
import java.io.Closeable;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

/** Owns one run's bounded input queue and ordered, replayable terminal events. */
final class RunSession {
    interface InputSink extends Closeable { void write(byte[] bytes) throws IOException; }
    private static final int MAX_INPUT = 64 * 1024, MAX_PENDING = 256 * 1024;
    private static final int MAX_EVENTS_BYTES = 2 * 1024 * 1024, MAX_EVENTS = 4096;
    final String id = UUID.randomUUID().toString();
    final boolean interactive;
    private final ArrayDeque<Input> inputs = new ArrayDeque<>();
    private final ArrayDeque<Event> events = new ArrayDeque<>();
    private final Map<Long, String> accepted = new LinkedHashMap<>();
    private InputSink sink;
    private Runnable stop;
    private Thread writer;
    private boolean canceled, finished, inputClosed;
    private String phase = "queued", status = "queued";
    private long eventSequence, inputSequence;
    private int pendingBytes, eventBytes;
    private byte[] nativeOutTail = new byte[0], nativeErrTail = new byte[0];

    RunSession(boolean interactive) { this.interactive = interactive; }
    synchronized boolean isCanceled() { return canceled; }

    void bind(InputSink next, Runnable cancel, String preset) {
        synchronized (this) {
            if (!canceled && !finished) {
                sink = next;
                stop = cancel;
                phase = "running"; status = "running";
                if (preset != null && !preset.isEmpty()) {
                    byte[] bytes = preset.getBytes(StandardCharsets.UTF_8);
                    inputs.add(new Input(bytes));
                    pendingBytes += bytes.length;
                }
                if (!interactive) { inputs.add(new Input(null)); inputClosed = true; }
                writer = new Thread(this::writeLoop, "doge-run-stdin");
                writer.setDaemon(true);
                writer.start();
                stateEvent();
                notifyAll();
                return;
            }
        }
        cancel.run();
        closeQuietly(next);
    }

    synchronized JSONObject input(String sessionId, long sequence, String text) throws Exception {
        if (!id.equals(sessionId)) return rejected("wrong_session", "运行会话已变化");
        byte[] bytes = text == null ? null : text.getBytes(StandardCharsets.UTF_8);
        if (bytes != null && bytes.length > MAX_INPUT) return rejected("input_too_large", "单次输入不能超过 64 KiB");
        String signature = text == null ? "EOF" : java.util.Arrays.toString(java.security.MessageDigest.getInstance("SHA-256").digest(bytes));
        if (sequence <= inputSequence) {
            if (signature.equals(accepted.get(sequence))) return acknowledgment();
            return rejected("input_conflict", "输入序号已使用或已过期");
        }
        if (sequence != inputSequence + 1) return rejected("input_sequence", "输入序号不连续");
        if (canceled || finished || inputClosed || sink == null || !interactive) return rejected("input_closed", "程序当前无法接收输入");
        if (bytes != null && pendingBytes + bytes.length > MAX_PENDING) return rejected("input_queue_full", "输入队列已满，请稍后重试");
        inputs.add(new Input(bytes));
        if (bytes == null) inputClosed = true; else pendingBytes += bytes.length;
        inputSequence = sequence;
        accepted.put(sequence, signature);
        while (accepted.size() > 64) accepted.remove(accepted.keySet().iterator().next());
        if (text != null) textEvent("stdin", text, sequence);
        stateEvent();
        notifyAll();
        return acknowledgment();
    }

    synchronized JSONObject legacyInput(String text) throws Exception { return input(id, inputSequence + 1, text); }

    private JSONObject acknowledgment() throws Exception {
        return new JSONObject().put("ok", true).put("session_id", id).put("accepted_seq", inputSequence);
    }
    private JSONObject rejected(String code, String message) throws Exception {
        return new JSONObject().put("ok", false).put("status", "input_rejected").put("code", code).put("message", message).put("accepted_seq", inputSequence);
    }

    private void writeLoop() {
        InputSink target;
        synchronized (this) { target = sink; }
        try {
            while (true) {
                Input frame;
                synchronized (this) {
                    while (inputs.isEmpty() && !canceled && !finished) wait();
                    if (canceled || finished) return;
                    frame = inputs.removeFirst();
                }
                if (frame.bytes == null) { target.close(); return; }
                target.write(frame.bytes);
                synchronized (this) { pendingBytes = Math.max(0, pendingBytes - frame.bytes.length); }
            }
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
        } catch (IOException failure) {
            synchronized (this) {
                if (!finished && !canceled) textEvent("system", "\n[输入管道已关闭]\n", 0);
            }
        } finally {
            synchronized (this) { inputClosed = true; inputs.clear(); pendingBytes = 0; if (!finished) stateEvent(); }
        }
    }

    void cancel() {
        Runnable action;
        synchronized (this) { canceled = true; inputClosed = true; inputs.clear(); action = stop; notifyAll(); }
        // Killing/closing a child releases a writer blocked in a full pipe. No I/O while holding the session lock.
        if (action != null) action.run();
    }

    void finish(String finalStatus, int exitCode) {
        synchronized (this) {
            if (finished) return;
            finished = true; phase = "finished"; status = finalStatus; inputClosed = true;
            inputs.clear(); notifyAll();
            try { add(new JSONObject().put("kind", "exit").put("status", status).put("exit_code", exitCode)); }
            catch (Exception impossible) { throw new IllegalStateException(impossible); }
        }
    }

    void closeInput() {
        InputSink target;
        Thread thread;
        synchronized (this) { target = sink; thread = writer; sink = null; inputClosed = true; canceled = true; notifyAll(); }
        closeQuietly(target);
        if (thread != null && thread != Thread.currentThread()) {
            try { thread.join(1000); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
        }
    }

    synchronized void output(String nextPhase, String stdout, String stderr) {
        if (finished) return;
        if (!phase.equals(nextPhase)) { phase = nextPhase; status = "running"; stateEvent(); }
        if (stdout != null && !stdout.isEmpty()) textEvent("stdout", stdout, 0);
        if (stderr != null && !stderr.isEmpty()) textEvent("stderr", stderr, 0);
    }

    // Called by JNI before starting guest execution. Control methods do not hold the run monitor.
    @SuppressWarnings("unused")
    public void onNativeReady(long handle) {
        bind(new InputSink() {
            public void write(byte[] bytes) throws IOException { if (!NativeWasmRunner.writeInput(handle, bytes)) throw new IOException("WASI input closed"); }
            public void close() { NativeWasmRunner.closeInput(handle); }
        }, () -> NativeWasmRunner.cancelRun(handle), "");
    }

    @SuppressWarnings("unused")
    public synchronized void onNativeOutput(byte[] bytes, boolean stderr) {
        byte[] tail = stderr ? nativeErrTail : nativeOutTail;
        byte[] combined = new byte[tail.length + bytes.length];
        System.arraycopy(tail, 0, combined, 0, tail.length);
        System.arraycopy(bytes, 0, combined, tail.length, bytes.length);
        int boundary = PythonRunner.utf8Boundary(combined);
        tail = java.util.Arrays.copyOfRange(combined, boundary, combined.length);
        if (stderr) nativeErrTail = tail; else nativeOutTail = tail;
        String text = new String(combined, 0, boundary, StandardCharsets.UTF_8);
        output("running", stderr ? "" : text, stderr ? text : "");
    }

    synchronized JSONObject events(long after) throws Exception {
        long first = events.isEmpty() ? eventSequence + 1 : events.getFirst().sequence;
        JSONArray result = new JSONArray();
        long next = Math.max(after, first - 1);
        int bytes = 0;
        for (Event event : events) {
            if (event.sequence <= after) continue;
            if (bytes > 0 && bytes + event.bytes > 64 * 1024) break;
            result.put(event.value); next = event.sequence; bytes += event.bytes;
        }
        return metadata().put("events", result).put("first_seq", first).put("next_seq", next)
                .put("gap", after < first - 1).put("has_more", next < eventSequence);
    }

    synchronized JSONObject metadata() throws Exception {
        return new JSONObject().put("session_id", id).put("phase", phase).put("status", status)
                .put("input_ready", sink != null && !inputClosed && !canceled && !finished)
                .put("input_closed", inputClosed).put("accepted_seq", inputSequence).put("last_seq", eventSequence);
    }

    private void stateEvent() {
        try { add(metadata().put("kind", "state")); }
        catch (Exception e) { throw new IllegalStateException(e); }
    }
    private void textEvent(String stream, String text, long inputSeq) {
        // Keep individual frames small and never split a UTF-16 surrogate pair.
        for (int start = 0; start < text.length();) {
            int end = Math.min(text.length(), start + 4096);
            if (end < text.length() && Character.isHighSurrogate(text.charAt(end - 1))) end--;
            try { add(new JSONObject().put("kind", "data").put("stream", stream).put("text", text.substring(start, end)).put("input_seq", inputSeq)); }
            catch (Exception e) { throw new IllegalStateException(e); }
            start = end;
        }
    }
    private void add(JSONObject value) throws Exception {
        long sequence = ++eventSequence;
        value.put("seq", sequence);
        Event event = new Event(sequence, value);
        events.add(event); eventBytes += event.bytes;
        while (eventBytes > MAX_EVENTS_BYTES || events.size() > MAX_EVENTS) eventBytes -= events.removeFirst().bytes;
    }
    private static void closeQuietly(Closeable value) { try { if (value != null) value.close(); } catch (IOException ignored) {} }
    private static final class Input { final byte[] bytes; Input(byte[] bytes) { this.bytes = bytes; } }
    private static final class Event {
        final long sequence; final JSONObject value; final int bytes;
        Event(long sequence, JSONObject value) { this.sequence = sequence; this.value = value; bytes = value.toString().getBytes(StandardCharsets.UTF_8).length; }
    }
}
