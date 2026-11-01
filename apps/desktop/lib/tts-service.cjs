'use strict';
const { EventEmitter } = require('node:events'), { spawn } = require('node:child_process'), fs = require('node:fs'), path = require('node:path'), { randomUUID } = require('node:crypto');
const { diagnostic, writeStatus, speechFault, safeId, ERRORS } = require('./speech-observability.cjs');
const { SpeechChunks, chunkWave } = require('./speech-chunks.cjs');
function systemSpeech(input, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, '../tools/tts-synthesize.ps1')], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', settled = false, timedOut = false; const kill = () => child.kill(), timer = setTimeout(() => { timedOut = true; kill(); }, 25000); signal?.addEventListener('abort', kill, { once: true }); if (signal?.aborted) kill();
    child.stderr.resume(); child.stdin.on('error', () => {}); child.stdout.on('data', bytes => { output += bytes.toString('utf8'); if (output.length > 7000000) kill(); });
    const finish = error => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', kill); if (error || signal?.aborted) return reject(signal?.aborted ? Error('已停止说话') : speechFault(timedOut ? 'SYNTHESIS_TIMEOUT' : 'SYNTHESIS_FAILED')); try { const result = JSON.parse(output.replace(/^\uFEFF/, '')); if (!result.ok) throw Error(); resolve(result); } catch { reject(speechFault('SYNTHESIS_FAILED')); } };
    child.once('error', () => finish(true)); child.once('close', code => finish(code !== 0)); child.stdin.end(JSON.stringify(input));
  });
}
class TtsService extends EventEmitter {
  constructor({ root, backend = systemSpeech, defaultVoice = 'Microsoft Huihui Desktop', playbackStartMs = 10000, playbackMs = 90000, stopMs = 1000 } = {}) {
    super(); this.root = root; this.runId = randomUUID(); this.playbackStartMs = playbackStartMs; this.playbackMs = playbackMs; this.stopMs = stopMs; this.file = path.join(root, 'speech-output-settings.json'); this.backend = backend; this.settings = { enabled: false, voice: defaultVoice, volume: .65, rate: 0, style: 'natural', streaming: true }; this.revision = 0; this.phase = 'idle'; this.error = ''; this.metadata = {}; this.requestVersion = 0;
    // Read only local preferences from older versions; retired cloud selections never revive.
    try { const value = JSON.parse(fs.readFileSync(this.file, 'utf8')); this.settings = this.validate({ enabled: value.enabled, voice: value.voice, volume: value.volume, rate: value.rate, style: value.style, streaming: value.streaming }); this.hasUnifiedChoice = value.schemaVersion === 2; } catch {}
  }
  validate(v) { if (v?.provider && v.provider !== 'system') throw Error('付费云语音已回退，当前使用本机声音'); if (typeof v?.enabled !== 'boolean' || typeof v.voice !== 'string' || v.voice.length > 120 || !Number.isFinite(v.volume) || v.volume < 0 || v.volume > 1 || !Number.isInteger(v.rate) || v.rate < -3 || v.rate > 3 || !['natural', 'soft', 'happy', 'calm'].includes(v.style ?? 'natural') || typeof (v.streaming ?? true) !== 'boolean') throw Error('声音设置无效'); return { enabled: v.enabled, voice: v.voice, volume: v.volume, rate: v.rate, style: v.style ?? 'natural', streaming: v.streaming ?? true }; }
  state() { return { revision: this.revision, phase: this.phase, active: ['synthesizing', 'playing', 'stopping'].includes(this.phase), error: this.error, errorCode: this.errorCode, settings: { ...this.settings }, ...this.metadata }; }
  publish() { if (!this.statusFrozen) this.persistStatus(); this.revision++; this.emit('update', this.state()); }
  persistStatus(phase = this.phase, code = this.errorCode) {
    if (!this.metadata.playbackId) return;
    const m = this.metadata, value = { schemaVersion: 1, pid: process.pid, runId: this.runId, phase, error: ERRORS[code] || '', errorCode: ERRORS[code] ? code : null,
      messageId: safeId(m.messageId), playbackId: safeId(m.playbackId), sentenceIndex: m.sentenceIndex ?? null,
      confirmedSentences: m.confirmedSentences || 0, sentenceCount: m.sentenceCount || 0, preview: !!m.preview,
      requestedAt: m.requestedAt, firstAudioAt: m.firstAudioAt, lastStoppedAt: m.lastStoppedAt,
      streaming: !!m.streaming, firstChunkAt: m.firstChunkAt ?? null, chunkIndex: m.chunkIndex ?? null, confirmedChunks: m.confirmedChunks || 0, receivedChunks: m.receivedChunks || 0, style: m.style || 'natural' };
    const signature = JSON.stringify(value); if (signature === this.statusSignature) return;
    if (writeStatus(this.root, { at: new Date().toISOString(), ...value })) this.statusSignature = signature;
    else diagnostic(this.root, { layer: 'tts', stage: 'status', code: 'STATUS_WRITE', playbackId: m.playbackId });
  }
  recordFailure(code, stage) { this.errorCode = ERRORS[code] ? code : 'SYNTHESIS_FAILED'; this.error = ERRORS[this.errorCode]; diagnostic(this.root, { layer: 'tts', stage, code: this.errorCode, ...this.metadata }); }
  async voices() { const result = await this.backend({ action: 'voices' }); return result.voices.filter(v => typeof v.name === 'string' && /^zh-/.test(v.culture)); }
  async save(v) { const next = this.validate(v); await this.stop(); fs.mkdirSync(path.dirname(this.file), { recursive: true }); fs.writeFileSync(this.file + '.tmp', JSON.stringify({ schemaVersion: 2, ...next }), { mode: 0o600 }); fs.renameSync(this.file + '.tmp', this.file); this.hasUnifiedChoice = true; this.settings = next; this.publish(); return this.state(); }
  async speak({ text, messageId, conversationId, generationId, preview = false }) {
    const settings = { ...this.settings };
    const request = ++this.requestVersion; await this.stop(false); if (request !== this.requestVersion) return;
    this.statusFrozen = false; this.errorCode = null; this.metadata = { messageId, conversationId, generationId, playbackId: randomUUID(), preview, sentence: '', sentenceIndex: null, confirmedSentences: 0, confirmedChunks: 0, receivedChunks: 0, style: settings.voice.startsWith('cosyvoice3:') ? settings.style : 'natural', requestedAt: Date.now(), firstAudioAt: null, lastStoppedAt: null };
    if (this.closed || !this.settings.enabled) { this.persistStatus('skipped', this.closed ? 'VOICE_CLOSED' : 'VOICE_DISABLED'); this.statusFrozen = true; return; }
    if (typeof text !== 'string' || !text.trim() || text.length > 600 || /```|https?:\/\/|\|.+\|/.test(text)) { this.phase = 'error'; this.recordFailure('SUMMARY_INVALID', 'validation'); this.publish(); return; }
    const sentences = text.match(/[^。！？!?；;\n]+[。！？!?；;]?/g)?.map(s => s.trim()).filter(Boolean) || [];
    if (!sentences.length || sentences.length > 12) { this.phase = 'error'; this.recordFailure('SUMMARY_SEGMENTS', 'validation'); this.publish(); return; }
    const op = this.current = { id: this.metadata.playbackId, abort: new AbortController(), cancelled: false }; this.error = ''; this.metadata.sentenceCount = sentences.length; this.metadata.sentenceIndex = 0;
    this.phase = 'synthesizing'; this.publish();
    const synth = (sentence, sentenceIndex = 0) => Promise.resolve().then(() => this.backend({ action: 'synthesize', text: sentence, voice: settings.voice, rate: settings.rate, style: settings.style, messageId, playbackId: op.id, sentenceIndex }, op.abort.signal));
    try {
      if (settings.streaming && settings.rate === 0 && settings.voice.startsWith('cosyvoice3:')) {
        let task = this.prepareChunks(sentences[0], 0, op, settings);
        for (let i = 0; i < sentences.length; i++) {
          const next = i + 1 < sentences.length ? task.done.then(() => { if (op.abort.signal.aborted) throw Error('已停止说话'); return this.prepareChunks(sentences[i + 1], i + 1, op, settings); }) : null; next?.catch(() => {});
          await this.playChunks(task, sentences[i], i, op, settings);
          if (op.cancelled || this.current !== op) return;
          this.metadata.confirmedSentences = i + 1; this.publish(); if (next) task = await next;
        }
      } else {
      let prepared = synth(sentences[0]); prepared.catch(() => {});
      for (let i = 0; i < sentences.length; i++) {
        this.metadata.sentenceIndex = i; this.phase = 'synthesizing'; this.publish();
        const result = await prepared; if (op.cancelled || this.current !== op) return;
        if (typeof result?.audio !== 'string' || result.audio.length > 6700000) throw speechFault('AUDIO_INVALID');
        const audio = Buffer.from(result.audio, 'base64'); if (audio.length < 44 || audio.length > 5000000 || audio.toString('ascii', 0, 4) !== 'RIFF' || audio.toString('ascii', 8, 12) !== 'WAVE') throw speechFault('AUDIO_INVALID');
        const next = i + 1 < sentences.length ? synth(sentences[i + 1], i + 1) : null; next?.catch(() => {});
        this.metadata.sentence = sentences[i]; this.metadata.sentenceIndex = i; this.phase = 'synthesizing'; this.publish();
        await new Promise((resolve, reject) => { op.play = { resolve, reject, index: i, started: false, startTimer: setTimeout(() => reject(speechFault('PLAYBACK_START_TIMEOUT')), this.playbackStartMs), timer: setTimeout(() => reject(speechFault('PLAYBACK_TIMEOUT')), this.playbackMs) }; this.emit('audio', { playbackId: op.id, index: i, sentence: sentences[i], audio: new Uint8Array(audio), volume: settings.volume, messageId }); });
        if (op.cancelled || this.current !== op) return; prepared = next;
      }
      }
      if (this.current === op && !op.cancelled) { this.phase = 'completed'; this.current = null; this.metadata.sentence = ''; this.publish(); }
    } catch (error) { if (this.current === op && !op.cancelled) { this.current = null; op.abort.abort(); this.phase = 'error'; const code = ERRORS[error?.code] ? error.code : 'SYNTHESIS_FAILED'; this.recordFailure(code, code.startsWith('PLAYBACK') ? 'playback' : code === 'AUDIO_INVALID' ? 'audio-validation' : 'synthesis'); this.metadata.sentence = ''; this.emit('stop', { playbackId: op.id }); this.publish(); } }
    finally { clearTimeout(op.play?.timer); clearTimeout(op.play?.startTimer); this.clearChunks(op); }
  }
  prepareChunks(text, index, op, settings) {
    const queue = new SpeechChunks(2), task = { queue, streamed: false };
    const cancel = () => queue.fail(Error('已停止说话')); op.abort.signal.addEventListener('abort', cancel, { once: true });
    task.done = Promise.resolve().then(() => {
      if (op.abort.signal.aborted) throw Error('已停止说话');
      return this.backend({ action: 'synthesize', text, voice: settings.voice, rate: settings.rate, style: settings.style, stream: true, messageId: this.metadata.messageId, playbackId: op.id, sentenceIndex: index,
        onChunk: chunk => { task.streamed = true; task.firstChunkAt ||= Date.now(); return queue.push(chunk); } }, op.abort.signal);
    }).then(async result => { if (!result?.streamed) { const chunk = chunkWave(result?.audio); task.firstChunkAt ||= Date.now(); await queue.push({ ...chunk, chunkIndex: 0 }); } else if (!task.firstChunkAt) throw speechFault('PROTOCOL'); queue.close(); }).catch(error => { queue.fail(error); for (const record of op.chunkPlays?.values() || []) record.reject(error); throw error; }).finally(() => op.abort.signal.removeEventListener('abort', cancel));
    task.done.catch(() => {}); return task;
  }
  async playChunks(task, sentence, index, op, settings) {
    this.metadata.sentence = sentence; this.metadata.sentenceIndex = index; this.metadata.chunkIndex = null; this.phase = 'synthesizing'; this.publish();
    const buffered = []; let seconds = 0, done = false;
    while (buffered.length < 2 && seconds < 1.2) { const item = await task.queue.next(); if (item.done) { done = true; break; } buffered.push(item.value); seconds += item.value.seconds; }
    const inFlight = [];
    const send = async chunk => {
      if (op.cancelled || this.current !== op) throw Error('已停止说话');
      this.metadata.streaming = task.streamed; this.metadata.firstChunkAt ||= task.firstChunkAt; this.metadata.receivedChunks++;
      const key = index + ':' + chunk.chunkIndex; let resolve, reject;
      const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); promise.catch(error => task.queue.fail(error));
      const record = { index, chunkIndex: chunk.chunkIndex, seconds: chunk.seconds, resolve, reject, promise, started: false,
        startTimer: setTimeout(() => reject(speechFault('PLAYBACK_START_TIMEOUT')), this.playbackStartMs + (inFlight.at(-1)?.seconds || 0) * 1000), timer: setTimeout(() => reject(speechFault('PLAYBACK_TIMEOUT')), this.playbackMs) };
      op.chunkPlays ||= new Map(); op.chunkPlays.set(key, record); inFlight.push(record);
      this.emit('audio', { playbackId: op.id, index, chunkIndex: chunk.chunkIndex, streamed: task.streamed, sentence, audio: new Uint8Array(Buffer.from(chunk.audio, 'base64')), volume: settings.volume, messageId: this.metadata.messageId });
      if (inFlight.length >= 2) await inFlight.shift().promise;
    };
    for (const chunk of buffered) await send(chunk);
    if (!done) for await (const chunk of task.queue) await send(chunk);
    await task.done; await Promise.all(inFlight.map(record => record.promise));
  }
  clearChunks(op) { for (const record of op.chunkPlays?.values() || []) { clearTimeout(record.timer); clearTimeout(record.startTimer); record.reject(Error('已停止说话')); } op.chunkPlays?.clear(); }
  player(event) {
    const op = this.current; if (!op || event?.playbackId !== op.id) return false;
    if (event.type === 'stopped') { op.stopAck?.(); return true; }
    if (Number.isInteger(event.chunkIndex)) {
      const key = event.index + ':' + event.chunkIndex, record = op.chunkPlays?.get(key); if (op.cancelled || !record) return false;
      if (event.type === 'started') { record.started = true; clearTimeout(record.startTimer); this.phase = 'playing'; this.metadata.chunkIndex = event.chunkIndex; this.metadata.firstAudioAt ||= Date.now(); this.publish(); }
      else if (event.type === 'ended' || event.type === 'failed') {
        clearTimeout(record.timer); clearTimeout(record.startTimer); op.chunkPlays.delete(key);
        if (event.type === 'failed' || !record.started) record.reject(speechFault(event.type === 'failed' ? 'PLAYBACK_FAILED' : 'PLAYBACK_START_TIMEOUT'));
        else { this.metadata.confirmedChunks++; record.resolve(); if (!op.chunkPlays.size) this.phase = 'synthesizing'; this.publish(); }
      } else return false; return true;
    }
    if (op.cancelled || event.index !== op.play?.index) return false;
    if (event.type === 'started') { op.play.started = true; clearTimeout(op.play.startTimer); this.phase = 'playing'; this.metadata.firstAudioAt ||= Date.now(); this.publish(); }
    else if (event.type === 'ended') { clearTimeout(op.play.timer); clearTimeout(op.play.startTimer); if (!op.play.started) op.play.reject(speechFault('PLAYBACK_START_TIMEOUT')); else { this.metadata.confirmedSentences = Math.max(this.metadata.confirmedSentences, op.play.index + 1); op.play.resolve(); } }
    else if (event.type === 'failed') { clearTimeout(op.play.timer); clearTimeout(op.play.startTimer); op.play.reject(speechFault('PLAYBACK_FAILED')); }
    else return false; return true;
  }
  async stop(invalidate = true) {
    if (invalidate) this.requestVersion++;
    const op = this.current; if (!op) return;
    if (op.stopping) return op.stopping;
    op.cancelled = true; op.abort.abort(); clearTimeout(op.play?.timer); clearTimeout(op.play?.startTimer); op.play?.reject(Error('已停止说话')); this.clearChunks(op); this.phase = 'stopping'; this.publish();
    op.stopping = (async () => { let timer; const confirmed = new Promise(resolve => { op.stopAck = () => resolve(true); timer = setTimeout(() => resolve(false), this.stopMs); }); this.emit('stop', { playbackId: op.id }); const stopped = await confirmed; clearTimeout(timer); if (this.current === op) { this.current = null; this.phase = stopped ? 'cancelled' : 'error'; if (stopped) { this.error = ''; this.errorCode = null; } else this.recordFailure('PLAYBACK_STOP_UNCONFIRMED', 'stop'); this.metadata.lastStoppedAt = Date.now(); this.metadata.sentence = ''; this.publish(); } })(); return op.stopping;
  }
  async close() { this.closed = true; await this.stop(); }
}
module.exports = { TtsService, systemSpeech };
