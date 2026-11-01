'use strict';
// Loaded by the installed Harness. No credentials or capability tokens enter a renderer.
const path = require('node:path');
exports.name = 'cute-partner-host';
exports.inject = ['tools', 'approval', 'userQuestions'];
exports.apply = async function(ctx) {
  const { defineTool } = require(path.join(process.env.CUTE_PARTNER_HARNESS_MODULES, '@deepseek-ai/dsh-tools'));
  const calls = new Map();
  async function host(action, value, signal) {
    const response = await fetch(process.env.CUTE_PARTNER_AGENT_URL, { method: 'POST', headers: { Authorization: 'Bearer ' + process.env.CUTE_PARTNER_AGENT_TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify({ action, ...value }), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(600000)]) : AbortSignal.timeout(600000), redirect: 'error' });
    if (!response.ok) throw Error('宿主工具连接已关闭或未授权');
    const result = await response.json(); if (!result.ok) { const e = Error(result.error || '宿主操作未完成'); e.code = result.code; throw e; } return result.value;
  }
  ctx.on('agent/pre-step', async (step, next) => { if (step.step >= 24) throw Error('本轮已达到24步上限，请汇报实际进度后等待用户继续'); await host('budget-check', { sessionId: process.env.CUTE_PARTNER_AGENT_SESSION }, step.signal); return next(); }, { global: true });
  require('./harness-stream-bridge.cjs').installStream(ctx, host);
  ctx.on('tools/execute', async (exec, next) => {
    calls.set(String(exec.callId), exec.arguments);
    try { return await next(); } finally { calls.delete(String(exec.callId)); }
  }, { global: true });
  ctx.on('approval/request', async request => host('approval', { sessionId: String(request.agent.session.id), tool: request.toolName, callId: String(request.callId || ''), reason: request.displayReason?.zh || request.reason || '该操作需要更高权限', arguments: calls.get(String(request.callId)) }, request.signal), { global: true });
  require('./harness-question-bridge.cjs').installQuestions(ctx, host);
  if (process.env.CUTE_PARTNER_MEMORY_ENABLED === '1') require('./harness-memory-bridge.cjs').installMemory(ctx, host);
  function register(name, description, parameters, action) {
    ctx.tools.register(defineTool({ name, description, parameters,
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute(args, exec) { if (!exec.agent) throw Error('需要活动会话'); return JSON.stringify(await host(action, { sessionId: String(exec.agent.session.id), ...args }, exec.signal)); }
    }));
  }
  ctx.tools.register(defineTool({ name: 'runtime_permissions', description: '查询当前会话实际生效的权限、工作区和审批通道。用户询问权限时先调用此工具，不凭旧聊天猜测。', parameters: {}, output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, execute(_args, exec) { const policy = ctx.get('sandboxPolicy')?.resolve({ session: exec.agent?.session }); return JSON.stringify({ configuredMode: process.env.CUTE_PARTNER_AGENT_MODE, effectiveSandboxMode: policy?.mode, workspaceRoot: policy?.workspaceRoot || process.env.CUTE_PARTNER_AGENT_WORKSPACE, approvalConnected: true, windowsAdministratorRequestedByApp: false }); } }));
  register('prepare_self_upgrade', '把本程序的源码复制到工作区候选目录，保留独立基线。返回候选路径；只在用户要求自身升级时调用。不要修改运行中的原程序。', {}, 'upgrade-prepare');
  register('review_self_upgrade', '核对候选文件与私有基线差异和JS语法，生成给用户及Codex审阅的本地交接文件；不会安装或通知其他聊天。', { id: { type: 'string', required: true }, summary: { type: 'string', required: true } }, 'upgrade-review');
  if (process.env.CUTE_PARTNER_AGENT_MODE === 'desktop') {
    register('desktop_windows', '读取当前可见窗口的句柄、标题和程序；只在用户要求操作电脑时使用。', {}, 'desktop-list');
    register('desktop_inspect', '读取指定窗口的可访问控件，返回runtimeId、类型、名称、可用动作。先观察再操作。', { window: { type: 'string', required: true } }, 'desktop-inspect');
    register('desktop_action', '操作刚观察到的控件。operation为focus、invoke或set_value；后两者需提供真实runtimeId。只处理用户要求的目标，不发送消息、付款或删除，除非用户明确要求。', { window: { type: 'string', required: true }, operation: { type: 'string', required: true, enum: ['focus', 'invoke', 'set_value'] }, node: { type: 'string' }, value: { type: 'string' } }, 'desktop-action');
  }
  await host('hello', { sessionId: process.env.CUTE_PARTNER_AGENT_SESSION, streamVersion: 1, tools: ctx.tools.schemas().map(tool => tool.name) });
};
