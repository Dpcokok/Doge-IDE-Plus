// Doge IDE+ 前端基线测试 (批次 0)
// 用法: node test/frontend-baseline.mjs
// 作用:
//   1. 抽取 doge-ide.html <script> 中的纯函数并断言其行为(重构后必须仍然通过)
//   2. 静态断言 APK 行为不变量(inputStyle/超时常量/回调名/桥接方法等)在源码中存在
//   3. 断言接口契约(DogeNative.* 调用 与 Java @JavascriptInterface 一一对应)
// 这些断言构成 1.0.2 -> 1.1.0 前端重构过程中每个批次都要复跑的护栏。

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'doge-ide.html'), 'utf8');
const java = readFileSync(
  join(root, 'android/app/src/main/java/com/doge/ide/MainActivity.java'),
  'utf8'
);

let pass = 0;
let fail = 0;
const failures = [];
function ok(name, cond) {
  if (cond) { pass++; }
  else { fail++; failures.push(name); }
}
function eq(name, got, want) {
  ok(name + ' (got ' + JSON.stringify(got) + ')', JSON.stringify(got) === JSON.stringify(want));
}

// ── 从 HTML 中按函数名抽取源码，放进受控作用域执行 ──────────────
function extractFn(name) {
  const re = new RegExp('function ' + name + '\\s*\\(');
  const start = html.search(re);
  if (start < 0) throw new Error('未找到函数: ' + name);
  // 从函数体第一个 { 起做花括号配平；跳过字符串、模板、注释、正则字面量里的括号
  const braceStart = html.indexOf('{', html.indexOf(')', start));
  let depth = 0, i = braceStart;
  let prevSig = '{';
  for (; i < html.length; i++) {
    const c = html[i];
    if (c === '"' || c === "'" || c === '`') {
      for (i++; i < html.length && html[i] !== c; i++) if (html[i] === '\\') i++;
      prevSig = c; continue;
    }
    if (c === '/' && html[i + 1] === '/') { i = html.indexOf('\n', i); continue; }
    if (c === '/' && html[i + 1] === '*') { i = html.indexOf('*/', i) + 1; continue; }
    // 正则：前一个有效字符是运算符 / 左括号 / 逗号等时，/ 开始的是正则而不是除号
    if (c === '/' && /[(,=:[!&|?{};+\-*%<>~^]/.test(prevSig)) {
      let inClass = false;
      for (i++; i < html.length; i++) {
        const d = html[i];
        if (d === '\\') { i++; continue; }
        if (d === '[') inClass = true;
        else if (d === ']') inClass = false;
        else if (d === '/' && !inClass) break;
      }
      prevSig = ')'; continue;
    }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { i++; break; } }
    if (!/\s/.test(c)) prevSig = c;
  }
  return html.slice(start, i);
}

// 纯函数不依赖 DOM 的部分：在沙箱里提供最小依赖
function loadPureFns(names, preamble = '') {
  const src = names.map(extractFn).join('\n\n');
  // eslint-disable-next-line no-new-func
  const factory = new Function(preamble + '\n' + src + '\nreturn {' + names.join(',') + '};');
  return factory();
}

// ── 1. parseDependencyCoordinate ────────────────────────────────
{
  const { parseDependencyCoordinate } = loadPureFns(['parseDependencyCoordinate']);
  eq('dep: name@version', parseDependencyCoordinate('fmt@10.2'), { name: 'fmt', version: '10.2' });
  eq('dep: @scope/name@ver', parseDependencyCoordinate('@scope/x@1.0'), { name: '@scope/x', version: '1.0' });
  eq('dep: 无版本原样', parseDependencyCoordinate('noversion'), 'noversion');
  eq('dep: 尾部@原样', parseDependencyCoordinate('x@'), 'x@');
  eq('dep: 去空格', parseDependencyCoordinate('  a@1  '), { name: 'a', version: '1' });
}

// ── 2. appendBoundedOutput ──────────────────────────────────────
{
  const consts = [];
  for (const m of html.matchAll(/const (MAX_OUTPUT_CHARS|OUTPUT_TRUNCATED_NOTE)\s*=\s*[^\n]+/g)) consts.push(m[0]);
  const { appendBoundedOutput } = loadPureFns(['appendBoundedOutput'], consts.join('\n'));
  const MAX = Number((html.match(/const MAX_OUTPUT_CHARS\s*=\s*([^;]+);/) || [])[1].replace(/[^0-9*]/g, '').split('*').reduce((a, b) => a * Number(b), 1));
  eq('out: 空追加不变', appendBoundedOutput('abc', ''), 'abc');
  eq('out: 正常追加', appendBoundedOutput('a', 'b'), 'ab');
  const base = 'x'.repeat(MAX - 2);
  const capped = appendBoundedOutput(base, 'bbbb');
  // 源码里的 '\n' 是两个字符，需先求值成运行时字符串再比较长度
  const noteLiteral = (html.match(/OUTPUT_TRUNCATED_NOTE\s*=\s*('[^']*')/) || [, "''"])[1];
  const note = new Function('return ' + noteLiteral)();
  ok('out: 截断到上限+提示', capped.length === MAX + note.length && capped.endsWith(note));
  eq('out: 到顶后不再追加', appendBoundedOutput(capped, 'more'), capped);
}

// ── 3. findDiagnosticFile (需要 project / currentFilePath 变量) ──
{
  const fnSrc = extractFn('findDiagnosticFile');
  const factory = new Function(
    'project', 'currentFilePath',
    fnSrc + '\nreturn findDiagnosticFile;'
  );
  const project = { files: [{ path: 'main.c' }, { path: 'src/util.c' }, { path: 'lib/util.c' }, { path: 'include/a.h' }] };
  let find = factory(project, 'lib/util.c');
  eq('diag: 绝对路径后缀匹配', find('/data/runs/x/src/util.c') && find('/data/runs/x/src/util.c').path, 'src/util.c');
  eq('diag: 精确匹配', find('main.c').path, 'main.c');
  eq('diag: 同名歧义优先当前文件', find('util.c').path, 'lib/util.c');
  find = factory(project, 'main.c');
  eq('diag: 同名歧义当前非候选返回 null', find('util.c'), null);
  eq('diag: 不存在返回 null', find('nope.c'), null);
}

// ── 4. clampInt (saveSettings 内的钳制逻辑) ─────────────────────
{
  const m = html.match(/const clampInt = \([^)]*\) => \{[\s\S]*?\};/);
  ok('存在 clampInt 钳制', !!m);
  if (m) {
    const clampInt = new Function('return ' + m[0].replace(/^const clampInt = /, '').replace(/;$/, ''))();
    eq('clamp: 低于下限', clampInt('500', 1000, 30000, 30000), 1000);
    eq('clamp: 高于上限', clampInt('999999', 1000, 30000, 30000), 30000);
    eq('clamp: 非法回退', clampInt('abc', 11, 24, 14), 14);
    eq('clamp: 正常', clampInt('16', 11, 24, 14), 16);
  }
}

// ── 5. APK 行为不变量(静态存在性断言) ───────────────────────────
ok('inv: CodeMirror inputStyle textarea', /inputStyle:\s*'textarea'/.test(html));
// 1.1.1 起 APK 内也自动弹出补全（Tab 吞字的根因是 contenteditable，已由 inputStyle:'textarea' 修复）；
// 这里改为守护：自动补全不再按 DogeNative 关闭、可在设置里关闭、输入法组字也能触发
ok('inv: 自动补全不再在 APK 内关闭', !/function bindAutoComplete[\s\S]{0,300}if \(window\.DogeNative\) return;/.test(html));
ok('inv: 自动补全支持输入法组字', /change\.origin !== '\+input' && change\.origin !== '\*compose'/.test(html));
ok('inv: 自动补全可在设置里关闭', /id="autoCompleteInput"/.test(html) && /setSetting\('autoComplete'/.test(html) && /function autoCompleteEnabled/.test(html));
ok('inv: toolchainReady 真正调用()', /function toolchainReady\(\)[\s\S]{0,200}isToolchainReady\(\)/.test(html));
ok('inv: 任务请求超时 8000', /TASK_REQUEST_TIMEOUT_MS\s*=\s*8000/.test(html));
ok('inv: 轮询失败熔断 5', /TASK_POLL_MAX_FAILURES\s*=\s*5/.test(html));
ok('inv: 停止后兜底 10000', /TASK_CANCEL_GRACE_MS\s*=\s*10000/.test(html));
ok('inv: fetchJsonWithTimeout 使用 AbortController', /fetchJsonWithTimeout[\s\S]{0,400}AbortController/.test(html));
ok('inv: 输出上限 512K', /MAX_OUTPUT_CHARS\s*=\s*512\s*\*\s*1024/.test(html));
ok('inv: 运行按钮三态', /setRunButtonState\('(idle|running|stopping)'\)/.test(html) && /function setRunButtonState/.test(html));
ok('inv: 运行态无 pointer-events:none', !/\.run-btn\.running\{[^}]*pointer-events:none/.test(html));
ok('inv: 无文件只读空状态', /function updateEditorAvailability/.test(html) && /editorEmpty/.test(html));
ok('inv: 导入进度 90 秒兜底', /IMPORT_STALL_MS\s*=\s*90000/.test(html));
ok('inv: 全局错误上报', /function reportSoftwareError/.test(html) && /addEventListener\('error'/.test(html) && /unhandledrejection/.test(html));
ok('inv: 缓存 no-store 依赖 Java 侧, 前端不缓存 fetch', true); // 占位: 缓存在 Java/LocalServer, 见 APK-DEEP-CHECK

// ── 5b. 主题系统(批次 1) ────────────────────────────────────────
ok('theme: 早期内联脚本设置 data-theme', /localStorage\.getItem\('doge-ide-theme'\)[\s\S]{0,160}dataset\.theme/.test(html));
ok('theme: 定义 modern 覆盖块', /\[data-theme="modern"\]\{/.test(html));
ok('theme: applyTheme 存在', /function applyTheme\(/.test(html));
ok('theme: currentTheme 存在', /function currentTheme\(/.test(html));
ok('theme: init 调用 applyTheme', /applyTheme\(currentTheme\(\)\)/.test(html));
ok('theme: saveSettings 写入 theme', /setSetting\('theme'/.test(html));
ok('theme: 设置面板有 themeInput', /id="themeInput"/.test(html));
ok('theme: 经典编辑器令牌保留原值', /--ed-bg:#181818/.test(html) && /--ed-keyword:#82d2ce/.test(html) && /--ed-string:#e394dc/.test(html));
ok('theme: 经典基础色保留原值', /--bg:#1a1b26/.test(html) && /--accent:#7aa2f7/.test(html) && /--green:#9ece6a/.test(html));

// toast 文字色与底色必须不同，否则文字看不见(批次 1 曾把 modern toast 底色设成与文字同色)
{
  // 解析每个主题块内的令牌值
  function tokensOf(scopeRe) {
    const m = html.match(scopeRe);
    if (!m) return {};
    const map = {};
    for (const t of m[1].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) map[t[1]] = t[2].trim();
    return map;
  }
  const rootTok = tokensOf(/:root\{([\s\S]*?)\n\}/);
  const modernTok = tokensOf(/\[data-theme="modern"\]\{([\s\S]*?)\n\}/);
  const resolve = (tok, name, seen = 0) => {
    let v = tok[name];
    if (!v && name in rootTok) v = rootTok[name];
    if (v && v.startsWith('var(') && seen < 5) {
      const inner = v.match(/var\((--[\w-]+)\)/);
      if (inner) return resolve(tok, inner[1], seen + 1);
    }
    return v;
  };
  for (const [label, tok] of [['classic', rootTok], ['modern', { ...rootTok, ...modernTok }]]) {
    const okBg = resolve(tok, '--toast-ok-bg'), green = resolve(tok, '--green');
    const errBg = resolve(tok, '--toast-err-bg'), red = resolve(tok, '--red');
    ok('theme: ' + label + ' 成功 toast 文字≠底色', okBg && green && okBg.toLowerCase() !== green.toLowerCase());
    ok('theme: ' + label + ' 错误 toast 文字≠底色', errBg && red && errBg.toLowerCase() !== red.toLowerCase());
  }
}

// 组件 CSS(body 之后 至 </style>)不得出现裸色值，全部走令牌
{
  const styleStart = html.indexOf('body{font-family:var(--font-sans)');
  const styleEnd = html.indexOf('</style>');
  const componentCss = html.slice(styleStart, styleEnd);
  const rawHex = componentCss.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
  const rawRgba = componentCss.match(/rgba?\([^)]*\)/g) || [];
  ok('theme: 组件 CSS 无裸 hex (' + rawHex.length + ')', rawHex.length === 0);
  ok('theme: 组件 CSS 无裸 rgba (' + rawRgba.length + ')', rawRgba.length === 0);
}

// ── 5c. 工作台骨架 + 命令注册表(批次 2) ─────────────────────────
// 新布局关键节点存在
for (const id of ['menubar','menuList','workbench','rail','explorer','vsplit','editor-col','hsplit','statusbar','layer','breadcrumb','runState']) {
  ok('layout: 存在 #' + id, new RegExp('id="' + id + '"').test(html) || new RegExp('class="[^"]*\\b' + id + '\\b').test(html));
}
// 旧布局已移除
ok('layout: 移除旧 .header 顶栏', !/<div class="header">/.test(html));
ok('layout: 移除旧 .main 容器', !/<div class="main">/.test(html));
ok('layout: 移除旧 resizeHandle', !/id="resizeHandle"/.test(html));
ok('layout: 移除旧 projectResize', !/id="projectResize"/.test(html));
// 关键行为函数仍在(重构不得删)
for (const fn of ['runCode','cancelExecution','newProjectFile','deleteProjectFile','renameProject','showCreateProject','openProject','saveProjectToDisk','triggerCompletion','toggleStdin','switchOutputTab','setRunButtonState','setExplorerVisible','setPanelOpen','runCommand','buildMenubar','buildRail','openCommandPalette','clearConsole','adjustFont']) {
  ok('fn: 存在 ' + fn, new RegExp('function ' + fn + '\\b').test(html));
}
// 所有 onclick="fn(...)" 都指向存在的函数(删死代码时防误删)
for (const name of new Set([...html.matchAll(/on(?:click|pointerdown)="(\w+)\(/g)].map(m => m[1]))) {
  if (name === 'event') continue;
  ok('onclick: ' + name + ' 已定义', new RegExp('function ' + name + '\\s*\\(').test(html));
}
// 命令注册表：每个菜单项都能在 COMMANDS 找到；快捷键不重复
{
  const cmdIds = new Set([...html.matchAll(/'([a-z]+\.[a-zA-Z]+)':\s*\{/g)].map(m => m[1]));
  ok('cmd: COMMANDS 至少 15 条 (' + cmdIds.size + ')', cmdIds.size >= 15);
  const menuBlock = (html.match(/const MENUS = \[([\s\S]*?)\];/) || [, ''])[1];
  const menuItems = [...menuBlock.matchAll(/'([a-z]+\.[a-zA-Z]+)'/g)].map(m => m[1]);
  ok('cmd: 菜单项非空 (' + menuItems.length + ')', menuItems.length > 0);
  for (const it of menuItems) ok('cmd: 菜单项 ' + it + ' 有命令定义', cmdIds.has(it));
  // 快捷键唯一(取 COMMANDS 块内的 key)
  const cmdBlock = (html.match(/const COMMANDS = \{([\s\S]*?)\n\};/) || [, ''])[1];
  const keys = [...cmdBlock.matchAll(/key:\s*'([^']+)'/g)].map(m => m[1]);
  const dup = keys.filter((k, i) => keys.indexOf(k) !== i);
  ok('cmd: 命令快捷键无重复 (' + keys.length + ' keys)' + (dup.length ? ' 重复:' + dup.join(',') : ''), dup.length === 0);
}
// 键盘处理遵守 §5.3：defaultPrevented 早退 + 浮层只吞 Esc
// 批次 5 起由 routeKey 统一判断(行为见 5f 的 route: 用例)
ok('key: 尊重 CodeMirror defaultPrevented', /if \(ev\.defaultPrevented\) return none;/.test(html));
ok('key: 浮层打开只处理 Esc', /if \(ctx\.overlayOpen\) return none;/.test(html) && /overlayOpen: overlayOpen\(\)/.test(html));
ok('key: 单键命令排除输入控件', /INPUT\|TEXTAREA\|SELECT/.test(html));

// ── 5d. 多标签 / 文件树 / 重命名 / 面板修复(批次 3) ─────────────────
{
  const { buildFileTree } = loadPureFns(['buildFileTree']);
  const tree = buildFileTree(['main.c', 'src/util.c', 'src/a.h', 'include/b.h', 'src/deep/x.c']);
  eq('tree: 根目录文件', tree.files.map(f => f.path), ['main.c']);
  eq('tree: 目录排序(字母)', tree.dirs.map(d => d.name), ['include', 'src']);
  const src = tree.dirs.find(d => d.name === 'src');
  eq('tree: src 下文件排序', src.files.map(f => f.path), ['src/a.h', 'src/util.c']);
  eq('tree: 嵌套目录路径', src.dirs.map(d => d.path), ['src/deep']);
  eq('tree: 空列表', buildFileTree([]).files.length + buildFileTree([]).dirs.length, 0);
}
{
  const { validateFileName } = loadPureFns(['validateFileName']);
  eq('name: C 项目 .c 合法', validateFileName('main.c', 'c'), '');
  eq('name: C 项目头文件合法', validateFileName('util.h', 'c'), '');
  ok('name: C 项目拒绝 .cpp 源文件', validateFileName('main.cpp', 'c') !== '');
  ok('name: C++ 项目拒绝 .c 源文件', validateFileName('main.c', 'cpp') !== '');
  eq('name: C++ 项目 .cpp 合法', validateFileName('main.cpp', 'cpp'), '');
  ok('name: 拒绝目录路径', validateFileName('src/main.c', 'c') !== '');
  ok('name: 拒绝 ..', validateFileName('a..c', 'c') !== '');
  ok('name: 拒绝空名', validateFileName('', 'c') !== '');
  eq('name: C 项目允许数据文件 .txt', validateFileName('notes.txt', 'c'), '');
  ok('name: 拒绝未知扩展名', validateFileName('a.exe', 'c') !== '');
  eq('name: Python 项目 .py 合法', validateFileName('main.py', 'python'), '');
  eq('name: Python 项目 .csv 合法', validateFileName('data.csv', 'python'), '');
  ok('name: Python 项目拒绝 .c', validateFileName('main.c', 'python') !== '');
  ok('name: C 项目拒绝 .py', validateFileName('main.py', 'c') !== '');
}
{
  const { parsePythonDiagnostics } = loadPureFns(['parsePythonDiagnostics']);
  const tb = 'Traceback (most recent call last):\n  File "main.py", line 4, in <module>\n    divide(1, 0)\n  File "util.py", line 2, in divide\n    return a / b\nZeroDivisionError: division by zero';
  const p = parsePythonDiagnostics(tb);
  eq('py-diag: 1 条', p.length, 1);
  eq('py-diag: 最深项目帧文件', p[0].file, 'util.py');
  eq('py-diag: 行号', p[0].line, 2);
  eq('py-diag: 消息', p[0].message, 'ZeroDivisionError: division by zero');
  const syn = parsePythonDiagnostics('  File "main.py", line 1\n    def foo()\n             ^\nSyntaxError: expected \':\'');
  eq('py-diag: 语法错误归为 compile', syn[0] && syn[0].source, 'compile');
  eq('py-diag: 标准库帧不定位', parsePythonDiagnostics('  File "/data/x/prefix/lib/python3.14/json/__init__.py", line 3\nValueError: x').length, 0);
  eq('py-diag: 空输入', parsePythonDiagnostics('').length, 0);
}
{
  const callback = html.match(/window\.projectOpened = function\([^)]*\) \{[\s\S]*?\n\};/)[0];
  const openLanguage = new Function(`
    let project, currentLang, currentFilePath;
    const window = {}, editor = null, pendingDiskSave = false;
    const getLang = id => ({ id });
    const closeCreateProject = () => {}, resetEditorSession = () => {}, saveProject = () => {};
    const updateEditorAvailability = () => {}, showToast = () => {}, document = { getElementById: () => ({}) };
    const projectError = message => { throw new Error(message); };
    ${extractFn('languageForPath')}
    ${callback}
    return loaded => { window.projectOpened(loaded); return project.language; };
  `)();
  eq('project-open: Python 语言不受首个数据文件影响', openLanguage({ language:'python', files:[{path:'config.json'},{path:'main.py'}] }), 'python');
  eq('project-open: 空 Python 项目保留语言', openLanguage({ language:'python', files:[] }), 'python');
  eq('project-open: C++ 语言不受首个数据文件影响', openLanguage({ language:'cpp', files:[{path:'config.json'},{path:'main.cpp'}] }), 'cpp');
  eq('project-open: 没有清单语言时按 .py 推断', openLanguage({ files:[{path:'main.py'}] }), 'python');
  eq('project-open: 未知语言按文件推断', openLanguage({ language:'unknown', files:[{path:'main.cpp'}] }), 'cpp');
}
{
  const languages = html.match(/const LANGUAGES = \[[\s\S]*?\n\];/)[0];
  const helpers = ['projectLang', 'editorModeForPath'].filter(name => new RegExp('function ' + name + '\\(').test(html));
  const source = ['getLang', 'isDataFile', 'docFor', 'swapToEmptyDoc', 'switchProjectFile', 'newProjectFile', 'initEditor', ...helpers].map(extractFn).join('\n');
  const editorHarness = new Function('language', 'path', `
    ${languages}
    const project = { language, files:[{path,code:'sample'}] }, projectDocs = new Map(), state = {};
    let currentFilePath = path, currentLang = language, switchingProjectFile = false, editor, openFiles = [], clangdDiagnosticRequest = 0;
    const isRunning = false, BP_GUTTER = 'bp', editorHint = () => {};
    const getProjectFile = p => project.files.find(file => file.path === p);
    const noop = () => {}, clearTimeout = noop, setTimeout = noop;
    const buildTabs = noop, loadBreakpoints = noop, loadSavedHashes = noop, loadOpenFiles = noop;
    const renderEditorTabs = noop, renderBreakpoints = noop, bindAutoComplete = noop, bindRichCopy = noop, updateEditorAvailability = noop;
    const scheduleLint = noop, persistOpenFiles = noop, updateLangInfo = noop, renderProjectFiles = noop, saveCurrentFile = noop, requestClangdDiagnostics = noop;
    const document = { getElementById: () => ({}) };
    const stub = { getWrapperElement: () => ({addEventListener:noop}), on:noop, setValue:noop, closeHint:noop,
      swapDoc: doc => {state.docMode=doc.mode;}, setOption:(key,value)=>{if(key==='mode')state.optionMode=value;} };
    const CodeMirror = { Doc:(text,mode)=>({text,mode}), fromTextArea:(el,opts)=>{state.initialMode=opts.mode;return stub;} };
    const dogeInput = (title,label,seed) => {state.fileName=seed;};
    ${source}
    return {
      doc: () => docFor(path).mode,
      init: () => {initEditor();return {mode:state.initialMode,language:currentLang};},
      empty: () => {editor=stub;swapToEmptyDoc();return state.docMode;},
      switch: () => {editor=stub;currentFilePath='';switchProjectFile(path);return state.optionMode;},
      fileName: () => {newProjectFile();return state.fileName;}
    };
  `);
  let h = editorHarness('python', 'main.py');
  eq('py-editor: 文档使用 Python mode', h.doc(), 'python');
  eq('py-editor: 冷启动保留 Python mode 和语言', h.init(), {mode:'python',language:'python'});
  eq('py-editor: 无文件时仍使用 Python mode', h.empty(), 'python');
  eq('py-editor: 切换文件使用 Python mode', h.switch(), 'python');
  eq('py-editor: 新建文件默认 main.py', h.fileName(), 'main.py');
  h = editorHarness('cpp', 'main.cpp');
  eq('cpp-editor: C++ mode 保持不变', h.doc(), 'text/x-c++src');
  eq('cpp-editor: 新建文件默认 main.cpp', h.fileName(), 'main.cpp');
  h = editorHarness('python', 'data.csv');
  eq('data-editor: 数据文件不使用代码语法模式', h.doc(), null);
}
{
  const enabled = /function clangdEnabledForFile\(/.test(html) ? extractFn('clangdEnabledForFile') : '';
  const checkLanguageService = new Function('language', 'path', `
    const project={language,files:[{path,code:'sample'}]},currentFilePath=path,currentLang=language;
    let clangdDiagnosticRequest=0, remote=0, scheduled=0, lintTimer=null;
    const clangdProblems={},clangdCompletionCache={},panelView='output';
    const editor={getAllMarks:()=>[],getCursor:()=>({line:0,ch:0})},cm=editor;
    const getLang=id=>({id}),toolchainReady=()=>true,activeBuildProfile=()=>({});
    const completionState=()=>({line:'sample',key:'key',prefix:'sample'}),buildCompletionResult=()=>({list:['local']});
    const requestClangdCompletions=()=>{remote++;return Promise.resolve();};
    const fetch=()=>{remote++;return Promise.resolve({ok:true,json:async()=>({items:[]})});};
    const fetchApi=fetch;
    const updateProblemBadges=()=>{},renderProblems=()=>{},clearTimeout=()=>{},lintDocument=()=>{},setTimeout=()=>{scheduled++;};
    ${extractFn('isDataFile')}
    ${extractFn('projectLang')}
    ${enabled}
    ${extractFn('gatherCompletions')}
    ${extractFn('requestClangdDiagnostics')}
    ${extractFn('clearLocalLintMarks')}
    ${extractFn('scheduleLint')}
    let list;
    gatherCompletions(cm,result=>{list=result.list;});requestClangdDiagnostics();scheduleLint();
    return {remote,scheduled,list};
  `);
  let result = checkLanguageService('python','main.py');
  eq('intel: 已有 C++ 运行库时 Python 不调用 clangd', result.remote, 0);
  eq('intel: Python 保留本地补全候选', result.list, ['local']);
  result = checkLanguageService('python','data.csv');
  eq('intel: 数据文件不调用 clangd', result.remote, 0);
  eq('intel: 数据文件不弹出代码补全', result.list, []);
  eq('intel: 数据文件不运行未定义名检查', result.scheduled, 0);
  result = checkLanguageService('cpp','main.cpp');
  eq('intel: C++ 仍调用 clangd 补全和诊断', result.remote, 2);
}
{
  const { hashText } = loadPureFns(['hashText']);
  eq('hash: 相同内容相同哈希', hashText('int main(){}'), hashText('int main(){}'));
  ok('hash: 不同内容不同哈希', hashText('a') !== hashText('b'));
  eq('hash: 空与 undefined 一致', hashText(''), hashText(undefined));
}
// 面板修复：收起按钮必须是切换，不能写死 setPanelOpen(false)
ok('panel: 收起按钮调用 togglePanel', /id="panelToggle"[^>]*onclick="togglePanel\(\)"/.test(html));
ok('panel: 不再有写死的 setPanelOpen(false) 按钮', !/onclick="setPanelOpen\(false\)"/.test(html));
ok('panel: 点输出标签会展开收起的面板', /function switchOutputTab[\s\S]{0,300}setPanelOpen\(true\)/.test(html));
// stdin 并入输出面板
{
  const panelStart = html.indexOf('id="outputPanel"');
  const panelEnd = html.indexOf('<!-- 状态栏 -->');
  const panelHtml = html.slice(panelStart, panelEnd);
  ok('stdin: 输入框位于输出面板内', panelHtml.includes('id="stdinInput"'));
  // 批次 4 起 stdin 是“输出”视图里的一个分段
  ok('stdin: 面板有 stdin 分段', /data-stream="stdin"/.test(panelHtml));
  ok('stdin: 编辑器列不再含 stdin', !/stdin-section/.test(html));
}
for (const fn of ['renderEditorTabs','closeProjectFile','renameProjectFile','openFileContextMenu','resetEditorSession','docFor','isFileDirty']) {
  ok('fn: 存在 ' + fn, new RegExp('function ' + fn + '\\b').test(html));
}
ok('doc: 切换文件用 swapDoc(独立撤销历史)', /function switchProjectFile[\s\S]{0,900}editor\.swapDoc\(docFor\(path\)\)/.test(html));
ok('bp: 断点按文件路径存储', /breakpoints\[currentFilePath\]/.test(html) && !/breakpoints\[currentLang\]/.test(html));

// 保存回归：驱动真实保存入口和原生回调，覆盖多个保存请求交错的时序。
{
  const callback = html.match(/window\.projectSaveResult = function\([^)]*\) \{[\s\S]*?\n\};/)[0];
  const source = ['hashText', 'dirtyTrackingEnabled', 'isFileDirty', 'snapshotHashes', 'saveProjectToDisk', 'resetEditorSession'].map(extractFn).join('\n');
  const createSaveHarness = new Function(`
    let project = { files: [{ path: 'main.c', code: 'initial' }] };
    let savedHashes = null, pendingDiskSave = false;
    let pendingDiskSaveRequest = null, queuedDiskSaveRequest = null, projectSaveSession = 0;
    let openFiles = [], compileProblems = [];
    const projectDocs = new Map(), clangdProblems = {}, sent = [];
    const window = {}, DogeNative = { saveProject: json => sent.push(JSON.parse(json)) };
    window.DogeNative = DogeNative;
    const getProjectFile = path => project.files.find(file => file.path === path);
    const saveCurrentFile = () => {}, persistSavedHashes = () => {}, persistOpenFiles = () => {};
    const showToast = () => {}, renderEditorTabs = () => {}, renderProjectFiles = () => {}, openProject = () => {};
    ${source}
    ${callback}
    savedHashes = snapshotHashes();
    return {
      sent, save: saveProjectToDisk,
      edit: code => { project.files[0].code = code; },
      complete: (ok, message = '') => window.projectSaveResult(ok, message),
      dirty: () => isFileDirty('main.c'),
      reset: code => { project = { files: [{ path: 'main.c', code }] }; resetEditorSession(true); }
    };
  `);
  let h = createSaveHarness();
  h.edit('A'); h.save(); h.edit('B'); h.save();
  eq('save: 同一时间只向原生发送一个保存请求', h.sent.length, 1);
  h.complete(true);
  ok('save: A 回调不能把尚未保存的 B 标为已保存', h.dirty());
  eq('save: A 完成后发送排队的 B', h.sent.length, 2);
  h.complete(false, '磁盘写入失败');
  ok('save: B 保存失败后仍显示未保存', h.dirty());

  h = createSaveHarness();
  h.edit('A'); h.save(); h.edit('B'); h.save(); h.edit('C');
  h.complete(true);
  eq('save: 排队保存使用点击保存时的 B 快照', h.sent[1].files[0].code, 'B');
  h.complete(true);
  ok('save: B 保存期间输入的 C 仍显示未保存', h.dirty());

  h = createSaveHarness();
  h.edit('A'); h.save(); h.reset('another-project'); h.complete(true);
  ok('save: 旧项目的保存回调不污染新项目基线', !h.dirty());
}

// ── 5e. 两级面板 / 问题模型 / 每流滚动(批次 4) ─────────────────────
{
  const { parseCompilerDiagnostics } = loadPureFns(['parseCompilerDiagnostics']);
  // clang 的真实输出格式：编译目录下的绝对路径 + 严重级别 + 源码行 + 插入符
  const clang = [
    "/data/user/0/com.doge.ide.plus.debug/files/runs/a1/main.c:4:7: warning: unused variable 'unused' [-Wunused-variable]",
    '    4 |   int unused = 3;',
    '      |       ^',
    "/data/user/0/com.doge.ide.plus.debug/files/runs/a1/main.c:5:24: error: too few arguments to function call, expected 2, have 1",
    "/data/user/0/com.doge.ide.plus.debug/files/runs/a1/util.h:1:5: note: 'add' declared here",
    "/data/user/0/com.doge.ide.plus.debug/files/runs/a1/main.c:6:10: error: use of undeclared identifier 'undefined_var'",
    '2 errors generated.'
  ].join('\n');
  const p = parseCompilerDiagnostics(clang);
  eq('diag: 解析出 4 条(警告/错误/提示/错误)', p.length, 4);
  eq('diag: 严重级别', p.map(x => x.severity), ['warning', 'error', 'info', 'error']);
  eq('diag: 行列', p.map(x => x.line + ':' + x.col), ['4:7', '5:24', '1:5', '6:10']);
  ok('diag: 保留原始文件路径(供项目路径映射)', p[0].file.endsWith('/main.c') && p[2].file.endsWith('/util.h'));
  eq('diag: 消息', p[3].message, "use of undeclared identifier 'undefined_var'");
  ok('diag: 忽略源码行、插入符与汇总行', p.every(x => !/^\d+ errors? generated/.test(x.message)));
  eq('diag: fatal error 视为 error', parseCompilerDiagnostics("main.c:1:10: fatal error: 'nope.h' file not found")[0].severity, 'error');
  // wasm-ld 链接错误没有文件位置
  const link = parseCompilerDiagnostics("wasm-ld: error: /data/x/runs/b2/main.c.o: undefined symbol: missing_fn\nclang: error: linker command failed with exit code 1 (use -v to see invocation)");
  eq('diag: 链接错误 1 条(去掉 linker command failed 汇总)', link.length, 1);
  ok('diag: 链接错误无文件、来源为 link', link[0].file === '' && link[0].line === 0 && link[0].source === 'link');
  ok('diag: 链接错误保留 undefined symbol', /undefined symbol: missing_fn/.test(link[0].message));
  eq('diag: 只有汇总行时保留它', parseCompilerDiagnostics('clang: error: linker command failed with exit code 1').length, 1);
  eq('diag: 重复诊断去重', parseCompilerDiagnostics('a.c:1:1: error: x\na.c:1:1: error: x').length, 1);
  eq('diag: 空输入', parseCompilerDiagnostics('').length, 0);
  eq('diag: 运行时输出不算问题', parseCompilerDiagnostics('Segmentation fault\nhello world').length, 0);
}
{
  const { normalizeClangdDiagnostic } = loadPureFns(['normalizeClangdDiagnostic']);
  const d = normalizeClangdDiagnostic({ severity: 2, message: 'unused', range: { start: { line: 3, character: 6 } } }, 'main.c');
  eq('clangd: LSP 0 基转 1 基', d.line + ':' + d.col, '4:7');
  eq('clangd: severity 2 = warning', d.severity, 'warning');
  eq('clangd: severity 1 = error', normalizeClangdDiagnostic({ severity: 1, range: { start: {} } }, 'a.c').severity, 'error');
  eq('clangd: severity 3/4 = info', normalizeClangdDiagnostic({ severity: 4, range: { start: {} } }, 'a.c').severity, 'info');
  eq('clangd: 缺字段不抛错', normalizeClangdDiagnostic({}, 'a.c').line, 1);
}
{
  const { mergeProblems, problemCounts } = loadPureFns(['mergeProblems', 'problemCounts']);
  const a = [{ file: 'main.c', line: 6, severity: 'error', message: 'x' }, { file: 'main.c', line: 4, severity: 'warning', message: 'w' }];
  const b = [{ file: 'main.c', line: 6, severity: 'error', message: 'x' }, { file: 'u.c', line: 1, severity: 'info', message: 'i' }];
  const m = mergeProblems([a, b]);
  eq('merge: 编译与 clangd 同一问题去重', m.length, 3);
  eq('merge: 计数', problemCounts(m), { errors: 1, warnings: 1, infos: 1 });
  eq('merge: 空来源', mergeProblems([[], undefined]).length, 0);
}
// 两级面板结构
ok('panel4: 四个视图容器', ['problemsView', 'outputView', 'tasksView', 'debugView'].every(id => new RegExp('id="' + id + '"').test(html)));
ok('panel4: 视图标签用 data-view', /data-view="problems"/.test(html) && /data-view="output"/.test(html) && /data-view="tasks"/.test(html));
ok('panel4: 输出内四个分段', ['stdin', 'stdout', 'stderr', 'info'].every(s => new RegExp('data-stream="' + s + '"').test(html)));
ok('panel4: 不再有旧的 data-tab 平级标签', !/data-tab="/.test(html));
ok('panel4: 调试控制台随调试开关显示', /data-view="debug"[^>]*hidden/.test(html) && /dbg\.hidden = !debugEnabled\(\)/.test(html));
ok('panel4: switchPanelView 会展开面板', /function switchPanelView[\s\S]{0,200}setPanelOpen\(true\)/.test(html));
ok('panel4: switchStream 会展开面板', /function switchStream[\s\S]{0,200}setPanelOpen\(true\)/.test(html));
ok('panel4: 切换前记住当前流的滚动位置', /function switchStream[\s\S]{0,400}rememberStreamScroll\(\)/.test(html) && /function switchPanelView[\s\S]{0,400}rememberStreamScroll\(\)/.test(html));
ok('panel4: 重绘时按 runId 恢复滚动', /saved\.runId === outputRenderId/.test(html));
ok('panel4: outputRenderId 已声明(修复 clearConsole 的 ReferenceError)', /let outputRenderId = 0;/.test(html));
ok('panel4: Ctrl+L 清空本次问题', /function clearConsole\(\)[\s\S]{0,300}compileProblems = \[\]/.test(html));
ok('panel4: 运行结束解析问题', /function onRunFinished[\s\S]{0,200}parseCompilerDiagnostics\(outputData\.stderr\)/.test(html));
ok('panel4: 编译错误自动切到问题视图', /status === 'compile_error' && compileProblems\.length\) \{ switchPanelView\('problems'\)/.test(html));
ok('panel4: 浏览器与任务两条运行路径都调用 onRunFinished', (html.match(/onRunFinished\(/g) || []).length >= 4);
ok('panel4: clangd 结果写入问题模型', /clangdProblems\[path\] = diagnostics\.map/.test(html));
ok('panel4: 问题条目点击跳行', /closest\('\.prob\[data-file\]'\)[\s\S]{0,120}jumpToDiagnostic/.test(html));
ok('panel4: 状态栏显示错误与警告数', /id="statusErrors"/.test(html) && /id="statusWarnings"/.test(html));
for (const fn of ['switchPanelView', 'switchStream', 'renderProblems', 'collectProblems', 'onRunFinished', 'beginRun', 'syncPanelTabs']) {
  ok('fn: 存在 ' + fn, new RegExp('function ' + fn + '\\b').test(html));
}

// ── 5f. 浮层栈 / 键盘路由 / 对话框 / 项目内搜索(批次 5) ─────────────
const cmdBlock5 = (html.match(/const COMMANDS = \{([\s\S]*?)\n\};/) || [, ''])[1];
// 用真实 COMMANDS 的 key / inEditor / skipInField 构造路由上下文(run/when 用桩)
function commandsFromSource() {
  const cmds = {};
  for (const m of cmdBlock5.matchAll(/'([a-z]+\.[a-zA-Z]+)':\s*\{([^\n]*)\}/g)) {
    const body = m[2];
    const key = (body.match(/key:\s*'([^']+)'/) || [])[1];
    cmds[m[1]] = { key, inEditor: /inEditor: true/.test(body), skipInField: /skipInField: true/.test(body), when: /when:/.test(body) ? () => false : undefined };
  }
  return cmds;
}
{
  const K = loadPureFns(['normalizeKeyName', 'comboString', 'normalizeCombo', 'keyComboOf', 'buildKeyBindings', 'routeKey'],
    (html.match(/const KEY_ALIASES = [^\n]+/) || [''])[0]);
  const commands = commandsFromSource();
  ok('keys: 从 COMMANDS 解析出命令 (' + Object.keys(commands).length + ')', Object.keys(commands).length >= 25);
  const bindings = K.buildKeyBindings(commands);
  // 规范化
  eq('keys: 组合键规范化', K.normalizeCombo('ctrl+shift+p'), 'Ctrl+Shift+P');
  eq('keys: Cmd 视为 Ctrl', K.normalizeCombo('Cmd+Enter'), 'Ctrl+Enter');
  eq('keys: 事件 Shift+= 产生的 + 按 Ctrl+= 处理', K.keyComboOf({ key: '+', ctrlKey: true, shiftKey: true }), 'Ctrl+=');
  eq('keys: 事件 Shift+- 产生的 _ 按 Ctrl+- 处理', K.keyComboOf({ key: '_', ctrlKey: true, shiftKey: true }), 'Ctrl+-');
  eq('keys: 空格键', K.keyComboOf({ key: ' ', ctrlKey: true }), 'Ctrl+Space');
  // 每个 COMMANDS.key 都能被路由命中(菜单/快捷键表写的键与实际生效的键一致)
  for (const [id, c] of Object.entries(commands)) {
    if (!c.key || c.key === 'Esc') continue;
    ok('keys: ' + c.key + ' 路由到 ' + id, bindings.get(K.normalizeCombo(c.key)) === id);
  }
  const ctx = (o = {}) => ({ overlayOpen: false, inField: false, inEditor: false, running: false, ctrlIStdin: true, escConsumed: false, bindings, commands, ...o });
  const ev = (key, o = {}) => ({ key, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, defaultPrevented: false, ...o });
  const r = (e, c) => { const x = K.routeKey(e, c); return x.action + (x.id ? ':' + x.id : ''); };
  // 规则 1：浮层打开只处理 Esc
  eq('route: 浮层打开 Esc 关最上层', r(ev('Escape'), ctx({ overlayOpen: true })), 'closeOverlay');
  eq('route: 浮层打开 Ctrl+Enter 不运行', r(ev('Enter', { ctrlKey: true }), ctx({ overlayOpen: true })), 'none');
  eq('route: 浮层打开 Ctrl+S 放行', r(ev('s', { ctrlKey: true }), ctx({ overlayOpen: true })), 'none');
  eq('route: 浮层打开且运行中 Esc 只关浮层不停止', r(ev('Escape'), ctx({ overlayOpen: true, running: true })), 'closeOverlay');
  // 规则 2：CodeMirror 已处理的键不二次执行
  eq('route: 编辑器已处理的 Ctrl+Space 不重复补全', r(ev(' ', { ctrlKey: true, defaultPrevented: true }), ctx({ inField: true, inEditor: true })), 'none');
  eq('route: 编辑器已处理的 Ctrl+Z 不被抢', r(ev('z', { ctrlKey: true, defaultPrevented: true }), ctx({ inField: true, inEditor: true })), 'none');
  eq('route: 编辑器已处理的 Ctrl+F 不重复打开', r(ev('f', { ctrlKey: true, defaultPrevented: true }), ctx({ inField: true, inEditor: true })), 'none');
  eq('route: Ctrl+Z 没有绑定命令', r(ev('z', { ctrlKey: true }), ctx()), 'none');
  // CodeMirror 对所有 Esc 都 preventDefault，Esc 不能按 defaultPrevented 丢弃
  eq('route: 编辑器里运行中 Esc(已 preventDefault)仍停止', r(ev('Escape', { defaultPrevented: true }), ctx({ inField: true, inEditor: true, running: true })), 'cancelRun');
  eq('route: 关闭补全列表的 Esc 不停止运行', r(ev('Escape', { defaultPrevented: true }), ctx({ inField: true, inEditor: true, running: true, escConsumed: true })), 'none');
  eq('route: 关闭命令面板的 Esc 不再关下一层', r(ev('Escape'), ctx({ overlayOpen: true, escConsumed: true })), 'none');
  // 规则 3：单键命令在输入控件里不触发
  eq('route: 文件树里 F2 重命名', r(ev('F2'), ctx()), 'command:file.renameFile');
  eq('route: 编辑器里 F2 重命名(inEditor)', r(ev('F2'), ctx({ inField: true, inEditor: true })), 'command:file.renameFile');
  eq('route: 搜索框里 F2 不重命名', r(ev('F2'), ctx({ inField: true })), 'none');
  eq('route: 调试关闭时 F5 无动作', r(ev('F5'), ctx()), 'none');
  eq('route: 组合键在输入框里照常生效', r(ev('s', { ctrlKey: true }), ctx({ inField: true })), 'command:file.save');
  eq('route: 编辑器外输入框的 Ctrl+Space 让给输入法', r(ev(' ', { ctrlKey: true }), ctx({ inField: true })), 'none');
  eq('route: 编辑器外输入框的 Ctrl+F 不开编辑器查找', r(ev('f', { ctrlKey: true }), ctx({ inField: true })), 'none');
  eq('route: 文件树里 Ctrl+F 打开编辑器查找', r(ev('f', { ctrlKey: true }), ctx()), 'command:edit.find');
  // 规则 4：Esc 无浮层时只在运行中取消
  eq('route: 空闲时 Esc 无动作', r(ev('Escape'), ctx()), 'none');
  eq('route: 运行中 Esc 停止', r(ev('Escape'), ctx({ running: true })), 'cancelRun');
  // 规则 5：Ctrl+I 可关闭
  eq('route: Ctrl+I 切换 stdin', r(ev('i', { ctrlKey: true }), ctx()), 'command:view.stdin');
  eq('route: Ctrl+I 关闭后放行给输入法', r(ev('i', { ctrlKey: true }), ctx({ ctrlIStdin: false })), 'none');
  // 输入法组字
  eq('route: 输入法组字中不处理', r(ev('Enter', { ctrlKey: true, isComposing: true }), ctx()), 'none');
  eq('route: keyCode 229 不处理', r(ev('Process', { keyCode: 229 }), ctx()), 'none');
  // 常用组合
  eq('route: Ctrl+Enter 运行', r(ev('Enter', { ctrlKey: true }), ctx({ inField: true, inEditor: true })), 'command:run.run');
  eq('route: Ctrl+Shift+P 命令面板', r(ev('P', { ctrlKey: true, shiftKey: true }), ctx()), 'command:help.palette');
  eq('route: Ctrl+Shift+F 项目搜索', r(ev('F', { ctrlKey: true, shiftKey: true }), ctx()), 'command:view.search');
  eq('route: Ctrl+Shift+N 新建项目(不是新建文件)', r(ev('N', { ctrlKey: true, shiftKey: true }), ctx()), 'command:file.newProject');
  eq('route: Ctrl+N 新建文件', r(ev('n', { ctrlKey: true }), ctx()), 'command:file.newFile');
  eq('route: Cmd+S 等同 Ctrl+S', r(ev('s', { metaKey: true }), ctx()), 'command:file.save');
  eq('route: Ctrl+Shift+= 放大字号', r(ev('+', { ctrlKey: true, shiftKey: true }), ctx()), 'command:view.fontUp');
  eq('route: Alt+S 不等于 Ctrl+S', r(ev('s', { altKey: true }), ctx()), 'none');
}
// 键盘路由接线：只有一个分发入口，走 routeKey
ok('keys: initKeybindings 调用 routeKey', /function initKeybindings\(\)[\s\S]{0,900}routeKey\(e, ctx\)/.test(html));
ok('keys: 不再手写 Ctrl 组合判断', !/if \(mod && e\.shiftKey && k === 'p'\)/.test(html));
ok('keys: CodeMirror 的 Shift-Ctrl-F 让给项目搜索', /'Shift-Ctrl-F': \(\) => openProjectSearch\(\)/.test(html));
ok('keys: CodeMirror 绑定 Ctrl-H 替换', /'Ctrl-H': 'replace'/.test(html));
ok('keys: 设置里有 Ctrl+I 开关', /id="ctrlIStdinInput"/.test(html) && /setSetting\('ctrlIStdin'/.test(html));
// 快捷键表由 COMMANDS 生成
{
  const { buildShortcutGroups } = loadPureFns(['buildShortcutGroups']);
  const cmds = { 'a.x': { label: 'X', key: 'Ctrl+X' }, 'a.y': { label: 'Y' }, 'b.z': { label: 'Z', key: 'F9', when: 1 }, 'c.w': { label: 'W', key: 'Ctrl+W' } };
  const g = buildShortcutGroups([{ label: 'A', items: ['a.x', '-', 'a.y'] }, { label: 'B', items: ['b.z', 'a.x'] }], cmds, id => id !== 'b.z');
  eq('shortcuts: 按菜单分组，跳过无快捷键与不可用命令', g.map(x => x.label + ':' + x.rows.map(r => r.id).join(',')), ['A:a.x', '其它:c.w']);
}
ok('shortcuts: 不再有手写英文快捷键行', !/Keyboard Shortcuts/.test(html) && !/<div class="shortcut-row"><span>Run code/.test(html));
ok('shortcuts: 由 buildShortcutGroups 渲染', /function openShortcuts\(\)[\s\S]{0,300}buildShortcutGroups\(MENUS, COMMANDS, cmdAvailable\)/.test(html));
// 浮层栈
for (const fn of ['pushOverlay', 'popOverlay', 'openModal', 'hideModal', 'closeTopOverlay', 'overlayOpen', 'focusableIn', 'openSettings', 'closeSettings', 'openAbout', 'openShortcuts', 'editorSearch', 'openProjectSearch', 'runProjectSearch', 'toggleSideView', 'routeKey']) {
  ok('fn: 存在 ' + fn, new RegExp('function ' + fn + '\\b').test(html));
}
ok('overlay: 设置改为居中对话框', /class="modal-overlay" id="settingsModal"/.test(html) && !/class="settings-panel"/.test(html));
ok('overlay: 设置输入框 id 不变', ['timeoutInput', 'codeSizeInput', 'themeInput', 'optimizationInput', 'definesInput', 'includesInput', 'librariesInput', 'dependenciesInput', 'toolchainHint'].every(id => html.includes('id="' + id + '"')));
for (const id of ['projectCreateModal', 'settingsModal', 'shortcutModal']) {
  const m = html.match(new RegExp('id="' + id + '">\\s*<div class="modal[^"]*"([^>]*)>'));
  ok('overlay: #' + id + ' 有 dialog 语义与标题', !!m && /role="dialog"/.test(m[1]) && /aria-modal="true"/.test(m[1]) && /aria-labelledby="/.test(m[1]));
}
ok('overlay: 动态弹窗入栈', /function openDynamicDialog[\s\S]{0,700}pushOverlay\(overlay, close\)/.test(html));
ok('overlay: 关闭后焦点归还', /function popOverlay[\s\S]{0,500}prev\.focus/.test(html));
ok('overlay: Tab 在最上层循环', /event\.key !== 'Tab'[\s\S]{0,600}first\.focus\(\)/.test(html));
ok('overlay: 焦点移出时拉回', /addEventListener\('focusin'/.test(html));
ok('overlay: 导入进度不被 Esc 关掉(停滞时等同后台继续)', /importProgressShown\(\)\) \{[\s\S]{0,200}dismissImportProgress\(\)/.test(html));
ok('overlay: 新建项目接入浮层栈', /function showCreateProject\(\)[\s\S]{0,120}openModal\('projectCreateModal'/.test(html));
ok('overlay: 打开对话框先关下拉/命令面板', /function pushOverlay[\s\S]{0,60}closeLayer\(\)/.test(html));
// 关于 / 版本号
{
  const gradle = readFileSync(join(root, 'android/app/build.gradle'), 'utf8');
  const vn = (gradle.match(/versionName '([^']+)'/) || [])[1];
  const av = (html.match(/const APP_VERSION = '([^']+)'/) || [])[1];
  eq('about: APP_VERSION 与 build.gradle versionName 一致', av, vn);
  ok('about: 状态栏版本打开关于', /id="statusVersion" onclick="openAbout\(\)"/.test(html));
}
// 编辑器查找替换(CodeMirror 5.65.18 search/dialog addon，离线文件)
for (const f of ['addon/search/search.min.js', 'addon/search/searchcursor.min.js', 'addon/dialog/dialog.min.js', 'addon/dialog/dialog.min.css']) {
  let exists = false; try { exists = readFileSync(join(root, 'web/codemirror', f)).length > 0; } catch (e) {}
  ok('search-addon: 存在 ' + f, exists);
  ok('search-addon: 页面引用 ' + f, html.includes('web/codemirror/' + f));
}
ok('search-addon: searchcursor 在 search 之前加载', html.indexOf('addon/search/searchcursor.min.js') < html.indexOf('addon/search/search.min.js"') && html.indexOf('addon/dialog/dialog.min.js') < html.indexOf('addon/search/search.min.js"'));
ok('search-addon: 对话框文案中文化', /phrases: \{ 'Search:': '查找：'/.test(html));
ok('search-addon: 菜单有查找/替换', /items: \['edit\.find','edit\.replace'/.test(html));
// 项目内搜索
{
  const S = loadPureFns(['escapeRegExp', 'buildSearchRegex', 'searchProjectFiles', 'searchHitPreview'],
    (html.match(/const SEARCH_MAX_RESULTS = [^\n]+/) || [''])[0]);
  const files = [
    { path: 'src/util.c', code: 'int add(int a, int b) {\n  return a + b; // ADD\n}\n' },
    { path: 'main.c', code: '#include "util.h"\nint main(void) {\n  int added = add(1, 2);\n  printf("%d\\n", added);\r\n}\n' },
    { path: 'util.h', code: 'int add(int a, int b);\n' }
  ];
  const r = S.searchProjectFiles(files, 'add', {});
  eq('search: 不区分大小写的总数', r.total, 6);
  eq('search: 按路径排序', r.results.map(x => x.path), ['main.c', 'src/util.c', 'util.h']);
  // 第 4 行是  printf("%d\n", added);（\n 为源码里的两个字符），added 从第 17 列开始
  eq('search: 行号 1 基、列 0 基', r.results[0].matches.map(m => m.line + ':' + m.col), ['3:6', '3:14', '4:17']);
  eq('search: 行文本去掉 \\r', r.results[0].matches[2].text.endsWith('\r'), false);
  eq('search: 区分大小写', S.searchProjectFiles(files, 'ADD', { caseSensitive: true }).total, 1);
  // add( ×3 + 注释里的 ADD（不区分大小写）；added 不算
  eq('search: 全字匹配', S.searchProjectFiles(files, 'add', { wholeWord: true }).total, 4);
  eq('search: 全字匹配非单词字符查询', S.searchProjectFiles(files, '->', { wholeWord: true }).total, 0);
  eq('search: 字面量转义', S.searchProjectFiles(files, 'a + b', {}).total, 1);
  eq('search: 正则', S.searchProjectFiles(files, 'int \\w+\\(', { regex: true }).total, 3);
  ok('search: 无效正则给出错误', /正则表达式无效/.test(S.searchProjectFiles(files, '(', { regex: true }).error));
  eq('search: 零宽正则不死循环', S.searchProjectFiles(files, '^', { regex: true }).total, 0);
  eq('search: 空查询', S.searchProjectFiles(files, '', {}).total, 0);
  const capped = S.searchProjectFiles([{ path: 'a.c', code: 'x'.repeat(50) }], 'x', {}, 10);
  ok('search: 超过上限截断', capped.total === 10 && capped.truncated);
  eq('search: 缺 code 不抛错', S.searchProjectFiles([{ path: 'a.c' }, null], 'x', {}).total, 0);
  const p = S.searchHitPreview('        return a + b;', 17, 1);
  eq('search: 预览去掉缩进', p.before + '[' + p.match + ']' + p.after, 'return a [+] b;');
  const far = S.searchHitPreview('x'.repeat(80) + 'hit', 80, 3);
  ok('search: 靠右的匹配截掉前面', far.before.startsWith('…') && far.before.length === 25 && far.match === 'hit');
}
ok('search: 活动栏有搜索入口', /id: 'search', label: '在项目中搜索', key: 'Ctrl\+Shift\+F', run: \(\) => toggleSideView\('search'\)/.test(html));
ok('search: 结果点击跳到对应位置', /closest\('\.sr-hit'\)[\s\S]{0,120}openSearchHit\(/.test(html) && /function openSearchHit[\s\S]{0,700}editor\.setSelection\(from, to\)/.test(html));
ok('search: 编辑时刷新结果', /scheduleDirtyRefresh\(\);\n\s+scheduleSearchRefresh\(\);/.test(html));
ok('search: 搜索视图结构', ['searchView', 'searchInput', 'searchResults', 'searchSummary'].every(id => html.includes('id="' + id + '"')));

// ── 5h. 输入时自动补全(1.1.1) ─────────────────────────────────────
{
  const { autoCompleteTrigger } = loadPureFns(['autoCompleteTrigger']);
  const t = (b, a = '', ty = null) => autoCompleteTrigger(b, a, ty);
  eq('ac: 一个字母不弹', t('  p'), null);
  eq('ac: 两个字母弹', t('  pr'), 'word');
  eq('ac: 标识符含数字下划线', t('x = my_v2'), 'word');
  eq('ac: 空行不弹', t('    '), null);
  eq('ac: 空格后不弹', t('int '), null);
  eq('ac: 数字字面量 0xff 不弹', t('x = 0xff'), null);
  eq('ac: 数字字面量 1e10 不弹', t('x = 1e10'), null);
  eq('ac: 注释里不弹', t('// print', '', 'comment'), null);
  eq('ac: 字符串里不弹', t('printf("hel', '', 'string'), null);
  eq('ac: 在词中间改字不弹', t('pri', 'ntf'), null);
  eq('ac: 后面是括号可以弹', t('pri', '()'), 'word');
  eq('ac: 成员 .', t('p.'), 'member');
  eq('ac: 成员 ->', t('node->'), 'member');
  eq('ac: 成员 -> 后继续输入', t('node->ne'), 'member');
  eq('ac: 调用结果后的 .', t('get().'), 'member');
  eq('ac: 下标后的 .', t('a[0].'), 'member');
  eq('ac: 作用域 ::', t('std::'), 'member');
  eq('ac: 作用域 :: 后一个字母', t('std::v'), 'member');
  eq('ac: 浮点数 1. 不弹', t('x = 1.'), null);
  eq('ac: 减号大于号不是 ->', t('a - >'), null);
  eq('ac: #include <', t('#include <'), 'include');
  eq('ac: #include <st', t('#include <st', '', 'string'), 'include');
  eq('ac: #include "', t('#include "'), 'include');
  eq('ac: # 预处理指令', t('#'), 'preproc');
  eq('ac: #inc', t('  #inc'), 'preproc');
  eq('ac: 空参数', autoCompleteTrigger(undefined, undefined, undefined), null);
}
{
  // 本地成员补全：光标所在的半个词不算候选；-> 与 . 都识别
  const src = extractFn('dogeCompletions');
  const make = (text, line, ch) => {
    const lines = text.split('\n');
    const cm = {
      getCursor: () => ({ line, ch }), getLine: (n) => lines[n], getValue: () => text,
      indexFromPos: (p) => lines.slice(0, p.line).reduce((a, l) => a + l.length + 1, 0) + p.ch
    };
    const CodeMirror = { Pos: (l, c) => ({ line: l, ch: c }) };
    const fn = new Function('CodeMirror', 'COMPLETE_WORDS', 'MODULE_MEMBERS', 'currentLang', 'projectHeaderSymbols', 'renderCompletionItem', src + '\nreturn dogeCompletions;')(CodeMirror, { c: ['printf', 'puts'], cpp: [] }, { c: {} }, 'c', () => [], null);
    return fn(cm);
  };
  const doc = 'struct P { int xpos; int ypos; };\nstruct P p; p.xpos = 1; p.ypos = 2;\nstruct P *q = &p;\nq->y';
  eq('member: q->y 候选不含半个词 y', make(doc, 3, 4).list, ['ypos']);
  eq('member: q-> 退而用文档里的成员', make(doc.replace(/y$/, ''), 3, 3).list, ['xpos', 'ypos']);
  eq('member: p.x 用 p 自己用过的成员', make(doc.replace(/q->y$/, 'p.x'), 3, 3).list, ['xpos']);
  eq('member: get(). 调用结果后的成员', make('s.len = 1;\nget().', 1, 6).list, ['len']);
}
{
  const { normalizeClangdCompletionItems } = loadPureFns(['normalizeClangdCompletionItems']);
  const r = normalizeClangdCompletionItems({ isIncomplete: false, items: [
    { label: ' printf(const char *restrict format, ...)', insertText: 'printf', detail: 'int', sortText: '2' },
    { label: '•puts(const char *s)', textEdit: { newText: 'puts', range: {} }, detail: 'int', sortText: '1' },
    { label: 'snippet', insertText: 'for(${1:i})', insertTextFormat: 2, sortText: '3' },
    { label: 'dup', insertText: 'printf', sortText: '4' },
    { label: 'noinsert', sortText: '5' },
    { label: '', insertText: '' },
    null
  ] });
  eq('clangd-ac: 按 sortText 排序', r.map(x => x.text), ['puts', 'printf', 'noinsert']);
  eq('clangd-ac: 插入 textEdit.newText / insertText 而不是 label', r[1].text, 'printf');
  eq('clangd-ac: 显示 label（去掉前导空格与 •）', [r[0].displayText, r[1].displayText], ['puts(const char *s)', 'printf(const char *restrict format, ...)']);
  eq('clangd-ac: 保留 detail', r[0].detail, 'int');
  eq('clangd-ac: 含空白的片段丢弃、重复去重', r.length, 3);
  eq('clangd-ac: 数组形式', normalizeClangdCompletionItems([{ label: 'abc' }, 'xyz']).map(x => x.text), ['abc', 'xyz']);
  eq('clangd-ac: 片段占位符去掉后是名字就保留', normalizeClangdCompletionItems({ items: [{ label: 'x', insertText: 'count${1}', insertTextFormat: 2 }] }).map(x => x.text), ['count']);
  eq('clangd-ac: 空 / 非法', [normalizeClangdCompletionItems({}).length, normalizeClangdCompletionItems(null).length, normalizeClangdCompletionItems({ items: 'x' }).length], [0, 0, 0]);
}
{
  const { rankCompletions } = loadPureFns(['isSubsequence', 'rankCompletions'], 'const COMPLETION_LIMIT = 80;');
  eq('rank: 区分大小写前缀优先，再不区分大小写，再子序列', rankCompletions(['Print', 'sprintf', 'printf', 'print'], 'pr'), ['printf', 'print', 'Print', 'sprintf']);
  eq('rank: 不匹配的去掉', rankCompletions(['alpha', 'beta'], 'pr'), []);
  eq('rank: 子序列排在前缀后面', rankCompletions(['strcpy', 'scanf'], 'sc'), ['scanf', 'strcpy']);
  eq('rank: 去掉与前缀完全相同的项', rankCompletions(['main', 'mainLoop'], 'main'), ['mainLoop']);
  eq('rank: 对象项按 text 去重', rankCompletions([{ text: 'abs' }, { text: 'abs' }, 'abort'], 'ab').length, 2);
  eq('rank: 空前缀保留原顺序', rankCompletions(['b', 'a'], ''), ['b', 'a']);
  eq('rank: 数量上限', rankCompletions(Array.from({ length: 200 }, (_, i) => 'v' + i), 'v').length, 80);
}
ok('ac: 移除工具栏补全按钮', !/id="completeBtn"/.test(html) && !/\.editor-tool\{/.test(html));
ok('ac: 手动补全不受开关限制', /function triggerCompletion\(\)[\s\S]{0,200}openCompletion\(editor, true\)/.test(html));
ok('ac: 列表打开期间随输入刷新(异步 hint)', /editorHint\.async = true;/.test(html) && /hintOptions: \{ hint: editorHint/.test(html));
ok('ac: 点候选不让编辑器失焦(平板不收键盘)', /closest\('\.CodeMirror-hints'\)\) e\.preventDefault\(\)/.test(html));
ok('ac: 编辑菜单有自动补全开关', /'edit\.autoComplete': \{ label: '输入时自动补全', checked:/.test(html) && /'edit\.complete','edit\.autoComplete'\]/.test(html));
ok('ac: clangd 结果按词缓存', /const clangdCompletionCache = /.test(html) && /s\.prefix\.startsWith\(c\.prefix\)/.test(html));
ok('ac: clangd 请求带超时', /fetchJsonWithTimeout\('\/api\/v1\/intel\/completion'/.test(html));
ok('ac: Esc 只在补全列表可见时算被用掉', /before = \{ hint: !!\(cs && cs\.widget\)/.test(html));

// ── 5i. 项目头文件(1.1.2) ─────────────────────────────────────────
{
  const H = loadPureFns(['dirnameOf', 'normalizeProjectPath', 'isHeaderPath', 'projectIncludeDirs', 'resolveProjectInclude', 'projectHeaderChoices']);
  const files = ['main.c', 'util.h', 'src/app.c', 'src/app.h', 'include/lib.h', 'include/sub/deep.h', 'notes.txt'];
  eq('inc: 规范化 ./ 与 ..', [H.normalizeProjectPath('./a/./b.h'), H.normalizeProjectPath('src/../util.h'), H.normalizeProjectPath('../x.h')], ['a/b.h', 'util.h', null]);
  eq('inc: 同目录优先', H.resolveProjectInclude('app.h', 'src/app.c', files), 'src/app.h');
  eq('inc: 子目录源文件找项目根的头文件', H.resolveProjectInclude('util.h', 'src/app.c', files), 'util.h');
  eq('inc: 相对上级目录', H.resolveProjectInclude('../util.h', 'src/app.c', files), 'util.h');
  eq('inc: 带目录写法', H.resolveProjectInclude('include/lib.h', 'main.c', files), 'include/lib.h');
  eq('inc: 构建配置 include 路径', H.resolveProjectInclude('lib.h', 'main.c', files, ['include']), 'include/lib.h');
  eq('inc: include 路径带 ./ 和末尾 /', H.resolveProjectInclude('sub/deep.h', 'main.c', files, ['./include/']), 'include/sub/deep.h');
  eq('inc: 不在查找路径里找不到', H.resolveProjectInclude('lib.h', 'main.c', files), null);
  eq('inc: 越出项目根找不到', H.resolveProjectInclude('../../etc/x.h', 'src/app.c', files), null);
  eq('inc: 可选头文件（main.c）', H.projectHeaderChoices('main.c', files), ['util.h', 'include/lib.h', 'src/app.h', 'include/sub/deep.h']);
  eq('inc: 可选头文件（src/app.c，同目录的写法在前）', H.projectHeaderChoices('src/app.c', files).slice(0, 2), ['app.h', 'util.h']);
  eq('inc: 可选头文件含 include 路径下的短写法', H.projectHeaderChoices('main.c', files, ['include']).slice(0, 3), ['lib.h', 'util.h', 'include/lib.h']);
  ok('inc: 非头文件不列出', !H.projectHeaderChoices('main.c', files).some(x => x.endsWith('.txt') || x.endsWith('.c')));
}
{
  const { extractHeaderSymbols } = loadPureFns(['stripCommentsAndStrings', 'extractHeaderSymbols'], (html.match(/const C_DECL_SKIP = [^\n]+/) || [''])[0]);
  const hdr = [
    '#ifndef UTIL_H', '#define UTIL_H', '#include <stdio.h>',
    '#define MAX_ITEMS 64', '#define SQUARE(x) ((x) * (x))',
    '/* int commented_out(void); */', '// void also_commented(int);',
    'typedef struct Point { int x; int y; } Point;',
    'struct Node { int value; struct Node *next; };',
    'typedef enum { RED, GREEN = 2, BLUE } Color;',
    'typedef int (*compare_fn)(const void *, const void *);',
    'typedef unsigned long u64;',
    'extern int global_count;',
    'int add_numbers(int a, int b);',
    'const char *greet(const char *name);',
    'static inline int clamp(int v, int lo, int hi) { if (v < lo) return lo; return v > hi ? hi : v; }',
    'void log_msg(const char *fmt, ...);',
    'const char *label = "not_a_function(int x);";',
    '#endif'
  ].join('\n');
  const syms = extractHeaderSymbols(hdr);
  const by = (k) => syms.filter(s => s.kind === k).map(s => s.name).sort();
  eq('hdr: 函数', by('function'), ['add_numbers', 'clamp', 'greet', 'log_msg']);
  eq('hdr: 宏（去掉 include guard）', by('macro'), ['MAX_ITEMS', 'SQUARE']);
  eq('hdr: 类型', by('type'), ['Color', 'Node', 'Point', 'compare_fn', 'u64']);
  eq('hdr: 枚举常量', by('enum'), ['BLUE', 'GREEN', 'RED']);
  eq('hdr: 结构体成员', by('field'), ['next', 'value', 'x', 'y']);
  eq('hdr: extern 变量', by('variable'), ['global_count']);
  ok('hdr: 注释和字符串里的不算', !syms.some(s => /commented|not_a_function/.test(s.name)));
  ok('hdr: 函数带签名说明', /int add_numbers\(int a, int b\)/.test(syms.find(s => s.name === 'add_numbers').detail));
  eq('hdr: 函数体内的 return 不算函数', syms.some(s => s.name === 'lo' || s.name === 'hi'), false);
  eq('hdr: 空', extractHeaderSymbols('').length, 0);
  const cpp = extractHeaderSymbols('namespace geo {\nclass Shape { public: virtual double area() const; };\n}\nint top_level(int);');
  ok('hdr: C++ class 名', cpp.some(s => s.name === 'Shape' && s.kind === 'type'));
  ok('hdr: 顶层函数', cpp.some(s => s.name === 'top_level'));
  // 真实风格：链表（C）与命名空间 / 模板 / std 返回类型（C++）
  const list = extractHeaderSymbols('#pragma once\n#include <stddef.h>\ntypedef struct list_node {\n  void *data;\n  struct list_node *prev, *next;\n} list_node_t;\ntypedef struct { list_node_t *head; size_t size; } list_t;\nlist_t *list_create(void);\nvoid list_destroy(list_t *list, void (*free_fn)(void *));\nint list_push_back(list_t *list, void *data);\nsize_t list_size(const list_t *list);\n#define LIST_FOREACH(l, it) for (list_node_t *it = (l)->head; it; it = it->next)');
  eq('hdr-real: 链表函数', list.filter(s => s.kind === 'function').map(s => s.name), ['list_create', 'list_destroy', 'list_push_back', 'list_size']);
  eq('hdr-real: 链表类型', list.filter(s => s.kind === 'type').map(s => s.name), ['list_node', 'list_node_t', 'list_t']);
  eq('hdr-real: 同一行多个成员', list.filter(s => s.kind === 'field').map(s => s.name), ['data', 'prev', 'next', 'head', 'size']);
  eq('hdr-real: 返回指针的签名', list.find(s => s.name === 'list_create').detail, 'list_t *list_create(void)');
  const shape = extractHeaderSymbols('#pragma once\n#include <string>\nnamespace geo {\nstruct Vec2 { double x, y; };\nclass Shape {\npublic:\n  virtual ~Shape() = default;\n  virtual double area() const = 0;\n};\nstd::vector<Vec2> make_polygon(int sides, double radius);\nstd::string describe(const Shape &s);\ntemplate <typename T> T clamp_value(T v, T lo, T hi);\n}\nunsigned int hash_bytes(const unsigned char *p, unsigned long n);');
  eq('hdr-real: 命名空间里的函数 / 模板 / std 返回类型', shape.filter(s => s.kind === 'function').map(s => s.name), ['make_polygon', 'describe', 'clamp_value', 'hash_bytes']);
  eq('hdr-real: std 模板返回类型签名', shape.find(s => s.name === 'make_polygon').detail, 'std::vector<Vec2> make_polygon(int sides, double radius)');
  ok('hdr-real: 类成员函数不当成全局函数', !shape.some(s => s.name === 'area' && s.kind === 'function'));
}
{
  const R = loadPureFns(['dirnameOf', 'normalizeProjectPath', 'projectIncludeDirs', 'resolveProjectInclude', 'reachableProjectHeaders']);
  const code = { 'main.c': '#include "a.h"\n#include <stdio.h>\n// #include "commented.h"\n#include "missing.h"', 'a.h': '#include "b.h"', 'b.h': '#include "a.h"\nint b(void);', 'commented.h': '' };
  const paths = Object.keys(code);
  const r = R.reachableProjectHeaders('main.c', p => code[p], paths);
  eq('reach: 递归收集并防环', r, ['a.h', 'b.h']);
}
ok('hdr: 普通候选合并项目头文件符号', /for \(const s of projectHeaderSymbols\(\)\)/.test(html) && /headerItems\.concat\(list\)/.test(html));
ok('hdr: #include " 列出项目头文件', /projectHeaderChoices\(currentFilePath, project\.files\.map\(f => f\.path\), buildIncludePaths\(\)\)/.test(html));
ok('hdr: 本地未定义名检查认得头文件符号', /for \(const s of projectHeaderSymbols\(\)\) known\.add\(s\.name\)/.test(html));
ok('hdr: 补全与诊断请求都带构建配置', (html.match(/code:\s?f(?:ile)?\.code \}\)\), build: activeBuildProfile\(\) \};/g) || []).length >= 2);
{
  const clangd = readFileSync(join(root, 'android/app/src/main/java/com/doge/ide/ClangdService.java'), 'utf8');
  const compiler = readFileSync(join(root, 'android/app/src/main/java/com/doge/ide/LocalCompiler.java'), 'utf8');
  ok('hdr: clangd 编译参数加项目根 -iquote', /\.put\("-iquote"\)\.put\(root\.getAbsolutePath\(\)\)/.test(clangd));
  ok('hdr: clangd 编译参数加 include_paths 与宏', /optJSONArray\("include_paths"\)/.test(clangd) && /args\.put\("-D"\+d\)/.test(clangd));
  ok('hdr: clangd 参数变了就重启', /if \(!json\.equals\(old\)\)[\s\S]{0,160}destroyProcess\(\)/.test(clangd));
  ok('hdr: 真实编译也加项目根 -iquote', /command\.add\("-iquote"\); command\.add\(work\.getAbsolutePath\(\)\);/.test(compiler));
}
// Tab 接受补全
ok('tab: 捕获阶段拦截 Tab 接受候选', /input\.addEventListener\('keydown', \(e\) => \{\s*if \(e\.key !== 'Tab'[\s\S]{0,600}acceptCompletion\(editor\);\s*\}, true\);/.test(html));
ok('tab: 输入法组字中的 Tab 等提交后再接受', /addEventListener\('compositionend'[\s\S]{0,200}tabDuringCompose/.test(html));
ok('tab: 输入法把 \\t 当文字送来也接受', /editor\.on\('beforeChange'[\s\S]{0,500}change\.cancel\(\)/.test(html));
ok('tab: 没有列表时 Tab 照常缩进', /function acceptCompletion\(cm\) \{\s*if \(!hintWidgetOpen\(cm\)\) return false;/.test(html));

// ── 5g. 响应式 / 触控 / 收尾(批次 6) ────────────────────────────────
ok('b6: 默认主题为现代(早期脚本)', /\? __t : 'modern';/.test(html) && /dataset\.theme = 'modern'; \}/.test(html));
ok('b6: 默认主题为现代(currentTheme/applyTheme)', /getSetting\('theme', 'modern'\)/.test(html) && /theme : 'modern';/.test(html) && !/getSetting\('theme', 'classic'\)/.test(html));
ok('b6: 经典主题仍可选', /<option value="classic">/.test(html) && /THEMES = \['classic', 'modern'\]/.test(html));
{
  const gradle = readFileSync(join(root, 'android/app/build.gradle'), 'utf8');
  ok('b6: versionCode ≥ 4', Number((gradle.match(/versionCode (\d+)/) || [])[1]) >= 4);
  ok('b6: versionName 1.1.x', /versionName '1\.1\.\d+'/.test(gradle));
  ok('b6: 页面里不再有 1.0.2 版本文案', !/Doge IDE\+ 1\.0\.2/.test(html) && !/APP_VERSION = '1\.0\.2'/.test(html));
}
ok('b6: 窄屏覆盖层遮罩', /id="explorerScrim"/.test(html) && /\.explorer:not\(\[hidden\]\)~\.explorer-scrim\{display:block/.test(html));
ok('b6: 窄屏选文件后收起', /switchProjectFile\(f\.path\); closeExplorerOverlay\(\);/.test(html));
ok('b6: Esc 收起窄屏覆盖层', /ctx\.overlayOpen \|\| ctx\.explorerOverlay/.test(html) && /if \(explorerOverlayOpen\(\)\) \{ closeExplorerOverlay\(\); return true; \}/.test(html));
ok('b6: 窄屏开关不写宽屏偏好', /if \(!isNarrowLayout\(\)\) \{ try \{ localStorage\.setItem\('doge-ide-explorer-visible'/.test(html));
ok('b6: 菜单栏窄屏只滚动菜单', /\.menu-list\{flex:0 1 auto;min-width:0;overflow-x:auto/.test(html) && !/\.menubar\{overflow-x:auto/.test(html));
ok('b6: 底部面板不再带旧 .output-panel(40% 宽)', !/class="output-panel/.test(html) && !/\.output-panel\{/.test(html));
ok('b6: kb-panel 时面板占满工作台', /body\.kb-open\.kb-panel \.workbench\{grid-template-rows:0 0 minmax\(0,1fr\)\}/.test(html));
ok('b6: 键盘收起后复位布局滚动', /if \(wasOpen && !open\) resetLayoutScroll\(\)/.test(html));
ok('b6: 触控下扩大把手可拖区域', /\.vsplit\{width:20px;margin-inline:-10px\}/.test(html));
ok('b6: prefers-reduced-motion 保留', /@media \(prefers-reduced-motion:reduce\)/.test(html));
ok('b6: dogeInput 不用内联样式', !/input\.style\.cssText/.test(html) && /input\.className = 'dialog-input'/.test(html));
// 死代码已删除
for (const fn of ['toggleProjectPanel', 'toggleExplorer', 'initResize', 'toggleSettings', 'defaultProjectFiles', 'storageKey', 'saveCode', 'getSavedCode', 'loadSavedState', 'saveCurrentLang']) {
  ok('b6: 已删除废弃函数 ' + fn, !new RegExp('function ' + fn + '\\s*\\(').test(html) && !new RegExp('\\b' + fn + '\\(').test(html));
}
for (const sel of ['.header{', '.logo{', '.main{', '.project-panel{', '.project-head{', '.project-actions{', '.project-resize{', '.project-toggle{', '.editor-panel{', '.tab{', '.packs-toggle{', '.output-header{', '.output-tab{', '.resize-handle{', '.footer{', '.settings-btn{', '.toolchain-btn{', '.settings-panel{', '.hotkey-hint{', '.rail-gap{', '.output-content.debug{']) {
  ok('b6: 已删除废弃样式 ' + sel, !html.includes(sel));
}

// 执行设置：运行请求与前端等待期限使用同一份超时。
{
  const headersFor = new Function('native', 'url', `
    const window={DogeNative:native?{executionToken:()=>'fixture-session'}:undefined};
    const DogeNative=window.DogeNative;
    let captured;
    const fetch=async(target,options)=>{captured=new Headers(options.headers);return {ok:true,text:async()=>'{}'};};
    ${extractFn('fetchApi')}
    async ${extractFn('fetchJsonWithTimeout')}
    return fetchJsonWithTimeout(url,{headers:{'Content-Type':'application/json','Authorization':'existing'}},1000).then(()=>({token:captured.get('X-Doge-Session'),contentType:captured.get('Content-Type'),authorization:captured.get('Authorization')}));
  `);
  eq('auth: 原生 API 请求携带会话令牌并保留已有请求头', await headersFor(true,'/api/v1/tasks'), {token:'fixture-session',contentType:'application/json',authorization:'existing'});
  eq('auth: 会话令牌不会发往站外地址', (await headersFor(true,'https://example.invalid/api/v1/tasks')).token, null);
  eq('auth: 桌面与开发代理请求保持兼容', (await headersFor(false,'/api/v1/tasks')).token, null);
}

// 执行设置：运行请求与前端等待期限使用同一份超时。
{
  const captureRunRequest = new Function('id', 'timeout', `
    let isRunning, taskCancelRequestedAt, activeTaskId, outputData, taskHistory=[];
    const project={language:id,dependencies:[],files:[{path:id==='python'?'main.py':'main.c',code:'sample'}]};
    const currentFilePath=project.files[0].path, TASK_REQUEST_TIMEOUT_MS=8000;
    const document={getElementById:()=>({value:''})}, getSetting=()=>timeout;
    const setRunButtonState=()=>{}, beginRun=()=>{}, renderOutput=()=>{}, activeBuildProfile=()=>({});
    const parseDependencyCoordinate=x=>x, bindLiveStdin=()=>{}, renderTaskList=()=>{}, pollTask=async()=>{}, showToast=()=>{}, onRunFinished=()=>{};
    let sent;
    const fetchJsonWithTimeout=async(url,options)=>{sent=JSON.parse(options.body);return {task_id:'t1'};};
    async ${extractFn('runAsTask')}
    return runAsTask({id,name:id,apiLang:id},'sample','').then(()=>sent);
  `);
  eq('py-timeout: Python 请求包含设置的超时', (await captureRunRequest('python',7000)).timeout_ms, 7000);
  eq('c-timeout: C 请求继续使用设置的超时', (await captureRunRequest('c',7000)).timeout_ms, 7000);
  const pollBeyondDeadline = new Function(`
    let calls=0,canceled=false,taskCancelRequestedAt=0,outputData={stdout:'',stderr:''};
    const Date={now:()=>calls++===0?0:130000}, getSetting=()=>5000;
    const TASK_REQUEST_TIMEOUT_MS=8000,TASK_POLL_MAX_FAILURES=5,TASK_CANCEL_GRACE_MS=10000;
    const document={getElementById:()=>({})},taskHistory=[];
    const appendBoundedOutput=(a,b)=>a+b,updateStderrCount=()=>{},renderTaskList=()=>{},renderOutput=()=>{},showToast=()=>{},onRunFinished=()=>{};
    const fetchJsonWithTimeout=async url=>{if(url.endsWith('/cancel'))canceled=true;return {phase:'finished',status:'success'};};
    async ${extractFn('pollTask')}
    return pollTask('t1',{id:'python',name:'Python'}).then(()=>canceled,()=>canceled);
  `);
  ok('py-timeout: 前端等待期限也按设置计算', await pollBeyondDeadline());
}

// ── 6. 接口契约: DogeNative.* 调用 ⊆ Java @JavascriptInterface ──
const jsCalls = new Set([...html.matchAll(/DogeNative\.(\w+)/g)].map(m => m[1]));
const javaMethods = new Set(
  [...java.matchAll(/@JavascriptInterface\s+public\s+[\w<>\[\]]+\s+(\w+)\s*\(/g)].map(m => m[1])
    .concat([...java.matchAll(/@JavascriptInterface\s+public\s+\w+\s+(\w+)\s*\(/g)].map(m => m[1]))
);
// 兼容单行写法 @JavascriptInterface public void x(...) 与换行写法
for (const m of java.matchAll(/@JavascriptInterface[\s\S]{0,80}?\b(\w+)\s*\(/g)) javaMethods.add(m[1]);
for (const name of jsCalls) {
  ok('bridge: DogeNative.' + name + ' 有 Java 实现', javaMethods.has(name));
}

// ── 7. 回调契约: Java postToWeb 的 window.* ⊆ 前端定义的 window.* ─
const jsCallbacks = new Set([...html.matchAll(/window\.(\w+)\s*=\s*function/g)].map(m => m[1]));
const javaCallbacks = new Set([...java.matchAll(/window\.(\w+)\s*&&/g)].map(m => m[1]));
for (const name of javaCallbacks) {
  ok('callback: window.' + name + ' 前端已定义', jsCallbacks.has(name));
}

// ── 输出 ────────────────────────────────────────────────────────
console.log('\n批次0 基线测试: ' + pass + ' 通过, ' + fail + ' 失败');
if (fail) {
  console.log('失败项:');
  failures.forEach(f => console.log('  ✗ ' + f));
  process.exit(1);
}
console.log('全部通过 ✓');
