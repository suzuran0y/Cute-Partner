'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), cp = require('node:child_process');
const root = path.resolve(__dirname, '..');
function build(output) {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw Error('Build on Windows x64.');
  const clean = cp.spawnSync('git', ['diff', '--quiet', 'HEAD', '--'], { cwd: root, windowsHide: true });
  if (clean.status !== 0) throw Error('Commit tracked source changes before building a release.');
  const version = require('../product.json').version;
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw Error('Use a stable product version.');
  const destination = path.resolve(output);
  fs.mkdirSync(destination, { recursive: true });
  const name = `Cute-Partner-${version}-win-x64.zip`, archive = path.join(destination, name);
  if (fs.existsSync(archive)) throw Error('The output archive already exists.');
  const stage = fs.mkdtempSync(path.join(destination, 'source-'));
  const files = cp.execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', windowsHide: true }).split('\0').filter(Boolean);
  for (const file of files) {
    if (/(^|\/)(?:\.runtime|node_modules|data|\.git)(\/|$)/.test(file)) throw Error('Private path in tracked sources.');
    const source = path.join(root, file), target = path.join(stage, file);
    if (!fs.lstatSync(source).isFile() || fs.lstatSync(source).isSymbolicLink()) throw Error('Unsupported source entry.');
    fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(source, target);
  }
  const moduleRoot = path.join(root, 'apps/desktop/node_modules/electron');
  const target = path.join(stage, 'apps/desktop/node_modules/electron');
  fs.mkdirSync(target, { recursive: true });
  for (const file of ['package.json', 'index.js', 'path.txt', 'LICENSE']) fs.copyFileSync(path.join(moduleRoot, file), path.join(target, file));
  fs.cpSync(path.join(moduleRoot, 'dist'), path.join(target, 'dist'), { recursive: true, dereference: true, errorOnExist: true, force: false });
  const result = cp.spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::CreateFromDirectory($env:CUTE_PARTNER_PACK_SOURCE, $env:CUTE_PARTNER_PACK_ZIP)'], {
    env: { ...process.env, CUTE_PARTNER_PACK_SOURCE: stage, CUTE_PARTNER_PACK_ZIP: archive }, windowsHide: true, encoding: 'utf8', timeout: 300000
  });
  if (result.status !== 0) throw Error('Windows ZIP creation failed.');
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
  const manifest = { version, url: `https://github.com/suzuran0y/Cute-Partner/releases/download/v${version}/${name}`, sha256, bytes: fs.statSync(archive).size, sourceCommit: cp.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim() };
  fs.writeFileSync(path.join(destination, 'release.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  return manifest;
}
if (require.main === module) { try { if (!process.argv[2]) throw Error('Provide an output directory.'); console.log(JSON.stringify(build(process.argv[2]), null, 2)); } catch (error) { console.error(error.message); process.exitCode = 1; } }
module.exports = { build };
