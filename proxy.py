#!/usr/bin/env python3
"""Doge IDE - Local Proxy Server (Python)
Usage: python proxy.py
Then open http://localhost:8787 in browser
"""

import http.server
import json
import os
import sys
import urllib.parse
import urllib.request

PORT = 8787
API_URL = "https://uapis.cn/api/v1/execution/run"
DIR = os.path.dirname(os.path.abspath(__file__))


def pick_upstream(raw):
    """页面可通过 X-Doge-Upstream 指定 endpoint；只接受 http/https，异常时回落默认地址。"""
    if not raw:
        return API_URL
    value = raw.strip()
    if not value or len(value) > 2048:
        return API_URL
    parsed = urllib.parse.urlparse(value)
    if parsed.scheme in ("http", "https") and parsed.netloc:
        return value
    return API_URL

MIME = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css",
    ".js": "application/javascript",
    ".json": "application/json",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
}


def asset_path(raw_url):
    """Expose only the frontend entry and files contained in the web directory."""
    try:
        path = urllib.parse.unquote(urllib.parse.urlsplit(raw_url).path, errors="strict")
        if path in ("/", "/doge-ide.html"):
            return os.path.join(DIR, "doge-ide.html")
        if not path.startswith("/web/") or "\\" in path or "\0" in path or ".." in path.split("/"):
            return None
        web_root = os.path.realpath(os.path.join(DIR, "web"))
        candidate = os.path.realpath(os.path.join(DIR, path.lstrip("/")))
        if os.path.commonpath((web_root, candidate)) != web_root:
            return None
        return candidate
    except (ValueError, UnicodeError, OSError):
        return None


class ProxyHandler(http.server.BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.end_headers()

    def do_POST(self):
        if self.path == "/api/v1/execution/run":
            length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(length)
            try:
                upstream = pick_upstream(self.headers.get("X-Doge-Upstream"))
                headers = {"Content-Type": "application/json"}
                auth = self.headers.get("Authorization")
                if auth:
                    headers["Authorization"] = auth
                req = urllib.request.Request(
                    upstream,
                    data=body,
                    headers=headers,
                    method="POST",
                )
                with urllib.request.urlopen(req, timeout=35) as resp:
                    data = resp.read()
                    self.send_response(resp.status)
                    self.send_header("Access-Control-Allow-Origin", "*")
                    self.send_header("Content-Type", "application/json")
                    self.end_headers()
                    self.wfile.write(data)
            except Exception as e:
                self.send_response(502)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"error": "Proxy error", "message": str(e)}).encode())
        else:
            self.send_response(404)
            self.end_headers()

    def do_GET(self):
        file_path = asset_path(self.path)
        if not file_path or not os.path.isfile(file_path):
            self.send_response(404)
            self.end_headers()
            self.wfile.write(b"Not found")
            return
        ext = os.path.splitext(file_path)[1]
        mime = MIME.get(ext, "application/octet-stream")
        with open(file_path, "rb") as f:
            data = f.read()
        self.send_response(200)
        self.send_header("Content-Type", mime)
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, fmt, *args):
        pass  # Silence logs


if __name__ == "__main__":
    print(f"""
╔══════════════════════════════════════════╗
║          🐕 Doge IDE is running!         ║
╠══════════════════════════════════════════╣
║                                          ║
║  Open: http://localhost:{PORT}            ║
║                                          ║
║  Press Ctrl+C to stop                    ║
╚══════════════════════════════════════════╝
    """)
    server = http.server.HTTPServer(("127.0.0.1", PORT), ProxyHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
        sys.exit(0)
