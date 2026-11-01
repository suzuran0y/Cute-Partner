'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { installation } = require('../lib/harness-provider.cjs');
const root = path.resolve(__dirname, '../.runtime/speech/assets');
function bundledManifest(executable) {
  const fd = fs.openSync(path.join(path.dirname(executable), 'resources/app.asar'), 'r');
  try {
    const head = Buffer.alloc(16); fs.readSync(fd, head, 0, 16, 0); const bytes = head.readUInt32LE(12); if (bytes > 64000000) throw Error('Harness archive header too large');
    const data = Buffer.alloc(bytes); fs.readSync(fd, data, 0, bytes, 16); let node = JSON.parse(data);
    for (const key of 'dsh/node_modules/@deepseek-ai/dsh-experimental-speech-to-text-sensevoice/runtime/assets.json'.split('/')) node = node.files[key];
    const text = Buffer.alloc(node.size); fs.readSync(fd, text, 0, text.length, 8 + head.readUInt32LE(4) + Number(node.offset)); return JSON.parse(text);
  } finally { fs.closeSync(fd); }
}
async function matches(file, asset) {
  try { if (fs.statSync(file).size !== asset.bytes) return false; const hash = crypto.createHash('sha256'); for await (const chunk of fs.createReadStream(file)) hash.update(chunk); return hash.digest('hex') === asset.sha256; } catch { return false; }
}
async function obtain(asset, candidates = []) {
  for (const file of [...candidates, path.join(root, asset.name)]) if (await matches(file, asset)) { console.log('已核验 ' + asset.name); return file; }
  const target = path.join(root, asset.name), partial = target + '.part';
  for (const origin of ['https://huggingface.co', 'https://hf-mirror.com']) {
    try {
      console.log('准备下载 ' + asset.name + '（' + Math.round(asset.bytes / 1024) + ' KB）');
      const url = new URL(asset.url); url.host = new URL(origin).host;
      const response = await fetch(url, { signal: AbortSignal.timeout(300000) }); if (!response.ok || !response.body) throw Error('下载响应失败');
      const fd = fs.openSync(partial, 'w'); let size = 0; const hash = crypto.createHash('sha256');
      try { for await (const chunk of response.body) { size += chunk.length; if (size > asset.bytes) throw Error('下载大小不符'); hash.update(chunk); fs.writeSync(fd, chunk); } } finally { fs.closeSync(fd); }
      if (size !== asset.bytes || hash.digest('hex') !== asset.sha256) throw Error('资源指纹不符');
      fs.renameSync(partial, target); console.log('已下载并核验 ' + asset.name); return target;
    } catch { console.log('此来源暂不可用：' + origin); }
  }
  throw Error('语音资源未准备完成，请稍后重试');
}
async function prepare() {
  const found = installation(); if (!found.installed) throw Error('未找到 Harness'); fs.mkdirSync(root, { recursive: true });
  const lock = bundledManifest(found.executable), cached = path.join(os.homedir(), '.dsh/speech-to-text/sensevoice/models');
  const model = await obtain(lock.models.int8, [path.join(cached, 'sensevoice-onnx', lock.models.int8.name)]);
  const tokens = await obtain(lock.tokens, [path.join(cached, 'sensevoice-onnx', lock.tokens.name)]);
  const vad = await obtain(lock.vad, [path.join(cached, 'silero', lock.vad.name)]);
  fs.writeFileSync(path.join(root, 'asset-paths.json'), JSON.stringify({ model, tokens, vad, preparedAt: Date.now(), hashes: { model: lock.models.int8.sha256, tokens: lock.tokens.sha256, vad: lock.vad.sha256 } }, null, 2));
  console.log('本地 SenseVoice 已就绪，麦克风录音不会上传。');
}
if (require.main === module) prepare().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { prepare, bundledManifest, matches };
