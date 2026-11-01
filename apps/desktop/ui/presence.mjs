import './task-presentation.js';
const canvas = document.getElementById('native-avatar'), fallback = document.getElementById('fallback');
const status = document.getElementById('presence-status'), host = window.desktop;
let avatar, frame = 0, paused = false, visible = !document.hidden, disposed = false, drag = null, error = '', failed = false;
let booted = false, queuedInstruction = null, characterName = '角色';
let chat = { revision: -1, busy: false, phase: 'idle' };
let speech = { revision: -1, active: false, phase: 'idle' };
let agent = { revision: -1, active: false, pending: false };
let playback = { phase: 'idle', active: false };
const taskPresentation = new AvatarTaskPresentation.TaskPresentation();
function displayInstruction(instruction) {
  const task = taskPresentation.update?.snapshot;
  const activeTask = task && !['succeeded', 'failed', 'cancelled'].includes(task.task_state);
  if (!activeTask && agent.pending) return { state: 'waiting', reason: '等待用户决定', confirmed: false, label: '等你决定' };
  if (!activeTask && agent.active) return { state: 'working', reason: 'Harness工具正在执行', confirmed: false, label: '正在办事' };
  if (!activeTask && speech.active) return { state: ['starting', 'listening'].includes(speech.phase) ? 'listening' : 'thinking', reason: '本地语音输入', confirmed: false, label: ['starting', 'listening'].includes(speech.phase) ? '正在倾听' : '正在识别语音' };
  if (!activeTask && playback.phase === 'playing') return { state: 'speaking', reason: '正在播放本机语音', confirmed: false, label: '正在说话' };
  return !activeTask && chat.busy ? { state: chat.phase === 'stopping' ? 'waiting' : 'thinking', reason: '文字对话处理中', confirmed: false, label: '正在回复' } : instruction;
}
function speechUpdate(update) {
  if (!update || update.revision <= speech.revision) return;
  const wasActive = speech.active; speech = update;
  if (wasActive || speech.active) { queuedInstruction = displayInstruction(taskPresentation.restore()); flushTask(); report(); }
}
function chatUpdate(update) {
  if (!update || !Number.isSafeInteger(update.revision) || update.revision <= chat.revision) return;
  const wasBusy = chat.busy; chat = update;
  // A reply is conversational text, never a verified task success event.
  const activeTask = taskPresentation.update?.snapshot && !['succeeded', 'failed', 'cancelled'].includes(taskPresentation.update.snapshot.task_state);
  if (!activeTask && (wasBusy || chat.busy)) { queuedInstruction = displayInstruction(taskPresentation.restore()); flushTask(); report(); }
}
function flushTask() {
  if (!queuedInstruction || !booted || !avatar?.ready || !visible || paused) return;
  const state = avatar.driver.getState();
  if (state.dragging || state.gesture?.startsWith('interaction.drag') || state.settling) return;
  const next = displayInstruction(queuedInstruction); queuedInstruction = null;
  avatar.driver.setExpression('auto'); avatar.driver.setState(next.state, { reason: next.reason, confirmed: next.confirmed });
}
function taskUpdate(update) {
  const next = taskPresentation.accept(update, booted && avatar?.ready && visible && !paused && !drag?.started);
  if (!next) return; queuedInstruction = next; flushTask(); report();
}
function report() {
  const detail = error ? '原生角色不可用 · 静态回退' : !avatar?.ready ? '正在加载' : paused ? '动态已暂停' : displayInstruction(taskPresentation.last).label;
  const state = { ready: !!avatar?.ready, paused, status: characterName + ' · ' + detail, error, parameters: avatar?.entries.size || 0, textures: avatar?.textures.length || 0, frames: avatar?.frames || 0 };
  status.textContent = state.status; canvas.dataset.ready = String(state.ready); host?.reportPresence(state);
}
function stopDrag(event, click = false) {
  const previous = drag; drag = null;
  if (previous) {
    if (canvas.hasPointerCapture(previous.id)) canvas.releasePointerCapture(previous.id);
    if (previous.started) { avatar?.driver.endDrag(); host?.endDrag(); }
    else if (click && !paused) avatar?.driver.triggerGesture('interaction.tap', { direction: previous.x < innerWidth / 2 ? -1 : 1 });
  }
}
function stopLoop() { cancelAnimationFrame(frame); frame = 0; avatar?.suspend(); stopDrag(); }
function fail(reason) {
  failed = true; error = reason.message || String(reason); stopLoop(); avatar?.dispose();
  canvas.hidden = true; fallback.hidden = false; host?.setHit(false); report();
}
function tick(now) {
  frame = 0; if (disposed || failed || !visible || paused || !avatar?.ready) return;
  try { flushTask(); avatar.render(now); } catch (reason) { fail(reason); return; }
  frame = requestAnimationFrame(tick);
}
function resumeLoop() { if (!frame && !disposed && !failed && visible && !paused && avatar?.ready) frame = requestAnimationFrame(tick); }
function lifecycle(next) {
  const wasInactive = !visible || paused;
  visible = !!next.visible && !document.hidden;
  if (typeof next.paused === 'boolean') paused = next.paused;
  avatar?.driver.setPaused(paused);
  if (!visible || paused) { queuedInstruction = taskPresentation.restore(); stopLoop(); }
  else { if (wasInactive) queuedInstruction = taskPresentation.restore(); flushTask(); resumeLoop(); } report();
}
function pointer(x, y) {
  if (!avatar?.ready || !visible) return;
  const rect = canvas.getBoundingClientRect(), nx = (x - rect.left) / rect.width, ny = (y - rect.top) / rect.height;
  if (!paused) avatar.driver.setMouse(nx * 2 - 1, 1 - ny * 2);
  if (!drag) host?.setHit(avatar.hitTest(nx, ny), { x, y });
}
canvas.addEventListener('pointerdown', event => {
  host?.interact();
  if (event.button !== 0 || !avatar?.ready) return;
  const rect = canvas.getBoundingClientRect();
  if (!avatar.hitTest((event.clientX - rect.left) / rect.width, (event.clientY - rect.top) / rect.height)) return;
  drag = { id: event.pointerId, x: event.clientX, y: event.clientY, screenX: event.screenX, screenY: event.screenY, lastX: event.screenX, time: event.timeStamp, started: false };
  canvas.setPointerCapture(event.pointerId);
});
canvas.addEventListener('pointermove', event => {
  pointer(event.clientX, event.clientY);
  if (!drag || drag.id !== event.pointerId) return;
  if (!drag.started && Math.hypot(event.screenX - drag.screenX, event.screenY - drag.screenY) > 5) {
    drag.started = paused || avatar.driver.beginDrag(); if (drag.started) host?.beginDrag();
  }
  if (drag.started) { avatar.driver.moveDrag((event.screenX - drag.lastX) / Math.max(1, event.timeStamp - drag.time)); host?.drag(); }
  drag.lastX = event.screenX; drag.time = event.timeStamp;
});
canvas.addEventListener('pointerup', event => stopDrag(event, true));
canvas.addEventListener('pointercancel', stopDrag); canvas.addEventListener('lostpointercapture', stopDrag);
document.getElementById('character').addEventListener('contextmenu', event => { event.preventDefault(); stopDrag(); host?.showCharacterMenu(); });
window.addEventListener('blur', () => { stopDrag(); avatar?.driver.setMouse(0, 0); });
document.addEventListener('visibilitychange', () => lifecycle({ visible: !document.hidden }));
canvas.addEventListener('webglcontextlost', event => { event.preventDefault(); failed = true; error = 'WebGL 上下文丢失，等待恢复；也可从面板重新加载'; stopLoop(); canvas.hidden = true; fallback.hidden = false; host?.setHit(false); report(); });
canvas.addEventListener('webglcontextrestored', () => location.reload());
const observer = new ResizeObserver(() => { if (avatar?.ready) { host?.reportHeadAnchor(avatar.headAnchor()); if (paused && visible) { try { avatar.render(performance.now(), true); } catch (reason) { fail(reason); } } } }); observer.observe(canvas);
const unsubscribeLifecycle = host?.onLifecycle(lifecycle), unsubscribePointer = host?.onPointer(p => pointer(p.x, p.y));
const unsubscribeTask = host?.onTask(taskUpdate);
const unsubscribeChat = host?.onChat(chatUpdate);
const unsubscribeSpeech = host?.onSpeech(speechUpdate);
const unsubscribeTts = host?.onTts(value => { playback = value; if (!value.active) avatar?.silenceAudio(); queuedInstruction = displayInstruction(taskPresentation.restore()); flushTask(); report(); });
function agentUpdate(value) { if (!value || value.revision < agent.revision) return; agent = value; queuedInstruction = displayInstruction(taskPresentation.restore()); flushTask(); report(); }
const unsubscribeAgent = host?.onAgent(agentUpdate);
const timer = setInterval(report, 1000);
window.addEventListener('pagehide', () => { disposed = true; clearInterval(timer); stopLoop(); observer.disconnect(); unsubscribeLifecycle?.(); unsubscribePointer?.(); unsubscribeTask?.(); unsubscribeChat?.(); unsubscribeSpeech?.(); unsubscribeAgent?.(); unsubscribeTts?.(); avatar?.dispose(); }, { once: true });
// Read-only diagnostics; this is not a model expression or task-control interface.
window.presenceDebug = { get state() { return { ready: !!avatar?.ready, paused, visible, failed, error, frames: avatar?.frames || 0, values: avatar?.values, nativeMouthOpenY: avatar?.mouthValue() || 0, driver: avatar?.driver.getState(), task: taskPresentation.update, chat, successFeedbacks: taskPresentation.feedbacks }; } };
try {
  if (host) characterName = (await host.getPresence()).characterName || characterName;
  document.title = characterName + ' · 桌面驻留';
  const { NativeAvatar } = await import('/native-avatar.mjs');
  if (!disposed) {
    avatar = new NativeAvatar(canvas); await avatar.load();
    if (!disposed) {
      host?.reportAnchor(avatar.anchor());
      host?.reportHeadAnchor(avatar.headAnchor());
      if (host) { lifecycle(await host.getPresence()); taskUpdate(await host.getTask()); chatUpdate(await host.getChatPresence()); speechUpdate(await host.getSpeech()); agentUpdate(await host.getAgent()); }
      booted = true; queuedInstruction = taskPresentation.restore(); flushTask(); report(); resumeLoop();
    }
  }
} catch (reason) { if (!disposed) fail(reason); }
