(() => {
  'use strict';
  const host = window.desktop, $ = id => document.getElementById(id), cloud = $('cloud'), text = $('cloud-text'), form = $('cloud-form'), input = $('cloud-input'), error = $('cloud-input-error'), send = $('cloud-send'), content = document.querySelector('.cloud-content'), flow = $('cloud-flow');
  let id, submitting = false, value, measureTimer;
  function measure() { if (measureTimer) return; measureTimer = setTimeout(() => { measureTimer = null; if (!value || cloud.hidden) return; host.measureCloud({ id: value.id, contentWidth: content.getBoundingClientRect().width, naturalHeight: Math.ceil(flow.scrollHeight + document.querySelector('.cloud-top').offsetHeight + 8) }); }, 70); }
  function geometry(layout) {
    if (!layout) return; cloud.dataset.side = layout.side; const b = layout.body, c = layout.content, skin = $('cloud-skin');
    Object.assign(skin.style, { left: b.x + 'px', top: b.y + 'px', width: b.width + 'px', height: b.height + 'px' });
    const w = b.width, h = b.height, a = Math.min(20, h * .13); skin.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
    skin.querySelector('path').setAttribute('d', `M${w*.10} ${a} C${w*.12} ${-a*.4} ${w*.22} ${-a*.4} ${w*.25} ${a*.7} C${w*.28} ${-a*.4} ${w*.42} ${-a*.4} ${w*.45} ${a*.7} C${w*.49} ${-a*.4} ${w*.62} ${-a*.4} ${w*.65} ${a*.7} C${w*.70} ${-a*.4} ${w*.82} ${-a*.3} ${w*.85} ${a} Q${w-5} 2 ${w-12} ${h*.18} C${w+5} ${h*.23} ${w+5} ${h*.30} ${w-5} ${h*.34} C${w+8} ${h*.45} ${w+8} ${h*.60} ${w-5} ${h*.65} C${w+5} ${h*.74} ${w+3} ${h*.83} ${w-12} ${h*.85} Q${w} ${h-3} ${w*.86} ${h-a*.5} C${w*.80} ${h+a*.2} ${w*.70} ${h+a*.2} ${w*.67} ${h-a*.5} C${w*.61} ${h+a*.2} ${w*.49} ${h+a*.2} ${w*.46} ${h-a*.5} C${w*.40} ${h+a*.2} ${w*.25} ${h+a*.2} ${w*.22} ${h-a*.5} Q${w*.06} ${h+4} 12 ${h*.85} C-3 ${h*.83} -5 ${h*.74} 5 ${h*.65} C-8 ${h*.60} -8 ${h*.45} 5 ${h*.34} C-5 ${h*.30} -5 ${h*.23} 12 ${h*.18} Q3 2 ${w*.10} ${a} Z`);
    if (c) Object.assign(content.style, { left: c.x + 'px', top: c.y + 'px', width: c.width + 'px', height: c.height + 'px', right: 'auto', bottom: 'auto' });
    for (let i = 0; i < 2; i++) { const e = document.querySelector(i ? '.dot-two' : '.dot-one'), d = layout.dots[i]; e.hidden = !d; if (d) Object.assign(e.style, { left: d.x - d.radius + 'px', top: d.y - d.radius + 'px', width: d.radius * 2 + 'px', height: d.radius * 2 + 'px' }); }
    measure();
  }
  function render(next) {
    geometry(next?.layout); const changed = next?.id !== id; id = next?.id; value = next; cloud.hidden = !next;
    $('cloud-welcome').hidden = next?.kind !== 'welcome';
    const typing = next?.kind === 'input', questioning = next?.kind === 'question'; form.hidden = !typing; text.hidden = typing || questioning;
    $('cloud-questions').hidden = !questioning; $('cloud-question-error').hidden = !next?.notice; $('cloud-question-error').textContent = next?.notice || '';
    if (!next) { text.textContent = ''; host.cloudHit(false); return; }
    cloud.dataset.kind = next.kind; $('cloud-name').textContent = questioning ? '她 · 等你回答' : typing ? '悄悄写给她' : next.kind === 'reply' ? next.streaming ? '她 · 正在写' : '她' : '她 · 小声说';
    if (typing && changed) { host.getDraft().then(draft => { if (id === next.id) { input.value = draft; measure(); } }); error.textContent = ''; send.disabled = false; submitting = false; input.focus(); }
    if (!typing && !questioning) text.textContent = next.text;
    if (changed) $('cloud-scroll').scrollTop = 0; measure();
  }
  new ResizeObserver(measure).observe(flow); window.addEventListener('question-layout', measure); document.fonts.ready.then(measure);
  document.addEventListener('mousemove', event => host.cloudHit(!!event.target.closest('.cloud-content'))); document.addEventListener('mouseleave', () => host.cloudHit(false));
  for(const button of document.querySelectorAll('[data-welcome]')) button.onclick=async()=>{const response=await host.growthCommand({action:'choose',id,choice:button.dataset.welcome}); if(!response.ok) $('welcome-error').textContent=response.error;};
  $('cloud-open').onclick = () => host.openReader(); $('cloud-close').onclick = () => host.cloudCommand('close'); $('cloud-stop-voice').onclick = () => host.ttsCommand('stop');
  input.oninput = () => { host.saveDraft(input.value); input.style.height = 'auto'; input.style.height = Math.min(170, Math.max(65, input.scrollHeight)) + 'px'; measure(); }; host.onDraft(draft => { if (value?.kind === 'input' && input.value !== draft) { input.value = draft; measure(); } });
  form.onsubmit = async event => {
    event.preventDefault(); if (submitting || value?.kind !== 'input') return;
    if (!input.value.trim()) { error.textContent = '先写一点想说的话吧。'; input.focus(); return; }
    submitting = true; send.disabled = true; error.textContent = ''; const requestId = id;
    try { const result = await host.cloudSend({ id: requestId, text: input.value }); if (!result.ok && requestId === id) { error.textContent = result.error; input.focus(); } else if (result.ok) await host.saveDraft(''); }
    catch { if (requestId === id) error.textContent = '发送未完成，请重试。'; } finally { if (requestId === id) { submitting = false; send.disabled = false; } measure(); }
  };
  input.onkeydown = event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); form.requestSubmit(); } else if (event.key === 'Escape') host.cloudCommand('close'); };
  host.onCloudFocus(() => { if (!form.hidden) input.focus(); }); host.onCloudGeometry(geometry); host.onCloud(render); host.getCloud().then(render);
  host.onTts(state => { $('cloud-stop-voice').hidden = !state.active; if (state.phase === 'playing' && value?.id === state.messageId) { $('cloud-name').textContent = '她 · 正在说'; } else if (!state.active && value?.id === state.messageId) { render(value); if (state.error) { text.textContent += '\n（声音暂不可用，可以先看文字）'; measure(); } } });
})();
