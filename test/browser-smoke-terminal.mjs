// Real xterm/DOM input with a deterministic task API; no device runtime is simulated as real WASI.
import {launch,checker,sleep} from './browser-lib.mjs';
import {writeFileSync} from 'node:fs';
const b=await launch({width:1557,height:973,touch:false});
if(!b){console.log('跳过：未找到 Edge/Chrome');process.exit(0);}
const {ok,eq,report}=checker();
async function waitFor(expression,ms=3000){for(let t=0;t<ms;t+=50){if(await b.ev(expression))return true;await sleep(50);}return false;}
try{
  await b.ev(`window.projectOpened({name:'Terminal',language:'python',files:[{path:'main.py',code:'pass'}]});
    window.DogeNative={isPythonReady:()=>true,isToolchainReady:()=>true,executionToken:()=>"token"};
    window.frames=[];window.inputFrames=[];window.nextSeq=0;window.acceptedSeq=0;window.runFinished=false;window.dropAck=false;
    window.emit=(event)=>frames.push({...event,seq:++nextSeq});
    window.fetch=async(url,options)=>{
      const body=options&&options.body?JSON.parse(options.body):{};
      if(url==='/api/v1/tasks'){
        window.createdBody=body;emit({kind:'data',stream:'stdout',text:'你的名字：'});
        return {ok:true,text:async()=>JSON.stringify({task_id:'t1',session_id:'s1'})};
      }
      if(url.includes('/events')){const after=Number(url.split('after=')[1]);return {ok:true,text:async()=>JSON.stringify({session_id:'s1',phase:runFinished?'finished':'running',status:runFinished?'success':'running',input_ready:!runFinished,input_closed:runFinished,events:frames.filter(e=>e.seq>after),next_seq:nextSeq,has_more:false})};}
      if(url.endsWith('/input')||url.endsWith('/eof')){
        if(body.seq>acceptedSeq){acceptedSeq=body.seq;inputFrames.push(body);if(body.text)emit({kind:'data',stream:'stdin',text:body.text,input_seq:body.seq});}
        if(dropAck){dropAck=false;throw Error('fixture lost ACK');}
        if(url.endsWith('/eof')){emit({kind:'data',stream:'stdout',text:'EOF tail\\n'});emit({kind:'exit',status:'success',exit_code:0});runFinished=true;}
        return {ok:true,text:async()=>JSON.stringify({ok:true,accepted_seq:acceptedSeq})};
      }
      if(url.endsWith('/cancel')){emit({kind:'exit',status:'canceled',exit_code:-1});runFinished=true;return {ok:true,text:async()=>'{}'};}
      throw Error('unexpected URL '+url);
    };window.runPromise=runCode();true`);
  ok('run: 默认运行进入终端',await waitFor('panelView === "terminal" && terminalView.ready'));
  eq('run: Python 使用独立交互时限',await b.ev('[createdBody.run_mode,createdBody.run_timeout_ms,createdBody.compile_timeout_ms]'),['interactive',600000,30000]);
  eq('run: 不发送遗留预填 stdin',await b.ev('createdBody.stdin'),undefined);
  ok('prompt: 无换行中文提示实时可见',await waitFor('terminalView.text().includes("你的名字：")'));
  await b.ev('document.getElementById("terminalInput").focus();true');
  await b.typeText('小明😀');
  await b.key('Enter');
  ok('input: Enter 发送中文和 emoji',await waitFor('inputFrames.length === 1'));
  eq('input: 输入携带会话与序号',await b.ev('inputFrames[0]'),{session_id:'s1',seq:1,text:'小明😀\n'});
  ok('echo: 服务端回显只出现一次',await waitFor('terminalView.text().split("小明😀").length === 2'));
  await b.ev(`var terminalDraft=document.getElementById('terminalInput');terminalDraft.dispatchEvent(new CompositionEvent('compositionstart'));terminalDraft.value='组字';terminalDraft.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true}));true`);
  eq('IME: 组字中的 Enter 不发送输入',await b.ev('inputFrames.length'),1);
  await b.ev(`document.getElementById('terminalInput').dispatchEvent(new CompositionEvent('compositionend'));true`);
  await b.key('Enter');
  ok('IME: 组字结束后的 Enter 可发送',await waitFor('inputFrames.length === 2'));
  await b.ev(`document.getElementById('terminalInput').value='草稿';emit({kind:'data',stream:'stdout',text:'后台输出\\n'});true`);
  await waitFor('terminalView.text().includes("后台输出")');
  eq('async: 新输出不会破坏正在编辑的输入',await b.ev('document.getElementById("terminalInput").value'),'草稿');
  if(process.env.DOGE_TERMINAL_SCREENSHOT){const shot=await b.send('Page.captureScreenshot',{format:'png'});writeFileSync(process.env.DOGE_TERMINAL_SCREENSHOT,Buffer.from(shot.result.data,'base64'));}
  await b.ev('dropAck=true;true');await b.key('Enter');
  ok('retry: 确认丢失后仍只投递一次',await waitFor('inputFrames.length===3 && !terminalView.busy'));
  eq('retry: 重试沿用输入序号',await b.ev('acceptedSeq'),3);
  await b.ev(`terminalDraft.value='';var terminalPaste=new DataTransfer();terminalPaste.setData('text/plain','line1\\nline2\\ntail');terminalDraft.dispatchEvent(new ClipboardEvent('paste',{clipboardData:terminalPaste,bubbles:true,cancelable:true}));true`);
  ok('paste: 完整多行按顺序发送',await waitFor('inputFrames.length===4'));
  eq('paste: 未提交的尾行保持可编辑',await b.ev('document.getElementById("terminalInput").value'),'tail');
  await b.ev('document.getElementById("terminalInput").value="";true');
  await b.key('d',{ctrl:true});
  ok('EOF: 等到输出尾部和退出事件',await waitFor('!isRunning && terminalView.text().includes("EOF tail")'));
  eq('EOF: 结束后输入禁用',await b.ev('document.getElementById("terminalInput").disabled'),true);
  ok('exit: 保留退出码',await b.ev('terminalView.text().includes("退出码 0")'));
  await b.ev('terminalView.clear();true');eq('clear: 清屏不创建新任务',await b.ev('inputFrames.length'),5);
  await b.setViewport(1280,560,true);await b.ev('terminalView.refresh();true');
  ok('layout: 终端在窄高视口内',await b.ev('(()=>{const r=document.getElementById("terminalView").getBoundingClientRect();return r.bottom<=innerHeight&&r.height>100;})()'));
  ok('terminal: 没有运行时 JS 错误 '+b.errors.join(';'),b.errors.length===0);
  await b.ev(`window.projectOpened({name:'C-terminal',language:'c',files:[{path:'main.c',code:'int main(){return 0;}'}]});frames=[];nextSeq=0;runFinished=false;inputFrames=[];acceptedSeq=0;window.runPromise=runCode();true`);
  ok('C: C 程序也默认使用交互终端',await waitFor('terminalView.ready && createdBody.language === "c"'));
  await b.ev('document.getElementById("terminalInput").focus();true');
  await b.setViewport(1280,430,true);await sleep(200);
  ok('keyboard: 终端输入时保留底部面板',await b.ev('document.body.classList.contains("kb-panel") && document.getElementById("terminalInput").getBoundingClientRect().bottom <= innerHeight'));
  await b.key('c',{ctrl:true});
  ok('stop: Ctrl+C 停止当前会话',await waitFor('!isRunning && terminalView.text().includes("canceled")'));
}finally{await b.close();}
process.exit(report('交互终端浏览器冒烟')?1:0);
