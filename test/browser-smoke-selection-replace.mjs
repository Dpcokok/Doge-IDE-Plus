import {launch, checker, sleep} from './browser-lib.mjs';

const browser = await launch({width:1280,height:800});
if (!browser) throw new Error('Edge/Chrome is required for selected replacement regression');
const {ev,key,send} = browser;
const {ok,eq,report} = checker();
async function reset(code = 'before input after') {
  await ev(`editor.getInputField().blur();finishEditorComposition(editor);editor.closeHint();
    editor.setValue(${JSON.stringify(code)});editor.focus();
    editor.setSelection({line:0,ch:7},{line:0,ch:12});true`);
  await sleep(30);
}
try {
  await send('Emulation.setUserAgentOverride',{userAgent:'Mozilla/5.0 (Linux; Android 14; Tablet) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',platform:'Linux armv8l'});
  await browser.reload();
  await ev(`projectOpened({name:'Selected replacement',language:'python',files:[{path:'main.py',code:''}]});true`);
  for (const char of ['a','7']) {
    await reset();await key(char);await key('z');
    eq('hardware '+char+' replaces selected input and continues',await ev('editor.getValue()'),'before '+char+'z after');
  }
  await reset();await ev('editor.setCursor(0,0);true');
  const drag = await ev(`(() => {const a=editor.charCoords({line:0,ch:7},'window'),b=editor.charCoords({line:0,ch:12},'window');
    return {from:{x:a.left,y:(a.top+a.bottom)/2},to:{x:b.left,y:(b.top+b.bottom)/2}};})()`);
  await send('Input.dispatchMouseEvent',{type:'mousePressed',...drag.from,button:'left',buttons:1,clickCount:1});
  await send('Input.dispatchMouseEvent',{type:'mouseMoved',...drag.to,button:'left',buttons:1});
  await send('Input.dispatchMouseEvent',{type:'mouseReleased',...drag.to,button:'left',buttons:0,clickCount:1});
  eq('mouse drag selects the reported word',await ev('editor.getSelection()'),'input');
  await key('7');await key('z');
  eq('mouse-selected word accepts hardware number and keeps typing',await ev('editor.getValue()'),'before 7z after');
  for (const composing of [false,true]) {
    for (const eventOrder of ['full','input-only','end-before-input']) {
      await reset();
      await ev(`(() => {const input=editor.getInputField();
        ${composing && eventOrder!=='input-only' ? "input.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));" : ''}
        input.value='x';input.setSelectionRange(0,1);
        ${composing && eventOrder==='end-before-input' ? "input.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'x'}));" : ''}
        input.dispatchEvent(new InputEvent('input',{bubbles:true,isComposing:${composing},inputType:${JSON.stringify(composing?'insertCompositionText':'insertText')},data:'x'}));
        ${composing && eventOrder!=='end-before-input' ? "input.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'x'}));" : ''}
      })();true`);
      await sleep(150);await key('z');
      eq('selected native replacement '+composing+'/'+eventOrder,await ev('editor.getValue()'),'before xz after');
    }
  }
  // Physical key delivery still passes through the Android IME. Exercise the
  // actual browser composition protocol while a document selection is mirrored.
  for (const candidate of ['a','7','ni']) {
    await reset();
    await send('Input.imeSetComposition',{text:candidate,selectionStart:candidate.length,selectionEnd:candidate.length});
    await send('Input.insertText',{text:candidate});await key('z');
    eq('CDP composition replaces selection '+candidate,await ev('editor.getValue()'),'before '+candidate+'z after');
  }
  ok('no browser exceptions: '+browser.errors.join(' | '),browser.errors.length===0);
} catch (error) { ok('script error: '+error.stack,false); }
finally { await browser.close(); }
process.exitCode = report('Selected text replacement');
