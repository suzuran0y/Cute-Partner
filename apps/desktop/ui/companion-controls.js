(() => {
  'use strict';
  const host = window.desktop, $ = id => document.getElementById(id); let page = 'settings', personaRevision;
  function navigate(value, scroll = false) {
    if (!['settings', 'memory', 'voice', 'food'].includes(value)) return; page = value;
    for (const name of ['settings', 'memory', 'voice', 'food']) { $('page-' + name).hidden = name !== value; document.querySelector(`[data-page="${name}"]`).setAttribute('aria-selected', String(name === value)); }
    if (scroll) $('page-' + value).scrollIntoView({ block: 'start', behavior: 'smooth' });
    if (value === 'food') void window.foodPanel.open();
  }
  for (const button of document.querySelectorAll('[data-page]')) button.onclick = () => navigate(button.dataset.page);
  host.onPanelPage(value => navigate(value, true)); host.getPanelPage().then(value => navigate(value));
  function showSettings(value) { personaRevision=value.personaRevision; $('persona-text').value = value.persona; $('memory-text').value = value.memory; $('voice-shortcut').value = value.voiceShortcut; $('voice-auto-send').checked = value.voiceAutoSend; $('agent-mode').value = value.agentMode; $('agent-mode').dispatchEvent(new Event('change')); $('agent-workspace').value = value.agentWorkspace; $('settings-notice').textContent = value.shortcutError || ''; }
  host.getSettings().then(showSettings);
  window.personaSettings={load:value=>{ $('persona-text').value=value.persona; personaRevision=value.personaRevision; }};
  host.onShortcutError(value => { $('settings-notice').textContent = value; });
  for (const kind of ['persona', 'memory']) $('import-' + kind).onclick = async () => { try { const result = await host.importSettings(kind); if (!result.ok) throw Error(result.error); if (!result.cancelled) { $(kind + '-text').value = result.text; $('settings-notice').textContent = '已载入 ' + result.name + '，点击保存后生效。'; } } catch (error) { $('settings-notice').textContent = error.message; } };
  $('settings-save').onclick = async () => {
    if (mapping) await finishMapping();
    $('settings-save').disabled = true;
    try { const result = await host.settingsCommand({ action: 'save', expectedPersonaRevision:personaRevision, value: { persona: $('persona-text').value, memory: $('memory-text').value, voiceShortcut: $('voice-shortcut').value.trim(), voiceAutoSend: $('voice-auto-send').checked, agentMode: $('agent-mode').value, agentWorkspace: $('agent-workspace').value } }); if (!result.ok) throw Error(result.error); showSettings(result.value); $('settings-notice').textContent = '设置已保存；设定或权限变化时开启新会话，旧参考记忆请到记忆页确认。' + (result.value.memoryWarning || '') + ''; }
    catch (error) { $('settings-notice').textContent = error.message; } finally { $('settings-save').disabled = false; }
  };
  $('open-debug').onclick = () => host.openDebug();
  function interaction(mode) { $('interaction-state').textContent = mode === 'text' ? '现在用文字聊。' : '现在可以说话。'; }
  host.getInteraction().then(value => interaction(value.mode)); host.onInteraction(interaction);
  let mapping = false, ctrlOnly = false, mapped = '';
  async function finishMapping(value) { mapping = false; ctrlOnly = false; if (value) $('voice-shortcut').value = value; $('shortcut-map').textContent = '重新映射'; await host.shortcutCapture(false); }
  $('shortcut-map').onclick = async () => { if (mapping) { await finishMapping(); return; } await host.shortcutCapture(true); mapping = true; mapped = ''; ctrlOnly = false; $('shortcut-map').textContent = '按新快捷键（Esc 取消）'; $('voice-shortcut').focus(); };
  $('shortcut-default').onclick = async () => { await finishMapping('Ctrl'); $('settings-notice').textContent = '点击保存后生效。'; };
  window.addEventListener('keydown', event => {
    if (!mapping) return; event.preventDefault();
    if (event.repeat) return;
    if (event.key === 'Escape') { void finishMapping(); return; }
    if (event.key === 'Control') { ctrlOnly = !event.altKey && !event.shiftKey && !event.metaKey && !mapped; return; }
    ctrlOnly = false;
    if (['Shift', 'Alt', 'Meta'].includes(event.key)) return;
    const modifiers = [event.ctrlKey && 'Ctrl', event.altKey && 'Alt', event.shiftKey && 'Shift'].filter(Boolean), key = event.key.toUpperCase();
    const candidate = [...modifiers, key].join('+');
    if (!event.metaKey && (/^F(?:[2-9]|1[0-2])$/.test(candidate) || modifiers.length >= 2 && /^[A-Z0-9]$/.test(key))) mapped = candidate;
    else { mapped = ''; $('settings-notice').textContent = '请选择单独 Ctrl、F2–F12，或至少两个修饰键加字母/数字。'; }
  }, true);
  window.addEventListener('keyup', event => { if (!mapping) return; event.preventDefault(); if (event.key === 'Control' && ctrlOnly) void finishMapping('Ctrl'); else if (mapped && !['Control', 'Shift', 'Alt'].includes(event.key)) void finishMapping(mapped); }, true);
  window.addEventListener('blur', () => { if (mapping) void finishMapping(); });
  window.addEventListener('pagehide', () => { void host.shortcutCapture(false); });
})();
