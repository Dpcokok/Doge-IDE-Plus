package com.doge.ide;

import android.content.Context;
import android.content.res.AssetManager;
import android.util.Log;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.Closeable;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.atomic.AtomicInteger;
import org.json.JSONObject;

/**
 * 进程内迷你 HTTP 服务，等价于桌面版 main.go 的角色：
 * <ul>
 *   <li>把 APK assets 里的 web 应用喂给 WebView —— 同源，因此没有 CORS、localStorage 也稳定；</li>
 *   <li>为本地执行器保留 POST /api/v1/execution/run 接口。</li>
 * </ul>
 * 只监听 127.0.0.1，不对外暴露。
 */
final class LocalServer implements Closeable {

    private static final String TAG = "DogeIDE";
    private static final String API_PATH = "/api/v1/execution/run";
    private static final String CANCEL_PATH = "/api/v1/execution/cancel";
    private static final String TASKS_PATH = "/api/v1/tasks";
    private static final int PREFERRED_PORT = 8787;
    private static final int MAX_BODY = 10 << 20;
    private static final int SOCKET_TIMEOUT_MS = 15000;
    private static final int WORKERS = 8;

    private final AssetManager assets;
    private final LocalCompiler compiler;
    private final TaskRegistry taskRegistry;
    private final ClangdService clangd;
    private ServerSocket serverSocket;
    private ExecutorService workers;
    private volatile boolean running;
    private int port;

    LocalServer(Context context) {
        this.assets = context.getApplicationContext().getAssets();
        this.compiler = new LocalCompiler(context);
        this.taskRegistry = new TaskRegistry(compiler);
        this.clangd = new ClangdService(context);
    }

    /** 启动服务，返回页面基地址（如 http://127.0.0.1:8787）。 */
    synchronized String start() throws IOException {
        if (running) {
            return baseUrl();
        }
        try {
            serverSocket = new ServerSocket(PREFERRED_PORT, 16, InetAddress.getByName("127.0.0.1"));
        } catch (IOException busy) {
            Log.w(TAG, "port " + PREFERRED_PORT + " is busy, falling back to an ephemeral port");
            serverSocket = new ServerSocket(0, 16, InetAddress.getByName("127.0.0.1"));
        }
        port = serverSocket.getLocalPort();
        workers = Executors.newFixedThreadPool(WORKERS, new ThreadFactory() {
            private final AtomicInteger seq = new AtomicInteger();

            @Override
            public Thread newThread(Runnable r) {
                Thread t = new Thread(r, "doge-http-" + seq.incrementAndGet());
                t.setDaemon(true);
                return t;
            }
        });
        running = true;
        Thread accept = new Thread(this::acceptLoop, "doge-http-accept");
        accept.setDaemon(true);
        accept.start();
        Log.i(TAG, "local server on " + baseUrl());
        return baseUrl();
    }

    String baseUrl() {
        return "http://127.0.0.1:" + port;
    }

    @Override
    public synchronized void close() {
        running = false;
        taskRegistry.close();
        clangd.close();
        if (serverSocket != null) {
            try {
                serverSocket.close();
            } catch (IOException ignored) {
                // 关闭失败无所谓：accept 循环已经退出
            }
            serverSocket = null;
        }
        if (workers != null) {
            workers.shutdownNow();
            workers = null;
        }
    }

    private void acceptLoop() {
        while (running) {
            Socket socket;
            try {
                socket = serverSocket.accept();
            } catch (IOException e) {
                if (running) {
                    Log.w(TAG, "accept failed", e);
                }
                return;
            }
            try {
                workers.execute(new Connection(socket));
            } catch (RuntimeException rejected) {
                closeQuietly(socket);
            }
        }
    }

    private final class Connection implements Runnable {
        private final Socket socket;

        Connection(Socket socket) {
            this.socket = socket;
        }

