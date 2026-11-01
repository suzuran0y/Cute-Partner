'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const DEFAULTS = Object.freeze({ persona: '', memory: '', voiceShortcut: 'Ctrl', voiceAutoSend: true, communicationMode: 'voice', shortcutVersion: 2, agentMode: 'workspace', agentWorkspace: '' });
function validate(input) {
  if (!input || typeof input !== 'object') throw Error('设置格式错误');
  const next = { ...DEFAULTS, ...input };
  for (const [key, limit] of [['persona', 8000], ['memory', 16000]]) if (typeof next[key] !== 'string' || next[key].length > limit) throw Error(`${key === 'persona' ? '角色设定' : '记忆'}最多 ${limit} 字符`);
  if (typeof next.voiceShortcut !== 'string' || !/^(?:Ctrl|(?:Ctrl\+Alt|Ctrl\+Shift|Alt\+Shift|Ctrl\+Alt\+Shift)\+[A-Z0-9]|F(?:[2-9]|1[0-2]))$/.test(next.voiceShortcut)) throw Error('快捷键支持单击 Ctrl、F2–F12，或至少两个修饰键加字母/数字');
  if (next.voiceShortcut === 'Ctrl+Alt+Shift+P') throw Error('此快捷键已用于显示/隐藏角色');
  if (typeof next.voiceAutoSend !== 'boolean') throw Error('自动发送设置无效');
  if (!['voice', 'text'].includes(next.communicationMode)) throw Error('交流方式无效');
  if (!['chat', 'workspace', 'desktop'].includes(next.agentMode)) throw Error('Harness权限模式无效');
  if (typeof next.agentWorkspace !== 'string' || next.agentWorkspace.length > 500 || next.agentWorkspace && (!path.isAbsolute(next.agentWorkspace) || /[\x00-\x1f]/.test(next.agentWorkspace))) throw Error('请选择有效的绝对工作目录');
  next.shortcutVersion = 2;
  return Object.fromEntries(Object.keys(DEFAULTS).map(k => [k, next[k]]));
}
function contextRevision(value) { return createHash('sha256').update(value.persona + '\0' + value.memory + '\0' + (value.agentMode || 'workspace') + '\0' + (value.agentWorkspace || '')).digest('hex'); }
function importText(text, kind, extension) {
  if (!['persona', 'memory'].includes(kind) || typeof text !== 'string') throw Error('导入类型无效');
  if (extension === '.json') {
    let value; try { value = JSON.parse(text.replace(/^\uFEFF/, '')); } catch { throw Error('JSON 文件格式错误'); }
    if (typeof value === 'string') text = value;
    else if (typeof value?.[kind] === 'string') text = value[kind];
    else if (kind === 'memory' && Array.isArray(value?.memories) && value.memories.every(x => typeof x === 'string')) text = value.memories.join('\n');
    else throw Error('JSON 请使用字符串、persona/memory 文本字段，或 memories 字符串数组');
  }
  const result = validate({ ...DEFAULTS, [kind]: text.replace(/^\uFEFF/, '') }); return result[kind];
}
class CompanionSettings {
  constructor(root) { this.file = path.join(root, 'companion-settings.json'); this.value = { ...DEFAULTS }; try { const saved = JSON.parse(fs.readFileSync(this.file, 'utf8')); if (!saved.shortcutVersion && saved.voiceShortcut === 'Ctrl+Alt+V') saved.voiceShortcut = 'Ctrl'; this.value = validate(saved); } catch {} }
  state() { return { ...this.value, contextRevision: contextRevision(this.value) }; }
  save(input) {
    const next = validate(input); fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file + '.tmp', JSON.stringify(next, null, 2), { mode: 0o600 }); fs.renameSync(this.file + '.tmp', this.file); this.value = next; return this.state();
  }
}
module.exports = { CompanionSettings, validate, importText, contextRevision, DEFAULTS };
