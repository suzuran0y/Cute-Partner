'use strict';
// Offline prerequisite inspection. Never reads credential bodies, launches Harness, or calls an API.
const fs = require('node:fs');
const path = require('node:path');
const { installation } = require('../apps/desktop/lib/harness-provider.cjs');
const exists = file => { try { return fs.statSync(file).isFile(); } catch { return false; } };
function inspect({ root = path.resolve(__dirname, '..'), platform = process.platform, nodeVersion = process.versions.node, found = installation() } = {}) {
  const checks = [], add = (id, ok, next) => checks.push({ id, status: ok ? 'present' : 'missing', next: ok ? null : next });
  add('windows', platform === 'win32', 'Use Windows x64; other platforms have not been verified.');
  add('node24', Number(nodeVersion.split('.')[0]) >= 24, 'Install Node.js 24 or later compatible with the project lockfile.');
  add('electron', exists(path.join(root, 'apps/desktop/node_modules/electron/dist/electron.exe')), 'Follow README section 3.3.1 (environment setup) to install the locked desktop dependencies and Electron.');
  add('harnessFiles', found.installed === true, 'Install the compatible Windows DeepSeek Harness desktop build; check CUTE_PARTNER_HARNESS_DIR if its location is custom.');
  add('savedCredentialFile', found.credentialAvailable === true, 'Save your own DeepSeek API key in Harness Settings > Models; do not send it in chat.');
  const runtime = path.join(root, 'characters/default'), modelRoot = path.join(runtime, 'model');
  let modelReady = false;
  try {
    const entry = JSON.parse(fs.readFileSync(path.join(modelRoot, 'character.model3.json'), 'utf8'));
    const refs = entry.FileReferences;
    const files = [refs.Moc, ...refs.Textures, refs.DisplayInfo, ...(refs.Expressions || []).map(v => v.File), ...Object.values(refs.Motions || {}).flat().map(v => v.File)].filter(Boolean);
    modelReady = files.length > 0 && files.every(relative => {
      if (typeof relative !== 'string') return false;
      const target = path.resolve(modelRoot, relative);
      if (!target.startsWith(modelRoot + path.sep) || !exists(target)) return false;
      return fs.realpathSync(target).startsWith(fs.realpathSync(modelRoot) + path.sep);
    });
  } catch { /* Missing/invalid resources are reported without exposing file content. */ }
  add('modelReferences', modelReady, 'Restore the bundled default character files from this source version; see README section 3.3.1.');
  add('cubismCore', exists(path.join(runtime, 'web/sdk/live2dcubismcore.min.js')), 'Restore the bundled Cubism Core file from this source version; retain its proprietary license.');
  add('icons', ['png', 'ico'].every(ext => exists(path.join(root, 'apps/desktop/assets/character-icon.' + ext))), 'Restore the bundled character icons; see README section 3.3.1.');
  add('staticFallback', exists(path.join(root, 'characters/default/preview.png')), 'Restore the bundled static fallback image; see README section 3.3.1.');
  return {
    schemaVersion: 1, mode: 'offline', networkRequests: 0, credentialBodiesRead: false,
    prerequisitesPresent: checks.every(check => check.status === 'present'), checks,
    notVerified: ['Saved credential validity and balance', 'Harness private SDK version/handshake', 'Network/proxy connectivity', 'Actual model reply', 'Desktop launch and audio playback'],
    next: 'See README section 3.3.2 (startup checks). After the offline checks, send a short greeting to verify the model connection.'
  };
}
if (require.main === module) {
  const report = inspect();
  if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
  else {
    console.log('cute-partner offline setup check (no network, no credential-body reads)');
    for (const check of report.checks) console.log(`[${check.status}] ${check.id}${check.next ? ': ' + check.next : ''}`);
    console.log(report.next);
  }
  if (!report.prerequisitesPresent) process.exitCode = 1;
}
module.exports = { inspect };
