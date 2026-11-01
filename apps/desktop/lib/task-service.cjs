'use strict';
const fs = require('node:fs/promises');
const sync = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { setTimeout: wait } = require('node:timers/promises');
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

class TaskService extends EventEmitter {
  constructor(dataRoot, options = {}) {
    super();
    this.root = path.resolve(dataRoot);
    this.session = randomUUID();
    this.delayMs = options.delayMs ?? 650;
    this.fileCount = options.fileCount ?? 18;
    this.current = null;
    this.job = null;
    this.history = [];
    sync.mkdirSync(this.root, { recursive: true });
    if (sync.lstatSync(this.root).isSymbolicLink()) throw Error('数据目录不能为链接');
    this.journal = path.join(this.root, 'events.jsonl');
    if (sync.existsSync(this.journal)) {
      const lines = sync.readFileSync(this.journal, 'utf8').trim().split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const previous = JSON.parse(lines[i]);
          if (!previous.task_id) continue;
          this.current = { ...previous, session_id: this.session, event_id: randomUUID(), sequence: previous.sequence + 1, observed_at: new Date().toISOString(), restored: true };
          if (!TERMINAL.has(previous.task_state)) Object.assign(this.current, { task_state: 'failed', phase: 'interrupted', message: '上次执行已中断，保留已有文件；没有自动重放操作。', can_cancel: false });
          break;
        } catch { /* An interrupted final journal line is skipped. */ }
      }
    }
  }
  snapshot() { return this.current ? structuredClone(this.current) : null; }
  get busy() { return !!this.current && !TERMINAL.has(this.current.task_state); }
  publish(state, phase, message, extra = {}, started = false) {
    const e = { ...this.current, ...extra, schema_version: '0.1', session_id: this.session, event_id: randomUUID(), sequence: (this.current?.sequence ?? -1) + 1, observed_at: new Date().toISOString(), source: 'local_executor', task_state: state, phase, message, can_cancel: !TERMINAL.has(state) && state !== 'cancel_requested' };
    sync.appendFileSync(this.journal, JSON.stringify(e) + '\n');
    this.current = e;
    this.history.push(e);
    this.emit('state', { type: started ? 'task-started' : 'state', event: structuredClone(e) });
    return e;
  }
  start(command, options = {}) {
    if (typeof command !== 'string' || !command.trim() || command.length > 1000) throw Error('请输入 1–1000 字的验收指令');
    if (this.busy) throw Error('已有任务正在执行，请先停止或等待完成');
    const kind = options.failure ? 'failure' : /整理|分类/.test(command) ? 'organize' : /笔记|记录|写/.test(command) ? 'note' : null;
    if (!kind) throw Error('当前为本地指令模式，请输入“整理测试文件”或“写一份测试笔记”；尚未连接大模型。');
    const id = randomUUID();
    this.current = { task_id: id, sequence: -1, command: command.trim(), activity: kind === 'organize' ? 'files.organize' : 'software.input', run_dir: path.join(this.root, 'runs', id), progress: null, result: null };
    this.abort = new AbortController();
    const signal = this.abort.signal;
    this.publish('planning', 'planning', '已接收指令，准备本地验收任务。', { kind }, true);
    this.job = new Promise(resolve => setImmediate(resolve)).then(() => this.execute(kind, signal));
    return this.snapshot();
  }
  cancel() {
    if (!this.busy) return this.snapshot();
    if (this.current.task_state !== 'cancel_requested') this.publish('cancel_requested', 'stopping', '已请求停止；正在等待当前文件操作返回。');
    this.abort.abort();
    return this.snapshot();
  }
  check(signal) { signal.throwIfAborted(); }
  async pause(signal, multiplier = 1) {
    this.check(signal);
    await wait(this.delayMs * multiplier, undefined, { signal });
    this.check(signal);
  }
  async ownDirectory(target) {
    const resolved = path.resolve(target);
    if (!resolved.startsWith(this.root + path.sep)) throw Error('目标超出宿主验收目录');
    await fs.mkdir(resolved, { recursive: true });
    let cursor = resolved;
    while (cursor !== this.root) {
      const s = await fs.lstat(cursor);
      if (s.isSymbolicLink() || !s.isDirectory()) throw Error('验收目录包含链接或非目录对象');
      cursor = path.dirname(cursor);
    }
  }
  async execute(kind, signal) {
    const run = this.current.run_dir;
    const moved = [];
    try {
      await this.ownDirectory(run);
      await this.pause(signal, 1.2);
      if (kind === 'failure') throw Error('受控失败验收：执行器主动返回异常，没有修改个人文件。');
      if (kind === 'organize') {
        const input = path.join(run, '待整理');
        await this.ownDirectory(input);
        const extensions = ['.txt', '.md', '.json', '.csv', '.log', '.txt'];
        const plan = [];
        for (let i = 0; i < this.fileCount; i++) {
          this.check(signal);
          const ext = extensions[i % extensions.length], name = `样例-${String(i + 1).padStart(2, '0')}${ext}`;
          const body = Buffer.from(`desktop-host acceptance fixture\n${i}\n${this.current.task_id}\n`, 'utf8');
          await fs.writeFile(path.join(input, name), body, { flag: 'wx' });
          plan.push({ name, category: ['.json', '.csv'].includes(ext) ? '数据' : ext === '.log' ? '日志' : '文档', sha256: hash(body) });
        }
        this.publish('executing', 'inspecting', `已生成 ${plan.length} 个测试文件，正在检查内容。`, { progress: { completed: 0, total: plan.length, unit: 'files' } });
        await this.pause(signal);
        for (const item of plan) {
          this.check(signal);
          const source = path.join(input, item.name), folder = path.join(run, item.category), target = path.join(folder, item.name);
          await this.ownDirectory(folder);
          const stat = await fs.lstat(source);
          if (!stat.isFile() || stat.isSymbolicLink()) throw Error('测试文件类型不符合计划');
          if (hash(await fs.readFile(source)) !== item.sha256) throw Error('文件在整理前发生变化');
          this.check(signal);
          // Destination creation is exclusive. Finish this one move before acknowledging cancellation.
          await fs.copyFile(source, target, sync.constants.COPYFILE_EXCL);
          if (hash(await fs.readFile(target)) !== item.sha256 || hash(await fs.readFile(source)) !== item.sha256) throw Error('移动前内容核验失败；已保留原文件');
          await fs.unlink(source);
          moved.push({ ...item, path: `${item.category}/${item.name}` });
          this.publish(this.abort.signal.aborted ? 'cancel_requested' : 'executing', this.abort.signal.aborted ? 'stopping' : 'moving', `已整理 ${moved.length} / ${plan.length} 个测试文件。`, { progress: { completed: moved.length, total: plan.length, unit: 'files' } });
          await this.pause(signal);
        }
        this.publish('verifying', 'verifying', '正在核对目录与每个文件的 SHA-256。');
        await this.pause(signal);
        this.check(signal);
        if ((await fs.readdir(input)).length !== 0) throw Error('原目录仍有未整理的文件');
        for (const item of moved) {
          this.check(signal);
          if (hash(await fs.readFile(path.join(run, item.path))) !== item.sha256) throw Error('文件内容核验失败');
        }
      } else {
        const target = path.join(run, '验收笔记.md');
        await fs.writeFile(target, '# 桌宠宿主验收笔记\n\n', { flag: 'wx' });
        const lines = ['这份笔记由本地执行器实际写入。', '可爱的助手由本地宿主管理桌面驻留。', '任务结果由执行器核验，角色姿态只负责反馈。', '每条文字写入后发布真实进度。', '取消请求会停止后续写入。', '任务成功由文件内容核验触发。', '动画完成不会改变任务结果。', '本轮没有调用付费模型 API。'];
        let expected = '# 桌宠宿主验收笔记\n\n';
        for (let i = 0; i < lines.length; i++) {
          this.check(signal);
          const line = `- ${lines[i]}\n`;
          await fs.appendFile(target, line);
          expected += line;
          this.publish(this.abort.signal.aborted ? 'cancel_requested' : 'executing', this.abort.signal.aborted ? 'stopping' : 'typing', `正在写入验收笔记：${i + 1} / ${lines.length}。`, { progress: { completed: i + 1, total: lines.length, unit: 'lines' } });
          await this.pause(signal);
        }
        this.publish('verifying', 'verifying', '笔记已写入，正在回读核验。');
        await this.pause(signal);
        if (await fs.readFile(target, 'utf8') !== expected) throw Error('笔记内容与预期不一致');
        moved.push({ path: '验收笔记.md', sha256: hash(Buffer.from(expected)) });
      }
      this.check(signal);
      const result = { verified: true, artifacts: moved, verified_at: new Date().toISOString(), note: '仅操作本次自动生成的验收文件；执行器不依赖角色动画，不调用模型服务。' };
      await fs.writeFile(path.join(run, '核验结果.json'), JSON.stringify(result, null, 2), { flag: 'wx' });
      this.check(signal);
      this.publish('succeeded', 'verified', '任务完成，文件内容核验通过。', { result });
    } catch (error) {
      if (signal.aborted) this.publish('cancelled', 'stopped', '已停止后续操作，已有文件保持原样。', { result: { verified: false, partial_artifacts: moved } });
      else this.publish('failed', 'failed', `执行失败：${error.message}`, { result: { verified: false, partial_artifacts: moved } });
    }
  }
  async stop() { this.cancel(); await this.job; }
}
module.exports = { TaskService, TERMINAL, hash };
