// 浏览器测试公共部分：静态服务 + headless Edge/Chrome + CDP（Node 24 自带 WebSocket，无需依赖）
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';

export const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const sleep = ms => new Promise(r => setTimeout(r, ms));
export function findBrowser() {
  return ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'].find(existsSync);
}
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.ttf': 'font/ttf' };

// 启动浏览器并打开页面；返回 { ev, key, typeText, send, errors, close, setViewport, reload }
export async function launch({ width = 1557, height = 973, touch = false } = {}) {
  const exe = findBrowser();
  if (!exe) return null;
  const server = createServer((req, res) => {
    const url = decodeURIComponent(req.url.split('?')[0]);
    const file = url === '/' ? join(root, 'doge-ide.html') : join(root, url);
    if (!file.startsWith(root) || !existsSync(file)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(readFileSync(file));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const profile = mkdtempSync(join(tmpdir(), 'doge-smoke-'));
  const browser = spawn(exe, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', '--user-data-dir=' + profile, '--window-size=' + width + ',' + height, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const wsUrl = await new Promise((resolve, reject) => {
    let buf = '';
    const t = setTimeout(() => reject(new Error('浏览器启动超时')), 20000);
    browser.stderr.on('data', d => { buf += d; const m = buf.match(/DevTools listening on (ws:\/\/\S+)/); if (m) { clearTimeout(t); resolve(m[1]); } });
  });
  const ws = new WebSocket(wsUrl);
  await new Promise(r => ws.addEventListener('open', r));
  let seq = 0; const pending = new Map(); const errors = [];
  ws.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') errors.push('console.error: ' + msg.params.args.map(a => a.value ?? a.description).join(' '));
  });
  const send = (method, params = {}, sessionId) => new Promise(r => { const id = ++seq; pending.set(id, r); ws.send(JSON.stringify({ id, method, params, sessionId })); });
  const { result: { targetId } } = await send('Target.createTarget', { url: 'about:blank' });
  const { result: { sessionId } } = await send('Target.attachToTarget', { targetId, flatten: true });
  const S = (m, p) => send(m, p, sessionId);
  await S('Runtime.enable'); await S('Page.enable');
  async function setViewport(w, h, isTouch = touch) {
    await S('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
    await S('Emulation.setTouchEmulationEnabled', { enabled: isTouch, maxTouchPoints: isTouch ? 5 : 1 });
    // pointer:coarse 由触控模拟决定；显式覆盖媒体特性，保证 @media (pointer:coarse) 生效
    await S('Emulation.setEmulatedMedia', { features: [{ name: 'pointer', value: isTouch ? 'coarse' : 'fine' }, { name: 'any-pointer', value: isTouch ? 'coarse' : 'fine' }, { name: 'hover', value: isTouch ? 'none' : 'hover' }] });
    await sleep(80);
  }
  async function ev(expr) {
    const r = await S('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
    return r.result.result.value;
  }
  async function reload(clearStorage = false) {
    if (clearStorage) await ev('localStorage.clear(); true').catch(() => {});
    await S('Page.navigate', { url: `http://127.0.0.1:${port}/` });
    for (let i = 0; i < 60 && !(await ev('typeof editor !== "undefined" && !!editor && document.readyState === "complete"').catch(() => false)); i++) await sleep(100);
    await sleep(400);
  }
  async function key(k, mods = {}) {
    const modifiers = (mods.alt ? 1 : 0) | (mods.ctrl ? 2 : 0) | (mods.meta ? 4 : 0) | (mods.shift ? 8 : 0);
    const named = { Escape: [27, 'Escape'], Enter: [13, 'Enter'], Tab: [9, 'Tab'], F2: [113, 'F2'], ' ': [32, 'Space'] };
    const [code, codeName] = named[k] || [k.toUpperCase().charCodeAt(0), 'Key' + k.toUpperCase()];
    const base = { modifiers, key: k, code: codeName, windowsVirtualKeyCode: code };
    await S('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
    if (k.length === 1 && !mods.ctrl && !mods.alt && !mods.meta) await S('Input.dispatchKeyEvent', { type: 'char', ...base, text: k });
    await S('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
    await sleep(60);
  }
  async function typeText(t) { await S('Input.insertText', { text: t }); await sleep(60); }
  // 真实触控点击（CDP 触摸事件，会触发 pointer / click）
  async function tap(x, y) {
    await S('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    await S('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(120);
  }
  async function close() {
    try { ws.close(); } catch (e) {}
    browser.kill();
    server.close();
    await sleep(300);
    try { rmSync(profile, { recursive: true, force: true }); } catch (e) {}
  }
  await setViewport(width, height, touch);
  await reload();
  return { ev, key, typeText, tap, send: S, errors, close, setViewport, reload };
}

// 简单断言收集
export function checker() {
  let pass = 0, fail = 0; const fails = [];
  const ok = (name, cond) => { if (cond) pass++; else { fail++; fails.push(name); } };
  const eq = (name, got, want) => ok(name + ' (got ' + JSON.stringify(got) + ')', JSON.stringify(got) === JSON.stringify(want));
  const report = (title) => {
    console.log('\n' + title + ': ' + pass + ' 通过, ' + fail + ' 失败');
    fails.forEach(f => console.log('  ✗ ' + f));
    return fail;
  };
  return { ok, eq, report, get fail() { return fail; } };
}