        @Override
        public void run() {
            try (Socket s = socket) {
                s.setSoTimeout(SOCKET_TIMEOUT_MS);
                s.setTcpNoDelay(true);
                InputStream in = new BufferedInputStream(s.getInputStream(), 16384);
                OutputStream out = new BufferedOutputStream(s.getOutputStream(), 16384);
                // HTTP/1.1 keep-alive：WebView 会复用连接，避免每个资源都重新握手
                while (running && !s.isClosed()) {
                    Request request = readRequest(in);
                    if (request == null) {
                        return;
                    }
                    boolean keepAlive = respond(out, request);
                    out.flush();
                    if (!keepAlive) {
                        return;
                    }
                }
            } catch (SocketTimeoutException idle) {
                // keep-alive 连接空闲超时，正常收工
            } catch (IOException closed) {
                // 客户端断开是常态（切后台、关页面）
            } catch (Exception e) {
                Log.w(TAG, "connection failed", e);
            }
        }
    }

    // ---------------------------------------------------------------- 请求解析

    private static final class Request {
        String method = "GET";
        String path = "/";
        boolean keepAlive = true;
        boolean chunked;
        byte[] body;
    }

    private Request readRequest(InputStream in) throws IOException {
        String line = readLine(in);
        if (line == null || line.isEmpty()) {
            return null;
        }
        String[] parts = line.split(" ");
        if (parts.length < 2) {
            return null;
        }
        Request req = new Request();
        req.method = parts[0].toUpperCase(Locale.US);
        String version = parts.length > 2 ? parts[2] : "HTTP/1.0";
        req.keepAlive = !"HTTP/1.0".equalsIgnoreCase(version);
        req.path = normalizePath(parts[1]);

        int contentLength = -1;
        String header;
        while ((header = readLine(in)) != null && !header.isEmpty()) {
            int colon = header.indexOf(':');
            if (colon <= 0) {
                continue;
            }
            String key = header.substring(0, colon).trim().toLowerCase(Locale.US);
            String value = header.substring(colon + 1).trim();
            if (key.equals("content-length")) {
                try {
                    long len = Long.parseLong(value);
                    if (len > MAX_BODY) {
                        throw new IOException("request body too large");
                    }
                    contentLength = (int) len;
                } catch (NumberFormatException ignored) {
                    // 交给下一层按空 body 处理
                }
            } else if (key.equals("transfer-encoding")) {
                req.chunked = value.toLowerCase(Locale.US).contains("chunked");
            } else if (key.equals("connection")) {
                String v = value.toLowerCase(Locale.US);
                if (v.contains("close")) {
                    req.keepAlive = false;
                } else if (v.contains("keep-alive")) {
                    req.keepAlive = true;
                }
            }
        }
        // body 必须等请求头的空行之后再读：否则空行会被当成 body 的开头，
        // 剩下的 body 字节又被当成下一个请求头，连接就此卡死。
        if (req.chunked) {
            req.body = readChunked(in);
        } else if (contentLength > 0) {
            req.body = readFully(in, contentLength);
        }
        return req;
    }

    private static String readLine(InputStream in) throws IOException {
        ByteArrayOutputStream buffer = new ByteArrayOutputStream(128);
        int c;
        while ((c = in.read()) != -1) {
            if (c == '\n') {
                break;
            }
            if (c != '\r') {
                buffer.write(c);
            }
            if (buffer.size() > 8192) {
                throw new IOException("header line too long");
            }
        }
        if (c == -1 && buffer.size() == 0) {
            return null;
        }
        return new String(buffer.toByteArray(), StandardCharsets.ISO_8859_1);
    }

    private static byte[] readFully(InputStream in, int length) throws IOException {
        byte[] data = new byte[length];
        int read = 0;
        while (read < length) {
            int n = in.read(data, read, length - read);
            if (n < 0) {
                throw new IOException("unexpected end of body");
            }
            read += n;
        }
        return data;
    }

