(function (root) {
  'use strict';
  class TerminalView {
    constructor(host, callbacks) {
      this.host = host; this.callbacks = callbacks; this.ready = false; this.busy = false; this.composing = false;
      this.draft = host.querySelector('.terminal-draft');
      this.status = host.querySelector('.terminal-state');
      this.jump = host.querySelector('.terminal-jump');
      this.term = new Terminal({convertEol:true,disableStdin:true,scrollback:5000,cursorBlink:false,fontSize:14,fontFamily:'"Maple Mono", monospace',allowProposedApi:false});
      this.fit = new FitAddon.FitAddon(); this.term.loadAddon(this.fit);
      this.term.open(host.querySelector('.terminal-screen'));
      // Terminal output cannot write to the system clipboard or auto-open links.
      this.term.parser.registerOscHandler(52, () => true);
      this.term.parser.registerOscHandler(8, () => true);
      this.term.onScroll(() => { const b=this.term.buffer.active; this.jump.hidden=b.viewportY>=b.baseY; });
      this.term.attachCustomKeyEventHandler(() => false);
      this.draft.addEventListener('compositionstart', () => {this.composing=true;});
      this.draft.addEventListener('compositionend', () => {this.composing=false;});
      this.draft.addEventListener('input', () => this.resizeDraft());
      this.draft.addEventListener('keydown', event => {
        if (this.composing || event.isComposing || event.keyCode===229) return;
        if (event.key==='Enter' && !event.shiftKey) {event.preventDefault();event.stopPropagation();this.submit();}
        else if ((event.ctrlKey||event.metaKey) && event.key.toLowerCase()==='c' && this.draft.selectionStart===this.draft.selectionEnd) {event.preventDefault();event.stopPropagation();callbacks.stop();}
        else if (event.ctrlKey && event.key.toLowerCase()==='d') {event.preventDefault();event.stopPropagation();this.eof();}
        else if ((event.ctrlKey||event.metaKey) && event.key.toLowerCase()==='l') {event.preventDefault();event.stopPropagation();this.clear();}
      });
      this.draft.addEventListener('paste', event => {
        const text = event.clipboardData?.getData('text/plain');
        if (!text || !text.includes('\n') || this.composing) return;
        event.preventDefault();
        const start=this.draft.selectionStart,end=this.draft.selectionEnd;
        this.draft.setRangeText(text.replace(/\r\n?/g,'\n'),start,end,'end');
        this.submitPastedLines();
      });
      host.querySelector('[data-terminal="enter"]').onclick=()=>this.submit();
      host.querySelector('[data-terminal="stop"]').onclick=()=>callbacks.stop();
      host.querySelector('[data-terminal="eof"]').onclick=()=>this.eof();
      host.querySelector('[data-terminal="clear"]').onclick=()=>this.clear();
      host.querySelector('[data-terminal="copy"]').onclick=()=>callbacks.copy(this.text());
      this.jump.onclick=()=>{this.term.scrollToBottom();this.jump.hidden=true;};
      host.querySelector('.terminal-screen').addEventListener('pointerup',()=>{if(this.ready&&!this.term.hasSelection())this.draft.focus({preventScroll:true});});
      this.resize = new ResizeObserver(()=>this.refresh()); this.resize.observe(host);
      new MutationObserver(()=>this.refresh()).observe(document.documentElement,{attributes:true,attributeFilter:['data-theme','style']});
      document.fonts?.ready.then(()=>this.refresh());
      this.setState({phase:'idle',input_ready:false});
      this.write('运行程序后，在这里查看提示并输入。\r\n');
    }
    refresh() {
      if (!this.host.getClientRects().length) return;
      const css=getComputedStyle(this.host),value=name=>css.getPropertyValue(name).trim();
      this.term.options.fontSize=parseFloat(value('--code-size'))||14;
      this.term.options.fontFamily=value('--font-mono');
      this.term.options.theme={background:value('--bg'),foreground:value('--fg'),cursor:value('--accent'),selectionBackground:value('--accent-soft'),red:value('--red'),green:value('--green'),yellow:value('--orange'),blue:value('--accent'),magenta:value('--purple'),cyan:value('--cyan')};
      try {this.fit.fit();} catch (ignored) {}
    }
    resizeDraft() {this.draft.style.height='';this.draft.style.height=Math.min(96,Math.max(this.draft.clientHeight,this.draft.scrollHeight))+'px';}
    begin(file) {this.draft.value='';this.term.reset();this.write('运行 '+file+'\r\n');this.status.textContent='准备中';}
    setState(state) {
      this.ready=!!state.input_ready;
      const labels={idle:'尚未运行',queued:'排队中',compiling:'编译中',linking:'链接中',running:'运行中',finished:'已结束'};
      this.status.textContent=labels[state.phase]||state.phase||'运行中';
      this.draft.disabled=!this.ready; this.draft.readOnly=this.busy;
      this.draft.placeholder=this.ready?'输入内容，Enter 发送 · Shift+Enter 换行':'程序运行后可输入';
      this.host.querySelector('[data-terminal="enter"]').disabled=!this.ready||this.busy;
      this.host.querySelector('[data-terminal="eof"]').disabled=!this.ready||this.busy;
      this.host.querySelector('[data-terminal="stop"]').disabled=state.phase==='finished'||state.phase==='idle';
    }
    write(text) {
      const b=this.term.buffer.active,follow=b.viewportY>=b.baseY;
      this.term.write(text,()=>{if(follow)this.term.scrollToBottom();});
    }
    event(event) {
      if(event.kind==='data') this.write(event.text||'');
      if(event.kind==='exit') {this.write('\r\n[程序结束：'+event.status+'，退出码 '+event.exit_code+']\r\n');this.setState({phase:'finished',input_ready:false});}
    }
    async submit() {
      if(!this.ready||this.busy||this.composing)return;
      const text=this.draft.value;
      this.busy=true;this.draft.readOnly=true;
      try {await this.callbacks.input(text+'\n',false);this.draft.value='';this.resizeDraft();}
      catch(error){this.callbacks.notice(error.message);}
      finally {this.busy=false;this.draft.readOnly=false;if(this.ready)this.draft.focus({preventScroll:true});}
    }
    async submitPastedLines() {
      if(!this.ready||this.busy)return;
      const split=this.draft.value.lastIndexOf('\n');
      if(split<0)return;
      const complete=this.draft.value.slice(0,split+1),tail=this.draft.value.slice(split+1);
      this.busy=true;this.draft.readOnly=true;
      try {await this.callbacks.input(complete,false);this.draft.value=tail;this.resizeDraft();}
      catch(error){this.callbacks.notice(error.message);}
      finally {this.busy=false;this.draft.readOnly=false;}
    }
    async eof() {
      if(!this.ready||this.busy)return;
      if(this.draft.value){this.callbacks.notice('请先发送当前输入或清空输入，再发送 EOF');return;}
      try {await this.callbacks.input('',true);this.setState({phase:'running',input_ready:false});}
      catch(error){this.callbacks.notice(error.message);}
    }
    clear(){this.term.clear();}
    text(){const b=this.term.buffer.active,lines=[];for(let i=0;i<b.length;i++)lines.push(b.getLine(i).translateToString(true));return lines.join('\n').trimEnd();}
    gap(){this.term.reset();this.write('[较早的输出已被回收，显示当前记录]\r\n');}
  }
  root.DogeTerminalView=TerminalView;
})(window);
