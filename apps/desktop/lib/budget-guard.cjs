'use strict';
const { EventEmitter } = require('node:events');
const fs = require('node:fs'), path = require('node:path');
// A local circuit breaker; the provider's balance and in-flight billing can lag.
class BudgetGuard extends EventEmitter {
  constructor({ root, query, ledger, now = () => Date.now() }) {
    super(); this.file = path.join(root, 'budget-settings.json'); this.query = query; this.ledger = ledger; this.now = now;
    this.settings = { enabled: false, minimumCny: 1 }; this.version = 0; this.warning = ''; this.checkedAt = null; this.remainingCny = null;
    try { this.settings = this.validate(JSON.parse(fs.readFileSync(this.file, 'utf8'))); } catch (error) { if (error.code !== 'ENOENT') { this.invalid = true; this.settings.enabled = true; this.warning = '节食提醒：配置无法读取，请重新设置并保存。'; } }
  }
  validate(value) {
    if (typeof value?.enabled !== 'boolean' || typeof value.minimumCny !== 'number' || !Number.isFinite(value.minimumCny) || value.minimumCny < 0 || value.minimumCny > 1000000) throw Error('请填写 0–1000000 元之间的节食下限');
    return { enabled: value.enabled, minimumCny: Math.round(value.minimumCny * 1000000) / 1000000 };
  }
  state() { return { ...this.settings, warning: this.warning, checkedAt: this.checkedAt, remainingCny: this.remainingCny }; }
  publish() { this.emit('update', this.state()); }
  save(value) {
    const settings = this.validate(value); fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file + '.tmp', JSON.stringify(settings, null, 2), { mode: 0o600 }); fs.renameSync(this.file + '.tmp', this.file);
    this.settings = settings; this.invalid = false; this.version++; this.warning = ''; this.publish(); return this.state();
  }
  async refresh() {
    if (this.pending) return this.pending;
    this.pending = Promise.resolve().then(() => this.query()).then(result => { this.ledger.recordBalance(result); return result; }).finally(() => { this.pending = null; });
    return this.pending;
  }
  beginTurn() { this.anchor = null; }
  fail(message) { this.warning = '节食提醒：' + message; this.publish(); this.emit('blocked', this.warning); throw Error(this.warning); }
  async check() {
    if (this.invalid) return this.fail('配置无法读取，请重新设置并保存。');
    if (!this.settings.enabled) return { allowed: true, enabled: false };
    const version = this.version; let result;
    try { result = await this.refresh(); } catch { if (version !== this.version) return this.check(); return this.fail('余额暂时无法确认，已暂停模型调用。'); }
    if (version !== this.version) return this.check();
    const info = result.infos?.find(i => i.currency === 'CNY'), balance = Number(info?.total);
    if (!info || !Number.isFinite(balance) || balance < 0) return this.fail('无法读取人民币余额，已暂停模型调用。');
    this.checkedAt = this.now();
    const priced = this.ledger.state();
    if (!this.anchor || this.anchor.accountId !== result.accountId) this.anchor = { accountId: result.accountId, balance, cost: priced.estimatedCostCny[1], unpriced: priced.unpricedRecords };
    if (priced.unpricedRecords > this.anchor.unpriced) return this.fail('本轮有无法估价的用量，已暂停模型调用。');
    this.remainingCny = Math.min(balance, this.anchor.balance - Math.max(0, priced.estimatedCostCny[1] - this.anchor.cost));
    if (this.remainingCny <= this.settings.minimumCny) return this.fail(`可用伙食费已到 ¥${this.settings.minimumCny.toFixed(2)} 下限，已停止调用。`);
    this.warning = ''; this.publish(); return { allowed: true, remainingCny: this.remainingCny, minimumCny: this.settings.minimumCny };
  }
}
module.exports = { BudgetGuard };