    private static byte[] readChunked(InputStream in) throws IOException {
        ByteArrayOutputStream body = new ByteArrayOutputStream();
        while (true) {
            String sizeLine = readLine(in);
            if (sizeLine == null) {
                throw new IOException("truncated chunked body");
            }
            int semi = sizeLine.indexOf(';');
            if (semi >= 0) {
                sizeLine = sizeLine.substring(0, semi);
            }
            int size;
            try {
                size = Integer.parseInt(sizeLine.trim(), 16);
            } catch (NumberFormatException e) {
                throw new IOException("bad chunk size");
            }
            if (size == 0) {
                readLine(in); // 结尾 CRLF
                return body.toByteArray();
            }
            if (body.size() + size > MAX_BODY) {
                throw new IOException("request body too large");
            }
            body.write(readFully(in, size));
            readLine(in); // 每个 chunk 后的 CRLF
        }
    }

    /** 去掉 query/fragment，百分号解码，并挡住路径穿越。 */
    private static String normalizePath(String raw) {
        String path = raw;
        int cut = path.length();
        for (int i = 0; i < path.length(); i++) {
            char ch = path.charAt(i);
            if (ch == '?' || ch == '#') {
                cut = i;
                break;
            }
        }
        path = path.substring(0, cut);
        if (!path.startsWith("/")) {
            path = "/" + path;
        }
        try {
            // URLDecoder 会把 '+' 当空格，先转义回去（资源名里不含 '+'，仅为稳妥）
            path = URLDecoder.decode(path.replace("+", "%2B"), "UTF-8");
        } catch (IOException ignored) {
            return "/";
        } catch (IllegalArgumentException ignored) {
            return "/";
        }
        if (path.contains("..") || path.contains("//")) {
            return "/";
        }
        return path;
    }

    // ---------------------------------------------------------------- 路由

