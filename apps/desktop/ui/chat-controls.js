(() => {
  'use strict';
  const $ = id => document.getElementById(id), host = window.desktop;
  if (!host) return;
  let revision = -1, submitting = false, current;
  const labels = { idle: '想聊些什么？', connecting: '正在连接 DeepSeek Harness…', thinking: '可爱的助手正在回复…', stopping: '正在停止，等待进程退出…', completed: '回复已完成', cancelled: '已停止', error: '这次对话未完成' };
  function render(state) {
    if (!state || state.revision < revision) return;
    revision = state.revision; current = state;
    $('chat-state').textContent = !state.installed ? '未找到 DeepSeek Harness' : !state.credentialAvailable ? '请先在 Harness 中配置 DeepSeek API 凭据' : labels[state.phase] || state.phase;
    $('chat-error').textContent = state.error || '';
    if (!$('chat-model').options.length) for (const model of state.models) { const option = document.createElement('option'); option.value = model.id; option.textContent = model.name; $('chat-model').append(option); }
    $('chat-model').value = state.model; $('chat-model').disabled = state.busy || submitting;
    $('chat-new').disabled = state.busy || submitting;
    $('chat-send').disabled = state.busy || submitting || !state.installed || !state.credentialAvailable;
    $('chat-stop').disabled = !state.busy || state.phase === 'stopping' || submitting;
    $('chat-input').disabled = state.busy || submitting;
    $('chat-usage').textContent = `${state.meter.month}：${state.meter.requests}${state.limits.monthlyRequests > 0 ? ' / ' + state.limits.monthlyRequests : ''} 次调用尝试 · 已报告 ${state.meter.totalTokens}${state.limits.monthlyReportedTokens > 0 ? ' / ' + state.limits.monthlyReportedTokens : ''} tokens${state.limits.monthlyReportedTokens > 0 || state.limits.monthlyRequests > 0 ? '' : '（未设月上限）'} · 本段 ${state.turns} / ${state.limits.turnsPerConversation} 轮`;
    const signature = JSON.stringify(state.messages);
    if ($('chat-messages').dataset.signature !== signature) {
      $('chat-messages').dataset.signature = signature;
      $('chat-messages').replaceChildren(...state.messages.map(message => {
        const item = document.createElement('article'), name = document.createElement('strong'), body = document.createElement('p');
        item.className = 'chat-message ' + message.role; name.textContent = message.role === 'user' ? '你' : '可爱的助手'; body.textContent = message.text;
        item.append(name, body); return item;
      }));
      $('chat-messages').scrollTop = $('chat-messages').scrollHeight;
    }
  }
  async function command(input) {
    if (submitting) return; submitting = true; if (current) render(current); $('chat-error').textContent = '';
    try { const reply = await host.chatCommand(input); if (!reply.ok) throw Error(reply.error); if (input.action === 'send') $('chat-input').value = ''; }
    catch (error) { $('chat-error').textContent = error.message; }
    finally { submitting = false; if (current) { const error = $('chat-error').textContent; render(current); if (error) $('chat-error').textContent = error; } }
  }
  $('chat-form').onsubmit = event => { event.preventDefault(); void command({ action: 'send', text: $('chat-input').value }); };
  $('chat-input').onkeydown = event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('chat-form').requestSubmit(); } };
  $('chat-stop').onclick = () => command({ action: 'stop' });
  $('chat-new').onclick = () => command({ action: 'new', model: $('chat-model').value });
  $('chat-model').onchange = () => command({ action: 'new', model: $('chat-model').value });
  host.onChat(render); host.getChat().then(render).catch(error => { $('chat-error').textContent = error.message; });
})();
