'use strict';
const { app, BrowserWindow, ipcMain, screen, Menu, Tray, nativeImage, globalShortcut, utilityProcess, powerMonitor, dialog, clipboard, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const ROOT = __dirname;
const checkId = process.argv.find(arg => /^--presence-check=[a-zA-Z0-9-]+$/.test(arg))?.slice('--presence-check='.length);
const RUNTIME = checkId ? path.join(ROOT, '.runtime', 'presence-check', checkId) : path.join(ROOT, '.runtime');
const { sizeFor, clampBounds, scaledBounds, readSettings } = require('./lib/presence-geometry.cjs');
const { presenceMenu } = require('./lib/presence-menu.cjs');
const { TaskLink } = require('./lib/task-link.cjs');
const { ChatService } = require('./lib/chat-service.cjs');
const { CompanionSettings, validate: validateCompanion, importText, contextRevision } = require('./lib/companion-settings.cjs');
const { HarnessProvider } = require('./lib/harness-provider.cjs');
const { DataService, applyPending } = require('./lib/data-service.cjs');
const { GrowthService } = require('./lib/growth-service.cjs');
const { MemoryService } = require('./lib/memory-service.cjs');
const { AgentService } = require('./lib/agent-service.cjs');
const { prepareWorkspace } = require('./lib/agent-workspace.cjs');
const { SpeechService } = require('./lib/speech-service.cjs');
const { TtsService, systemSpeech } = require('./lib/tts-service.cjs');
const { CosyVoiceModule } = require('./lib/cosyvoice-module.cjs');
const { canSpeakReply, cloudReply } = require('./lib/reply-format.cjs');
const { VoiceProfiles } = require('./lib/voice-profiles.cjs');
const { queryBalance } = require('./lib/account-balance.cjs');
const { UsageLedger } = require('./lib/usage-ledger.cjs');
const { BudgetGuard } = require('./lib/budget-guard.cjs');
const { cloudSize: fitCloud } = require('./lib/cloud-sizing.cjs');
const { questionSpeech } = require('./lib/question-input.cjs');
const { cloudLayout } = require('./lib/cloud-geometry.cjs');
const { VoiceShortcut } = require('./lib/voice-shortcut.cjs');
const { ensureDesktopShortcut } = require('./lib/desktop-shortcut.cjs');
const CHARACTER_NAME = require('../../characters/default/character.json').displayName;
const iconPath = path.join(ROOT, 'assets', 'character-icon.png');
const settingsPath = path.join(RUNTIME, 'presence-settings.json');
let settings = readSettings(null);
try { settings = readSettings(JSON.parse(fs.readFileSync(settingsPath, 'utf8'))); } catch { /* First run or damaged preferences: use safe defaults. */ }
fs.mkdirSync(path.join(RUNTIME, 'electron-profile'), { recursive: true });
app.setPath('userData', path.join(RUNTIME, 'electron-profile'));
if(!app.requestSingleInstanceLock()){app.quit();return;}
let dataStartupResult;
try{dataStartupResult=applyPending(RUNTIME);}catch(error){dialog.showErrorBox('小本本资料需要检查',error.message+'。资料和恢复记录保留在本机，请勿重复载入。');app.quit();return;}
// Read visual preferences again after a confirmed restore/reset.
try{settings=readSettings(JSON.parse(fs.readFileSync(settingsPath,'utf8')));}catch{settings=readSettings(null);}
let panel, debug, reader, pet, cloud, worker, tray, origin, dragStart = null, quitting = false, scale = settings.scale;
let readerDraft = '', readerBoundsTimer;
try { const draft = JSON.parse(fs.readFileSync(path.join(RUNTIME, 'conversation-draft.json'), 'utf8')).text; if (typeof draft === 'string' && draft.length <= 4000) readerDraft = draft; } catch {}
let paused = false, suspended = false, pointerTimer, anchor = { x: .5, y: .9 };
let alwaysOnTop = settings.alwaysOnTop, stackPending = false, menuOpen = false;
let petMouseIgnored = null;
let presence = { ready: false, status: '正在加载原生角色', error: '' };
let windowsReady = false, desktopShortcutAttempted = false;
function prepareDesktopShortcut() {
  if (checkId || desktopShortcutAttempted || !windowsReady || !presence.ready) return;
  desktopShortcutAttempted = true;
  try { ensureDesktopShortcut({ shell, desktop: app.getPath('desktop'), root: ROOT, runtime: RUNTIME }); }
  catch (error) { console.warn('Desktop shortcut: ' + error.message); }
}
let taskLink;
const companion = new CompanionSettings(RUNTIME);
const memoryService = new MemoryService({ root: path.join(RUNTIME, 'memory'), legacy: companion.state().memory });
const growth = new GrowthService({root:RUNTIME,companion,memory:memoryService});
const ledger = new UsageLedger(path.join(RUNTIME, 'chat'));
const budgetGuard = new BudgetGuard({ root: RUNTIME, query: queryBalance, ledger });
const agentService = new AgentService({ root: path.join(RUNTIME, 'agent'), sourceRoot: ROOT, memory: memoryService, growth, budgetCheck: async () => { const provider = chatService.provider; try { return await budgetGuard.check(); } catch (error) { setImmediate(() => { if (chatService.provider === provider && chatService.state().busy) void chatService.stop(error.message); }); throw error; } } });
const agentWorkspace = prepareWorkspace({ runtime: RUNTIME, checkId }), defaultAgentWorkspace = agentWorkspace.directory;
if (companion.state().agentWorkspace && path.resolve(companion.state().agentWorkspace).toLowerCase() === path.resolve(agentWorkspace.legacy).toLowerCase()) companion.save({ ...companion.state(), agentWorkspace: defaultAgentWorkspace });
function runtimeContext(drawerId = 'general') { const value = { ...companion.state(), memory: '', agentWorkspace: companion.state().agentWorkspace || defaultAgentWorkspace, runtimePolicyVersion: 5 }; return { ...value, drawerId, drawerName: memoryService.state().drawers.find(d => d.id === drawerId)?.name || '日常', personaRevision: contextRevision({ ...value, agentWorkspace: '', agentMode: 'workspace' }), permissionRevision: contextRevision({ ...value, persona: '' }), contextRevision: contextRevision(value), speechStatusFile: path.join(RUNTIME, 'speech-status.json'), voiceDiagnosticFile: path.join(RUNTIME, 'voice-module-diagnostics.jsonl') }; }
const chatService = new ChatService({ root: path.join(RUNTIME, 'chat'), context: runtimeContext, ledger, memory: memoryService, growth, budget: budgetGuard, factory: options => new HarnessProvider({ ...options, agentBridge: agentService }) });
growth.on('update',value=>{ if(panel&&!panel.isDestroyed()) panel.webContents.send('host:growth',{revision:value.revision,personaRevision:value.personaRevision}); if(reader&&!reader.isDestroyed()) reader.webContents.send('host:growth',{revision:value.revision}); });
const dataService=new DataService({root:RUNTIME,memory:memoryService,snapshot:()=>{growth.syncPersona();growth.reconcileArchives();saveSettings();saveReaderBounds();chatService.save();ledger.save();return {'companion-settings.json':validateCompanion(companion.state()),'budget-settings.json':{...budgetGuard.settings},'speech-output-settings.json':{...tts.settings,schemaVersion:2},'voice-module-settings.json':{selection:naturalVoice.selection},'presence-settings.json':JSON.parse(fs.readFileSync(settingsPath,'utf8')),'growth-state.json':structuredClone(growth.value)};}});
function dataIdle(){if(chatService.state().busy||agentService.state().pending||speech.state().active||tts.state().active||creatingVoice||savingVoice||balanceQuery||budgetGuard.pending)throw Error('等她说完、录音和声音准备结束后，再整理小本本。');}
function guardedHandle(channel,handler){ipcMain.handle(channel,(event,...args)=>{const win=allowed(event),windows={'chat-command':[debug,reader],'tts-command':[panel,cloud,reader],'draft-save':[reader,cloud],'growth-command':[panel,cloud],'drawer-create':[reader],'settings-command':[panel,debug],'cloud-send':[cloud],'speech-command':[debug],'agent-command':[panel,debug]};if(!(windows[channel.slice(5)]||[panel]).includes(win))throw Error('无效宿主来源');if(dataService.busy)return {ok:false,error:'小本本正在整理，先完成或取消这次操作吧。'};return handler(event,...args);});}
budgetGuard.on('update', value => { if (panel && !panel.isDestroyed()) panel.webContents.send('host:budget', value); });
chatService.on('tool', ({ sessionId, event }) => agentService.note(sessionId, event));
let lastPermissionId, lastQuestionId, questionPaintTimer; const questionPainted = new Set();
agentService.on('update', value => {
  for (const win of [panel, debug]) if (win && !win.isDestroyed()) win.webContents.send('host:agent', value);
  if (pet && !pet.isDestroyed()) pet.webContents.send('host:agent', { revision: value.revision, active: value.active, pending: value.pending });
  const state = agentService.questions.state(), expired = state.requests.findLast(r => r.status === 'timed-out');
  if (expired?.turnId === chatService.generationId && chatService.state().busy) void chatService.stop('追问等待超时，没有收到答案或授权；本轮已停止，可重新发起。');
  if (reader && !reader.isDestroyed()) reader.webContents.send('host:questions', state);
  if (cloud && !cloud.isDestroyed()) cloud.webContents.send('host:questions', cloudQuestions(state));
  const question = pendingQuestion();
  if (question) {
    showPendingQuestion();
    if (question.id !== lastQuestionId) { lastQuestionId = question.id; clearTimeout(questionPaintTimer); questionPaintTimer = setTimeout(() => { if (pendingQuestion()?.id === question.id && !questionPainted.has(question.id)) { question.voiceNotice = '白云问题卡片暂未显示，可点全文在聊聊中回答；草稿已保留。'; showPendingQuestion(); } }, 2200); }
  } else if (cloudValue?.kind === 'question') { clearTimeout(questionPaintTimer); if (String(tts.state().messageId || '').startsWith('question:')) void tts.stop(); showCloud(null); }
  const approval = value.requests.find(r => r.kind === 'approval'); if (approval && approval.id !== lastPermissionId) { lastPermissionId = approval.id; openInfo('settings'); if (!question) showCloud({ id: approval.id, kind: 'status', text: '这一步需要你决定，已放到小本本里。' }); }
});
let observedMemoryEpoch = memoryService.state().privacyEpoch;
memoryService.on('update', value => { if (value.privacyEpoch !== observedMemoryEpoch) { observedMemoryEpoch = value.privacyEpoch; if (chatService.state().busy) void chatService.stop('记忆整理涉及遗忘或撤销，已停止旧上下文；下次交流会使用更新后的记忆。'); } if (reader && !reader.isDestroyed()) reader.webContents.send('host:drawer-directory'); if (panel && !panel.isDestroyed()) panel.webContents.send('host:memory', { revision: value.revision }); });
const speech = new SpeechService();
const naturalVoice = new CosyVoiceModule({ root: RUNTIME, fallback: systemSpeech });
const voiceProfiles = new VoiceProfiles(RUNTIME);
const tts = new TtsService({ root: RUNTIME, defaultVoice: naturalVoice.resources() ? voiceProfiles.defaultVoice() || undefined : undefined, backend: (input, signal) => naturalVoice.backend(input, signal) });
// Migrate the old separate backend choice without overwriting a saved unified voice choice.
if (!tts.hasUnifiedChoice && naturalVoice.selection === 'cosyvoice3' && !tts.settings.voice.startsWith('cosyvoice3:')) tts.settings.voice = 'cosyvoice3:official-demo';
let voiceReference, creatingVoice = false, savingVoice = false;
function voiceChoice(voice) {
  if (!voice.startsWith('cosyvoice3:')) return { selection: 'system', profileId: 'official-demo' };
  const profileId = voice.slice('cosyvoice3:'.length); if (!/^(official-demo|voice-[a-f0-9-]{36})$/.test(profileId)) throw Error('音色编号无效');
  return { selection: 'cosyvoice3', profileId };
}
async function configureVoice() { return naturalVoice.configure({ enabled: tts.settings.enabled, ...voiceChoice(tts.settings.voice) }); }
async function saveVoice(value) {
  if (savingVoice) throw Error('声音设置正在保存，请稍候');
  const next = tts.validate(value); voiceChoice(next.voice);
  savingVoice = true;
  try {
    if (!next.enabled) await naturalVoice.configure({ enabled: false, ...voiceChoice(next.voice) });
    const result = await tts.save(next); await configureVoice(); return result;
  } finally { savingVoice = false; }
}
naturalVoice.on('update', value => { if (panel && !panel.isDestroyed()) panel.webContents.send('host:voice-module', value); });
let lastTtsGeneration, lastAutoSpoken;
function voiceAllowed() { return !savingVoice && !creatingVoice && companion.state().communicationMode === 'voice' && pet && !pet.isDestroyed() && pet.isVisible() && !paused && !suspended && !quitting; }
tts.on('audio', value => { if (voiceAllowed()) pet.webContents.send('host:tts-audio', value); else tts.player({ type: 'failed', playbackId: value.playbackId, index: value.index, chunkIndex: value.chunkIndex }); });
tts.on('stop', value => { if (pet && !pet.isDestroyed()) pet.webContents.send('host:tts-stop', value); else tts.player({ type: 'stopped', playbackId: value.playbackId }); });
tts.on('update', value => {
  const question = pendingQuestion(); if (question && value.phase === 'playing' && String(value.messageId || '').startsWith('question:' + question.id + ':') && question.voiceNotice?.startsWith('读题未完成')) { question.voiceNotice = ''; showPendingQuestion(); } if (question && value.phase === 'error' && String(value.messageId || '').startsWith('question:' + question.id + ':')) { question.voiceNotice = '读题未完成，文字问题已保留：' + value.error; showPendingQuestion(); }
  const message = chatService.messages.find(m => m.id === value.messageId);
  if (message) { message.playback = { phase: value.phase, firstAudioAt: value.firstAudioAt, lastStoppedAt: value.lastStoppedAt, error: value.error }; chatService.save(); }
  for (const win of [pet, panel, reader, cloud]) if (win && !win.isDestroyed()) win.webContents.send('host:tts', value);
  if (value.phase === 'completed' && cloudValue?.id === value.messageId && cloudValue.kind === 'reply') showCloud(cloudValue, 40000);
});
let panelPage = 'settings', shortcutError = '', balanceQuery = null, balanceLastAttempt = 0, balanceError = '', cloudValue = null, cloudTimer, lastReplyId = null, speechResultHandledId = null, speechAutoSentId = null;
let petHit = null, shortcutCaptureTimer, switchingMode = false, rebindingShortcut = false;
let questionFocus, questionSpeechTarget, lastQuestionReadKey, cloudMeasurement;
let headAnchor = { x: .5, y: .12 }, cloudGeometry, cloudHover = false, cloudDismissedId, cloudSize = { width: 440, height: 260 };
const voiceKeys = new VoiceShortcut(globalShortcut, activateShortcut);
voiceKeys.on('unavailable', () => { shortcutError = '快捷键监听已停止，请在习惯页重新映射'; showCloud({ id: String(Date.now()), kind: 'status', text: shortcutError }, 8000); });
async function activateShortcut() {
  if(dataService.busy)return;
  if (quitting || suspended || switchingMode || rebindingShortcut) return;
  try {
    if (companion.state().communicationMode === 'text') {
      const cursor = screen.getCursorScreenPoint();
      if (!pet?.isVisible() || !presence.ready || menuOpen || dragStart || !petHit?.hit || Date.now() - petHit.at > 350 || Math.abs(cursor.x - petHit.x) > 3 || Math.abs(cursor.y - petHit.y) > 3) return;
      if (pendingQuestion()) { cloudDismissedId = null; showPendingQuestion(); cloud.show(); cloud.focus(); return; }
      if (chatService.state().busy) { showCloud({ id: String(Date.now()), kind: 'status', text: '她正在回复，等一下再写给她吧。' }, 4000); return; }
      if (cloudValue?.kind !== 'input') showCloud({ id: require('node:crypto').randomUUID(), kind: 'input', text: '', silent: true });
      cloud.show(); cloud.focus(); cloud.webContents.focus(); cloud.webContents.send('host:cloud-focus');
    } else await toggleListening();
  } catch (error) { showCloud({ id: String(Date.now()), kind: 'status', text: error.message }, 8000); }
}
async function toggleCommunication() {
  if (switchingMode) return; switchingMode = true;
  try {
    const next = companion.state().communicationMode === 'text' ? 'voice' : 'text';
    companion.save({ ...companion.state(), communicationMode: next });
    await tts.stop();
    if (speech.state().active) await speech.cancel();
    showCloud(null); updateTray(); if (pendingQuestion()) { cloudDismissedId = null; showPendingQuestion(); }
    for (const win of [panel, debug]) win?.webContents.send('host:interaction-mode', next);
  } catch (error) { showCloud({ id: String(Date.now()), kind: 'status', text: error.message }, 8000); }
  finally { switchingMode = false; }
}
function pendingQuestion() { return agentService.questions.pending.values().next().value?.row; }
function cloudQuestions(state) { return { revision: state.revision, error: state.error, requests: state.requests.filter(r => r.status === 'waiting').slice(0, 1) }; }
function showPendingQuestion() { const row = pendingQuestion(); if (row) showCloud({ id: row.id, kind: 'question', text: row.questions[0].question, notice: row.voiceNotice || '' }); }
function readQuestion(row, q, force = false) {
  if (!voiceAllowed() || !tts.settings.enabled || speech.state().active) return false;
  const key = row.id + ':' + q.id; if (!force && lastQuestionReadKey === key) return true; lastQuestionReadKey = key;
  void tts.speak({ text: questionSpeech(q, row.questions.indexOf(q), row.questions.length), messageId: 'question:' + key, conversationId: row.sessionId, generationId: row.turnId }); return true;
}
async function toggleListening() {
  if (companion.state().communicationMode === 'text') throw Error('当前为打字交流，请右键选择“能说话了”后使用语音');
  await tts.stop();
  if (!speech.state().active) { const row = pendingQuestion(); if (row) { const q = row.questions.find(q => row.id === questionFocus?.id && q.id === questionFocus.questionId) || row.questions[0]; questionSpeechTarget = { id: row.id, sessionId: row.sessionId, turnId: row.turnId, connectionId: row.connectionId, questionId: q.id, revision: row.drafts?.[q.id]?.revision || 0 }; } else questionSpeechTarget = null; }
  speech.toggle(); if (questionSpeechTarget && !questionSpeechTarget.recordingId) questionSpeechTarget.recordingId = speech.recordingId;
}
function positionCloud() {
  if (!cloud || cloud.isDestroyed() || !pet || pet.isDestroyed()) return;
  if (!cloudValue || !pet.isVisible() || suspended) { if (cloud.isVisible()) cloud.hide(); return; }
  const bounds = pet.getContentBounds(), area = screen.getDisplayNearestPoint({ x: bounds.x + bounds.width / 2, y: bounds.y }).workArea;
  cloudSize = fitCloud(cloudValue, area, cloudMeasurement, cloudSize);
  cloudGeometry = { id: cloudValue.id, ...cloudLayout(bounds, area, { head: headAnchor, previousSide: cloudGeometry?.side, size: cloudSize }) };
  const oldBounds = cloud.getContentBounds(); if (['x', 'y', 'width', 'height'].some(k => oldBounds[k] !== cloudGeometry.bounds[k])) cloud.setContentBounds(cloudGeometry.bounds); cloud.webContents.send('host:cloud-geometry', cloudGeometry);
  if (!cloud.isVisible()) cloud.showInactive();
  if (cloud.isAlwaysOnTop() !== alwaysOnTop) cloud.setAlwaysOnTop(alwaysOnTop, 'screen-saver');
}
function showCloud(value, duration = 0) {
  if (value && (value.id === cloudDismissedId || pendingQuestion() && value.kind !== 'question' || cloudValue?.kind === 'input' && !['input','question'].includes(value.kind))) return;
  if (value && value.id !== cloudValue?.id) { cloudMeasurement = null; cloudSize = { width: 440, height: 260 }; }
  clearTimeout(cloudTimer); cloudValue = value;
  if (cloud && !cloud.isDestroyed()) { const interactive = ['input','question','welcome'].includes(value?.kind); if (cloud.isFocusable() !== interactive) cloud.setFocusable(interactive); cloud.setIgnoreMouseEvents(!interactive, { forward: true }); cloud.webContents.send('host:cloud', value); }
  positionCloud();
  if (duration) { const hide = () => { if (cloudHover || cloudValue?.kind === 'input' || chatService.state().busy || agentService.state().pending || tts.state().active) cloudTimer = setTimeout(hide, 1000); else showCloud(null); }; cloudTimer = setTimeout(hide, duration); }
}
async function setVoiceShortcut(value) { rebindingShortcut = true; try { await voiceKeys.set(value); } finally { rebindingShortcut = false; } }
speech.on('capture', value => { if (debug && !debug.isDestroyed()) debug.webContents.send('host:capture', value); });
speech.on('update', value => {
  let questionResult = false;
  if (value.phase === 'ready' && value.recordingId !== speechResultHandledId) {
    speechResultHandledId = value.recordingId;
    if (questionSpeechTarget?.recordingId === value.recordingId) {
      questionResult = true;
      const target = questionSpeechTarget; questionSpeechTarget = null;
      try {
        const result = agentService.questions.receiveSpeech({ ...target, expectedRevision: target.revision, transcript: value.text }, { autoSend: !switchingMode && companion.state().communicationMode === 'voice' && companion.state().voiceAutoSend });
        if (!result.submitted) { const { row } = agentService.questions.owned(target); row.voiceNotice = result.notice; if (result.nextQuestionId) { questionFocus = { id: row.id, questionId: result.nextQuestionId }; readQuestion(row, row.questions.find(q => q.id === result.nextQuestionId)); } cloudDismissedId = null; showPendingQuestion(); }
      }
      catch { const row = pendingQuestion(); if (row) { row.voiceNotice = '这段识别未覆盖已修改或过期的答案，请核对后重新录音。'; showPendingQuestion(); } }
    } else {
    if (!pendingQuestion() && !switchingMode && companion.state().communicationMode === 'voice' && companion.state().voiceAutoSend) { try { chatService.command({ action: 'send', text: value.text }); speechAutoSentId = value.recordingId; } catch {} }
    if (speechAutoSentId !== value.recordingId) setDraft([readerDraft.trim(), value.text].filter(Boolean).join('\n').slice(0, 4000));
    }
  }
  if (debug && !debug.isDestroyed()) debug.webContents.send('host:speech', { ...value, autoSent: speechAutoSentId === value.recordingId });
  if (pet && !pet.isDestroyed()) pet.webContents.send('host:speech', { revision: value.revision, phase: value.phase, active: value.active });
  if (questionResult) { if (pendingQuestion()) showPendingQuestion(); else if (cloudValue?.kind === 'question') showCloud(null); return; }
  if (pendingQuestion()) { if (value.error) { pendingQuestion().voiceNotice = value.error; showPendingQuestion(); } return; }
  if (switchingMode || companion.state().communicationMode === 'text') return;
  const labels = { starting: '正在打开麦克风…', listening: '我在听。说完后再按 ' + companion.state().voiceShortcut, stopping: '正在结束录音…', transcribing: '正在把声音记成文字…', cancelling: '正在关闭倾听…' };
  if (labels[value.phase]) showCloud({ id: value.recordingId + value.phase, kind: 'status', text: labels[value.phase] });
  else if (value.phase === 'ready') {
    if (speechAutoSentId !== value.recordingId) showCloud({ id: value.recordingId + 'transcript', kind: 'input', text: '', silent: true });
  } else if (value.error) showCloud({ id: String(Date.now()), kind: 'status', text: value.error }, 10000); else showCloud(null);
});
chatService.on('update', update => {
  if (update.phase === 'connecting' && update.generationId !== lastTtsGeneration) { lastTtsGeneration = update.generationId; void tts.stop(); }
  if (['stopping', 'cancelled', 'error', 'idle'].includes(update.phase)) void tts.stop();
  for (const win of [panel, debug, reader]) if (win && !win.isDestroyed()) win.webContents.send('host:chat', win === panel ? { revision: update.revision, busy: update.busy } : update);
  if (pet && !pet.isDestroyed()) pet.webContents.send('host:chat', { revision: update.revision, phase: update.phase, busy: update.busy });
  const last = update.messages.at(-1);
  if (update.phase === 'completed' && last?.role === 'assistant' && last.generationId === update.generationId && last.id !== lastAutoSpoken) {
    lastAutoSpoken = last.id;
    if (voiceAllowed() && tts.settings.enabled && canSpeakReply(last)) void tts.speak({ text: last.spokenText, messageId: last.id, conversationId: update.conversationId, generationId: update.generationId });
  }
  if (update.phase === 'error') showCloud({ id: String(update.revision), kind: 'status', text: update.error }, 15000);
  else if (update.phase === 'cancelled') { if (update.error.startsWith('节食提醒：')) showCloud({ id: String(update.revision), kind: 'status', text: update.error }, 15000); else showCloud(null); }
  else if (last?.role === 'assistant' && last.generationId === update.generationId && (last.text || last.spokenText || last.status === 'streaming')) { lastReplyId = last.id; showCloud({ id: last.id, ...cloudReply(last), silent: true }, update.busy ? 0 : 40000); }
  else if (update.phase === 'connecting') showCloud({ id: String(update.revision), kind: 'status', text: '让我想一想…' });

});
function presenceInfo() { return { ...presence, characterName: CHARACTER_NAME, paused, scale, alwaysOnTop, topmostApplied: !!pet && !pet.isDestroyed() && pet.isAlwaysOnTop(), visible: !!pet && !pet.isDestroyed() && pet.isVisible() && !suspended }; }
function publishPresence() { if (debug && !debug.isDestroyed()) debug.webContents.send('host:presence', presenceInfo()); }
function writeHostInfo() { fs.writeFileSync(path.join(RUNTIME, 'host-info.json'), JSON.stringify({ ready: true, origin, pid: process.pid, renderer: 'native-presence-v1', host_revision: require('./lib/product.cjs').version, model_ready: presence.ready })); }
function lifecycle() {
  if (!voiceAllowed()) void tts.stop();
  if (pet && !pet.isDestroyed()) pet.webContents.send('host:lifecycle', { paused, visible: pet.isVisible() && !suspended });
  publishPresence();
  positionCloud();
}
function saveSettings() {
  if (pet && !pet.isDestroyed()) fs.writeFileSync(settingsPath, JSON.stringify({ scale, alwaysOnTop, position: { x: pet.getContentBounds().x, y: pet.getContentBounds().y } }, null, 2));
}
function applyStacking(raise = false) {
  if (!pet || pet.isDestroyed() || quitting) return;
  pet.setAlwaysOnTop(alwaysOnTop, 'screen-saver');
  if (cloud && !cloud.isDestroyed() && cloud.isVisible() && cloud.isAlwaysOnTop() !== alwaysOnTop) cloud.setAlwaysOnTop(alwaysOnTop, 'screen-saver');
  if (raise && alwaysOnTop && pet.isVisible()) pet.moveTop();
  if (stackPending) return;
  stackPending = true;
  setImmediate(() => {
    stackPending = false;
    if (pet && !pet.isDestroyed() && !quitting) {
      if (pet.isAlwaysOnTop() !== alwaysOnTop) pet.setAlwaysOnTop(alwaysOnTop, 'screen-saver');
      if (raise && alwaysOnTop && pet.isVisible()) pet.moveTop();
    }
  });
}
function setTopmost(value) { alwaysOnTop = !!value; applyStacking(true); saveSettings(); updateTray(); publishPresence(); }
function setPetBounds(bounds, clamp = true) {
  // setPosition() can round-trip a Windows invisible frame and grow one DIP per move.
  // Always write canonical CONTENT dimensions from scale, never measured outer dimensions.
  const next = { x: Math.round(bounds.x), y: Math.round(bounds.y), ...sizeFor(scale) };
  pet.setContentBounds(clamp ? clampPosition(next) : next); applyStacking(); positionCloud();
}
function setPetMouseIgnored(value) {
  if (!pet || pet.isDestroyed() || petMouseIgnored === value) return;
  petMouseIgnored = value; pet.setIgnoreMouseEvents(value, { forward: true });
  applyStacking();
}
function finishDrag() {
  dragStart = null;
  if (pet && !pet.isDestroyed()) { setPetBounds(pet.getContentBounds()); if (!menuOpen) setPetMouseIgnored(true); }
}
function showPet() {
  pet.showInactive(); applyStacking(true); lifecycle();
}
function openInfo(page) { if (typeof page === 'string' && ['settings', 'memory', 'voice', 'food'].includes(page)) { panelPage = page; panel.webContents.send('host:panel-page', page); } panel.show(); panel.focus(); }
function openDebug() { debug.show(); debug.focus(); }
function saveReaderBounds() { if (reader && !reader.isDestroyed()) fs.writeFileSync(path.join(RUNTIME, 'reader-bounds.json'), JSON.stringify(reader.getNormalBounds())); }
function openReader() { const current = reader.getNormalBounds(), area = screen.getDisplayMatching(current).workArea; reader.setBounds(clampBounds({ ...current, width: Math.min(current.width, area.width), height: Math.min(current.height, area.height) }, area)); reader.show(); reader.focus(); }
function setDraft(text) { readerDraft = text; fs.writeFileSync(path.join(RUNTIME, 'conversation-draft.json'), JSON.stringify({ text }), { mode: 0o600 }); for (const win of [reader, cloud]) if (win && !win.isDestroyed()) win.webContents.send('host:draft', text); }
function menuItems() { return presenceMenu({ alwaysOnTop, textMode: companion.state().communicationMode === 'text', toggleCommunication, openInfo: () => openInfo('settings'), openFood: () => openInfo('food'), openReader, setTopmost, quit: () => app.quit() }); }
function updateTray() { if (tray) tray.setContextMenu(Menu.buildFromTemplate([...menuItems(), { type: 'separator' }, { label: '显示/隐藏角色', click: () => pet.isVisible() ? pet.hide() : showPet() }])); }
function openCharacterMenu() {
  if (menuOpen || !pet.isVisible()) return false;
  finishDrag(); menuOpen = true; setPetMouseIgnored(false); applyStacking(true);
  Menu.buildFromTemplate(menuItems()).popup({ window: pet, callback: () => { menuOpen = false; if (pet && !pet.isDestroyed() && !quitting) { setPetMouseIgnored(true); applyStacking(); } } });
  return true;
}
function allowed(event, which) {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || which && win !== which || !event.senderFrame || event.senderFrame !== event.sender.mainFrame || !event.senderFrame.url.startsWith(origin + '/')) throw Error('无效宿主来源');
  return win;
}
function clampPosition(bounds) {
  const area = screen.getDisplayNearestPoint({ x: bounds.x + Math.round(bounds.width / 2), y: bounds.y + Math.round(bounds.height / 2) }).workArea;
  return clampBounds(bounds, area);
}
function placeScale(factor) {
  finishDrag(); const old = { ...pet.getContentBounds(), ...sizeFor(scale) }, next = scaledBounds(old, factor, anchor);
  scale = factor; setPetBounds(next); saveSettings(); publishPresence();
}
function protect(win) {
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => { if (!url.startsWith(origin + '/')) event.preventDefault(); });
}
async function createWindows(info) {
  origin = info.origin;
  taskLink = new TaskLink(info);
  taskLink.on('update', update => { for (const win of [pet, debug]) if (win && !win.isDestroyed()) win.webContents.send('host:task', update); });
  const preferences = { preload: path.join(ROOT, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' };
  panel = new BrowserWindow({ width: 620, height: 850, minWidth: 480, minHeight: 580, show: false, icon: iconPath, backgroundColor: '#f4f6fa', title: '她的小本本', autoHideMenuBar: true, webPreferences: { ...preferences, backgroundThrottling: true } });
  protect(panel);
  debug = new BrowserWindow({ width: 680, height: 850, minWidth: 480, minHeight: 580, show: false, icon: iconPath, backgroundColor: '#f4f6fa', title: '她的调试页', autoHideMenuBar: true, webPreferences: preferences });
  protect(debug);
  const area = screen.getPrimaryDisplay().workArea, size = sizeFor(scale);
  const firstPet = { x: settings.position?.x ?? area.x + area.width - size.width - 12, y: settings.position?.y ?? area.y + area.height - size.height - 12, ...size }, firstArea = screen.getDisplayMatching(firstPet).workArea;
  const readingSize = { width: Math.min(760, firstArea.width), height: Math.min(800, firstArea.height) };
  let reading = clampBounds({ ...readingSize, x: firstPet.x - readingSize.width - 16 >= firstArea.x ? firstPet.x - readingSize.width - 16 : firstPet.x + firstPet.width + 16, y: firstPet.y - 80 }, firstArea);
  try { const saved = JSON.parse(fs.readFileSync(path.join(RUNTIME, 'reader-bounds.json'), 'utf8')); if (['x', 'y', 'width', 'height'].every(k => Number.isFinite(saved[k]))) { const target = screen.getDisplayMatching(saved).workArea; reading = clampBounds({ x: saved.x, y: saved.y, width: Math.min(target.width, Math.max(500, saved.width)), height: Math.min(target.height, Math.max(460, saved.height)) }, target); } } catch {}
  reader = new BrowserWindow({ ...reading, minWidth: 500, minHeight: 460, show: false, icon: iconPath, backgroundColor: '#f4f8fc', title: '和她聊聊', autoHideMenuBar: true, webPreferences: preferences }); protect(reader);
  for (const event of ['move', 'resize']) reader.on(event, () => { clearTimeout(readerBoundsTimer); readerBoundsTimer = setTimeout(saveReaderBounds, 250); });
  pet = new BrowserWindow({ ...size, x: settings.position?.x ?? area.x + area.width - size.width - 12, y: settings.position?.y ?? area.y + area.height - size.height - 12, icon: iconPath, transparent: true, frame: false, thickFrame: false, resizable: false, alwaysOnTop, skipTaskbar: true, hasShadow: false, show: false, backgroundColor: '#00000000', webPreferences: preferences });
  protect(pet);
  cloud = new BrowserWindow({ width: 400, height: 240, transparent: true, frame: false, thickFrame: false, resizable: false, alwaysOnTop, skipTaskbar: true, hasShadow: false, show: false, focusable: false, backgroundColor: '#00000000', webPreferences: preferences });
  protect(cloud); cloud.setIgnoreMouseEvents(true, { forward: true });
  const mediaAllowed = contents => contents === debug.webContents && companion.state().communicationMode === 'voice' && ['starting', 'listening', 'stopping'].includes(speech.phase) && contents.getURL() === origin + '/debug.html';
  panel.webContents.session.setPermissionRequestHandler((contents, permission, callback, details) => { callback(permission === 'media' && mediaAllowed(contents) && !details.videoRequested && details.mediaTypes?.every(type => type === 'audio') !== false); });
  panel.webContents.session.setPermissionCheckHandler((contents, permission, requestingOrigin, details) => permission === 'media' && mediaAllowed(contents) && requestingOrigin === origin && details.mediaType !== 'video');
  setPetMouseIgnored(true);
  screen.on('display-metrics-changed', () => { if (pet && !pet.isDestroyed()) setPetBounds(pet.getContentBounds()); });
  screen.on('display-removed', () => { if (pet && !pet.isDestroyed()) setPetBounds(pet.getContentBounds()); });
  ipcMain.handle('host:show-pet', event => { allowed(event, debug); showPet(); return true; });
  ipcMain.handle('host:open-debug', event => { allowed(event, panel); openDebug(); return true; });
  ipcMain.handle('host:show-panel', event => { allowed(event, pet); openInfo(); return true; });
  ipcMain.handle('host:context-menu', event => { allowed(event, pet); return openCharacterMenu(); });
  ipcMain.on('host:interact', event => { try { allowed(event, pet); applyStacking(true); } catch {} });
  ipcMain.handle('host:scale', (event, factor) => { allowed(event, debug); if (!Number.isFinite(factor) || factor < .65 || factor > 1.3) return false; placeScale(factor); return true; });
  ipcMain.handle('host:mode', (event, mode) => { allowed(event, debug); if (!['legacy-sequence', 'static-v0.10'].includes(mode)) return false; pet.webContents.send('host:mode', mode); return true; });
  ipcMain.on('host:hit', (event, hit, point) => { try {
    allowed(event, pet); const bounds = pet.getContentBounds();
    // Bind the alpha result to the tested point, rather than a later OS cursor sample.
    petHit = hit === true && Number.isFinite(point?.x) && Number.isFinite(point?.y) && point.x >= 0 && point.x < bounds.width && point.y >= 0 && point.y < bounds.height ? { hit: true, at: Date.now(), x: bounds.x + point.x, y: bounds.y + point.y } : null;
    if (!dragStart && !menuOpen) setPetMouseIgnored(!hit);
  } catch { /* Ignore stale renderer. */ } });
  ipcMain.on('host:drag-start', event => { try { allowed(event, pet); if (dragStart || menuOpen) return; dragStart = { bounds: pet.getContentBounds(), cursor: screen.getCursorScreenPoint() }; setPetMouseIgnored(false); applyStacking(true); } catch {} });
  ipcMain.on('host:drag', event => { try { allowed(event, pet); if (!dragStart) return; const cursor = screen.getCursorScreenPoint(); setPetBounds({ x: dragStart.bounds.x + cursor.x - dragStart.cursor.x, y: dragStart.bounds.y + cursor.y - dragStart.cursor.y }, false); } catch {} });
  ipcMain.on('host:drag-end', event => { try { allowed(event, pet); finishDrag(); saveSettings(); } catch {} });
  ipcMain.handle('host:presence-query', event => { allowed(event); return presenceInfo(); });
  ipcMain.handle('host:task-query', event => { allowed(event); return taskLink.state(true); });
  ipcMain.handle('host:task-command', async (event, action) => { allowed(event, debug); try { await taskLink.command(action); return { ok: true }; } catch (error) { return { ok: false, error: error.message }; } });
  ipcMain.handle('host:chat-query', event => { const win = allowed(event); if (![debug, reader].includes(win)) throw Error('无效宿主来源'); return chatService.state(); });
  ipcMain.handle('host:chat-presence', event => { allowed(event, pet); const { revision, phase, busy } = chatService.state(); return { revision, phase, busy }; });
  guardedHandle('host:chat-command', (event, input) => { const win = allowed(event); if (![debug, reader].includes(win)) throw Error('无效宿主来源'); try { chatService.command(input); if (input.action === 'new') { lastReplyId = null; showCloud(null); } return { ok: true }; } catch (error) { return { ok: false, error: error.message }; } });
  ipcMain.handle('host:reader-open', event => { const win = allowed(event); if (![panel, cloud, pet, reader].includes(win)) throw Error('无效宿主来源'); openReader(); return true; });
  ipcMain.handle('host:tts-query', event => { allowed(event); return tts.state(); });
  ipcMain.handle('host:tts-voices', async event => { allowed(event, panel); try { return { ok: true, voices: [...(await tts.voices()).map(v => ({ ...v, engine: 'system', label: 'Windows · ' + v.name })), { name: 'cosyvoice3:official-demo', engine: 'cosyvoice3', label: 'CosyVoice3 · 官方示例（试听）' }, ...voiceProfiles.list().map(v => ({ name: 'cosyvoice3:' + v.id, engine: 'cosyvoice3', label: 'CosyVoice3 · ' + v.name + (v.bundled ? '（内置）' : '') }))] }; } catch (error) { return { ok: false, error: error.message }; } });
  guardedHandle('host:tts-save', async (event, value) => { allowed(event, panel); try { return { ok: true, value: await saveVoice(value) }; } catch (error) { return { ok: false, error: error.message }; } });
  ipcMain.handle('host:voice-module-query', event => { allowed(event, panel); return naturalVoice.state(); });
  guardedHandle('host:voice-module-select', async (event, value) => { allowed(event, panel); try { if (!['system', 'cosyvoice3'].includes(value)) throw Error('声音模块无效'); if (value === 'cosyvoice3' && !naturalVoice.resources()) throw Error('CosyVoice3可选包尚未就绪'); await saveVoice({ ...tts.settings, voice: value === 'cosyvoice3' ? 'cosyvoice3:official-demo' : 'Microsoft Huihui Desktop' }); return { ok: true, value: naturalVoice.state() }; } catch (error) { return { ok: false, error: error.message }; } });
  guardedHandle('host:voice-reference', async event => {
    allowed(event, panel); try {
      if (!tts.settings.enabled) throw Error('请先开启语音');
      const result = await dialog.showOpenDialog(panel, { title: '选择3–30秒的参考声音', properties: ['openFile'], filters: [{ name: '参考录音', extensions: ['wav', 'flac', 'mp3'] }] });
      if (result.canceled) return { ok: true, reference: null };
      const source = fs.realpathSync(result.filePaths[0]), stat = fs.statSync(source); if (!stat.isFile() || stat.size > 20000000) throw Error('请选择20MB以内的WAV、FLAC或MP3录音');
      voiceReference = { token: require('node:crypto').randomUUID(), source }; return { ok: true, reference: { token: voiceReference.token, name: path.basename(source) } };
    } catch (error) { return { ok: false, error: error.message }; }
  });
  guardedHandle('host:voice-create', async (event, input) => {
    allowed(event, panel); let owned = false; try {
      if (creatingVoice) throw Error('正在生成音色，请稍候');
      if (!tts.settings.enabled || naturalVoice.selection !== 'cosyvoice3') throw Error('请先开启语音并选择CosyVoice3音色');
      if (!voiceReference || input?.token !== voiceReference.token) throw Error('请重新选择参考录音');
      creatingVoice = true; owned = true; const id = voiceProfiles.prepare(voiceReference.source, input); voiceReference = null;
      await tts.stop(); await naturalVoice.createProfile(id); const profile = voiceProfiles.find(id);
      return { ok: true, profile: { id, name: profile.name, seconds: profile.seconds } };
    } catch (error) { return { ok: false, error: error.message }; } finally { if (owned) creatingVoice = false; }
  });
  guardedHandle('host:tts-command', async (event, input) => {
    const win = allowed(event); if (![panel, cloud, reader].includes(win)) throw Error('无效宿主来源');
    try {
      if (input?.action === 'stop') { await tts.stop(); naturalVoice.rewarm(); return { ok: true }; }
      if (!tts.settings.enabled) throw Error('请先在小本本中开启语音');
      if (!voiceAllowed()) throw Error('当前不能播放语音；请切回语音模式并显示角色');
      if (input?.action === 'preview' && win === panel) { void tts.speak({ text: '你好呀，我会先把重点说给你听，完整内容可以慢慢看。', messageId: 'voice-preview', preview: true }); return { ok: true }; }
      if (input?.action === 'read' && win === reader) { const message = chatService.messages.find(m => m.id === input.messageId); if (!canSpeakReply(message)) throw Error(message?.voiceUnavailable || '本条没有可用的完整口语稿，请选择文字按需追问'); void tts.speak({ text: message.spokenText, messageId: message.id, conversationId: chatService.sessionId, generationId: message.generationId, preview: true }); return { ok: true }; }
      throw Error('声音操作无效');
    } catch (error) { return { ok: false, error: error.message }; }
  });
  ipcMain.handle('host:tts-player', (event, value) => { allowed(event, pet); return tts.player(value); });
  ipcMain.handle('host:draft-query', event => { const win = allowed(event); if (![reader, cloud].includes(win)) throw Error('无效宿主来源'); return readerDraft; });
  guardedHandle('host:draft-save', (event, text) => { const win = allowed(event); if (![reader, cloud].includes(win) || typeof text !== 'string' || text.length > 4000) throw Error('草稿无效'); setDraft(text); return true; });
  ipcMain.handle('host:copy-text', (event, text) => { allowed(event, reader); if (typeof text !== 'string' || text.length > 131072) throw Error('复制内容过长'); clipboard.writeText(text); return true; });
  ipcMain.handle('host:open-link', async (event, text) => { allowed(event, reader); if (typeof text !== 'string' || text.length > 4096) throw Error('链接无效'); const url = new URL(text); if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw Error('仅支持网页链接'); await shell.openExternal(url.href); return true; });
  ipcMain.handle('host:growth-query', event => { const win=allowed(event); if (![panel,reader,cloud].includes(win)) throw Error('无效宿主来源'); return growth.state({full:win===panel,drawerId:chatService.drawerId}); });
  guardedHandle('host:growth-command', async (event,input) => { const win=allowed(event); if (![panel,cloud].includes(win)) throw Error('无效宿主来源'); try { if (input?.action==='invite' && win===panel) { const invitation=growth.welcome(true); if(invitation) showCloud(invitation); else { setDraft('我想和你一起调整说话与相处方式。'); openReader(); } return {ok:true}; } if(input?.action==='undo-persona' && win===panel && input.confirmed===true) { if(chatService.state().busy) throw Error('先结束当前对话再撤销设定'); const value=growth.undoPersona(input.id,input.expectedRevision); chatService.command({action:'new'}); return {ok:true,value}; } if(input?.action==='choose') { const choice=growth.chooseWelcome(input.id,input.choice); showCloud(null); if(choice==='manual') { openInfo('settings'); panel.webContents.send('host:growth-focus'); } if(choice==='talk') { const value={id:'welcome-talk:'+Date.now(),kind:'status',text:'你喜欢我怎样和你聊天？可以先随便说一点。'}; showCloud(value,60000); if(voiceAllowed()&&tts.settings.enabled) void tts.speak({text:value.text,messageId:value.id,preview:true}); } return {ok:true}; } throw Error('成长操作无效'); } catch(error) { return {ok:false,error:error.message}; } });
  ipcMain.handle('host:data-query',event=>{allowed(event,panel);return {phase:dataService.phase,lastResult:dataStartupResult||null,recoveries:dataService.recoveries()};});
  ipcMain.handle('host:data-command',async(event,input)=>{allowed(event,panel);try{if(input?.action==='cancel'){dataService.cancel(input.token);return {ok:true};}if(input?.action==='commit'){const value=await dataService.commit(input.token,input.confirmation);setTimeout(()=>{app.relaunch();app.quit();},400);return {ok:true,value};}if(input?.action==='open-recovery'){const folder=path.join(RUNTIME,'data-backups');fs.mkdirSync(folder,{recursive:true});require('./lib/data-service.cjs').noLinks(RUNTIME,folder);const error=await shell.openPath(folder);if(error)throw Error(error);return {ok:true};}dataIdle();if(input?.action==='recovery')return {ok:true,value:await dataService.prepareRecovery(input.id)};if(input?.action==='export'){const chosen=await dialog.showSaveDialog(panel,{title:'把小本本收好',defaultPath:'她的小本本-'+new Date().toLocaleDateString('sv-SE')+'.cpbackup',filters:[{name:'完整资料备份',extensions:['cpbackup']}]});if(chosen.canceled)return {ok:true,canceled:true};dataIdle();return {ok:true,value:await dataService.export(chosen.filePath)};}if(input?.action==='import'){const chosen=await dialog.showOpenDialog(panel,{title:'翻开以前的小本本',properties:['openFile'],filters:[{name:'完整资料备份',extensions:['cpbackup']}]});if(chosen.canceled)return {ok:true,canceled:true};dataIdle();return {ok:true,value:await dataService.prepareImport(chosen.filePaths[0])};}if(input?.action==='reset')return {ok:true,value:dataService.prepareReset()};throw Error('资料操作无效');}catch(error){return {ok:false,error:error.message};}});
  ipcMain.handle('host:settings-query', event => { allowed(event, panel); return { ...companion.state(), agentWorkspace: runtimeContext().agentWorkspace, personaRevision:growth.value.persona.revision, shortcutError }; });
  ipcMain.handle('host:drawer-query', event => { const win = allowed(event); if (![reader, panel].includes(win)) throw Error('无效宿主来源'); const state = memoryService.state(); return { error: state.error, drawers: state.drawers.map(({ id, name, type }) => ({ id, name, type })) }; });
  guardedHandle('host:drawer-create', (event, input) => { allowed(event, reader); try { if (chatService.state().busy) throw Error('先结束当前回复再切换事务'); return { ok: true, value: memoryService.saveDrawer({ name: input?.name }, { actor: 'user', ref: 'reader:' + require('node:crypto').randomUUID(), at: Date.now() }) }; } catch (error) { return { ok: false, error: error.message }; } });
  ipcMain.handle('host:memory-query', event => { allowed(event, panel); return memoryService.state(); });
  guardedHandle('host:memory-command', async (event, input) => { allowed(event, panel); try { const source = { actor: 'user', ref: 'notebook:' + require('node:crypto').randomUUID(), at: Date.now() }; let value;
    if (input?.action === 'search') value = memoryService.search({ ...input, includeCandidates: true });
    else if (input?.action === 'save') value = memoryService.saveEntry(input, source);
    else if (input?.action === 'drawer-save') value = memoryService.saveDrawer(input, source);
    else if (input?.action === 'history') value = memoryService.history(input.id);
    else if (input?.action === 'undo' && input.confirmed === true) { await chatService.stop('记忆正在撤销整理，停止旧上下文以便重建'); value = memoryService.undoOperation(input.operationId, source); }
    else if (input?.action === 'forget' && input.confirmed === true) { await chatService.stop('记忆正在遗忘，停止旧上下文以便重建'); value = memoryService.forget(input.id, input.expectedRevision, source); }
    else if (input?.action === 'export') { const result = await dialog.showSaveDialog(panel, { title: '导出记忆副本', defaultPath: '她的记忆.md', filters: [{ name: 'Markdown', extensions: ['md'] }] }); if (!result.canceled) { if (path.resolve(result.filePath).toLowerCase() === memoryService.file.toLowerCase()) throw Error('不能覆盖记忆权威库'); fs.writeFileSync(result.filePath, memoryService.exportMarkdown(), { mode: 0o600 }); } value = { exported: !result.canceled }; }
    else throw Error('记忆操作无效'); return { ok: true, value }; } catch (error) { return { ok: false, error: error.message }; } });
  ipcMain.handle('host:questions-query', event => { const win = allowed(event); if (![reader, cloud, panel, debug].includes(win)) throw Error('无效宿主来源'); const state = agentService.questions.state(); return win === cloud ? cloudQuestions(state) : state; });
  ipcMain.handle('host:question-draft', (event, input) => { const win = allowed(event); if (![reader, cloud].includes(win)) throw Error('无效宿主来源'); try { return { ok: true, value: agentService.questions.draft(input, win === cloud ? 'cloud' : 'reader') }; } catch (error) { return { ok: false, error: error.message }; } });
  ipcMain.handle('host:question-action', async (event, input) => { const win = allowed(event); if (![reader, cloud].includes(win)) throw Error('无效宿主来源'); try { const { row } = agentService.questions.owned(input); const q = row.questions.find(q => q.id === input.questionId) || row.questions[0]; if (input.action === 'rendered') { if (win === cloud) { questionPainted.add(row.id); if (row.voiceNotice?.startsWith('白云问题卡片暂未显示') || row.voiceNotice?.startsWith('问题卡片显示失败')) { row.voiceNotice = ''; showPendingQuestion(); } if (cloud.isVisible() && (!questionFocus || questionFocus.id !== row.id)) { questionFocus = { id: row.id, questionId: q.id }; readQuestion(row, q); } } } else if (input.action === 'render-failed') { row.voiceNotice = '问题卡片显示失败，可打开聊聊回答；没有默认选择。'; showPendingQuestion(); } else if (input.action === 'show') { cloudDismissedId = null; showPendingQuestion(); } else if (input.action === 'focus') { if (questionFocus?.id !== row.id || questionFocus.questionId !== q.id) { questionFocus = { id: row.id, questionId: q.id }; readQuestion(row, q); } } else if (input.action === 'read') { if (!readQuestion(row, q, true)) throw Error('当前无法读题；请开启语音、切回能说话了，并结束录音后重试。'); } else if (input.action === 'listen') { questionFocus = { id: row.id, questionId: q.id }; await toggleListening(); } else throw Error('问题操作无效'); return { ok: true }; } catch (error) { return { ok: false, error: error.message }; } });
  ipcMain.handle('host:question-answer', async (event, input) => { const win = allowed(event); if (![reader, cloud].includes(win)) throw Error('无效宿主来源'); try { if (String(tts.state().messageId || '').startsWith('question:' + input.id + ':')) await tts.stop(); const ok = agentService.questions.answer(input, { fromDraft: true, surface: win === cloud ? 'cloud' : 'reader' }); if (input.action === 'cancel') await chatService.stop('已取消追问，本轮停止；没有提供答案或授权。'); return { ok }; } catch (error) { return { ok: false, error: error.message }; } });
  ipcMain.handle('host:agent-query', event => { const win = allowed(event); const state = agentService.state(); return [panel, debug].includes(win) ? { ...state, mode: runtimeContext().agentMode, workspace: runtimeContext().agentWorkspace } : { revision: state.revision, active: state.active, pending: state.pending }; });
  guardedHandle('host:agent-command', async (event, input) => {
    const win = allowed(event); if (![panel, debug].includes(win)) throw Error('无效宿主来源');
    try {
      if (input?.action === 'stop') { await chatService.stop(); return { ok: true }; }
      if (win !== panel) throw Error('请在小本本处理权限与升级');
      if (input?.action === 'answer') return { ok: agentService.answer(input.id, input) };
      if (input?.action === 'workspace') { const result = await dialog.showOpenDialog(panel, { title: '选择她的工作目录', properties: ['openDirectory'] }); return { ok: true, path: result.canceled ? null : fs.realpathSync(result.filePaths[0]) }; }
      if (input?.action === 'upgrade') { if (chatService.state().busy) throw Error('请先结束当前任务'); return { ok: true, value: await agentService.prepareUpgrade({ workspace: runtimeContext().agentWorkspace }) }; }
      throw Error('不支持的办事操作');
    } catch (error) { return { ok: false, error: error.message }; }
  });
  ipcMain.handle('host:panel-page-query', event => { allowed(event, panel); return panelPage; });
  guardedHandle('host:settings-command', async (event, input) => {
    const win = allowed(event); if (win !== panel && win !== debug) throw Error('无效宿主来源');
    try {
      if (input?.action === 'prepare-speech' && win === debug) { await require('./tools/prepare-speech.cjs').prepare(); speech.publish(); return { ok: true }; }
      if (win !== panel) throw Error('请在习惯页保存设置');
      if (input?.action !== 'save') throw Error('不支持的设置操作');
      if (chatService.state().busy || speech.state().active) throw Error('请先结束当前回复或录音再保存设置');
      if(input.expectedPersonaRevision!==undefined && input.expectedPersonaRevision!==growth.value.persona.revision) throw Error('她的设定刚刚有变化，请先查看最新设定，草稿仍保留');
      const old = companion.state(), oldContextRevision = runtimeContext().contextRevision, next = validateCompanion({ ...input.value, communicationMode: old.communicationMode });
      if (next.agentWorkspace) { if (!fs.statSync(next.agentWorkspace).isDirectory()) throw Error('工作目录不存在'); next.agentWorkspace = fs.realpathSync(next.agentWorkspace); }
      await setVoiceShortcut(next.voiceShortcut);
      try { companion.save(next); } catch (error) { await setVoiceShortcut(old.voiceShortcut); throw error; }
      growth.syncPersona({actor:'user',ref:'notebook:'+require('node:crypto').randomUUID()});
      if(old.persona.trim()&&!next.persona.trim()) setTimeout(()=>{try{if(!cloudValue&&!chatService.state().busy){const welcome=growth.welcome();if(welcome)showCloud(welcome);}}catch{}},500);
      shortcutError = '';
      debug.webContents.send('host:shortcut', next.voiceShortcut);
      for (const win of [panel, debug]) win.webContents.send('host:agent', { ...agentService.state(), mode: runtimeContext().agentMode, workspace: runtimeContext().agentWorkspace });
      if (oldContextRevision !== runtimeContext().contextRevision) { chatService.command({ action: 'new' }); lastReplyId = null; showCloud(null); }
      let memoryWarning = ''; try { memoryService.importLegacy(next.memory); } catch { memoryWarning = '旧参考原文已保留，但记忆副本导入失败，请检查记忆页后重试。'; }
      return { ok: true, value: { ...companion.state(), agentWorkspace: runtimeContext().agentWorkspace, personaRevision:growth.value.persona.revision, memoryWarning } };
    } catch (error) { return { ok: false, error: error.message }; }
  });
  function endShortcutCapture() { clearTimeout(shortcutCaptureTimer); if (!quitting && !voiceKeys.pause(false)) shortcutError = '快捷键恢复失败，请重新映射'; }
  guardedHandle('host:shortcut-capture', (event, value) => { allowed(event, panel); clearTimeout(shortcutCaptureTimer); if (value === true) { voiceKeys.pause(true); shortcutCaptureTimer = setTimeout(endShortcutCapture, 20000); } else endShortcutCapture(); return true; });
  panel.on('blur', endShortcutCapture);
  ipcMain.handle('host:interaction-query', event => { const win = allowed(event); if (![panel, debug].includes(win)) throw Error('无效宿主来源'); return { mode: companion.state().communicationMode, shortcut: voiceKeys.value, shortcutReady: voiceKeys.value === 'Ctrl' ? voiceKeys.ready : !!voiceKeys.value && globalShortcut.isRegistered(voiceKeys.value) }; });
  ipcMain.handle('host:settings-import', async (event, kind) => {
    allowed(event, panel);
    try {
      if (!['persona', 'memory'].includes(kind)) throw Error('导入类型无效');
      const selected = await dialog.showOpenDialog(panel, { title: kind === 'persona' ? '载入角色设定' : '载入记忆', properties: ['openFile'], filters: [{ name: '文字设定', extensions: ['txt', 'md', 'json'] }] });
      if (selected.canceled) return { ok: true, cancelled: true };
      const file = selected.filePaths[0], ext = path.extname(file).toLowerCase(), stat = await fs.promises.stat(file);
      if (!['.txt', '.md', '.json'].includes(ext) || !stat.isFile() || stat.size > 200000) throw Error('请选择 200 KB 内的 TXT、Markdown 或 JSON 文件');
      return { ok: true, text: importText(await fs.promises.readFile(file, 'utf8'), kind, ext), name: path.basename(file) };
    } catch (error) { return { ok: false, error: error.message }; }
  });
  ipcMain.handle('host:food-query', event => { allowed(event, panel); const state = chatService.state(); return { ...chatService.ledger.state({ monthlyLimit: state.limits.monthlyReportedTokens, monthlyUsed: state.meter.totalTokens }), balanceError, querying: !!balanceQuery, budget: budgetGuard.state() }; });
  guardedHandle('host:budget-save', async (event, value) => {
    allowed(event, panel);
    try {
      budgetGuard.save(value);
      if (value.enabled) { try { await budgetGuard.check(); } catch (error) { if (chatService.state().busy) void chatService.stop(error.message); } }
      return { ok: true, value: budgetGuard.state() };
    } catch (error) { return { ok: false, error: error.message }; }
  });
  guardedHandle('host:balance-refresh', async event => {
    allowed(event, panel);
    if (balanceQuery) return balanceQuery;
    if (Date.now() - balanceLastAttempt < 15000) return { ok: false, error: '请稍候再刷新余额（间隔 15 秒）' };
    balanceLastAttempt = Date.now(); balanceError = '';
    balanceQuery = budgetGuard.refresh().then(() => { return { ok: true }; }).catch(error => { balanceError = error.message; return { ok: false, error: error.message }; }).finally(() => { balanceQuery = null; });
    return balanceQuery;
  });
  ipcMain.handle('host:speech-query', event => { const win = allowed(event); const value = speech.state(); return win === debug ? { ...value, autoSent: speechAutoSentId === value.recordingId, shortcut: companion.state().voiceShortcut, shortcutError } : { revision: value.revision, phase: value.phase, active: value.active }; });
  guardedHandle('host:speech-command', async (event, action) => { allowed(event, debug); try { if (action === 'toggle') { if (companion.state().communicationMode === 'text') throw Error('当前为打字交流，请右键选择“能说话了”'); await toggleListening(); } else if (action === 'cancel') await speech.cancel(); else throw Error('不支持的语音操作'); return { ok: true }; } catch (error) { return { ok: false, error: error.message }; } });
  ipcMain.handle('host:speech-capture', async (event, value) => { allowed(event, debug); return speech.capture(value); });
  ipcMain.handle('host:cloud-query', event => { allowed(event, cloud); return cloudValue ? { ...cloudValue, layout: cloudGeometry } : null; });
  ipcMain.handle('host:cloud-command', async (event, action) => { allowed(event, cloud); if (action === 'close') { cloudDismissedId = cloudValue?.id; showCloud(null); await tts.stop(); } else if (action === 'chat') openReader(); return true; });
  guardedHandle('host:cloud-send', (event, input) => {
    allowed(event, cloud);
    try {
      if (switchingMode || cloudValue?.kind !== 'input' || input?.id !== cloudValue.id) throw Error('输入框已关闭，请重新打开输入框后发送');
      const draftCloud = cloudValue; cloudValue = null;
      try { chatService.command({ action: 'send', text: input.text }); } catch (error) { cloudValue = draftCloud; throw error; } return { ok: true };
    } catch (error) { return { ok: false, error: error.message }; }
  });
  ipcMain.on('host:cloud-measure', (event, value) => { try { allowed(event, cloud); if (!cloudValue || value?.id !== cloudValue.id || !Number.isFinite(value.contentWidth) || !Number.isFinite(value.naturalHeight) || value.naturalHeight < 20 || value.naturalHeight > 20000 || Math.abs(value.contentWidth - cloudGeometry.content.width) > 2) return; if (cloudMeasurement && Math.abs(cloudMeasurement.naturalHeight - value.naturalHeight) < 2 && Math.abs(cloudMeasurement.contentWidth - value.contentWidth) < 2) return; cloudMeasurement = { contentWidth: value.contentWidth, naturalHeight: value.naturalHeight }; positionCloud(); } catch {} });
  ipcMain.on('host:cloud-hit', (event, value) => { try { allowed(event, cloud); cloudHover = value === true; cloud.setIgnoreMouseEvents(!cloudHover, { forward: true }); } catch {} });
  ipcMain.handle('host:presence-command', (event, command) => {
    allowed(event, debug);
    if (command === 'hide') { finishDrag(); pet.hide(); }
    else if (command === 'home') { finishDrag(); const a = screen.getPrimaryDisplay().workArea, s = sizeFor(scale); setPetBounds({ x: a.x + a.width - s.width - 12, y: a.y + a.height - s.height - 12 }); showPet(); saveSettings(); }
    else if (command === 'topmost-on' || command === 'topmost-off') setTopmost(command === 'topmost-on');
    else if (command === 'pause' || command === 'resume') { finishDrag(); paused = command === 'pause'; }
    else if (command === 'reload') { finishDrag(); presence = { ready: false, status: '正在重新加载角色', error: '' }; writeHostInfo(); pet.webContents.reload(); }
    else if (command === 'quit') { app.quit(); return true; }
    else return false;
    lifecycle(); return true;
  });
  ipcMain.on('host:presence-report', (event, data) => {
    try {
      allowed(event, pet);
      if (!data || typeof data.status !== 'string' || typeof data.ready !== 'boolean') return;
      const wasReady = presence.ready;
      presence = { ready: data.ready, status: data.status.slice(0, 120), error: String(data.error || '').slice(0, 500), parameters: Number.isSafeInteger(data.parameters) ? data.parameters : 0, textures: Number.isSafeInteger(data.textures) ? data.textures : 0, frames: Number.isSafeInteger(data.frames) ? data.frames : 0 };
      if (wasReady !== presence.ready) writeHostInfo();
      publishPresence();
      prepareDesktopShortcut();
    } catch { /* Stale renderer. */ }
  });
  ipcMain.on('host:anchor', (event, value) => { try { allowed(event, pet); if (Number.isFinite(value?.x) && value.x >= .2 && value.x <= .8 && Number.isFinite(value?.y) && value.y >= .5 && value.y <= 1) anchor = { x: value.x, y: value.y }; } catch {} });
  ipcMain.on('host:head-anchor', (event, value) => { try { allowed(event, pet); if (value?.source === 'Headband-neutral-projection' && [value.x, value.y].every(n => Number.isFinite(n) && n >= 0 && n <= 1)) { headAnchor = { x: value.x, y: value.y }; positionCloud(); } } catch {} });
  pet.on('hide', () => { petHit = null; finishDrag(); lifecycle(); }); pet.on('show', lifecycle);
  pet.on('focus', () => applyStacking(true));
  pet.on('always-on-top-changed', (_, enabled) => { if (alwaysOnTop && !enabled) applyStacking(); });
  pet.webContents.on('did-finish-load', lifecycle);
  pet.webContents.on('render-process-gone', (_, details) => { finishDrag(); presence = { ready: false, status: '角色渲染进程已停止', error: `原因：${details.reason}；请点击重新加载角色。` }; publishPresence(); openDebug(); });
  powerMonitor.on('suspend', () => { suspended = true; finishDrag(); void speech.cancel('电脑进入睡眠，倾听已结束'); lifecycle(); });
  powerMonitor.on('resume', () => { suspended = false; setPetBounds(pet.getContentBounds()); lifecycle(); });
  pointerTimer = setInterval(() => {
    if (!pet || pet.isDestroyed() || !pet.isVisible() || suspended || !presence.ready) return;
    // Windows can clear the native flag after focus without emitting a change event.
    if (alwaysOnTop && !pet.isAlwaysOnTop()) applyStacking();
    if (cloud?.isVisible() && cloud.isAlwaysOnTop() !== alwaysOnTop) cloud.setAlwaysOnTop(alwaysOnTop, 'screen-saver');
    const cursor = screen.getCursorScreenPoint(), bounds = pet.getContentBounds();
    pet.webContents.send('host:pointer', { x: cursor.x - bounds.x, y: cursor.y - bounds.y });
  }, 50);
  pointerTimer.unref();
  globalShortcut.register('CommandOrControl+Alt+Shift+P', () => pet.isVisible() ? pet.hide() : showPet());
  const icon = nativeImage.createFromPath(iconPath).resize({ width: 24, height: 24 });
  tray = new Tray(icon); tray.setToolTip(CHARACTER_NAME + ' · 桌面陪伴');
  updateTray(); tray.on('double-click', openInfo);
  panel.on('close', event => { if (!quitting) { event.preventDefault(); endShortcutCapture(); panel.hide(); } });
  debug.on('close', event => { if (!quitting) { event.preventDefault(); debug.hide(); } });
  reader.on('close', event => { saveReaderBounds(); if (!quitting) { event.preventDefault(); reader.hide(); } });
  debug.webContents.on('did-start-loading', () => { if (speech.state().active) void speech.cancel('页面重新加载，倾听已结束'); });
  debug.webContents.on('render-process-gone', () => { void speech.cancel('录音页面已停止'); });
  // Register IPC before loading pages: the panel requests its initial state during load.
  await panel.loadURL(info.url + '&view=presence');
  await debug.loadURL(origin + '/debug.html');
  await reader.loadURL(origin + '/reader.html');
  await pet.loadURL(origin + '/presence.html');
  await cloud.loadURL(origin + '/cloud.html');
  setTimeout(()=>{ if(!quitting&&!cloudValue&&!chatService.state().busy) { try { const invitation=growth.welcome(); if(invitation) showCloud(invitation); } catch {} } },700);
  try { await setVoiceShortcut(companion.state().voiceShortcut); } catch (error) { shortcutError = error.message; panel.webContents.send('host:shortcut-error', shortcutError); showCloud({ id: String(Date.now()), kind: 'status', text: shortcutError }, 10000); }
  setPetBounds(pet.getContentBounds()); showPet(); panel.show();
  windowsReady = true;
  prepareDesktopShortcut();
  taskLink.connect();
  writeHostInfo();
  void configureVoice().catch(error => { naturalVoice.error = error.message; naturalVoice.phase = 'error'; naturalVoice.publish(); });
}
app.whenReady().then(() => {
  worker = utilityProcess.fork(path.join(ROOT, 'server.cjs'), checkId ? ['--presence-check=' + checkId] : [], { stdio: 'pipe', serviceName: 'Desktop Pet Local Executor' });
  worker.stdout?.on('data', data => process.stdout.write(data)); worker.stderr?.on('data', data => process.stderr.write(data));
  worker.on('message', message => { if (message.type === 'ready') createWindows(message).catch(error => { console.error(error); app.quit(); }); });
  worker.on('exit', () => { if (!quitting && panel && !panel.isDestroyed()) panel.setTitle(CHARACTER_NAME + ' · 执行器已离线'); });
});
app.on('second-instance', () => { if (panel && !panel.isDestroyed()) panel.show(); });
app.on('before-quit', async event => {
  if (quitting) return; event.preventDefault(); quitting = true; taskLink?.close(); saveSettings(); clearInterval(pointerTimer); clearTimeout(cloudTimer); clearTimeout(shortcutCaptureTimer); globalShortcut.unregisterAll();
  const timeout = setTimeout(() => { worker?.kill(); app.quit(); }, 6500);
  const workerExit = !worker ? Promise.resolve() : new Promise(resolve => { worker.once('exit', resolve); worker.postMessage('shutdown'); });
  clearTimeout(readerBoundsTimer); saveReaderBounds();
  await Promise.allSettled([workerExit, chatService.close(), speech.close(), tts.close(), naturalVoice.close(), voiceKeys.close(), agentService.close()]); clearTimeout(timeout); app.quit();
});
app.on('window-all-closed', () => { if (!quitting) app.quit(); });
