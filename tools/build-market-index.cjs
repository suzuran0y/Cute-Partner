'use strict';
const fs = require('node:fs'), path = require('node:path');
function build({ repository, commit, author, timestamp, version = require('../product.json').version }) {
  const url = new URL(repository);
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || !/^\/[^/]+\/[^/]+$/.test(url.pathname) || url.username || url.password || url.search || url.hash) throw Error('Provide the actual HTTPS GitHub repository URL, without credentials, query, or fragment.');
  if (!/^[a-f0-9]{40}$/.test(commit)) throw Error('Provide an existing fixed 40-character commit SHA.');
  if (typeof author !== 'string' || !author.trim() || /[<>\r\n]/.test(author)) throw Error('Provide the real display author.');
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0 || timestamp >= 1e11) throw Error('Provide the Git commit committer timestamp in Unix seconds.');
  if (!/^1\.\d+\.\d+(?:-(?:rc|dev)\.[1-9]\d*)?$/.test(version)) throw Error('Version must match the product release line.');
  const bundle = require('../integrations/harness/package.json');
  if (version !== bundle.version) throw Error('Product and bundle versions differ.');
  const en = require('../integrations/harness/locale/en.json').meta;
  const zh = require('../integrations/harness/locale/zh.json').meta;
  // Installation selects the bundle directory; detail fallback selects the root README.
  return {
    format: 1,
    title: { en: 'Cute-Partner', zh: '可爱的助手' },
    plugins: [{
      name: bundle.name,
      title: { en: en.title, zh: zh.title },
      description: { en: en.description, zh: zh.description },
      icon: 'https://raw.githubusercontent.com' + url.pathname + '/' + commit + '/apps/desktop/assets/character-icon.png',
      author: author.trim(),
      homepage: repository,
      repository: { url: repository },
      metadata: { keywords: bundle.keywords },
      versions: [{ version, publishTimestamp: timestamp, source: { type: 'git', url: repository, commit, path: 'integrations/harness' }, engines: { dsh: bundle.engines.dsh } }],
    }],
  };
}
if (require.main === module) {
  try {
    const args = Object.fromEntries(process.argv.slice(2).map(a => { const at = a.indexOf('='); if (!a.startsWith('--') || at < 3) throw Error('Use --repository= --commit= --author= --timestamp= --output= with actual values.'); return [a.slice(2,at),a.slice(at+1)]; }));
    const result = build({ ...args, timestamp: Number(args.timestamp) });
    if (!args.output) throw Error('Provide an explicit output path.');
    const target = path.resolve(args.output); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, JSON.stringify(result,null,2)+'\n', { flag: 'wx' });
    console.log('Market index generated from supplied publication metadata. This does not upload or prove remote availability.');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { build };
