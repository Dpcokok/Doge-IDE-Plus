// 批次 6 浏览器冒烟：响应式布局 / 触控尺寸 / 窄屏覆盖层 / 软键盘 / 默认主题
// 用法: node test/browser-smoke-b6.mjs   （找不到 Edge/Chrome 时跳过）
import { launch, checker, sleep } from './browser-lib.mjs';

const b = await launch({ width: 1557, height: 973, touch: true });
if (!b) { console.log('跳过：未找到 Edge/Chrome'); process.exit(0); }
const { ok, eq, report } = checker();
const { ev, key, tap } = b;

// 关键区域几何
const GEOM = `(() => {
  const r = s => { const e = document.querySelector(s); if (!e || !e.getClientRects().length) return null; const b = e.getBoundingClientRect(); return { l: Math.round(b.left), t: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height), r: Math.round(b.right), b: Math.round(b.bottom) }; };
  return { vw: innerWidth, vh: innerHeight, scrollW: document.documentElement.scrollWidth, scrollH: document.documentElement.scrollHeight,
    menubar: r('#menubar'), editorCol: r('.editor-col'), panel: r('#outputPanel'), statusbar: r('#statusbar'), explorer: r('#explorer'),
    runBtn: r('#runBtn'), rail: r('#rail'), scrim: r('#explorerScrim'), cm: r('.CodeMirror') };
})()`;
// 可见可点控件中小于 44px 的（排除状态栏：设计上 30px 高，操作在别处有 ≥44px 入口；排除 CodeMirror 内部与浮层）
const SMALL = `(() => {
  const sel = 'button, [role=tab], [role=button], input:not([type=hidden]), select, textarea, .rail-btn';
  const out = [];
  for (const e of document.querySelectorAll(sel)) {
    if (!e.getClientRects().length || e.closest('#statusbar') || e.closest('.CodeMirror') || e.closest('#layer')) continue;
    const st = getComputedStyle(e); if (st.visibility === 'hidden' || st.display === 'none') continue;
    let host = e.closest('.modal-overlay'); if (host && !host.classList.contains('show')) continue;
    if (e.closest('#importProgress') && !document.getElementById('importProgress').classList.contains('show')) continue;
    // 包在 <label> 里的复选框：真正的点击目标是整个 label
    const wrap = e.type === 'checkbox' && e.closest('label');
    const b = (wrap || e).getBoundingClientRect();
    // 伪元素扩展的点击区
    const after = getComputedStyle(e, '::after');
    let ew = b.width, eh = b.height;
    if (!wrap && after.content && after.content !== 'none' && after.position === 'absolute') {
      const px = v => parseFloat(v) || 0;
      eh = b.height - px(after.top) - px(after.bottom); ew = b.width - px(after.left) - px(after.right);
    }
    if (eh < 43.5 || ew < 43.5) out.push((e.id || e.getAttribute('aria-label') || e.className || e.tagName) + ' ' + Math.round(ew) + 'x' + Math.round(eh));
  }
  return out;
})()`;

