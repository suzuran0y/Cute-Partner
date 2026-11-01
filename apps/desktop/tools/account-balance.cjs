'use strict';
// Runs in Harness's Node runtime. Only normalized balance data leaves this process.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
async function main() {
  const yaml = require(path.join(path.dirname(process.execPath), 'resources/app.asar/dsh/node_modules/yaml'));
  let doc = {}; try { doc = yaml.parse(fs.readFileSync(process.env.CUTE_PARTNER_CREDENTIAL_FILE, 'utf8')); } catch { if (!process.env.DEEPSEEK_API_KEY) throw Error('credentials'); }
  const key = doc.refs?.DEEPSEEK_API_KEY || process.env.DEEPSEEK_API_KEY;
  if (typeof key !== 'string' || !key.trim()) throw Error('credentials');
  const response = await fetch('https://api.deepseek.com/user/balance', { headers: { Authorization: 'Bearer ' + key, Accept: 'application/json' }, signal: AbortSignal.timeout(10000), redirect: 'error' });
  if (!response.ok) throw Error('HTTP_' + response.status);
  const body = await response.text(); if (body.length > 32000) throw Error('format');
  const value = JSON.parse(body);
  if (typeof value.is_available !== 'boolean' || !Array.isArray(value.balance_infos) || !value.balance_infos.length) throw Error('format');
  const infos = value.balance_infos.map(info => {
    if (!['CNY', 'USD'].includes(info.currency)) throw Error('currency');
    for (const k of ['total_balance', 'granted_balance', 'topped_up_balance']) if (typeof info[k] !== 'string' || !/^-?\d{1,12}(?:\.\d{1,10})?$/.test(info[k])) throw Error('format');
    return { currency: info.currency, total: info.total_balance, granted: info.granted_balance, toppedUp: info.topped_up_balance };
  });
  process.stdout.write(JSON.stringify({ ok: true, accountId: createHash('sha256').update(key).digest('hex').slice(0, 24), at: Date.now(), available: value.is_available, infos }) + '\n');
}
main().catch(error => { const code = /^(credentials|HTTP_\d{3}|format|currency)$/.test(error.message) ? error.message : 'network'; process.stdout.write(JSON.stringify({ ok: false, code }) + '\n'); process.exitCode = 1; });
