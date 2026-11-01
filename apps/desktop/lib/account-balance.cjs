'use strict';
const { spawn } = require('node:child_process');
const path = require('node:path');
const { installation } = require('./harness-provider.cjs');
function queryBalance() {
  const found = installation(); if (!found.installed) return Promise.reject(Error('未找到 Harness，无法读取账户凭据'));
  return new Promise((resolve, reject) => {
    const child = spawn(found.executable, [path.join(__dirname, '../tools/account-balance.cjs')], { windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', CUTE_PARTNER_CREDENTIAL_FILE: found.credentialFile }, stdio: ['ignore', 'pipe', 'pipe'] });
    let text = '', settled = false; const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
    const timer = setTimeout(() => { child.kill(); finish(Error('余额查询超时，请稍后刷新')); }, 12000);
    child.stderr.resume(); child.stdout.on('data', bytes => { text += bytes.toString(); if (text.length > 40000) { child.kill(); finish(Error('余额返回格式无效')); } });
    child.on('error', () => finish(Error('无法启动余额查询')));
    child.on('close', () => { try { const result = JSON.parse(text); if (!result.ok) throw Error(result.code === 'credentials' || result.code === 'HTTP_401' ? '请检查 Harness 中的 DeepSeek API 凭据' : '余额暂时无法读取，请检查网络或稍后刷新'); finish(null, result); } catch (error) { finish(Error(error.message.startsWith('请') || error.message.startsWith('余额暂') ? error.message : '余额返回格式无效')); } });
  });
}
module.exports = { queryBalance };
