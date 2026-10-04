package com.doge.ide;

import android.content.Context;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import org.json.*;

/** Minimal persistent clangd stdio/LSP bridge for completion, diagnostics and definition. */
final class ClangdService implements Closeable {
    private final File filesDir;
    private final File toolchain;
    private Process process;
    private InputStream input;
    private OutputStream output;
    private int sequence;
    private final Object lock = new Object();
    private final ExecutorService ioExecutor = Executors.newSingleThreadExecutor();
    private static final long REQUEST_TIMEOUT_MS = 5000L;

    ClangdService(Context context) {
        Context app = context.getApplicationContext();
        filesDir = app.getFilesDir(); toolchain = new File(filesDir, "toolchain");
    }

    Object request(JSONObject body, String method) throws Exception {
        synchronized (lock) {
            File root = syncWorkspace(body);
            ensureStarted(root);
            String path = body.optString("path", "main.c");
            File file = new File(root, path);
            String uri = file.toURI().toString();
            JSONObject didOpen = new JSONObject().put("jsonrpc", "2.0").put("method", "textDocument/didOpen")
                    .put("params", new JSONObject().put("textDocument", new JSONObject().put("uri", uri).put("languageId", path.endsWith(".cpp") ? "cpp" : "c").put("version", 1).put("text", read(file))));
            sendWithTimeout(didOpen);
            JSONObject params = new JSONObject().put("textDocument", new JSONObject().put("uri", uri)).put("position", new JSONObject().put("line", Math.max(0, body.optInt("line", 0))).put("character", Math.max(0, body.optInt("column", 0))));
            JSONObject response = sendWithTimeout(new JSONObject().put("jsonrpc", "2.0").put("id", ++sequence).put("method", method).put("params", params));
            Object result = response == null ? null : response.opt("result");
            // LSP 补全和定义都允许数组；保留协议中的对象/数组形状交给前端解析。
            return result instanceof JSONObject || result instanceof JSONArray ? result : new JSONObject();
        }
    }

    private void ensureStarted(File root) throws Exception {
        if (process != null && RuntimeCompat.isAlive(process)) return;
        File clangd = new File(toolchain, "bin/clangd"); if (!clangd.isFile()) throw new IOException("资源包中没有 clangd"); clangd.setExecutable(true, false);
        ProcessBuilder builder = new ProcessBuilder(clangd.getAbsolutePath(), "--compile-commands-dir=" + root.getAbsolutePath(), "--background-index=false", "-j=1");
        builder.directory(root); builder.environment().put("HOME", filesDir.getAbsolutePath()); builder.environment().put("PATH", new File(toolchain, "bin").getAbsolutePath()); builder.environment().put("LD_LIBRARY_PATH", new File(toolchain, "lib").getAbsolutePath());
        process = builder.start(); input = process.getInputStream(); output = process.getOutputStream();
        startStderrReader(process.getErrorStream());
        sendWithTimeout(new JSONObject().put("jsonrpc", "2.0").put("id", ++sequence).put("method", "initialize").put("params", new JSONObject().put("rootUri", root.toURI().toString()).put("capabilities", new JSONObject())));
        sendWithTimeout(new JSONObject().put("jsonrpc", "2.0").put("method", "initialized").put("params", new JSONObject()));
    }

    private JSONObject send(JSONObject message) throws Exception {
        byte[] data = message.toString().getBytes(StandardCharsets.UTF_8);
        output.write(("Content-Length: " + data.length + "\r\n\r\n").getBytes(StandardCharsets.US_ASCII)); output.write(data); output.flush();
        if (!message.has("id")) return null;
        while (true) {
            String line; int length = -1;
            while ((line = readLine(input)) != null && !line.isEmpty()) if (line.toLowerCase().startsWith("content-length:")) length = Integer.parseInt(line.substring(15).trim());
            if (length < 0) throw new IOException("clangd 响应无效");
            byte[] payload = readFully(input, length); JSONObject value = new JSONObject(new String(payload, StandardCharsets.UTF_8));
            if (value.optInt("id", -1) == message.optInt("id", -2)) return value;
        }
    }

    private JSONObject sendWithTimeout(JSONObject message) throws Exception {
        try {
            return ioExecutor.submit(() -> send(message)).get(REQUEST_TIMEOUT_MS, TimeUnit.MILLISECONDS);
        } catch (java.util.concurrent.TimeoutException timeout) {
            destroyProcess();
            throw new IOException("clangd 响应超时");
        }
    }

