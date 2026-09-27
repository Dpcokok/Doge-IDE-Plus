package com.doge.ide;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
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
import java.io.InputStream;
import java.io.OutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;
import org.json.JSONObject;

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

    private WebView web;
    private LocalServer server;
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
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != PICK_TOOLCHAIN || resultCode != RESULT_OK || data == null || data.getData() == null) return;
        Uri uri = data.getData();
        new Thread(() -> {
            try {
                installToolchain(uri);
                runOnUiThread(() -> web.evaluateJavascript("window.toolchainImported && window.toolchainImported(true, '')", null));
            } catch (Exception e) {
                Log.e(TAG, "toolchain import failed", e);
                String message = e.getMessage() == null ? "导入失败" : e.getMessage().replace("\\", "\\\\").replace("'", "\\'");
                runOnUiThread(() -> web.evaluateJavascript("window.toolchainImported && window.toolchainImported(false, '" + message + "')", null));
            }
        }, "doge-toolchain-import").start();
    }

    private void installToolchain(Uri uri) throws IOException {
        File root = new File(getFilesDir(), "toolchain");
        File staging = new File(getFilesDir(), "toolchain.importing");
        deleteTree(staging);
        if (!staging.mkdirs() && !staging.isDirectory()) throw new IOException("无法创建临时目录");
        try (InputStream raw = getContentResolver().openInputStream(uri);
             ZipInputStream zip = new ZipInputStream(raw)) {
            if (raw == null) throw new IOException("无法读取资源包");
            ZipEntry entry;
            byte[] buffer = new byte[32768];
            while ((entry = zip.getNextEntry()) != null) {
                String name = entry.getName().replace('\\', '/');
                if (name.startsWith("/") || name.contains("../")) throw new IOException("资源包路径无效");
                File out = new File(staging, name);
                if (!out.getCanonicalPath().startsWith(staging.getCanonicalPath() + File.separator)) throw new IOException("资源包路径无效");
                if (entry.isDirectory()) { out.mkdirs(); continue; }
                File parent = out.getParentFile();
                if (parent != null) parent.mkdirs();
                try (OutputStream target = new FileOutputStream(out)) {
                    int n; while ((n = zip.read(buffer)) >= 0) { if (n > 0) target.write(buffer, 0, n); }
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
