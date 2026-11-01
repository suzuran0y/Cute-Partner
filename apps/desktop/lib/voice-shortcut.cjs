'use strict';
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const path = require('node:path');
class VoiceShortcut extends EventEmitter {
  constructor(registry, activate) { super(); this.registry = registry; this.activate = activate; this.value = ''; this.paused = false; this.worker = null; this.ready = false; }
  fire() { if (!this.paused && Date.now() >= (this.suppressUntil || 0)) this.activate(); }
  async startHook() {
    if (this.worker && this.ready) return;
    const child = spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, '../tools/ctrl-tap.ps1')], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.worker = child; child.stdin.on('error', () => {}); child.stderr.resume(); let buffer = '';
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { child.kill(); reject(Error('Ctrl 监听启动超时，请重试或重新映射组合键')); }, 12000);
      const fail = () => { clearTimeout(timeout); reject(Error('Ctrl 监听不可用，请重新映射组合键')); };
      child.once('error', fail);
      child.once('exit', () => { const wasReady = this.ready; if (this.worker === child) { this.ready = false; this.worker = null; if (wasReady && this.value === 'Ctrl') this.emit('unavailable'); } fail(); });
      child.stdout.on('data', bytes => {
        buffer += bytes; if (buffer.length > 4096) buffer = '';
        let index; while ((index = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, index).trim(); buffer = buffer.slice(index + 1);
          if (line === 'ready') { clearTimeout(timeout); this.ready = true; resolve(); }
          else if (line === 'tap' && this.value === 'Ctrl') this.fire();
        }
      });
    });
  }
  async set(value) {
    if (value === this.value && (value !== 'Ctrl' || this.ready)) return;
    if (value === 'Ctrl') await this.startHook();
    else if (!this.registry.register(value, () => this.fire())) throw Error('快捷键已被其他程序占用，请重新映射');
    if (this.value && this.value !== 'Ctrl') this.registry.unregister(this.value);
    this.value = value;
    if (value !== 'Ctrl') await this.stopHook();
  }
  pause(value) {
    if (value === this.paused) return true;
    if (!value) this.suppressUntil = Date.now() + 300;
    this.paused = value;
    if (this.value && this.value !== 'Ctrl') {
      if (value) this.registry.unregister(this.value);
      else if (!this.registry.register(this.value, () => this.fire())) { this.emit('unavailable'); return false; }
    }
    return true;
  }
  stopHook() {
    const child = this.worker; this.worker = null; this.ready = false;
    if (!child) return Promise.resolve();
    child.stdin.end();
    return new Promise(resolve => { const timeout = setTimeout(() => child.kill(), 2000); child.once('exit', () => { clearTimeout(timeout); resolve(); }); });
  }
  async close() { if (this.value && this.value !== 'Ctrl') this.registry.unregister(this.value); this.value = ''; await this.stopHook(); }
}
module.exports = { VoiceShortcut };
