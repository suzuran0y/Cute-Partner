(() => {
  'use strict';
  const host = window.desktop, $ = id => document.getElementById(id), rows = new Map(), history = $('reader-history'); let revision = -1, state, selection = '', submitting = false;
  function selectedMessage() { const node = getSelection()?.anchorNode; return node && history.contains(node); }
  function render(value) {
    if (value.revision < revision) return; state = value; revision = value.revision;
    const pinned = history.scrollHeight - history.clientHeight - history.scrollTop < 90, keepScroll = history.scrollTop, ids = new Set();
    for (const message of value.messages) {
      ids.add(message.id); let row = rows.get(message.id);
      if (!row) { const element = document.createElement('article'), top = document.createElement('div'), who = document.createElement('span'), copy = document.createElement('button'), body = document.createElement('div'); element.className = 'message'; element.dataset.role = message.role; top.className = 'message-top'; copy.textContent = '复制正文'; copy.onclick = () => host.copyText(row.message.text); top.append(who, copy); element.append(top, body); history.append(element); row = { element, who, body, message, signature: '' }; rows.set(message.id, row); }
      row.message = message; row.who.textContent = (message.drawerId ? '[' + (message.drawerId === value.drawerId ? value.drawerName : '其他事务') + '] ' : '') + (message.role === 'user' ? '你' : '她') + (message.status === 'streaming' ? ' · 正在生成' : message.status === 'interrupted' ? ' · 已中断' : message.replyCompletion === 'intermediate' ? ' · 办事进展' : message.voiceUnavailable ? ' · 口语稿不可用，正文已保留' : message.replyFormatWarning ? ' · 格式提示' : ''); row.who.title = message.replyFormatWarning || message.voiceUnavailable || '';
      if (message.role === 'assistant' && !row.read) { row.read = document.createElement('button'); row.read.textContent = '说重点'; row.read.onclick = async () => { const result = await host.ttsCommand('read', row.message.id); if (!result.ok) $('reader-error').textContent = result.error; }; row.element.querySelector('.message-top').append(row.read); }
      if (row.read) { row.read.disabled = message.status !== 'completed' || message.speechEligible === false || !message.spokenText; row.read.title = message.voiceUnavailable || (message.replyCompletion === 'intermediate' ? '这是办事过程记录，最终回复完成后再朗读' : message.replyFormatWarning || '朗读这条回复的完整口语稿'); }
      const signature = message.status + '\0' + message.text;
      if (signature !== row.signature && !(selectedMessage() && row.element.contains(getSelection().anchorNode) && getSelection().toString())) { row.signature = signature; if (message.status === 'streaming' || message.role === 'user') { const pre = document.createElement('div'); pre.className = 'stream-text'; pre.textContent = message.text; row.body.replaceChildren(pre); } else row.body.replaceChildren(window.safeMarkdown.render(message.text)); }
    }
    for (const [id, row] of rows) if (!ids.has(id)) { row.element.remove(); rows.delete(id); }
    if (pinned) history.scrollTop = history.scrollHeight; else history.scrollTop = keepScroll;
    $('reader-latest').hidden = pinned; $('reader-send').disabled = value.busy || submitting; $('reader-stop').disabled = !value.busy; $('reader-new').disabled = value.busy;
    $('reader-status').textContent = value.busy ? value.phase === 'stopping' ? '正在确认停止…' : '她正在思考或办事，正文会接着写在这里。' : value.streaming?.degraded ? '本轮实时通道延迟，最终正文已保留。' : '文字留在这里，慢慢看。'; $('reader-error').textContent = value.error || '';
  }
  host.onChat(render); host.getChat().then(render);
  host.getDraft().then(value => { $('reader-input').value = value; }); host.onDraft(value => { if ($('reader-input').value !== value) $('reader-input').value = value; });
  $('reader-input').oninput = () => host.saveDraft($('reader-input').value);
  $('reader-input').onkeydown = event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('reader-form').requestSubmit(); } };
  $('reader-form').onsubmit = async event => { event.preventDefault(); if (submitting || !$('reader-input').value.trim()) return; submitting = true; $('reader-send').disabled = true; try { const result = await host.chatCommand({ action: 'send', text: $('reader-input').value }); if (!result.ok) throw Error(result.error); $('reader-input').value = ''; await host.saveDraft(''); history.scrollTop = history.scrollHeight; } catch (error) { $('reader-error').textContent = error.message; } finally { submitting = false; $('reader-send').disabled = !!state?.busy; } };
  $('reader-new').onclick = async () => { const result = await host.chatCommand({ action: 'new' }); if (!result.ok) $('reader-error').textContent = result.error; };
  $('reader-stop-voice').onclick = () => host.ttsCommand('stop');
  $('reader-stop').onclick = () => host.chatCommand({ action: 'stop' });
  $('reader-latest').onclick = () => { history.scrollTop = history.scrollHeight; $('reader-latest').hidden = true; };
  document.addEventListener('selectionchange', () => { const chosen = selectedMessage() ? getSelection().toString().trim().slice(0, 1200) : ''; if (chosen) selection = chosen; $('reader-explain').disabled = !chosen; $('reader-selection').textContent = chosen ? '已选 ' + chosen.length + ' 字' : ''; if (!chosen && state) render(state); });
  $('reader-explain').onmousedown = event => event.preventDefault();
  $('reader-explain').onclick = () => { const prefix = $('reader-input').value.trim(); $('reader-input').value = (prefix ? prefix + '\n\n' : '') + '请解释这段内容：\n' + selection; $('reader-input').value = $('reader-input').value.slice(0, 4000); void host.saveDraft($('reader-input').value); $('reader-input').focus(); };
})();
