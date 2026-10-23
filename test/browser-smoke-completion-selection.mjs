import {launch,checker,sleep} from './browser-lib.mjs';
const browser=await launch({width:1557,height:973});
if(!browser){console.log('SKIP: Edge/Chrome not found');process.exit(0);}
const {ev,key,typeText,send}=browser,{ok,eq,report}=checker();
const source='complete_alpha=1\ncomplete_bravo=2\ncomplete_charlie=3\ncomplete_';
const selected=`(()=>{const cs=editor.state.completionActive,w=cs&&cs.widget,item=w&&w.data.list[w.selectedHint];return item&&(typeof item==='string'?item:item.text);})()`;
async function open() {
  await ev(`editor.closeHint();editor.setValue(${JSON.stringify(source)});editor.setCursor(3,9);editor.focus();triggerCompletion();true`);
  for(let i=0;i<30;i++){if(await ev('hintWidgetOpen(editor)'))return;await sleep(30);}
  throw new Error('Completion widget did not open');
}
async function arrow(direction) {
  const code=direction==='ArrowDown'?40:38;
  await send('Input.dispatchKeyEvent',{type:'rawKeyDown',key:direction,code:direction,windowsVirtualKeyCode:code});
  await send('Input.dispatchKeyEvent',{type:'keyUp',key:direction,code:direction,windowsVirtualKeyCode:code});
  await sleep(30);
}
try {
  if(process.argv.includes('--android')) {
    await send('Emulation.setUserAgentOverride',{userAgent:'Mozilla/5.0 (Linux; Android 14; Tablet) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',platform:'Linux armv8l'});
    await browser.reload();
  }
  await ev(`projectOpened({name:'Selection',language:'python',files:[{path:'main.py',code:${JSON.stringify(source)}}]});setSetting('autoComplete','0');true`);
  for(let i=0;i<3;i++) {
    await open();const first=await ev(selected);await arrow('ArrowDown');const wanted=await ev(selected);
    ok('arrow selects a different item '+i,!!wanted&&wanted!==first);
    await key('Tab');
    eq('Tab accepts the highlighted item '+i,await ev('editor.getLine(3)'),wanted);
    eq('Tab closes the candidate list '+i,await ev('hintWidgetOpen(editor)'),false);
  }
  for(let i=0;i<2;i++) {
    await ev(`editor.closeHint();editor.setValue(${JSON.stringify(source.slice(0,-9))});editor.setCursor(3,0);editor.focus();true`);
    await send('Input.imeSetComposition',{text:'complete_',selectionStart:9,selectionEnd:9});await sleep(60);
    await ev('triggerCompletion();true');await sleep(80);
    const first=await ev(selected);await arrow('ArrowDown');const wanted=await ev(selected);
    ok('composition: arrow selects another item '+i,!!wanted&&wanted!==first);
    eq('composition is still active before Tab '+i,await ev('!!editor.display.input.composing'),true);
    await send('Input.dispatchKeyEvent',{type:'rawKeyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
    await send('Input.insertText',{text:'complete_'});
    await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});await sleep(160);
    eq('composition: Tab accepts the highlighted item after commit '+i,await ev('editor.getLine(3)'),wanted);
  }
  await open();await arrow('ArrowDown');await arrow('ArrowDown');await arrow('ArrowUp');
  let wanted=await ev(selected);await key('Tab');eq('up/down navigation accepts the final highlighted item',await ev('editor.getLine(3)'),wanted);
  await open();await arrow('ArrowUp');wanted=await ev(selected);await key('Tab');
  eq('wrapped selection accepts the last item',await ev('editor.getLine(3)'),wanted);
  await open();await arrow('ArrowDown');wanted=await ev(selected);await typeText('\t');await sleep(100);
  eq('Tab delivered as text accepts the highlighted item',await ev('editor.getLine(3)'),wanted);
  await open();await arrow('ArrowDown');wanted=await ev(selected);
  await ev('editor.state.completionActive.update();true');await sleep(80);
  eq('explicit candidate refresh preserves the selected item',await ev(selected),wanted);
  await key('Enter');eq('Enter after refresh accepts the selected item',await ev('editor.getLine(3)'),wanted);
  await open();await arrow('ArrowDown');
  await typeText('c');await ev('editor.state.completionActive.update();true');await sleep(80);
  eq('filtering out the old selection chooses a valid new candidate',await ev(selected),'complete_charlie');
  await key('Tab');eq('Tab never inserts a filtered-out candidate',await ev('editor.getLine(3)'),'complete_charlie');
  await ev(`projectOpened({name:'Clangd',language:'c',files:[{path:'main.c',code:${JSON.stringify(source)}}]});
    window.__originalFetch=window.fetch;window.__originalReady=toolchainReady;toolchainReady=()=>true;
    window.fetch=(url,opts)=>String(url).includes('/intel/completion') ? new Promise(resolve=>{window.__completeRemote=()=>resolve(new Response(JSON.stringify({items:[{label:'complete_charlie',insertText:'complete_charlie',sortText:'1'}]}),{status:200}));}) : window.__originalFetch(url,opts);
    clangdCompletionCache.key='';clangdCompletionCache.items=null;true`);
  await open();await arrow('ArrowDown');wanted=await ev(selected);
  await ev('window.__completeRemote();true');await sleep(180);
  eq('async clangd merge preserves the selected candidate by text',await ev(selected),wanted);
  await key('Tab');eq('Tab accepts the selection after clangd reorders the list',await ev('editor.getLine(3)'),wanted);
  await ev('window.fetch=window.__originalFetch;toolchainReady=window.__originalReady;true');
  await browser.setViewport(1557,973,true);await open();
  wanted=await ev(`(()=>{const cs=editor.state.completionActive,item=cs.widget.data.list[1];return typeof item==='string'?item:item.text;})()`);
  const tapPoint=await ev(`(()=>{const r=editor.state.completionActive.widget.hints.children[1].getBoundingClientRect();return {x:r.left+10,y:r.top+r.height/2};})()`);
  await browser.tap(tapPoint.x,tapPoint.y);
  eq('native touch chooses the second candidate exactly once',await ev('editor.getLine(3)'),wanted);
  eq('native touch keeps the input focused',await ev('editor.hasFocus()'),true);
  await open();
  await ev(`(()=>{const item=editor.state.completionActive.widget.hints.children[1],r=item.getBoundingClientRect(),base={bubbles:true,cancelable:true,pointerType:'touch',pointerId:7,clientX:r.left+10,clientY:r.top+10};
    item.dispatchEvent(new PointerEvent('pointerdown',base));item.dispatchEvent(new PointerEvent('pointermove',{...base,clientY:base.clientY+20}));item.dispatchEvent(new PointerEvent('pointerup',{...base,clientY:base.clientY+20}));})();true`);
  eq('scrolling the candidates must not accept an item',await ev('editor.getLine(3)'),'complete_');
  await ev('editor.closeHint();true');
  await open();await ev(`(()=>{const item=editor.state.completionActive.widget.hints.children[1],r=item.getBoundingClientRect(),base={bubbles:true,cancelable:true,pointerType:'touch',pointerId:8,clientX:r.left+10,clientY:r.top+10};
    item.dispatchEvent(new PointerEvent('pointerdown',base));item.dispatchEvent(new PointerEvent('pointercancel',base));item.dispatchEvent(new PointerEvent('pointerup',base));})();true`);
  eq('cancelled candidate gesture must not accept an item',await ev('editor.getLine(3)'),'complete_');
  ok('no browser exceptions: '+browser.errors.join(' | '),browser.errors.length===0);
}catch(error){ok('script error: '+error.stack,false);}
const failures=report('Completion selection'+(process.argv.includes('--android')?' (Android UA)':''));await browser.close();process.exit(failures?1:0);
