(() => {
  'use strict';
  const host = window.desktop, select = document.getElementById('reader-drawer'), linked = document.getElementById('reader-linked'), note = document.getElementById('reader-memory-status'); let state, drawers = [], signature;
  function render() {
    if (!state) return; const next = JSON.stringify(drawers.map(d => [d.id, d.name]));
    if (next !== signature) { signature = next; select.replaceChildren(); linked.replaceChildren(); for (const d of drawers) { const option = document.createElement('option'); option.value = d.id; option.textContent = d.name; select.append(option); const label = document.createElement('label'), input = document.createElement('input'); input.type = 'checkbox'; input.value = d.id; label.append(input, document.createTextNode(d.name)); linked.append(label); } }
    select.value = state.drawerId; select.disabled = state.busy; for (const input of linked.querySelectorAll('input')) { input.checked = state.linkedDrawers.includes(input.value); input.disabled = state.busy || input.value === state.drawerId; }
    document.getElementById('reader-drawer-new').disabled = state.busy;
    note.textContent = [state.memoryNotice, state.continuityNotice, state.memorySnapshot?.omittedCoreCount ? '本轮有'+state.memorySnapshot.omittedCoreCount+'条核心未纳入预算，完整内容可在小本本查看。' : '', state.memorySnapshot?.available ? '本轮已按当前事务读取记忆。' : ''].filter(Boolean).join(' ');
  }
  async function command(input) { try { const result = await host.chatCommand(input); if (!result.ok) throw Error(result.error); } catch (error) { note.textContent = error.message; } }
  select.onchange = () => command({ action: 'drawer', drawerId: select.value });
  document.getElementById('reader-linked-save').onclick = () => command({ action: 'link-drawers', ids: [...linked.querySelectorAll('input:checked')].map(input => input.value) });
  const dialog = document.getElementById('reader-drawer-dialog'); document.getElementById('reader-drawer-new').onclick = () => dialog.showModal(); document.getElementById('reader-drawer-cancel').onclick = () => dialog.close();
  document.getElementById('reader-drawer-form').onsubmit = async event => { event.preventDefault(); try { const result = await host.createDrawer({ name: document.getElementById('reader-drawer-name').value }); if (!result.ok) throw Error(result.error); dialog.close(); await load(); await command({ action: 'drawer', drawerId: result.value.id }); } catch (error) { document.getElementById('reader-drawer-error').textContent = error.message; } };
  async function load() { const result = await host.getDrawers(); drawers = result.drawers; render(); }
  host.onChat(value => { state = value; render(); }); host.getChat().then(value => { state = value; render(); }); host.onDrawerDirectory(load); void load();
})();