try {
  // ── 默认主题（全新安装、无设置）──
  await b.reload(true);
  eq('theme: 全新安装默认现代主题', await ev('document.documentElement.dataset.theme'), 'modern');
  eq('theme: 设置下拉默认现代', await ev('(openSettings(), document.getElementById("themeInput").value)'), 'modern');
  await key('Escape');
  await ev('setSetting("theme","classic"); true');
  await b.reload();
  eq('theme: 选过经典的保持经典', await ev('document.documentElement.dataset.theme'), 'classic');
  await ev('setSetting("theme","modern"); true');
  await b.reload();
  // 关掉首次启动的新建项目弹窗，并准备一个项目
  if (await ev('overlayStack.length')) await key('Escape');
  await ev(`(() => { project = { name: 'Smoke', language: 'c', files: [
    { path: 'main.c', code: '#include <stdio.h>\\nint main(void) {\\n  printf("hi\\\\n");\\n  return 0;\\n}\\n' },
    { path: 'src/util.c', code: 'int add(int a, int b) { return a + b; }\\n' } ] };
    resetEditorSession(true); currentFilePath = ''; switchProjectFile('main.c'); renderProjectFiles(); return true; })()`);
  eq('version: 状态栏显示 1.1.0', await ev('document.getElementById("statusVersion").textContent'), 'Doge IDE+ 1.1.0');
  eq('version: 页面标题', await ev('document.title'), 'Doge IDE+ · 本地 C/C++ 编程');

  // ── 各视口：无横向滚动、区域互不重叠、运行按钮可见 ──
  for (const [w, h, label] of [[1557, 973, '全屏横屏'], [964, 973, '分屏一半'], [920, 900, '断点 920'], [720, 973, '窄分屏'], [600, 960, '竖屏']]) {
    await b.setViewport(w, h, true); await sleep(150);
    const g = await ev(GEOM);
    eq(label + ': 无横向滚动', g.scrollW, w);
    eq(label + ': 无纵向溢出', g.scrollH, h);
    ok(label + ': 运行按钮完整可见 ' + JSON.stringify(g.runBtn), g.runBtn && g.runBtn.l >= 0 && g.runBtn.r <= w);
    ok(label + ': 状态栏贴底', g.statusbar && g.statusbar.b === h);
    ok(label + ': 底部面板与编辑区同宽 ' + (g.panel && g.panel.w) + '/' + (g.editorCol && g.editorCol.w), g.panel && g.editorCol && g.panel.w === g.editorCol.w && g.panel.l === g.editorCol.l);
    ok(label + ': 编辑器至少 12 行高 (' + (g.cm && g.cm.h) + 'px)', g.cm && g.cm.h >= 12 * 24);
    const small = await ev(SMALL);
    ok(label + ': 触控目标 ≥44px' + (small.length ? ' 不足: ' + small.join(', ') : ''), small.length === 0);
  }
  // 全屏横屏：编辑器列宽度 = 视口 − 活动栏 − 资源管理器
  await b.setViewport(1557, 973, true); await sleep(150);
  {
    const g = await ev(GEOM);
    eq('wide: 资源管理器内嵌（不覆盖编辑区）', g.explorer && g.editorCol && g.explorer.r <= g.editorCol.l, true);
    eq('wide: 无遮罩', g.scrim, null);
  }

  // ── 窄屏覆盖层 ──
  await b.setViewport(720, 973, true); await sleep(200);
  eq('narrow: 进入窄屏自动收起资源管理器', await ev('document.getElementById("explorer").hidden'), true);
  await ev('document.querySelector(".rail-btn[data-rail=explorer]").click()'); await sleep(80);
  {
    const g = await ev(GEOM);
    ok('narrow: 资源管理器覆盖在编辑区上 ' + JSON.stringify(g.explorer), g.explorer && g.editorCol && g.explorer.l < g.editorCol.r && g.explorer.l >= g.rail.r - 1);
    ok('narrow: 编辑区宽度不被挤压', g.editorCol.w === 720 - g.rail.w);
    ok('narrow: 显示遮罩', !!g.scrim);
    // 点遮罩收起（真实触摸）
    await tap(g.explorer.r + 60, 400);
    eq('narrow: 点遮罩收起', await ev('document.getElementById("explorer").hidden'), true);
  }
  // 选文件后收起
  await ev('document.querySelector(".rail-btn[data-rail=explorer]").click()'); await sleep(80);
  await ev('document.querySelector(".project-file[data-path=\\"src/util.c\\"]").click()'); await sleep(80);
  eq('narrow: 选中文件后收起并打开文件', await ev('[document.getElementById("explorer").hidden, currentFilePath]'), [true, 'src/util.c']);
  // Esc 收起（运行中也只收起，不停止）
  await ev('document.querySelector(".rail-btn[data-rail=explorer]").click(); window.__c = 0; window.__oc = cancelExecution; cancelExecution = () => window.__c++; isRunning = true; true'); await sleep(60);
  await key('Escape');
  eq('narrow: Esc 收起覆盖层且不停止运行', await ev('[document.getElementById("explorer").hidden, window.__c]'), [true, 0]);
  await ev('isRunning = false; cancelExecution = window.__oc; true');
  // 搜索结果跳转后收起
  await key('F', { ctrl: true, shift: true }); await sleep(100);
  await ev('document.getElementById("searchInput").value = "main"; runProjectSearch(); true');
  await ev('document.querySelector(".sr-hit").click()'); await sleep(100);
  eq('narrow: 搜索结果跳转后收起', await ev('document.getElementById("explorer").hidden'), true);
  // 窄屏里的开关不影响宽屏偏好
  await b.setViewport(1557, 973, true); await sleep(200);
  eq('narrow→wide: 恢复宽屏的资源管理器', await ev('document.getElementById("explorer").hidden'), false);
  await ev('setSideView("files"); setExplorerVisible(false); true'); // 宽屏里收起
  await b.setViewport(720, 973, true); await sleep(150);
  await b.setViewport(1557, 973, true); await sleep(150);
  eq('wide: 宽屏收起偏好被保留', await ev('document.getElementById("explorer").hidden'), true);
  await ev('setExplorerVisible(true)');

  // ── 菜单栏在窄屏只滚动菜单 ──
  await b.setViewport(420, 900, true); await sleep(150);
  {
    const g = await ev(GEOM);
    eq('tiny: 420 宽也无横向滚动', g.scrollW, 420);
    ok('tiny: 运行按钮可见', g.runBtn && g.runBtn.r <= 420 && g.runBtn.l >= 0);
    ok('tiny: 菜单可横向滚动', await ev('(() => { const m = document.getElementById("menuList"); return m.scrollWidth > m.clientWidth && getComputedStyle(m).overflowX === "auto"; })()'));
  }

  // ── 软键盘（模拟：页面高度缩小 + 焦点在输入控件 → kb-open）──
  await b.setViewport(1557, 973, true); await sleep(200);
  await ev('document.querySelectorAll("#explorer").forEach(e => e.hidden = false); switchProjectFile("main.c"); editor.focus(); editor.setCursor(3, 2); true'); await sleep(80);
  // 真实设备上 adjustResize 会把 WebView 高度缩小；这里用视口高度模拟 visualViewport 变化
  await b.setViewport(1557, 560, true); await sleep(250);
  eq('kb: 编辑器获得焦点且高度缩小时进入 kb-open', await ev('document.body.classList.contains("kb-open")'), true);
  {
    const g = await ev(GEOM);
    eq('kb: 键盘弹出时无纵向溢出', g.scrollH, 560);
    eq('kb: 底部面板让出空间', g.panel, null);
    eq('kb: 状态栏让出空间', g.statusbar, null);
    ok('kb: 编辑器占满剩余高度 (' + (g.cm && g.cm.h) + ')', g.cm && g.cm.b <= 560 && g.cm.h >= 560 - 48 - 40 - 30 - 4);
    ok('kb: 光标行可见', await ev('(() => { const c = editor.cursorCoords(null, "window"); return c.top >= 0 && c.bottom <= innerHeight; })()'));
  }
  await ev('document.activeElement.blur(); true');
  await b.setViewport(1557, 973, true); await sleep(250);
  eq('kb: 键盘收起后退出 kb-open', await ev('document.body.classList.contains("kb-open")'), false);
  eq('kb: 收起后布局没有残留滚动', await ev('[document.documentElement.scrollTop, document.body.scrollTop, document.querySelector(".workbench").scrollTop]'), [0, 0, 0]);
  // 焦点在 stdin：保留面板、收起编辑区
  await ev('switchStream("stdin"); document.getElementById("stdinInput").focus(); true'); await sleep(80);
  await b.setViewport(1557, 560, true); await sleep(250);
  {
    const g = await ev(GEOM);
    eq('kb-stdin: 进入 kb-panel', await ev('document.body.classList.contains("kb-panel")'), true);
    eq('kb-stdin: 编辑区让出空间', g.editorCol, null);
    ok('kb-stdin: 面板占满剩余高度', g.panel && g.panel.b <= 560 && g.panel.h >= 300);
    ok('kb-stdin: 输入框可见', await ev('(() => { const r = document.getElementById("stdinInput").getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight && r.height > 60; })()'));
    eq('kb-stdin: 无纵向溢出', g.scrollH, 560);
  }
  await ev('document.activeElement.blur(); true');
  await b.setViewport(1557, 973, true); await sleep(250);
  eq('kb-stdin: 收起后恢复编辑区', await ev('!!document.querySelector(".editor-col").getClientRects().length && !document.body.classList.contains("kb-panel")'), true);
  // 键盘弹出时打开对话框：对话框不超出可视区
  await ev('openSettings()'); await sleep(80);
  await ev('document.getElementById("timeoutInput").focus()');
  await b.setViewport(1557, 560, true); await sleep(250);
  ok('kb-dialog: 设置对话框在可视区内', await ev('(() => { const r = document.getElementById("settingsPanel").getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; })()'));
  ok('kb-dialog: 聚焦的输入框可见', await ev('(() => { const r = document.activeElement.getBoundingClientRect(); return document.activeElement.id === "timeoutInput" && r.top >= 0 && r.bottom <= innerHeight; })()'));
  await b.setViewport(1557, 973, true); await sleep(200);
  await key('Escape');

  // ── 对话框与浮层的触控尺寸 ──
  for (const [label, open] of [['设置', 'openSettings()'], ['快捷键', 'openShortcuts()'], ['新建项目', 'showCreateProject()'], ['输入框', 'dogeInput("t","l","v",()=>{})'], ['确认框', 'dogeConfirm("m",()=>{})']]) {
    await ev(open + '; true'); await sleep(100);
    const small = await ev(SMALL);
    ok('touch-dialog: ' + label + ' 控件 ≥44px' + (small.length ? ' 不足: ' + small.join(', ') : ''), small.length === 0);
    await key('Escape'); await sleep(60);
  }
  // 下拉菜单与命令面板项
  await ev('document.querySelector(".menu-btn").click()'); await sleep(80);
  ok('touch-menu: 菜单项 ≥44px', await ev('[...document.querySelectorAll("#layer .mi")].every(m => m.getBoundingClientRect().height >= 44)'));
  await key('Escape');
  await ev('openCommandPalette()'); await sleep(80);
  ok('touch-palette: 命令项 ≥44px', await ev('[...document.querySelectorAll("#palList .pi")].every(m => m.getBoundingClientRect().height >= 44)'));
  await key('Escape');

  // ── 非触控（鼠标）：保持紧凑尺寸，不被触控样式放大 ──
  await b.setViewport(1557, 973, false); await sleep(150);
  eq('mouse: 菜单栏 44px', await ev('document.getElementById("menubar").getBoundingClientRect().height'), 44);
  eq('mouse: 图标按钮 30px', await ev('document.querySelector(".side-head .btn-icon").getBoundingClientRect().height'), 30);
  eq('mouse: 状态栏 26px', await ev('document.getElementById("statusbar").getBoundingClientRect().height'), 26);

  // ── 减少动态效果 ──
  await b.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  eq('motion: prefers-reduced-motion 关闭过渡', await ev('getComputedStyle(document.querySelector(".toast")).transitionDuration'), '0s');
} catch (e) {
  ok('脚本异常: ' + e.message, false);
}
ok('无 JS 异常' + (b.errors.length ? '：' + b.errors.join(' | ') : ''), b.errors.length === 0);
const failed = report('批次6 浏览器冒烟');
await b.close();
process.exit(failed ? 1 : 0);
