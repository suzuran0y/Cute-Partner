(function(root) {
  'use strict';
  const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);
  const LABELS = { planning: '正在准备', executing: '正在执行', verifying: '正在核验', waiting: '等待中', awaiting_input: '等待补充', cancel_requested: '正在停止', succeeded: '已完成', failed: '执行失败', cancelled: '已取消' };
  function describe(update, active = false) {
    const event = update?.snapshot, connected = !!update?.connected;
    if (!event) return { state: 'idle', confirmed: false, label: connected ? '自然动态' : '正在连接任务控制器', reason: '' };
    if (!connected && !TERMINAL.has(event.task_state)) return { state: 'waiting', confirmed: false, label: '任务状态未知', reason: '任务连接中断，等待实际快照；后台可能仍在执行' };
    const live = connected && active && !update.restored;
    const state = { planning: 'thinking', executing: 'working', verifying: 'working', waiting: 'waiting', awaiting_input: 'waiting', cancel_requested: 'waiting', failed: 'error', succeeded: live ? 'success' : 'idle', cancelled: live ? 'cancelled' : 'idle' }[event.task_state] || 'idle';
    return { state, confirmed: state === 'success' || state === 'cancelled', label: LABELS[event.task_state] || '自然动态', reason: event.task_state === 'cancel_requested' ? '正在停止，等待执行器确认' : String(event.message || '').slice(0, 160) };
  }
  class TaskPresentation {
    constructor() { this.revision = -1; this.update = null; this.feedbacks = 0; this.last = describe(null); }
    accept(update, active) {
      if (!update || !Number.isSafeInteger(update.revision) || update.revision <= this.revision) return null;
      this.revision = update.revision; this.update = update; this.last = describe(update, active);
      if (this.last.state === 'success') this.feedbacks++;
      return this.last;
    }
    restore() { this.last = describe({ ...this.update, restored: true }, false); return this.last; }
  }
  const api = { TaskPresentation, describe, LABELS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.AvatarTaskPresentation = api;
})(globalThis);
