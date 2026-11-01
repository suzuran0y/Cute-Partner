(() => {
  'use strict';
  const host = window.desktop, $ = id => document.getElementById(id);
  let value, refreshing = false, dirty = false, saving = false, mode = 'money';
  const money = n => Number(n).toFixed(2);
  const range = pair => { const low = money(pair[0]), high = money(pair[1]); return low === high ? `¥${low}` : `¥${low}–${high}`; };
  const visible = () => !$('page-food').hidden && !document.hidden;
  function budget(settings) {
    if (!settings) return;
    if (!dirty) { $('budget-enabled').checked = settings.enabled; $('budget-minimum').value = money(settings.minimumCny); }
    $('budget-notice').textContent = settings.warning || (dirty ? '尚未保存' : settings.enabled ? `保护已开启 · 到 ¥${money(settings.minimumCny)} 时停止` : '未开启');
  }
  function render() {
    if (!value) return;
    const token = mode === 'token', balance = value.balance?.infos.find(i => i.currency === 'CNY');
    $('rice-primary-label').textContent = token ? '累计消耗米粒 · token' : '当前伙食费剩余 · ¥';
    $('rice-day-label').textContent = token ? '近 24 小时饭量 · token' : '近 24 小时饭量 · ¥';
    $('rice-primary').textContent = token ? value.totalTokens.toLocaleString() : balance ? `¥${money(balance.total)}` : '待查询';
    $('rice-day').textContent = token ? value.last24Tokens.toLocaleString() : `约 ${range(value.last24CostCny)}${value.unpriced24Records ? ' *' : ''}`;
    const label = token ? '切换为伙食费统计' : '切换为米粒统计';
    $('rice-rotate').setAttribute('aria-label', label); $('rice-rotate').title = label; $('rice-rotate').setAttribute('aria-pressed', String(token));
    $('rice-updated').textContent = value.balance ? '余额更新于 ' + new Date(value.balance.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '尚未查询余额';
    $('rice-notice').textContent = value.balanceError || '';
    $('rice-chart-title').textContent = token ? '近 24 小时 · 每小时米粒（token）' : '近 24 小时 · 每小时费用（¥）';
    const amount = b => token ? b.total : b.costCny[1], max = Math.max(0.000001, ...value.buckets.map(amount));
    $('rice-bars').replaceChildren(...value.buckets.map(b => {
      const column = document.createElement('div'), bar = document.createElement('span'), label = document.createElement('span');
      column.className = 'rice-column'; bar.className = 'rice-bar'; bar.style.height = Math.max(2, amount(b) / max * 130) + 'px';
      const time = n => new Date(n).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      column.title = `${time(b.start)}–${time(b.end)}：${token ? b.total.toLocaleString() + ' token' : '约 ' + range(b.costCny)}${b.unpriced ? '（有未估价用量）' : ''}`;
      column.setAttribute('aria-label', column.title); label.textContent = new Date(b.end).getHours().toString().padStart(2, '0'); column.append(bar, label); return column;
    }));
    $('rice-chart-summary').textContent = `近 24 小时合计 ${token ? value.last24Tokens + ' token' : '约 ' + range(value.last24CostCny)}，共 24 根小时柱。`;
    $('food-info-records').textContent = `逐笔记录始于 ${new Date(value.startedAt).toLocaleString()}；累计估算 ${range(value.estimatedCostCny)}。未能估价：累计 ${value.unpricedRecords} 笔，近 24 小时 ${value.unpriced24Records} 笔（带 * 的数字仅含可估价部分）。`;
    $('food-info-limits').textContent = (value.monthlyLimit > 0 ? `独立的本地月token上限：${value.monthlyLimit.toLocaleString()}，当前余量 ${value.remainingLocalTokens.toLocaleString()}。这不是账户余额，也不是节食下限。` : '未开启本地月token限额；累计token仅用于统计，不会因达到20万而停止。') + (value.budget?.enabled ? `节食按保留伙食费 ¥${money(value.budget.minimumCny)} 判断。` : '节食保护尚未开启。') + (value.budget?.remainingCny !== null && value.budget?.remainingCny !== undefined ? '最近保护检查参考余额：¥' + money(value.budget.remainingCny) + '。' : '');
    budget(value.budget);
  }
  async function load() { value = await host.getFood(); render(); return value; }
  async function refresh() {
    if (refreshing) return; refreshing = true; $('rice-refresh').disabled = true; $('rice-notice').textContent = '正在查询…';
    try { const result = await host.refreshBalance(); await load(); if (!result.ok) $('rice-notice').textContent = result.error; }
    catch { $('rice-notice').textContent = '余额暂时无法读取'; } finally { refreshing = false; $('rice-refresh').disabled = false; }
  }
  window.foodPanel = { open: async () => { try { const state = await load(); if (!state.balance || Date.now() - state.balance.at > 60000) await refresh(); } catch { $('rice-notice').textContent = '用量暂时无法读取'; } } };
  $('rice-refresh').onclick = refresh;
  $('rice-rotate').onclick = () => { mode = mode === 'money' ? 'token' : 'money'; render(); };
  $('food-info-open').onclick = () => $('food-info').showModal(); $('food-info-close').onclick = () => $('food-info').close();
  for (const id of ['budget-enabled', 'budget-minimum']) $(id).oninput = () => { dirty = true; $('budget-notice').textContent = '尚未保存'; };
  $('budget-save').onclick = async () => {
    if (saving) return; saving = true; $('budget-save').disabled = true;
    try {
      if (!$('budget-minimum').value.trim() || !$('budget-minimum').validity.valid) throw Error('请填写有效的保留金额');
      const result = await host.saveBudget({ enabled: $('budget-enabled').checked, minimumCny: Number($('budget-minimum').value) });
      if (!result.ok) throw Error(result.error); dirty = false; budget(result.value); await load();
    } catch (error) { $('budget-notice').textContent = error.message; } finally { saving = false; $('budget-save').disabled = false; }
  };
  host.onBudget(settings => { budget(settings); if (visible()) void load(); });
  host.onChat(() => { if (visible()) void load(); });
  setInterval(() => { if (visible()) void refresh(); }, 60000);
})();
