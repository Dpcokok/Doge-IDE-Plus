import {launch,checker,sleep} from './browser-lib.mjs';
const browser=await launch({width:1557,height:973});
if(!browser){console.log('SKIP: Edge/Chrome not found');process.exit(0);}
const {ev,key,typeText,send}=browser,{ok,eq,report}=checker();
const cases=[['all','abcdef',0,6],['middle','abcdef',1,5],['multiple lines','first\nsecond\nthird',2,15],['Unicode','甲乙丙😀丁',1,6],['long selection','L'+'a'.repeat(1600)+'R',1,1601]];
async function reset(code) {
  await ev(`editor.getInputField().blur();finishEditorComposition(editor);editor.closeHint();editor.setValue(${JSON.stringify(code)});editor.setCursor(0,0);editor.focus();true`);await sleep(40);
}
async function arrow(keyName,shift=false) {
  const code=keyName==='ArrowLeft'?37:keyName==='Delete'?46:39;
  await send('Input.dispatchKeyEvent',{type:'rawKeyDown',key:keyName,code:keyName,windowsVirtualKeyCode:code,modifiers:shift?8:0});
  await send('Input.dispatchKeyEvent',{type:'keyUp',key:keyName,code:keyName,windowsVirtualKeyCode:code,modifiers:shift?8:0});await sleep(20);
}
async function state(){return ev(`(()=>{const i=editor.getInputField(),b=editor.display.input;return {code:editor.getValue(),focused:editor.state.focused,active:editor.hasFocus(),selected:editor.getSelection(),native:i.value,previous:b.prevInput,nativeSelection:[i.selectionStart,i.selectionEnd],composing:!!b.composing,range:b.composing&&b.composing.range.find(),keySeq:editor.state.keySeq,readOnly:editor.isReadOnly(),resetting:b.resetting,contextMenu:!!b.contextMenuPending};})()`);}
async function verify(name,wanted){const got=await state();eq(name,got.code,wanted);if(got.code!==wanted)console.log('Input state after failure: '+JSON.stringify(got));}
try {
  if(process.argv.includes('--android')){await send('Emulation.setUserAgentOverride',{userAgent:'Mozilla/5.0 (Linux; Android 14; Tablet) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',platform:'Linux armv8l'});await browser.reload();}
  await ev(`projectOpened({name:'Selection input',language:'python',files:[{path:'main.py',code:''},{path:'other.py',code:'other'}]});setSetting('autoComplete','0');true`);
  for(const deletion of ['Backspace','Delete','native','cut']) {
    for(const [name,code,start,end] of cases) {
      await reset(code);await ev(`editor.setSelection(editor.posFromIndex(${start}),editor.posFromIndex(${end}));true`);
      if(deletion==='Backspace')await key('Backspace');
      else if(deletion==='Delete')await arrow('Delete');
      else await ev(`(()=>{const input=editor.getInputField();${deletion==='cut'?"input.dispatchEvent(new Event('cut',{bubbles:true,cancelable:true}));":''}
        input.dispatchEvent(new InputEvent('beforeinput',{bubbles:true,inputType:${JSON.stringify(deletion==='cut'?'deleteByCut':'deleteContentBackward')}}));input.value='';input.setSelectionRange(0,0);input.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:${JSON.stringify(deletion==='cut'?'deleteByCut':'deleteContentBackward')}}));})();true`);
      eq(deletion+': removes '+name,await ev('editor.getValue()'),code.slice(0,start)+code.slice(end));
      await key('x');await typeText('你');await verify(deletion+': input after '+name,code.slice(0,start)+'x你'+code.slice(end));
    }
  }
  await reset('abcdef');await key('a',{ctrl:true});await key('Backspace');await typeText('xy');await verify('Ctrl+A deletion allows input','xy');
  await reset('abcdef');await ev('editor.setCursor(0,6);true');for(let i=0;i<4;i++)await arrow('ArrowLeft',true);await key('Backspace');await typeText('xy');await verify('Shift+Arrow selection deletion allows input','abxy');
  for(const updateKind of ['keys','native']) {
    await reset('keep ');await ev('editor.setCursor(0,5);true');
    await send('Input.imeSetComposition',{text:'abcdef',selectionStart:6,selectionEnd:6});await sleep(50);
    await ev('editor.setSelection({line:0,ch:5},{line:0,ch:11});true');
    if(updateKind==='keys')await key('Backspace');
    else await ev(`(()=>{const input=editor.getInputField();input.value='';input.setSelectionRange(0,0);input.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'deleteContentBackward'}));})();true`);
    await key('x');await typeText('y');await verify('active composition selection deletion '+updateKind,'keep xy');
    await ev(`editor.getInputField().dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}));true`);
  }
  await reset('abcdef');await ev('editor.setSelection({line:0,ch:1},{line:0,ch:5});true');await key('Backspace');
  await ev(`(()=>{const input=editor.getInputField();input.value='xy';input.setSelectionRange(0,2);input.dispatchEvent(new InputEvent('input',{bubbles:true,isComposing:true,inputType:'insertCompositionText',data:'xy'}));})();true`);await sleep(250);
  await verify('selected deletion then input-only IME update','axyf');
  await ev(`(()=>{const input=editor.getInputField();input.setSelectionRange(2,2);input.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'xy'}));})();true`);
  await typeText('z');await verify('input-only IME commit continues after selection deletion','axyzf');
  await reset('abcdef');await ev('editor.setSelection({line:0,ch:1},{line:0,ch:5});true');await key('Backspace');
  await ev(`(()=>{const input=editor.getInputField();input.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));
    input.value='xy';input.setSelectionRange(0,2);input.dispatchEvent(new InputEvent('input',{bubbles:true,isComposing:true,inputType:'insertCompositionText',data:'xy'}));
    input.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'xy'}));})();true`);
  await key('z');await verify('committed native selection must not erase preceding composition text','axyzf');
  await reset('abcdef');
  const drag=await ev(`(()=>{const a=editor.charCoords({line:0,ch:1},'window'),b=editor.charCoords({line:0,ch:5},'window');return {from:{x:a.left,y:(a.top+a.bottom)/2},to:{x:b.left,y:(b.top+b.bottom)/2}};})()`);
  await send('Input.dispatchMouseEvent',{type:'mousePressed',...drag.from,button:'left',buttons:1,clickCount:1});
  await send('Input.dispatchMouseEvent',{type:'mouseMoved',...drag.to,button:'left',buttons:1});
  await send('Input.dispatchMouseEvent',{type:'mouseReleased',...drag.to,button:'left',buttons:0,clickCount:1});await sleep(50);
  eq('actual mouse drag selects multiple characters',await ev('editor.getSelection()'),'bcde');
  await key('Backspace');
  await ev(`(()=>{const input=editor.getInputField();input.value='xy';input.setSelectionRange(0,2);input.dispatchEvent(new InputEvent('input',{bubbles:true,isComposing:true,inputType:'insertCompositionText',data:'xy'}));
    input.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'xy'}));})();true`);
  await key('z');await verify('mouse drag deletion followed by IME-only update and typing','axyzf');
  await reset('abcdef');await ev(`(()=>{const input=editor.getInputField();input.dispatchEvent(new KeyboardEvent('keyup',{key:'Tab',bubbles:true}));
    editor.setSelection({line:0,ch:1},{line:0,ch:5});})();true`);await sleep(50);
  eq('delayed Tab handling must not erase a newer mouse selection',await ev('editor.getSelection()'),'bcde');
  await reset('abcdef');await ev(`(()=>{editor.getInputField().dispatchEvent(new KeyboardEvent('keyup',{key:'Tab',bubbles:true}));
    switchProjectFile('other.py');editor.setSelection({line:0,ch:0},{line:0,ch:5});})();true`);await sleep(50);
  eq('delayed Tab handling must not change another document selection',await ev('editor.getSelection()'),'other');
  await ev('switchProjectFile("main.py");editor.focus();true');
  await reset('complete_alpha=1\ncomplete_bravo=2\n');await ev('editor.setCursor(2,0);true');
  await ev(`(()=>{const input=editor.getInputField();input.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));input.value='complete_';input.setSelectionRange(9,9);
    input.dispatchEvent(new InputEvent('input',{bubbles:true,isComposing:true,inputType:'insertCompositionText',data:'complete_'}));
    input.dispatchEvent(new InputEvent('input',{bubbles:true,isComposing:false,inputType:'insertText',data:'complete_'}));})();true`);
  await ev('triggerCompletion();true');await sleep(80);await key('Tab');await sleep(80);
  eq('committed input without compositionend must not block Tab completion',await ev('editor.getLine(2)'),'complete_alpha');
  await reset('abcdef');await ev(`editor.getInputField().dispatchEvent(new Event('copy',{bubbles:true,cancelable:true}));
    editor.getInputField().dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}));true`);
  await key('x');await verify('late compositionend must not turn the clipboard mirror into input','xabcdef');
  await reset('abcdef');await ev('editor.setSelection({line:0,ch:1},{line:0,ch:5});true');
  await ev(`(()=>{const input=editor.getInputField();input.value='xy';input.setSelectionRange(0,2);input.dispatchEvent(new InputEvent('input',{bubbles:true,isComposing:false,inputType:'insertText',data:'xy'}));})();true`);await sleep(100);
  await verify('committed native selection replaces the actual document selection','axyf');
  await reset('abcdef');await ev(`(()=>{const pos=editor.charCoords({line:0,ch:3},'window');editor.getScrollerElement().dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,button:2,clientX:pos.left,clientY:pos.top+5}));})();true`);await sleep(80);
  const menuRef=await ev('!!editor.display.selForContextMenu');
  ok('native context-menu selection marker is present for the replay',menuRef);
  await ev('editor.setSelection({line:0,ch:1},{line:0,ch:5});true');await key('Backspace');
  await ev(`(()=>{const input=editor.getInputField();input.value='xy';input.setSelectionRange(0,2);input.dispatchEvent(new InputEvent('input',{bubbles:true,isComposing:false,inputType:'insertText',data:'xy'}));})();true`);await sleep(100);
  await verify('stale context-menu selection cannot block input after deletion','axyf');
  await reset('a\nb');await ev('editor.setSelection({line:0,ch:0},{line:1,ch:1});true');await key('Tab');
  ok('Tab indentation preserves the selected text across lines',await ev('editor.getSelection().includes("a")&&editor.getSelection().includes("b")'));
  await key('Tab',{shift:true});
  ok('Shift+Tab unindent preserves the selected text',await ev('editor.getSelection().includes("a")&&editor.getSelection().includes("b")'));
  await reset('abcdef');await ev(`editor.setSelection({line:0,ch:1},{line:0,ch:5});
    (()=>{const input=editor.getInputField(),event=new Event('paste',{bubbles:true,cancelable:true});Object.defineProperty(event,'clipboardData',{value:{getData:()=> '粘贴'}});input.dispatchEvent(event);})();true`);
  await key('z');await verify('paste replacing a selection allows subsequent input','a粘贴zf');
  await reset('abcdef');await ev('editor.setSelection({line:0,ch:1},{line:0,ch:5});true');await key('Backspace');await key('z',{ctrl:true});await key('y',{ctrl:true});await typeText('xy');
  await verify('undo/redo after selected deletion leaves input ready','axyf');
  for(let i=0;i<60;i++) {
    const [,code,start,end]=cases[i%cases.length];await reset(code);
    await ev(`editor.setSelection(editor.posFromIndex(${start}),editor.posFromIndex(${end}));true`);
    if(i%2===0)await key('Backspace');else await arrow('Delete');
    await ev(`(()=>{editor.focus();if(!editor.hasFocus())throw new Error('IME replay target is not focused');const input=editor.getInputField();
      ${i%3===0?"input.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));":''}
      input.value='ni';input.setSelectionRange(0,2);
      input.dispatchEvent(new InputEvent('input',{bubbles:true,isComposing:true,inputType:'insertCompositionText',data:'ni'}));
      input.value='你';input.setSelectionRange(0,1);
      ${i%3===1?"input.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'你'}));":''}
      input.dispatchEvent(new InputEvent('input',{bubbles:true,isComposing:false,inputType:'insertText',data:'你'}));
      ${i%3===2?"input.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'你'}));":''}
    })();true`);
    await key('z');await verify('repeated selection/IME transition '+i,code.slice(0,start)+'你z'+code.slice(end));
  }
  ok('no browser exceptions: '+browser.errors.join(' | '),browser.errors.length===0);
}catch(error){ok('script error: '+error.stack,false);}
const failures=report('Selection input continuity'+(process.argv.includes('--android')?' (Android UA)':''));await browser.close();process.exit(failures?1:0);
