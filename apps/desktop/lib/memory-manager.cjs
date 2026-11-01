'use strict';
// Consent and evidence are bound by the host, never supplied by model arguments.
async function manageMemory(memory, questions, lease, input, response) {
  const scopes = new Set(['global', 'general', lease.drawerId, ...lease.linkedDrawers, ...(lease.createdDrawers || []), ...(lease.discoveredDrawers || [])]);
  const find = id => { const row = memory.state().entries.find(e => e.id === id); if (!row || !scopes.has(row.drawerId)) throw Error('当前记忆范围内没有这条记录'); return row; };
  const source = { actor: 'model-managed', ref: 'message:' + lease.memorySource.messageId, sessionId: lease.sessionId, generationId: lease.turnId, at: Date.now(), verifiedByTool: false };
  const op = input.operation, previous = op === 'remember' ? null : find(input.id);
  if (op === 'history') { let size = 0; return memory.history(previous.id).filter(v => scopes.has(v.drawerId)).slice(-8).reverse().flatMap(v => { const item = { revision: v.revision, content: v.content, status: v.status, drawerId: v.drawerId }; const n = require('./memory-context.cjs').estimate(JSON.stringify(item)); if (size + n > 1800) return []; size += n; return [item]; }); }
  if (!['remember', 'update', 'move', 'forget', 'confirm', 'core'].includes(op)) throw Error('记忆管理操作无效');
  if ((lease.memoryWrites || 0) >= 12) throw Error('本轮记忆整理已达上限，先结束本轮');
  if (previous && input.expectedRevision !== previous.revision) throw Error('记忆已更新，请重新查询后再整理');
  const drawerId = op === 'core' && input.core !== false ? 'global' : input.drawerId || previous?.drawerId || lease.drawerId;
  if (!scopes.has(drawerId)) throw Error('不能整理未关联的事务');
  const content = ['forget', 'move', 'confirm', 'core'].includes(op) ? previous.content : input.content;
  if (typeof content !== 'string' || !content.trim() || content.length > 1600 || /\x00/.test(content)) throw Error('自动整理请使用1至1600字的独立记忆；较长原文请在小本本中处理');
  const kind = input.kind || previous?.kind || 'fact';
  if (!['fact', 'decision', 'plan', 'todo', 'reference', 'result'].includes(kind)) throw Error('自动整理的记忆类型无效');
  const exactUserExcerpt = typeof lease.memorySource.text === 'string' && lease.memorySource.text.includes(content.trim());
  if (op === 'remember' && exactUserExcerpt && ['fact', 'decision'].includes(kind)) {
    const subject = /^(.*?(?:是|为|喜欢|叫|住在|偏好|预算|下限))/.exec(content.trim())?.[1];
    const collision = subject?.length >= 2 && memory.state().entries.some(e => scopes.has(e.drawerId) && e.status === 'confirmed' && e.content !== content.trim() && e.content.startsWith(subject));
    if (collision) throw Error('可能与已有事实冲突，请先memory_search核对，再用update请求更正；不要新增相互矛盾的事实');
  }
  let status = previous?.status || (exactUserExcerpt ? 'confirmed' : 'candidate');
  const changed = previous && (content.trim() !== previous.content || kind !== previous.kind || drawerId !== previous.drawerId);
  if (previous && !['forget', 'confirm', 'core'].includes(op) && !changed) return { id: previous.id, revision: previous.revision, status: previous.status, changed: false };
  const contentChanged = previous && (content.trim() !== previous.content || kind !== previous.kind);
  const protectedChange = contentChanged && (previous.drawerId === 'global' || drawerId === 'global' || previous.status === 'confirmed' && (['fact', 'decision'].includes(previous.kind) || ['fact', 'decision'].includes(kind) || /偏好|喜欢|讨厌|过敏|称呼|名字|习惯|不许|不要/.test(previous.content + content)));
  const needsConfirmation = ['forget', 'confirm', 'core'].includes(op) || input.conflict === true || protectedChange || previous?.core;
  if (needsConfirmation) {
    if (previous?.content.length > 1600) throw Error('原条目较长，请在小本本中核对完整内容后修改');
    if ((lease.memoryQuestions || 0) >= 4) throw Error('本轮记忆确认已达上限，请先结束本轮');
    lease.memoryQuestions = (lease.memoryQuestions || 0) + 1;
    const detail = (previous ? '原记忆：\n' + previous.content + '\n\n' : '') + (op === 'forget' ? '将不再用于之后的回答，历史修订仍保留，可在小本本撤销。' : '整理后：\n' + content + '\n归属：' + (drawerId === 'global' ? '关于你' : memory.drawer(drawerId).name)) + (op === 'core' ? input.core === false ? '\n降为普通总体记忆，不再优先加载。' : '\n设为核心：以后优先提供，但仍受上下文预算限制。' : '');
    const waiting = questions.ask(lease, { questions: [{ id: 'memory-change', question: op === 'forget' ? '这条记忆，要让我忘记吗？' : '这条记忆这样整理，可以吗？', detail, options: [{ label: '确认这次整理' }, { label: '保留原样' }] }] }, response);
    const requestId = questions.state().requests.findLast(r => r.connectionId === lease.connectionId && r.turnId === lease.turnId && r.status === 'waiting')?.id;
    const answer = await waiting; lease.abort.signal.throwIfAborted();
    if (answer.answers[0]?.selected.length !== 1 || answer.answers[0].selected[0] !== '确认这次整理' || answer.answers[0].custom) return { changed: false, decision: 'not-approved', answers: answer.answers, message: '未确认，不修改；自填意见留给本轮继续讨论' };
    if (!requestId) throw Error('缺少宿主确认记录');
    source.confirmationRequestId = requestId; source.confirmedByUser = true;
    if (['remember', 'confirm', 'core'].includes(op)) status = 'confirmed';
  }
  if (lease.memoryEpoch !== undefined && lease.memoryEpoch !== memory.state().privacyEpoch) throw Error('记忆遗忘范围已变化，请结束旧会话后重试');
  lease.abort.signal.throwIfAborted();
  if ((lease.memoryWrites || 0) >= 12) throw Error('本轮记忆整理已达上限，先结束本轮');
  const row = op === 'forget' ? memory.forget(previous.id, previous.revision, source) : memory.saveEntry({ ...(previous ? { id: previous.id, expectedRevision: previous.revision } : {}), drawerId, content, kind, status, ...(op === 'core' ? { core: input.core !== false, coreReason: '用户在白云确认；来源 ' + source.ref } : {}), validUntil: previous?.validUntil || null }, source);
  lease.memoryWrites = (lease.memoryWrites || 0) + 1;
  return { id: row.id, revision: row.revision, status: row.status, drawerId: row.drawerId, changed: true, confirmation: needsConfirmation, message: row.status === 'candidate' ? '已存为待核对想法，不自动当作事实召回' : '已整理并保留变更记录，可在小本本撤销' };
}
module.exports = { manageMemory };
