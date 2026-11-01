'use strict';
exports.name = 'cute-partner-chat-stream';
exports.inject = ['tools', 'userQuestions'];
exports.apply = async function(ctx) {
  async function host(action, value, signal) {
    const response = await fetch(process.env.CUTE_PARTNER_AGENT_URL, { method: 'POST', headers: { Authorization: 'Bearer ' + process.env.CUTE_PARTNER_AGENT_TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify({ action, ...value }), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(600000)]) : AbortSignal.timeout(600000), redirect: 'error' });
    const result = await response.json(); if (!response.ok || !result.ok) { const e = Error(result.error || '正文桥接连接已关闭'); e.code = result.code; throw e; } return result.value;
  }
  require('./harness-stream-bridge.cjs').installStream(ctx, host);
  require('./harness-question-bridge.cjs').installQuestions(ctx, host);
  if (process.env.CUTE_PARTNER_MEMORY_ENABLED === '1') require('./harness-memory-bridge.cjs').installMemory(ctx, host);
  ctx.on('agent/pre-step', async (step, next) => { if (step.step >= 24) throw Error('本轮步数已达上限'); await host('budget-check', { sessionId: process.env.CUTE_PARTNER_AGENT_SESSION }); return next(); }, { global: true });
  await host('hello', { sessionId: process.env.CUTE_PARTNER_AGENT_SESSION, streamVersion: 1, tools: ctx.tools.schemas().map(tool => tool.name) });
};
