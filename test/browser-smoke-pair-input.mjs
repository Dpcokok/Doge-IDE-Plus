import {launch,checker,sleep} from './browser-lib.mjs';
const browser=await launch({width:1557,height:973});
if(!browser){console.log('SKIP: Edge/Chrome not found');process.exit(0);}
const {ev,key,typeText,send}=browser,{ok,eq,report}=checker();
async function reset() {
  await ev('editor.getInputField().blur();editor.closeHint();editor.setValue("");editor.setCursor(0,0);editor.focus();true');await sleep(50);
}
async function snapshot(){return ev(`(()=>{const input=editor.getInputField(),b=editor.display.input;return {code:editor.getValue(),focus:editor.state.focused,active:editor.hasFocus(),selected:editor.somethingSelected(),value:input.value,previous:b.prevInput,selection:[input.selectionStart,input.selectionEnd],composing:!!b.composing,keySeq:editor.state.keySeq,disabled:editor.getOption('disableInput'),readOnly:editor.isReadOnly()};})()`);}
try {
  if(process.argv.includes('--android')) {
    await send('Emulation.setUserAgentOverride',{userAgent:'Mozilla/5.0 (Linux; Android 14; Tablet) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',platform:'Linux armv8l'});await browser.reload();
  }
  await ev(`projectOpened({name:'Pairs',language:'python',files:[{path:'main.py',code:''}]});setSetting('autoComplete','0');true`);
  for(let i=0;i<3;i++) {
    await reset();await typeText('(');await send('Input.imeSetComposition',{text:'ab',selectionStart:2,selectionEnd:2});await sleep(60);
    await key('Backspace');await key('Backspace');await key('Backspace');
    await key('x');await typeText('y');const after=await snapshot();
    eq('composition: input continues after deleting contents and brackets '+i,after.code,'xy');
  }
  for(const inputMode of ['keys','text']) {
    for(const [left,right] of [['(',')'],['[',']'],['{','}']]) {
      for(let i=0;i<3;i++) {
        await reset();
        if(inputMode==='keys'){await key(left);await key('a');await key('b');}
        else {await typeText(left);await typeText('ab');}
        eq(inputMode+': populated pair '+left+' '+i,await ev('editor.getValue()'),left+'ab'+right);
        await key('Backspace');await key('Backspace');
        eq(inputMode+': contents removed '+left+' '+i,await ev('editor.getValue()'),left+right);
        await key('Backspace');eq(inputMode+': empty pair removed '+left+' '+i,await ev('editor.getValue()'),'');
        await key('x');await typeText('y');
        const state=await snapshot();eq(inputMode+': input continues after pair removal '+left+' '+i,state.code,'xy');
      }
    }
  }
  for(const [left,right] of [['(',')'],['[',']'],['{','}']]) {
    await reset();await typeText(left);await typeText('ab');
    await ev('editor.setSelection({line:0,ch:1},{line:0,ch:3});true');await key('Backspace');await key('Backspace');await typeText('xy');
    eq('selected contents then empty pair deletion accepts input '+left,await ev('editor.getValue()'),'xy');
    await reset();await typeText(left);await typeText('ab');await key('Backspace');await key('Backspace');
    await ev('editor.setCursor(0,2);true');await key('Backspace');await key('Backspace');await typeText('xy');
    eq('deleting each bracket separately accepts input '+left,await ev('editor.getValue()'),'xy');
  }
  for(const [language,path] of [['c','main.c'],['cpp','main.cpp'],['python','main.py']]) {
    await ev(`projectOpened({name:'Pairs',language:${JSON.stringify(language)},files:[{path:${JSON.stringify(path)},code:''}]});true`);
    for(const [left,right] of [["'","'"],['"','"'],['`','`'],['‘','’'],['“','”'],['（','）'],['［','］'],['｛','｝'],['【','】'],['「','」'],['『','』'],['《','》']]) {
      await reset();await typeText(left);
      eq(language+': text input pairs '+left,await ev('editor.getValue()'),left+right);
      eq(language+': cursor stays inside '+left,await ev('editor.getCursor().ch'),1);
      await typeText('ab');await typeText(right);
      eq(language+': typing the existing right symbol skips it '+right,await ev('editor.getValue()'),left+'ab'+right);
      await ev('editor.setCursor(0,3);true');await key('Backspace');await key('Backspace');await key('Backspace');
      eq(language+': deleting contents and the pair leaves an editable document '+left,await ev('editor.getValue()'),'');
      await key('x');eq(language+': input after deleting '+left,await ev('editor.getValue()'),'x');
      await reset();await typeText(left);await key('z',{ctrl:true});
      eq(language+': one undo removes the auto pair '+left,await ev('editor.getValue()'),'');
    }
    for(const char of ["'",'"','`']) {
      await reset();await key(char);eq(language+': hardware quote pairing '+char,await ev('editor.getValue()'),char+char);
      await key('Backspace');await key('x');eq(language+': hardware quote deletion keeps typing '+char,await ev('editor.getValue()'),'x');
    }
    await reset();await typeText('word');await typeText("'");
    eq(language+': apostrophe after a word is literal',await ev('editor.getValue()'),"word'");
    await reset();await typeText('\\');await typeText('"');
    eq(language+': escaped quote is literal',await ev('editor.getValue()'),'\\"');
    await reset();await typeText('"');await typeText('\\');await typeText('"');
    eq(language+': escaped quote inside a string does not skip the closing quote',await ev('editor.getValue()'),'"\\""');
    await reset();await typeText('paste "literal"');
    eq(language+': pasted text is unchanged',await ev('editor.getValue()'),'paste "literal"');
  }
  for(const [left,right] of [["'","'"],['"','"'],['‘','’'],['“','”'],['【','】']]) {
    await reset();await typeText('value');await ev('editor.setSelection({line:0,ch:0},{line:0,ch:5});true');await typeText(left);
    eq('selected text is wrapped in '+left,await ev('editor.getValue()'),left+'value'+right);
  }
  for(const char of ["'",'"']) {
    await reset();await key(char);await key(char);await key(char);
    eq('Python hardware triple quote behavior is preserved '+char,await ev('editor.getValue()'),char.repeat(6));
    await reset();await send('Input.imeSetComposition',{text:char,selectionStart:1,selectionEnd:1});await sleep(50);
    await send('Input.insertText',{text:char});await sleep(100);
    eq('committed IME quote pairs exactly once '+char,await ev('editor.getValue()'),char+char);
    await key('Backspace');await key('x');eq('typing after committed IME quote removal '+char,await ev('editor.getValue()'),'x');
  }
  await ev('setSetting("autoCloseBrackets","0");applyEditorPreferences();true');
  await reset();await typeText('“');eq('pair setting also disables Chinese quotes',await ev('editor.getValue()'),'“');
  await ev('setSetting("autoCloseBrackets","1");applyEditorPreferences();true');
  await reset();await ev('editor.setOption("readOnly",true);true');await typeText('"');eq('read-only documents remain unchanged',await ev('editor.getValue()'),'');
  await ev('editor.setOption("readOnly",false);true');
  await reset();await ev('editor.setValue("a\\nb");editor.setSelections([{anchor:{line:0,ch:1},head:{line:0,ch:1}},{anchor:{line:1,ch:1},head:{line:1,ch:1}}]);true');await typeText('‘');
  eq('direct text at multiple cursors preserves each native input',await ev('editor.getValue()'),'a‘\nb‘');
  await reset();await typeText('(');await typeText('ab');
  await key('Backspace');await key('Backspace');await key('Backspace');
  await ev(`(()=>{const input=editor.getInputField();input.dispatchEvent(new CompositionEvent('compositionupdate',{bubbles:true,data:'xy'}));
    input.value='xy';input.setSelectionRange(0,2);
    input.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertCompositionText',isComposing:true,data:'xy'}));})();true`);
  await sleep(220);
  eq('IME update after pair deletion is read even when compositionstart was omitted',await ev('editor.getValue()'),'xy');
  await ev(`(()=>{const input=editor.getInputField();input.setSelectionRange(input.value.length,input.value.length);
    input.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'xy'}));})();true`);
  await key('z');eq('typing continues after the resumed IME commit',await ev('editor.getValue()'),'xyz');
  await reset();await typeText('(');await typeText('ab');await key('Backspace');await key('Backspace');await key('Backspace');
  await ev(`(()=>{const input=editor.getInputField();input.dispatchEvent(new InputEvent('beforeinput',{bubbles:true,inputType:'insertCompositionText',isComposing:true,data:'ni'}));
    input.value='ni';input.setSelectionRange(0,2);input.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertCompositionText',isComposing:true,data:'ni'}));})();true`);
  eq('beforeinput starts the missing IME range without discarding the candidate',await ev('editor.getValue()'),'ni');
  eq('active IME selection remains intact during recovery',await ev('[editor.getInputField().selectionStart,editor.getInputField().selectionEnd]'),[0,2]);
  await ev(`(()=>{const input=editor.getInputField();input.setSelectionRange(2,2);input.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'ni'}));})();true`);
  await typeText('x');eq('typing resumes after beforeinput recovery',await ev('editor.getValue()'),'nix');
  ok('no browser exceptions: '+browser.errors.join(' | '),browser.errors.length===0);
}catch(error){ok('script error: '+error.stack,false);}
const failures=report('Pair input continuity'+(process.argv.includes('--android')?' (Android UA)':''));await browser.close();process.exit(failures?1:0);
