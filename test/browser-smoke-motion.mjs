// Real caret motion, geometry and input continuity. No document decorations or input interception.
import {launch,checker,sleep} from './browser-lib.mjs';
import {writeFileSync} from 'node:fs';
const browser=await launch({width:1557,height:973});
if(!browser){console.log('SKIP: Edge/Chrome not found');process.exit(0);}
const {ev,key,typeText,send}=browser,{ok,eq,report}=checker();
const visible=`(()=>{const caret=document.querySelector('.doge-smooth-caret');return !caret.hidden&&getComputedStyle(caret).display!=='none';})()`;
const aligned=`(()=>{const caret=document.querySelector('.doge-smooth-caret').getBoundingClientRect(),pos=editor.cursorCoords(editor.getCursor(),'window');return Math.abs(caret.left-pos.left)<1&&Math.abs(caret.top-pos.top)<1&&Math.abs(caret.height-(pos.bottom-pos.top))<1;})()`;
async function settle(){await sleep(150);}
async function checkAligned(name){
  const result=await ev(aligned);ok(name,result);
  if(!result)console.log(name+': '+JSON.stringify(await ev(`(()=>{const c=document.querySelector('.doge-smooth-caret'),s=editor.getScrollerElement();return {hidden:c.hidden,caret:c.getBoundingClientRect().toJSON(),position:editor.cursorCoords(null,'window'),viewport:s.getBoundingClientRect().toJSON(),client:[s.clientWidth,s.clientHeight],gutter:editor.getGutterElement().getBoundingClientRect().toJSON(),scroll:editor.getScrollInfo()};})()`)));
}
async function reset(code='ab') {
  await ev(`editor.closeHint();editor.setValue(${JSON.stringify(code)});editor.setCursor(editor.lastLine(),editor.getLine(editor.lastLine()).length);editor.focus();true`);
  await settle();
}
async function hardware(k,code=k.toUpperCase().charCodeAt(0),text=k) {
  const base={key:k,code:k.length===1?'Key'+k.toUpperCase():k,windowsVirtualKeyCode:code};
  await send('Input.dispatchKeyEvent',{type:'rawKeyDown',...base});
  if(text)await send('Input.dispatchKeyEvent',{type:'char',...base,text});
  await send('Input.dispatchKeyEvent',{type:'keyUp',...base});
}
try {
  if(process.argv.includes('--android')) {
    await send('Emulation.setUserAgentOverride',{userAgent:'Mozilla/5.0 (Linux; Android 14; Tablet) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',platform:'Linux armv8l'});
    await browser.reload();
  }
  await ev(`projectOpened({name:'Motion',language:'python',files:[{path:'main.py',code:'ab'},{path:'other.py',code:'other'}]});setSetting('autoComplete','0');editor.focus();true`);
  await reset();
  eq('smooth caret is enabled by default',await ev('getSetting("smoothCaret","1")'),'1');
  eq('one visible caret after focus',await ev(visible),true);
  eq('native caret is hidden while the smooth caret is visible',await ev('getComputedStyle(document.querySelector(".CodeMirror-cursor")).visibility'),'hidden');
  ok('caret is aligned with CodeMirror text',await ev(aligned));
  const caretStart=await ev('document.querySelector(".doge-smooth-caret").getBoundingClientRect().left');
  await hardware('x');
  const motion=await ev(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>{
    const caret=document.querySelector('.doge-smooth-caret'),animation=caret.getAnimations().find(a=>a.transitionProperty==='transform');
    resolve({animated:!!animation,duration:animation&&animation.effect.getTiming().duration,left:caret.getBoundingClientRect().left,target:editor.cursorCoords(null,'window').left});
  })))`);
  ok('typing produces a real transform animation',motion.animated);
  eq('caret animation matches the reference 80ms duration',motion.duration,80);
  ok('caret travels between its old and new character positions',motion.left>=caretStart-1&&motion.left<=motion.target+1&&motion.target>caretStart);
  await settle();ok('caret finishes at the new insertion position',await ev(aligned));
  eq('typing and project source contain exactly the inserted text',await ev('[editor.getValue(),project.files[0].code]'),['abx','abx']);

  await hardware('ArrowLeft',37,'');await settle();
  ok('arrow key movement ends at the text cursor',await ev(aligned));
  await typeText('你');await settle();
  eq('Unicode input stays intact',await ev('editor.getValue()'),'ab你x');
  ok('caret stays aligned after a wide Unicode character',await ev(aligned));
  await key('z',{ctrl:true});await settle();eq('motion leaves undo behavior intact',await ev('editor.getValue()'),'abx');

  await ev('editor.setSelection({line:0,ch:0},{line:0,ch:2});true');await settle();
  eq('text selection hides the smooth caret',await ev(visible),false);
  await typeText('new');await settle();eq('selection replacement remains native',await ev('editor.getValue()'),'newx');
  await reset('abc\ndef');
  await ev('editor.setSelections([{anchor:{line:0,ch:1},head:{line:0,ch:1}},{anchor:{line:1,ch:1},head:{line:1,ch:1}}]);true');await settle();
  eq('multiple cursors use the native caret renderer',await ev(visible),false);
  eq('both native cursors remain visible',await ev('[...document.querySelectorAll(".CodeMirror-cursor")].filter(x=>getComputedStyle(x).visibility==="visible").length'),2);
  await reset();
  await ev('openSettings();true');await settle();
  eq('dialog focus hides the editor caret',await ev(visible),false);
  eq('new motion setting starts checked',await ev('document.getElementById("smoothCaretInput").checked'),true);
  await ev('document.getElementById("smoothCaretInput").checked=false;saveSettings();true');await settle();
  eq('disabling motion restores the native cursor',await ev('getComputedStyle(document.querySelector(".CodeMirror-cursor")).visibility'),'visible');
  eq('disabling motion hides its visual caret',await ev(visible),false);
  await browser.reload();await ev('editor.focus();true');await settle();
  eq('disabled preference persists after restart',await ev('getSetting("smoothCaret","1")'),'0');
  await ev('openSettings();document.getElementById("smoothCaretInput").checked=true;saveSettings();true');await settle();
  eq('reenabling motion takes effect immediately',await ev(visible),true);
  await browser.reload();await ev('editor.focus();true');await settle();
  eq('enabled preference persists after restart',await ev('getSetting("smoothCaret","1")'),'1');

  await reset();
  await send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});await settle();
  eq('reduced motion uses the native cursor',await ev(visible),false);
  eq('reduced motion does not change the saved preference',await ev('getSetting("smoothCaret","1")'),'1');
  await typeText('x');eq('typing continues with reduced motion',await ev('editor.getValue().endsWith("x")'),true);
  await send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});await settle();
  eq('motion resumes when the system preference changes',await ev(visible),true);

  await reset('first\nsecond');await ev('switchProjectFile("other.py");editor.focus();editor.setCursor(0,5);true');await settle();
  ok('document switching snaps to the new document position',await ev(aligned));
  await ev(`window.dispatchEvent(new Event('blur'));window.dispatchEvent(new Event('focus'));true`);await key('x');await settle();
  eq('hardware input survives returning to the window with motion enabled',await ev('editor.getValue()'),'otherx');
  ok('caret is aligned after window focus recovery',await ev(aligned));
  await reset('line\n'.repeat(100));await ev('editor.setCursor(60,2);editor.scrollIntoView(editor.getCursor());true');await settle();
  await checkAligned('scrolling leaves the caret aligned');
  await ev('setSetting("codeSize",24);applyCodeSize();true');await settle();
  eq('caret stays hidden when resized text moves outside the viewport',await ev(visible),false);
  await ev('editor.scrollIntoView(editor.getCursor(),30);true');await settle();
  await checkAligned('font resizing updates the caret height and position');
  await ev('editor.setOption("readOnly","nocursor");true');await settle();
  eq('nocursor documents show no animated caret',await ev(visible),false);
  await ev('editor.setOption("readOnly",false);editor.focus();true');await settle();
  await checkAligned('caret returns when the document becomes editable');

  if(process.env.DOGE_MOTION_SCREENSHOT){
    await reset('def greet(name):\n    print("Hello, " + name)\n\ngreet("Doge")');
    await ev('editor.setCursor(1,17);true');await settle();
    const shot=await send('Page.captureScreenshot',{format:'png'});writeFileSync(process.env.DOGE_MOTION_SCREENSHOT,Buffer.from(shot.result.data,'base64'));
  }
  ok('no browser exceptions: '+browser.errors.join(' | '),browser.errors.length===0);
}catch(error){ok('script error: '+error.stack,false);}
const failures=report('Editor typing motion'+(process.argv.includes('--android')?' (Android UA)':''));await browser.close();process.exit(failures?1:0);
