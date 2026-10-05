// 自动补全浏览器冒烟：真实按键 / 输入法组字 / 列表随输入刷新 / 接受补全 / clangd 模拟 / 触控点选
// 用法: node test/browser-smoke-completion.mjs   （找不到 Edge/Chrome 时跳过）
import { launch, checker, sleep } from './browser-lib.mjs';

const b = await launch({ width: 1557, height: 973, touch: false });
if (!b) { console.log('跳过：未找到 Edge/Chrome'); process.exit(0); }
const { ok, eq, report } = checker();
const { ev, key, typeText, send } = b;

// 候选名（不含 .hint-detail 里的类型说明）
const hintItems = 'editor.state.completionActive && editor.state.completionActive.widget ? [...document.querySelectorAll(".CodeMirror-hints .CodeMirror-hint")].map(li => li.firstChild ? li.firstChild.textContent : li.textContent) : null';
const hintOpen = '!!(editor.state.completionActive && editor.state.completionActive.widget)';
const lineText = (n) => 'editor.getLine(' + n + ')';
async function waitFor(expr, ms = 3000) {
  for (let t = 0; t < ms; t += 40) { if (await ev(expr)) return true; await sleep(40); }
  return false;
}
// 逐字符输入（真实 keydown/char/keyup，走 CodeMirror 的 +input 路径）
async function typeKeys(s) { for (const ch of s) await key(ch); }
// 模拟 Android 输入法组字：compositionstart → 更新 textarea → compositionend
async function composeText(s) {
  await send('Input.imeSetComposition', { text: s, selectionStart: s.length, selectionEnd: s.length });
  await sleep(60);
  await send('Input.insertText', { text: s });
  await sleep(80);
}
async function reset(code, line, ch) {
  await ev('editor.closeHint(); clangdCompletionCache.key = ""; clangdCompletionCache.items = null; true');
  await ev('editor.setValue(' + JSON.stringify(code) + '); editor.focus(); editor.setCursor(' + line + ', ' + ch + '); true');
  await sleep(60);
}

