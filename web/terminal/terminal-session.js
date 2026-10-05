(function (root) {
  'use strict';
  class TerminalSession {
    constructor(request, callbacks) {
      this.request = request; this.callbacks = callbacks || {};
      this.taskId = null; this.sessionId = null; this.after = 0; this.sequence = 0;
      this.pending = null; this.inputReady = false; this.closed = true; this.generation = 0;
      this.cancelRequested = false; this.cancelAt = 0;
    }
    async run(body) {
      const generation = ++this.generation;
      this.after = 0; this.sequence = 0; this.pending = null; this.inputReady = false; this.closed = false;
      this.cancelRequested = false; this.cancelAt = 0;
      let exit;
      try {
        const created = await this.request('/api/v1/tasks', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) }, 8000);
        if (!created.task_id || !created.session_id) throw new Error(created.message || '运行会话创建失败');
        this.taskId = created.task_id; this.sessionId = created.session_id;
        this.callbacks.created?.(created);
        if (this.cancelRequested) await this.cancel();
        const deadline = Date.now() + (body.compile_timeout_ms || 30000) + (body.run_timeout_ms || body.timeout_ms || 30000) + 120000;
        let failures = 0;
        while (generation === this.generation) {
          if (Date.now() > deadline) { await this.cancel(); throw new Error('运行会话等待超时'); }
          if (this.cancelAt && Date.now() - this.cancelAt > 10000) throw new Error('停止请求尚未完成，请在设备调试时检查运行器');
          let batch;
          try { batch = await this.request(this.url('/events?after=' + this.after), null, 8000); failures = 0; }
          catch (error) {
            if (++failures >= 5) throw error;
            this.callbacks.notice?.('连接暂时中断，正在重试…');
            await new Promise(resolve => setTimeout(resolve, 500)); continue;
          }
          if (generation !== this.generation) return;
          if (batch.session_id !== this.sessionId) throw new Error('运行会话已变化');
          this.inputReady = !!batch.input_ready; this.closed = !!batch.input_closed;
          this.callbacks.state?.(batch);
          if (batch.gap) this.callbacks.gap?.();
          for (const event of batch.events || []) {
            if (event.seq <= this.after) continue;
            this.callbacks.event?.(event);
            this.after = event.seq;
            if (event.kind === 'exit') exit = event;
          }
          this.after = Math.max(this.after, batch.next_seq || 0);
          // A terminal event arrives only after the last output; drain paginated events before leaving.
          if (exit && !batch.has_more) return exit;
          if (batch.phase === 'finished' && !batch.has_more) return exit || {kind:'exit',status:batch.status,exit_code:-1};
          if (!batch.has_more) await new Promise(resolve => setTimeout(resolve, this.inputReady ? 75 : 150));
        }
      } finally {
        if (generation === this.generation) { this.inputReady = false; this.closed = true; this.callbacks.state?.({phase:'finished',input_ready:false,input_closed:true}); }
      }
    }
    url(suffix) { return '/api/v1/tasks/' + encodeURIComponent(this.taskId) + suffix; }
    async input(text, eof) {
      if (!this.taskId || (!this.pending && (!this.inputReady || this.closed))) throw new Error('程序当前无法接收输入');
      if (this.pending && (this.pending.text !== text || this.pending.eof !== !!eof)) throw new Error('上一条输入尚未确认，请先重试');
      const frame = this.pending || {seq:this.sequence + 1,text,eof:!!eof};
      this.pending = frame;
      let error;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const payload = {session_id:this.sessionId,seq:frame.seq};
          if (!eof) payload.text = text;
          const response = await this.request(this.url(eof ? '/eof' : '/input'), {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)}, 3000);
          if (!response.ok) {
            this.pending = null;
            throw Object.assign(new Error(response.message || '输入未被接受'), {rejected:true});
          }
          this.sequence = frame.seq; this.pending = null;
          if (eof) { this.closed = true; this.inputReady = false; }
          return response;
        } catch (failure) { error = failure; if (failure.rejected) throw failure; }
      }
      throw new Error('输入确认失败；再次提交会重试相同输入，不会重复发送。' + (error?.message || ''));
    }
    async cancel() {
      this.cancelRequested = true; if (!this.cancelAt) this.cancelAt = Date.now();
      if (this.taskId) return this.request(this.url('/cancel'), {method:'POST'}, 8000);
    }
  }
  root.DogeTerminalSession = TerminalSession;
})(typeof window === 'undefined' ? globalThis : window);
