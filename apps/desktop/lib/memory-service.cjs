'use strict';
const fs = require('node:fs'), path = require('node:path'), { randomUUID, createHash } = require('node:crypto'), { EventEmitter } = require('node:events');
const KINDS = ['fact', 'decision', 'plan', 'todo', 'result', 'reference', 'handoff'];
function text(value, max, label, optional = false) { if (typeof value !== 'string' || value.length > max || !optional && !value.trim() || /\x00/.test(value)) throw Error(label + '无效'); return value.trim(); }
const parse = row => row ? JSON.parse(row.data) : null;
// SQLite is the single authority. Exports and summaries are never written back as facts.
class SqliteMemoryStore {
  constructor(file) {
    const { DatabaseSync } = require('node:sqlite'); this.db = new DatabaseSync(file);
    try { const v = this.db.prepare('PRAGMA user_version').get().user_version; if (v !== 0 && v !== 1) throw Error('记忆schema版本不兼容，保留原库，不自动迁移'); if (v === 1) { const tables = new Set(this.db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map(r => r.name)); if (['meta','drawers','entries','versions','operations','sources'].some(t => !tables.has(t))) throw Error('记忆schema缺表，拒绝当新库初始化'); } } catch (error) { this.db.close(); throw error; }
    this.db.exec('PRAGMA busy_timeout=3000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
    this.db.exec('BEGIN IMMEDIATE; CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS drawers(id TEXT PRIMARY KEY,data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS entries(id TEXT PRIMARY KEY,data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS versions(id INTEGER PRIMARY KEY, memoryId TEXT NOT NULL, revision INTEGER NOT NULL,data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY,data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS sources(id TEXT PRIMARY KEY,data TEXT NOT NULL); PRAGMA user_version=1; COMMIT;');
    this.db.prepare('INSERT OR IGNORE INTO meta VALUES(?,?)').run('revision', '0'); this.db.prepare('INSERT OR IGNORE INTO meta VALUES(?,?)').run('privacyEpoch', '0');
    const row = { id: 'general', name: '日常', aliases: [], type: 'life', summary: '未选择特定事务时的日常交流', directory: '', revision: 1, createdAt: Date.now(), updatedAt: Date.now() };
    this.db.prepare('INSERT OR IGNORE INTO drawers VALUES(?,?)').run(row.id, JSON.stringify(row));
    try { if (this.db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw Error('记忆数据校验失败'); for (const d of this.all('drawers')) if (!d || typeof d.id !== 'string' || typeof d.name !== 'string' || !Array.isArray(d.aliases)) throw Error('抽屉记录损坏'); for (const e of this.all('entries')) if (!e || typeof e.id !== 'string' || typeof e.content !== 'string' || !KINDS.includes(e.kind) || !['candidate','confirmed','forgotten','superseded'].includes(e.status) || !Number.isSafeInteger(e.revision)) throw Error('记忆记录损坏'); this.all('sources'); this.all('operations'); } catch (error) { this.db.close(); throw error; }
  }
  all(table) { if (!['drawers', 'entries', 'operations', 'sources'].includes(table)) throw Error('表无效'); return this.db.prepare('SELECT data FROM ' + table + ' ORDER BY rowid').all().map(parse); }
  get(table, id) { if (!['drawers', 'entries', 'sources'].includes(table)) throw Error('表无效'); return parse(this.db.prepare('SELECT data FROM ' + table + ' WHERE id=?').get(id)); }
  put(table, row) { if (!['drawers', 'entries', 'sources', 'operations'].includes(table)) throw Error('表无效'); this.db.prepare('INSERT INTO ' + table + '(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(row.id, JSON.stringify(row)); }
  meta(k) { return Number(this.db.prepare('SELECT value FROM meta WHERE key=?').get(k).value); }
  version(row) { this.db.prepare('INSERT INTO versions(memoryId,revision,data) VALUES(?,?,?)').run(row.id, row.revision, JSON.stringify(row)); }
  versions(id) { return this.db.prepare('SELECT data FROM versions WHERE memoryId=? ORDER BY revision').all(id).map(parse); }
  increment(k) { const next = this.meta(k) + 1; this.db.prepare('UPDATE meta SET value=? WHERE key=?').run(String(next), k); return next; }
  transaction(fn) { this.db.exec('BEGIN IMMEDIATE'); try { const value = fn(); this.db.exec('COMMIT'); return value; } catch (error) { this.db.exec('ROLLBACK'); throw error; } }
  close() { this.db.close(); }
}
class MemoryService extends EventEmitter {
  constructor({ root, storeFactory = file => new SqliteMemoryStore(file), legacy = '' } = {}) {
    super(); this.root = root; this.file = path.join(root, 'memory.sqlite'); this.error = ''; fs.mkdirSync(root, { recursive: true });
    const existed = fs.existsSync(this.file);
    try { this.store = storeFactory(this.file); if (legacy) this.importLegacy(legacy); if (!existed) { try { fs.appendFileSync(path.join(root, 'framework-upgrades.jsonl'), JSON.stringify({ id: randomUUID(), parentId: null, at: Date.now(), oldHost: null, newHost: require('./product.cjs').version, schemaBefore: 0, schemaAfter: 1, policyBefore: 0, policyAfter: 1, reason: '首版分层记忆数据底座；不热替换既有库', source: 'companion-settings.memory保留原配置；导入副本在sources表', legacySourceFilePresent: fs.existsSync(path.join(root, '..', 'companion-settings.json')), migration: '新建SQLite，旧文完整复制为未分类候选', rollback: '先关闭宿主并保留新库；回退前应保留代码与数据配对副本。后续schema升级需先validateCopy并成对回退代码/数据。', validation: '见README第5.3节（设定、记忆与资料接口）与隔离测试', unverified: ['未来schema迁移不能复用本次成功声明'], authorization: '用户本次资料操作授权，禁止自动安装自身升级', applied: 'new-store-only', maintenanceCost: '本地事务，无额外模型调用', nextReading: ['README.md#sec53', 'README.md#sec45'] }) + '\n', { mode: 0o600 }); } catch { this.frameworkWarning = '记忆已建立，但框架升级记录未能落盘'; } } } catch (error) { this.error = '记忆库暂不可用；原库保留，不作为空库覆盖。' + (error.message.includes('schema') ? '版本不兼容。' : '请检查数据或恢复副本。'); }
  }
  ready() { if (this.error || !this.store) throw Error(this.error || '记忆库不可用'); }
  state() { if (this.error) return { error: this.error, revision: 0, drawers: [], entries: [], operations: [] }; const s = this.store; return { error: '', schemaVersion: 1, policyVersion: 1, revision: s.meta('revision'), privacyEpoch: s.meta('privacyEpoch'), drawers: s.all('drawers'), entries: s.all('entries').filter(e => !['forgotten', 'superseded'].includes(e.status)), operations: s.all('operations').slice(-100) }; }
  mutate(action, source, fn) {
    this.ready(); if (!source || !['user', 'host', 'model-candidate', 'model-managed'].includes(source.actor) || !source.ref) throw Error('缺少宿主来源');
    let value;
    try { value = this.store.transaction(() => { const before = this.store.meta('revision'), result = fn(), after = this.store.increment('revision'); this.store.put('operations', { id: randomUUID(), at: Date.now(), action, actor: source.actor, source: structuredClone(source), before, after, affected: result?.id, entityRevision: result?.revision, result: 'success' }); return result; }); }
    catch (error) { this.lastFailure = { id: randomUUID(), at: Date.now(), action, actor: source.actor, source, before: this.store.meta('revision'), after: this.store.meta('revision'), result: 'failed', reason: error.message.slice(0, 150) }; try { this.store.transaction(() => this.store.put('operations', this.lastFailure)); } catch { /* A blocked store cannot promise a durable failure log. */ } throw error; }
    this.emit('update', this.state()); return value;
  }
  drawer(id) { this.ready(); const row = this.store.get('drawers', id); if (!row) throw Error('抽屉不存在'); return row; }
  saveDrawer(input, source) {
    const name = text(input.name, 80, '抽屉名称'), aliases = input.aliases || []; if (!Array.isArray(aliases) || aliases.length > 12 || aliases.some(a => typeof a !== 'string' || !a.trim() || a.length > 80)) throw Error('抽屉别名无效');
    return this.mutate('drawer-save', source, () => { const previous = input.id ? this.drawer(input.id) : null; if (previous && input.expectedRevision !== previous.revision) throw Error('抽屉已更新，请刷新后重试'); const row = { ...(previous || {}), id: previous?.id || randomUUID(), name, aliases: [...new Set(aliases)], type: text(input.type || 'life', 40, '事务类型'), summary: text(input.summary || '', 1000, '简介', true), directory: text(input.directory || '', 500, '目录', true), createdAt: previous?.createdAt || Date.now(), updatedAt: Date.now(), revision: (previous?.revision || 0) + 1 }; this.store.put('drawers', row); return row; });
  }
  saveEntry(input, source) {
    const content = text(input.content, 16000, '记忆'), kind = input.kind || 'fact'; if (!KINDS.includes(kind)) throw Error('记忆类型无效'); if (input.validUntil != null && (!Number.isSafeInteger(input.validUntil) || input.validUntil < 0)) throw Error('有效期无效'); const drawerId = input.drawerId || 'general'; if (drawerId !== 'global') this.drawer(drawerId);
    return this.mutate('entry-save', source, () => {
      const previous = input.id ? this.store.get('entries', input.id) : null; if (input.id && (!previous || previous.status === 'forgotten')) throw Error('记忆不存在或已忘记'); if (previous && input.expectedRevision !== previous.revision) throw Error('记忆已更新，请刷新后重试');
      if (previous && source.actor === 'model-candidate') throw Error('模型推断不能覆盖既有条目，请另存候选');
      if (!previous) { const same = this.store.all('entries').find(e => e.drawerId === drawerId && e.kind === kind && e.content === content && !['forgotten', 'superseded'].includes(e.status)); if (same) { if(input.core===true&&!same.core&&source.actor==='user') { if(drawerId!=='global') throw Error('核心记忆必须放在关于你'); if(this.store.all('entries').filter(e=>e.core&&e.status==='confirmed').length>=12) throw Error('核心记忆已较多，请先核对整理'); this.store.version(same); Object.assign(same,{core:true,coreReason:text(input.coreReason||'用户确认的重要信息',500,'核心说明'),status:'confirmed',source:structuredClone(source),sources:[...(same.sources||[]),structuredClone(source)].slice(-30),revision:same.revision+1,updatedAt:Date.now(),validUntil:input.validUntil||null}); this.store.put('entries',same); return same; } if (source.actor !== 'model-candidate' && !same.sources?.some(s => s.ref === source.ref)) { this.store.version(same); same.sources = [...(same.sources || []), source].slice(-30); same.revision++; same.updatedAt = Date.now(); this.store.put('entries', same); } return same; } }
      const status = source.actor === 'model-candidate' || input.status === 'candidate' ? 'candidate' : 'confirmed';
      if (previous) this.store.version(previous);
      const core = input.core === undefined ? previous?.core === true : input.core;
      if (typeof core !== 'boolean' || core && (drawerId !== 'global' || status !== 'confirmed')) throw Error('核心记忆必须是关于你中的已确认条目');
      if (source.actor === 'model-managed' && core !== (previous?.core === true) && !source.confirmationRequestId) throw Error('核心变更缺少宿主确认');
      if (core && !previous?.core && this.store.all('entries').filter(e => e.core && e.status === 'confirmed').length >= 12) throw Error('核心记忆已较多，请先核对整理');
      const row = { id: previous?.id || randomUUID(), drawerId, kind, content, status, core, coreReason: core ? text(input.coreReason || previous?.coreReason || '用户确认的重要信息', 500, '核心说明') : '', source: structuredClone(source), sources: [...(previous?.sources || []), structuredClone(source)].slice(-30), createdAt: previous?.createdAt || Date.now(), updatedAt: Date.now(), revision: (previous?.revision || 0) + 1, validUntil: input.validUntil || null, supersedesRevision: previous?.revision || null };
      this.store.put('entries', row); return row;
    });
  }
  forget(id, expectedRevision, source) {
    return this.mutate('entry-forget', source, () => { const row = this.store.get('entries', id); if (!row || row.status === 'forgotten' || row.revision !== expectedRevision) throw Error('记忆已变化，请刷新'); this.store.version(row); row.status = 'forgotten'; row.updatedAt = Date.now(); row.revision++; this.store.put('entries', row); for (const derived of this.store.all('entries')) if (derived.kind === 'handoff' && derived.status === 'confirmed') { this.store.version(derived); derived.status = 'superseded'; derived.invalidatedBy = id; derived.revision++; this.store.put('entries', derived); } this.store.increment('privacyEpoch'); return row; });
  }
  archiveTopic(input, source) {
    this.ready(); if ((!source?.confirmedByUser || !source.confirmationRequestId) && !(source?.actor === 'model-managed' && source.authorization === 'user-auto-memory-policy-current' && source.ref?.startsWith('message:')) || !input.archiveId) throw Error('归档缺少真实确认或自动整理授权记录');
    const name = text(input.name, 80, '事务名称'), summary = text(input.summary, 500, '事务简介', true);
    if (!Array.isArray(input.items) || !input.items.length || input.items.length > 24 || input.items.some(i => !KINDS.includes(i.kind) || typeof i.content !== 'string' || !i.content.trim() || i.content.length > 1600 || !i.source?.ref || !['candidate','confirmed'].includes(i.status))) throw Error('归档线索无效');
    return this.mutate('topic-archive', source, () => {
      const prior = this.store.all('drawers').find(d => d.archiveIds?.includes(input.archiveId)); if (prior) return prior;
      const previous = input.id ? this.drawer(input.id) : null;
      if (previous && previous.revision !== input.expectedRevision) throw Error('事务已更新，请重新核对');
      if (!previous && this.store.all('drawers').some(d => d.name === name)) throw Error('已有同名事务，请先明确关联后再加入');
      const now = Date.now(), d = { ...(previous || { id: randomUUID(), aliases: [], type: 'life', directory: '', createdAt: now }), name: previous?.name || name, summary: previous?.summary || summary, updatedAt: now, revision: (previous?.revision || 0) + 1, archiveIds: [...(previous?.archiveIds || []), input.archiveId] };
      this.store.put('drawers', d);
      for (const item of input.items) {
        if (this.store.all('entries').some(e => e.drawerId === d.id && e.content === item.content && e.kind === item.kind && !['forgotten','superseded'].includes(e.status))) continue;
        const row = { id: randomUUID(), drawerId: d.id, content: item.content, kind: item.kind, status: item.status, core: false, coreReason: '', revision: 1, createdAt: now, updatedAt: now, validUntil: null, source: { ...item.source, archiveId: input.archiveId, ...(source.confirmedByUser ? { confirmationRequestId: source.confirmationRequestId, archiveConfirmedByUser: true } : { authorization: source.authorization, archiveConfirmedByUser: false }) }, sources: [item.source, source] }; this.store.put('entries', row);
      }
      return d;
    });
  }
  history(id) { this.ready(); return this.store.versions(id); }
  undoOperation(operationId, source) {
    this.ready(); if (source?.actor !== 'user') throw Error('撤销需要小本本中的明确操作');
    const op = this.store.all('operations').find(o => o.id === operationId && o.result === 'success');
    const current = op && this.store.get('entries', op.affected);
    if (!current || !['entry-save', 'entry-forget', 'entry-restore'].includes(op.action) || !op.entityRevision || current.revision !== op.entityRevision) throw Error('此项之后已有变更或是旧记录，请查看历史后更正');
    if (op.action === 'entry-save' && current.revision === 1) return this.forget(current.id, current.revision, { ...source, undoOf: op.id });
    const previous = this.store.versions(current.id).find(v => v.revision === current.revision - 1);
    if (!previous) throw Error('没有可恢复的上一版');
    return this.mutate('entry-restore', { ...source, undoOf: op.id }, () => {
      const latest = this.store.get('entries', current.id); if (latest.revision !== current.revision) throw Error('记忆已变化，请刷新');
      this.store.version(latest); const row = { ...previous, revision: latest.revision + 1, updatedAt: Date.now(), supersedesRevision: latest.revision, source: { ...source, undoOf: op.id }, sources: [...(latest.sources || []), { ...source, undoOf: op.id }].slice(-30) };
      this.store.put('entries', row); this.store.increment('privacyEpoch'); return row;
    });
  }
  search({ drawerId = 'general', query = '', includeCandidates = false, linkedDrawers = [], limit = 30 } = {}) {
    this.ready(); if (drawerId !== 'global') this.drawer(drawerId); const scopes = new Set([drawerId, ...linkedDrawers]); if (scopes.size > 5) throw Error('关联抽屉过多'); for (const id of linkedDrawers) this.drawer(id);
    query = text(query, 500, '检索文字', true).toLocaleLowerCase(); limit = Math.max(1, Math.min(100, Number.isSafeInteger(limit) ? limit : 30));
    return this.store.all('entries').filter(e => scopes.has(e.drawerId) && (e.status === 'confirmed' || includeCandidates && e.status === 'candidate') && (!e.validUntil || e.validUntil > Date.now()) && (!query || e.content.toLocaleLowerCase().includes(query))).slice(-limit).reverse();
  }
  importLegacy(content) {
    this.ready(); if (typeof content !== 'string' || !content) return; const id = createHash('sha256').update(content).digest('hex'); if (this.store.get('sources', id)) return;
    this.mutate('legacy-import', { actor: 'host', ref: 'companion-settings.memory:' + id }, () => {
      this.store.put('sources', { id, type: 'legacy-memory', content, at: Date.now(), encoding: 'utf8' }); let drawer = this.store.all('drawers').find(d => d.type === 'legacy');
      if (!drawer) { drawer = { id: randomUUID(), name: '旧版导入／未分类', aliases: [], type: 'legacy', summary: '旧memory完整保留；未自动确认为总体事实', directory: '', createdAt: Date.now(), updatedAt: Date.now(), revision: 1 }; this.store.put('drawers', drawer); }
      const row = { id: randomUUID(), drawerId: drawer.id, kind: 'reference', content, status: 'candidate', source: { actor: 'host', ref: 'legacy:' + id }, sources: [], createdAt: Date.now(), updatedAt: Date.now(), revision: 1, validUntil: null }; this.store.put('entries', row); return row;
    });
  }
  overview(drawerId) { const rows = this.search({ drawerId, limit: 30 }); return { drawer: drawerId === 'global' ? { id: 'global', name: '总体记忆' } : this.drawer(drawerId), basedOn: rows.map(e => ({ id: e.id, revision: e.revision })), text: rows.map(e => '[' + e.kind + '] ' + e.content).join('\n') }; }
  exportMarkdown() { this.ready(); return '# 记忆导出（只读副本）\n\n' + this.store.all('entries').filter(e => !['forgotten', 'superseded'].includes(e.status)).map(e => '## ' + e.id + ' · ' + (e.drawerId === 'global' ? '总体' : this.drawer(e.drawerId).name) + ' · ' + e.status + '\n\n' + e.content + '\n\n来源：' + JSON.stringify(e.source) + '\n修订：' + e.revision).join('\n\n'); }
  close() { this.store?.close(); }
}
module.exports = { MemoryService, SqliteMemoryStore, KINDS };
