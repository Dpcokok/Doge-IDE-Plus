// Editor input continuity through IME, completion, overlays and focus changes.
import {launch, checker, sleep} from './browser-lib.mjs';

const browser = await launch({width:1557,height:973});
if (!browser) {console.log('SKIP: Edge/Chrome not found');process.exit(0);}
const {ev, key, typeText, send} = browser;
const {ok, eq, report} = checker();
async function reset(code='') {
  await ev(`editor.closeHint();editor.setValue(${JSON.stringify(code)});editor.setCursor(editor.lastLine(),editor.getLine(editor.lastLine()).length);editor.focus();true`);
  await sleep(80);
}

try {
  if (process.argv.includes('--android')) {
    await send('Emulation.setUserAgentOverride',{userAgent:'Mozilla/5.0 (Linux; Android 14; Tablet) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',platform:'Linux armv8l'});
    await browser.reload();
  }
  await ev(`window.projectOpened({name:'Input',language:'python',files:[{path:'main.py',code:''},{path:'other.py',code:'other'}]});setSetting('autoComplete','0');editor.focus();true`);
  for (const text of ['(','a',')','[','b',']','\t','c']) {
    await typeText(text);
  }
  eq('brackets and input continue normally',await ev('editor.getValue()'),'(a)[b]\tc');

  await reset('keep');
  await ev(`window.dispatchEvent(new Event('blur'));window.dispatchEvent(new Event('focus'));true`);
  await key('x');await key('y');
  eq('hardware typing resumes after window focus returns with the same active input',await ev('editor.getValue()'),'keepxy');
  eq('editor focus state agrees with the active textarea after returning',await ev('editor.state.focused && document.activeElement===editor.getInputField()'),true);
  await ev('editor.getInputField().blur();editor.focus();true');

  await reset('keep');
  await ev(`window.dispatchEvent(new Event('blur'));true`);
  await key('x');
  eq('first hardware key recovers when the window focus event is missing',await ev('editor.getValue()'),'keepx');

  await reset('keep');await typeText('z');
  await ev(`window.dispatchEvent(new Event('blur'));
    (()=>{const input=editor.getInputField();input.value+='你x';input.setSelectionRange(input.value.length,input.value.length);
      input.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:'你x'}));})();true`);
  eq('input-only commit preserves pending text and its existing input baseline',await ev('editor.getValue()'),'keepz你x');
  await key('y');
  eq('hardware input continues after input-only focus recovery',await ev('editor.getValue()'),'keepz你xy');
  await sleep(150);
  eq('recovery does not duplicate committed characters on later polls',await ev('editor.getValue()'),'keepz你xy');

  await reset('value');await ev(`editor.setSelection({line:0,ch:1},{line:0,ch:4});window.dispatchEvent(new Event('blur'));window.dispatchEvent(new Event('focus'));true`);
  eq('window focus recovery preserves the document selection',await ev('editor.getSelection()'),'alu');
  await key('x');
  eq('hardware typing replaces the original selection after recovery',await ev('editor.getValue()'),'vxe');

  await reset('value');
  await ev(`editor.setSelection({line:0,ch:1},{line:0,ch:4});window.dispatchEvent(new Event('blur'));
    (()=>{const input=editor.getInputField();input.value='你';input.setSelectionRange(1,1);
      input.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:'你'}));})();true`);
  eq('input-only focus recovery replaces the selected range without losing the commit',await ev('editor.getValue()'),'v你e');

  await reset('keep');await ev(`editor.setOption('readOnly',true);window.dispatchEvent(new Event('blur'));window.dispatchEvent(new Event('focus'));true`);
  await key('x');
  eq('window focus recovery respects read-only documents',await ev('editor.getValue()'),'keep');
  await ev(`editor.setOption('readOnly',false);true`);await key('y');
  eq('hardware input resumes when the recovered document becomes writable',await ev('editor.getValue()'),'keepy');

  await reset('keep');await key('x');
  await ev(`window.dispatchEvent(new Event('blur'));window.dispatchEvent(new Event('focus'));true`);
  await key('z',{ctrl:true});
  eq('focus recovery preserves undo history',await ev('editor.getValue()'),'keep');

  await reset();await send('Input.imeSetComposition',{text:'ni',selectionStart:2,selectionEnd:2});await sleep(60);
  await ev(`window.dispatchEvent(new Event('blur'));true`);
  eq('window blur ends composition even if the textarea remains active',await ev('!!editor.display.input.composing'),false);
  eq('window blur preserves the current composition text',await ev('editor.getValue()'),'ni');
  await ev(`window.dispatchEvent(new Event('focus'));true`);await key('x');
  eq('hardware typing continues after an interrupted window composition',await ev('editor.getValue()'),'nix');
  await ev(`editor.getInputField().dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}));true`);

  await reset('keep');await ev('openSettings();true');await sleep(60);
  const modalFocus = await ev('document.activeElement.id');
  await ev(`window.dispatchEvent(new Event('blur'));window.dispatchEvent(new Event('focus'));true`);
  eq('window focus recovery keeps focus in an open dialog',await ev('document.activeElement.id'),modalFocus);
  eq('window focus recovery does not focus the editor behind a dialog',await ev('editor.hasFocus()'),false);
  await ev('hideModal("settingsModal");true');await sleep(60);

  for (let i=0;i<10;i++) {
    await ev(`window.dispatchEvent(new Event('blur'));window.dispatchEvent(new Event('focus'));true`);
    await key('a');
  }
  eq('repeated window switches accept every hardware character once',await ev('editor.getValue()'),'keep'+'a'.repeat(10));

  await reset('pr');await ev('setSetting("autoComplete","1");triggerCompletion();true');await sleep(250);
  await ev(`window.dispatchEvent(new Event('blur'));window.dispatchEvent(new Event('focus'));true`);
  await key('Tab');await key('x');
  eq('Tab completion and hardware typing survive window focus recovery',await ev('editor.getValue()'),'printx');
  await ev('setSetting("autoComplete","0");true');

  await reset();
  await send('Input.imeSetComposition',{text:'ni',selectionStart:2,selectionEnd:2});
  await sleep(60);
  await ev(`openSettings();true`);await sleep(50);
  await ev(`hideModal('settingsModal');true`);await sleep(80);
  eq('closing settings returns focus to the editor',await ev('editor.hasFocus()'),true);
  await typeText('你');await typeText('x');
  ok('typing after interrupted composition remains accepted',await ev('editor.getValue().endsWith("你x")'));

  await reset();
  await send('Input.imeSetComposition',{text:'ni',selectionStart:2,selectionEnd:2});await sleep(60);
  await ev('switchProjectFile("other.py");editor.focus();editor.setCursor(0,5);true');await sleep(80);
  eq('file swap clears the previous IME composition',await ev('!!editor.display.input.composing'),false);
  await typeText('x');
  eq('typing after file swap remains accepted',await ev('editor.getValue()'),'otherx');
  await ev(`editor.getInputField().dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}));true`);

  await reset();
  for (let i=0;i<3;i++) {
    await ev(`(()=>{const input=editor.getInputField();input.value='candidate${i}';input.setSelectionRange(0,input.value.length);input.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:input.value}));})();true`);
    await sleep(250);
    eq('native input selection does not block committed text '+i,await ev('editor.getValue()'),'candidate'+i);
    await typeText('x');
    eq('typing continues after recovery '+i,await ev('editor.getValue()'),'candidate'+i+'x');
    await reset();
  }

  await reset();await typeText('x');await key('Tab');await typeText('y');
  ok('typing after Tab remains accepted',await ev('editor.getValue().endsWith("y")'));
  await reset();await ev('openCommandPalette();true');await sleep(80);await key('Escape');await typeText('x');
  eq('closing palette restores editor typing',await ev('editor.getValue()'),'x');

  await reset('value');
  await ev('editor.setSelection({line:0,ch:0},{line:0,ch:5});true');await typeText('new');
  eq('normal document selection still replaces text',await ev('editor.getValue()'),'new');
  await reset('keep');await ev('editor.setOption("readOnly",true);true');await typeText('discard');
  eq('read-only documents remain unchanged',await ev('editor.getValue()'),'keep');
  await ev('editor.setOption("readOnly",false);true');await typeText('x');
  eq('read-only exit resumes input',await ev('editor.getValue()'),'keepx');

  await reset();
  await ev(`(()=>{const input=editor.getInputField();input.value='pending';input.setSelectionRange(0,7);
    input.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertCompositionText',isComposing:true,data:'pending'}));})();true`);
  eq('input-only composition updates its tracked document range',await ev('editor.getValue()'),'pending');
  eq('uncommitted native selection is preserved',await ev('[editor.getInputField().selectionStart,editor.getInputField().selectionEnd]'),[0,7]);
  await reset();
  await ev(`(()=>{const input=editor.getInputField();input.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));
    input.value='ni';input.setSelectionRange(2,2);input.dispatchEvent(new InputEvent('input',{bubbles:true,isComposing:true}));})();true`);
  eq('active composition updates document normally',await ev('editor.getValue()'),'ni');
  await ev('openSettings();true');await sleep(40);
  eq('blur clears composition even without a native end event',await ev('!!editor.display.input.composing'),false);
  await ev('hideModal("settingsModal");true');await sleep(40);await typeText('x');
  eq('blur preserves text and subsequent input',await ev('editor.getValue()'),'nix');

  await reset();
  await ev(`(()=>{const input=editor.getInputField();input.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));
    input.value='(';input.setSelectionRange(1,1);input.dispatchEvent(new InputEvent('input',{bubbles:true,isComposing:true}));
    input.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}));switchProjectFile('main.py');})();true`);
  await sleep(80);
  ok('pending bracket completion cannot modify another file',await ev('!editor.getValue().includes(")")'));
  await reset();await typeText('[');await typeText('a');await typeText(']');await typeText('z');
  eq('bracket input resumes after interrupted composition',await ev('editor.getValue()'),'[a]z');

  await reset('pr');await ev('setSetting("autoComplete","1");triggerCompletion();true');await sleep(250);
  ok('completion widget is available',await ev('hintWidgetOpen(editor)'));
  await key('Tab');await typeText('x');
  ok('input continues after accepting completion',await ev('editor.getValue().endsWith("x") && editor.getValue().startsWith("print")'));

  await reset('pr');await ev('triggerCompletion();true');await sleep(250);await typeText('i\t');await sleep(150);
  eq('IME final letter and text Tab accept the updated prefix',await ev('editor.getValue()'),'print');
  await typeText('x');eq('typing after text Tab remains accepted',await ev('editor.getValue()'),'printx');

  await reset('pr');await ev('triggerCompletion();true');await sleep(250);
  await ev(`(()=>{const input=editor.getInputField();input.value='i\t';input.setSelectionRange(2,2);
    input.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:'i\t'}));
    openSettings();})();true`);await sleep(50);
  const textTabAfterBlur = await ev('editor.getValue()');
  ok('last letter is not discarded when focus changes during text Tab (got '+JSON.stringify(textTabAfterBlur)+')',textTabAfterBlur.startsWith('pri'));
  await ev('hideModal("settingsModal");setSetting("autoComplete","0");true');await sleep(60);

  for (let i=0;i<8;i++) {
    await reset();await send('Input.imeSetComposition',{text:'ni',selectionStart:2,selectionEnd:2});await sleep(30);
    await ev(`switchProjectFile(${JSON.stringify(i%2===0?'other.py':'main.py')});editor.focus();editor.setCursor(editor.lastLine(),editor.getLine(editor.lastLine()).length);true`);
    eq('repeat '+i+': composition ends on file swap',await ev('!!editor.display.input.composing'),false);
    await typeText('你');await typeText('x');
    ok('repeat '+i+': committed Unicode and continued input preserved',await ev('editor.getValue().endsWith("你x")'));
  }

  await ev('openProjectSearch();true');await sleep(60);
  await ev('openCommandPalette();true');await sleep(60);await key('Escape');
  eq('palette also restores a search field, without stealing focus',await ev('document.activeElement.id'),'searchInput');
  await ev(`window.dispatchEvent(new Event('blur'));window.dispatchEvent(new Event('focus'));true`);
  eq('window focus recovery keeps the active project search field',await ev('document.activeElement.id'),'searchInput');
  ok('no browser exceptions',browser.errors.length===0);
} catch (error) {ok('script error: '+error.message,false);}
const failures=report('Editor input continuity'+(process.argv.includes('--android')?' (Android UA)':''));await browser.close();process.exit(failures?1:0);
