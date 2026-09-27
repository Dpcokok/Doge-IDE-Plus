package com.doge.ide;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.res.Configuration;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.view.inputmethod.InputMethodManager;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.JavascriptInterface;
import android.widget.Toast;
import android.provider.DocumentsContract;
import android.provider.OpenableColumns;
import android.database.Cursor;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.Reader;
import java.io.InputStreamReader;
import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;
import org.json.JSONObject;
import org.json.JSONArray;

/**
 * Doge IDE 平板壳：一个全屏横屏的 WebView，内容由进程内 {@link LocalServer} 提供。
 * 目标形态是 13 寸平板横屏（1280x800dp 左右），所以没有标题栏、系统栏沉浸隐藏、
 * 旋转与软键盘弹出都不会重建 Activity。
 */
public class MainActivity extends Activity {

    private static final String TAG = "DogeIDE";
    private static final int BG = Color.parseColor("#1A1B26");
    private static final long BACK_GRACE_MS = 1200L;
    private static final int PICK_TOOLCHAIN = 42;
    private static final int PICK_PROJECT = 43;
    private static final int PICK_DEPENDENCY = 44;
    private static final int MAX_PROJECT_FILE = 2 * 1024 * 1024;
    private static final long MAX_TOOLCHAIN_BYTES = 1024L * 1024 * 1024;
    private static final int MAX_TOOLCHAIN_ENTRIES = 100000;
    private static final String PROJECT_MANIFEST = ".doge-project.json";

