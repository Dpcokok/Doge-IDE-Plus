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

    JSONObject request(JSONObject body, String method) throws Exception {
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
            return response == null ? new JSONObject() : response.optJSONObject("result") == null ? new JSONObject() : response.optJSONObject("result");
        }
    }

    private void ensureStarted(File root) throws Exception {
        if (process != null && process.isAlive()) return;
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
        if (files != null) for (int i=0;i<files.length();i++) { JSONObject f=files.optJSONObject(i); if(f==null)continue; String p=f.optString("path","").replace('\\','/'); if(!isSafeRelativePath(p))continue; File target=safeChild(root,p); if(target.getParentFile()!=null && !target.getParentFile().isDirectory() && !target.getParentFile().mkdirs()) throw new IOException("无法创建 clangd 文件目录"); java.nio.file.Files.write(target.toPath(),f.optString("code","").getBytes(StandardCharsets.UTF_8)); }
        JSONArray commands = new JSONArray();
        if (files != null) for (int i=0;i<files.length();i++) { JSONObject f=files.optJSONObject(i); if(f==null)continue; String p=f.optString("path",""); String lower=p.toLowerCase(); if(!(lower.endsWith(".c")||lower.endsWith(".cc")||lower.endsWith(".cpp")||lower.endsWith(".cxx")))continue; File source=new File(root,p); String compiler=lower.endsWith(".c")?"clang":"clang++"; commands.put(new JSONObject().put("directory",root.getAbsolutePath()).put("file",source.getAbsolutePath()).put("arguments",new JSONArray().put(new File(toolchain,"bin/"+compiler).getAbsolutePath()).put("--target=wasm32-wasip1").put("--sysroot="+new File(toolchain,"wasi-sysroot").getAbsolutePath()).put("-std="+(lower.endsWith(".c")?"c17":"c++20")).put("-fsyntax-only").put(source.getAbsolutePath()))); }
        java.nio.file.Files.write(new File(root, "compile_commands.json").toPath(), commands.toString(2).getBytes(StandardCharsets.UTF_8));
        return root;
    }
    private static String read(File f) throws IOException { return new String(java.nio.file.Files.readAllBytes(f.toPath()), StandardCharsets.UTF_8); }
    private static String readLine(InputStream in) throws IOException { StringBuilder s=new StringBuilder(); int c; while((c=in.read())!=-1){if(c=='\n')break;if(c!='\r')s.append((char)c);} return c==-1&&s.length()==0?null:s.toString(); }
    private static byte[] readFully(InputStream in,int n)throws IOException{byte[]b=new byte[n];int o=0,r;while(o<n&&(r=in.read(b,o,n-o))>0)o+=r;if(o<n)throw new EOFException();return b;}
    private static boolean isSafeRelativePath(String path) { return path != null && path.matches("[A-Za-z0-9._/-]+") && !path.startsWith("/") && !path.startsWith(".") && !path.contains("..") && !path.endsWith("/"); }
    private static File safeChild(File root, String path) throws IOException { File child = new File(root, path); if (!child.getCanonicalPath().startsWith(root.getCanonicalPath() + File.separator)) throw new IOException("clangd 路径无效"); return child; }
    private void destroyProcess() { if (process != null) { process.destroyForcibly(); process = null; input = null; output = null; } }
    public void close(){synchronized(lock){destroyProcess();} ioExecutor.shutdownNow();}
}
