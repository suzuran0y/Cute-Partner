'use strict';
const { EventEmitter } = require('node:events'), fs = require('node:fs'), path = require('node:path'), { randomUUID } = require('node:crypto');
function string(value, max, label, empty = false) { if (typeof value !== 'string' || value.length > max || !empty && !value.trim() || /\x00/.test(value)) throw Error(label + '无效'); return value; }
function questions(input) {
  if (!Array.isArray(input) || input.length < 1 || input.length > 6) throw Error('每批应有1至6个问题');
  const ids = new Set(); return input.map(q => {
    if (!q || typeof q !== 'object') throw Error('问题无效');
    const id = string(q.id, 120, '问题ID'); if (ids.has(id)) throw Error('问题ID重复'); ids.add(id);
    if (q.multiSelect !== undefined && typeof q.multiSelect !== 'boolean') throw Error('多选类型无效');
    if (q.options !== undefined && (!Array.isArray(q.options) || q.options.length > 12)) throw Error('选项过多');
    const labels = new Set(), options = (q.options || []).map((o, index) => {
      const label = string(o?.label, 200, '选项'); if (labels.has(label)) throw Error('选项标签重复'); labels.add(label);
      return { id: String(index), label, ...(o.description === undefined ? {} : { description: string(o.description, 1000, '选项说明', true) }) };
    });
    return { id, question: string(q.question, 2000, '问题'), ...(q.header === undefined ? {} : { header: string(q.header, 120, '标题', true) }), ...(q.detail === undefined ? {} : { detail: string(q.detail, 4000, '补充说明', true) }), options, multiSelect: q.multiSelect === true };
  });
}
function answers(request, input) {
  if (!Array.isArray(input) || input.length !== request.questions.length || new Set(input.map(a => a?.id)).size !== input.length) throw Error('请完整回答每个问题，不能重复ID');
  return request.questions.map(q => {
    const a = input.find(x => x?.id === q.id); if (!a || !Array.isArray(a.selected) || a.selected.length > q.options.length || new Set(a.selected).size !== a.selected.length) throw Error('回答选项无效');
    if (a.selected.some(label => !q.options.some(o => o.label === label))) throw Error('回答包含未知选项');
    const custom = a.custom === undefined ? '' : string(a.custom, 4000, '自由回答', true).trim();
    if (!q.multiSelect && (a.selected.length > 1 || custom && a.selected.length)) throw Error('单选请在选项与其他回答中选一种');
    if (!a.selected.length && !custom) throw Error('请作答；空白不是同意，也不能跳过必需问题');
    return { id: q.id, selected: [...a.selected], ...(custom ? { custom } : {}) };
  });
}
class QuestionService extends EventEmitter {
  constructor({ root, timeoutMs = 300000 } = {}) {
    super(); this.file = path.join(root, 'question-history.json'); this.timeoutMs = timeoutMs; this.pending = new Map(); this.rows = []; this.revision = 0; this.error = '';
    try { const data = JSON.parse(fs.readFileSync(this.file, 'utf8')); if (data.version !== 1 || !Array.isArray(data.rows) || data.rows.length > 208) throw Error('version'); const ids = new Set(); for (const row of data.rows) { if (!row || typeof row.id !== 'string' || ids.has(row.id) || !['waiting', 'answered', 'cancelled', 'timed-out', 'interrupted'].includes(row.status) || ['sessionId', 'turnId', 'connectionId', 'drawerId', 'drawerName'].some(k => typeof row[k] !== 'string')) throw Error('row'); ids.add(row.id); questions(row.questions); if (row.status === 'answered') answers(row, row.answers); } this.rows = data.rows; let changed = false; for (const row of this.rows) if (row.status === 'waiting') { row.status = 'interrupted'; row.reason = 'restart'; row.endedAt = Date.now(); changed = true; } if (changed) this.save(); }
    catch (e) { if (e.code !== 'ENOENT') this.error = '问题记录损坏或无法读取，原文件保留；请检查后重试'; }
  }
  state() { return { revision: this.revision, error: this.error, requests: structuredClone(this.rows) }; }
  save() { if (this.error) throw Error(this.error); fs.mkdirSync(path.dirname(this.file), { recursive: true }); fs.writeFileSync(this.file + '.tmp', JSON.stringify({ version: 1, rows: this.rows }), { mode: 0o600 }); fs.renameSync(this.file + '.tmp', this.file); }
  publish() { this.revision++; this.emit('update', this.state()); }
  ask(lease, input, response) {
    if (this.error) throw Error(this.error); if (this.pending.size >= 8) throw Error('待回答问题过多');
    const row = { id: randomUUID(), kind: 'question', sessionId: lease.sessionId, turnId: lease.turnId, connectionId: lease.connectionId, drawerId: lease.drawerId, drawerName: lease.drawerName, questions: questions(input.questions), at: Date.now(), status: 'waiting' };
    const previous = this.rows; this.rows = this.rows.filter(r => r.status === 'waiting').concat(this.rows.filter(r => r.status !== 'waiting').slice(-199), row); try { this.save(); } catch (error) { this.rows = previous; throw error; }
    const waiting = new Promise((resolve, reject) => { this.pending.set(row.id, { row, lease, response, resolve, reject, timer: setTimeout(() => this.end(row.id, 'timed-out', 'deadline'), this.timeoutMs) }); }); this.publish(); return waiting;
  }
  owned(input) {
    const item = this.pending.get(input?.id); if (!item) throw Error('问题已结束或不属于当前运行，不能重复提交');
    if (['sessionId', 'turnId', 'connectionId'].some(k => input[k] !== item.row[k])) throw Error('问题归属已失效'); return item;
  }
  draft(input, surface = 'reader') {
    const { row } = this.owned(input), q = row.questions.find(q => q.id === input.questionId); if (!q) throw Error('问题ID无效');
    const previous = row.drafts?.[q.id], revision = previous?.revision || 0; if (input.expectedRevision !== revision) throw Error('另一窗口已更新草稿，请同步后重试');
    const value = input.value; if (!value || !Array.isArray(value.selectedIds) || new Set(value.selectedIds).size !== value.selectedIds.length || value.selectedIds.some(id => !q.options.some(o => o.id === id)) || !q.multiSelect && value.selectedIds.length > 1 || typeof value.other !== 'boolean' || typeof value.custom !== 'string' || value.custom.length > 4000 || !['controls', 'text', 'speech-choice', 'speech-text'].includes(value.method)) throw Error('问题草稿无效');
    const draft = { selectedIds: !q.multiSelect && value.other ? [] : q.options.filter(o => value.selectedIds.includes(o.id)).map(o => o.id), custom: value.custom, other: value.other, method: value.method, revision: revision + 1, surface, at: Date.now() };
    const previousDrafts = row.drafts; row.drafts = { ...row.drafts, [q.id]: draft }; try { this.save(); } catch (error) { row.drafts = previousDrafts; throw error; } this.publish(); return draft;
  }
  answer(input, { fromDraft = false, surface = 'reader' } = {}) {
    const item = this.owned(input);
    const { row } = item;
    if (['sessionId', 'turnId', 'connectionId'].some(k => input[k] !== row[k])) throw Error('问题归属已失效');
    if (input.action === 'cancel') { this.end(row.id, 'cancelled', 'user'); return true; }
    if (input.action !== 'answer') throw Error('回答操作无效');
    const result = answers(row, input.answers), previous = structuredClone(row); let submission;
    if (fromDraft) {
      const derived = row.questions.map(q => { const d = row.drafts?.[q.id]; return { id: q.id, selected: (d?.selectedIds || []).map(id => q.options.find(o => o.id === id).label), custom: q.options.length && !q.multiSelect && !d?.other ? '' : d?.custom || '' }; });
      if (JSON.stringify(answers(row, derived)) !== JSON.stringify(result)) throw Error('答案与当前控件草稿不一致，请同步后提交');
      submission = { surface, at: Date.now(), questions: row.questions.map(q => ({ id: q.id, method: row.drafts[q.id].method, selectedIds: row.drafts[q.id].selectedIds, customSupplied: !!row.drafts[q.id].custom.trim() })) };
    }
    Object.assign(row, { status: 'answered', answers: result, endedAt: Date.now(), ...(submission ? { submission } : {}) });
    try { this.save(); } catch (error) { for (const key of Object.keys(row)) delete row[key]; Object.assign(row, previous); throw error; }
    clearTimeout(item.timer); this.pending.delete(row.id); item.resolve({ answers: result }); this.publish(); return true;
  }
  receiveSpeech(input, { autoSend = false } = {}) {
    const { row } = this.owned(input), q = row.questions.find(q => q.id === input.questionId);
    if (!q || typeof input.transcript !== 'string' || !input.transcript.trim()) throw Error('没有识别到回答，请再说一次');
    this.draft({ ...input, value: require('./question-input.cjs').speechDraft(q, input.transcript) }, 'speech');
    const derived = row.questions.map(q => { const d = row.drafts?.[q.id]; return { id: q.id, selected: (d?.selectedIds || []).map(id => q.options.find(o => o.id === id).label), custom: q.options.length && !q.multiSelect && !d?.other ? '' : d?.custom || '' }; });
    const missing = derived.find(a => !a.selected.length && !a.custom.trim());
    if (autoSend && !missing) { this.answer({ ...input, action: 'answer', answers: derived }, { fromDraft: true, surface: 'speech' }); return { submitted: true }; }
    row.speechNextQuestionId = autoSend ? missing?.id : null;
    row.voiceNotice = autoSend ? '这题记好了，接着回答下一题就好。' : '语音已填入，可以修改后点“回答她”。';
    this.save(); this.publish();
    return { submitted: false, nextQuestionId: row.speechNextQuestionId, notice: row.voiceNotice };
  }
  end(id, status, reason) {
    const item = this.pending.get(id); if (!item) return;
    Object.assign(item.row, { status, reason, endedAt: Date.now() }); clearTimeout(item.timer); this.pending.delete(id);
    try { this.save(); } catch { this.error = '问题结束状态未能保存，原记录保留'; }
    const e = Error(status === 'timed-out' ? '等待答复已超时，未获得答案或授权；请停止依赖该答案的动作，等待用户重新发起' : '问题已取消或中断，未获得答案或授权；请停止依赖该答案的动作'); e.code = status === 'timed-out' ? 'HOST_QUESTION_TIMEOUT' : 'ASK_ABORTED'; item.reject(e); this.publish();
  }
  endWhere(match, reason = 'connection') { for (const [id, item] of this.pending) if (match(item)) this.end(id, 'interrupted', reason); }
}
module.exports = { QuestionService, questions, answers };
