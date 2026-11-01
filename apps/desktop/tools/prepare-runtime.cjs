'use strict';
// A normal temporary cache avoids managed-workspace ACL incompatibility with Chromium's sandbox.
// No ACLs are changed and the renderer sandbox stays enabled.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const source = path.join(root, 'node_modules/electron/dist');
const version = require('../node_modules/electron/package.json').version;
const fingerprint = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function prepare() {
  const binary = path.join(source, 'electron.exe');
  if (!fs.existsSync(binary)) throw Error('Electron 运行库未安装，请先执行本目录依赖安装和 install-electron。');
  const sha256 = fingerprint(binary), record = path.join(root, '.runtime/native-path.json');
  try {
    const cached = JSON.parse(fs.readFileSync(record, 'utf8'));
    const directory = path.dirname(cached.executable);
    if (path.dirname(directory).toLowerCase() === path.resolve(os.tmpdir()).toLowerCase() && path.basename(directory).startsWith(`desktop-pet-electron-${version}-`) && cached.sha256 === sha256 && fs.existsSync(cached.executable) && fingerprint(cached.executable) === sha256) return cached.executable;
  } catch { /* Prepare a fresh cache without deleting any previous files. */ }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `desktop-pet-electron-${version}-`));
  for (const entry of fs.readdirSync(source)) {
    fs.cpSync(path.join(source, entry), path.join(directory, entry), { recursive: true, force: false, errorOnExist: true });
  }
  const executable = path.join(directory, 'electron.exe');
  if (fingerprint(executable) !== sha256) throw Error('运行库复制核验失败');
  fs.mkdirSync(path.dirname(record), { recursive: true });
  fs.writeFileSync(record, JSON.stringify({ executable, version, sha256 }, null, 2));
  return executable;
}
if (require.main === module) console.log(prepare());
module.exports = { prepare };
