'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname,'..');
const listing = spawnSync('git',['ls-files','--cached','--others','--exclude-standard','-z'],{cwd:root,encoding:'utf8',windowsHide:true});
if(listing.status!==0)throw Error('Initialize the source root as its own Git repository.');
const candidates=[...new Set(listing.stdout.split('\0').filter(Boolean))].sort(),problems=[],files=[];
const manifest=require('./release-resources.json'),approved=new Map(manifest.files.map(f=>[f.path,f]));
const forbiddenPart=/(^|\/)(?:\.runtime|data|test-results|node_modules|\.venv|venv|__pycache__|\.pytest_cache|archives)(\/|$)/;
const forbiddenFile=/(?:\.(?:cpbackup|sqlite(?:-wal|-shm)?|db|lnk|mp3|wav|flac|pt|pth|onnx|safetensors|psd|cmo3|moc3)$|(?:^|\/)\.credentials\.yaml$|(?:^|\/)\.env(?:\.|$)|live2dcubismcore)/i;
const textExt=/\.(?:md|txt|json|ya?ml|cjs|mjs|js|html|css|ps1|py|cmd|cs|vert|frag|svg)$|(?:^|\/)(?:LICENSE|NOTICE|\.gitignore)$/i;
const previousName=new RegExp(['o[h]?','jingjing'].join('\\s*'),'i');
const normalizePaths=value=>value.replace(/\\+/g,'/').toLowerCase();
const localPaths=[root,path.dirname(root)].filter(value=>value.split(path.sep).filter(Boolean).length>=3).map(normalizePaths);
const personalHome=/(?:\b[A-Z]:\/Users\/|\/(?:Users|home)\/)(?!Public(?:\/|$)|Default(?:\/|$))[^\s"'<>/]+/i;
for(const rel of candidates){const file=path.join(root,rel);if(!fs.existsSync(file)){problems.push({file:rel,kind:'missing-file'});continue;}const st=fs.lstatSync(file);if(!st.isFile()||st.isSymbolicLink()){problems.push({file:rel,kind:'unsupported-file'});continue;}
 const allow=approved.get(rel);if(forbiddenPart.test(rel)||!allow&&forbiddenFile.test(rel)||!allow&&(rel.startsWith('characters/default/model/')||rel==='characters/default/preview.png'||/apps\/desktop\/assets\/character-icon\.(?:png|ico)/.test(rel))){problems.push({file:rel,kind:'private-or-unapproved-resource'});continue;}
 const bytes=fs.readFileSync(file),sha256=crypto.createHash('sha256').update(bytes).digest('hex');files.push({path:rel,bytes:st.size,sha256});if(allow&&(allow.sha256!==sha256||allow.bytes!==st.size))problems.push({file:rel,kind:'resource-manifest-mismatch'});if(st.size>10*1024*1024)problems.push({file:rel,kind:'large-file'});
 if(rel.startsWith('docs/media/')&&!allow)problems.push({file:rel,kind:'media-missing-from-manifest'});
 if(!textExt.test(rel))continue;const s=bytes.toString('utf8');if(/\b(?:sk-[A-Za-z0-9_-]{24,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(s))problems.push({file:rel,kind:'possible-secret'});
 const normalized=normalizePaths(s);if(personalHome.test(normalized)||localPaths.some(value=>normalized.includes(value)))problems.push({file:rel,kind:'personal-absolute-path'});
 const own=!rel.includes('/web/sdk/')&&!rel.endsWith('/CORE-LICENSE.md');if(own&&(previousName.test(s)||/TASK-\d{3}|task\d{3}|production-v0\.|live2d-runtime-v0\./i.test(s)))problems.push({file:rel,kind:'previous-development-identity'});
 if(!rel.endsWith('.md'))continue;const clean=s.replace(/```[\s\S]*?```/g,'');for(const m of clean.matchAll(/\]\((<[^>]+>|[^)]+)\)|<img[^>]*src="([^"]+)"/g)){let target=(m[1]||m[2]).replace(/^<|>$/g,'').split('#')[0];if(!target||/^(https?:|mailto:|data:)/i.test(target))continue;try{target=decodeURIComponent(target);}catch{problems.push({file:rel,kind:'invalid-local-link'});continue;}const resolved=path.resolve(path.dirname(file),target);if(!resolved.startsWith(root+path.sep)||!fs.existsSync(resolved))problems.push({file:rel,kind:'missing-local-link',target});}
}
for(const [rel] of approved)if(!candidates.includes(rel))problems.push({file:rel,kind:'resource-missing-from-candidate'});
for(const file of ['LICENSE','README.md','README_EN.md','package.json','pnpm-workspace.yaml','characters/default/web/sdk/LICENSE.md','characters/default/web/sdk/NOTICE.md','characters/default/web/sdk/CORE-LICENSE.md','product.json','tools/release-resources.json','apps/desktop/pnpm-lock.yaml'])if(!candidates.includes(file))problems.push({file,kind:'required-file-missing'});
const license=fs.readFileSync(path.join(root,'LICENSE'),'utf8');if(!license.startsWith('MIT License')||!license.includes('Copyright (c) 2026 Cute-Partner contributors')||!license.includes('The above copyright notice and this permission notice shall be included')||!license.includes('OUT OF OR IN CONNECTION WITH THE SOFTWARE'))problems.push({file:'LICENSE',kind:'incomplete-license'});
const product=require('../product.json');for(const f of ['package.json','apps/desktop/package.json','integrations/harness/package.json'])if(require(path.join(root,f)).version!==product.version)problems.push({file:f,kind:'version-mismatch'});
const report={schemaVersion:1,product:product.name,version:product.version,checkedAt:new Date().toISOString(),scope:'Git candidate source and resource checks',files,totalBytes:files.reduce((n,f)=>n+f.bytes,0),problems};
fs.mkdirSync(path.join(root,'.runtime'),{recursive:true});fs.writeFileSync(path.join(root,'.runtime/release-audit.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({files:files.length,totalBytes:report.totalBytes,problems},null,2));if(problems.length)process.exitCode=1;
