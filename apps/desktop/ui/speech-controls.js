(() => {
  'use strict';
  const host = window.desktop, $ = id => document.getElementById(id);
  let capture = null, revision = -1, draftId = null;
  let lastCapture = null;
  window.speechDebug = { get state() { return capture ? { active: true, samples: capture.count, peak: capture.peak || 0, contextState: capture.context?.state } : { active: false, ...lastCapture }; } };
  async function release(recording) {
    if (!recording) return;
    recording.stream?.getTracks().forEach(track => track.stop()); recording.source?.disconnect(); recording.node?.disconnect(); recording.gain?.disconnect();
    if (recording.context && recording.context.state !== 'closed') await recording.context.close().catch(() => {});
  }
  function wav(chunks, count) {
    const bytes = new ArrayBuffer(44 + count * 2), view = new DataView(bytes);
    const string = (offset, value) => Array.from(value).forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
    string(0, 'RIFF'); view.setUint32(4, bytes.byteLength - 8, true); string(8, 'WAVE'); string(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, 16000, true); view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); string(36, 'data'); view.setUint32(40, count * 2, true);
    let offset = 44;
    for (const chunk of chunks) for (const sample of chunk) { if (offset >= bytes.byteLength) break; view.setInt16(offset, Math.round(Math.max(-1, Math.min(1, sample)) * 32767), true); offset += 2; }
    return new Uint8Array(bytes);
  }
  async function command(value) {
    if (value.action === 'start') {
      if (capture) await release(capture);
      const recording = capture = { id: value.id, chunks: [], count: 0 };
      try {
        recording.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }, video: false });
        if (capture !== recording) { await release(recording); return; }
        recording.context = new AudioContext({ sampleRate: 16000 });
        if (recording.context.sampleRate !== 16000) throw Error('sample-rate');
        await recording.context.audioWorklet.addModule('/pcm-worklet.js');
        if (capture !== recording) { await release(recording); return; }
        recording.source = recording.context.createMediaStreamSource(recording.stream); recording.node = new AudioWorkletNode(recording.context, 'pcm-capture'); recording.gain = recording.context.createGain(); recording.gain.gain.value = 0;
        recording.node.port.onmessage = event => { if (capture !== recording) return; const length = Math.min(event.data.length, 960000 - recording.count); if (length > 0) { const chunk = event.data.slice(0, length); recording.chunks.push(chunk); recording.count += length; for (const value of chunk) recording.peak = Math.max(recording.peak || 0, Math.abs(value)); } };
        recording.source.connect(recording.node).connect(recording.gain).connect(recording.context.destination); await recording.context.resume();
        if (capture !== recording) { await release(recording); return; }
        for (const track of recording.stream.getAudioTracks()) track.onended = () => { if (capture === recording) { capture = null; void release(recording); void host.speechCapture({ id: recording.id, type: 'error', reason: 'device' }); } };
        await host.speechCapture({ id: value.id, type: 'started' });
      } catch (error) { if (capture === recording) capture = null; await release(recording); await host.speechCapture({ id: value.id, type: 'error', reason: error.name === 'NotAllowedError' ? 'permission' : 'device' }); }
    } else if (capture?.id === value.id) {
      const recording = capture; capture = null; await release(recording);
      lastCapture = { samples: recording.count, peak: recording.peak || 0 };
      if (value.action === 'stop') await host.speechCapture({ id: value.id, type: 'audio', audio: wav(recording.chunks, recording.count) });
    }
  }
  function render(state, restored = false) {
    if (state.revision < revision) return; revision = state.revision;
    const labels = { idle: '按快捷键或点击按钮开始倾听', starting: '正在打开麦克风…', listening: '正在倾听；再次按快捷键结束', stopping: '正在结束录音…', transcribing: '正在本地识别…', cancelling: '正在关闭倾听…', ready: '语音已转成文字', cancelled: '已关闭倾听', error: '语音输入未完成' };
    $('speech-state').textContent = state.error || labels[state.phase];
    $('speech-toggle').textContent = ['starting', 'listening'].includes(state.phase) ? '结束倾听' : ['stopping', 'transcribing', 'cancelling'].includes(state.phase) ? '取消识别' : '语音输入';
    $('speech-toggle').disabled = !state.ready; if (state.shortcut) $('speech-shortcut-hint').textContent = state.shortcut;
    if (restored && state.phase === 'ready') draftId = state.recordingId;
    if (state.phase === 'ready' && !restored && !state.autoSent && state.recordingId !== draftId) {
      draftId = state.recordingId;
      // Never silently overwrite a typed draft. Append recognized speech for review.
      $('chat-input').value = [$('chat-input').value.trim(), state.text].filter(Boolean).join('\n');
      if ($('chat-input').value.length > 4000) $('speech-state').textContent = '文字已保留；合并草稿超过 4000 字符，请删减后发送。';
      if (!$('chat-input').disabled) $('chat-input').focus();
    }
    $('speech-resource-state').textContent = state.ready ? '本地 SenseVoice 已就绪，录音不上传。' : '语音资源尚未就绪，请准备本地识别组件。';
  }
  $('speech-toggle').onclick = async () => { const result = await host.speechCommand('toggle'); if (!result.ok) $('speech-state').textContent = result.error; };
  host.onCapture(value => { void command(value).catch(() => { $('speech-state').textContent = '录音中断，请重试'; }); });
  host.onSpeech(render); host.getSpeech().then(state => render(state, true));
  host.onShortcut(value => { $('speech-shortcut-hint').textContent = value; });
  window.addEventListener('pagehide', () => { const previous = capture; capture = null; void release(previous); });
})();