try {
  if (await ev('overlayStack.length')) await key('Escape');
  await ev(`(() => { project = { name: 'AC', language: 'c', files: [{ path: 'main.c', code: '' }] };
    resetEditorSession(true); currentFilePath = ''; switchProjectFile('main.c'); return true; })()`);
  eq('setup: 默认开启自动补全', await ev('autoCompleteEnabled()'), true);
  const base = '#include <stdio.h>\nint counter_total = 0;\nint main(void) {\n  \n  return 0;\n}\n';

  // ── 基本：两个字母后自动弹出 ──
  await reset(base, 3, 2);
  await typeKeys('p');
  await sleep(250);
  eq('word: 一个字母不弹', await ev(hintOpen), false);
  await typeKeys('r');
  ok('word: 两个字母自动弹出', await waitFor(hintOpen));
  const first = await ev(hintItems);
  ok('word: 候选含 printf (' + (first || []).slice(0, 5).join(',') + ')', !!first && first.includes('printf'));
  ok('word: 候选都以 pr 开头(前缀优先)', !!first && first[0].toLowerCase().startsWith('pr'));
  // 列表打开后继续输入：随输入收窄（输入 "print" 后只剩 print 开头的）
  await typeKeys('int');
  await sleep(120);
  const narrowed = await ev(hintItems);
  ok('refresh: 继续输入后列表收窄 (' + JSON.stringify(narrowed) + ')', !!narrowed && narrowed.length >= 1 && narrowed.every(x => x.startsWith('print')));
  await key('Escape');
  eq('esc: Esc 关闭列表', await ev(hintOpen), false);
  eq('esc: 关闭列表后文本不变', await ev(lineText(3)), '  print');
  // 已经输完整个词：唯一候选就是自己，列表自动关闭
  await typeKeys('f');
  await sleep(300);
  eq('refresh: 输完整个词后不再弹出', await ev(hintOpen), false);

  // ── 文档里的标识符 + Tab 接受 ──
  await reset(base, 3, 2);
  await typeKeys('cou');
  ok('doc: 文档里的标识符出现', await waitFor('(' + hintItems + ' || []).includes("counter_total")'));
  await key('Tab');
  eq('tab: Tab 接受补全', await ev(lineText(3)), '  counter_total');
  eq('tab: 接受后列表关闭', await ev(hintOpen), false);

  // ── Enter 接受 ──
  await reset(base, 3, 2);
  await typeKeys('ret');
  ok('enter: 弹出 return', await waitFor('(' + hintItems + ' || [])[0] === "return"'));
  await key('Enter');
  eq('enter: Enter 接受补全（不换行）', await ev('[' + lineText(3) + ', editor.lineCount()]'), ['  return', 7]);

  // ── 不该弹的地方 ──
  await reset(base, 3, 2);
  await typeKeys('// pr');
  await sleep(300);
  eq('skip: 注释里不弹', await ev(hintOpen), false);
  await reset('int main(void) {\n  printf("he");\n}\n', 1, 12);
  await typeKeys('ll');
  await sleep(300);
  eq('skip: 字符串里不弹', await ev(hintOpen), false);
  await reset('int x = 0;\n', 0, 8);
  await typeKeys('xff');
  await sleep(300);
  eq('skip: 数字字面量 0xff 不弹', await ev(hintOpen), false);

  // ── #include 与预处理 ──
  await reset('\n', 0, 0);
  await typeKeys('#inc');
  ok('preproc: #inc 弹出 #include', await waitFor('(' + hintItems + ' || []).some(x => x.startsWith("#include"))'));
  await key('Escape');
  await reset('#include <\n', 0, 10);
  await typeKeys('st');
  ok('include: #include <st 弹出头文件', await waitFor('(' + hintItems + ' || []).includes("#include <stdio.h>")'));
  await key('Enter');
  eq('include: 接受后整行替换为头文件', await ev(lineText(0)), '#include <stdio.h>');

  // ── 成员访问 . / -> 触发（本地候选来自文档里用过的成员）──
  const structSrc = 'struct P { int xpos; int ypos; };\nint main(void) {\n  struct P p; p.xpos = 1; p.ypos = 2;\n  struct P *q = &p;\n  \n}\n';
  await reset(structSrc, 4, 2);
  await typeKeys('p.');
  ok('member: p. 自动弹出成员 (' + JSON.stringify(await ev(hintItems)) + ')', await waitFor('(' + hintItems + ' || []).includes("xpos")'));
  await key('Enter');
  eq('member: 接受成员', await ev(lineText(4)), '  p.xpos');
  await reset(structSrc, 4, 2);
  await typeKeys('q->');
  ok('member: q-> 自动弹出成员 (' + JSON.stringify(await ev(hintItems)) + ')', await waitFor('(' + hintItems + ' || []).includes("ypos")'));
  await typeKeys('y');
  await sleep(120);
  eq('member: -> 后继续输入收窄', await ev(hintItems), ['ypos']);
  await key('Escape');

  // ── 输入法组字（Android 键盘英文模式也走组字）──
  await reset(base, 3, 2);
  await composeText('pr');
  ok('ime: 组字输入 pr 也自动弹出', await waitFor(hintOpen));
  await key('Escape');

  // ── 关闭开关：不自动弹；Ctrl+Space 仍可手动 ──
  await ev('setSetting("autoComplete", "0"); true');
  await reset(base, 3, 2);
  await typeKeys('pri');
  await sleep(300);
  eq('off: 关闭后不自动弹', await ev(hintOpen), false);
  await key(' ', { ctrl: true });
  ok('off: Ctrl+Space 仍可手动补全', await waitFor(hintOpen));
  await key('Escape');
  await ev('runCommand("edit.autoComplete"); true');
  eq('menu: 编辑菜单开关切换', await ev('autoCompleteEnabled()'), true);
  // 手动补全：一个字母也可以
  await reset(base, 3, 2);
  await ev('setSetting("autoComplete", "0"); true');
  await typeKeys('m');
  await key(' ', { ctrl: true });
  ok('manual: 一个字母也能手动补全', await waitFor('(' + hintItems + ' || []).includes("main")'));
  await key('Escape');
  await ev('setSetting("autoComplete", "1"); true');

  // ── Esc：关补全列表的 Esc 不停止运行；没有列表时运行中 Esc 仍停止 ──
  await ev('window.__c = 0; window.__oc = cancelExecution; cancelExecution = () => window.__c++; isRunning = true; true');
  await reset(base, 3, 2);
  await typeKeys('pr');
  await waitFor(hintOpen);
  await key('Escape');
  eq('esc-run: 关补全列表的 Esc 不停止运行', await ev('[' + hintOpen + ', window.__c]'), [false, 0]);
  await key('Escape');
  eq('esc-run: 再按 Esc 停止运行', await ev('window.__c'), 1);
  // 没有候选时留下的隐形补全状态不能吞掉 Esc
  await reset(base, 3, 2);
  await typeKeys('zq');
  await sleep(300);
  await key('Escape');
  eq('esc-run: 没有候选时 Esc 直接停止运行', await ev('window.__c'), 2);
  await ev('isRunning = false; cancelExecution = window.__oc; true');

  // ── clangd（模拟运行库就绪 + 本地服务返回 LSP CompletionList）──
  await ev(`(() => {
    window.__calls = 0;
    window.__origReady = toolchainReady; toolchainReady = () => true;
    window.__origFetch = window.fetch;
    window.fetch = (url, opts) => {
      if (String(url).includes('/api/v1/intel/completion')) {
        window.__calls++;
        const body = JSON.parse(opts.body);
        const items = [
          { label: ' fprintf(FILE *restrict stream, const char *restrict format, ...)', insertText: 'fprintf', detail: 'int', sortText: '2' },
          { label: ' printf(const char *restrict format, ...)', insertText: 'printf', detail: 'int', sortText: '1' },
          { label: ' puts(const char *s)', textEdit: { newText: 'puts' }, detail: 'int', sortText: '3' }
        ];
        return new Promise(r => setTimeout(() => r(new Response(JSON.stringify({ isIncomplete: false, items, __line: body.line }), { status: 200 })), 150));
      }
      return window.__origFetch(url, opts);
    };
    return true; })()`);
  await reset(base, 3, 2);
  await typeKeys('pr');
  ok('clangd: 先显示本地候选', await waitFor(hintOpen, 600));
  ok('clangd: clangd 结果回来后合并 (' + JSON.stringify(await ev(hintItems)) + ')', await waitFor('(' + hintItems + ' || []).some(x => x.startsWith("printf(const char"))', 2000));
  eq('clangd: 按 clangd 排序靠前', await ev('(' + hintItems + ')[0].startsWith("printf(")'), true);
  ok('clangd: 显示返回类型', await ev('!!document.querySelector(".CodeMirror-hints .hint-detail")'));
  const callsAfterFirst = await ev('window.__calls');
  await typeKeys('i');
  await sleep(250);
  eq('clangd: 同一个词里继续输入不再请求', await ev('window.__calls'), callsAfterFirst);
  await key('Enter');
  eq('clangd: 插入的是名字不是签名', await ev(lineText(3)), '  printf');
  // 不在同一个词里：新请求
  await typeKeys('(');
  await typeKeys('pu');
  ok('clangd: 新词重新请求', await waitFor('window.__calls > ' + callsAfterFirst, 1500));
  // clangd 失败：回落到本地候选
  await ev('window.fetch = (u, o) => String(u).includes("/intel/completion") ? Promise.reject(new Error("down")) : window.__origFetch(u, o); true');
  await reset(base, 3, 2);
  await typeKeys('re');
  ok('clangd: 服务失败时回落到本地候选', await waitFor('(' + hintItems + ' || []).includes("return")', 1500));
  await key('Escape');
  await ev('window.fetch = window.__origFetch; toolchainReady = window.__origReady; true');

  // ── Tab 接受：各种到达方式（真机上 Tab 曾经变成缩进）──
  const tabRaw = async () => {
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    await sleep(150);
  };
  await reset(base, 3, 2); await composeText('pr'); await waitFor(hintOpen);
  await tabRaw();
  eq('tab: 输入法组字输入后 Tab 接受', await ev(lineText(3)), '  printf');
  await reset(base, 3, 2); await composeText('pr'); await waitFor(hintOpen);
  await send('Input.imeSetComposition', { text: 'i', selectionStart: 1, selectionEnd: 1 }); await sleep(40);
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
  await send('Input.insertText', { text: 'i' });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
  await sleep(250);
  eq('tab: 组字还没上屏时按 Tab，先上屏再接受', await ev(lineText(3)), '  printf');
  await reset(base, 3, 2); await typeKeys('pr'); await waitFor(hintOpen);
  await send('Input.insertText', { text: '\t' }); await sleep(200);
  eq('tab: 输入法把 Tab 当文字 \\t 送来也接受', await ev(lineText(3)), '  printf');
  await reset(base, 3, 2); await typeKeys('pr'); await waitFor(hintOpen);
  await send('Input.insertText', { text: 'i\t' }); await sleep(250);
  eq('tab: 输入法送 "i\\t"（字母和 Tab 一起）', await ev(lineText(3)), '  printf');
  await reset(base, 3, 2);
  await tabRaw();
  eq('tab: 没有列表时 Tab 照常缩进', await ev(lineText(3)), '  \t'.replace('\t', '    ').slice(0, 2) + (await ev(lineText(3))).slice(2));
  ok('tab: 没有列表时 Tab 插入了缩进', (await ev(lineText(3))).length > 2);
  await reset(base, 3, 2);
  await send('Input.insertText', { text: '\t' }); await sleep(150);
  ok('tab: 没有列表时输入法 \\t 照常插入', (await ev(lineText(3))).length > 2);
  await reset(base, 3, 2); await typeKeys('pr'); await waitFor(hintOpen);
  await key('Tab', { shift: true });
  eq('tab: Shift+Tab 不接受补全', await ev(lineText(3)).then(t => t.includes('printf')), false);
  await key('Escape');

  // ── 项目头文件 ──
  await ev(`(() => {
    project.files = [
      { path: 'main.c', code: '#include "util.h"\\n#include "geo/shape.h"\\n\\nint main(void) {\\n  \\n  return 0;\\n}\\n' },
      { path: 'util.h', code: '#pragma once\\n#define MAX_ITEMS 64\\ntypedef struct Point { int xpos; int ypos; } Point;\\nint add_numbers(int a, int b);\\nconst char *greet_user(const char *name);\\n' },
      { path: 'geo/shape.h', code: '#pragma once\\n#include "common.h"\\ndouble shape_area(double w, double h);\\n' },
      { path: 'geo/common.h', code: 'typedef enum { SHAPE_SQUARE, SHAPE_CIRCLE } ShapeKind;\\n' },
      { path: 'include/lib.h', code: 'int lib_version(void);\\n' },
      { path: 'unused.h', code: 'int not_included_fn(void);\\n' }
    ];
    projectDocs.clear(); currentFilePath = ''; switchProjectFile('main.c'); return true; })()`);
  const mainCode = await ev('editor.getValue()');
  const mainLine = 4;
  await reset(mainCode, mainLine, 2);
  await typeKeys('ad');
  ok('hdr: 头文件里的函数出现在候选 (' + JSON.stringify(await ev(hintItems)) + ')', await waitFor('(' + hintItems + ' || []).some(x => x === "add_numbers")'));
  ok('hdr: 候选带签名与来源文件', await ev('[...document.querySelectorAll(".CodeMirror-hints .hint-detail")].some(d => d.textContent.includes("int add_numbers(int a, int b)") && d.textContent.includes("util.h"))'));
  await key('Tab');
  eq('hdr: Tab 接受头文件函数', await ev(lineText(mainLine)), '  add_numbers');
  await reset(mainCode, mainLine, 2); await typeKeys('MA');
  ok('hdr: 宏', await waitFor('(' + hintItems + ' || []).includes("MAX_ITEMS")'));
  await key('Escape');
  await reset(mainCode, mainLine, 2); await typeKeys('sh');
  ok('hdr: 子目录头文件里的函数', await waitFor('(' + hintItems + ' || []).includes("shape_area")'));
  await key('Escape');
  await reset(mainCode, mainLine, 2); await typeKeys('SHAPE_');
  ok('hdr: 头文件 include 的头文件（递归）里的枚举常量', await waitFor('(' + hintItems + ' || []).includes("SHAPE_CIRCLE")'));
  await key('Escape');
  await reset(mainCode, mainLine, 2); await typeKeys('not_in');
  await sleep(300);
  eq('hdr: 没 include 的头文件不提示', await ev('(' + hintItems + ' || []).includes("not_included_fn")'), false);
  await key('Escape');
  await reset(mainCode.replace('  \n', '  Point pt;\n  \n'), mainLine + 1, 2); await typeKeys('pt.');
  ok('hdr: 头文件里的结构体成员', await waitFor('(' + hintItems + ' || []).includes("xpos")'));
  await key('Escape');
  // 编辑头文件后，main.c 的候选跟着更新
  await ev('project.files.find(f => f.path === "util.h").code += "int added_later(void);\\n"; true');
  await reset(mainCode, mainLine, 2); await typeKeys('add');
  ok('hdr: 头文件改动后候选更新', await waitFor('(' + hintItems + ' || []).includes("added_later")'));
  await key('Escape');
  // #include "…" 列出项目头文件
  await reset('#include "\n', 0, 10);
  await typeKeys('u');
  ok('inc: #include "u 列出项目头文件 (' + JSON.stringify(await ev(hintItems)) + ')', await waitFor('(' + hintItems + ' || []).includes("util.h")'));
  ok('inc: 只列 u 开头的', await ev('(' + hintItems + ' || []).every(x => x.startsWith("u"))'));
  // unused.h 也以 u 开头；再输入 t 收窄到 util.h 再接受
  await typeKeys('t');
  ok('inc: 输入 ut 后候选刷新为 util.h', await waitFor('(' + hintItems + ' || [])[0] === "util.h"'));
  await key('Tab');
  eq('inc: 接受后补上收尾引号', await ev(lineText(0)), '#include "util.h"');
  await reset('#include "geo/\n', 0, 14);
  await typeKeys('s');
  ok('inc: 子目录写法', await waitFor('(' + hintItems + ' || []).includes("geo/shape.h")'));
  await key('Escape');
  await reset('#include ""\n', 0, 10);
  await typeKeys('ut');
  await waitFor(hintOpen);
  await key('Enter');
  eq('inc: 已有收尾引号时不重复', await ev(lineText(0)), '#include "util.h"');
  // 本地“未定义名”检查不再把头文件里的函数标红
  await ev('editor.setValue(\'#include "util.h"\\nint main(void) { return add_numbers(1, 2) + MAX_ITEMS; }\\n\'); lintDocument(); true');
  eq('lint: 头文件里的函数和宏不标为未定义', await ev('editor.getAllMarks().filter(m => m.className === "cm-doge-undefined").map(m => editor.getRange(m.find().from, m.find().to))'), []);
  await ev('editor.setValue(\'int main(void) { return add_numbers(1, 2); }\\n\'); lintDocument(); true');
  eq('lint: 没 include 时仍标为未定义', await ev('editor.getAllMarks().filter(m => m.className === "cm-doge-undefined").map(m => editor.getRange(m.find().from, m.find().to))'), ['add_numbers']);
  await ev('editor.setValue(""); true');

  // ── 切换文件时关闭列表；只读时不弹 ──
  await reset(base, 3, 2);
  await typeKeys('pr');
  await waitFor(hintOpen);
  await ev('project.files.push({ path: "b.c", code: "" }); switchProjectFile("b.c"); true');
  eq('switch: 切换文件关闭补全列表', await ev(hintOpen), false);
  await ev('switchProjectFile("main.c"); true');

  // ── 触控：点选候选不让编辑器失焦（平板上键盘不收起），候选项 44px ──
  await b.setViewport(1557, 973, true);
  await reset(base, 3, 2);
  await typeKeys('pr');
  await waitFor(hintOpen);
  ok('touch: 候选项 ≥44px', await ev('[...document.querySelectorAll(".CodeMirror-hints .CodeMirror-hint")].every(li => li.getBoundingClientRect().height >= 44)'));
  const target = await ev('(() => { const li = [...document.querySelectorAll(".CodeMirror-hints .CodeMirror-hint")].find(x => x.textContent === "printf"); const r = li.getBoundingClientRect(); return [r.left + 10, r.top + r.height / 2]; })()');
  let blurred = false;
  await ev('window.__blur = 0; editor.on("blur", window.__blurFn = () => window.__blur++); true');
  await b.tap(target[0], target[1]);
  await sleep(150);
  blurred = await ev('window.__blur > 0');
  eq('touch: 点选候选插入', await ev(lineText(3)), '  printf');
  eq('touch: 点选时编辑器没有失焦', blurred, false);
  await ev('editor.off("blur", window.__blurFn); true');
} catch (e) {
  ok('脚本异常: ' + e.message, false);
}
ok('无 JS 异常' + (b.errors.length ? '：' + b.errors.join(' | ') : ''), b.errors.length === 0);
const failed = report('自动补全浏览器冒烟');
await b.close();
process.exit(failed ? 1 : 0);
