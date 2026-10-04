package com.doge.ide;

import android.os.Build;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.lang.reflect.Field;
import java.util.concurrent.TimeUnit;

/** File and child-process operations supported by the app's API 24 minimum. */
final class RuntimeCompat {
    private RuntimeCompat() {}

    static byte[] readBytes(File file) throws IOException {
        try (FileInputStream input = new FileInputStream(file); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192];
            int read;
            while ((read = input.read(buffer)) != -1) output.write(buffer, 0, read);
            return output.toByteArray();
        }
    }

    static void writeBytes(File file, byte[] bytes) throws IOException {
        try (FileOutputStream output = new FileOutputStream(file)) { output.write(bytes); }
    }

    static boolean deleteIfExists(File file) throws IOException {
        if (!file.exists()) return false;
        if (!file.delete()) throw new IOException("无法删除文件: " + file);
        return true;
    }

    static void copyFile(File source, File target) throws IOException { copyFile(source, target, false); }

    static void copyFile(File source, File target, boolean replace) throws IOException {
        if (source.getCanonicalFile().equals(target.getCanonicalFile())) return;
        if (!replace && target.exists()) throw new IOException("目标文件已存在: " + target);
        try (FileInputStream input = new FileInputStream(source); FileOutputStream output = new FileOutputStream(target)) {
            byte[] buffer = new byte[8192];
            int read;
            while ((read = input.read(buffer)) != -1) output.write(buffer, 0, read);
        }
    }

    static boolean isAlive(Process process) {
        if (Build.VERSION.SDK_INT >= 26) return process.isAlive();
        try { process.exitValue(); return false; }
        catch (IllegalThreadStateException running) { return true; }
    }

    static boolean waitFor(Process process, long timeout, TimeUnit unit) throws InterruptedException {
        if (Build.VERSION.SDK_INT >= 26) return process.waitFor(timeout, unit);
        long deadline = System.nanoTime() + unit.toNanos(timeout);
        while (isAlive(process)) {
            long remaining = deadline - System.nanoTime();
            if (remaining <= 0) return false;
            Thread.sleep(Math.max(1, Math.min(20, TimeUnit.NANOSECONDS.toMillis(remaining))));
        }
        return true;
    }

    static void terminate(Process process) {
        if (Build.VERSION.SDK_INT >= 26) { process.destroyForcibly(); return; }
        // Android 7 has no public Process.pid()/destroyForcibly(). Its process
        // implementation stores the child PID; killProcess sends SIGKILL.
        try {
            Class<?> type = process.getClass();
            while (type != null) {
                try {
                    Field pid = type.getDeclaredField("pid");
                    pid.setAccessible(true);
                    Object value = pid.get(process);
                    if (value instanceof Number) {
                        long child = ((Number) value).longValue();
                        if (child > 0 && child <= Integer.MAX_VALUE) android.os.Process.killProcess((int) child);
                    }
                    break;
                } catch (NoSuchFieldException absent) { type = type.getSuperclass(); }
            }
        } catch (ReflectiveOperationException | RuntimeException unavailable) {
            // Vendor implementations may hide the PID. Retain the public fallback.
        } finally {
            process.destroy();
        }
    }
}
