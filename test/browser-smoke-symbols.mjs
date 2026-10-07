// Real CodeMirror keys, soft-keyboard text events, token scopes and display-only ligatures.
import {launch,checker,sleep} from './browser-lib.mjs';
import {writeFileSync} from 'node:fs';
const browser=await launch({width:1557,height:973,touch:false});
if(!browser){console.log('跳过：未找到 Edge/Chrome');process.exit(0);}
const {ok,eq,report}=checker(),{ev,key,typeText}=browser;
const fwMarks='editor.getAllMarks().filter(m=>m.className==="cm-doge-fullwidth").map(m=>{const p=m.find();return [p.from.line,p.from.ch]})';
async function open(language,code='') {
  const path=language==='python'?'main.py':language==='cpp'?'main.cpp':'main.c';
  await ev(`window.projectOpened(${JSON.stringify({name:'Symbols',language,files:[{path,code}]})});editor.focus();true`);
}
async function reset(code='') {await ev(`editor.closeHint();editor.setValue(${JSON.stringify(code)});editor.setCursor(0,0);editor.focus();true`);}
async function waitFor(expr) {for(let i=0;i<60;i++){if(await ev(expr))return true;await sleep(50);}return false;}
try{
  if(await ev('overlayStack.length'))await key('Escape');
  await open('c');await ev('setSetting("autoComplete","0");true');
  for(const language of ['c','cpp','python']) {
    await open(language);
    for(const [left,right] of [['(',')'],['[',']'],['{','}']]) {
      await reset();await key(left);
      eq(language+': 左括号自动补全 '+left,await ev('editor.getValue()'),left+right);
      eq(language+': 光标位于括号中间 '+left,await ev('editor.getCursor().ch'),1);
      await key(right);eq(language+': 跳过已有右括号 '+right,await ev('editor.getValue()'),left+right);
      await ev('editor.setCursor(0,1);true');await key('Backspace');
      eq(language+': 退格成对删除 '+left,await ev('editor.getValue()'),'');
    }
    await reset('value');await ev('editor.setSelection({line:0,ch:0},{line:0,ch:5});true');await key('(');
    eq(language+': 括号包裹选中文字',await ev('editor.getValue()'),'(value)');
    await reset('value');await ev('editor.setSelection({line:0,ch:0},{line:0,ch:5});true');await typeText('[');
    eq(language+': 软键盘包裹选中文字',await ev('editor.getValue()'),'[value]');
    await reset();await typeText('(');
    eq(language+': 软键盘文本路径补全括号',await ev('editor.getValue()'),'()');
    await typeText(')');eq(language+': 软键盘跳过已有右括号',await ev('editor.getValue()'),'()');
    await reset();await typeText('[');await key('z',{ctrl:true});eq(language+': 一次撤销整对软键盘括号',await ev('editor.getValue()'),'');
  }
  await open('cpp');await reset();await key('{');await key('Enter');
  ok('brackets: 花括号中 Enter 分行并缩进',await ev('editor.lineCount()===3 && editor.getCursor().line===1 && editor.getCursor().ch>0'));
  await open('python');await reset();await key('"');eq('brackets: 双引号配对',await ev('editor.getValue()'),'""');
  await reset();await browser.send('Input.imeSetComposition',{text:'(',selectionStart:1,selectionEnd:1});await sleep(60);
  await browser.send('Input.insertText',{text:'('});await sleep(100);
  eq('IME: 组字提交只补一对括号',await ev('editor.getValue()'),'()');
  await reset();await typeText('(literal)');eq('paste: 多字符输入不重复补括号',await ev('editor.getValue()'),'(literal)');
  const code='int main（ ） {\n  int x＝1；\n  printf("中文，合法"); // 中文（注释）\n  return 0；\n}';
  await open('c',code);
  eq('fullwidth: 仅代码符号标红',await ev(fwMarks),[[0,8],[0,10],[1,7],[1,9],[3,10]]);
  eq('fullwidth: 问题模型包含错误',await ev('collectProblems().filter(p=>p.source==="syntax").length'),5);
  await ev('switchPanelView("problems");true');eq('problems: 诊断进入问题列表',await ev('document.querySelectorAll("#problemsList .prob").length'),5);
  await ev('document.querySelector("#problemsList .prob[data-file]").click();true');eq('problems: 点击定位具体符号',await ev('editor.getCursor().ch'),8);
  await reset('int x=1;');ok('fullwidth: 修正后问题与红线清除',await waitFor('fullwidthProblems.length===0'));
  await ev('window.DogeNative={isToolchainReady:()=>true};true');await reset('#define LIMIT １＋2\nint a＝0；');
  eq('clangd: 就绪时仍检查预处理和源码',await ev(fwMarks),[[0,15],[1,5],[1,7]]);
  await reset('#define MSG "中文，合法"\n#define X 1 // 中文（注释）');
  eq('C: 预处理字符串和注释不误报',await ev(fwMarks),[]);
  await open('python','print（"中文（字符串），正确"）\n# 中文：注释\na＝1');
  eq('Python: 代码标点检查而字符串注释排除',await ev(fwMarks),[[0,5],[0,18],[2,1]]);
  await ev('editor.setValue("（（");scheduleLint();true');eq('problems: 同行相同符号独立计数',await ev('collectProblems().filter(p=>p.source==="syntax").map(p=>p.col)'),[1,2]);
  await ev('openSettings();true');eq('settings: 默认符号合并关闭',await ev('document.getElementById("symbolLigaturesInput").checked'),false);
  await ev('document.getElementById("symbolLigaturesInput").checked=true;document.getElementById("fullwidthSymbolLintInput").checked=false;document.querySelector("#settingsModal .settings-save").click();true');
  eq('settings: 关闭检查后红线清除',await ev(fwMarks),[]);
  eq('settings: 连字设置生效',await ev('editor.getWrapperElement().classList.contains("doge-symbol-ligatures")'),true);
  const operators='a>=b; a<=b; a!=b; a->b; ----';await reset(operators);
  eq('ligatures: 开关未改变实际代码',await ev('editor.getValue()'),operators);eq('ligatures: 草稿保留 ASCII',await ev('project.files[0].code'),operators);
  await ev('editor.setSelection({line:0,ch:0},{line:0,ch:5});true');eq('ligatures: 字符位置与选择保持 ASCII',await ev('editor.getSelection()'),'a>=b;');
  const clipboard=await ev(`(()=>{const data={};const e=new Event('copy',{bubbles:true,cancelable:true});Object.defineProperty(e,'clipboardData',{value:{setData:(k,v)=>data[k]=v}});editor.getInputField().dispatchEvent(e);return data['text/plain'];})()`);
  eq('ligatures: 复制保持源码',clipboard,'a>=b;');
  ok('ligatures: 编辑器 span 启用字体连字',await ev('getComputedStyle(document.querySelector(".CodeMirror-code .CodeMirror-line span")).fontVariantLigatures === "contextual"'));
  await ev('document.fonts.load(\'16px "Maple Mono"\');true');
  for(const symbols of ['>=','<=','->','----']) {
    await reset(symbols);await ev('document.querySelector(".CodeMirror-cursors").style.visibility="hidden";true');
    const clip=await ev('(()=>{const r=document.querySelector(".CodeMirror-code .CodeMirror-line").getBoundingClientRect();return {x:r.left,y:r.top,width:Math.min(r.width,220),height:r.height,scale:1};})()');
    await ev('setSetting("symbolLigatures","0");applyEditorPreferences();true');await sleep(80);
    const off=await browser.send('Page.captureScreenshot',{format:'png',clip});
    await ev('setSetting("symbolLigatures","1");applyEditorPreferences();true');await sleep(80);
    const on=await browser.send('Page.captureScreenshot',{format:'png',clip});
    ok('ligatures: '+symbols+' 显示字形确实变化',off.result.data!==on.result.data);
    eq('ligatures: '+symbols+' 保留源字符',await ev('editor.getValue()'),symbols);
  }
  await ev('document.querySelector(".CodeMirror-cursors").style.visibility="";true');
  await browser.reload();eq('settings: 重启仍保留连字设置',await ev('editor.getWrapperElement().classList.contains("doge-symbol-ligatures")'),true);
  await ev('openSettings();document.getElementById("symbolLigaturesInput").checked=false;document.getElementById("fullwidthSymbolLintInput").checked=true;document.getElementById("autoCloseBracketsInput").checked=false;saveSettings();true');
  await reset();await key('(');eq('brackets: 关闭后仅输入左括号',await ev('editor.getValue()'),'(');
  ok('ligatures: 关闭时 span 明确禁用连字',await ev('getComputedStyle(document.querySelector(".CodeMirror-code .CodeMirror-line span")).fontFeatureSettings.includes("0")'));
  await ev('openSettings();document.getElementById("autoCloseBracketsInput").checked=true;saveSettings();true');await reset();await key('[');eq('brackets: 再开启立即生效',await ev('editor.getValue()'),'[]');
  await browser.reload();eq('settings: 连字关闭持久化',await ev('getSetting("symbolLigatures","0")'),'0');
  await ev('window.projectOpened({name:"Data",language:"python",files:[{path:"notes.txt",code:"中文，（全角）；"}]});true');eq('data: 普通文本数据不作为代码报错',await ev(fwMarks),[]);
  if(process.env.DOGE_SYMBOL_SCREENSHOT){await open('python','if a >= b:\n    print（"需要半角括号"）');await ev('setSetting("symbolLigatures","1");applyEditorPreferences();true');await sleep(200);const shot=await browser.send('Page.captureScreenshot',{format:'png'});writeFileSync(process.env.DOGE_SYMBOL_SCREENSHOT,Buffer.from(shot.result.data,'base64'));}
  ok('无 JavaScript 异常'+browser.errors.join(' | '),browser.errors.length===0);
}catch(error){ok('脚本异常: '+error.message,false);}
const failed=report('符号与括号浏览器冒烟');await browser.close();process.exit(failed?1:0);
