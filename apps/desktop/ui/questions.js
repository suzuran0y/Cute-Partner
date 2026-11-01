(() => {
  'use strict';
  const host = window.desktop, cloudMode = !!document.getElementById('cloud-questions'), root = document.getElementById(cloudMode ? 'cloud-questions' : 'reader-questions'), cards = new Map(); let revision = -1;
  const identity = r => ({ id: r.id, sessionId: r.sessionId, turnId: r.turnId, connectionId: r.connectionId });
  function el(tag, text, parent) { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; parent?.append(e); return e; }
  function layout() { window.dispatchEvent(new Event('question-layout')); }
  function showPage(card, index, announce = true) {
    card.index = Math.max(0, Math.min(index, card.fields.length - 1));
    card.fields.forEach((f, i) => { f.box.hidden = cloudMode && i !== card.index; });
    card.progress.textContent = '第 ' + (card.index + 1) + ' / ' + card.fields.length + ' 题'; card.back.disabled = !card.index; card.next.disabled = card.index === card.fields.length - 1;
    if (announce && card.request.status === 'waiting') void host.questionAction({ ...identity(card.request), action: 'focus', questionId: card.fields[card.index].q.id }); layout();
  }
  function valueOf(f) { return { selectedIds: f.other?.checked ? [] : f.options.filter(o => o.input.checked).map(o => o.input.value), other: f.other?.checked || false, custom: f.text.value, method: f.method || 'text' }; }
  function apply(f, draft) {
    if (f.dirty) return; f.serverRevision = draft?.revision || 0;
    for (const o of f.options) o.input.checked = draft?.selectedIds?.includes(o.input.value) || false;
    if (f.other) f.other.checked = draft?.other === true;
    const text = draft?.custom || ''; if (f.text.value !== text) f.text.value = text; f.method = draft?.method || 'text'; f.visibility();
  }
  function saveField(card, f) {
    const value = valueOf(f); f.dirty = true;
    card.queue = card.queue.then(async () => {
      if (card.request.status !== 'waiting') return;
      const result = await host.questionDraft({ ...identity(card.request), questionId: f.q.id, expectedRevision: f.serverRevision, value });
      if (!result.ok) throw Error(result.error); f.serverRevision = result.value.revision;
      if (JSON.stringify(valueOf(f)) === JSON.stringify(value)) f.dirty = false;
    }).catch(error => { card.notice.textContent = error.message + '；可点“同步草稿”重新载入。'; card.conflict = true; });
  }
  function render(value) {
    if (value.revision < revision) return; revision = value.revision;
    if (value.error) throw Error(value.error);
    const pending = value.requests.filter(r => r.status === 'waiting');
    const visible = cloudMode ? pending.slice(0, 1) : pending.length ? pending : value.requests.slice(-1);
    const ids = new Set();
    for (const request of visible) {
      ids.add(request.id); let card = cards.get(request.id);
      if (!card) {
        const element = el('article', undefined, root); element.className = 'question-card'; element.dataset.requestId = request.id;
        el('h2', '她想听听你的意见', element); el('p', '事务：' + request.drawerName, element).className = 'question-scope';
        const nav = el('div', undefined, element); nav.className = 'question-nav'; const back = el('button', '上一题', nav), progress = el('span', '', nav), next = el('button', '下一题', nav); nav.hidden = !cloudMode || request.questions.length < 2;
        const form = el('form', undefined, element), fields = [];
        card = { element, form, fields, back, progress, next, queue: Promise.resolve(), busy: false, conflict: false, request, index: 0 }; cards.set(request.id, card);
        for (const [index, q] of request.questions.entries()) {
          const box = el('fieldset', undefined, form); box.dataset.questionId = q.id; el('legend', q.question, box); if (q.detail) el('p', q.detail, box);
          const f = { q, box, options: [], serverRevision: 0, dirty: false }; fields.push(f);
          for (const o of q.options) {
            const label = el('label', undefined, box); label.className = 'question-option'; const input = el('input', undefined, label); input.type = q.multiSelect ? 'checkbox' : 'radio'; input.name = request.id + ':' + q.id; input.value = o.id;
            const content = el('span', undefined, label); el('span', o.label, content); if (o.description) el('small', o.description, content); f.options.push({ input, label: o.label });
          }
          if (q.options.length && !q.multiSelect) { const label = el('label', undefined, box); label.className = 'question-option'; f.other = el('input', undefined, label); f.other.type = 'radio'; f.other.name = request.id + ':' + q.id; f.other.value = '__custom'; el('span', '其他，自行填写', label); }
          const label = el('label', q.multiSelect ? '其他补充（不自动勾选选项）' : q.options.length ? '其他回答' : '你的回答', box); f.text = el('textarea', undefined, label); f.text.maxLength = 4000; f.text.rows = 2;
          const tools = el('div', undefined, box); tools.className = 'question-tools'; f.count = el('span', '', tools); const clear = el('button', '清空勾选', tools); clear.type = 'button'; clear.hidden = !q.options.length;
          const read = el('button', '读题', tools), listen = el('button', '语音回答', tools); read.type = listen.type = 'button'; read.className = 'question-read';
          f.visibility = () => { f.text.disabled = !!f.other && !f.other.checked; f.count.textContent = q.options.length ? '已勾选 ' + f.options.filter(o => o.input.checked).length + ' 项' : ''; layout(); };
          for (const o of f.options) o.input.onchange = () => { f.method = 'controls'; f.visibility(); saveField(card, f); };
          if (f.other) f.other.onchange = () => { f.method = 'text'; f.visibility(); saveField(card, f); };
          f.text.oninput = () => { f.method = 'text'; saveField(card, f); layout(); };
          clear.onclick = () => { f.options.forEach(o => { o.input.checked = false; }); f.method = 'controls'; f.visibility(); saveField(card, f); };
          const action = async name => { try { const result = await host.questionAction({ ...identity(card.request), action: name, questionId: q.id }); if (!result.ok) throw Error(result.error); } catch (error) { card.notice.textContent = error.message; } };
          read.onclick = () => action('read'); listen.onclick = () => action('listen'); box.addEventListener('focusin', () => { if (card.request.status === 'waiting') void action('focus'); });
          f.visibility();
        }
        const notice = el('p', '', form); notice.setAttribute('role', 'status'); const buttons = el('div', undefined, form); buttons.className = 'question-buttons'; const send = el('button', '回答她', buttons); send.type = 'submit'; const cancel = el('button', '取消这次追问', buttons); cancel.type = 'button'; const sync = el('button', '同步草稿', buttons); sync.type = 'button'; const otherWindow = el('button', cloudMode ? '在聊聊中回答' : '在白云中回答', buttons); otherWindow.type = 'button';
        const record = el('div', undefined, element); record.hidden = true; Object.assign(card, { notice, send, cancel, record });
        back.onclick = () => showPage(card, card.index - 1); next.onclick = () => showPage(card, card.index + 1);
        sync.onclick = async () => { await card.queue; card.conflict = false; fields.forEach(f => { f.dirty = false; }); revision = -1; safeRender(await host.getQuestions()); notice.textContent = '已同步另一窗口的草稿。'; };
        otherWindow.onclick = () => cloudMode ? host.openReader() : host.questionAction({ ...identity(card.request), action: 'show' });
        async function submit(action) {
          if (card.busy || card.request.status !== 'waiting') return; card.busy = true; send.disabled = cancel.disabled = true;
          try {
            await card.queue; if (card.conflict) throw Error('草稿有冲突，请先同步。');
            for (const f of fields) { if (!card.request.drafts?.[f.q.id]) saveField(card, f); } await card.queue; if (card.conflict) throw Error('草稿未保存，请重试或同步。');
            const answers = fields.map(f => ({ id: f.q.id, selected: f.other?.checked ? [] : f.options.filter(o => o.input.checked).map(o => o.label), custom: !f.other || f.other.checked ? f.text.value.trim() : '' }));
            const missing = answers.findIndex(a => !a.selected.length && !a.custom); if (action === 'answer' && missing >= 0) { showPage(card, missing); throw Error('请回答每题；选“其他”后请填写内容。'); }
            notice.textContent = '正在提交…'; const result = await host.answerQuestion({ ...identity(card.request), action, ...(action === 'answer' ? { answers } : {}) }); if (!result.ok) throw Error(result.error);
          } catch (error) { notice.textContent = error.message; }
          finally { card.busy = false; send.disabled = cancel.disabled = card.request.status !== 'waiting'; layout(); }
        }
        form.onsubmit = event => { event.preventDefault(); void submit('answer'); }; cancel.onclick = () => submit('cancel');
      }
      card.request = request; card.fields.forEach(f => apply(f, request.drafts?.[f.q.id]));
      if (request.speechNextQuestionId && request.speechNextQuestionId !== card.speechNextQuestionId) { card.speechNextQuestionId = request.speechNextQuestionId; const next = card.fields.findIndex(f => f.q.id === request.speechNextQuestionId); if (next >= 0) card.index = next; }
      if (request.voiceNotice && !cloudMode) card.notice.textContent = request.voiceNotice;
      showPage(card, card.index, false);
      if (request.status !== 'waiting') { card.form.hidden = true; card.record.hidden = false; card.record.replaceChildren(); el('p', { answered: '已回答', cancelled: '已取消，没有提供答案', 'timed-out': '等待超时，没有提供答案', interrupted: '连接或程序中断，此问题已失效' }[request.status] || request.status, card.record); for (const a of request.answers || []) el('p', request.questions.find(q => q.id === a.id).question + '：' + [...a.selected, a.custom].filter(Boolean).join('；'), card.record); }
      else requestAnimationFrame(() => { if (card.element.getBoundingClientRect().width > 0) void host.questionAction({ ...identity(card.request), action: 'rendered' }); });
    }
    for (const [id, card] of cards) if (!ids.has(id)) { card.element.remove(); cards.delete(id); } root.hidden = !visible.length; layout();
  }
  function safeRender(value) { try { render(value); } catch { root.hidden = false; root.textContent = '问题卡片暂未显示，请点“全文”在聊聊中回答。'; const r = value?.requests?.find(r => r.status === 'waiting'); if (r) void host.questionAction({ ...identity(r), action: 'render-failed' }); layout(); } }
  host.onQuestions(safeRender); host.getQuestions().then(safeRender).catch(() => { root.hidden = false; root.textContent = '问题暂时无法读取，请打开聊聊检查。'; layout(); });
  host.getTts().then(s => { document.documentElement.dataset.speechEnabled = String(s.settings.enabled); }); host.onTts(s => { document.documentElement.dataset.speechEnabled = String(s.settings.enabled); });
  window.questionCards = { render: safeRender };
})();
