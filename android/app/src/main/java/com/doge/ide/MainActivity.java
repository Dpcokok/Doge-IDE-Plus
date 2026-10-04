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
import android.os.Looper;
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
import android.widget.TextView;
import android.app.AlertDialog;
import android.content.ClipboardManager;
import android.content.ClipData;
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
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
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
    private static final int PICK_CREATE_PROJECT = 45;
    private static final int MAX_PROJECT_FILE = 2 * 1024 * 1024;
    private static final long MAX_TOOLCHAIN_BYTES = 1024L * 1024 * 1024;
    private static final int MAX_TOOLCHAIN_ENTRIES = 100000;
    private static final String PROJECT_MANIFEST = ".doge-project.json";

    private WebView web;
    private LocalServer server;
    private DependencyManager dependencyManager;
    private boolean debug;
    private long lastBackAt;
    private String pendingProjectName;
    private String pendingProjectTemplate;
    private final ExecutorService ioExecutor = Executors.newCachedThreadPool();
    // 项目保存必须 FIFO 串行：保证最后一次保存的内容最终落盘
    private final ExecutorService projectExecutor = Executors.newSingleThreadExecutor();
    private final Object projectWriteLock = new Object();
    private volatile boolean destroyed;
    private Thread.UncaughtExceptionHandler previousExceptionHandler;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        previousExceptionHandler = Thread.getDefaultUncaughtExceptionHandler();
        Thread.setDefaultUncaughtExceptionHandler((thread, error) -> {
            showSoftwareError("Java 未捕获异常", error);
        });
        debug = getIntent() != null && getIntent().getBooleanExtra("debug", false);

        if (!isSupportedAbi()) {
            showStartupFailure("此 APK 仅支持 arm64-v8a 设备。当前设备 ABI：" + android.os.Build.SUPPORTED_ABIS[0]);
            return;
        }
        if (!NativeWasmRunner.ensureLoaded()) {
            showStartupFailure("无法加载本地 ARM64 运行库：" + NativeWasmRunner.loadError());
            return;
        }

        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            // 刘海/打孔屏：内容画到缺口下面，13 寸横屏多出来的那一条不要浪费
            WindowManager.LayoutParams params = getWindow().getAttributes();
            params.layoutInDisplayCutoutMode =
                    WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
            getWindow().setAttributes(params);
        }

        server = new LocalServer(this);
        dependencyManager = DependencyManager.get(this);
        String base;
        try {
            base = server.start();
        } catch (Exception e) {
            Log.e(TAG, "local server failed", e);
            showAppError("内置服务启动失败", e);
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

    private boolean isSupportedAbi() {
        for (String abi : android.os.Build.SUPPORTED_ABIS) if ("arm64-v8a".equals(abi)) return true;
        return false;
    }

    private void showStartupFailure(String message) {
        TextView view = new TextView(this);
        view.setText(message);
        view.setTextColor(Color.WHITE);
        view.setTextSize(18);
        view.setPadding(32, 32, 32, 32);
        view.setBackgroundColor(BG);
        view.setGravity(android.view.Gravity.CENTER);
        setContentView(view);
        Toast.makeText(this, message, Toast.LENGTH_LONG).show();
        Log.e(TAG, message);
        new AlertDialog.Builder(this).setTitle("Doge IDE+ 启动失败").setMessage(message + "\n\n错误已复制到剪贴板")
                .setPositiveButton("复制", (dialog, which) -> copyDiagnostic(message)).setNegativeButton("退出", (dialog, which) -> finishAffinity()).setCancelable(false).show();
    }

    private void showSoftwareError(String source, Throwable error) {
        StringWriterPair detail = formatError(source, error);
        persistDiagnostic(detail.text);
        copyDiagnostic(detail.text);
        if (destroyed) return;
        runOnUiThread(() -> showFatalErrorDialog(detail.text));
    }

    private void reportSoftwareErrorInternal(String source, String message, String stack) {
        String detail = source + "\n" + (message == null ? "未知错误" : message) + "\n" + (stack == null ? "" : stack);
        persistDiagnostic(detail);
        copyDiagnostic(detail);
        if (!destroyed) runOnUiThread(() -> showErrorDialog(detail));
    }

    private void showAppError(String title, Throwable error) {
        StringWriterPair detail = formatError(title, error);
        persistDiagnostic(detail.text);
        copyDiagnostic(detail.text);
        if (!destroyed) runOnUiThread(() -> {
            if (isFinishing() || (Build.VERSION.SDK_INT >= 17 && isDestroyed())) return;
            new AlertDialog.Builder(this).setTitle(title)
                    .setMessage(detail.text + "\n\n错误已保存并复制到剪贴板")
                    .setPositiveButton("复制", (dialog, which) -> copyDiagnostic(detail.text))
                    .setNegativeButton("关闭", null).show();
        });
    }

    private void showErrorDialog(String detail) {
        if (isFinishing() || (Build.VERSION.SDK_INT >= 17 && isDestroyed())) return;
        new AlertDialog.Builder(this)
                .setTitle("Doge IDE+ 软件错误")
                .setMessage(detail + "\n\n错误信息已自动复制到剪贴板")
                .setPositiveButton("再次复制", (dialog, which) -> copyDiagnostic(detail))
                .setNegativeButton("关闭", null)
                .show();
    }

    private void showFatalErrorDialog(String detail) {
        if (isFinishing() || (Build.VERSION.SDK_INT >= 17 && isDestroyed())) return;
        new AlertDialog.Builder(this)
                .setTitle("Doge IDE+ 软件崩溃")
                .setMessage(detail + "\n\n错误已保存并复制。请先复制或关闭此窗口，再选择退出。")
                .setCancelable(false)
                .setPositiveButton("复制错误", (dialog, which) -> copyDiagnostic(detail))
                .setNegativeButton("退出应用", (dialog, which) -> {
                    if (previousExceptionHandler != null) previousExceptionHandler.uncaughtException(Thread.currentThread(), new RuntimeException(detail));
                    else finishAffinity();
                })
                .show();
    }

    private void persistDiagnostic(String detail) {
        try {
            File log = new File(getFilesDir(), "last-software-error.txt");
            try (FileOutputStream output = new FileOutputStream(log, false)) {
                output.write(detail.getBytes(StandardCharsets.UTF_8));
            }
        } catch (Exception e) { Log.e(TAG, "could not persist software error", e); }
    }

    private void copyDiagnostic(String detail) {
        ClipboardManager clipboard = (ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
        if (clipboard != null) clipboard.setPrimaryClip(ClipData.newPlainText("Doge IDE+ error", detail));
    }

    private StringWriterPair formatError(String source, Throwable error) {
        java.io.StringWriter writer = new java.io.StringWriter();
        if (error != null) error.printStackTrace(new java.io.PrintWriter(writer));
        return new StringWriterPair(source + "\n" + (error == null ? "未知错误" : error.toString()) + "\n" + writer);
    }

    private static final class StringWriterPair {
        final String text;
        StringWriterPair(String text) { this.text = text; }
    }

    private final class ToolchainBridge {
        @JavascriptInterface
        public void reportSoftwareError(String source, String message, String stack) {
            reportSoftwareErrorInternal(source, message, stack);
        }
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
        public boolean isPythonReady() {
            return new File(getFilesDir(), "python/manifest.json").isFile();
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
        public void createProject(String name, String template) {
            runOnUiThread(() -> {
                String safeName = name == null ? "" : name.trim();
                if (!safeName.matches("[A-Za-z0-9._-]{1,64}")) {
                    notifyProjectError("项目名称只能包含字母、数字、点、下划线和短横线");
                    return;
                }
                pendingProjectName = safeName;
                pendingProjectTemplate = template == null ? "c-empty" : template;
                Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
                intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                        | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION | Intent.FLAG_GRANT_PREFIX_URI_PERMISSION);
                startActivityForResult(intent, PICK_CREATE_PROJECT);
            });
        }

        @JavascriptInterface
        public void saveProject(String json) {
            final Uri tree = projectTreeUri();
            if (tree == null) {
                postToWeb("window.projectSaveResult && window.projectSaveResult(false," + JSONObject.quote("未选择项目目录") + ")");
                return;
            }
            // 与目录 URI 一起捕获：异步保存排队期间用户可能打开另一个项目。
            final String rootId = projectRootId(tree);
            projectExecutor.execute(() -> {
                try {
                    writeProject(tree, new JSONObject(json), rootId);
                    postToWeb("window.projectSaveResult && window.projectSaveResult(true,'')");
                } catch (Exception e) {
                    Log.e(TAG, "project save failed", e);
                    postToWeb("window.projectSaveResult && window.projectSaveResult(false," + JSONObject.quote(messageOf(e)) + ")");
                }
            });
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
                if ((flags & Intent.FLAG_GRANT_READ_URI_PERMISSION) == 0 || (flags & Intent.FLAG_GRANT_WRITE_URI_PERMISSION) == 0) throw new IOException("文件选择器未授予项目读写权限");
                getContentResolver().takePersistableUriPermission(uri, flags);
            } catch (Exception e) {
                showAppError("项目目录授权失败", e);
                return;
            }
            new Thread(() -> {
                try {
                    String rootId = DocumentsContract.getTreeDocumentId(uri);
                    JSONObject project = readProject(uri, rootId);
                    getPreferences(MODE_PRIVATE).edit().putString("project_tree_uri", uri.toString()).putString("project_root_id", rootId).apply();
                    runOnUiThread(() -> {
                        postToWeb("window.projectOpened && window.projectOpened(" + JSONObject.quote(project.toString()) + ")");
                    });
                } catch (Exception e) {
                    Log.e(TAG, "project open failed", e);
                    notifyProjectError(e.getMessage());
                }
            }, "doge-project-open").start();
            return;
        }
        if (requestCode == PICK_CREATE_PROJECT) {
            if (resultCode != RESULT_OK || data == null || data.getData() == null) return;
            Uri parent = data.getData();
            try {
                int flags = data.getFlags() & (Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
                if ((flags & Intent.FLAG_GRANT_WRITE_URI_PERMISSION) == 0) throw new IOException("文件选择器未授予写入权限");
                getContentResolver().takePersistableUriPermission(parent, flags);
            } catch (Exception e) { showAppError("父目录授权失败", e); return; }
            final String name = pendingProjectName;
            final String template = pendingProjectTemplate;
            pendingProjectName = null; pendingProjectTemplate = null;
            new Thread(() -> {
                try {
                    Uri parentDocument = DocumentsContract.buildDocumentUriUsingTree(parent, DocumentsContract.getTreeDocumentId(parent));
                    Uri projectTree = DocumentsContract.createDocument(getContentResolver(), parentDocument,
                            DocumentsContract.Document.MIME_TYPE_DIR, name);
                    if (projectTree == null) throw new IOException("无法创建项目目录");
                    String projectRootId = DocumentsContract.getDocumentId(projectTree);
                    String language = template.startsWith("python") ? "python" : template.startsWith("cpp") ? "cpp" : "c";
                    JSONObject project = new JSONObject().put("name", name).put("language", language).put("files", new JSONArray());
                    if (template.endsWith("-sample")) {
                        String code, file;
                        if ("python".equals(language)) { file = "main.py"; code = "name = input(\"你的名字：\")\nprint(f\"Hello, {name}! 欢迎使用 Doge IDE+\")\n"; }
                        else if ("cpp".equals(language)) { file = "main.cpp"; code = "#include <iostream>\n\nint main() {\n    std::cout << \"Hello, Doge IDE!\\n\";\n    return 0;\n}\n"; }
                        else { file = "main.c"; code = "#include <stdio.h>\n\nint main(void) {\n    printf(\"Hello, Doge IDE!\\n\");\n    return 0;\n}\n"; }
                        project.getJSONArray("files").put(new JSONObject().put("path", file).put("code", code));
                    }
                    writeProject(parent, project, projectRootId);
                    getPreferences(MODE_PRIVATE).edit().putString("project_tree_uri", parent.toString()).putString("project_root_id", projectRootId).apply();
                    postToWeb("window.projectOpened && window.projectOpened(" + JSONObject.quote(project.toString()) + ")");
                } catch (Exception e) { showAppError("创建项目失败", e); }
            }, "doge-project-create").start();
            return;
        }
        if (requestCode == PICK_DEPENDENCY) {
            if (resultCode != RESULT_OK || data == null || data.getData() == null) return;
            Uri uri = data.getData(); String name = getPreferences(MODE_PRIVATE).getString("dependency_name", "dependency"); String version = getPreferences(MODE_PRIVATE).getString("dependency_version", "1.0.0");
            ioExecutor.execute(() -> { try { dependencyManager.install(uri, name, version); postToWeb("window.dependencyImported && window.dependencyImported(true,''," + JSONObject.quote(name) + "," + JSONObject.quote(version) + ")"); } catch (Exception e) { showAppError("依赖导入失败", e); postToWeb("window.dependencyImported && window.dependencyImported(false," + JSONObject.quote(messageOf(e)) + ")"); } });
            return;
        }
        if (requestCode != PICK_TOOLCHAIN || resultCode != RESULT_OK || data == null || data.getData() == null) return;
        Uri uri = data.getData();
        new Thread(() -> {
            try {
                String kind = installToolchain(uri);
                runOnUiThread(() -> {
                    postToWeb("window.toolchainImported && window.toolchainImported(true, '', " + JSONObject.quote(kind) + ")");
                });
            } catch (Exception e) {
                Log.e(TAG, "toolchain import failed", e);
                String message = e.getMessage() == null ? "导入失败" : e.getMessage();
                showAppError("运行库导入失败", e);
                runOnUiThread(() -> {
                    postToWeb("window.toolchainImported && window.toolchainImported(false, " + JSONObject.quote(message) + ")");
                });
            }
        }, "doge-toolchain-import").start();
    }

    private Uri projectTreeUri() {
        String value = getPreferences(MODE_PRIVATE).getString("project_tree_uri", null);
        return value == null ? null : Uri.parse(value);
    }

    private String projectRootId(Uri authorizedTree) {
        String rootId = getPreferences(MODE_PRIVATE).getString("project_root_id", null);
        return rootId == null ? DocumentsContract.getTreeDocumentId(authorizedTree) : rootId;
    }

    private JSONObject readProject(Uri tree, String rootId) throws Exception {
        LinkedHashMap<String, String> scanned = new LinkedHashMap<>();
        scanSourceFiles(tree, rootId, "", scanned);
        JSONObject manifest = readManifest(tree, rootId);
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
                if (manifest.has("language")) project.put("language", manifest.get("language"));
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
        writeProject(tree, project, projectRootId(tree));
    }

    private void writeProject(Uri tree, JSONObject project, String rootId) throws Exception {
        // writeProject 是多步非原子操作（读清单→逐文件写→写清单→删陈旧文件），并发执行会产生重复文件或互相回滚
        synchronized (projectWriteLock) {
            writeProjectLocked(tree, project, rootId);
        }
    }

    private void writeProjectLocked(Uri tree, JSONObject project, String rootId) throws Exception {
        JSONArray files = project.optJSONArray("files");
        if (files == null) throw new IOException("项目文件列表无效");
        JSONObject previousManifest = readManifest(tree, rootId);
        String previousManifestText = previousManifest == null ? null : previousManifest.toString(2);
        JSONArray previousFiles = previousManifest == null ? new JSONArray() : previousManifest.optJSONArray("files");
        java.util.HashSet<String> currentPaths = new java.util.HashSet<>();
        LinkedHashMap<String, byte[]> previousContents = new LinkedHashMap<>();
        ArrayList<String> createdPaths = new ArrayList<>();
        boolean committed = false;
        try {
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
            if (id != null) {
                Uri oldUri = DocumentsContract.buildDocumentUriUsingTree(tree, id);
                try (InputStream old = getContentResolver().openInputStream(oldUri); ByteArrayOutputStream bytes = new ByteArrayOutputStream()) {
                    if (old != null) { byte[] buffer = new byte[8192]; int n; while ((n = old.read(buffer)) > 0) { if (bytes.size() + n > MAX_PROJECT_FILE) throw new IOException("已有文件过大，无法建立保存回滚副本: " + path); bytes.write(buffer, 0, n); } }
                    previousContents.put(path, bytes.toByteArray());
                }
            } else {
                createdPaths.add(path);
            }
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
        JSONObject manifest = new JSONObject();
        manifest.put("format", 1);
        manifest.put("name", project.optString("name", "Project"));
        String language = project.optString("language", "");
        if ("c".equals(language) || "cpp".equals(language) || "python".equals(language)) manifest.put("language", language);
        manifest.put("files", new JSONArray(currentPaths));
        if (project.has("buildProfiles")) manifest.put("buildProfiles", project.get("buildProfiles"));
        if (project.has("dependencies")) manifest.put("dependencies", project.get("dependencies"));
        writeTextFile(tree, rootId, PROJECT_MANIFEST, manifest.toString(2));
        committed = true;
        if (previousFiles != null) {
            for (int i = 0; i < previousFiles.length(); i++) {
                String oldPath = previousFiles.optString(i, "");
                if (!isSafeProjectPath(oldPath) || currentPaths.contains(oldPath)) continue;
                try {
                    String oldId = findDocumentByPath(tree, oldPath, rootId);
                    if (oldId != null) DocumentsContract.deleteDocument(getContentResolver(), DocumentsContract.buildDocumentUriUsingTree(tree, oldId));
                } catch (Exception cleanupError) { Log.w(TAG, "could not remove stale project file " + oldPath, cleanupError); }
            }
        }
        } finally {
            if (!committed) {
                for (String path : createdPaths) {
                    try { String id = findDocumentByPath(tree, path, rootId); if (id != null) DocumentsContract.deleteDocument(getContentResolver(), DocumentsContract.buildDocumentUriUsingTree(tree, id)); } catch (Exception rollbackError) { Log.w(TAG, "project save rollback could not remove " + path, rollbackError); }
                }
                for (Map.Entry<String, byte[]> entry : previousContents.entrySet()) {
                    try { String id = findDocumentByPath(tree, entry.getKey(), rootId); if (id != null) try (OutputStream output = getContentResolver().openOutputStream(DocumentsContract.buildDocumentUriUsingTree(tree, id), "wt")) { if (output != null) output.write(entry.getValue()); } } catch (Exception rollbackError) { Log.w(TAG, "project save rollback could not restore " + entry.getKey(), rollbackError); }
                }
                try {
                    if (previousManifestText != null) writeTextFile(tree, rootId, PROJECT_MANIFEST, previousManifestText);
                    else {
                        String id = findChild(tree, rootId, PROJECT_MANIFEST);
                        if (id != null) DocumentsContract.deleteDocument(getContentResolver(), DocumentsContract.buildDocumentUriUsingTree(tree, id));
                    }
                } catch (Exception rollbackError) { Log.w(TAG, "project save rollback could not restore manifest", rollbackError); }
            }
        }
    }

    private JSONObject readManifest(Uri tree) throws Exception { return readManifest(tree, projectRootId(tree)); }

    private JSONObject readManifest(Uri tree, String rootId) throws Exception {
        String id = findChild(tree, rootId, PROJECT_MANIFEST);
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
        return findDocumentByPath(tree, path, projectRootId(tree));
    }

    private String findDocumentByPath(Uri tree, String path, String rootId) throws IOException {
        if (!isSafeProjectPath(path)) return null;
        String parentId = rootId;
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
        showAppError("项目操作失败", new IOException(safe));
    }

    private static boolean isSafeName(String name) { return name != null && !name.isEmpty() && !".".equals(name) && !"..".equals(name) && !name.contains("/") && !name.contains("\\"); }
    private static boolean isSourceFile(String name) { return name.matches("(?i).+\\.(c|cc|cpp|cxx|h|hh|hpp|hxx|py|txt|json|csv|md)"); }
    private static boolean isSafeProjectPath(String path) { return path != null && path.matches("[A-Za-z0-9._/-]+") && !path.startsWith("/") && !path.contains("..") && !path.endsWith("/"); }

    /** 资源包导入：按 manifest.kind 安装到 files/toolchain（C/C++，旧包无 kind）或 files/python。返回 kind。 */
    private String installToolchain(Uri uri) throws IOException {
            File staging = new File(getFilesDir(), "runtime.importing");
            File root = null, backup = null;
            String kind = "cpp-toolchain";
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
                JSONObject meta = new JSONObject(new String(RuntimeCompat.readBytes(manifest), java.nio.charset.StandardCharsets.UTF_8));
                if (meta.optInt("format", 0) != 1) throw new IOException("不支持的资源包格式");
                kind = meta.optString("kind", "cpp-toolchain");
                File mainExe;
                if ("python".equals(kind)) {
                    mainExe = safeArchiveChild(staging, meta.optString("python", "bin/doge-python"));
                    File home = safeArchiveChild(staging, meta.optString("home", "prefix"));
                    if (!mainExe.isFile() || !new File(home, "lib/python3.14/os.py").isFile()) throw new IOException("资源包缺少 Python 启动器或标准库");
                    root = new File(getFilesDir(), "python");
                } else if ("cpp-toolchain".equals(kind)) {
                    mainExe = safeArchiveChild(staging, meta.optString("clang", "bin/clang"));
                    File sysroot = safeArchiveChild(staging, meta.optString("sysroot", "wasi-sysroot"));
                    if (!mainExe.isFile() || !sysroot.isDirectory()) throw new IOException("资源包缺少 Clang 或 WASI sysroot");
                    root = new File(getFilesDir(), "toolchain");
                } else throw new IOException("不认识的资源包类型: " + kind);
                backup = new File(root.getPath() + ".previous");
                deleteTree(backup);
                JSONObject checksums = meta.optJSONObject("sha256");
                if (checksums != null) {
                    java.util.Iterator<String> names = checksums.keys();
                    while (names.hasNext()) {
                        String relative = names.next();
                        File checked = safeArchiveChild(staging, relative);
                        if (!checked.isFile() || !sha256(checked).equalsIgnoreCase(checksums.optString(relative))) {
                            throw new IOException("资源包文件校验失败: " + relative);
                        }
                    }
                }
                if (!mainExe.setExecutable(true, false)) throw new IOException("无法启用执行权限: " + mainExe.getName());
                if ("cpp-toolchain".equals(kind)) for (String executable : new String[]{"clang++", "clang-21", "clang++-21", "clangd", "wasm-ld", "ld.lld"}) {
                    File file = new File(staging, "bin/" + executable);
                    if (file.isFile() && !file.setExecutable(true, false)) throw new IOException("无法启用工具执行权限: " + executable);
                }
                RuntimeCompat.writeBytes(new File(staging, ".doge-runtime.json"),
                        new JSONObject().put("generation", java.util.UUID.randomUUID().toString()).toString().getBytes(StandardCharsets.UTF_8));
            } catch (org.json.JSONException e) {
                throw new IOException("manifest.json 无效", e);
            }
            if (root.exists() && !root.renameTo(backup)) throw new IOException("无法暂存旧资源包");
            if (!staging.renameTo(root)) {
                if (backup.exists()) backup.renameTo(root);
                throw new IOException("无法安装资源包");
            }
            deleteTree(backup);
            ok = true;
            notifyToolchainProgress(100, "资源包导入完成");
            return kind;
        } finally {
            if (!ok) {
                deleteTree(staging);
                if (root != null && backup != null && !root.exists() && backup.exists()) backup.renameTo(root);
            }
        }
    }

    private long querySize(Uri uri) {
        try (Cursor cursor = getContentResolver().query(uri, new String[]{OpenableColumns.SIZE}, null, null, null)) {
            return cursor != null && cursor.moveToFirst() && !cursor.isNull(0) ? cursor.getLong(0) : -1;
        } catch (Exception ignored) { return -1; }
    }

    private static File safeArchiveChild(File root, String relative) throws IOException {
        if (relative == null || !relative.matches("[A-Za-z0-9._/-]+") || relative.startsWith("/") || relative.contains("..")) throw new IOException("资源包 manifest 路径无效");
        File child = new File(root, relative);
        if (!child.getCanonicalPath().startsWith(root.getCanonicalPath() + File.separator)) throw new IOException("资源包 manifest 路径无效");
        return child;
    }

    private static String sha256(File file) throws IOException {
        try {
            java.security.MessageDigest digest = java.security.MessageDigest.getInstance("SHA-256");
            try (InputStream input = new java.io.FileInputStream(file)) {
                byte[] buffer = new byte[32768]; int n;
                while ((n = input.read(buffer)) > 0) digest.update(buffer, 0, n);
            }
            StringBuilder value = new StringBuilder();
            for (byte b : digest.digest()) value.append(String.format(java.util.Locale.ROOT, "%02x", b & 0xff));
            return value.toString();
        } catch (java.security.NoSuchAlgorithmException e) { throw new IOException("SHA-256 不可用", e); }
    }

    private void notifyToolchainProgress(int percent, String message) {
        postToWeb("window.toolchainProgress && window.toolchainProgress(" + percent + "," + JSONObject.quote(message) + ")");
    }

    private String messageOf(Exception error) {
        return error.getMessage() == null ? "操作失败" : error.getMessage();
    }

    private void postToWeb(String script) {
        runOnUiThread(() -> {
            if (!destroyed && web != null) web.evaluateJavascript(script, null);
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
        s.setCacheMode(WebSettings.LOAD_NO_CACHE);
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
        destroyed = true;
        ioExecutor.shutdownNow();
        // 不中断正在进行的 SAF 写入，让已排队的保存完成
        projectExecutor.shutdown();
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
