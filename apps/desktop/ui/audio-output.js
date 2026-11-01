(() => {
  'use strict';
  const host = window.desktop, records = new Set(), retired = new Set(); let context, playbackId, serial = 0, nextStart = 0, decodeChain = Promise.resolve(), metrics = {};
  function retire(id) { if (id) retired.add(id); if (retired.size > 32) retired.delete(retired.values().next().value); }
  function dispose(record, stop = false) { clearTimeout(record.startTimer); record.source.onended = null; if (stop) try { record.source.stop(); } catch {} record.source.disconnect(); record.gain.disconnect(); record.analyser.disconnect(); records.delete(record); }
  function clear(block = true) { if (block) retire(playbackId); serial++; for (const record of [...records]) dispose(record, true); nextStart = 0; decodeChain = Promise.resolve(); }
  const report = (type, value) => host.ttsPlayer({ type, playbackId: value.playbackId, index: value.index, ...(Number.isInteger(value.chunkIndex) ? { chunkIndex: value.chunkIndex } : {}) });
  host.onTtsStop(value => { retire(value.playbackId); if (value.playbackId === playbackId) clear(); void host.ttsPlayer({ type: 'stopped', playbackId: value.playbackId }); });
  host.onTtsAudio(value => {
    if (retired.has(value.playbackId)) return;
    if (playbackId !== value.playbackId) { clear(); playbackId = value.playbackId; metrics = { scheduledChunks: 0, completedChunks: 0, gapCount: 0, maxGapMs: 0 }; }
    else if (!value.streamed) clear(false);
    const generation = serial;
    decodeChain = decodeChain.then(async () => {
      if (generation !== serial || document.hidden) return;
      try {
        context ||= new AudioContext(); const bytes = new Uint8Array(value.audio), buffer = await context.decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
        if (generation !== serial || document.hidden) return;
        await context.resume(); if (generation !== serial) return;
        if (records.size >= 3) throw Error('audio queue limit');
        const source = context.createBufferSource(), gain = context.createGain(), analyser = context.createAnalyser(); source.buffer = buffer; gain.gain.value = value.volume; analyser.fftSize = 512;
        source.connect(gain).connect(analyser).connect(context.destination);
        const startAt = Math.max(context.currentTime + (!nextStart && value.streamed ? .5 : .035), nextStart), gap = nextStart ? Math.max(0, startAt - nextStart) : 0;
        if (gap > .01) { metrics.gapCount++; metrics.maxGapMs = Math.max(metrics.maxGapMs, Math.round(gap * 1000)); }
        nextStart = startAt + buffer.duration;
        const record = { source, gain, analyser, samples: new Float32Array(analyser.fftSize), envelope: VoiceEnvelope.prepare(buffer), startAt, endAt: nextStart, started: false }; records.add(record); metrics.scheduledChunks++;
        const started = () => {
          if (generation !== serial || record.started || !records.has(record)) return;
          if (context.state !== 'running' || context.currentTime < startAt) { record.startTimer = setTimeout(started, 10); return; }
          record.started = true; void report('started', value);
        };
        source.onended = () => { if (generation !== serial) return; started(); dispose(record); metrics.completedChunks++; void report('ended', value); };
        source.start(startAt); record.startTimer = setTimeout(started, Math.max(0, (startAt - context.currentTime) * 1000));
      } catch { if (generation === serial) { clear(); void report('failed', value); } }
    });
  });
  function current() { if (!context || context.state !== 'running' || document.hidden) return null; return [...records].find(r => context.currentTime >= r.startAt && context.currentTime < r.endAt); }
  function level() { const active = current(); if (!active || active.gain.gain.value <= 0) return 0; active.analyser.getFloatTimeDomainData(active.samples); let square = 0; for (const sample of active.samples) square += sample * sample; return Math.min(1, Math.sqrt(square / active.samples.length) * 5); }
  function mouthLevel() { const active = current(); return active ? VoiceEnvelope.at(active.envelope, context.currentTime - active.startAt - (context.outputLatency || 0), active.gain.gain.value) : 0; }
  host.onLifecycle(value => { if (!value.visible || value.paused) clear(); }); window.addEventListener('pagehide', () => { clear(); void context?.close(); });
  window.audioOutput = { level, mouthLevel, get state() { return { playing: !!current(), contextState: context?.state, level: level(), mouthLevel: mouthLevel(), playbackId, queuedChunks: records.size, ...metrics }; } };
})();
