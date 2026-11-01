'use strict';
const fs = require('node:fs');
const path = require('node:path');
// Verified 2026-10-22. Prices in CNY / million tokens; range covers peak/off-peak.
const PRICING = Object.freeze({ 'deepseek-flash': { input: [1, 2], cache: [.02, .04], output: [4, 8] }, 'deepseek-v4-pro': { input: [4.5, 9], cache: [.15, .30], output: [13.5, 27] } });
const PRICE_SOURCE = 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/';
function costRange(model, usage) {
  const p = PRICING[model]; if (!p || !Number.isSafeInteger(usage.inputTokens) || !Number.isSafeInteger(usage.outputTokens)) return null;
  return [0, 1].map(i => ((usage.inputTokens + (usage.cacheWriteTokens || 0)) * p.input[i] + (usage.cacheReadTokens || 0) * p.cache[i] + usage.outputTokens * p.output[i]) / 1000000);
}
class UsageLedger {
  constructor(root, { now = () => Date.now() } = {}) {
    this.file = path.join(root, 'usage-ledger.json'); this.now = now; this.entries = []; this.balances = []; this.startedAt = now();
    try { const saved = JSON.parse(fs.readFileSync(this.file, 'utf8')); if (saved.version === 1) { this.entries = saved.entries.filter(e => typeof e.id === 'string' && Number.isFinite(e.at) && Number.isSafeInteger(e.usage?.totalTokens) && e.usage.totalTokens >= 0); this.balances = (saved.balances || []).filter(e => Number.isFinite(e.at) && Array.isArray(e.infos)); this.startedAt = saved.startedAt || this.startedAt; } } catch {}
  }
  save() { fs.mkdirSync(path.dirname(this.file), { recursive: true }); fs.writeFileSync(this.file + '.tmp', JSON.stringify({ version: 1, startedAt: this.startedAt, entries: this.entries, balances: this.balances }, null, 2), { mode: 0o600 }); fs.renameSync(this.file + '.tmp', this.file); }
  record({ id, model, usage, at = this.now() }) {
    if (this.entries.some(e => e.id === id)) return false;
    if (typeof id !== 'string' || !Number.isFinite(at) || !Number.isSafeInteger(usage?.totalTokens) || usage.totalTokens < 0) throw Error('用量记录无效');
    this.entries.push({ id, model, usage: { ...usage }, at, cost: costRange(model, usage) }); this.save(); return true;
  }
  recordBalance(balance) {
    this.balances.push({ at: balance.at, accountId: balance.accountId, infos: balance.infos });
    this.balances = this.balances.slice(-2000); this.save();
  }
  state({ monthlyLimit, monthlyUsed } = {}) {
    const now = this.now(), hour = 3600000, start = now - 24 * hour;
    const buckets = Array.from({ length: 24 }, (_, i) => ({ start: start + i * hour, end: start + (i + 1) * hour, total: 0, input: 0, output: 0, costCny: [0, 0], unpriced: 0 }));
    let total = 0, last24 = 0, low = 0, high = 0, unpriced = 0, unpriced24 = 0; const last24CostCny = [0, 0];
    for (const e of this.entries) {
      total += e.usage.totalTokens; if (e.cost) { low += e.cost[0]; high += e.cost[1]; } else unpriced++;
      if (e.at >= start && e.at <= now) { const b = buckets[Math.min(23, Math.floor((e.at - start) / hour))]; b.total += e.usage.totalTokens; b.input += (e.usage.inputTokens || 0) + (e.usage.cacheReadTokens || 0) + (e.usage.cacheWriteTokens || 0); b.output += e.usage.outputTokens || 0; last24 += e.usage.totalTokens; if (e.cost) { for (let i = 0; i < 2; i++) { b.costCny[i] += e.cost[i]; last24CostCny[i] += e.cost[i]; } } else { b.unpriced++; unpriced24++; } }
    }
    const latest = this.balances.at(-1), first = latest && this.balances.find(b => b.accountId === latest.accountId);
    const balance = latest ? { at: latest.at, infos: latest.infos.map(info => { const initial = first.infos.find(i => i.currency === info.currency); return { ...info, observedNetDecrease: initial ? Number(initial.total) - Number(info.total) : null }; }), baselineAt: first.at } : null;
    return { startedAt: this.startedAt, asOf: now, totalTokens: total, last24Tokens: last24, last24CostCny, unpriced24Records: unpriced24, buckets, estimatedCostCny: [low, high], unpricedRecords: unpriced, priceCheckedOn: '2026-10-22', priceSource: PRICE_SOURCE, balance, monthlyLimit, monthlyUsed, remainingLocalTokens: monthlyLimit > 0 ? Math.max(0, monthlyLimit - (monthlyUsed || 0)) : null };
  }
}
module.exports = { UsageLedger, costRange, PRICING };
