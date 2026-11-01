(() => {
  'use strict';
  const host=window.desktop,$=id=>document.getElementById(id),persona=$('persona-text');
  const section=document.createElement('section');section.className='settings-panel';section.innerHTML='<h3>慢慢认识她</h3><p class="note">相处方式可以在聊天中逐步补充；她提出修改时会先给你看，再保存。</p><div class="buttons"><button id="growth-invite" type="button">一起补充相处方式</button><button id="growth-reload" type="button">查看最新设定</button></div><p id="growth-notice" role="status"></p><details><summary>最近的设定修订</summary><div id="persona-history"></div></details>';$('page-settings').append(section);
  const topics=document.createElement('section');topics.className='settings-panel';topics.innerHTML='<h3>还在聊的事</h3><p class="note">这里仅留尚不明确的线索。明确要记的内容会保存到“关于你”或“各件事”；成熟事务由她自行归档，冲突和遗忘再问你。</p><div id="growth-topics"></div>';$('page-memory').append(topics);
  const dialog=document.createElement('dialog');dialog.id='persona-review';dialog.innerHTML='<h3>当前设定</h3><pre id="persona-latest"></pre><button id="persona-load" type="button">将当前设定放入编辑框</button><button id="persona-review-close" type="button">保留草稿</button>';document.body.append(dialog);
  const undo=document.createElement('dialog');undo.id='persona-undo-dialog';undo.innerHTML='<p id="persona-undo-text"></p><button id="persona-undo-confirm" type="button">确认撤销</button><button id="persona-undo-cancel" type="button">保留</button>';document.body.append(undo);
  let dirty=false,state,latest,undoTarget,loading=false;
  persona.addEventListener('input',()=>{dirty=true;});
  function node(tag,text,parent){const n=document.createElement(tag);n.textContent=text;parent.append(n);return n;}
  async function command(input){const r=await host.growthCommand(input);if(!r.ok)throw Error(r.error);return r.value;}
  async function action(fn){try{await fn();}catch(e){$('growth-notice').textContent=e.message;}}
  async function refresh(){if(loading)return;loading=true;try{const old=state;state=await host.getGrowth();if(state.error){$('growth-notice').textContent=state.error;return;}if(old&&old.personaRevision!==state.personaRevision){if(dirty)$('growth-notice').textContent='相处方式有了新版本，你的草稿仍保留。可先查看最新设定。';else window.personaSettings.load(await host.getSettings());}
    $('persona-history').replaceChildren();for(const row of (state.personaHistory||[]).slice().reverse()){const item=node('article','',$('persona-history'));item.className='memory-card';node('p',new Date(row.at).toLocaleString()+' · '+(row.status==='applied'?'已保存':'未应用')+' · 第'+row.revision+'版',item);const detail=node('details','',item);node('summary','查看前后内容',detail);node('p','原来：\n'+(row.before||'未填写'),detail);node('p','现在：\n'+row.after,detail);if(row.status==='applied'&&row.revision===state.personaRevision){const b=node('button','撤销这次设定修改',item);b.onclick=()=>{undoTarget=row;$('persona-undo-text').textContent='恢复为：\n'+(row.before||'空白设定')+'\n确认撤销吗？旧版本仍保留。';undo.showModal();};}}
    $('growth-topics').replaceChildren();const pending=(state.topics||[]).filter(t=>t.state!=='archived').slice(-12).reverse();if(!pending.length)node('p','还没有暂存的话题。先正常聊就好。',$('growth-topics'));for(const t of pending){const card=node('article','',$('growth-topics'));card.className='memory-card';node('p',t.title+' · '+({chatting:'本次线索',deferred:'继续聊，暂不归档',declined:'不长期保存'}[t.state]||t.state),card);if(t.state!=='declined')for(const i of t.items)node('p',(i.status==='candidate'?'待核对想法：':'')+i.content,card);else node('p','本话题不提取长期记忆；已有聊天历史独立保留。',card);}
  }finally{loading=false;}}
  $('growth-invite').onclick=()=>action(()=>command({action:'invite'}));
  $('growth-reload').onclick=()=>action(async()=>{latest=await host.getSettings();$('persona-latest').textContent=latest.persona||'还没有填写相处方式。';dialog.showModal();});
  $('persona-load').onclick=()=>{window.personaSettings.load(latest);dirty=false;dialog.close();};$('persona-review-close').onclick=()=>dialog.close();
  $('persona-undo-confirm').onclick=()=>action(async()=>{await command({action:'undo-persona',id:undoTarget.id,expectedRevision:state.personaRevision,confirmed:true});dirty=false;undo.close();await refresh();});$('persona-undo-cancel').onclick=()=>undo.close();
  $('settings-save').addEventListener('click',()=>{setTimeout(()=>{if($('settings-notice').textContent.startsWith('设置已保存'))dirty=false;},400);});
  host.onGrowth(()=>void action(refresh));host.onGrowthFocus(()=>{persona.focus();persona.scrollIntoView({block:'center'});});void action(refresh);
})();
