'use strict';
const { EventEmitter } = require('node:events');
const { ConnectionGate } = require('../ui/protocol.js');

// The startup capability stays in the main process; renderer commands are an enum.
class TaskLink extends EventEmitter {
  constructor(info) {
    super(); this.origin = info.origin; this.bootstrap = info.url; this.cookie = '';
    this.gate = new ConnectionGate(); this.epoch = 0; this.revision = 0; this.rejected = 0;
    this.closed = false; this.manual = false; this.lastMessage = 0; this.error = '';
    this.watchdog = setInterval(() => { if (this.gate.connected && Date.now() - this.lastMessage > 6500) this.abort?.abort(); }, 1000);
    this.watchdog.unref();
  }
  state(restored = true) { return { revision: this.revision, connected: this.gate.connected, snapshot: this.gate.snapshot, restored, rejected: this.rejected, error: this.error }; }
  publish(restored = true) { this.revision++; this.emit('update', this.state(restored)); }
  receive(message) {
    if (message.type === 'heartbeat') {
      if (message.connection_id === this.gate.connection && message.session_id === this.gate.session) this.lastMessage = Date.now();
      return;
    }
    const result = message.type === 'hello' ? this.gate.restore(message) : this.gate.accept(message);
    if (!result.accepted) { this.rejected++; return; }
    this.lastMessage = Date.now(); this.error = ''; this.publish(!!result.restored);
  }
  async connect() {
    if (this.closed || this.manual) return;
    clearTimeout(this.retry); this.abort?.abort(); const epoch = ++this.epoch;
    const abort = this.abort = new AbortController();
    if (this.gate.connected) { this.gate.disconnect(); this.publish(); }
    try {
      if (!this.cookie) {
        const boot = await fetch(this.bootstrap, { redirect: 'manual', signal: AbortSignal.any([abort.signal, AbortSignal.timeout(5000)]) });
        const cookie = boot.headers.get('set-cookie')?.split(';')[0];
        if (boot.status !== 303 || !cookie?.startsWith('host_session=')) throw Error('本地连接认证失败');
        this.cookie = cookie;
      }
      const response = await fetch(this.origin + '/api/events', { headers: { Cookie: this.cookie }, signal: abort.signal });
      if (!response.ok || !response.body) throw Error('无法连接本地任务事件');
      const reader = response.body.getReader(), decoder = new TextDecoder(); let pending = '';
      try {
        while (!this.closed && epoch === this.epoch) {
          const { value, done } = await reader.read(); if (done) break;
          pending += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
          if (pending.length > 1024 * 1024) throw Error('本地事件长度异常');
          let boundary;
          while ((boundary = pending.indexOf('\n\n')) !== -1) {
            const frame = pending.slice(0, boundary); pending = pending.slice(boundary + 2);
            const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
            if (data && epoch === this.epoch) {
              try { this.receive(JSON.parse(data)); } catch { this.rejected++; }
            }
          }
        }
      } finally { await reader.cancel().catch(() => {}); }
      if (!abort.signal.aborted) throw Error('本地任务连接已结束');
    } catch (error) {
      if (epoch !== this.epoch || this.closed || this.manual) return;
      this.error = abort.signal.aborted ? '任务连接超时，正在重连' : '本地任务连接中断，正在重连';
    } finally {
      if (epoch === this.epoch && !this.closed && !this.manual) {
        this.gate.disconnect(); this.publish();
        this.retry = setTimeout(() => this.connect(), 1000); this.retry.unref();
      }
    }
  }
  disconnect() {
    this.manual = true; ++this.epoch; clearTimeout(this.retry); this.abort?.abort();
    this.gate.disconnect(); this.error = '预览连接已断开，后台任务可能仍在运行'; this.publish();
  }
  reconnect() { if (this.closed) return; this.manual = false; this.connect(); }
  async command(action) {
    if (action === 'disconnect') { this.disconnect(); return true; }
    if (action === 'reconnect') { this.reconnect(); return true; }
    const commands = { organize: '整理测试文件', note: '写一份测试笔记', failure: '受控失败验收' };
    if (!Object.hasOwn(commands, action) && action !== 'cancel') throw Error('不支持的任务操作');
    if (!this.cookie || this.closed) throw Error('本地任务连接尚未就绪');
    const response = await fetch(this.origin + (action === 'cancel' ? '/api/cancel' : '/api/command'), {
      method: 'POST', headers: { Cookie: this.cookie, Origin: this.origin, 'Content-Type': 'application/json' },
      body: JSON.stringify(action === 'cancel' ? {} : { command: commands[action], scenario: action === 'failure' ? 'failure' : undefined }),
      signal: AbortSignal.timeout(5000),
    });
    const body = await response.json(); if (!response.ok) throw Error(body.error || '本地任务请求失败');
    // The response is an acknowledgement. Only ordered SSE events update task facts.
    return true;
  }
  close() { this.closed = true; ++this.epoch; this.abort?.abort(); clearTimeout(this.retry); clearInterval(this.watchdog); }
}
module.exports = { TaskLink };
