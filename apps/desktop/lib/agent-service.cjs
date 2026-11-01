'use strict';
const { EventEmitter } = require('node:events'), http = require('node:http'), fs = require('node:fs'), fsp = require('node:fs/promises'), path = require('node:path'), { randomUUID, randomBytes, timingSafeEqual, createHash } = require('node:crypto'), { spawn } = require('node:child_process');
const { QuestionService } = require('./question-service.cjs');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const OMIT = new Set(['node_modules', '.runtime', 'data', 'test-results', '.git', '.env', '.credentials.yaml']);
function redact(args) { if (!args || typeof args !== 'object') return args; return Object.fromEntries(Object.entries(args).map(([key, value]) => [key, /token|secret|password|content|api.?key/i.test(key) ? '[内容省略]' : typeof value === 'string' ? value.slice(0, 12000) : value])); }
function run(executable, args, { cwd, input, signal, timeout = 30000, nodeMode = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, env: nodeMode ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' } : process.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); let output = '', error = '', settled = false;
    const kill = () => child.kill(); const timer = setTimeout(kill, timeout); signal?.addEventListener('abort', kill, { once: true });
    child.stdout.on('data', bytes => { if (output.length < 250000) output += bytes; }); child.stderr.on('data', bytes => { if (error.length < 4000) error += bytes; }); child.stdin.on('error', () => {}); child.stdin.end(input || '');
    child.on('error', () => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', kill); reject(Error('程序启动失败')); });
    child.on('close', code => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', kill); if (signal?.aborted) reject(Error('操作已取消')); else resolve({ code, output, error }); });
  });
}
class AgentService extends EventEmitter {
  constructor({ root, sourceRoot, memory, growth, budgetCheck = async () => ({ allowed: true }) }) { super(); this.root = root; this.sourceRoot = sourceRoot; this.budgetCheck = budgetCheck; this.memory = memory; this.growth = growth; this.leases = new Map(); this.requests = new Map(); this.tools = []; this.revision = 0; this.upgrades = new Map(); this.questions = new QuestionService({ root }); this.questions.on('update', () => this.publish()); }
  state() { return { revision: this.revision, runtime: this.runtime ? { ...this.runtime } : null, requests: [...this.requests.values()].map(({ resolve, timer, lease, response, ...publicValue }) => publicValue).concat(this.questions.state().requests.filter(r => r.status === 'waiting')), tools: this.tools.slice(-60), active: this.tools.some(tool => tool.status === 'running'), pending: this.requests.size > 0 || this.questions.pending.size > 0 }; }
  publish() { this.revision++; this.emit('update', this.state()); }
  audit(value) { fs.mkdirSync(this.root, { recursive: true }); fs.appendFileSync(path.join(this.root, 'execution-log.jsonl'), JSON.stringify({ at: Date.now(), ...value }) + '\n', { mode: 0o600 }); }
  note(sessionId, event) {
    if (event.type === 'tool/call') {
      let args; try { args = JSON.parse(event.data.arguments); } catch { args = {}; }
      const value = { sessionId, id: event.data.callId, name: String(event.data.name).slice(0, 100), arguments: redact(args), status: 'running', at: Date.now() }; this.tools.push(value); this.tools = this.tools.slice(-100);
      this.audit({ kind: 'tool-start', ...value }); this.publish();
    } else if (event.type === 'tool/result') {
      const message = event.data.message, value = this.tools.findLast(item => item.sessionId === sessionId && item.id === message.toolCallId);
      if (value) { value.status = message.isError ? 'failed' : 'completed'; value.result = (message.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').slice(0, 16000); this.audit({ kind: 'tool-end', sessionId, id: value.id, status: value.status }); this.publish(); }
    }
  }
  async open({ sessionId, mode, workspace, onStream, turnId = randomUUID(), drawerId = 'general', drawerName = '日常', linkedDrawers = [], memorySource }) {
    if (!this.server) {
      this.server = http.createServer((req, res) => { void this.handle(req, res); });
      await new Promise(resolve => this.server.listen(0, '127.0.0.1', resolve)); this.origin = 'http://127.0.0.1:' + this.server.address().port;
    }
    const token = randomBytes(32).toString('hex'), lease = { token, sessionId, mode, workspace, onStream, turnId, drawerId, drawerName, linkedDrawers, memorySource, memoryEpoch: this.memory?.state().privacyEpoch, connectionId: randomUUID(), abort: new AbortController(), observed: new Map() }; this.growth?.initializeLease(lease); this.leases.set(token, lease);
    lease.ready = new Promise(resolve => { lease.markReady = resolve; });
    return { url: this.origin + '/agent', token, waitReady: async () => { let timer; try { return await Promise.race([lease.ready, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Harness宿主插件未就绪；审批和电脑工具没有加载，本轮未发送模型请求')), 5000); })]); } finally { clearTimeout(timer); } }, close: () => {
      if (!this.leases.delete(token)) return; lease.abort.abort(); this.questions.endWhere(item => item.lease === lease);
      if (this.runtime?.sessionId === sessionId) this.runtime.connected = false;
      for (const [id, request] of this.requests) if (request.lease === lease) this.answer(id, { decision: 'cancelled' });
      for (const tool of this.tools) if (tool.sessionId === sessionId && tool.status === 'running') tool.status = 'interrupted'; this.publish();
    } };
  }
  async handle(req, res) {
    const reply = (code, value) => { if (!res.destroyed) { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); } };
    try {
      if (req.method !== 'POST' || req.url !== '/agent' || req.headers.host !== new URL(this.origin).host || req.headers.origin) return reply(403, { ok: false });
      const bearer = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization || '')?.[1], lease = bearer && [...this.leases.values()].find(item => timingSafeEqual(Buffer.from(item.token), Buffer.from(bearer)));
      if (!lease) return reply(401, { ok: false });
      let bytes = ''; for await (const chunk of req) { bytes += chunk; if (bytes.length > 64000) return reply(413, { ok: false }); }
      const input = JSON.parse(bytes); if (input.sessionId !== lease.sessionId) return reply(403, { ok: false });
      const cancel = () => { if (!res.writableEnded) this.questions.endWhere(item => item.response === res); if (!res.writableEnded) for (const [id, request] of this.requests) if (request.response === res) this.answer(id, { decision: 'cancelled' }); };
      res.once('close', cancel);
      const value = await this.execute(lease, input, res); res.removeListener('close', cancel); reply(200, { ok: true, value });
    } catch (error) { reply(200, { ok: false, error: error.message?.slice(0, 200) || '宿主操作失败', code: error.code }); }
  }
  async execute(lease, input, response) {
    lease.abort.signal.throwIfAborted();
    if (input.action === 'assistant-stream') {
      const f = input.frame;
      if (!f || !['start', 'chunk', 'end'].includes(f.type) || typeof f.attemptId !== 'string' || f.attemptId.length > 200 || !Number.isSafeInteger(f.revision) || f.revision < 1) throw Error('正文帧无效');
      const frame = { type: f.type, attemptId: f.attemptId, revision: f.revision };
      if (f.type === 'start') { if (![f.turn, f.step].every(n => Number.isSafeInteger(n) && n >= 0)) throw Error('正文归属无效'); Object.assign(frame, { turn: f.turn, step: f.step }); }
      if (f.type === 'chunk') {
        if (!Number.isSafeInteger(f.index) || f.index < 0 || !Number.isSafeInteger(f.block) || f.block < 0 || typeof f.text !== 'string' || f.text.length > 32000) throw Error('正文分段无效');
        Object.assign(frame, { index: f.index, block: f.block, text: f.text, replace: f.replace === true });
      }
      if (f.type === 'end') frame.outcome = f.outcome?.kind === 'committed' && ['assistant/message', 'assistant/attempt'].includes(f.outcome.eventType) && Number.isSafeInteger(f.outcome.seq) ? { kind: 'committed', eventType: f.outcome.eventType, seq: f.outcome.seq } : { kind: 'abandoned' };
      lease.onStream?.(frame); return { received: true };
    }
    if (input.action === 'budget-check') return this.budgetCheck();
    if (input.action === 'hello') { const tools = Array.isArray(input.tools) ? input.tools.filter(name => typeof name === 'string') : []; this.runtime = { mode: lease.mode, sandbox: lease.mode === 'desktop' ? 'danger-full-access' : 'workspace-write', workspace: lease.workspace, sessionId: lease.sessionId, connected: true, approvalConnected: true, tools }; lease.markReady({ tools, streaming: input.streamVersion === 1 }); this.publish(); return { connected: true }; }
    if (input.action === 'question') return this.questions.ask(lease, input, response);
    if (['growth-topic','growth-persona'].includes(input.action)) { if (!this.growth || !lease.memorySource?.messageId) throw Error('本轮成长来源不可用'); return input.action === 'growth-topic' ? this.growth.topicCommand(lease,input,this.questions,response) : this.growth.personaCommand(lease,input,this.questions,response); }
    if (input.action.startsWith('memory-')) {
      if (!this.memory || !lease.memorySource?.messageId) throw Error('记忆服务或本轮来源不可用');
      if (lease.memoryEpoch !== undefined && lease.memoryEpoch !== this.memory.state().privacyEpoch) throw Error('记忆范围已改变，请结束旧会话后再整理');
      if (['memory-candidate', 'memory-drawer'].includes(input.action) && (lease.memoryWrites || 0) >= 12) throw Error('本轮记忆整理已达上限，先结束本轮');
      if (this.growth && input.action !== 'memory-search' && input.operation !== 'history') {
        const target = this.growth.storageTarget(lease);
        if (input.action === 'memory-candidate' && !target) return this.growth.stage(lease, input);
        if (input.action === 'memory-manage' && input.operation === 'remember' && !input.drawerId) input = { ...input, drawerId: target || 'general' };
      }
      if (input.action === 'memory-manage') return require('./memory-manager.cjs').manageMemory(this.memory, this.questions, lease, input, response);
      const source = { actor: 'model-candidate', ref: 'message:' + lease.memorySource.messageId, sessionId: lease.sessionId, generationId: lease.turnId, at: Date.now(), verifiedByTool: false };
      if (input.action === 'memory-search') {
        if (typeof input.query !== 'string' || input.query.length > 200) throw Error('检索词请控制在200字以内');
        let count = 0;
        // User explicitly authorized cross-drawer snippet sharing on 2026-10-27.
        // Empty broad queries stay scoped; discovery never expands prompt snapshots.
        const current = new Set(['global', lease.drawerId, ...lease.linkedDrawers, ...(lease.createdDrawers || [])]);
        if (input.drawerId && !current.has(input.drawerId) && !input.query.trim()) throw Error('跨抽屉检索需要具体检索词');
        const scopes = input.drawerId ? [input.drawerId] : [...current, ...(input.query.trim() ? this.memory.state().drawers.map(d => d.id) : [])];
        if (input.drawerId && input.drawerId !== 'global') this.memory.drawer(input.drawerId);
        const rows = [...new Set(scopes)].flatMap(drawerId => this.memory.search({ drawerId, query: input.query, includeCandidates: input.includeCandidates === true, limit: 12 }));
        const result = rows.flatMap(e => { const size = require('./memory-context.cjs').estimate(JSON.stringify(e)); if (count + size > 1800) return []; count += size; return [e]; }).slice(0, 12);
        lease.discoveredDrawers = [...new Set([...(lease.discoveredDrawers || []), ...result.map(e => e.drawerId), ...(input.drawerId ? [input.drawerId] : [])])];
        return result;
      }
      if (input.action === 'memory-candidate') { const row = this.memory.saveEntry({ drawerId: lease.drawerId, kind: input.kind || 'reference', content: input.content, status: 'candidate' }, source); lease.memoryWrites = (lease.memoryWrites || 0) + 1; return { id: row.id, status: row.status }; }
      if (input.action === 'memory-drawer') {
        const scopes = new Set([lease.drawerId, ...lease.linkedDrawers, ...(lease.createdDrawers || []), ...(lease.discoveredDrawers || [])]);
        const previous = input.id ? this.memory.drawer(input.id) : null;
        if (previous && !scopes.has(previous.id)) throw Error('不能改名未关联的事务');
        const same = this.memory.state().drawers.find(d => d.name === input.name && d.id !== previous?.id);
        if (same) { lease.discoveredDrawers = [...new Set([...(lease.discoveredDrawers || []), same.id])]; return { id: same.id, name: same.name, changed: false }; }
        if (!previous && (lease.createdDrawers?.length || 0) >= 4) throw Error('本轮最多新建4件事务');
        const d = this.memory.saveDrawer({ ...(previous || {}), ...(previous ? { expectedRevision: input.expectedRevision } : {}), name: input.name, summary: input.summary ?? previous?.summary ?? '' }, { ...source, actor: 'model-managed' });
        lease.memoryWrites = (lease.memoryWrites || 0) + 1;
        if (!previous) lease.createdDrawers = [...(lease.createdDrawers || []), d.id];
        return { id: d.id, name: d.name, revision: d.revision, changed: true, activeConversationChanged: false };
      }
      throw Error('记忆工具操作无效');
    }
    if (lease.mode === 'chat') throw Error('只聊天仅允许正文、预算与结构化追问，不开放执行或审批');
    if (input.action === 'approval') {
      if (this.requests.size >= 8) throw Error('待处理请求过多，请先结束当前操作');
      const id = randomUUID(), tool = this.tools.findLast(t => t.sessionId === lease.sessionId && t.id === input.callId);
      return new Promise(resolve => {
        const request = { id, kind: input.action, sessionId: lease.sessionId, tool: String(input.tool || ''), reason: String(input.reason || '').slice(0, 3000), arguments: redact(input.arguments) || tool?.arguments, questions: input.action === 'question' ? input.questions : undefined, at: Date.now(), lease, resolve, response, timer: setTimeout(() => this.answer(id, { decision: 'cancelled' }), 300000) };
        this.requests.set(id, request); this.audit({ kind: 'waiting-user', id, tool: request.tool, sessionId: lease.sessionId }); this.publish();
      });
    }
    if (input.action === 'upgrade-prepare') return this.prepareUpgrade(lease);
    if (input.action === 'upgrade-review') return this.reviewUpgrade(lease, input);
    if (input.action.startsWith('desktop-')) {
      if (lease.mode !== 'desktop') throw Error('电脑操作权限未开启，请在习惯页切换到“电脑操作”后保存');
      const allowed = ['desktop-list', 'desktop-inspect', 'desktop-action']; if (!allowed.includes(input.action)) throw Error('电脑操作无效');
      if (input.action !== 'desktop-list' && !/^\d{1,18}$/.test(input.window || '')) throw Error('窗口句柄无效');
      if (input.action === 'desktop-action') {
        const observed = lease.observed.get(input.window);
        if (!observed || Date.now() - observed.at > 60000 || input.operation !== 'focus' && !observed.nodes.has(input.node)) throw Error('请先重新inspect目标窗口，再使用真实控件ID');
        if (!['focus', 'invoke', 'set_value'].includes(input.operation) || String(input.value || '').length > 12000) throw Error('控件操作无效');
      }
      const result = await run(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(this.sourceRoot, 'tools/desktop-access.ps1')], { input: JSON.stringify(input), signal: lease.abort.signal, timeout: 15000 });
      let data; try { data = JSON.parse(result.output.replace(/^\uFEFF/, '')); } catch { throw Error('电脑控件读取超时或不可用'); }
      if (!data.ok) throw Error(data.error);
      if (input.action === 'desktop-inspect') lease.observed.set(input.window, { at: Date.now(), nodes: new Set(data.value.controls.map(item => item.node)) });
      return data.value;
    }
    throw Error('不支持的宿主工具');
  }
  answer(id, input) {
    const request = this.requests.get(id); if (!request) return false;
    let result;
    if (request.kind === 'approval') {
      if (!['allowed-once', 'rejected', 'cancelled'].includes(input.decision)) throw Error('授权决定无效'); result = input.decision;
    } else {
      if (input.decision === 'cancelled') result = { answers: (request.questions || []).map(q => ({ id: q.id, selected: [], custom: '用户取消了该问题，请停止等待并说明需要的信息。' })) };
      else { if (!Array.isArray(input.answers) || input.answers.length !== request.questions.length || !request.questions.every(q => input.answers.some(a => a.id === q.id && Array.isArray(a.selected) && a.selected.every(x => typeof x === 'string') && (a.custom === undefined || typeof a.custom === 'string' && a.custom.length <= 4000)))) throw Error('请回答每个问题'); result = { answers: input.answers }; }
    }
    clearTimeout(request.timer); this.requests.delete(id); request.resolve(result); this.audit({ kind: 'user-decision', id, decision: input.decision || 'answered' }); this.publish(); return true;
  }
  async prepareUpgrade(lease) {
    const id = randomUUID(), directory = path.join(lease.workspace, 'upgrades', id), candidate = path.join(directory, 'app'), baseline = [];
    await this.safeCandidate(lease.workspace, candidate);
    await fsp.mkdir(candidate, { recursive: true });
    const walk = async (from, relative = '') => {
      for (const entry of await fsp.readdir(from, { withFileTypes: true })) {
        if (OMIT.has(entry.name) || entry.name.startsWith('.env.')) continue;
        const name = path.join(relative, entry.name), target = path.join(candidate, name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) { await fsp.mkdir(target, { recursive: true }); await walk(path.join(from, entry.name), name); }
        else if (entry.isFile()) { const bytes = await fsp.readFile(path.join(from, entry.name)); await fsp.writeFile(target, bytes); baseline.push({ file: name, sha256: sha(bytes) }); }
      }
    };
    await walk(this.sourceRoot); const record = { id, sourceRoot: this.sourceRoot, directory, candidate, workspace: lease.workspace, createdAt: Date.now(), baseline };
    await fsp.mkdir(path.join(this.root, 'upgrade-records'), { recursive: true }); await fsp.writeFile(path.join(this.root, 'upgrade-records', id + '.json'), JSON.stringify(record, null, 2), { mode: 0o600 }); this.upgrades.set(id, record);
    await fsp.writeFile(path.join(directory, '给Codex的交接.md'), '# 自身升级候选\n\n候选源码：' + candidate + '\n\n请在候选副本内实现用户要求，运行测试后调用review_self_upgrade。依赖与运行数据未复制；生产程序未替换。此文件不会自动发送到任何聊天。\n');
    return { id, candidate, handoff: path.join(directory, '给Codex的交接.md'), copiedFiles: baseline.length, installed: false };
  }
  async reviewUpgrade(lease, input) {
    if (!/^[\w-]{36}$/.test(input.id || '')) throw Error('候选ID无效');
    const record = this.upgrades.get(input.id) || JSON.parse(await fsp.readFile(path.join(this.root, 'upgrade-records', input.id + '.json'), 'utf8'));
    if (path.resolve(record.workspace) !== path.resolve(lease.workspace)) throw Error('候选不属于当前工作区');
    await this.safeCandidate(lease.workspace, record.candidate);
    const before = new Map(record.baseline.map(item => [item.file, item.sha256])), changed = [], syntax = [];
    let count = 0;
    const walk = async (dir, relative = '') => { for (const entry of await fsp.readdir(dir, { withFileTypes: true })) { if (++count > 5000) throw Error('候选文件过多'); if (OMIT.has(entry.name)) continue; if (entry.isSymbolicLink()) throw Error('候选包含符号链接，未生成交付包'); const name = path.join(relative, entry.name); if (entry.isDirectory()) await walk(path.join(dir, entry.name), name); else { if ((await fsp.stat(path.join(dir, entry.name))).size > 20000000) throw Error('候选存在过大的文件'); const hash = sha(await fsp.readFile(path.join(dir, entry.name))); if (before.get(name) !== hash) { changed.push({ file: name, kind: before.has(name) ? 'modified' : 'added', sha256: hash }); if (/\.(?:cjs|mjs|js)$/.test(name)) { const check = await run(process.execPath, ['--check', path.join(dir, entry.name)], { timeout: 10000, signal: lease.abort.signal, nodeMode: true }); syntax.push({ file: name, passed: check.code === 0 }); } } before.delete(name); } } };
    await walk(record.candidate); for (const file of before.keys()) changed.push({ file, kind: 'removed' });
    const drift = []; for (const item of record.baseline) { try { if (sha(await fsp.readFile(path.join(this.sourceRoot, item.file))) !== item.sha256) drift.push(item.file); } catch { drift.push(item.file); } }
    const report = { id: record.id, at: Date.now(), candidate: record.candidate, changed, syntax, sourceChangedSinceCopy: drift, installed: false, summary: String(input.summary || '').slice(0, 8000) };
    await fsp.writeFile(path.join(record.directory, 'review.json'), JSON.stringify(report, null, 2));
    const handoff = path.join(record.directory, '给Codex的交接.md'); await fsp.writeFile(handoff, '# 自身升级候选交接\n\n' + report.summary + '\n\n候选：' + record.candidate + '\n\n实际差异与语法检查：review.json\n\n' + changed.map(item => '- ' + item.kind + ': ' + item.file).join('\n') + '\n\n语法检查通过不代表完整测试通过；具体测试请核对执行记录。运行程序尚未替换，也未自动联系其他对话。请用户在研发对话提供本文件，供Codex审阅、回归及安装。\n');
    return { ...report, handoff };
  }
  async safeCandidate(workspace, target) {
    const relative = path.relative(workspace, target); if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw Error('候选路径越界');
    let current = workspace;
    for (const part of ['', ...relative.split(path.sep)]) { if (part) current = path.join(current, part); try { const stat = await fsp.lstat(current); if (stat.isSymbolicLink() || !stat.isDirectory()) throw Error('候选路径包含链接或非目录'); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
  }
  async close() { this.questions.endWhere(() => true, 'shutdown'); for (const lease of this.leases.values()) lease.abort.abort(); this.leases.clear(); for (const id of this.requests.keys()) this.answer(id, { decision: 'cancelled' }); if (this.server) { this.server.closeAllConnections(); await new Promise(resolve => this.server.close(resolve)); this.server = null; } }
}
module.exports = { AgentService, run, redact };
