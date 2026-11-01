'use strict';
// Explicit opt-in preparation only. Never imported by desktop startup.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const lock = require('../optional-modules/cosyvoice3/assets.lock.json');
async function digest(file) { const hash = crypto.createHash('sha256'); for await (const bytes of fs.createReadStream(file)) hash.update(bytes); return hash.digest('hex'); }
async function obtain(asset, root) {
  const target = path.resolve(root, asset.name); if (!target.startsWith(root + path.sep) || !Number.isSafeInteger(asset.bytes) || !/^[a-f0-9]{64}$/.test(asset.sha256)) throw Error('资源清单无效');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (fs.existsSync(target) && fs.statSync(target).size === asset.bytes && await digest(target) === asset.sha256) { console.log('已核验 ' + asset.name); return; }
  const partial = target + '.part', name = asset.name.split('/').map(encodeURIComponent).join('/');
  const sources = [
    `https://modelscope.cn/models/${lock.model.repository}/resolve/master/${name}`,
    `https://hf-mirror.com/${lock.model.repository}/resolve/${lock.model.revision}/${name}`
  ];
  let lastError;
  for (const url of sources) {
    try {
      let size = fs.existsSync(partial) ? fs.statSync(partial).size : 0; if (size >= asset.bytes) size = 0;
      const response = await fetch(url, { headers: size ? { Range: `bytes=${size}-` } : {}, signal: AbortSignal.timeout(1800000) });
      if (![200, 206].includes(response.status) || !response.body) throw Error('下载响应失败 ' + response.status);
      if (response.status === 206 && !response.headers.get('content-range')?.startsWith(`bytes ${size}-`)) throw Error('下载断点不符');
      if (response.status === 200) size = 0;
      const fd = fs.openSync(partial, size ? 'a' : 'w'); let reportedAt = 0;
      try { for await (const bytes of response.body) { size += bytes.length; if (size > asset.bytes) throw Error('下载长度超过清单'); fs.writeSync(fd, bytes); if (Date.now() - reportedAt > 15000) { reportedAt = Date.now(); console.log(`${asset.name}: ${Math.round(size / asset.bytes * 100)}%`); } } } finally { fs.closeSync(fd); }
      if (size !== asset.bytes || await digest(partial) !== asset.sha256) throw Error('下载长度或SHA-256不符');
      fs.renameSync(partial, target); console.log('已下载并核验 ' + asset.name); return;
    } catch (error) { lastError = error; console.log(asset.name + '：此来源未完成，保留断点'); }
  }
  throw Error(asset.name + ' 未准备完成：' + lastError.message);
}
async function prepare(root) {
  root = path.resolve(root); fs.mkdirSync(root, { recursive: true });
  const queue = [...lock.model.files]; await Promise.all([0, 1].map(async () => { while (queue.length) await obtain(queue.shift(), root); }));
  fs.writeFileSync(path.join(root, 'verified-assets.json'), JSON.stringify({ repository: lock.model.repository, revision: lock.model.revision, verifiedAt: new Date().toISOString(), files: lock.model.files }, null, 2));
  console.log('CosyVoice3权重已核验；这不表示Python环境或声音已就绪。');
}
if (require.main === module) prepare(process.argv[2] || path.join(__dirname, '../.runtime/components/voice-cosyvoice3/dev/model')).catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { prepare, obtain, digest };
