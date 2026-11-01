'use strict';
// Reuse the installed SDK's legacy tool and service; never turn a cancellation into an answer.
exports.installQuestions = function(ctx, host) {
  const path = require('node:path');
  require(path.join(process.env.CUTE_PARTNER_HARNESS_MODULES, '@deepseek-ai/dsh-tool-ask-user')).apply(ctx, { mode: 'legacy' });
  const { UserQuestionError } = require(path.join(process.env.CUTE_PARTNER_HARNESS_MODULES, '@deepseek-ai/dsh-user-questions'));
  ctx.on('user-questions/request', async request => {
    try { return await host('question', { sessionId: String(request.agent.session.id), questions: request.questions }, request.signal); }
    catch (error) { throw new UserQuestionError(error.message, error.code || 'ASK_ABORTED'); }
  }, { global: true });
};
