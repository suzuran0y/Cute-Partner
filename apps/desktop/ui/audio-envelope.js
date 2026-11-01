/* The envelope follows decoded PCM at the actual playback clock, never a timer animation. */
((root) => {
  'use strict';
  function prepare(buffer) {
    const stride = Math.max(1, Math.round(buffer.sampleRate * .02)), values = [], channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i));
    for (let offset = 0; offset < buffer.length; offset += stride) {
      const end = Math.min(buffer.length, offset + stride); let square = 0;
      for (const channel of channels) for (let i = offset; i < end; i++) square += channel[i] * channel[i];
      values.push(Math.sqrt(square / ((end - offset) * channels.length)));
    }
    const voiced = values.filter(v => v > .0025).sort((a, b) => a - b);
    return { values, step: stride / buffer.sampleRate, duration: buffer.length / buffer.sampleRate, reference: Math.max(.025, voiced[Math.floor((voiced.length - 1) * .85)] || 0) };
  }
  function at(envelope, seconds, volume) {
    if (!envelope || !Number.isFinite(seconds) || seconds < 0 || seconds >= envelope.duration || !Number.isFinite(volume) || volume <= 0) return 0;
    const position = seconds / envelope.step, index = Math.floor(position), mix = position - index;
    const rms = (envelope.values[index] || 0) * (1 - mix) + (envelope.values[index + 1] || 0) * mix;
    if (rms <= .0025) return 0;
    const normalized = Math.min(1, (rms - .0025) / Math.max(.001, envelope.reference - .0025));
    return Math.min(.92, .9 * Math.pow(normalized, .65) * Math.sqrt(Math.min(1, volume)));
  }
  const api = { prepare, at }; if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.VoiceEnvelope = api;
})(globalThis);
