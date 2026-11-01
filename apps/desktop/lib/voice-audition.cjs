'use strict';
// Original comparison scripts retained for a future local-only audition. No provider profiles.
const SCENES = Object.freeze([
  { id: 'hello', name: '日常问候', text: '你回来啦。今天想先聊聊天，还是一起做点事情？' },
  { id: 'comfort', name: '安慰陪伴', text: '今天辛苦了，先歇一会儿吧。想说的话，我在听。' },
  { id: 'explain', name: '简短解释', text: '我先说重点：声音和说话的节奏，要一起调整。详细内容放在小本本里，你可以慢慢看。' },
  { id: 'success', name: '完成反馈（虚构试听）', text: '这是试听示例：笔记已经整理好了，也检查过内容。要一起看看吗？' },
  { id: 'failure', name: '失败反馈（虚构试听）', text: '这是试听示例：这次没能连接上服务。我先停在这里，等你方便时再试。' }
]);
module.exports = { SCENES };
