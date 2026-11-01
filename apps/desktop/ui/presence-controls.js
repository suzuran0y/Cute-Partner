(() => {
  'use strict';
  const $ = id => document.getElementById(id), host = window.desktop;
  if (!host) { $('presence-status').textContent = '请通过“启动桌宠.cmd”打开桌面控制面板'; return; }
  let paused = false, alwaysOnTop = true;
  let taskRevision = -1, task = null, taskSubmitting = false;
  function showTask(update) {
    if (!update || update.revision < taskRevision) return;
    taskRevision = update.revision; task = update; updateTask();
  }
  function updateTask() {
    const event = task?.snapshot, terminal = ['succeeded', 'failed', 'cancelled'].includes(event?.task_state), busy = !!event && !terminal;
    $('task-state').textContent = AvatarTaskPresentation.describe(task).label;
    $('task-message').textContent = !task?.connected && busy ? '连接中断，后台任务可能仍在运行；可请求停止或重连读取结果。' : event?.message || '仅操作本次新建的测试目录。';
    for (const id of ['task-organize', 'task-note', 'task-failure']) $(id).disabled = taskSubmitting || busy || !task?.connected;
    $('task-cancel').disabled = taskSubmitting || !busy || event?.task_state === 'cancel_requested';
    $('task-disconnect').disabled = !task?.connected; $('task-reconnect').disabled = taskSubmitting;
    const progress = event?.progress; $('task-progress').hidden = !progress;
    if (progress) { $('task-progress').max = progress.total; $('task-progress').value = progress.completed; }
    $('task-result').textContent = event?.task_state === 'succeeded' ? `已核验 ${event.result?.artifacts?.length ?? 0} 个文件，结果记录已保存。` : event?.task_state === 'cancelled' ? '执行器已确认停止，已有文件保留。' : event?.task_state === 'failed' ? '任务失败，原因见上方；未报告成功。' : progress ? `实际进度：${progress.completed} / ${progress.total}` : '';
    $('task-path').textContent = event?.run_dir ? `本次目录：${event.run_dir}` : '';
  }
  async function taskCommand(action) {
    taskSubmitting = true; $('task-notice').textContent = ''; updateTask();
    try {
      const result = await host.taskCommand(action);
      if (!result.ok) throw Error(result.error);
      if (action === 'cancel') $('task-notice').textContent = '停止请求已发送，等待实际停止确认。';
    } catch (error) { $('task-notice').textContent = error.message; }
    finally { taskSubmitting = false; updateTask(); }
  }
  function show(info) {
    paused = !!info.paused;
    alwaysOnTop = info.alwaysOnTop !== false;
    $('topmost').textContent = '过来待着 · ' + (alwaysOnTop ? '已开启' : '已关闭'); $('topmost').setAttribute('aria-pressed', String(alwaysOnTop));
    $('pause').textContent = paused ? '继续动态' : '暂停动态';
    $('presence-status').textContent = info.status || '等待角色加载';
    $('presence-detail').textContent = info.error || (info.visible === false ? '角色已隐藏，自然动态停止计时；显示后继续。' : '关闭面板可继续驻留；Ctrl+Alt+Shift+P 显示或隐藏角色。');
    $('scale').value = String(info.scale || 1); $('scale-value').value = Math.round((info.scale || 1) * 100) + '%';
    $('diagnostics').textContent = `原生模型：${info.ready ? '已就绪' : '尚未就绪'}\n有效参数：${info.parameters || 0} / 26\n纹理：${info.textures || 0} / 2\n绘制帧数：${info.frames || 0}\n资源：cute-partner-character-v1\n新增动作视觉验收：待用户完成`;
  }
  const run = fn => Promise.resolve().then(fn).catch(error => { $('presence-detail').textContent = error.message; });
  $('show').onclick = () => run(() => host.showPet());
  $('hide').onclick = () => run(() => host.presenceCommand('hide'));
  $('home').onclick = () => run(() => host.presenceCommand('home'));
  $('pause').onclick = () => run(() => host.presenceCommand(paused ? 'resume' : 'pause'));
  $('reload').onclick = () => run(() => host.presenceCommand('reload'));
  $('quit').onclick = () => run(() => host.presenceCommand('quit'));
  $('topmost').onclick = () => run(() => host.presenceCommand(alwaysOnTop ? 'topmost-off' : 'topmost-on'));
  $('scale').oninput = event => { $('scale-value').value = Math.round(Number(event.target.value) * 100) + '%'; run(() => host.setScale(Number(event.target.value))); };
  host.onPresence(show); run(async () => show(await host.getPresence()));
  for (const action of ['organize', 'note', 'failure', 'cancel', 'disconnect', 'reconnect']) $('task-' + action).onclick = () => taskCommand(action);
  host.onTask(showTask); run(async () => showTask(await host.getTask()));
})();
