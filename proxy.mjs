// Doge IDE - Local Proxy Server (Node.js)
// Usage: node proxy.mjs
// Then open http://localhost:8787 in browser

import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PORT = 8787;
const API_URL = 'https://uapis.cn/api/v1/execution/run';

// 页面可通过 X-Doge-Upstream 指定 endpoint；只接受 http/https，异常时回落默认地址。
function pickUpstream(raw) {
  if (typeof raw !== 'string') return API_URL;
  const value = raw.trim();
  if (!value || value.length > 2048) return API_URL;
  try {
    const url = new URL(value);
    if ((url.protocol === 'http:' || url.protocol === 'https:') && url.hostname) return value;
  } catch {
    // 非法 URL，走默认地址
  }
  return API_URL;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const server = createServer(async (req, res) => {
  // CORS headers for local dev
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Proxy API requests
  if (req.method === 'POST' && req.url === '/api/v1/execution/run') {
    let body = '';
    for await (const chunk of req) body += chunk;

    try {
      const headers = { 'Content-Type': 'application/json' };
      const auth = req.headers['authorization'];
      if (auth) headers['Authorization'] = auth;

      const upstream = pickUpstream(req.headers['x-doge-upstream']);
      const proxyReq = await fetch(upstream, {
        method: 'POST',
        headers,
        body,
      });
      const data = await proxyReq.text();
      res.writeHead(proxyReq.status, { 'Content-Type': 'application/json' });
      res.end(data);
    } catch (err) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Proxy error', message: err.message }));
    }
    return;
  }

  // Serve static files
  let filePath = join(__dirname, req.url === '/' ? 'doge-ide.html' : req.url);
  if (!existsSync(filePath)) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }
  const ext = extname(filePath);
  const mime = MIME[ext] || 'application/octet-stream';
  const content = readFileSync(filePath);
  res.writeHead(200, { 'Content-Type': mime });
  res.end(content);
});

server.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════╗
║          🐕 Doge IDE is running!         ║
╠══════════════════════════════════════════╣
║                                          ║
║  Open: http://localhost:${PORT}            ║
║                                          ║
║  Press Ctrl+C to stop                    ║
╚══════════════════════════════════════════╝
  `);
});
