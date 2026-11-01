'use strict';
exports.installStream = function(ctx, host) {
  let queue = Promise.resolve();
  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    if (String(agent.session.id) !== process.env.CUTE_PARTNER_AGENT_SESSION) return;
    const value = { type: frame.type, attemptId: frame.attemptId, revision: frame.revision };
    if (frame.type === 'start') Object.assign(value, { turn: frame.turn, step: frame.step });
    else if (frame.type === 'chunk') {
      const chunk = frame.chunk;
      if (chunk.type === 'text-delta') Object.assign(value, { index: frame.index, block: chunk.index, text: chunk.text });
      else if (chunk.type === 'block-end' && chunk.block.type === 'text' && chunk.block.text.length <= 32000) Object.assign(value, { index: frame.index, block: chunk.index, text: chunk.block.text, replace: true });
      else return;
    } else if (frame.type === 'end') value.outcome = frame.outcome;
    else return;
    queue = queue.then(() => host('assistant-stream', { sessionId: process.env.CUTE_PARTNER_AGENT_SESSION, frame: value })).catch(() => {});
  }, { global: true });
};
