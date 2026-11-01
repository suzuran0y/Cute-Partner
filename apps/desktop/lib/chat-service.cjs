'use strict';
const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { HarnessProvider, installation, MODELS } = require('./harness-provider.cjs');
const { UsageLedger } = require('./usage-ledger.cjs');
const { replyFormat, committedReply } = require('./reply-format.cjs');
const BUSY = new Set(['connecting', 'thinking', 'stopping']);
const MAX_REPLY = 131072;
const month = () => new Date().toISOString().slice(0, 7);
const usageOf = u => Object.fromEntries(['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'totalTokens'].filter(k => Number.isSafeInteger(u?.[k]) && u[k] >= 0).map(k => [k, u[k]]));
class ChatService extends EventEmitter {
  constructor({ root, factory = options => new HarnessProvider(options), available = installation, context = () => ({ persona: '', memory: '', contextRevision: '' }), ledger, budget, budgetPollMs = 5000, memory, growth } = {}) {
    super(); this.growth = growth; this.memory = memory; this.drawerId = 'general'; this.drawerSessions = {}; this.linkedDrawers = []; this.memoryEpoch = -1; this.sessionTask = null; this.memoryNotice = ''; this.root = root; this.factory = factory; this.available = available; this.budget = budget; this.budgetPollMs = budgetPollMs;
    this.context = context; this.ledger = ledger || new UsageLedger(root); this.contextRevision = context().contextRevision;
    this.file = path.join(root, 'chat-state.json'); this.revision = 0; this.phase = 'idle'; this.error = ''; this.closed = false;
    this.model = MODELS[0].id; this.sessionId = randomUUID(); this.messages = []; this.turns = 0; this.lastSeq = -1;
    this.meter = { month: month(), requests: 0, totalTokens: 0 }; this.limits = { monthlyRequests: 0, monthlyReportedTokens: 0, turnsPerConversation: 20 };
    const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'model-service.config.json'), 'utf8'));
    if (config.version !== 1 || config.provider !== 'deepseek-harness') throw Error('模型服务配置版本或服务商无效');
    for (const [key, max] of Object.entries({ monthlyRequests: 10000, monthlyReportedTokens: 10000000, turnsPerConversation: 20 })) {
      if (!Number.isSafeInteger(config.limits?.[key]) || config.limits[key] < (key === 'turnsPerConversation' ? 1 : 0) || config.limits[key] > max) throw Error('模型调用限额配置无效：' + key);
      this.limits[key] = config.limits[key];
    }
    try {
      const state = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (state.version === 1 && MODELS.some(m => m.id === state.model) && /^[\w-]+$/.test(state.sessionId)) {
        if (this.memory) { try { this.memory.drawer(state.drawerId || 'general'); this.drawerId = state.drawerId || 'general'; } catch {} this.drawerSessions = state.drawerSessions || {}; this.sessionTask = state.sessionTask || null; this.memoryEpoch = state.memoryEpoch ?? -1; this.linkedDrawers = (state.linkedDrawers || []).filter(id => this.memory.state().drawers.some(d => d.id === id)).slice(0, 4); }
        this.model = state.model; this.sessionId = state.sessionId; this.messages = (state.messages || []).filter(m => ['user', 'assistant'].includes(m.role) && typeof m.text === 'string').slice(-40).map(m => {
          const restored = m.status === 'streaming' ? { ...m, status: 'interrupted' } : m;
          return restored.role === 'assistant' && typeof restored.rawText === 'string' ? { ...restored, ...committedReply(restored.rawText, { interrupted: restored.status === 'interrupted', finishKind: restored.finishKind, truncated: restored.hostTruncated }) } : restored;
        });
        this.turns = Math.min(20, Number.isSafeInteger(state.turns) ? state.turns : 0); this.lastSeq = Number.isSafeInteger(state.lastSeq) ? state.lastSeq : -1;
        this.needsResume = state.needsResume === true;
        this.contextRevision = state.contextRevision ?? this.contextRevision;
        if (state.meter?.month === month() && Number.isSafeInteger(state.meter.requests) && Number.isSafeInteger(state.meter.totalTokens)) this.meter = state.meter;
        if (state.inFlight) { this.phase = 'error'; this.error = '上次对话被中断，未自动重发；可以继续交流或开启新对话。'; }
        if (context().runtimePolicyVersion && state.runtimePolicyVersion !== context().runtimePolicyVersion) {
          fs.copyFileSync(this.file, path.join(root, 'chat-before-policy-' + context().runtimePolicyVersion + '-' + Date.now() + '.json'));
          this.sessionId = randomUUID(); if (!this.memory) this.messages = []; this.drawerSessions = {}; this.sessionTask = null; this.turns = 0; this.lastSeq = -1; this.needsResume = false; this.phase = 'idle'; this.error = ''; this.contextRevision = context().contextRevision; this.continuityNotice = '宿主记忆规则已更新，聊天历史保留；模型会话按新规则重建，旧任务不自动重放。';
        }
      }
    } catch { /* No saved conversation, or invalid local data. */ }
  }
  state() {
    if (this.meter.month !== month()) this.meter = { month: month(), requests: 0, totalTokens: 0 };
    const found = this.available();
    return { growth: this.growth?.state({drawerId:this.drawerId}), drawerId: this.drawerId, drawerName: this.memory?.state().drawers.find(d => d.id === this.drawerId)?.name || '日常', linkedDrawers: [...this.linkedDrawers], memoryNotice: this.memoryNotice, continuityNotice: this.continuityNotice || '', memorySnapshot: this.lastMemorySnapshot ? { id: this.lastMemorySnapshot.id, revision: this.lastMemorySnapshot.revision, estimatedTokens: this.lastMemorySnapshot.estimatedTokens, omittedCoreCount: this.lastMemorySnapshot.omittedCoreCount || 0, sources: this.lastMemorySnapshot.sources, available: this.lastMemorySnapshot.available } : null, revision: this.revision, conversationId: this.sessionId, generationId: this.generationId, streaming: { available: !!this.streamCapable, degraded: !!this.streamDegraded }, provider: 'deepseek-harness', model: this.model, models: MODELS, phase: this.phase, busy: BUSY.has(this.phase) || !!this.provider, installed: found.installed, credentialAvailable: found.credentialAvailable || !!process.env.DEEPSEEK_API_KEY, messages: this.messages.map(({ rawText, ...m }) => ({ ...m })), error: this.error, meter: { ...this.meter }, limits: { ...this.limits }, turns: this.turns };
  }
  save() {
    fs.mkdirSync(this.root, { recursive: true });
    const next = this.file + '.tmp';
    fs.writeFileSync(next, JSON.stringify({ version: 1, drawerId: this.drawerId, drawerSessions: this.drawerSessions, sessionTask: this.sessionTask, memoryEpoch: this.memoryEpoch, linkedDrawers: this.linkedDrawers, runtimePolicyVersion: this.context(this.drawerId).runtimePolicyVersion, model: this.model, sessionId: this.sessionId, contextRevision: this.contextRevision, needsResume: !!this.needsResume, messages: this.messages, turns: this.turns, lastSeq: this.lastSeq, meter: this.meter, inFlight: BUSY.has(this.phase) }, null, 2), { mode: 0o600 });
    fs.renameSync(next, this.file);
  }
  publish() { this.save(); this.revision++; this.emit('update', this.state()); }
  command(input) {
    if (this.closed) throw Error('对话服务已关闭');
    if (!input || typeof input !== 'object') throw Error('无效对话操作');
    if (input.action === 'stop') { void this.stop(); return this.state(); }
    if (BUSY.has(this.phase)) throw Error('请等待当前回复结束或停止');
    if (this.provider) throw Error('上一轮连接尚未释放，请稍后重试');
    if (this.memory && input.action === 'drawer') { this.growth?.clearSwitch(this.drawerId); this.switchDrawer(input.drawerId); return this.state(); }
    if (this.memory && input.action === 'link-drawers') { if (!Array.isArray(input.ids) || input.ids.length > 4 || new Set(input.ids).size !== input.ids.length) throw Error('最多关联4个不同抽屉'); for (const id of input.ids) this.memory.drawer(id); this.linkedDrawers = [...input.ids]; this.rotateSession('关联参考范围已改变，已新建隔离会话', false); this.publish(); return this.state(); }
    if (input.action === 'new') { this.growth?.clearSwitch(this.drawerId);
      if (input.model !== undefined && !MODELS.some(m => m.id === input.model)) throw Error('不支持的模型');
      this.model = input.model || this.model; this.sessionId = randomUUID(); this.contextRevision = this.context(this.drawerId).contextRevision; if (!this.memory) this.messages = []; this.memoryEpoch = this.memory?.state().privacyEpoch ?? -1; this.turns = 0; this.lastSeq = -1; this.needsResume = false; this.phase = 'idle'; this.error = ''; this.publish(); return this.state();
    }
    if (input.action !== 'send' || typeof input.text !== 'string' || !input.text.trim() || input.text.length > 4000) throw Error('请输入 1–4000 字的消息');
    if (this.growth) { const next = this.growth.nextDrawer(this.drawerId, this.sessionId); if (next) this.switchDrawer(next); }
    this.state();
    if (this.memory && (this.memoryEpoch !== this.memory.state().privacyEpoch || this.contextRevision !== this.context(this.drawerId).contextRevision)) this.rotateSession('记忆遗忘边界、角色或权限变化，已重建干净会话', false);
    if (this.memory && this.turns >= this.limits.turnsPerConversation) this.rotateSession('已保存阶段交接，在同一抽屉续接新会话', true);
    if (this.turns && this.contextRevision !== this.context(this.drawerId).contextRevision) throw Error('角色设定、记忆或权限已更新，请开启新对话后发送');
    this.contextRevision = this.context(this.drawerId).contextRevision;
    if (this.turns >= this.limits.turnsPerConversation) throw Error('本次对话已达轮数上限，请开启新对话');
    if (this.limits.monthlyRequests > 0 && this.meter.requests >= this.limits.monthlyRequests) throw Error(`已达到独立的本地月调用次数上限（${this.limits.monthlyRequests}次）；它与节食余额下限无关，请检查模型服务配置。`);
    if (this.limits.monthlyReportedTokens > 0 && this.meter.totalTokens >= this.limits.monthlyReportedTokens) throw Error(`已达到独立的本地月token上限（${this.limits.monthlyReportedTokens} token）；它与节食余额下限无关，请检查模型服务配置。`);
    const found = this.available();
    if (!found.installed) throw Error('未找到 DeepSeek Harness');
    if (!found.credentialAvailable && !process.env.DEEPSEEK_API_KEY) throw Error('请先在 DeepSeek Harness 中配置 API 凭据');
    this.stopRequested = false; this.stopReason = ''; this.error = ''; this.phase = 'connecting'; this.turnEnd = null; this.answer = false; this.turnUsage = null; this.generationId = randomUUID(); this.startedAt = Date.now(); this.streamCapable = false; this.streamDegraded = false;
    const userMessage = { id: randomUUID(), role: 'user', text: input.text.trim(), at: Date.now(), drawerId: this.drawerId, sessionId: this.sessionId }; this.messages.push(userMessage); if (!this.turns) this.sessionTask = { id: userMessage.id, text: userMessage.text }; this.lastUserMessage = userMessage;
    if (this.memory) { try { this.memoryNotice = (this.growth ? this.growth.capture.bind(this.growth) : require('./memory-context.cjs').capture)(this.memory, { text: userMessage.text, messageId: userMessage.id, drawerId: this.drawerId, sessionId: this.sessionId, generationId: this.generationId }); } catch (error) { this.memoryNotice = '本次记忆未保存：' + error.message; } } this.turns++; this.meter.requests++;
    this.publish(); this.operation = this.run(input.text.trim()); this.operation.catch(() => {}); return this.state();
  }
  async run(text) {
    const provider = this.provider = this.factory({ root: path.join(this.root, 'runtime'), context: { ...this.context(this.drawerId), generationId: this.generationId, drawerId: this.drawerId, linkedDrawers: [...this.linkedDrawers], growthContext: this.growth?.context(this.drawerId), memorySource: this.lastUserMessage && { messageId: this.lastUserMessage.id, text: this.lastUserMessage.text }, ...(this.memory ? { memorySnapshot: this.prepareMemory(text) } : {}) } });
    let active = true, checking = false, timer, liveTimer; const attempts = new Map(), committedSteps = new Set();
    const publishLive = () => { if (!liveTimer) liveTimer = setTimeout(() => { liveTimer = null; if (active) this.publish(); }, 60); };
    const onStream = frame => {
      if (!active || !this.accepting || this.stopRequested || !frame || typeof frame.attemptId !== 'string' || !Number.isSafeInteger(frame.revision)) return;
      if (frame.type === 'start') { if (attempts.has(frame.attemptId) || committedSteps.has(frame.turn + ':' + frame.step) || attempts.size >= 64) return; attempts.set(frame.attemptId, { turn: frame.turn, step: frame.step, revision: frame.revision, index: -1, blocks: new Map() }); return; }
      const attempt = attempts.get(frame.attemptId); if (!attempt || frame.revision <= attempt.revision || attempt.ended) return; attempt.revision = frame.revision;
      if (frame.type === 'end') { attempt.ended = true; if (attempt.row && frame.outcome?.kind !== 'committed') { attempt.row.status = 'interrupted'; publishLive(); } return; }
      if (frame.type !== 'chunk' || frame.index <= attempt.index || typeof frame.text !== 'string' || attempt.row?.status === 'completed') return;
      attempt.index = frame.index; const previous = attempt.blocks.get(frame.block) || '';
      attempt.blocks.set(frame.block, (frame.replace ? frame.text : previous + frame.text).slice(0, MAX_REPLY));
      const raw = [...attempt.blocks.entries()].sort((a, b) => a[0] - b[0]).map(([, text]) => text).join('\n').slice(0, MAX_REPLY), formatted = replyFormat(raw);
      if (!attempt.row) { attempt.row = { id: 'live:' + this.generationId + ':' + frame.attemptId, role: 'assistant', at: Date.now(), firstBodyAt: null, generationId: this.generationId, attemptId: frame.attemptId, providerTurn: attempt.turn, providerStep: attempt.step, status: 'streaming' }; attempt.row.drawerId = this.drawerId; attempt.row.sessionId = this.sessionId; this.messages.push(attempt.row); }
      Object.assign(attempt.row, formatted, { rawText: raw }); if (formatted.text && !attempt.row.firstBodyAt) attempt.row.firstBodyAt = Date.now(); publishLive();
    };
    const checkBudget = async () => { if (!active || checking || this.stopRequested) return; checking = true; try { await this.budget?.check(); } catch (error) { if (active && !this.stopRequested) void this.stop(error.message); } finally { checking = false; } };
    const onNotification = (method, params) => {
      if (this.stopRequested || !this.accepting || params?.sessionId !== this.sessionId || method !== 'session.event') return;
      const event = params.event;
      if (!Number.isSafeInteger(event?.seq) || event.seq <= this.lastSeq) return;
      this.lastSeq = event.seq;
      if (event.type === 'tool/call' || event.type === 'tool/result') this.emit('tool', { sessionId: this.sessionId, event });
      if (['assistant/message', 'assistant/attempt'].includes(event.type)) {
        const usage = usageOf(event.data?.usage || event.data?.stream?.findLast?.(item => item.type === 'chunk' && item.chunk?.type === 'usage')?.chunk.usage);
        if (Number.isSafeInteger(usage.totalTokens) && this.ledger.record({ id: this.sessionId + ':' + event.seq, model: this.model, usage, at: Number.isFinite(event.time) ? event.time : Date.now() })) { this.meter.totalTokens += usage.totalTokens; this.turnUsage = usage; if (this.limits.monthlyReportedTokens > 0 && this.meter.totalTokens >= this.limits.monthlyReportedTokens) setImmediate(() => { void this.stop('已达到独立的本地月token上限，与节食余额下限无关。'); }); if (this.budget) void checkBudget(); }
      }
      if (event.type === 'assistant/message' && event.data?.message?.role === 'assistant') {
        const message = event.data.message;
        const rawReply = (message.content || []).filter(b => b.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n'), reply = rawReply.slice(0, MAX_REPLY);
        if (reply) {
          const attempt = attempts.get(event.data.hostAttemptId), existing = attempt?.row || this.messages.find(m => m.providerMessageId === message.id || m.id === message.id);
          const row = existing || { id: message.id || randomUUID(), role: 'assistant', at: Date.now(), generationId: this.generationId };
          const reason = event.data.stream?.findLast?.(item => item.type === 'chunk' && item.chunk?.type === 'finish')?.chunk.reason?.kind;
          const finishKind = typeof reason === 'string' ? /^[a-z-]{1,40}$/.test(reason) ? reason : 'unknown' : undefined;
          const formatted = committedReply(reply, { interrupted: !!event.data.interrupted, finishKind, truncated: rawReply.length > MAX_REPLY });
          Object.assign(row, formatted, { rawText: reply, hostTruncated: rawReply.length > MAX_REPLY, providerMessageId: message.id, providerTurn: event.data.turn, providerStep: event.data.step, status: formatted.replyCompletion === 'incomplete' ? 'interrupted' : 'completed', committedAt: Date.now() });
          row.drawerId = this.drawerId; row.sessionId = this.sessionId; if (!existing) this.messages.push(row); if (attempt) attempt.row = row; committedSteps.add(event.data.turn + ':' + event.data.step); this.answer = true;
        }
        this.publish();
      }
      if (event.type === 'turn/end') { this.turnEnd = event.data?.reason; }
    };
    provider.on('notification', onNotification);
    provider.on('stream', onStream);
    try {
      this.budget?.beginTurn(); await this.budget?.check();
      if (this.stopRequested) return;
      if (this.budget) { timer = setInterval(checkBudget, this.budgetPollMs); timer.unref?.(); }
      await provider.openConversation({ model: this.model, sessionId: this.sessionId, resume: this.needsResume });
      this.streamCapable = !!provider.agentCapabilities?.streaming;
      this.needsResume = true;
      if (this.stopRequested) return;
      this.phase = 'thinking'; this.accepting = true; this.publish();
      await provider.send(text);
      this.streamDegraded = !!provider.streamDegraded;
      if (!this.stopRequested) {
        if (this.turnEnd?.kind !== 'completed' || !this.answer) {
          const code = this.turnEnd?.error?.code;
          throw Error(code === 'TRANSPORT' ? 'DeepSeek 网络连接失败，请检查网络后重试；消息未自动重发。' : code === 'AUTH' ? 'DeepSeek 凭据校验失败，请检查 Harness 设置。' : '模型回复未正常完成，请检查 Harness 凭据、额度与网络；消息未自动重发。');
        }
        this.phase = 'completed';
      }
    } catch (error) {
      if (!this.stopRequested) { this.phase = 'error'; this.error = this.budget?.state().warning || error.message; }
    } finally {
      active = false; clearInterval(timer); clearTimeout(liveTimer);
      for (const attempt of attempts.values()) if (attempt.row?.status === 'streaming') attempt.row.status = 'interrupted';
      this.accepting = false; provider.off('notification', onNotification);
      provider.off('stream', onStream);
      try { await provider.close(); this.provider = null; }
      catch { this.phase = 'error'; this.error = 'Harness 进程尚未确认退出，暂时禁止新请求。'; }
      if (this.stopRequested && !this.provider) { this.phase = 'cancelled'; this.error = this.stopReason || '已确认停止；已发送内容可能已产生用量，未报告用量不计入本地 token 统计。'; }
      if (this.phase !== 'completed') for (const row of this.messages) if (row.role === 'assistant' && row.generationId === this.generationId) { row.status = 'interrupted'; row.speechEligible = false; row.spokenText = ''; row.replyCompletion = 'incomplete'; row.voiceUnavailable = '本轮未正常完成，未自动朗读；已收到的正文保留'; }
      if (this.memory) { try { fs.appendFileSync(path.join(this.root, 'conversation-archive.jsonl'), JSON.stringify({ at: Date.now(), sessionId: this.sessionId, generationId: this.generationId, drawerId: this.drawerId, phase: this.phase, messages: this.messages.filter(m => m.generationId === this.generationId || m.id === this.lastUserMessage?.id) }) + '\n', { mode: 0o600 }); } catch { this.memoryNotice += ' 对话归档未能保存。'; } }
      this.publish();
    }
  }
  prepareMemory(text) { try { this.lastMemorySnapshot = require('./memory-context.cjs').snapshot(this.memory, { drawerId: this.drawerId, linkedDrawers: this.linkedDrawers, query: text, generationId: this.generationId }); return { ...this.lastMemorySnapshot, text: this.lastMemorySnapshot.text + (this.memoryNotice ? '\n本轮本地记忆反馈：' + this.memoryNotice : '') }; } catch (error) { this.memoryNotice = '本轮记忆读取未完成：' + error.message; return { available: false, text: this.memoryNotice }; } }
  checkpoint() { this.drawerSessions[this.drawerId] = { sessionId: this.sessionId, turns: this.turns, lastSeq: this.lastSeq, needsResume: this.needsResume, contextRevision: this.contextRevision, memoryEpoch: this.memoryEpoch, linkedDrawers: [...this.linkedDrawers], model: this.model, sessionTask: this.sessionTask }; }
  rotateSession(reason, handoff) {
    if (handoff) { try { const recent = this.messages.filter(m => m.sessionId === this.sessionId && m.status !== 'interrupted').slice(-4), rows = this.sessionTask ? [{ ...this.sessionTask, role: 'user' }, ...recent.filter(m => m.id !== this.sessionTask.id)] : recent, sources = rows.map(m => m.id); if(this.growth) this.growth.checkpoint(this.drawerId,this.sessionId,rows); else this.memory.saveEntry({ drawerId: this.drawerId, kind: 'handoff', content: '阶段交接摘录（非完成证明；完整来源在conversation-archive.jsonl）：\n' + rows.map(m => m.role + ' [' + m.id + '] ' + m.text.slice(0, 900) + (m.text.length > 900 ? '…（摘录，完整见归档）' : '')).join('\n') }, { actor: 'host', ref: 'session:' + this.sessionId, messageIds: sources, verifiedByTool: false }); } catch { reason = '阶段交接保存失败；已切新会话，不能声称旧进度完整续接。'; } }
    this.sessionId = randomUUID(); this.turns = 0; this.lastSeq = -1; this.needsResume = false; this.contextRevision = this.context(this.drawerId).contextRevision; this.memoryEpoch = this.memory?.state().privacyEpoch ?? -1; this.sessionTask = null; this.continuityNotice = reason;
  }
  switchDrawer(id) { this.memory.drawer(id); if (id === this.drawerId) return; this.checkpoint(); this.drawerId = id; this.linkedDrawers = []; const saved = this.drawerSessions[id]; if (saved && typeof saved.sessionId === 'string' && saved.model === this.model) Object.assign(this, { sessionTask: saved.sessionTask || null, linkedDrawers: (saved.linkedDrawers || []).filter(id => this.memory.state().drawers.some(d => d.id === id)), sessionId: saved.sessionId, turns: saved.turns, lastSeq: saved.lastSeq, needsResume: saved.needsResume, contextRevision: saved.contextRevision, memoryEpoch: saved.memoryEpoch }); else this.rotateSession('新事务会话', false); if (this.memoryEpoch !== this.memory.state().privacyEpoch || this.contextRevision !== this.context(this.drawerId).contextRevision) this.rotateSession('旧会话规则或遗忘边界已变化，已重建', false); this.phase = 'idle'; this.error = ''; this.publish(); }
  async stop(reason = '') {
    if (!BUSY.has(this.phase) || this.phase === 'stopping') return;
    this.stopRequested = true; this.stopReason = reason; this.phase = 'stopping'; this.publish();
    try { await this.provider?.close(); } catch { /* run() reports confirmed shutdown failures. */ }
    await this.operation;
  }
  async close() { this.closed = true; await this.stop(); await this.operation; }
}
module.exports = { ChatService, BUSY, usageOf };
