(() => {
  'use strict';
  const host = window.desktop, notebook = !!document.getElementById('page-settings'), section = document.createElement('section'); section.className = 'agent-panel';
  section.innerHTML = '<h2>她会办的事</h2><p id="agent-status" role="status">正在读取 Harness 状态</p>' + (notebook ? '<label for="agent-mode">Harness 权限</label><select id="agent-mode"><option value="workspace">工作区办事 · 文件、代码与终端</option><option value="desktop">电脑操作 · 当前 Windows 用户完整权限</option><option value="chat">只聊天 · 可追问，不操作电脑文件</option></select><p class="note" id="agent-mode-note"></p><label for="agent-workspace">工作目录</label><input id="agent-workspace" type="text" readonly><button id="agent-workspace-choose" type="button">选择目录</button><p class="note">权限与目录随“保存设置”生效并开启新对话。电脑模式可操作工作区外文件与其他应用；不提升为管理员。</p><button id="agent-prepare-upgrade" type="button">准备自身升级候选</button><p id="agent-upgrade-result" class="note"></p>' : '') + '<div class="buttons"><button id="agent-stop" type="button">停止当前任务</button></div><div id="agent-requests" aria-live="polite"></div><details><summary>实际执行记录</summary><div id="agent-tools"></div></details><p class="note">工具执行结果与聊天结论分别显示；中断不代表回滚已有文件。自身升级先修改候选副本，再交给你和 Codex 审阅。</p>';
  if (notebook) { const anchor = document.getElementById('settings-save').parentElement; anchor.before(section); } else document.querySelector('main').insertBefore(section, document.querySelector('#page-chat'));
  const $ = id => document.getElementById(id); let revision = -1, configuredMode = '';
  async function command(input) { const result = await host.agentCommand(input); if (!result.ok) throw Error(result.error || '请求已过期'); return result; }
  $('agent-stop').onclick = () => command({ action: 'stop' }).catch(error => { $('agent-status').textContent = error.message; });
  if (notebook) {
    function modeNote() { $('agent-mode-note').textContent = { chat: '她可交流和提出问题，不使用终端、文件或电脑工具。', workspace: '启用正式 Harness Agent：文件读写、搜索、PowerShell、技能与多步任务。越出工作区的写入或需更高权限的命令会请求你决定。', desktop: '在你指定的任务中，使用当前账户权限执行程序，并读取、操作真实窗口控件。此模式不受工作区写入范围限制；不自动发消息、付款或删除。' }[$('agent-mode').value]; }
    $('agent-mode').onchange = modeNote; modeNote();
    $('agent-workspace-choose').onclick = async () => { try { const value = await command({ action: 'workspace' }); if (value.path) $('agent-workspace').value = value.path; } catch (error) { $('agent-status').textContent = error.message; } };
    $('agent-prepare-upgrade').onclick = async () => { $('agent-prepare-upgrade').disabled = true; try { const { value } = await command({ action: 'upgrade' }); $('agent-upgrade-result').textContent = '候选已准备：' + value.candidate + '。请告诉她需要修改什么；交接文件：' + value.handoff; } catch (error) { $('agent-upgrade-result').textContent = error.message; } finally { $('agent-prepare-upgrade').disabled = false; } };
  }
  function render(value) {
    if (!value || value.revision < revision) return; revision = value.revision;
    if (value.mode) configuredMode = value.mode;
    const modes = { chat: '只聊天', workspace: '工作区办事', desktop: '电脑操作（当前账户完整访问）' }, runtime = value.runtime;
    $('agent-status').textContent = (configuredMode ? '已保存：' + modes[configuredMode] + '。' : '') + (value.pending ? '正在等你决定下一步。' : value.active ? 'Harness 正在执行工具。' : '收到你的任务后才会执行。') + (runtime ? ' ' + (runtime.connected ? '本轮实际：' : '最近一轮：') + runtime.sandbox + '；审批桥' + (runtime.approvalConnected ? '已连接' : '未就绪') + '。' : '尚未启动新的 Harness 会话。');
    $('agent-stop').disabled = false;
    $('agent-requests').replaceChildren();
    for (const request of value.requests) {
      const card = document.createElement('div'); card.className = 'agent-request'; const title = document.createElement('h3'); title.textContent = request.kind === 'approval' ? '允许这一步吗？' : '她有个问题'; card.append(title);
      if (request.kind === 'question') { const button = document.createElement('button'); button.textContent = '在聊聊中回答她'; button.onclick = () => host.openReader(); card.append(button); }
      else if (!notebook) { const note = document.createElement('p'); note.textContent = '请在小本本的习惯页回答。'; card.append(note); }
      else if (request.kind === 'approval') {
        const description = document.createElement('p'), detail = document.createElement('pre'); description.textContent = request.tool + '：' + request.reason; detail.textContent = JSON.stringify(request.arguments || {}, null, 2); card.append(description, detail);
        for (const [label, decision] of [['仅允许这一次', 'allowed-once'], ['拒绝', 'rejected']]) { const button = document.createElement('button'); button.textContent = label; button.onclick = () => command({ action: 'answer', id: request.id, decision }).catch(error => { description.textContent = error.message; }); card.append(button); }
      } else {
        const fields = [];
        for (const question of request.questions || []) {
          const box = document.createElement('fieldset'), legend = document.createElement('legend'); legend.textContent = question.question || question.title || question.header || '需要你补充的信息'; box.append(legend); const options = [];
          for (const option of question.options || []) { const label = document.createElement('label'), input = document.createElement('input'); input.type = question.multiSelect ? 'checkbox' : 'radio'; input.name = request.id + question.id; input.value = typeof option === 'string' ? option : option.label; label.append(input, document.createTextNode(input.value)); box.append(label); options.push(input); }
          const text = document.createElement('textarea'); text.maxLength = 4000; text.placeholder = '也可以直接写下你的回答'; box.append(text); card.append(box); fields.push({ question, options, text });
        }
        const send = document.createElement('button'); send.textContent = '回答她'; send.onclick = () => command({ action: 'answer', id: request.id, answers: fields.map(field => ({ id: field.question.id, selected: field.options.filter(input => input.checked).map(input => input.value), custom: field.text.value })) }).catch(error => { title.textContent = error.message; }); card.append(send);
      }
      $('agent-requests').append(card);
    }
    $('agent-tools').replaceChildren(...value.tools.slice(-30).reverse().map(tool => {
      const item = document.createElement('details'), name = document.createElement('summary'), args = document.createElement('pre'), result = document.createElement('pre'); name.textContent = tool.name + ' · ' + ({ running: '执行中', completed: '已返回结果', failed: '失败', interrupted: '已中断' }[tool.status] || tool.status); args.textContent = JSON.stringify(tool.arguments, null, 2); result.textContent = tool.result || ''; item.append(name, args, result); return item;
    }));
  }
  host.onAgent(render); host.getAgent().then(render).catch(error => { $('agent-status').textContent = error.message; });
})();
