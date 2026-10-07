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
  await ev(`window.projectOpened({name:'Input',language:'python',files:[{path:'main.py',code:''},{path:'other.py',code:'other'}]});setSetting('autoComplete','0');editor.focus();true`);
  for (const text of ['(','a',')','[','b',']','\t','c']) {
    await typeText(text);
  }
  eq('brackets and input continue normally',await ev('editor.getValue()'),'(a)[b]\tc');

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
  eq('uncommitted selected composition is not force-read',await ev('editor.getValue()'),'');
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
  ok('last letter is not discarded when focus changes during text Tab',await ev('editor.getValue().startsWith("pri")'));
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
  ok('no browser exceptions',browser.errors.length===0);
} catch (error) {ok('script error: '+error.message,false);}
const failures=report('Editor input continuity');await browser.close();process.exit(failures?1:0);