    private void startStderrReader(InputStream error) {
        Thread reader = new Thread(() -> {
            byte[] buffer = new byte[1024];
            try { while (error.read(buffer) >= 0) { /* drain clangd diagnostics */ } }
            catch (IOException ignored) { }
        });
        reader.setDaemon(true);
        reader.setName("doge-clangd-stderr");
        reader.start();
    }
    private File syncWorkspace(JSONObject body) throws Exception {
        File root = new File(filesDir, "workspace/clangd"); if (!root.isDirectory() && !root.mkdirs()) throw new IOException("无法创建 clangd 工作区"); JSONArray files = body.optJSONArray("files");
        java.util.Set<String> currentPaths = new java.util.HashSet<>();
        if (files != null) for (int i = 0; i < files.length(); i++) {
            JSONObject file = files.optJSONObject(i);
            if (file == null) continue;
            String path = file.optString("path", "").replace('\\', '/');
            if (isSafeRelativePath(path)) currentPaths.add(path);
        }
        // 删除的头文件也会影响已有 AST；清理后重启，避免缓存仍解析到旧文件。
        if (removeStaleFiles(root, root, currentPaths)) destroyProcess();
        if (files != null) for (int i=0;i<files.length();i++) { JSONObject f=files.optJSONObject(i); if(f==null)continue; String p=f.optString("path","").replace('\\','/'); if(!isSafeRelativePath(p))continue; File target=safeChild(root,p); if(target.getParentFile()!=null && !target.getParentFile().isDirectory() && !target.getParentFile().mkdirs()) throw new IOException("无法创建 clangd 文件目录"); RuntimeCompat.writeBytes(target,f.optString("code","").getBytes(StandardCharsets.UTF_8)); }
        // 头文件查找与真实编译一致：源文件所在目录（clang 对 "…" 默认就查）、项目根、构建配置 include_paths；宏定义同样带上
        JSONObject build = body.optJSONObject("build");
        JSONArray includePaths = build == null ? null : build.optJSONArray("include_paths");
        JSONArray defines = build == null ? null : build.optJSONArray("defines");
        JSONArray commands = new JSONArray();
        if (files != null) for (int i=0;i<files.length();i++) {
            JSONObject f=files.optJSONObject(i); if(f==null)continue;
            String p=f.optString("path","").replace('\\','/'); if(!isSafeRelativePath(p))continue;
            String lower=p.toLowerCase(java.util.Locale.ROOT);
            if(!(lower.endsWith(".c")||lower.endsWith(".cc")||lower.endsWith(".cpp")||lower.endsWith(".cxx")))continue;
            File source=safeChild(root,p); String compiler=lower.endsWith(".c")?"clang":"clang++";
            JSONArray args = new JSONArray().put(new File(toolchain,"bin/"+compiler).getAbsolutePath()).put("--target=wasm32-wasip1")
                    .put("--sysroot="+new File(toolchain,"wasi-sysroot").getAbsolutePath()).put("-std="+(lower.endsWith(".c")?"c17":"c++20"))
                    // -iquote 只作用于 #include "…"，不会让项目里的 math.h 挡住 <math.h>
                    .put("-iquote").put(root.getAbsolutePath());
            if (includePaths != null) for (int k=0;k<includePaths.length();k++) {
                String inc = includePaths.optString(k,"").replace('\\','/');
                while (inc.startsWith("./")) inc = inc.substring(2);
                while (inc.endsWith("/")) inc = inc.substring(0, inc.length()-1);
                if (inc.isEmpty() || !isSafeRelativePath(inc)) continue;
                args.put("-I"+safeChild(root,inc).getAbsolutePath());
            }
            if (defines != null) for (int k=0;k<defines.length();k++) {
                String d = defines.optString(k,""); if (d.matches("[A-Za-z_][A-Za-z0-9_]*(=.*)?")) args.put("-D"+d);
            }
            args.put("-fsyntax-only").put(source.getAbsolutePath());
            commands.put(new JSONObject().put("directory",root.getAbsolutePath()).put("file",source.getAbsolutePath()).put("arguments",args));
        }
        String json = commands.toString(2);
        File cc = new File(root, "compile_commands.json");
        // 编译参数变了（例如新增 include 路径）要让 clangd 重新读取：内容不同才写，并重启 clangd
        String old = cc.isFile() ? read(cc) : "";
        if (!json.equals(old)) {
            RuntimeCompat.writeBytes(cc, json.getBytes(StandardCharsets.UTF_8));
            if (!old.isEmpty()) destroyProcess();
        }
        return root;
    }
    private static boolean removeStaleFiles(File root, File directory, java.util.Set<String> currentPaths) throws IOException {
        File[] children = directory.listFiles();
        if (children == null) return false;
        boolean changed = false;
        String rootPrefix = root.getCanonicalPath() + File.separator;
        for (File child : children) {
            String path = child.getAbsolutePath().substring(root.getAbsolutePath().length() + 1).replace(File.separatorChar, '/');
            if ("compile_commands.json".equals(path) || path.startsWith(".")) continue;
            // 对指向工作区外的链接只删除链接本身，不递归访问其目标。
            if (!child.getCanonicalPath().startsWith(rootPrefix)) {
                if (!child.delete()) throw new IOException("无法清理 clangd 链接: " + path);
                changed = true;
            } else if (child.isDirectory()) {
                changed |= removeStaleFiles(root, child, currentPaths);
                File[] remaining = child.listFiles();
                if (remaining != null && remaining.length == 0) child.delete();
            } else if (!currentPaths.contains(path)) {
                if (!child.delete()) throw new IOException("无法清理 clangd 文件: " + path);
                changed = true;
            }
        }
        return changed;
    }
    private static String read(File f) throws IOException { return new String(RuntimeCompat.readBytes(f), StandardCharsets.UTF_8); }
    private static String readLine(InputStream in) throws IOException { StringBuilder s=new StringBuilder(); int c; while((c=in.read())!=-1){if(c=='\n')break;if(c!='\r')s.append((char)c);} return c==-1&&s.length()==0?null:s.toString(); }
    private static byte[] readFully(InputStream in,int n)throws IOException{byte[]b=new byte[n];int o=0,r;while(o<n&&(r=in.read(b,o,n-o))>0)o+=r;if(o<n)throw new EOFException();return b;}
    private static boolean isSafeRelativePath(String path) { return path != null && path.matches("[A-Za-z0-9._/-]+") && !path.startsWith("/") && !path.startsWith(".") && !path.contains("..") && !path.endsWith("/"); }
    private static File safeChild(File root, String path) throws IOException { File child = new File(root, path); if (!child.getCanonicalPath().startsWith(root.getCanonicalPath() + File.separator)) throw new IOException("clangd 路径无效"); return child; }
    private void destroyProcess() { if (process != null) { RuntimeCompat.terminate(process); process = null; input = null; output = null; } }
    public void close(){synchronized(lock){destroyProcess();} ioExecutor.shutdownNow();}
}