    private boolean respond(OutputStream out, Request req) throws IOException {
        if (req.path.startsWith("/api/v1/intel/")) {
            if (!"POST".equals(req.method)) return sendBytes(out, req, 405, "text/plain", "method not allowed".getBytes(StandardCharsets.UTF_8));
            try { JSONObject body = new JSONObject(new String(req.body == null ? new byte[0] : req.body, StandardCharsets.UTF_8)); String method = req.path.endsWith("/completion") ? "textDocument/completion" : req.path.endsWith("/definition") ? "textDocument/definition" : req.path.endsWith("/diagnostics") ? "textDocument/diagnostic" : "textDocument/documentSymbol"; JSONObject result = clangd.request(body, method); return sendBytes(out, req, 200, "application/json; charset=utf-8", result.toString().getBytes(StandardCharsets.UTF_8)); }
            catch (Exception e) { return sendBytes(out, req, 503, "application/json; charset=utf-8", ("{\"error\":" + JSONObject.quote(e.getMessage()) + "}").getBytes(StandardCharsets.UTF_8)); }
        }
        if (TASKS_PATH.equals(req.path)) {
            if ("POST".equals(req.method)) {
                try {
                    String id = taskRegistry.submit(new String(req.body == null ? new byte[0] : req.body, StandardCharsets.UTF_8));
                    return sendBytes(out, req, 202, "application/json; charset=utf-8", ("{\"task_id\":\"" + id + "\",\"status\":\"queued\"}").getBytes(StandardCharsets.UTF_8));
                } catch (IllegalStateException full) { return sendBytes(out, req, 429, "application/json; charset=utf-8", ("{\"status\":\"error\",\"message\":" + JSONObject.quote(full.getMessage()) + "}").getBytes(StandardCharsets.UTF_8)); }
                catch (Exception bad) { return sendBytes(out, req, 400, "application/json; charset=utf-8", ("{\"status\":\"error\",\"message\":" + JSONObject.quote(bad.toString()) + "}").getBytes(StandardCharsets.UTF_8)); }
            }
            if ("GET".equals(req.method)) {
                try { return sendBytes(out, req, 200, "application/json; charset=utf-8", taskRegistry.list().toString().getBytes(StandardCharsets.UTF_8)); }
                catch (Exception e) { return sendBytes(out, req, 500, "text/plain", e.toString().getBytes(StandardCharsets.UTF_8)); }
            }
        }
        if (req.path.startsWith(TASKS_PATH + "/")) {
            String rest = req.path.substring((TASKS_PATH + "/").length());
            if (rest.endsWith("/cancel") && "POST".equals(req.method)) {
                String id = rest.substring(0, rest.length() - 7); boolean ok = taskRegistry.cancel(id);
                return sendBytes(out, req, ok ? 200 : 404, "application/json; charset=utf-8", ("{\"task_id\":\"" + id + "\",\"status\":\"" + (ok ? "canceled" : "not_found") + "\"}").getBytes(StandardCharsets.UTF_8));
            }
            if ("GET".equals(req.method)) {
                try { JSONObject task = taskRegistry.get(rest); if (task == null) return sendBytes(out, req, 404, "text/plain", "not found".getBytes(StandardCharsets.UTF_8)); return sendBytes(out, req, 200, "application/json; charset=utf-8", task.toString().getBytes(StandardCharsets.UTF_8)); }
                catch (Exception e) { return sendBytes(out, req, 500, "text/plain", e.toString().getBytes(StandardCharsets.UTF_8)); }
            }
        }
        if (CANCEL_PATH.equals(req.path)) {
            if (!"POST".equals(req.method)) {
                return sendBytes(out, req, 405, "text/plain; charset=utf-8", "method not allowed".getBytes(StandardCharsets.UTF_8));
            }
            LocalCompiler.cancelActive();
            return sendBytes(out, req, 200, "application/json; charset=utf-8", "{\"status\":\"canceled\"}".getBytes(StandardCharsets.UTF_8));
        }
        if (API_PATH.equals(req.path)) {
            if (!"POST".equals(req.method)) {
                return sendBytes(out, req, 405, "text/plain; charset=utf-8",
                        "method not allowed".getBytes(StandardCharsets.UTF_8));
            }
            String request = new String(req.body == null ? new byte[0] : req.body, StandardCharsets.UTF_8);
            String response = compiler.execute(request);
            int status = response.contains("\"status\":\"runtime_not_ready\"") ? 503 : 200;
            return sendBytes(out, req, status, "application/json; charset=utf-8", response.getBytes(StandardCharsets.UTF_8));
        }
        if (!"GET".equals(req.method) && !"HEAD".equals(req.method)) {
            return sendBytes(out, req, 405, "text/plain; charset=utf-8",
                    "method not allowed".getBytes(StandardCharsets.UTF_8));
        }
        return sendAsset(out, req);
    }

    private boolean sendAsset(OutputStream out, Request req) throws IOException {
        String name = assetName(req.path);
        if (name == null) {
            return sendBytes(out, req, 404, "text/plain; charset=utf-8",
                    "not found".getBytes(StandardCharsets.UTF_8));
        }
        byte[] data;
        try (InputStream in = assets.open(name)) {
            data = readAll(in);
        } catch (IOException missing) {
            return sendBytes(out, req, 404, "text/plain; charset=utf-8",
                    "not found".getBytes(StandardCharsets.UTF_8));
        }
        writeHead(out, req, 200, mimeOf(name), data.length, "public, max-age=86400");
        if (!"HEAD".equals(req.method)) {
            out.write(data);
        }
        return req.keepAlive;
    }

    /** 页面 / → index.html；/web/... → assets 里的同名文件。 */
    private static String assetName(String path) {
        if (path.equals("/") || path.equals("/index.html") || path.equals("/doge-ide.html")) {
            return "index.html";
        }
        String name = path.substring(1);
        if (name.isEmpty() || name.endsWith("/") || name.contains("..")) {
            return null;
        }
        return name;
    }

    // ---------------------------------------------------------------- 响应

