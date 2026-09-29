// 批次 5 浏览器冒烟测试：headless Edge + CDP（Node 24 自带 WebSocket，无需依赖）
// 用法: node test/browser-smoke-b5.mjs
// 从仓库根目录起一个静态服务，加载 doge-ide.html，真实驱动浮层栈、键盘路由、设置、快捷键、关于、查找、项目搜索。
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const EDGE = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'].find(existsSync);
if (!EDGE) { console.log('跳过：未找到 Edge/Chrome'); process.exit(0); }
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.ttf': 'font/ttf' };
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
const browser = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', '--user-data-dir=' + profile, '--window-size=1557,973', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
const wsUrl = await new Promise((resolve, reject) => {
  let buf = '';
  const t = setTimeout(() => reject(new Error('浏览器启动超时')), 20000);
  browser.stderr.on('data', d => { buf += d; const m = buf.match(/DevTools listening on (ws:\/\/\S+)/); if (m) { clearTimeout(t); resolve(m[1]); } });
});
const ws = new WebSocket(wsUrl);
await new Promise(r => ws.addEventListener('open', r));
let seq = 0; const pending = new Map(); const errors = [];
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
  if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') errors.push('console.error: ' + msg.params.args.map(a => a.value ?? a.description).join(' '));
});
const send = (method, params = {}, sessionId) => new Promise(r => { const id = ++seq; pending.set(id, r); ws.send(JSON.stringify({ id, method, params, sessionId })); });
const { result: { targetId } } = await send('Target.createTarget', { url: 'about:blank' });
const { result: { sessionId } } = await send('Target.attachToTarget', { targetId, flatten: true });
const S = (m, p) => send(m, p, sessionId);
await S('Runtime.enable'); await S('Page.enable');
await S('Page.navigate', { url: `http://127.0.0.1:${port}/` });
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function ev(expr) {
  const r = await S('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
  return r.result.result.value;
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
let pass = 0, fail = 0; const fails = [];
const ok = (name, cond) => { if (cond) pass++; else { fail++; fails.push(name); } };
const eq = (name, got, want) => ok(name + ' (got ' + JSON.stringify(got) + ')', JSON.stringify(got) === JSON.stringify(want));

try {
  for (let i = 0; i < 50 && !(await ev('typeof editor !== "undefined" && !!editor').catch(() => false)); i++) await sleep(100);
  await sleep(400);
  // 首次进入无项目时会自动弹出“新建项目”：用 Esc 关掉，验证 Esc 关静态弹窗
  const createShown = await ev('document.getElementById("projectCreateModal").classList.contains("show")');
  if (createShown) {
    eq('startup: 新建项目弹窗入栈', await ev('overlayStack.length'), 1);
    await key('Escape');
    eq('startup: Esc 关闭新建项目', await ev('document.getElementById("projectCreateModal").classList.contains("show")'), false);
  }
  // 准备测试项目
  await ev(`(() => {
    project = { name: 'Smoke', language: 'c', files: [
      { path: 'main.c', code: '#include "util.h"\\nint main(void) {\\n  int added = add(1, 2);\\n  return added;\\n}\\n' },
      { path: 'src/util.c', code: 'int add(int a, int b) {\\n  return a + b;\\n}\\n' },
      { path: 'util.h', code: 'int add(int a, int b);\\n' } ] };
    resetEditorSession(true); currentFilePath = ''; switchProjectFile('main.c'); return true; })()`);
  eq('setup: 打开 main.c', await ev('currentFilePath'), 'main.c');
  eq('setup: 浮层栈为空', await ev('overlayStack.length'), 0);

  // ── 设置对话框 ──
  await ev('editor.focus()');
  await key(',', { ctrl: true });
  eq('settings: Ctrl+, 打开', await ev('document.getElementById("settingsModal").classList.contains("show")'), true);
  eq('settings: 初始焦点在主题下拉框', await ev('document.activeElement.id'), 'themeInput');
  eq('settings: 回填字号', await ev('document.getElementById("codeSizeInput").value !== ""'), true);
  eq('settings: 浮层打开时 Ctrl+Enter 不运行', await (async () => { await key('Enter', { ctrl: true }); return ev('isRunning'); })(), false);
  // Tab 循环：从最后一个可聚焦元素 Tab 回到第一个
  await ev('document.querySelector("#settingsModal .settings-save").focus()');
  await key('Tab');
  eq('settings: Tab 从最后循环到第一个', await ev('document.activeElement === focusableIn(document.getElementById("settingsModal"))[0]'), true);
  await key('Tab', { shift: true });
  eq('settings: Shift+Tab 从第一个循环到最后', await ev('document.activeElement.classList.contains("settings-save")'), true);
  // 焦点被程序移出时拉回
  await ev('editor.focus()'); await sleep(60);
  eq('settings: 焦点移到编辑器会被拉回对话框', await ev('document.getElementById("settingsModal").contains(document.activeElement)'), true);
  // 叠一层 dogeConfirm，Esc 逐层关闭
  await ev('dogeConfirm("测试", () => { window.__confirmed = true; })'); await sleep(60);
  eq('stack: 对话框上再叠确认框', await ev('overlayStack.length'), 2);
  eq('stack: 确认框默认聚焦取消', await ev('document.activeElement.textContent'), '取消');
  await key('Escape');
  eq('stack: 第一次 Esc 只关确认框', await ev('[overlayStack.length, document.getElementById("settingsModal").classList.contains("show")]'), [1, true]);
  eq('stack: 焦点回到设置对话框', await ev('document.getElementById("settingsModal").contains(document.activeElement)'), true);
  eq('stack: Esc 不触发确认回调', await ev('!!window.__confirmed'), false);
  // 保存：字号 + 关闭 Ctrl+I
  await ev('document.getElementById("codeSizeInput").value = "17"; document.getElementById("ctrlIStdinInput").checked = false; true');
  await ev('document.querySelector("#settingsModal .settings-save").click()'); await sleep(60);
  eq('settings: 保存后关闭并出栈', await ev('[document.getElementById("settingsModal").classList.contains("show"), overlayStack.length]'), [false, 0]);
  eq('settings: 字号生效', await ev('getComputedStyle(document.documentElement).getPropertyValue("--code-size").trim()'), '17px');
  eq('settings: 焦点回到编辑器', await ev('!!document.activeElement.closest(".CodeMirror")'), true);
  // Ctrl+I 已关闭：不切到 stdin
  await key('i', { ctrl: true });
  eq('keys: Ctrl+I 关闭后不切换 stdin', await ev('outputStream'), 'stdout');
  await ev('setSetting("ctrlIStdin", "1"); true');
  await key('i', { ctrl: true });
  eq('keys: Ctrl+I 打开后切换 stdin', await ev('outputStream'), 'stdin');
  await ev('editor.focus()');

  // ── 快捷键表 ──
  await ev('runCommand("help.shortcuts")'); await sleep(60);
  const sc = await ev('[...document.querySelectorAll("#shortcutList .shortcut-row")].map(r => r.textContent)');
  ok('shortcuts: 由 COMMANDS 生成(' + sc.length + ' 行)', sc.length >= 15);
  ok('shortcuts: 含项目搜索', sc.some(t => t.includes('在项目中搜索') && t.includes('Ctrl+Shift+F')));
  ok('shortcuts: 含查找替换', sc.some(t => t.includes('查找') && t.includes('Ctrl+F')) && sc.some(t => t.includes('替换') && t.includes('Ctrl+H')));
  ok('shortcuts: 调试关闭时不列 F5', !sc.some(t => t.includes('F5')));
  eq('shortcuts: 焦点在“知道了”', await ev('document.activeElement.textContent'), '知道了');
  await key('Escape');
  eq('shortcuts: Esc 关闭', await ev('document.getElementById("shortcutModal").classList.contains("show")'), false);

  // ── 关于 ──
  await ev('document.getElementById("statusVersion").click()'); await sleep(60);
  const about = await ev('document.querySelector(".about-dialog") && document.querySelector(".about-dialog").textContent');
  const appVersion = await ev('APP_VERSION');
  ok('about: 状态栏版本打开关于 (' + String(about).slice(0, 160) + ')', !!about && about.includes(appVersion) && about.includes('CodeMirror 5.65.18'));
  await key('Escape');
  eq('about: Esc 关闭', await ev('!!document.querySelector(".about-dialog")'), false);

  // ── 命令面板：Esc 只关面板 ──
  await ev('editor.focus()');
  await key('P', { ctrl: true, shift: true });
  eq('palette: Ctrl+Shift+P 打开', await ev('document.getElementById("layer").dataset.kind'), 'palette');
  await typeText('搜索');
  const items = await ev('[...document.querySelectorAll("#palList .pi")].map(x => x.textContent)');
  ok('palette: 能搜到“在项目中搜索”', items.some(t => t.includes('在项目中搜索')));
  await ev('isRunning = true; true');
  await key('Escape');
  eq('palette: Esc 关面板', await ev('layerOpen()'), false);
  await ev('isRunning = false; true');
  // 打开对话框会先关掉下拉
  await ev('document.querySelector(".menu-btn").click()'); await sleep(60);
  eq('menu: 下拉打开', await ev('document.getElementById("layer").dataset.kind'), 'menu');
  await ev('openSettings()'); await sleep(60);
  eq('menu: 打开对话框前先关下拉', await ev('[layerOpen(), overlayStack.length]'), [false, 1]);
  await key('Escape');

  // ── 键盘路由：编辑器内撤销不被抢、F2 ──
  await ev('editor.focus(); editor.setCursor(4, 0); true');
  await typeText('xyz');
  eq('undo: 输入生效', await ev('editor.getLine(4).startsWith("xyz")'), true);
  await key('z', { ctrl: true });
  eq('undo: Ctrl+Z 由编辑器撤销', await ev('editor.getLine(4).startsWith("xyz")'), false);
  await key('F2');
  eq('keys: 编辑器里 F2 打开重命名', await ev('document.querySelector(".modal-overlay[data-dynamic] h3") && document.querySelector(".modal-overlay[data-dynamic] h3").textContent'), '重命名文件');
  await key('F2');
  eq('keys: 输入框里 F2 不再叠一层', await ev('overlayStack.length'), 1);
  await key('Escape');
  // 编辑器 Esc：空闲无动作；运行中停止
  await ev('editor.focus(); window.__cancel = 0; window.__origCancel = cancelExecution; cancelExecution = () => { window.__cancel++; }; isRunning = true; true');
  await key('Escape');
  eq('esc: 编辑器里运行中 Esc 停止', await ev('window.__cancel'), 1);
  await ev('isRunning = false; true');
  await key('Escape');
  eq('esc: 空闲时 Esc 不停止', await ev('window.__cancel'), 1);

  // ── 编辑器查找 / 替换 ──
  await ev('editor.focus()');
  await key('f', { ctrl: true });
  const dlg = await ev('document.querySelector(".CodeMirror-dialog") && document.querySelector(".CodeMirror-dialog").textContent');
  ok('find: Ctrl+F 打开编辑器查找条(中文)', !!dlg && dlg.includes('查找'));
  await typeText('added');
  await key('Enter');
  eq('find: 选中第一个匹配', await ev('editor.getSelection()'), 'added');
  await key('Escape'); await sleep(60);
  eq('find: Esc 关闭查找条', await ev('!!document.querySelector(".CodeMirror-dialog")'), false);
  eq('find: 关闭查找条的 Esc 不停止运行', await ev('window.__cancel'), 1);
  await ev('runCommand("edit.replace")'); await sleep(60);
  ok('replace: 菜单命令打开替换条', (await ev('document.querySelector(".CodeMirror-dialog") && document.querySelector(".CodeMirror-dialog").textContent') || '').includes('替换'));
  await key('Escape'); await sleep(60);

  // ── 项目内搜索 ──
  await ev('editor.focus()');
  await key('F', { ctrl: true, shift: true }); await sleep(100);
  eq('search: Ctrl+Shift+F 切到搜索视图', await ev('[document.getElementById("explorer").dataset.view, document.getElementById("explorer").hidden]'), ['search', false]);
  eq('search: 焦点在搜索框', await ev('document.activeElement.id'), 'searchInput');
  eq('search: 活动栏高亮搜索', await ev('document.querySelector(".rail-btn[data-rail=search]").classList.contains("active") && !document.querySelector(".rail-btn[data-rail=explorer]").classList.contains("active")'), true);
  eq('search: 文件树隐藏', await ev('getComputedStyle(document.getElementById("projectList")).display'), 'none');
  await ev('document.getElementById("searchInput").value = ""; true');
  await typeText('add');
  await key('Enter');
  const sum = await ev('document.getElementById("searchSummary").textContent');
  // main.c: added / add( / added = 3；src/util.c: add( = 1；util.h: add( = 1
  ok('search: 汇总 (' + sum + ')', /^5 个结果，分布在 3 个文件中/.test(sum));
  eq('search: 结果按文件分组', await ev('[...document.querySelectorAll(".sr-file .fname")].map(x => x.textContent)'), ['main.c', 'util.c', 'util.h']);
  await key('F2');
  eq('search: 搜索框里 F2 不重命名', await ev('overlayStack.length'), 0);
  await key('f', { ctrl: true });
  eq('search: 搜索框里 Ctrl+F 不开编辑器查找', await ev('!!document.querySelector(".CodeMirror-dialog")'), false);
  await ev('document.querySelector(".sr-hit[data-path=\\"src/util.c\\"]").click()'); await sleep(100);
  eq('search: 点击结果打开文件并选中', await ev('[currentFilePath, editor.getCursor("from").line + 1, editor.getSelection()]'), ['src/util.c', 1, 'add']);
  // 全字 + 区分大小写
  await ev('document.querySelector(".search-opt[data-opt=wholeWord]").click(); true'); await sleep(60);
  ok('search: 全字匹配排除 added', /^3 个结果，分布在 3 个文件中/.test(await ev('document.getElementById("searchSummary").textContent')));
  await ev('document.querySelector(".search-opt[data-opt=wholeWord]").click(); document.querySelector(".search-opt[data-opt=regex]").click(); document.getElementById("searchInput").value = "("; runProjectSearch(); true');
  ok('search: 无效正则提示', /正则表达式无效/.test(await ev('document.getElementById("searchSummary").textContent')));
  await ev('document.querySelector(".search-opt[data-opt=regex]").click(); document.getElementById("searchInput").value = "return"; runProjectSearch(); true');
  // 编辑后结果自动刷新
  await ev('editor.focus(); editor.replaceRange("  return 0;\\n", {line: 2, ch: 0}); true'); await sleep(700);
  ok('search: 编辑后自动刷新 (' + await ev('document.getElementById("searchSummary").textContent') + ')', /^3 个结果/.test(await ev('document.getElementById("searchSummary").textContent')));
  // 活动栏：再点搜索收起；点文件切回
  await ev('document.querySelector(".rail-btn[data-rail=search]").click()');
  eq('rail: 再点搜索收起侧栏', await ev('document.getElementById("explorer").hidden'), true);
  await ev('document.querySelector(".rail-btn[data-rail=explorer]").click()');
  eq('rail: 点文件打开文件视图', await ev('[document.getElementById("explorer").hidden, document.getElementById("explorer").dataset.view]'), [false, 'files']);
  eq('rail: 文件树可见', await ev('getComputedStyle(document.getElementById("projectList")).display !== "none"'), true);
  await key('b', { ctrl: true });
  eq('keys: Ctrl+B 收起', await ev('document.getElementById("explorer").hidden'), true);
  await key('b', { ctrl: true });
  eq('keys: Ctrl+B 打开', await ev('document.getElementById("explorer").hidden'), false);

  // ── 导入进度遮罩 ──
  await ev('window.toolchainProgress(10, "解压中"); true');
  await key('Escape');
  eq('import: 进行中 Esc 不关遮罩', await ev('document.getElementById("importProgress").classList.contains("show")'), true);
  await ev('document.getElementById("importProgressStall").hidden = false; true');
  await key('Escape');
  eq('import: 停滞时 Esc 等同后台继续', await ev('document.getElementById("importProgress").classList.contains("show")'), false);
  await ev('cancelExecution = window.__origCancel; true');
  // 布局：对话框不超出视口
  await ev('openSettings()'); await sleep(80);
  const box = await ev('(() => { const r = document.getElementById("settingsPanel").getBoundingClientRect(); return [r.top >= 0, r.bottom <= innerHeight, r.left >= 0, r.right <= innerWidth]; })()');
  eq('layout: 设置对话框在视口内', box, [true, true, true, true]);
  await key('Escape');
} catch (e) {
  fail++; fails.push('脚本异常: ' + e.message);
}
ok('无 JS 异常' + (errors.length ? '：' + errors.join(' | ') : ''), errors.length === 0);
console.log('\n批次5 浏览器冒烟: ' + pass + ' 通过, ' + fail + ' 失败');
fails.forEach(f => console.log('  ✗ ' + f));
try { ws.close(); } catch (e) {}
browser.kill();
server.close();
await sleep(300);
try { rmSync(profile, { recursive: true, force: true }); } catch (e) {}
process.exit(fail ? 1 : 0);
