'use strict';
const fs = require('node:fs'), path = require('node:path');
const MAX_LOG_BYTES = 32768;
const ERRORS = Object.freeze({
  SUMMARY_INVALID: '本条保留全文，口语稿不可用', SUMMARY_SEGMENTS: '口语稿分段过多，请按需讲解',
  SYNTHESIS_FAILED: '语音合成失败，文字已保留', SYNTHESIS_TIMEOUT: '本机语音合成超时',
  AUDIO_INVALID: '语音音频格式无效', PLAYBACK_FAILED: '音频播放不可用，正文已保留',
  PLAYBACK_START_TIMEOUT: '音频播放启动未确认，请检查角色窗口', PLAYBACK_TIMEOUT: '音频播放结束超时',
  PLAYBACK_STOP_UNCONFIRMED: '播放停止未确认，请检查角色窗口', VOICE_DISABLED: '语音未开启', VOICE_CLOSED: '语音服务已关闭',
  GPU_MEMORY: '显存不足，请关闭其他占用显存的程序后重新加载声音',
  ENGINE_LOAD: 'CosyVoice3模型加载失败，请重新加载声音或检查可选语音包',
  PROFILE_LOAD: '所选音色未加载成功，请重新加载声音或检查保存的音色', PROFILE_PREPARE: '参考音色准备失败，请检查录音和对应文字',
  VOICE_GENERATE: '本机语音生成失败，文字已保留', PROCESS_EXIT: '语音模块意外退出',
  PROCESS_START: 'CosyVoice3运行环境无法启动', MODULE_NOT_READY: '语音模块未就绪或队列已满',
  MODULE_MISSING: 'CosyVoice3可选包缺失或版本不兼容', PRELOAD_FAILED: '所选音色预加载失败，请重新加载声音',
  NATIVE_INIT_CRASH: '本地语音运行库初始化异常退出，请重新加载声音',
  PROTOCOL: '语音模块协议无效', LOAD_TIMEOUT: 'CosyVoice3加载超时', PROFILE_TIMEOUT: '本机音色准备超时',
  PROCESS_STOP_UNCONFIRMED: '语音模块退出未确认', STATUS_WRITE: '语音状态写入失败',
  STYLE_UNSUPPORTED: '当前语音包不支持所选风格，请选择自然或更新可选语音包',
});
const safeId = value => typeof value === 'string' && /^[a-zA-Z0-9:._-]{1,160}$/.test(value) ? value : null;
function speechFault(code) { const error = Error(ERRORS[code] || ERRORS.SYNTHESIS_FAILED); error.code = ERRORS[code] ? code : 'SYNTHESIS_FAILED'; return error; }
function diagnostic(root, record) {
  try {
    const value = { at: new Date().toISOString(), layer: record.layer === 'tts' ? 'tts' : 'cosyvoice3',
      stage: typeof record.stage === 'string' && /^[a-z-]{1,40}$/.test(record.stage) ? record.stage : 'unknown',
      code: typeof record.code === 'number' && Number.isInteger(record.code) ? record.code : typeof record.code === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,80}$/.test(record.code) ? record.code : 'UNKNOWN' };
    for (const key of ['messageId', 'playbackId', 'requestId']) if (safeId(record[key])) value[key] = record[key];
    if (Number.isSafeInteger(record.sentenceIndex) && record.sentenceIndex >= 0 && record.sentenceIndex < 12) value.sentenceIndex = record.sentenceIndex;
    if (Number.isSafeInteger(record.chunkIndex) && record.chunkIndex >= 0 && record.chunkIndex < 128) value.chunkIndex = record.chunkIndex;
    const file = path.join(root, 'voice-module-diagnostics.jsonl'), line = Buffer.from(JSON.stringify(value) + '\n');
    let previous = Buffer.alloc(0), fd;
    try { fd = fs.openSync(file, 'r'); const bytes = fs.fstatSync(fd).size, start = Math.max(0, bytes - MAX_LOG_BYTES); previous = Buffer.alloc(Math.min(bytes, MAX_LOG_BYTES)); fs.readSync(fd, previous, 0, previous.length, start); if (start > 0) { const n = previous.indexOf(10); previous = n < 0 ? Buffer.alloc(0) : previous.subarray(n + 1); } } catch {} finally { if (fd !== undefined) fs.closeSync(fd); }
    while (previous.length + line.length > MAX_LOG_BYTES) { const n = previous.indexOf(10); previous = n < 0 ? Buffer.alloc(0) : previous.subarray(n + 1); }
    fs.mkdirSync(root, { recursive: true }); const temporary = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(temporary, Buffer.concat([previous, line]), { mode: 0o600 }); fs.renameSync(temporary, file); return true;
  } catch { return false; }
}
function writeStatus(root, value) {
  try { fs.mkdirSync(root, { recursive: true }); const file = path.join(root, 'speech-status.json'), temporary = file + '.' + process.pid + '.tmp'; fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); fs.renameSync(temporary, file); return true; }
  catch { return false; }
}
module.exports = { diagnostic, writeStatus, speechFault, safeId, ERRORS, MAX_LOG_BYTES };