    private boolean sendBytes(OutputStream out, Request req, int status, String contentType, byte[] body)
            throws IOException {
        writeHead(out, req, status, contentType, body.length, "no-store");
        if (!"HEAD".equals(req.method)) {
            out.write(body);
        }
        return req.keepAlive;
    }

    private void writeHead(OutputStream out, Request req, int status, String contentType, int length,
                           String cacheControl) throws IOException {
        StringBuilder head = new StringBuilder(160);
        head.append("HTTP/1.1 ").append(status).append(' ').append(reason(status)).append("\r\n");
        head.append("Content-Type: ").append(contentType).append("\r\n");
        head.append("Content-Length: ").append(length).append("\r\n");
        head.append("Cache-Control: ").append(cacheControl).append("\r\n");
        head.append("Connection: ").append(req.keepAlive ? "keep-alive" : "close").append("\r\n");
        head.append("\r\n");
        out.write(head.toString().getBytes(StandardCharsets.ISO_8859_1));
    }

    private static String reason(int status) {
        switch (status) {
            case 200:
                return "OK";
            case 400:
                return "Bad Request";
            case 401:
                return "Unauthorized";
            case 403:
                return "Forbidden";
            case 404:
                return "Not Found";
            case 405:
                return "Method Not Allowed";
            case 429:
                return "Too Many Requests";
            case 500:
                return "Internal Server Error";
            case 502:
                return "Bad Gateway";
            case 503:
                return "Service Unavailable";
            default:
                return status >= 200 && status < 300 ? "OK" : "Unknown";
        }
    }

    private static String mimeOf(String name) {
        if (name.endsWith(".html") || name.endsWith(".htm")) {
            return "text/html; charset=utf-8";
        }
        if (name.endsWith(".js") || name.endsWith(".mjs")) {
            return "text/javascript; charset=utf-8";
        }
        if (name.endsWith(".css")) {
            return "text/css; charset=utf-8";
        }
        if (name.endsWith(".json")) {
            return "application/json; charset=utf-8";
        }
        if (name.endsWith(".svg")) {
            return "image/svg+xml";
        }
        if (name.endsWith(".png")) {
            return "image/png";
        }
        if (name.endsWith(".jpg") || name.endsWith(".jpeg")) {
            return "image/jpeg";
        }
        if (name.endsWith(".ico")) {
            return "image/x-icon";
        }
        if (name.endsWith(".woff2")) {
            return "font/woff2";
        }
        if (name.endsWith(".woff")) {
            return "font/woff";
        }
        if (name.endsWith(".ttf")) {
            return "font/ttf";
        }
        if (name.endsWith(".map")) {
            return "application/json; charset=utf-8";
        }
        return "application/octet-stream";
    }

    private static String jsonString(String value) {
        StringBuilder sb = new StringBuilder(value.length() + 8);
        sb.append('"');
        for (int i = 0; i < value.length(); i++) {
            char ch = value.charAt(i);
            switch (ch) {
                case '"':
                    sb.append("\\\"");
                    break;
                case '\\':
                    sb.append("\\\\");
                    break;
                case '\n':
                    sb.append("\\n");
                    break;
                case '\r':
                    sb.append("\\r");
                    break;
                case '\t':
                    sb.append("\\t");
                    break;
                default:
                    if (ch < 0x20) {
                        sb.append(String.format(Locale.US, "\\u%04x", (int) ch));
                    } else {
                        sb.append(ch);
                    }
            }
        }
        return sb.append('"').toString();
    }

    private static byte[] readAll(InputStream in) throws IOException {
        try (InputStream stream = in) {
            ByteArrayOutputStream out = new ByteArrayOutputStream(8192);
            byte[] buffer = new byte[8192];
            int n;
            while ((n = stream.read(buffer)) > 0) {
                out.write(buffer, 0, n);
            }
            return out.toByteArray();
        }
    }

    private static void closeQuietly(Socket socket) {
        try {
            socket.close();
        } catch (IOException ignored) {
            // 无需处理
        }
    }
}
