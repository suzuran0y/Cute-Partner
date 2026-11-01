'use strict';
// Match a whole answer, never substrings in descriptions or negated chatter.
function speechDraft(question, transcript) {
  const text = String(transcript).trim(), normalized = text.normalize('NFKC').replace(/[。！!]+$/, '').replace(/^(?:我)?(?:就|还是)?(?:想要|想选|选择|选|要)\s*/, '').replace(/(?:就好|可以了|好了|吧|就行|就可以)$/, '').trim();
  const command = /^((?:第?[一二两三四五六七八九十\d]+(?:项|个|号)?)(?:[、，,和与及\s]+第?[一二两三四五六七八九十\d]+(?:项|个|号)?)*)$/.exec(normalized.replace(/两/g, '二'));
  if (command) {
    const numbers = command[1].match(/[一二三四五六七八九十\d]+/g).map(s => /^\d+$/.test(s) ? Number(s) : /^(?:十[一二]?|[一二三四五六七八九])$/.test(s) ? s === '十' ? 10 : s.startsWith('十') ? 10 + '一二三四五六七八九'.indexOf(s.slice(1)) + 1 : '一二三四五六七八九'.indexOf(s) + 1 : 0);
    if (numbers.length && (question.multiSelect || numbers.length === 1) && new Set(numbers).size === numbers.length && numbers.every(n => n >= 1 && n <= question.options.length)) return { selectedIds: numbers.map(n => question.options[n - 1].id), custom: '', other: false, method: 'speech-choice' };
  }
  const clean = s => s.normalize('NFKC').replace(/(?:[（(](?:推荐|建议|Recommended)[）)])$/, '').replace(/[\s。！!]/g, '');
  const wanted = clean(normalized), options = question.options || [];
  const exact = options.filter(o => clean(o.label) === wanted);
  if (wanted && exact.length === 1) return { selectedIds: [exact[0].id], custom: '', other: false, method: 'speech-choice' };
  if (question.multiSelect) {
    const parts = normalized.split(/和|以及|还有|、|，|,/).map(clean);
    const matches = parts.map(part => options.filter(o => clean(o.label) === part));
    if (parts.length > 1 && matches.every(m => m.length === 1) && new Set(matches.map(m => m[0].id)).size === parts.length) return { selectedIds: matches.map(m => m[0].id), custom: '', other: false, method: 'speech-choice' };
  }
  return { selectedIds: [], custom: text, other: !!question.options.length && !question.multiSelect, method: 'speech-text' };
}
function questionSpeech(question, index, total) {
  const text = String(question.question).trim();
  if (text.length <= 280) return text;
  const prefix = text.slice(0, 220), end = Math.max(prefix.lastIndexOf('。'), prefix.lastIndexOf('？'), prefix.lastIndexOf('！'));
  return (end >= 30 ? prefix.slice(0, end + 1) : '想听听你的想法，具体问题放在云朵里了。');
}
module.exports = { speechDraft, questionSpeech };
