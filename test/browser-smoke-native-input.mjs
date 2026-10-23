// The Android InputConnection boundary is modeled explicitly: the IME emits no
// DOM input until the app requests a new connection after a handled deletion.
import {launch,checker,sleep} from './browser-lib.mjs';
const browser=await launch();
if(!browser){console.log('SKIP: Edge/Chrome not found');process.exit(0);}
const {ev,key,typeText,send}=browser,{ok,eq,report}=checker();
async function reset(code='abcdef'){
  await ev(`editor.closeHint();editor.setValue(${JSON.stringify(code)});editor.setCursor(0,0);editor.clearHistory();editor.focus();window.__blocked=false;window.__requests=[];true`);await sleep(50);
}
try {
  await send('Emulation.setUserAgentOverride',{userAgent:'Mozilla/5.0 (Linux; Android 14; Tablet) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',platform:'Linux armv8l'});await browser.reload();
  await ev(`projectOpened({name:'Native connection',language:'python',files:[{path:'main.py',code:'abcdef'},{path:'other.py',code:'other'}]});setSetting('autoComplete','0');
    window.__blocked=false;window.__requests=[];window.__delaySync=false;
    window.DogeNative={syncEditorInput:id=>{window.__requests.push(id);if(window.__delaySync)return;
      setTimeout(()=>{if(window.confirmEditorInputSync&&window.confirmEditorInputSync(id)){window.__blocked=false;
        if(window.editorInputSyncResult)window.editorInputSyncResult(id,true);}},0);},
      editorInputDiagnostics:()=>JSON.stringify({events:[],ime:'fixture'})};true`);
  for(let i=0;i<4;i++){
    await reset();await ev('editor.setSelection({line:0,ch:1},{line:0,ch:5});window.__blocked=true;true');await key('Backspace');await sleep(30);
    eq('selection deletion requests an Android input connection '+i,await ev('window.__requests.length'),1);
    if(await ev('!window.__blocked'))await typeText('xy');
    eq('native text delivery resumes after selected Backspace '+i,await ev('editor.getValue()'),'axyf');
    eq('selection deletion preserves the project source '+i,await ev('project.files[0].code'),'axyf');
  }
  for(const [code,start,end] of [['abcdefghijklmnopqr',0,18],['abcdef',1,5]]) {
    await reset(code);
    await ev(`editor.setSelection({line:0,ch:${start}},{line:0,ch:${end}});window.__blocked=true;
      (()=>{const input=editor.getInputField();input.dispatchEvent(new InputEvent('beforeinput',{bubbles:true,inputType:'insertText',data:''}));
        input.value='';input.setSelectionRange(0,0);input.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:''}));})();true`);
    await key('Backspace');await sleep(40);
    const requestCount=await ev('window.__requests.length');
    ok('Sogou empty commit followed by Backspace synchronizes '+start,requestCount>=1&&requestCount<=(start===0?1:2));
    if(await ev('!window.__blocked'))await typeText('xy');
    const after=code.slice(0,start)+code.slice(end),insertion=Math.max(0,start-1);
    const wanted=after.slice(0,insertion)+'xy'+after.slice(start);
    eq('text resumes after diagnostic empty-commit replay '+start,await ev('editor.getValue()'),wanted);
  }
  await reset('abcdefghijklmnopqr');
  await ev(`window.__delaySync=true;editor.setSelection({line:0,ch:0},{line:0,ch:18});window.__blocked=true;
    (()=>{const input=editor.getInputField();input.dispatchEvent(new InputEvent('beforeinput',{bubbles:true,inputType:'insertText',data:''}));
      input.value='';input.setSelectionRange(0,0);input.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:''}));})();true`);
  const emptyCommitRequest=await ev('window.__requests[0]');await key('Backspace');
  eq('a no-op Backspace at document start must not invalidate native synchronization',await ev(`!!window.confirmEditorInputSync(${emptyCommitRequest})`),true);
  await ev('window.__delaySync=false;true');
  await reset();await ev(`editor.setSelection({line:0,ch:1},{line:0,ch:5});window.__blocked=true;
    (()=>{const input=editor.getInputField();input.value='';input.setSelectionRange(0,0);
      input.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:null}));})();true`);await sleep(40);
  eq('empty insertText without beforeinput or event data synchronizes the deleted selection',await ev('window.__requests.length'),1);
  if(await ev('!window.__blocked'))await typeText('xy');eq('input resumes after empty input-only commit',await ev('editor.getValue()'),'axyf');
  await reset();await ev('editor.setSelection({line:0,ch:1},{line:0,ch:5});true');await typeText('new');
  eq('committed text replacing a selection synchronizes input',await ev('window.__requests.length'),1);
  eq('ordinary replacement text remains intact',await ev('editor.getValue()'),'anewf');
  // Replay a WebView connection that stops delivering input after replacing a
  // range. Backspace is covered above; a nonempty replacement must recover too.
  for (const replacement of ['x','7','new']) {
    await reset('before input after');
    await ev('editor.setSelection({line:0,ch:7},{line:0,ch:12});window.__blocked=true;true');
    await typeText(replacement);await sleep(40);
    eq('committed selected replacement synchronizes '+replacement,await ev('window.__requests.length'),1);
    if(await ev('!window.__blocked'))await typeText('z');
    eq('input continues after committed selected replacement '+replacement,await ev('editor.getValue()'),'before '+replacement+'z after');
  }
  for (const selected of [['input',0,5],['before input after',7,12],['ab',0,1],['a\nb',0,3]]) {
    const [code,start,end] = selected;
    await reset(code);
    await ev(`editor.setSelection(editor.posFromIndex(${start}),editor.posFromIndex(${end}));window.__blocked=true;true`);
    await send('Input.imeSetComposition',{text:'ni',selectionStart:2,selectionEnd:2});await sleep(30);
    eq('uncommitted selected composition does not restart input '+JSON.stringify(selected),await ev('window.__requests.length'),0);
    await send('Input.insertText',{text:'你'});await sleep(40);
    eq('selected composition restarts after commit '+JSON.stringify(selected),await ev('window.__requests.length'),1);
    if(await ev('!window.__blocked'))await key('z');
    eq('selected composition continues after commit '+JSON.stringify(selected),await ev('editor.getValue()'),code.slice(0,start)+'你z'+code.slice(end));
  }
  await reset('input');await ev('editor.setSelection({line:0,ch:0},{line:0,ch:5});window.__delaySync=true;true');
  await typeText('x');const replaceRequest=await ev('window.__requests[0]');
  await typeText('y');
  eq('replacement synchronization must not interrupt newer typing',await ev(`window.confirmEditorInputSync(${replaceRequest})`),false);
  eq('typing before delayed replacement sync stays intact',await ev('editor.getValue()'),'xy');
  await reset('input');await ev('window.__delaySync=false;editor.setSelection({line:0,ch:0},{line:0,ch:5});true');
  await key('7');await sleep(40);await key('z');
  eq('hardware number replaces a selected word and continues',await ev('editor.getValue()'),'7z');
  await key('z',{ctrl:true});await key('z',{ctrl:true});
  eq('input sync preserves undo of replacement',await ev('editor.getValue()'),'input');
  await reset('input');await ev('setSetting("autoComplete","1");editor.setSelection({line:0,ch:0},{line:0,ch:5});true');
  await typeText('pr');await sleep(300);
  ok('replacement synchronization preserves automatic completion',await ev('hintWidgetOpen(editor)'));
  await key('Tab');await key('7');
  eq('completion after selected replacement accepts and keeps typing',await ev('editor.getValue()'),'print7');
  await ev('setSetting("autoComplete","0");editor.closeHint();true');
  await reset();await ev(`editor.setSelection({line:0,ch:1},{line:0,ch:5});
    (()=>{const input=editor.getInputField();input.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));
      input.value='';input.setSelectionRange(0,0);input.dispatchEvent(new InputEvent('input',{bubbles:true,isComposing:true,inputType:'insertCompositionText',data:''}));})();true`);
  eq('an uncommitted empty composition does not restart native input',await ev('window.__requests.length'),0);
  await ev('finishEditorComposition(editor);true');
  await reset('()');await ev('editor.setCursor(0,1);window.__blocked=true;true');await key('Backspace');await sleep(30);
  eq('empty pair deletion also synchronizes Android input',await ev('window.__requests.length'),1);
  if(await ev('!window.__blocked'))await typeText('x');eq('input after empty pair removal',''+await ev('editor.getValue()'),'x');
  for(const beforeInput of [true,false]) {
    await reset();await ev(`editor.setSelection({line:0,ch:1},{line:0,ch:5});window.__blocked=true;
      (()=>{const input=editor.getInputField();${beforeInput?"input.dispatchEvent(new InputEvent('beforeinput',{bubbles:true,inputType:'deleteContentBackward'}));":''}
        input.value='';input.setSelectionRange(0,0);input.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'deleteContentBackward'}));})();true`);await sleep(40);
    eq('IME-native selected deletion synchronizes without keydown '+beforeInput,await ev('window.__requests.length'),1);
    if(await ev('!window.__blocked'))await typeText('xy');eq('input resumes after IME-native selection deletion '+beforeInput,await ev('editor.getValue()'),'axyf');
  }
  await reset();await ev('editor.setCursor(0,6);true');await key('Backspace');
  eq('ordinary single-character Backspace does not restart the IME',await ev('window.__requests.length'),0);
  await reset();await ev('editor.setOption("readOnly",true);editor.setSelection({line:0,ch:1},{line:0,ch:5});true');await key('Backspace');
  eq('read-only selection does not restart the IME',await ev('window.__requests.length'),0);
  eq('read-only source is retained',await ev('editor.getValue()'),'abcdef');await ev('editor.setOption("readOnly",false);true');
  await reset();await ev('window.__delaySync=true;editor.setSelection({line:0,ch:1},{line:0,ch:5});true');await key('Backspace');
  const request=await ev('window.__requests[0]');await typeText('x');
  eq('late native synchronization cannot interrupt newer input',await ev(`window.confirmEditorInputSync&&window.confirmEditorInputSync(${request})`),false);
  await reset('abcdefghijklmnopqr');await ev(`window.__delaySync=true;editor.setSelection({line:0,ch:0},{line:0,ch:18});
    (()=>{const input=editor.getInputField();input.value='';input.setSelectionRange(0,0);input.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:''}));})();true`);
  await key('Backspace');await ev('window.__requests=[];true');
  await send('Input.imeSetComposition',{text:'ni',selectionStart:2,selectionEnd:2});await sleep(40);
  eq('no-op deletion marker must not restart a later composition',await ev('window.__requests.length'),0);
  eq('new composition survives a preceding no-op Backspace',await ev('!!editor.display.input.composing'),true);
  await send('Input.insertText',{text:'你'});await typeText('z');eq('new composition is committed without losing text',await ev('editor.getValue()'),'你z');
  await reset();await ev('editor.setSelection({line:0,ch:1},{line:0,ch:5});true');await key('Backspace');
  const swapRequest=await ev('window.__requests[0]');await ev('switchProjectFile("other.py");editor.focus();true');
  eq('late synchronization cannot act on another document',await ev(`window.confirmEditorInputSync&&window.confirmEditorInputSync(${swapRequest})`),false);
  await ev('switchProjectFile("main.py");window.__delaySync=false;editor.focus();true');
  await reset();await ev('window.__delaySync=true;editor.setSelection({line:0,ch:1},{line:0,ch:5});true');await key('Backspace');
  const movedRequest=await ev('window.__requests[0]');await ev('editor.setCursor(0,0);true');
  eq('late synchronization cannot interrupt a new cursor position',await ev(`window.confirmEditorInputSync(${movedRequest})`),false);
  await reset();await ev('window.__delaySync=false;true');await typeText('private_source_marker');
  await ev('openEditorInputDiagnostics();true');await sleep(50);
  const diagnostics=await ev('document.querySelector(".input-diagnostic-log").value');
  ok('diagnostics contain native and frontend input metadata',diagnostics.includes('"native"')&&diagnostics.includes('"nativeLength"'));
  ok('diagnostics do not contain source or committed text',!diagnostics.includes('private_source_marker'));
  await key('Escape');
  eq('closing diagnostics restores editor focus',await ev('editor.hasFocus()'),true);
  await ev('window.__blocked=true;recoverEditorInput();true');await sleep(40);
  eq('manual recovery asks Android for a new input connection',await ev('window.__blocked'),false);
  await reset();await ev('window.__delaySync=true;editor.setSelection({line:0,ch:1},{line:0,ch:5});true');await key('Backspace');
  const blurRequest=await ev('window.__requests[0]');await ev('openSettings();true');await sleep(40);
  eq('pending synchronization cannot act behind an open dialog',await ev(`window.confirmEditorInputSync(${blurRequest})`),false);
  await key('Escape');
  await reset();await ev('window.__delaySync=false;editor.setSelection({line:0,ch:1},{line:0,ch:5});window.__blocked=true;editor.replaceSelection("","end","+input");true');await sleep(40);
  eq('actual multi-character input deletion synchronizes without a recognized DOM event',await ev('window.__requests.length'),1);
  if(await ev('!window.__blocked'))await typeText('xy');eq('text after a deletion with no event marker is retained',await ev('editor.getValue()'),'axyf');
  await reset();await ev('window.__delaySync=true;window.__refocus=0;editor.getInputField().addEventListener("focus",()=>window.__refocus++);editor.setSelection({line:0,ch:1},{line:0,ch:5});true');await key('Backspace');
  const focusRequest=await ev('window.__requests[0]');await ev(`window.confirmEditorInputSync(${focusRequest});true`);
  eq('native synchronization rebuilds the DOM editor focus before restarting the IME',await ev('window.__refocus'),1);
  eq('focus rebuild preserves source and cursor',await ev('[editor.getValue(),editor.getCursor().ch]'),['af',1]);
  await key('z',{ctrl:true});eq('focus rebuild preserves undo history',await ev('editor.getValue()'),'abcdef');
  await reset();await ev('window.__delaySync=true;true');
  for(let i=0;i<140;i++)await ev(`editor.getInputField().dispatchEvent(new KeyboardEvent('keyup',{key:'q',bubbles:true}));true`);
  await ev('openEditorInputDiagnostics();true');await sleep(40);
  const retained=JSON.parse(await ev('document.querySelector(".input-diagnostic-log").value'));
  ok('critical synchronization events survive a flood of normal key events',retained.transitions&&retained.transitions.some(e=>e.type==='native-sync-confirm'));
  await key('Escape');
  await ev('window.__delaySync=false;true');
  for(let i=0;i<12;i++) {
    await reset('abcdef');await ev('editor.setSelection({line:0,ch:1},{line:0,ch:5});window.__blocked=true;true');
    await key('Backspace');await sleep(20);
    if(await ev('!window.__blocked'))await typeText('xy');
    eq('repeated selected Backspace and native recovery '+i,await ev('editor.getValue()'),'axyf');
  }
  ok('no browser exceptions: '+browser.errors.join(' | '),browser.errors.length===0);
}catch(error){ok('script error: '+error.stack,false);}
const failures=report('Android native input synchronization');await browser.close();process.exit(failures?1:0);
