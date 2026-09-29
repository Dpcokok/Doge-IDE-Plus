package com.doge.ide;

import android.content.Context;
import android.net.Uri;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.security.MessageDigest;
import java.util.Locale;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;
import org.json.JSONArray;
import org.json.JSONObject;

/** Offline dependency package cache and registry. */
final class DependencyManager {
    private static final long MAX_BYTES = 256L * 1024 * 1024;
    private final Context context;
    private final File root;
    private final File registry;
    private static DependencyManager instance;

    /** 进程内唯一实例：所有 registry.json 读写共用同一把实例锁。 */
    static synchronized DependencyManager get(Context context) {
        if (instance == null) instance = new DependencyManager(context);
        return instance;
    }

    private DependencyManager(Context context) {
        this.context = context.getApplicationContext();
        root = new File(this.context.getFilesDir(), "packages");
        registry = new File(root, "registry.json");
    }
    synchronized JSONObject list() throws Exception { return new JSONObject().put("packages", readRegistry()); }
    synchronized JSONObject install(Uri uri, String name, String version) throws Exception {
        if (!name.matches("[A-Za-z0-9_.-]+") || !version.matches("[A-Za-z0-9_.-]+")) throw new IOException("依赖名称或版本无效");
        if (!root.isDirectory() && !root.mkdirs()) throw new IOException("无法创建依赖目录");
        File staging = new File(root, ".importing-" + System.nanoTime());
        if (!staging.mkdirs()) throw new IOException("无法创建临时目录");
        long total = 0; int entries = 0; boolean ok = false;
        MessageDigest digest;
        try { digest = MessageDigest.getInstance("SHA-256"); } catch (Exception e) { throw new IOException("SHA-256 不可用", e); }
        File destination = new File(root, name + "-" + version);
        File backup = new File(root, ".previous-" + name + "-" + version);
        deleteTree(backup);
        long available = root.getUsableSpace();
        if (available < 16L * 1024 * 1024) { deleteTree(staging); throw new IOException("设备剩余空间不足"); }
        try (InputStream raw = context.getContentResolver().openInputStream(uri); ZipInputStream zip = new ZipInputStream(raw)) {
            if (raw == null) throw new IOException("无法读取依赖包");
            ZipEntry entry; byte[] buffer = new byte[32768];
            while ((entry = zip.getNextEntry()) != null) {
                if (++entries > 50000) throw new IOException("依赖包条目过多");
                String path = entry.getName().replace('\\', '/');
                if (path.startsWith("/") || path.contains("..") || !path.matches("[A-Za-z0-9._/-]+")) throw new IOException("依赖包路径无效");
                File target = new File(staging, path);
                if (!target.getCanonicalPath().startsWith(staging.getCanonicalPath() + File.separator)) throw new IOException("依赖包路径无效");
                if (entry.isDirectory()) { target.mkdirs(); continue; }
                if (target.exists()) throw new IOException("依赖包包含重复路径: " + path);
                File parent = target.getParentFile(); if (parent != null) parent.mkdirs();
                try (FileOutputStream out = new FileOutputStream(target)) { int n; while ((n = zip.read(buffer)) > 0) { total += n; if (total > MAX_BYTES) throw new IOException("依赖包过大"); digest.update(buffer, 0, n); out.write(buffer, 0, n); } }
            }
            if (total + 16L * 1024 * 1024 > available) throw new IOException("设备剩余空间不足");
            String sha256 = hex(digest.digest());
            java.nio.file.Files.write(new File(staging, ".doge-package.json").toPath(), new JSONObject().put("name", name).put("version", version).put("sha256", sha256).toString().getBytes(java.nio.charset.StandardCharsets.UTF_8));
            if (destination.exists() && !destination.renameTo(backup)) throw new IOException("无法备份现有依赖版本");
            if (!staging.renameTo(destination)) throw new IOException("无法安装依赖");
            JSONArray items = readRegistry(); removeEntry(items, name, version);
            items.put(new JSONObject().put("name", name).put("version", version).put("path", destination.getName()).put("sha256", sha256));
            try { writeRegistry(items); } catch (Exception e) { deleteTree(destination); if (backup.exists()) backup.renameTo(destination); throw e; }
            deleteTree(backup); ok = true;
            return new JSONObject().put("name", name).put("version", version).put("path", destination.getName()).put("sha256", sha256);
        } finally { if (!ok) { deleteTree(staging); if (!destination.exists() && backup.exists()) backup.renameTo(destination); } }
    }
    synchronized boolean remove(String name, String version) throws Exception {
        JSONArray items = readRegistry(); String path = null;
        for (int i = 0; i < items.length(); i++) { JSONObject item = items.optJSONObject(i); if (item != null && name.equals(item.optString("name")) && version.equals(item.optString("version"))) path = item.optString("path"); }
        if (path == null) return false; deleteTree(new File(root, path)); removeEntry(items, name, version); writeRegistry(items); return true;
    }
    File packageRoot(String name, String version) { return new File(root, name + "-" + version); }
    synchronized File resolvePackage(String name, String version) throws Exception {
        JSONArray items = readRegistry();
        for (int i = 0; i < items.length(); i++) {
            JSONObject item = items.optJSONObject(i);
            if (item == null || !name.equals(item.optString("name")) || !version.equals(item.optString("version"))) continue;
            String relative = item.optString("path", "");
            if (!relative.matches("[A-Za-z0-9_.-]+")) return null;
            File found = new File(root, relative);
            return found.isDirectory() && found.getCanonicalPath().startsWith(root.getCanonicalPath() + File.separator) ? found : null;
        }
        return null;
    }
    private JSONArray readRegistry() throws Exception { if (!registry.isFile()) return new JSONArray(); return new JSONArray(new String(java.nio.file.Files.readAllBytes(registry.toPath()), java.nio.charset.StandardCharsets.UTF_8)); }
    private void writeRegistry(JSONArray value) throws Exception {
        // 先写临时文件再替换，进程被杀时不会留下写了一半的 registry.json
        File temp = new File(root, "registry.json.tmp");
        java.nio.file.Files.write(temp.toPath(), value.toString(2).getBytes(java.nio.charset.StandardCharsets.UTF_8));
        if (!temp.renameTo(registry)) {
            temp.delete();
            throw new IOException("无法写入依赖注册表");
        }
    }
    private static void removeEntry(JSONArray values, String name, String version) { for (int i = values.length() - 1; i >= 0; i--) { JSONObject item = values.optJSONObject(i); if (item != null && name.equals(item.optString("name")) && version.equals(item.optString("version"))) values.remove(i); } }
    private static void deleteTree(File file) { if (!file.exists()) return; File[] children = file.listFiles(); if (children != null) for (File child : children) deleteTree(child); file.delete(); }
    private static String hex(byte[] bytes) { StringBuilder out = new StringBuilder(bytes.length * 2); for (byte value : bytes) out.append(String.format(Locale.ROOT, "%02x", value & 0xff)); return out.toString(); }
}
