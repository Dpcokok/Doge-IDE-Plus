// Python editing and save lifecycle regressions in real CodeMirror and DOM.
import { launch, checker, sleep } from './browser-lib.mjs';

const browser = await launch({ width: 1557, height: 973 });
if (!browser) { console.log('跳过：未找到 Edge/Chrome'); process.exit(0); }
const { ok, eq, report } = checker();
const { ev } = browser;
try {
  await ev(`window.projectOpened({name:'Python',language:'python',files:[
    {path:'config.json',code:'{}'}, {path:'main.py',code:'import json\\nprint(123)\\n'}]}); true`);
  eq('open: 首个数据文件不改变 Python 项目语言', await ev('project.language'), 'python');
  eq('data: JSON 以普通文本编辑', await ev('editor.getOption("mode")'), null);
  await ev('switchProjectFile("main.py"); true');
  eq('editor: Python 文件使用 Python mode', await ev('editor.getOption("mode")'), 'python');
  eq('editor: CodeMirror 实际加载的 mode 是 Python', await ev('editor.getMode().name'), 'python');
  eq('editor: 切换后语言保持 Python', await ev('currentLang'), 'python');
  await ev(`window.DogeNative={isToolchainReady:()=>true,isPythonReady:()=>true}; true`);
  eq('intel: C++ 运行库不会为 Python 启用 clangd', await ev('clangdEnabledForFile()'), false);
  await ev('switchProjectFile("config.json"); true');
  eq('intel: 数据文件也不启用 clangd', await ev('clangdEnabledForFile()'), false);
  await ev('window.projectOpened({name:"EmptyPy",language:"python",files:[]}); true');
  eq('empty: 空项目保留 Python 语言', await ev('project.language'), 'python');
  eq('empty: 空编辑器使用 Python mode', await ev('editor.getOption("mode")'), 'python');

  await ev(`window.savedRequests=[];
    window.DogeNative={saveProject:json=>savedRequests.push(JSON.parse(json)),executionToken:()=>"fixture-token"};
    window.projectOpened({name:'Save',language:'python',files:[{path:'main.py',code:'initial'}]});
    editor.setValue('A');saveProjectToDisk();editor.setValue('B');saveProjectToDisk();true`);
  eq('save: 两次点击只发送第一个原生请求', await ev('savedRequests.length'), 1);
  await ev('window.projectSaveResult(true, ""); true');
  eq('save: 第一个回调不清除 B 的未保存状态', await ev('isFileDirty("main.py")'), true);
  eq('save: 第一个回调后发送 B', await ev('savedRequests[1].files[0].code'), 'B');
  await ev('window.projectSaveResult(false,"fixture failure"); true');
  eq('save: 第二次失败后 B 保持未保存', await ev('isFileDirty("main.py")'), true);
  await ev(`editor.setValue('C');saveProjectToDisk();
    window.projectOpened({name:'New',language:'python',files:[{path:'main.py',code:'another-project'}]});
    window.projectSaveResult(true,''); true`);
  eq('save: 旧项目的回调不污染新项目的保存基线', await ev('isFileDirty("main.py")'), false);

  const auth = await ev(`(async()=>{
    const original=window.fetch;
    let token,contentType;
    window.fetch=async(url,options)=>{const headers=new Headers(options.headers);token=headers.get('X-Doge-Session');contentType=headers.get('Content-Type');return {ok:true,text:async()=>'{}'};};
    try{await fetchJsonWithTimeout('/api/v1/tasks',{headers:{'Content-Type':'application/json'}},1000);return {token,contentType};}
    finally{window.fetch=original;}
  })()`);
  eq('auth: 浏览器 API 请求携带原生会话令牌', auth, {token:'fixture-token',contentType:'application/json'});
  await sleep(100);
  ok('无 JavaScript 错误 (' + browser.errors.join('; ') + ')', browser.errors.length === 0);
} finally { await browser.close(); }
process.exit(report('Python 浏览器冒烟') ? 1 : 0);
