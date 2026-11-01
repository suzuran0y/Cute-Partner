'use strict';
const { EventEmitter } = require('node:events'), fs = require('node:fs'), path = require('node:path'), { spawn } = require('node:child_process'), { randomUUID } = require('node:crypto');
const lock = require('../optional-modules/cosyvoice3/assets.lock.json');
const { diagnostic, speechFault } = require('./speech-observability.cjs');
const { chunkWave } = require('./speech-chunks.cjs');
const STYLES = ['natural', 'soft', 'happy', 'calm'];
function readSmall(file) { if (fs.statSync(file).size > 16384) throw Error('模块清单过大'); return JSON.parse(fs.readFileSync(file, 'utf8')); }
function abortable(promise, signal) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const aborted = () => reject(Error('已停止说话')); signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted();
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
  });
}
class CosyVoiceModule extends EventEmitter {
  constructor({ root, fallback, spawnProcess = spawn, startupMs = 180000, requestMs = 120000 } = {}) {
    super(); this.root = root; this.base = path.join(root, 'components/voice-cosyvoice3'); this.file = path.join(root, 'voice-module-settings.json'); this.fallback = fallback; this.spawnProcess = spawnProcess; this.startupMs = startupMs; this.requestMs = requestMs; this.selection = 'system'; this.phase = 'idle'; this.error = ''; this.pending = new Map(); this.profileId = 'official-demo'; this.keepWarm = false; this.configVersion = 0;
    try { const value = readSmall(this.file); if (['system', 'cosyvoice3'].includes(value.selection)) this.selection = value.selection; } catch {}
  }
  resources() {
    try {
      const pointer = readSmall(path.join(this.base, 'active.json'));
      if (typeof pointer.directory !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(pointer.directory) || pointer.protocolVersion !== 1) return null;
      const directory = path.join(this.base, pointer.directory), installed = readSmall(path.join(directory, 'installation.json'));
      if (installed.moduleId !== lock.moduleId || installed.moduleVersion !== lock.moduleVersion || installed.protocolVersion !== 1 || installed.engineRevision !== lock.engine.revision || installed.modelRevision !== lock.model.revision || installed.verified !== true) return null;
      const python = path.join(directory, 'venv/Scripts/python.exe');
      if (!fs.statSync(python).isFile() || !fs.statSync(path.join(directory, 'source/cosyvoice/cli/cosyvoice.py')).isFile() || !fs.statSync(path.join(directory, 'model/verified-assets.json')).isFile()) return null;
      for (const asset of lock.model.files) if (fs.statSync(path.join(directory, 'model', asset.name)).size !== asset.bytes) return null;
      return { directory, python };
    } catch { return null; }
  }
  state() { return { selection: this.selection, installed: !!this.resources(), phase: this.phase, active: !!this.child, enabled: this.keepWarm, profileId: this.profileId, preparedProfile: this.preparedProfile, error: this.error, errorCode: this.errorCode, reference: '官方示例声音（开发试听）', capabilities: this.capabilities, loadMs: this.loadMs, metrics: this.metrics }; }
  publish() { this.emit('update', this.state()); }
  diagnostic(stage, code, details = {}) { diagnostic(this.root, { ...details, layer: 'cosyvoice3', stage, code }); }
  async configure({ enabled, selection, profileId = 'official-demo' }) {
    if (typeof enabled !== 'boolean' || !['system', 'cosyvoice3'].includes(selection) || !/^(official-demo|voice-[a-f0-9-]{36})$/.test(profileId)) throw Error('声音设置无效');
    if (enabled === this.keepWarm && selection === this.selection && profileId === this.profileId && this.phase !== 'error') { if (enabled && selection === 'cosyvoice3') void this.preload(); return this.state(); }
    const version = ++this.configVersion, changed = this.selection !== selection || this.profileId !== profileId;
    this.keepWarm = enabled; this.selection = selection; this.profileId = profileId; clearTimeout(this.idleTimer); clearTimeout(this.rewarmTimer);
    if (!enabled || selection === 'system' || this.phase === 'error') await this.stop();
    if (version !== this.configVersion || this.closed) return this.state();
    fs.mkdirSync(this.root, { recursive: true }); fs.writeFileSync(this.file + '.tmp', JSON.stringify({ selection })); fs.renameSync(this.file + '.tmp', this.file);
    if (changed) this.preparedProfile = null;
    this.error = ''; this.errorCode = null; this.publish(); if (enabled && selection === 'cosyvoice3') this.preload(); return this.state();
  }
  preload() {
    if (!this.keepWarm || this.selection !== 'cosyvoice3' || this.closed) return Promise.resolve();
    if (this.child && !this.child.invalid && this.phase === 'ready' && this.preparedProfile === this.profileId) return Promise.resolve();
    if (this.warming) return this.warming;
    const version = this.configVersion, profileId = this.profileId; this.recoveryAttempt = 0;
    this.warming = (async () => {
      try { for (let attempt = 0; attempt < 2; attempt++) {
        if (version !== this.configVersion || !this.keepWarm || this.closed) return;
        try {
          await this.start(); if (version !== this.configVersion || !this.keepWarm || this.closed) return;
          this.phase = 'preparing'; this.publish(); await this.request({ action: 'use-profile', profileId }, 'profile-ready');
          if (version === this.configVersion && this.keepWarm) { this.preparedProfile = profileId; this.phase = 'ready'; this.publish(); } return;
        } catch (error) {
          await this.stop().catch(() => {}); if (version !== this.configVersion || !this.keepWarm || this.closed) return;
          if (attempt === 0 && ['ENGINE_LOAD', 'NATIVE_INIT_CRASH'].includes(this.errorCode) && this.retryable) { this.recoveryAttempt = 1; this.error = ''; this.phase = 'recovering'; this.diagnostic('one-local-retry', this.errorCode); this.publish(); await new Promise(resolve => setTimeout(resolve, 300)); continue; }
          this.error = error.message; this.errorCode ||= 'PRELOAD_FAILED'; this.phase = 'error'; this.diagnostic('preload', this.errorCode); this.publish(); return;
        }
      } }
      finally { this.warming = null; if (version !== this.configVersion && this.keepWarm && !this.closed && this.selection === 'cosyvoice3') void this.preload(); }
    })(); return this.warming;
  }
  rewarm() { clearTimeout(this.rewarmTimer); if (this.keepWarm && this.selection === 'cosyvoice3' && !this.closed) { this.rewarmTimer = setTimeout(() => void this.preload(), 100); this.rewarmTimer.unref?.(); } }
  async createProfile(profileId) {
    if (!this.keepWarm || this.selection !== 'cosyvoice3') throw Error('请先开启语音并选择CosyVoice3音色');
    const version = this.configVersion; await this.preload();
    if (version !== this.configVersion || !this.keepWarm || !this.child || this.phase === 'error') throw Error('语音模型尚未就绪');
    if (this.pending.size) throw Error('请等当前语音准备完成后再生成音色');
    this.phase = 'preparing'; this.publish();
    try { await this.request({ action: 'prepare-profile', profileId }, 'profile-ready'); }
    finally { if (version === this.configVersion && this.child && this.phase !== 'error') { this.phase = 'ready'; this.publish(); } }
  }
  async select(selection) {
    if (!['system', 'cosyvoice3'].includes(selection)) throw Error('声音模块无效');
    if (selection === 'cosyvoice3' && !this.resources()) throw Error('CosyVoice3可选包尚未就绪，基础程序仍可使用');
    await this.stop(); fs.mkdirSync(this.root, { recursive: true }); const next = JSON.stringify({ selection }); fs.writeFileSync(this.file + '.tmp', next); fs.renameSync(this.file + '.tmp', this.file); this.selection = selection; this.error = ''; this.publish(); return this.state();
  }
  async start(signal) {
    clearTimeout(this.idleTimer); if (this.stopping) await this.stopping;
    if (this.closed || signal?.aborted) throw Error('语音模块已停止');
    if (this.child) return this.ready;
    const resources = this.resources(); if (!resources) { this.diagnostic('load', 'MODULE_MISSING'); throw speechFault('MODULE_MISSING'); }
    const child = this.child = this.spawnProcess(resources.python, ['-X', 'faulthandler', '-u', path.join(__dirname, '../optional-modules/cosyvoice3/worker.py'), '--root', resources.directory, '--profiles', path.join(this.root, 'voice-profiles'), '--bundled-profiles', path.join(__dirname, '../assets/voice-presets')], { cwd: resources.directory, windowsHide: true, env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
    this.phase = 'loading'; this.error = ''; this.errorCode = null; this.retryable = false; this.capabilities = null; this.preparedProfile = null; this.publish(); child.stdin.on('error', () => {}); child.stderr.on('data', bytes => { const name = /CosyVoice3 load failed: ([A-Za-z][A-Za-z0-9_]{0,80})/.exec(bytes.toString('utf8'))?.[1]; if (name) this.diagnostic('load-exception', name); });
    this.exited = new Promise(resolve => child.once('close', resolve));
    this.ready = new Promise((resolve, reject) => { this.readyResolve = resolve; this.readyReject = reject; this.startTimer = setTimeout(() => { this.errorCode = 'LOAD_TIMEOUT'; this.diagnostic('load', 'LOAD_TIMEOUT'); reject(speechFault('LOAD_TIMEOUT')); void this.stop().catch(() => {}); }, this.startupMs); }); this.ready.catch(() => {});
    let buffer = '';
    child.stdout.on('data', bytes => {
      if (this.child !== child || child.invalid) return;
      buffer += bytes.toString('utf8'); if (buffer.length > 7100000) { this.fail('语音模块响应超过大小限制'); return; }
      let end; while ((end = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); try { this.frame(JSON.parse(line)); } catch { this.fail('语音模块协议无效'); return; } }
    });
    child.once('error', () => { if (this.child === child && !child.invalid) this.fail('CosyVoice3运行环境无法启动', 'PROCESS_START'); });
    child.once('close', code => {
      if (this.child !== child) return; clearTimeout(this.startTimer);
      const nativeCrash = !child.invalid && !child.engineReady && Number.isInteger(code) && (code >>> 0) === 0xc0000005;
      if (nativeCrash) { this.errorCode = 'NATIVE_INIT_CRASH'; this.retryable = true; }
      this.readyReject?.(speechFault(nativeCrash ? 'NATIVE_INIT_CRASH' : 'PROCESS_EXIT'));
      for (const [id, job] of this.pending) { this.diagnostic('request-exit', 'PROCESS_EXIT', { ...job.context, requestId: id }); job.reject(speechFault('PROCESS_EXIT')); } this.pending.clear(); this.child = null; this.preparedProfile = null;
      this.phase = nativeCrash && this.keepWarm && this.warming && !this.recoveryAttempt ? 'recovering' : this.error ? 'error' : 'idle';
      if (!child.invalid) this.diagnostic('unexpected-exit', Number.isInteger(code) ? code : null); this.publish();
    });
    return this.ready;
  }
  frame(value) {
    if (value.type === 'ready') { if (value.protocolVersion !== 1) throw Error(); clearTimeout(this.startTimer); if (this.child) this.child.engineReady = true; this.capabilities = { audioChunks: value.capabilities?.audioChunks === true, styles: Array.isArray(value.capabilities?.styles) ? STYLES.filter(s => value.capabilities.styles.includes(s)) : ['natural'] }; this.phase = this.keepWarm ? 'preparing' : 'ready'; this.loadMs = Number.isFinite(value.loadMs) ? value.loadMs : null; this.readyResolve(); this.publish(); return; }
    if (value.type === 'fatal') { const code = value.code === 'GPU_MEMORY' ? value.code : 'ENGINE_LOAD'; this.retryable = value.retryable === true; this.fail(code === 'GPU_MEMORY' ? '显存不足，请关闭其他占用显存的程序后重新加载声音' : 'CosyVoice3模型加载失败，请重新加载声音或检查可选语音包', code); return; }
    const job = this.pending.get(value.id); if (!job) return;
    if (value.type === 'audio-chunk') {
      if (!job.onChunk || job.delivering || value.index !== job.chunks || job.chunks >= 128) { this.fail('语音块顺序或协议无效'); return; }
      let chunk;
      try { chunk = chunkWave(value.audio); if (job.audioBytes + chunk.bytes > 5000000) throw speechFault('AUDIO_INVALID'); }
      catch { this.diagnostic('audio-validation', 'AUDIO_INVALID', { ...job.context, requestId: value.id }); this.fail('语音音频格式无效', 'AUDIO_INVALID'); return; }
      const child = this.child; job.delivering = true; job.chunks++; job.audioBytes += chunk.bytes;
      Promise.resolve().then(() => job.onChunk({ ...chunk, chunkIndex: value.index })).then(() => {
        if (this.child !== child || child.invalid || this.pending.get(value.id) !== job) return;
        job.delivering = false; child.stdin.write(JSON.stringify({ id: value.id, action: 'chunk-ack', index: value.index }) + '\n');
      }).catch(() => { if (this.child === child && !child.invalid && this.pending.get(value.id) === job) this.fail('语音块队列已停止', 'PROTOCOL'); });
      return;
    }
    this.pending.delete(value.id);
    const details = { ...job.context, requestId: value.id };
    if (job.responseType !== 'audio') { if (value.type === job.responseType) job.resolve(value); else { this.errorCode = ['GPU_MEMORY', 'PROFILE_LOAD', 'PROFILE_PREPARE'].includes(value.code) ? value.code : 'PROFILE_LOAD'; this.diagnostic('profile', this.errorCode, details); job.reject(speechFault(this.errorCode)); } return; }
    if (value.type === 'audio-end') {
      if (!job.onChunk || job.delivering || !job.chunks || value.chunks !== job.chunks) { job.reject(speechFault('PROTOCOL')); this.fail('语音块结束协议无效'); return; }
      this.captureMetrics(value.metrics); job.resolve({ streamed: true, chunks: job.chunks }); this.publish(); return;
    }
    if (value.type !== 'audio') { const code = ['GPU_MEMORY', 'PROFILE_LOAD', 'VOICE_GENERATE'].includes(value.code) ? value.code : 'VOICE_GENERATE'; this.diagnostic('synthesis', code, details); job.reject(speechFault(code)); return; }
    if (job.chunks) { job.reject(speechFault('PROTOCOL')); this.fail('语音块模式不可重复返回整句音频'); return; }
    if (typeof value.audio !== 'string' || value.audio.length > 6700000) { this.diagnostic('audio-validation', 'AUDIO_INVALID', details); job.reject(speechFault('AUDIO_INVALID')); return; }
    const wave = Buffer.from(value.audio, 'base64'); if (wave.length < 44 || wave.length > 5000000 || wave.toString('ascii', 0, 4) !== 'RIFF' || wave.toString('ascii', 8, 12) !== 'WAVE') { this.diagnostic('audio-validation', 'AUDIO_INVALID', details); job.reject(speechFault('AUDIO_INVALID')); return; }
    this.captureMetrics(value.metrics);
    job.resolve({ audio: value.audio }); this.publish(); clearTimeout(this.idleTimer); if (!this.keepWarm) { this.idleTimer = setTimeout(() => void this.stop().catch(() => {}), 300000); this.idleTimer.unref?.(); }
  }
  captureMetrics(metrics) { this.metrics = {}; for (const field of ['synthesisMs', 'firstEngineChunkMs', 'audioSeconds', 'rtf', 'peakCudaMiB', 'transportWaitMs', 'totalMs', 'chunkCount']) if (Number.isFinite(metrics?.[field]) && metrics[field] >= 0) this.metrics[field] = metrics[field]; }
  request(input, responseType = 'audio', context = {}, onChunk) {
    if (!this.child || this.child.invalid || this.pending.size >= 2 || [...this.pending.values()].some(job => job.onChunk)) { this.diagnostic('request', 'MODULE_NOT_READY', context); return Promise.reject(speechFault('MODULE_NOT_READY')); }
    const id = randomUUID(); return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { const code = responseType === 'audio' ? 'SYNTHESIS_TIMEOUT' : 'PROFILE_TIMEOUT'; this.errorCode = code; this.diagnostic(responseType === 'audio' ? 'synthesis' : 'profile', code, { ...context, requestId: id }); reject(speechFault(code)); void this.stop().catch(() => {}); }, this.requestMs);
      this.pending.set(id, { action: input.action, responseType, context, onChunk, chunks: 0, audioBytes: 0, resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
      this.child.stdin.write(JSON.stringify({ id, ...input }) + '\n');
    });
  }
  fail(message, code = 'PROTOCOL') { const recovering = code === 'ENGINE_LOAD' && this.retryable && this.keepWarm && this.warming && !this.recoveryAttempt; this.phase = recovering ? 'recovering' : 'error'; this.error = recovering ? '' : message; this.errorCode = code; this.diagnostic('worker', code); this.readyReject?.(speechFault(code)); for (const [id, job] of this.pending) { this.diagnostic('request', code, { ...job.context, requestId: id }); job.reject(speechFault(code)); } this.pending.clear(); this.publish(); void this.stop().catch(() => {}); }
  async backend(input, signal) {
    if (input.action === 'voices' || this.selection === 'system') return this.fallback(input, signal);
    if (input.action !== 'synthesize' || typeof input.text !== 'string' || !input.text.trim() || input.text.length > 600 || !Number.isInteger(input.rate) || Math.abs(input.rate) > 3) throw Error('本机口语稿无效');
    if (!STYLES.includes(input.style ?? 'natural')) throw Error('说话风格无效');
    if (signal?.aborted) throw Error('已停止说话');
    // Background warm-up belongs to the enabled voice feature, not to one utterance.
    const cancel = () => { if ([...this.pending.values()].some(job => job.action === 'synthesize') || !this.keepWarm && this.phase === 'loading') void this.stop().then(() => this.rewarm()).catch(() => {}); }; signal?.addEventListener('abort', cancel, { once: true });
    try {
      const version = this.configVersion;
      if (this.keepWarm) {
        do { await abortable(this.preload(), signal); } while (this.warming && this.phase !== 'error' && version === this.configVersion);
        if (version !== this.configVersion || !this.keepWarm) throw Error('声音设置已更换');
        if (this.phase === 'error' || this.preparedProfile !== this.profileId) throw speechFault(this.errorCode || 'PROFILE_LOAD');
      } else await abortable(this.start(signal), signal);
      if (signal?.aborted) throw Error('已停止说话'); if (this.pending.size >= 2) throw Error('语音队列已满');
      const style = input.style ?? 'natural'; if (style !== 'natural' && !this.capabilities?.styles.includes(style)) throw speechFault('STYLE_UNSUPPORTED');
      const stream = input.stream === true && input.rate === 0 && this.capabilities?.audioChunks === true && typeof input.onChunk === 'function';
      return await this.request({ action: 'synthesize', text: input.text, rate: input.rate, profileId: this.profileId, style, stream }, 'audio', { playbackId: input.playbackId, messageId: input.messageId, sentenceIndex: input.sentenceIndex }, stream ? input.onChunk : undefined);
    } finally { signal?.removeEventListener('abort', cancel); }
  }
  async stop() {
    clearTimeout(this.idleTimer); if (this.stopping) return this.stopping; const child = this.child; if (!child) return;
    child.invalid = true; clearTimeout(this.startTimer); this.readyReject?.(Error('已停止说话')); for (const job of this.pending.values()) job.reject(Error('已停止说话')); this.pending.clear(); this.phase = 'stopping'; this.publish(); child.kill();
    this.stopping = (async () => { let timer; const confirmed = await Promise.race([this.exited.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), 5000); })]); clearTimeout(timer); if (!confirmed) { this.phase = 'error'; this.error = '语音模块退出未确认'; this.diagnostic('stop', 'PROCESS_STOP_UNCONFIRMED'); this.publish(); throw speechFault('PROCESS_STOP_UNCONFIRMED'); } })();
    try { await this.stopping; } finally { this.stopping = null; }
  }
  async close() { this.closed = true; this.keepWarm = false; this.configVersion++; clearTimeout(this.rewarmTimer); await this.stop(); }
}
module.exports = { CosyVoiceModule };
