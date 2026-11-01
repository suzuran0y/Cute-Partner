'use strict';
const fs = require('node:fs'), path = require('node:path'), { spawn } = require('node:child_process');
function createController({ root = process.env.CUTE_PARTNER_HOME, platform = process.platform, run = spawn, node = process.execPath } = {}) {
  function inspect() {
    if (!root || !path.isAbsolute(root)) return { configured: false, ready: false, next: 'Set CUTE_PARTNER_HOME to your installed Cute-Partner directory before starting Harness.' };
    try {
      const metadataFile = path.join(root, 'product.json');
      if (fs.statSync(metadataFile).size > 16384) throw Error();
      const product = JSON.parse(fs.readFileSync(metadataFile, 'utf8').replace(/^\uFEFF/, ''));
      if (product.name !== 'Cute-Partner') throw Error();
      const start = path.join(root, 'apps/desktop/tools/start.cjs'), executable = path.join(root, 'apps/desktop/node_modules/electron/dist/electron.exe');
      return { configured: true, ready: platform === 'win32' && fs.existsSync(start) && fs.existsSync(executable), product: product.name, version: product.version, desktopSession: 'independent', uiVerified: false };
    } catch { return { configured: true, ready: false, next: 'Install the base application and check its product manifest; no files were modified.' }; }
  }
  async function start(signal) {
    const state = inspect(); if (!state.ready) throw Error('Cute-Partner base application is not ready. Complete the base installation first.');
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      const child = run(node, [path.join(root, 'apps/desktop/tools/start.cjs')], { cwd: root, windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'ignore', 'ignore'] });
      let settled = false;
      const finish = error => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); error ? reject(error) : resolve({ launchRequested: true, uiVerified: false, desktopSession: 'independent', next: 'Continue in the character window; model configuration and permissions are managed by the desktop application.' }); };
      const abort = () => { child.kill(); finish(Error('Launch helper cancelled; an already started desktop window may remain open.')); };
      const timer = setTimeout(() => { child.kill(); finish(Error('Launch helper timed out; check the desktop application locally.')); }, 30000);
      signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
      child.once('error', () => finish(Error('Launch helper could not start.')));
      child.once('close', code => finish(code === 0 ? null : Error('Launch helper failed.')));
    });
  }
  return { inspect, start };
}
exports.createController = createController;
exports.name = 'cute-partner-entry';
exports.inject = ['tools'];
exports.apply = function (ctx) {
  const { defineTool } = require('@deepseek-ai/dsh-tools'), controller = createController();
  const output = { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] };
  ctx.tools.register(defineTool({ name: 'cute_partner_status', description: 'Check the explicitly configured Cute-Partner base installation without reading credentials or personal runtime files. Does not start or install anything.', parameters: {}, output, execute: () => JSON.stringify(controller.inspect()) }));
  ctx.tools.register(defineTool({ name: 'cute_partner_start', description: 'Start the already installed Cute-Partner desktop application only when the user explicitly requests it. Does not install dependencies, download voice models, change permissions, or reuse this Harness conversation.', parameters: {}, output, execute: async (_args, exec) => JSON.stringify(await controller.start(exec.signal)) }));
};
