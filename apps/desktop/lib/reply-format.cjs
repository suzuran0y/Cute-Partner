'use strict';
const CONTROL = /<\/?(?:voice|body)>/;
function spokenSafe(text, max = 600) { return !!text.trim() && text.length <= max && !CONTROL.test(text) && !/```|~~~|https?:\/\/|\|.+\||<\|/.test(text); }
function plainSpoken(text) { return text.replace(/[#*_>\x60]/g, '').trim(); }
function result(text, spokenText = '', voiceUnavailable = '', replyFormatWarning = '', cloudText = spokenText) { return { text, spokenText, voiceUnavailable, replyFormatWarning, cloudText }; }
// Only a leading envelope is protocol. Code examples elsewhere remain ordinary body text.
function replyFormat(raw, final = false) {
  let source = raw.replace(/^\uFEFF/, '').trimStart(), wrapper = false;
  const fenced = /^\x60{3}(?:xml|html|text)?[ \t]*\r?\n([\s\S]*?)\r?\n\x60{3}[ \t]*$/.exec(source);
  if (fenced && /^<(?:voice|body)>/.test(fenced[1].trimStart())) { source = fenced[1].trimStart(); wrapper = true; }
  if (!final && ['<voice>', '<body>'].some(tag => tag.startsWith(source) && source.length < tag.length)) return result('');
  if (source.startsWith('<voice>')) {
    const close = source.indexOf('</voice>', 7), body = source.indexOf('<body>', close < 0 ? 7 : close + 8);
    if (close < 0) {
      const text = body >= 0 ? source.slice(body + 6).replace(/<\/body>\s*$/, '') : final ? source.slice(7) : '';
      return result(text, '', final ? '口语段未闭合，未自动朗读；正文已保留' : '');
    }
    const voice = source.slice(7, close).trim(), spoken = plainSpoken(voice), safe = spokenSafe(voice) && !!spoken, bodyClosed = body >= 0 && /<\/body>\s*$/.test(source);
    let text = body >= 0 ? source.slice(body + 6).replace(/<\/body>\s*$/, '') : source.slice(close + 8).trimStart();
    if (!final) for (let n = 1; n < 7; n++) if (text.endsWith('</body>'.slice(0, n))) { text = text.slice(0, -n); break; }
    if (final && !text.trim()) text = voice;
    const warning = !final ? '' : body < 0 && source.slice(close + 8).trim() ? '口语段之后有未标记的正文，已保留。' : body >= 0 && !bodyClosed ? '正文缺少结束标记；已保留收到的正文，完整口语稿可独立播放。' : wrapper ? '已按语音封套解析外层代码围栏。' : '';
    return result(text, final && safe ? spoken : '', final && !safe ? '口语稿为空、过长或包含不适合朗读的内容，正文已保留' : '', warning, safe ? spoken : '');
  }
  if (source.startsWith('<body>')) {
    let text = source.slice(6).replace(/<\/body>\s*$/, '');
    if (!final) for (let n = 1; n < 7; n++) if (text.endsWith('</body>'.slice(0, n))) { text = text.slice(0, -n); break; }
    const short = spokenSafe(text, 180), spoken = final && short ? plainSpoken(text) : '';
    return result(text, spoken, final && !short ? '本条保留全文，未提供简短口语稿' : '', final && !/<\/body>\s*$/.test(source) ? '正文缺少结束标记；已保留收到的文字。' : '');
  }
  const short = spokenSafe(source, 180);
  return result(raw, final && short ? plainSpoken(source) : '', final && !short ? '本条保留全文，未提供简短口语稿' : '');
}
function committedReply(raw, { interrupted = false, finishKind, truncated = false } = {}) {
  const formatted = replyFormat(raw, true), intermediate = finishKind === 'tool-calls';
  const incomplete = interrupted || truncated || finishKind !== undefined && !['stop', 'tool-calls'].includes(finishKind);
  return { ...formatted, finishKind, speechEligible: !incomplete && !intermediate && !!formatted.spokenText,
    ...(incomplete ? { spokenText: '', voiceUnavailable: '回复已中断或被截断，未自动朗读；正文已保留' } : intermediate ? { spokenText: '', voiceUnavailable: '' } : {}),
    replyCompletion: incomplete ? 'incomplete' : intermediate ? 'intermediate' : 'normal' };
}
function canSpeakReply(message) { return message?.role === 'assistant' && message.status === 'completed' && message.speechEligible !== false && !!message.spokenText; }
// Never expose detailed/progress text as a cloud fallback, even with sound disabled.
function cloudReply(message) {
  const normal = message?.status !== 'interrupted' && message?.replyCompletion !== 'intermediate' && message?.replyCompletion !== 'incomplete';
  if (normal && (message.cloudText || message.spokenText)) return { kind: 'reply', text: message.cloudText || message.spokenText, streaming: message.status === 'streaming' };
  return { kind: 'status', text: message?.status === 'streaming' ? '让我想一想…' : normal && message?.replyCompletion !== 'intermediate' ? '这条内容记在历史里了，点“全文”查看。' : '过程记在历史里，我还在处理。' };
}
module.exports = { replyFormat, committedReply, canSpeakReply, cloudReply };
