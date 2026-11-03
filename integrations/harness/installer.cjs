'use strict';
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), { spawn } = require('node:child_process');
function createInstaller({ home = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData/Local'), 'CutePartner'), platform = process.platform, run = spawn, release = require('./release.json') } = {}) {
  if (!/^\d+\.\d+\.\d+$/.test(release.version) || !/^[a-f0-9]{64}$/.test(release.sha256) || !Number.isSafeInteger(release.bytes) || release.bytes < 1 || release.bytes > 1073741824 || release.url !== `https://github.com/suzuran0y/Cute-Partner/releases/download/v${release.version}/Cute-Partner-${release.version}-win-x64.zip`) throw Error('Invalid desktop release manifest.');
  const root = path.join(home, `app-${release.version}-${release.sha256.slice(0, 12)}`), record = path.join(home, 'installation.json');
  const plan = () => ({ version: release.version, destination: root, downloadBytes: release.bytes, voiceIncluded: false, confirmationRequired: true });
  function installed() {
    try { const saved = JSON.parse(fs.readFileSync(record, 'utf8')); return saved.sha256 === release.sha256 && saved.root === root && fs.existsSync(path.join(root, 'apps/desktop/launch.ps1')) && fs.existsSync(path.join(root, 'apps/desktop/node_modules/electron/dist/electron.exe')) ? root : null; } catch { return null; }
  }
  let pending;
  function install({ confirm = false, signal } = {}) {
    if (!confirm) return Promise.resolve({ installed: false, ...plan() });
    if (platform !== 'win32') return Promise.reject(Error('Windows x64 is required.'));
    signal?.throwIfAborted();
    if (installed()) return Promise.resolve({ installed: true, root, alreadyInstalled: true });
    if (pending) return Promise.reject(Error('An installation is already running.'));
    if (fs.existsSync(root)) return Promise.reject(Error('An unregistered installation exists; preserve it and inspect before retrying.'));
    pending = new Promise((resolve, reject) => {
      const child = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', path.join(__dirname, 'install-windows.ps1')], { windowsHide: true, env: { ...process.env, CUTE_PARTNER_INSTALL_RELEASE: JSON.stringify(release), CUTE_PARTNER_INSTALL_TARGET: root }, stdio: ['ignore', 'ignore', 'ignore'] });
      let settled = false;
      const finish = error => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); if (error) return reject(error); try {
        const product = JSON.parse(fs.readFileSync(path.join(root, 'product.json'), 'utf8'));
        if (product.name !== 'Cute-Partner' || product.version !== release.version || !fs.existsSync(path.join(root, 'apps/desktop/node_modules/electron/dist/electron.exe'))) throw Error('Incomplete installation.');
        fs.mkdirSync(home, { recursive: true }); fs.writeFileSync(record + '.tmp', JSON.stringify({ root, version: release.version, sha256: release.sha256 }, null, 2)); fs.renameSync(record + '.tmp', record);
        resolve({ installed: true, root, voiceIncluded: false, next: 'Use cute_partner_start to launch the character.' });
      } catch (error) { reject(error); } };
      const stop = () => { if (!Number.isInteger(child.pid)) { child.kill(); return; } try { const killer = run('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); killer.on('error', () => child.kill()); } catch { child.kill(); } };
      const abort = () => { stop(); finish(Error('Installation cancelled; existing installations and personal data were preserved.')); };
      const timer = setTimeout(() => { stop(); finish(Error('Installation timed out.')); }, 900000);
      signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
      child.once('error', () => finish(Error('Unable to run the Windows installer.')));
      child.once('close', code => finish(code === 0 ? null : Error('Desktop installation failed; check the download connection and installation directory.')));
    }).finally(() => { pending = null; });
    return pending;
  }
  return { plan, installed, install };
}
module.exports = { createInstaller };
