// 文件改名、保存来源及纯黑主题的实际浏览器回归。
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launch, checker, sleep, root } from './browser-lib.mjs';

const b = await launch({ width: 1280, height: 800 });
if (!b) { console.log('跳过：未找到 Edge/Chrome'); process.exit(0); }
const { ev, key, typeText } = b;
const { ok, eq, report } = checker();
async function rename(name) {
  await ev('editor.focus(); true');
  await key('F2');
  await typeText(name);
  await key('Enter');
}
async function waitForHints() {
  for (let i = 0; i < 50; i++) {
    if (await ev('!!document.querySelector(".CodeMirror-hints .hint-label")')) return true;
    await sleep(60);
  }
  return false;
}
try {
  await ev(`window.__savedRequests = [];
    window.DogeNative = { saveProject: json => window.__savedRequests.push(JSON.parse(json)) };
    window.projectOpened({ name: 'Rename', language: 'c', files: [{ path: 'main.c', code: 'int main() { return 0; }' }] }); true`);
  await ev('editor.setValue("int main() { return 42; }"); true');
  await rename('Main.c');
  eq('F2 改名更新当前文件', await ev('currentFilePath'), 'Main.c');
  eq('改名保留目录原路径和编辑内容', await ev('[project.files[0].originalPath, project.files[0].code]'), ['main.c', 'int main() { return 42; }']);
  ok('标签和文档跟随改名', await ev('openFiles.includes("Main.c") && projectDocs.has("Main.c") && !projectDocs.has("main.c")'));
  await key('s', { ctrl: true });
  eq('保存请求携带改名来源', await ev('window.__savedRequests[0].files[0].originalPath'), 'main.c');
  await ev('window.projectSaveResult(false, "磁盘写入失败"); true');
  eq('失败后保留改名信息', await ev('project.files[0].originalPath'), 'main.c');
  await ev('saveProjectToDisk(); window.projectSaveResult(true, ""); true');
  ok('成功后清除来源及未保存标记', await ev('!project.files[0].originalPath && !isFileDirty("Main.c")'));
  eq('成功后本地缓存也清理来源', await ev('JSON.parse(localStorage.getItem(projectStorageKey())).files[0].originalPath || null'), null);

  await ev('openSettings(); document.getElementById("themeInput").value = "black"; saveSettings(); true');
  eq('设置可启用纯黑主题', await ev('currentTheme()'), 'black');
  eq('编辑器与顶栏均为纯黑', await ev('[getComputedStyle(document.querySelector(".CodeMirror")).backgroundColor, getComputedStyle(document.querySelector(".menubar")).backgroundColor]'), ['rgb(0, 0, 0)', 'rgb(0, 0, 0)']);
  eq('浏览器主题色同步', await ev('document.querySelector("meta[name=theme-color]").content'), '#000000');
  eq('富文本复制保留纯黑底色', await ev('copyBgColor()'), '#000000');
  await b.reload();
  eq('重新加载保留纯黑主题', await ev('document.documentElement.dataset.theme'), 'black');
  await ev(String.raw`window.projectOpened({ name: 'Black theme', language: 'cpp', files: [
    { path: 'main.cpp', code: '#include "math.h"\n#include <iostream>\n\nint main() {\n    int total = 42;\n    ca\n    return 0;\n}\n' },
    { path: 'math.h', code: 'int calculate_total(int count);\nint calculate_average(int sum, int count);' }
  ] }); editor.focus(); editor.setCursor(5, 6); triggerCompletion(); true`);
  ok('补全列表可显示', await waitForHints());
  ok('候选名称和签名分开显示', await ev('!!document.querySelector(".CodeMirror-hints .hint-label") && !!document.querySelector(".CodeMirror-hints .hint-detail")'));
  eq('匹配前缀高亮', await ev('document.querySelector(".hint-match").textContent'), 'ca');
  ok('类型图标存在', await ev('!!document.querySelector(".CodeMirror-hint").dataset.icon'));
  if (process.argv.includes('--screenshot')) {
    await sleep(3200); // 等待“项目已打开”提示退场，截图只展示工作区。
    const shot = await b.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(root, 'report/BLACK-COMPLETION-2026-10-17.png'), Buffer.from(shot.result.data, 'base64'));
  }
  await ev('editor.closeHint(); true');
  await b.setViewport(390, 844, true);
  await ev('editor.focus(); triggerCompletion(); true');
  await waitForHints();
  ok('窄屏列表保持在视口内', await ev('(() => { const r=document.querySelector(".CodeMirror-hints").getBoundingClientRect(); return r.left>=0 && r.right<=innerWidth; })()'));
  ok('触屏候选保持 44px 点击区域', await ev('[...document.querySelectorAll(".CodeMirror-hint")].every(li => li.getBoundingClientRect().height>=44)'));
  eq('浏览器无脚本错误', b.errors, []);
} finally { await b.close(); }
process.exitCode = report('文件改名与纯黑主题');