    private WebView web;
    private LocalServer server;
    private DependencyManager dependencyManager;
    private boolean debug;
    private long lastBackAt;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        debug = getIntent() != null && getIntent().getBooleanExtra("debug", false);

        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            // 刘海/打孔屏：内容画到缺口下面，13 寸横屏多出来的那一条不要浪费
            WindowManager.LayoutParams params = getWindow().getAttributes();
            params.layoutInDisplayCutoutMode =
                    WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
            getWindow().setAttributes(params);
        }

        server = new LocalServer(this);
        dependencyManager = new DependencyManager(this);
        String base;
        try {
            base = server.start();
        } catch (Exception e) {
            Log.e(TAG, "local server failed", e);
            toast(getString(R.string.server_failed, String.valueOf(e.getMessage())));
            finish();
            return;
        }

        web = new WebView(this);
        web.setBackgroundColor(BG);
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);
        web.setHorizontalScrollBarEnabled(false);
        web.setVerticalScrollBarEnabled(false);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            // API 26 起才有的渲染进程优先级：切后台时别急着回收渲染进程
            web.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false);
        }
        if (debug) {
            WebView.setWebContentsDebuggingEnabled(true);
        }
        configure(web.getSettings());
        web.addJavascriptInterface(new ToolchainBridge(), "DogeNative");
        web.setWebViewClient(new LocalOnlyClient());
        setContentView(web);

        applyImmersive();
        web.loadUrl(base + "/");
    }

    private final class ToolchainBridge {
        @JavascriptInterface
        public void pickToolchain() {
            runOnUiThread(() -> {
                Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.setType("application/zip");
                startActivityForResult(intent, PICK_TOOLCHAIN);
            });
        }

        @JavascriptInterface
        public boolean isToolchainReady() {
            return new File(getFilesDir(), "toolchain/manifest.json").isFile();
        }

        @JavascriptInterface
        public boolean hasProjectWorkspace() {
            return getPreferences(MODE_PRIVATE).contains("project_tree_uri");
        }

        @JavascriptInterface public void pickDependency(String name, String version) {
            runOnUiThread(() -> { getPreferences(MODE_PRIVATE).edit().putString("dependency_name", name).putString("dependency_version", version).apply(); Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT); intent.addCategory(Intent.CATEGORY_OPENABLE); intent.setType("application/zip"); startActivityForResult(intent, PICK_DEPENDENCY); });
        }
        @JavascriptInterface public String listDependencies() { try { return dependencyManager.list().toString(); } catch (Exception e) { return "{\"packages\":[]}"; } }
        @JavascriptInterface public boolean removeDependency(String name, String version) { try { return dependencyManager.remove(name, version); } catch (Exception e) { return false; } }

        @JavascriptInterface
        public void openProject() {
            runOnUiThread(() -> {
                Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
                intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                        | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION | Intent.FLAG_GRANT_PREFIX_URI_PERMISSION);
                startActivityForResult(intent, PICK_PROJECT);
            });
        }

        @JavascriptInterface
        public boolean saveProject(String json) {
            try {
                Uri tree = projectTreeUri();
                if (tree == null) return false;
                writeProject(tree, new JSONObject(json));
                return true;
            } catch (Exception e) {
                Log.e(TAG, "project save failed", e);
                return false;
            }
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == PICK_PROJECT) {
            if (resultCode != RESULT_OK || data == null || data.getData() == null) return;
            Uri uri = data.getData();
            try {
                int flags = data.getFlags() & (Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
                getContentResolver().takePersistableUriPermission(uri, flags);
            } catch (Exception e) {
                Log.w(TAG, "could not persist project permission", e);
            }
            new Thread(() -> {
                try {
                    JSONObject project = readProject(uri);
                    getPreferences(MODE_PRIVATE).edit().putString("project_tree_uri", uri.toString()).apply();
                    runOnUiThread(() -> {
                        if (web != null) web.evaluateJavascript("window.projectOpened && window.projectOpened(" + JSONObject.quote(project.toString()) + ")", null);
                    });
                } catch (Exception e) {
                    Log.e(TAG, "project open failed", e);
                    notifyProjectError(e.getMessage());
                }
            }, "doge-project-open").start();
            return;
        }
        if (requestCode == PICK_DEPENDENCY) {
            if (resultCode != RESULT_OK || data == null || data.getData() == null) return;
            Uri uri = data.getData(); String name = getPreferences(MODE_PRIVATE).getString("dependency_name", "dependency"); String version = getPreferences(MODE_PRIVATE).getString("dependency_version", "1.0.0");
            new Thread(() -> { try { dependencyManager.install(uri, name, version); runOnUiThread(() -> web.evaluateJavascript("window.dependencyImported && window.dependencyImported(true,'')", null)); } catch (Exception e) { runOnUiThread(() -> web.evaluateJavascript("window.dependencyImported && window.dependencyImported(false," + JSONObject.quote(e.getMessage()) + ")", null)); } }, "doge-dependency-import").start();
            return;
        }
        if (requestCode != PICK_TOOLCHAIN || resultCode != RESULT_OK || data == null || data.getData() == null) return;
        Uri uri = data.getData();
        new Thread(() -> {
            try {
                installToolchain(uri);
                runOnUiThread(() -> {
                    if (web != null) web.evaluateJavascript("window.toolchainImported && window.toolchainImported(true, '')", null);
                });
            } catch (Exception e) {
                Log.e(TAG, "toolchain import failed", e);
                String message = e.getMessage() == null ? "导入失败" : e.getMessage();
                runOnUiThread(() -> {
                    if (web != null) web.evaluateJavascript("window.toolchainImported && window.toolchainImported(false, " + JSONObject.quote(message) + ")", null);
                });
            }
        }, "doge-toolchain-import").start();
    }

    private Uri projectTreeUri() {
        String value = getPreferences(MODE_PRIVATE).getString("project_tree_uri", null);
        return value == null ? null : Uri.parse(value);
    }

    private JSONObject readProject(Uri tree) throws Exception {
        LinkedHashMap<String, String> scanned = new LinkedHashMap<>();
        scanSourceFiles(tree, DocumentsContract.getTreeDocumentId(tree), "", scanned);
        JSONObject manifest = readManifest(tree);
        String name = manifest == null ? null : manifest.optString("name", "");
        JSONArray files = new JSONArray();
        java.util.HashSet<String> added = new java.util.HashSet<>();
        if (manifest != null) {
            JSONArray listed = manifest.optJSONArray("files");
            if (listed != null) {
                for (int i = 0; i < listed.length(); i++) {
                    String path = listed.optString(i, "");
                    if (!isSafeProjectPath(path) || PROJECT_MANIFEST.equals(path) || added.contains(path)) continue;
                    String code = scanned.get(path);
                    if (code == null) continue;
                    files.put(new JSONObject().put("path", path).put("code", code));
                    added.add(path);
                }
            }
        }
        for (Map.Entry<String, String> entry : scanned.entrySet()) {
            if (added.contains(entry.getKey())) continue;
            files.put(new JSONObject().put("path", entry.getKey()).put("code", entry.getValue()));
        }
            JSONObject project = new JSONObject();
            project.put("name", name == null || name.isEmpty() ? queryDisplayName(tree) : name);
            project.put("files", files);
            if (manifest != null) {
                if (manifest.has("buildProfiles")) project.put("buildProfiles", manifest.get("buildProfiles"));
                if (manifest.has("dependencies")) project.put("dependencies", manifest.get("dependencies"));
            }
            return project;
    }

    private void scanSourceFiles(Uri tree, String documentId, String prefix, LinkedHashMap<String, String> files) throws Exception {
        Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, documentId);
        String[] projection = {DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                DocumentsContract.Document.COLUMN_MIME_TYPE};
        try (Cursor cursor = getContentResolver().query(children, projection, null, null, null)) {
            if (cursor == null) return;
            while (cursor.moveToNext()) {
                String id = cursor.getString(0);
                String name = cursor.getString(1);
                String mime = cursor.getString(2);
                if (!isSafeName(name)) continue;
                String path = prefix.isEmpty() ? name : prefix + "/" + name;
                if (DocumentsContract.Document.MIME_TYPE_DIR.equals(mime)) {
                    scanSourceFiles(tree, id, path, files);
                } else if (isSourceFile(name)) {
                    Uri fileUri = DocumentsContract.buildDocumentUriUsingTree(tree, id);
                    String code = readText(fileUri);
                    files.put(path, code);
                }
            }
        }
    }

    private String readText(Uri uri) throws IOException {
        try (InputStream input = getContentResolver().openInputStream(uri);
             ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            if (input == null) throw new IOException("无法读取项目文件");
            byte[] buffer = new byte[8192]; int total = 0; int n;
            while ((n = input.read(buffer)) >= 0) {
                if (n == 0) continue;
                total += n; if (total > MAX_PROJECT_FILE) throw new IOException("项目文件过大: " + uri);
                output.write(buffer, 0, n);
            }
            return output.toString(StandardCharsets.UTF_8.name());
        }
    }

    private void writeProject(Uri tree, JSONObject project) throws Exception {
        JSONArray files = project.optJSONArray("files");
        if (files == null) throw new IOException("项目文件列表无效");
        String rootId = DocumentsContract.getTreeDocumentId(tree);
        JSONObject previousManifest = readManifest(tree);
        JSONArray previousFiles = previousManifest == null ? new JSONArray() : previousManifest.optJSONArray("files");
        java.util.HashSet<String> currentPaths = new java.util.HashSet<>();
        for (int i = 0; i < files.length(); i++) {
            JSONObject file = files.optJSONObject(i); if (file == null) continue;
            String path = file.optString("path", "").replace('\\', '/');
            if (!isSafeProjectPath(path) || PROJECT_MANIFEST.equals(path)) throw new IOException("文件路径无效: " + path);
            currentPaths.add(path);
            String[] parts = path.split("/");
            String parentId = rootId;
            for (int p = 0; p < parts.length - 1; p++) parentId = findOrCreateDirectory(tree, parentId, parts[p]);
            String name = parts[parts.length - 1];
            String id = findChild(tree, parentId, name);
            Uri target;
            if (id == null) {
                Uri created = DocumentsContract.createDocument(getContentResolver(), DocumentsContract.buildDocumentUriUsingTree(tree, parentId), "text/plain", name);
                if (created == null) throw new IOException("无法创建项目文件: " + path);
                target = DocumentsContract.buildDocumentUriUsingTree(tree, DocumentsContract.getDocumentId(created));
            } else target = DocumentsContract.buildDocumentUriUsingTree(tree, id);
            try (OutputStream output = getContentResolver().openOutputStream(target, "wt")) {
                if (output == null) throw new IOException("无法写入项目文件: " + path);
                byte[] data = file.optString("code", "").getBytes(StandardCharsets.UTF_8);
                if (data.length > MAX_PROJECT_FILE) throw new IOException("项目文件过大: " + path);
                output.write(data);
            }
        }
        if (previousFiles != null) {
            for (int i = 0; i < previousFiles.length(); i++) {
                String oldPath = previousFiles.optString(i, "");
                if (!isSafeProjectPath(oldPath) || currentPaths.contains(oldPath)) continue;
                String oldId = findDocumentByPath(tree, oldPath);
                if (oldId != null) DocumentsContract.deleteDocument(getContentResolver(), DocumentsContract.buildDocumentUriUsingTree(tree, oldId));
            }
        }
        JSONObject manifest = new JSONObject();
        manifest.put("format", 1);
        manifest.put("name", project.optString("name", "Project"));
        manifest.put("files", new JSONArray(currentPaths));
        if (project.has("buildProfiles")) manifest.put("buildProfiles", project.get("buildProfiles"));
        if (project.has("dependencies")) manifest.put("dependencies", project.get("dependencies"));
        writeTextFile(tree, rootId, PROJECT_MANIFEST, manifest.toString(2));
    }

    private JSONObject readManifest(Uri tree) throws Exception {
        String id = findChild(tree, DocumentsContract.getTreeDocumentId(tree), PROJECT_MANIFEST);
        if (id == null) return null;
        try {
            return new JSONObject(readText(DocumentsContract.buildDocumentUriUsingTree(tree, id)));
        } catch (org.json.JSONException | IOException e) {
            // 清单损坏时降级为目录扫描，不阻塞打开/保存
            Log.w(TAG, "project manifest unreadable, falling back to directory scan", e);
            return null;
        }
    }

    private void writeTextFile(Uri tree, String parentId, String name, String text) throws Exception {
        String id = findChild(tree, parentId, name);
        Uri target;
        if (id == null) {
            Uri created = DocumentsContract.createDocument(getContentResolver(), DocumentsContract.buildDocumentUriUsingTree(tree, parentId), "application/json", name);
            if (created == null) throw new IOException("无法创建项目清单");
            target = DocumentsContract.buildDocumentUriUsingTree(tree, DocumentsContract.getDocumentId(created));
        } else target = DocumentsContract.buildDocumentUriUsingTree(tree, id);
        try (OutputStream output = getContentResolver().openOutputStream(target, "wt")) {
            if (output == null) throw new IOException("无法写入项目清单");
            output.write(text.getBytes(StandardCharsets.UTF_8));
        }
    }

    private String findDocumentByPath(Uri tree, String path) throws IOException {
        if (!isSafeProjectPath(path)) return null;
        String parentId = DocumentsContract.getTreeDocumentId(tree);
        String[] parts = path.split("/");
        for (int i = 0; i < parts.length; i++) {
            String id = findChild(tree, parentId, parts[i]);
            if (id == null) return null;
            parentId = id;
        }
        return parentId;
    }

    private String findOrCreateDirectory(Uri tree, String parentId, String name) throws IOException {
        String existing = findChild(tree, parentId, name);
        if (existing != null) return existing;
        Uri parent = DocumentsContract.buildDocumentUriUsingTree(tree, parentId);
        Uri created = DocumentsContract.createDocument(getContentResolver(), parent, DocumentsContract.Document.MIME_TYPE_DIR, name);
        if (created == null) throw new IOException("无法创建目录: " + name);
        return DocumentsContract.getDocumentId(created);
    }

    private String findChild(Uri tree, String parentId, String name) throws IOException {
        Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, parentId);
        String[] projection = {DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_DISPLAY_NAME};
        try (Cursor cursor = getContentResolver().query(children, projection, null, null, null)) {
            if (cursor == null) return null;
            while (cursor.moveToNext()) if (name.equals(cursor.getString(1))) return cursor.getString(0);
        }
        return null;
    }

    private String queryDisplayName(Uri uri) {
        try (Cursor cursor = getContentResolver().query(uri, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            return cursor != null && cursor.moveToFirst() ? cursor.getString(0) : "Project";
        } catch (Exception e) { return "Project"; }
    }

    private void notifyProjectError(String message) {
        String safe = message == null ? "项目操作失败" : message;
        runOnUiThread(() -> {
            if (web != null) web.evaluateJavascript("window.projectError && window.projectError(" + JSONObject.quote(safe) + ")", null);
        });
    }

    private static boolean isSafeName(String name) { return name != null && !name.isEmpty() && !".".equals(name) && !"..".equals(name) && !name.contains("/") && !name.contains("\\"); }
    private static boolean isSourceFile(String name) { return name.matches("(?i).+\\.(c|cc|cpp|cxx|h|hh|hpp|hxx)"); }
    private static boolean isSafeProjectPath(String path) { return path != null && path.matches("[A-Za-z0-9._/-]+") && !path.startsWith("/") && !path.contains("..") && !path.endsWith("/"); }

    private void installToolchain(Uri uri) throws IOException {
        File root = new File(getFilesDir(), "toolchain");
        File staging = new File(getFilesDir(), "toolchain.importing");
        deleteTree(staging);
        if (!staging.mkdirs() && !staging.isDirectory()) throw new IOException("无法创建临时目录");
        boolean ok = false;
        try {
            long compressedSize = querySize(uri);
            long requiredSpace = compressedSize > 0
                    ? Math.min(MAX_TOOLCHAIN_BYTES, Math.max(256L * 1024 * 1024, compressedSize * 4L))
                    : 768L * 1024 * 1024;
            if (staging.getUsableSpace() < requiredSpace) {
                throw new IOException("设备剩余空间不足，需要至少 " + (requiredSpace / (1024 * 1024)) + " MiB");
            }
            long progressBytes = 0;
            notifyToolchainProgress(1, "正在读取资源包...");
            try (InputStream raw = getContentResolver().openInputStream(uri);
                 ZipInputStream zip = new ZipInputStream(raw)) {
                if (raw == null) throw new IOException("无法读取资源包");
                ZipEntry entry;
                byte[] buffer = new byte[32768];
                long totalBytes = 0;
                int entryCount = 0;
                while ((entry = zip.getNextEntry()) != null) {
                    if (++entryCount > MAX_TOOLCHAIN_ENTRIES) throw new IOException("资源包条目数量过多");
                    String name = entry.getName().replace('\\', '/');
                    if (name.startsWith("/") || name.contains("../")) throw new IOException("资源包路径无效");
                    File out = new File(staging, name);
                    if (!out.getCanonicalPath().startsWith(staging.getCanonicalPath() + File.separator)) throw new IOException("资源包路径无效");
                    if (entry.isDirectory()) { out.mkdirs(); continue; }
                    File parent = out.getParentFile();
                    if (parent != null) parent.mkdirs();
                    try (OutputStream target = new FileOutputStream(out)) {
                        int n; while ((n = zip.read(buffer)) >= 0) {
                            if (n > 0) {
                                totalBytes += n;
                                progressBytes += n;
                                if (totalBytes > MAX_TOOLCHAIN_BYTES) throw new IOException("资源包解压后过大");
                                target.write(buffer, 0, n);
                                if (compressedSize > 0 && progressBytes % (1024 * 1024) < n) {
                                    int percent = (int) Math.min(95, Math.max(1, progressBytes * 90 / compressedSize + 1));
                                    notifyToolchainProgress(percent, "正在解压资源包...");
                                }
                            }
                        }
                    }
                }
            }
            File manifest = new File(staging, "manifest.json");
            if (!manifest.isFile()) throw new IOException("缺少资源包 manifest.json");
            try {
                JSONObject meta = new JSONObject(new String(java.nio.file.Files.readAllBytes(manifest.toPath()), java.nio.charset.StandardCharsets.UTF_8));
                if (meta.optInt("format", 0) != 1) throw new IOException("不支持的资源包格式");
                File clang = new File(staging, meta.optString("clang", "bin/clang"));
                File sysroot = new File(staging, meta.optString("sysroot", "wasi-sysroot"));
                if (!clang.isFile() || !sysroot.isDirectory()) throw new IOException("资源包缺少 Clang 或 WASI sysroot");
                if (!clang.setExecutable(true, false)) throw new IOException("无法启用 Clang 执行权限");
                for (String executable : new String[]{"clang++", "clang-21", "clang++-21", "wasm-ld", "ld.lld"}) {
                    File file = new File(staging, "bin/" + executable);
                    if (file.isFile() && !file.setExecutable(true, false)) throw new IOException("无法启用工具执行权限: " + executable);
                }
            } catch (org.json.JSONException e) {
                throw new IOException("manifest.json 无效", e);
            }
            deleteTree(root);
            if (!staging.renameTo(root)) throw new IOException("无法安装资源包");
            ok = true;
            notifyToolchainProgress(100, "资源包导入完成");
        } finally {
            if (!ok) deleteTree(staging);
        }
    }

    private long querySize(Uri uri) {
        try (Cursor cursor = getContentResolver().query(uri, new String[]{OpenableColumns.SIZE}, null, null, null)) {
            return cursor != null && cursor.moveToFirst() && !cursor.isNull(0) ? cursor.getLong(0) : -1;
        } catch (Exception ignored) { return -1; }
    }

    private void notifyToolchainProgress(int percent, String message) {
        runOnUiThread(() -> {
            if (web != null) web.evaluateJavascript("window.toolchainProgress && window.toolchainProgress(" + percent + "," + JSONObject.quote(message) + ")", null);
        });
    }

    private static void deleteTree(File file) {
        if (!file.exists()) return;
        File[] children = file.listFiles();
        if (children != null) for (File child : children) deleteTree(child);
        file.delete();
    }

    private void configure(WebSettings s) {
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);          // localStorage：设置、语言、代码草稿
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setGeolocationEnabled(false);
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        s.setSupportMultipleWindows(false);
        s.setMediaPlaybackRequiresUserGesture(true);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setTextZoom(100);                    // 跟随系统字号缩放会打乱固定布局，字号在应用内设置里调
        s.setDefaultTextEncodingName("UTF-8");
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
    }

    /** 站内资源由 LocalServer 提供；站外链接（文档、API Key 页面）交给系统浏览器。 */
    private final class LocalOnlyClient extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri url = request.getUrl();
            String host = url.getHost();
            if ("127.0.0.1".equals(host) || "localhost".equals(host)) {
                return false;
            }
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, url));
            } catch (Exception e) {
                Log.w(TAG, "no handler for " + url, e);
            }
            return true;
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (request != null && request.isForMainFrame()) {
                // WebResourceError 不是 Throwable，只能按字符串记
                Log.e(TAG, "main frame failed: " + url(request) + " -> " + error);
            }
        }

        private String url(WebResourceRequest request) {
            return request.getUrl() != null ? request.getUrl().toString() : "?";
        }
    }

    private void applyImmersive() {
        View decor = getWindow().getDecorView();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            WindowInsetsController controller = getWindow().getInsetsController();
            if (controller != null) {
                controller.hide(WindowInsets.Type.statusBars() | WindowInsets.Type.navigationBars());
                controller.setSystemBarsBehavior(
                        WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            }
            return;
        }
        decor.setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                        | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) {
            applyImmersive();
        }
    }

    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        applyImmersive();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (web != null) {
            web.resumeTimers();
            web.onResume();
        }
        applyImmersive();
    }

    @Override
    protected void onPause() {
        if (web != null) {
            web.onPause();
            web.pauseTimers();
        }
        super.onPause();
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) {
            web.goBack();
            return;
        }
        // 软键盘弹出时系统会先消费返回键；走到这里说明键盘已收起
        View focused = getCurrentFocus();
        if (focused != null) {
            focused.clearFocus();
        }
        hideKeyboard(focused);
        long now = System.currentTimeMillis();
        if (now - lastBackAt < BACK_GRACE_MS) {
            super.onBackPressed();
            return;
        }
        lastBackAt = now;
        toast(getString(R.string.press_back_again));
    }

    private void hideKeyboard(View focused) {
        if (focused == null) {
            return;
        }
        InputMethodManager imm = (InputMethodManager) getSystemService(Context.INPUT_METHOD_SERVICE);
        if (imm != null) {
            imm.hideSoftInputFromWindow(focused.getWindowToken(), 0);
        }
    }

    @Override
    protected void onDestroy() {
        if (web != null) {
            web.stopLoading();
            web.loadUrl("about:blank");
            if (web.getParent() instanceof android.view.ViewGroup) {
                ((android.view.ViewGroup) web.getParent()).removeView(web);
            }
            web.destroy();
            web = null;
        }
        if (server != null) {
            server.close();
            server = null;
        }
        super.onDestroy();
    }

    private void toast(String message) {
        Toast.makeText(this, message, Toast.LENGTH_SHORT).show();
    }
}
