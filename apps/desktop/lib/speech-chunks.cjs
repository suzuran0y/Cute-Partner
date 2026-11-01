'use strict';
const { speechFault } = require('./speech-observability.cjs');
// A bounded producer queue. The worker receives its chunk acknowledgement only after push resolves.
class SpeechChunks {
  constructor(limit = 2) { this.limit = limit; this.items = []; this.readers = []; this.writers = []; }
  async push(value) {
    while (!this.error && !this.ended && this.items.length >= this.limit) await new Promise((resolve, reject) => this.writers.push({ resolve, reject }));
    if (this.error) throw this.error; if (this.ended) throw speechFault('PROTOCOL');
    const reader = this.readers.shift(); if (reader) reader.resolve({ value, done: false }); else this.items.push(value);
  }
  next() {
    if (this.error) return Promise.reject(this.error);
    if (this.items.length) { const value = this.items.shift(); this.writers.shift()?.resolve(); return Promise.resolve({ value, done: false }); }
    if (this.ended) return Promise.resolve({ done: true });
    return new Promise((resolve, reject) => this.readers.push({ resolve, reject }));
  }
  close() { this.ended = true; for (const reader of this.readers.splice(0)) reader.resolve({ done: true }); }
  fail(error) { if (this.error) return; this.error = error; this.items = []; for (const waiter of [...this.readers.splice(0), ...this.writers.splice(0)]) waiter.reject(error); }
  [Symbol.asyncIterator]() { return this; }
}
function chunkWave(audio) {
  if (typeof audio !== 'string' || audio.length > 6700000) throw speechFault('AUDIO_INVALID');
  const wave = Buffer.from(audio, 'base64');
  if (wave.length < 44 || wave.length > 5000000 || wave.toString('ascii', 0, 4) !== 'RIFF' || wave.toString('ascii', 8, 12) !== 'WAVE') throw speechFault('AUDIO_INVALID');
  let format, data;
  for (let offset = 12; offset + 8 <= wave.length;) {
    const name = wave.toString('ascii', offset, offset + 4), bytes = wave.readUInt32LE(offset + 4), start = offset + 8;
    if (start + bytes > wave.length) throw speechFault('AUDIO_INVALID');
    if (name === 'fmt ' && bytes >= 16) format = { type: wave.readUInt16LE(start), channels: wave.readUInt16LE(start + 2), rate: wave.readUInt32LE(start + 4), align: wave.readUInt16LE(start + 12), bits: wave.readUInt16LE(start + 14) };
    if (name === 'data') data = bytes;
    offset = start + bytes + (bytes % 2);
  }
  if (!format || format.type !== 1 || format.bits !== 16 || ![1, 2].includes(format.channels) || format.align !== format.channels * 2 || format.rate < 8000 || format.rate > 96000 || !data || data % format.align) throw speechFault('AUDIO_INVALID');
  return { audio, seconds: data / (format.rate * format.align), bytes: wave.length };
}
module.exports = { SpeechChunks, chunkWave };
