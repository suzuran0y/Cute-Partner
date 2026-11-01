'use strict';
const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes, randomUUID } = require('node:crypto');
const { installation } = require('./harness-provider.cjs');
const ACTIVE = new Set(['starting', 'listening', 'stopping', 'transcribing', 'cancelling']);
function validateWave(value) {
  const b = Buffer.from(value);
  if (b.length < 12844 || b.length > 1920044 || b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE' || b.toString('ascii', 12, 16) !== 'fmt ' || b.readUInt32LE(16) !== 16 || b.readUInt16LE(20) !== 1 || b.readUInt16LE(22) !== 1 || b.readUInt32LE(24) !== 16000 || b.readUInt32LE(28) !== 32000 || b.readUInt16LE(32) !== 2 || b.readUInt16LE(34) !== 16 || b.toString('ascii', 36, 40) !== 'data' || b.readUInt32LE(40) !== b.length - 44 || b.readUInt32LE(4) !== b.length - 8 || b.length % 2) throw Error('录音格式无效或时长不足 0.4 秒；最多录音 60 秒');
  return b;
}
class SpeechService extends EventEmitter {
  constructor({ assetsRoot = path.join(__dirname, '../.runtime/speech/assets'), spawnProcess = spawn } = {}) { super(); this.assetsRoot = assetsRoot; this.spawnProcess = spawnProcess; this.phase = 'idle'; this.revision = 0; this.text = ''; this.error = ''; this.closed = false; }
  resources() { try { const v = JSON.parse(fs.readFileSync(path.join(this.assetsRoot, 'asset-paths.json'), 'utf8')); return ['model', 'tokens', 'vad'].every(k => typeof v[k] === 'string' && fs.statSync(v[k]).isFile()) ? v : null; } catch { return null; } }
  state() { return { revision: this.revision, phase: this.phase, active: ACTIVE.has(this.phase), recordingId: this.recordingId, text: this.text, error: this.error, ready: !!this.resources(), maxSeconds: 60 }; }
  publish() { this.revision++; this.emit('update', this.state()); }
  toggle() { if (['starting', 'listening'].includes(this.phase)) this.stopRecording(); else if (ACTIVE.has(this.phase)) void this.cancel(); else this.start(); }
  start() {
    if (this.closed || ACTIVE.has(this.phase)) throw Error('语音服务正在处理上一条录音');
    if (!this.resources()) throw Error('本地语音资源未就绪，请在设置中准备语音组件');
    clearTimeout(this.idleTimer); this.phase = 'starting'; this.recordingId = randomUUID(); this.text = ''; this.error = ''; this.publish(); this.emit('capture', { action: 'start', id: this.recordingId });
    this.captureTimer = setTimeout(() => { void this.cancel('麦克风启动超时，请检查系统权限'); }, 30000);
  }
  stopRecording() {
    if (!['starting', 'listening'].includes(this.phase)) return; clearTimeout(this.captureTimer); this.phase = 'stopping'; this.publish(); this.emit('capture', { action: 'stop', id: this.recordingId });
    this.captureTimer = setTimeout(() => { void this.cancel('未收到完整录音，请重试'); }, 10000);
  }
  async capture(input) {
    if (!input || input.id !== this.recordingId || !ACTIVE.has(this.phase)) return false;
    if (input.type === 'error') { await this.cancel(input.reason === 'permission' ? '麦克风访问被拒绝，请在 Windows 隐私设置中允许桌面应用使用麦克风' : '麦克风不可用或录音中断，请检查输入设备'); return true; }
    if (input.type === 'started' && this.phase === 'starting') { clearTimeout(this.captureTimer); this.phase = 'listening'; this.publish(); this.captureTimer = setTimeout(() => this.stopRecording(), 60000); return true; }
    if (input.type !== 'audio' || this.phase !== 'stopping') return false;
    clearTimeout(this.captureTimer); let audio;
    try { if (!(input.audio instanceof Uint8Array) && !(input.audio instanceof ArrayBuffer)) throw Error('录音数据无效'); audio = validateWave(input.audio instanceof ArrayBuffer ? new Uint8Array(input.audio) : input.audio); }
    catch (error) { this.phase = 'error'; this.error = error.message; this.publish(); return false; }
    const id = this.recordingId; this.phase = 'transcribing'; this.publish();
    this.operation = this.transcribe(audio, id); await this.operation; return true;
  }
  async worker() {
    if (this.child && !this.child.killed) return this.workerReady;
    const found = installation(), assets = this.resources(); if (!found.installed || !assets) throw Error('本地识别组件不可用，请重新准备语音资源');
    this.token = randomBytes(32).toString('hex');
    const script = path.join(path.dirname(found.executable), 'resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-experimental-speech-to-text-sensevoice/lib/worker.js');
    const config = { ...assets, dataRoot: this.assetsRoot, maxAudioBytes: 1920044, threads: 2, segmentSeconds: 30 };
    const child = this.child = this.spawnProcess(found.executable, [script, JSON.stringify(config)], { windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_SPEECH_TOKEN: this.token }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stderr.resume();
    this.workerExit = new Promise(resolve => { child.once('exit', () => { if (this.child === child) this.child = null; resolve(); }); child.once('error', () => { if (this.child === child) this.child = null; resolve(); }); });
    this.workerReady = new Promise((resolve, reject) => {
      let text = ''; const timer = setTimeout(() => reject(Error('本地识别器启动超时')), 30000);
      const data = chunk => { text += chunk.toString(); if (text.length > 4096) return reject(Error('识别器启动失败')); if (text.includes('\n')) { try { const frame = JSON.parse(text.split('\n')[0]); if (!Number.isSafeInteger(frame.port) || frame.port < 1 || frame.port > 65535) throw Error(); clearTimeout(timer); child.stdout.off('data', data); child.stdout.resume(); resolve(frame.port); } catch { clearTimeout(timer); reject(Error('识别器启动失败')); } } };
      child.stdout.on('data', data); this.workerExit.then(() => { clearTimeout(timer); reject(Error('本地识别器已退出')); });
    });
    return this.workerReady;
  }
  async transcribe(audio, id) {
    try {
      const port = await this.worker(); if (id !== this.recordingId || this.phase !== 'transcribing') return;
      this.abort = new AbortController(); const response = await fetch(`http://127.0.0.1:${port}/transcribe?language=auto`, { method: 'POST', headers: { Authorization: 'Bearer ' + this.token, 'Content-Type': 'audio/wav', 'Content-Length': String(audio.length) }, body: audio, signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(120000)]) });
      if (!response.ok) throw Error('本地语音识别失败，请重试'); const result = await response.json();
      if (id !== this.recordingId || this.phase !== 'transcribing') return;
      if (typeof result.text !== 'string' || result.text.length > 4000) throw Error('识别文字过长或格式错误');
      this.text = result.text.trim(); this.phase = this.text ? 'ready' : 'error'; this.error = this.text ? '' : '未识别到清晰语音，请重试'; this.publish();
    } catch (error) {
      if (id === this.recordingId && this.phase === 'transcribing') { this.phase = 'error'; this.error = error.message.startsWith('本地') || error.message.startsWith('识别') ? error.message : '本地识别超时或连接中断，请重试'; await this.releaseWorker(); this.publish(); }
    } finally { if (this.child) { this.idleTimer = setTimeout(() => { void this.releaseWorker(); }, 45000); this.idleTimer.unref(); } }
  }
  async releaseWorker() { this.abort?.abort(); clearTimeout(this.idleTimer); if (this.child) { const child = this.child; child.kill(); await Promise.race([this.workerExit, new Promise(resolve => setTimeout(resolve, 1500))]); if (this.child === child) { child.kill('SIGKILL'); await Promise.race([this.workerExit, new Promise(resolve => setTimeout(resolve, 1500))]); } if (this.child === child) throw Error('本地识别器尚未确认退出'); } }
  async cancel(reason = '') {
    if (!ACTIVE.has(this.phase)) return; clearTimeout(this.captureTimer); const id = this.recordingId; this.recordingId = null; this.phase = 'cancelling'; this.publish(); this.emit('capture', { action: 'cancel', id });
    try { await this.releaseWorker(); await this.operation; this.phase = reason ? 'error' : 'cancelled'; this.error = reason; }
    catch { this.phase = 'error'; this.error = '识别器退出未确认，请先退出程序再重试'; }
    this.publish();
  }
  async close() { this.closed = true; await this.cancel(); await this.releaseWorker(); }
}
module.exports = { SpeechService, validateWave, ACTIVE };
