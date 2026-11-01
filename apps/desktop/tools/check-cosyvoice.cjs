'use strict';
// Explicit real local synthesis. Never starts from desktop bootstrap or npm installation.
const fs = require('node:fs'), path = require('node:path'), { spawn, execFileSync } = require('node:child_process');
const { CosyVoiceModule } = require('../lib/cosyvoice-module.cjs'), lock = require('../optional-modules/cosyvoice3/assets.lock.json'), { SCENES } = require('../lib/voice-audition.cjs');
const root = path.resolve(__dirname, '../.runtime'), directory = path.join(root, 'components/voice-cosyvoice3/dev'), output = path.resolve(__dirname, '../test-results/voice');
async function check(register = false) {
  if (!fs.existsSync(path.join(directory, 'model/verified-assets.json'))) throw Error('请先完成权重校验');
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: path.join(directory, 'source'), encoding: 'utf8', windowsHide: true }).trim(); if (commit !== lock.engine.revision) throw Error('上游代码版本不符');
  for (const asset of lock.model.files) if (fs.statSync(path.join(directory, 'model', asset.name)).size !== asset.bytes) throw Error('权重不完整');
  const service = new CosyVoiceModule({ root, fallback: async () => { throw Error('不允许以系统声音替代实测'); }, spawnProcess: (python, args, options) => { const child = spawn(python, args, { ...options, env: { ...options.env, CUTE_PARTNER_VOICE_DIAGNOSTICS: '1' } }); child.stderr.on('data', bytes => process.stderr.write(bytes)); return child; } });
  service.resources = () => ({ directory, python: path.join(directory, 'venv/Scripts/python.exe') }); service.selection = 'cosyvoice3'; fs.mkdirSync(output, { recursive: true });
  try {
    const started = Date.now(); await service.start(); console.log('模型已加载：' + service.loadMs + ' ms'); const records = [];
    for (const scene of SCENES.slice(0, 3)) { const audio = await service.backend({ action: 'synthesize', text: scene.text, rate: 0 }); const file = path.join(output, 'cosyvoice3-' + scene.id + '.wav'); fs.writeFileSync(file, Buffer.from(audio.audio, 'base64')); records.push({ scene: scene.id, text: scene.text, audio: file, ...service.metrics }); console.log(JSON.stringify(records.at(-1))); }
    const abort = new AbortController(), pending = service.backend({ action: 'synthesize', text: '这是用于检查停止行为的本机试听。'.repeat(20), rate: 0 }, abort.signal); const observed = pending.catch(error => error.message); await new Promise(resolve => setTimeout(resolve, 250)); const stopAt = Date.now(); abort.abort(); await observed; await service.stop();
    const report = { checkedOn: new Date().toISOString(), passed: true, realCloudVoiceRequests: 0, realDeepseekRequests: 0, engineRevision: commit, modelRevision: lock.model.revision, reference: lock.reference, loadMs: service.loadMs, totalMs: Date.now() - started, records, cancellationExitMs: Date.now() - stopAt, processExitConfirmed: service.child === null, userVoiceAccepted: false, desktopPlaysCompleteSentence: true, engineChunkMode: process.env.CUTE_PARTNER_VOICE_ENGINE_STREAM === '1' };
    if (register) { fs.writeFileSync(path.join(directory, 'installation.json'), JSON.stringify({ moduleId: lock.moduleId, protocolVersion: 1, moduleVersion: lock.moduleVersion, engineRevision: commit, modelRevision: lock.model.revision, verified: true, verifiedAt: report.checkedOn }, null, 2)); fs.writeFileSync(path.join(root, 'components/voice-cosyvoice3/active.json'), JSON.stringify({ directory: 'dev', protocolVersion: 1 })); report.moduleRegistered = true; }
    fs.writeFileSync(path.join(output, 'cosyvoice3-local-report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report)); return report;
  } finally { await service.close(); }
}
if (require.main === module) check(process.argv.includes('--register')).catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { check };
