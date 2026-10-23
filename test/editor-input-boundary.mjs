// Execute the production WebView/InputConnection wrapper on a JVM. Android API
// fixtures preserve return values so diagnostics must not consume or rewrite input.
import {mkdtempSync,writeFileSync,mkdirSync,rmSync,existsSync} from 'node:fs';
import {join,dirname,resolve,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const work=mkdtempSync(join(tmpdir(),'doge-input-boundary-'));
const javaRoot=process.env.JAVA_HOME||'D:/java/jdk-21.0.7';
const java=existsSync(join(javaRoot,'bin/java.exe'))?join(javaRoot,'bin/java.exe'):'java';
const javac=existsSync(join(javaRoot,'bin/javac.exe'))?join(javaRoot,'bin/javac.exe'):'javac';
const sources={
  'android/content/Context.java':`package android.content;
    public class Context {public static final String INPUT_METHOD_SERVICE="input";
      public final android.view.inputmethod.InputMethodManager manager=new android.view.inputmethod.InputMethodManager();
      public Object getSystemService(String name){return manager;}public Object getContentResolver(){return this;}}`,
  'android/os/Build.java':`package android.os;public class Build {public static class VERSION {public static final String RELEASE="fixture";public static final int SDK_INT=24;}}`,
  'android/os/SystemClock.java':`package android.os;public class SystemClock {public static long uptimeMillis(){return System.nanoTime()/1000000;}}`,
  'android/provider/Settings.java':`package android.provider;public class Settings {public static class Secure {public static final String DEFAULT_INPUT_METHOD="ime";public static String getString(Object resolver,String key){return "fixture-ime";}}}`,
  'android/view/KeyEvent.java':`package android.view;public class KeyEvent {
    public static final int ACTION_DOWN=0,KEYCODE_DEL=67,KEYCODE_FORWARD_DEL=112,KEYCODE_ENTER=66,KEYCODE_TAB=61,KEYCODE_BACK=4,KEYCODE_DPAD_UP=19,KEYCODE_DPAD_CENTER=23;
    private final int code,action;public KeyEvent(int action,int code){this.action=action;this.code=code;}
    public int getAction(){return action;}public int getKeyCode(){return code;}public static boolean isModifierKey(int code){return code==59;}}`,
  'android/view/inputmethod/EditorInfo.java':`package android.view.inputmethod;public class EditorInfo {public int initialSelStart=1,initialSelEnd=5;}`,
  'android/view/inputmethod/InputConnection.java':`package android.view.inputmethod;import android.view.KeyEvent;
    public interface InputConnection {boolean commitText(CharSequence t,int c);boolean setComposingText(CharSequence t,int c);boolean setComposingRegion(int s,int e);
      boolean finishComposingText();boolean deleteSurroundingText(int b,int a);boolean deleteSurroundingTextInCodePoints(int b,int a);
      boolean setSelection(int s,int e);boolean sendKeyEvent(KeyEvent e);boolean beginBatchEdit();boolean endBatchEdit();void closeConnection();}`,
  'android/view/inputmethod/InputConnectionWrapper.java':`package android.view.inputmethod;import android.view.KeyEvent;
    public class InputConnectionWrapper implements InputConnection {private final InputConnection target;
      public InputConnectionWrapper(InputConnection target,boolean mutable){this.target=target;}
      public boolean commitText(CharSequence t,int c){return target.commitText(t,c);}public boolean setComposingText(CharSequence t,int c){return target.setComposingText(t,c);}
      public boolean setComposingRegion(int s,int e){return target.setComposingRegion(s,e);}public boolean finishComposingText(){return target.finishComposingText();}
      public boolean deleteSurroundingText(int b,int a){return target.deleteSurroundingText(b,a);}public boolean deleteSurroundingTextInCodePoints(int b,int a){return target.deleteSurroundingTextInCodePoints(b,a);}
      public boolean setSelection(int s,int e){return target.setSelection(s,e);}public boolean sendKeyEvent(KeyEvent e){return target.sendKeyEvent(e);}
      public boolean beginBatchEdit(){return target.beginBatchEdit();}public boolean endBatchEdit(){return target.endBatchEdit();}public void closeConnection(){target.closeConnection();}}`,
  'android/view/inputmethod/InputMethodManager.java':`package android.view.inputmethod;
    public class InputMethodManager {public int restarts;public void restartInput(android.webkit.WebView view){restarts++;}}`,
  'android/webkit/WebView.java':`package android.webkit;import android.content.Context;import android.view.KeyEvent;import android.view.inputmethod.*;
    public class WebView {private final Context context;public InputConnection fixture;public boolean focused=true,windowFocused=true,keyResult=true;
      public WebView(Context context){this.context=context;}public Context getContext(){return context;}public boolean hasFocus(){return focused;}
      public boolean hasWindowFocus(){return windowFocused;}public boolean dispatchKeyEvent(KeyEvent event){return keyResult;}
      public InputConnection onCreateInputConnection(EditorInfo info){return fixture;}}`,
  'org/json/JSONObject.java':`package org.json;import java.util.*;public class JSONObject {private final Map<String,Object> items=new LinkedHashMap<>();public JSONObject put(String k,Object v){items.put(k,v);return this;}public String toString(){return items.toString();}}`,
  'org/json/JSONArray.java':`package org.json;import java.util.*;public class JSONArray {private final List<Object> items=new ArrayList<>();public JSONArray put(Object v){items.add(v);return this;}public String toString(){return items.toString();}}`,
  'com/doge/ide/EditorInputBoundaryTest.java':`package com.doge.ide;
    import android.content.Context;import android.view.KeyEvent;import android.view.inputmethod.*;
    public class EditorInputBoundaryTest {
      static int passed;static void check(String name,boolean ok){if(!ok)throw new AssertionError(name);passed++;}
      static class Connection implements InputConnection {String text="";boolean accepted=true,closed;int calls,start,end,before,after,cursor;KeyEvent event;
        public boolean commitText(CharSequence t,int c){calls++;text=t.toString();cursor=c;return accepted;}
        public boolean setComposingText(CharSequence t,int c){calls++;text=t.toString();cursor=c;return accepted;}
        public boolean setComposingRegion(int s,int e){calls++;start=s;end=e;return accepted;}
        public boolean finishComposingText(){calls++;return accepted;}
        public boolean deleteSurroundingText(int b,int a){calls++;before=b;after=a;return accepted;}
        public boolean deleteSurroundingTextInCodePoints(int b,int a){calls++;before=b;after=a;return accepted;}
        public boolean setSelection(int s,int e){calls++;start=s;end=e;return accepted;}
        public boolean sendKeyEvent(KeyEvent e){calls++;event=e;return accepted;}
        public boolean beginBatchEdit(){calls++;return accepted;}public boolean endBatchEdit(){calls++;return accepted;}
        public void closeConnection(){calls++;closed=true;}}
      public static void main(String[] args){Context context=new Context();EditorWebView web=new EditorWebView(context);Connection target=new Connection();web.fixture=target;
        InputConnection input=web.onCreateInputConnection(new EditorInfo());
        check("wraps an existing connection",input!=null&&input!=target);
        check("committed text forwarded",input.commitText("PRIVATE_SOURCE_MARKER",2)&&target.text.equals("PRIVATE_SOURCE_MARKER")&&target.cursor==2);
        check("composition forwarded",input.setComposingText("PRIVATE_CANDIDATE",1)&&target.text.equals("PRIVATE_CANDIDATE"));
        check("composition range forwarded",input.setComposingRegion(4,9)&&target.start==4&&target.end==9);
        check("selection forwarded",input.setSelection(2,8)&&target.start==2&&target.end==8);
        check("deletion lengths forwarded",input.deleteSurroundingText(4,3)&&target.before==4&&target.after==3);
        check("codepoint deletion forwarded",input.deleteSurroundingTextInCodePoints(1,2)&&target.before==1&&target.after==2);
        KeyEvent backspace=new KeyEvent(0,KeyEvent.KEYCODE_DEL);check("same key event forwarded",input.sendKeyEvent(backspace)&&target.event==backspace);
        check("batch forwarded",input.beginBatchEdit()&&input.endBatchEdit());check("finish composing forwarded",input.finishComposingText());
        target.accepted=false;check("failed input is not masked by diagnostics",!input.commitText("PRIVATE_FAILED_TEXT",1));
        check("restart preserves view focus",web.restartEditorInput()&&web.hasFocus()&&context.manager.restarts==1);
        web.focused=false;check("unfocused view is not restarted",!web.restartEditorInput()&&context.manager.restarts==1);web.focused=true;web.windowFocused=false;
        check("background view is not restarted",!web.restartEditorInput()&&context.manager.restarts==1);web.windowFocused=true;
        web.keyResult=false;check("hardware dispatch return value forwarded",!web.dispatchKeyEvent(backspace));
        String diagnostic=web.inputDiagnostics();check("diagnostics contain event and IME state",diagnostic.contains("commit-text")&&diagnostic.contains("fixture-ime"));
        check("diagnostics contain no source or candidate text",!diagnostic.contains("PRIVATE_"));
        check("IME range and deletion parameters have explicit names",diagnostic.contains("newCursorPosition=2")&&diagnostic.contains("start=4")&&diagnostic.contains("beforeLength=4"));
        input.setComposingRegion(31,47);input.finishComposingText();input.setSelection(0,18);input.commitText("",1);
        for(int i=0;i<160;i++)input.commitText("PRIVATE_TYPING_FLOOD",1);
        diagnostic=web.inputDiagnostics();
        check("deletion onset survives later committed typing",diagnostic.contains("lastDeletion")&&diagnostic.contains("start=31")&&diagnostic.contains("end=47")&&diagnostic.contains("finish-compose")&&diagnostic.contains("length=0"));
        check("retained onset contains no source or candidate text",!diagnostic.contains("PRIVATE_"));
        int calls=target.calls;for(int i=0;i<120;i++)input.setSelection(i,i);check("diagnostic capacity does not stop native input",target.calls==calls+120);
        check("critical connection history survives a flood of selection updates",web.inputDiagnostics().contains("transitions")&&web.inputDiagnostics().contains("create-connection"));
        try {java.lang.reflect.Field field=EditorWebView.class.getDeclaredField("inputEvents");field.setAccessible(true);
          check("normal diagnostic history is bounded",((java.util.ArrayDeque<?>)field.get(web)).size()==100);
          field=EditorWebView.class.getDeclaredField("inputTransitions");field.setAccessible(true);
          for(int i=0;i<100;i++)web.noteEditorInputSync("sync-request",i,true);
          check("critical transition history is bounded",((java.util.ArrayDeque<?>)field.get(web)).size()==80);
        }catch(ReflectiveOperationException error){throw new RuntimeException(error);}
        input.closeConnection();check("connection close forwarded",target.closed);web.fixture=null;
        check("absent input connection remains absent",web.onCreateInputConnection(new EditorInfo())==null);
        System.out.println("Editor InputConnection boundary: "+passed+" passed, 0 failed");}
    }`
};
try {
  const files=[];
  for(const [name,source] of Object.entries(sources)){const file=join(work,name);mkdirSync(dirname(file),{recursive:true});writeFileSync(file,source);files.push(file);}
  files.push(join(root,'android/app/src/main/java/com/doge/ide/EditorWebView.java'));
  const compilation=spawnSync(javac,['-encoding','UTF-8','--release','17','-d',join(work,'classes'),...files],{encoding:'utf8',timeout:30000});
  if(compilation.status!==0)throw new Error(compilation.stderr||String(compilation.error));
  const execution=spawnSync(java,['-cp',join(work,'classes'),'com.doge.ide.EditorInputBoundaryTest'],{encoding:'utf8',timeout:10000});
  if(execution.status!==0)throw new Error(execution.stderr||String(execution.error));
  process.stdout.write(execution.stdout);
}finally{
  if(dirname(resolve(work))!==resolve(tmpdir())||!basename(work).startsWith('doge-input-boundary-'))throw new Error('Unexpected fixture directory');
  rmSync(work,{recursive:true,force:true});
}
