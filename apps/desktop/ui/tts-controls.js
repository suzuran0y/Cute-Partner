(() => {
  'use strict';
  const host = window.desktop, section = document.createElement('section'); section.className = 'settings-panel voice-settings';
  section.innerHTML = '<div class="food-heading"><h2>语音</h2><button id="voice-info-open" class="icon-button info-button" type="button" aria-label="语音说明">i</button></div><label class="voice-switch"><input id="tts-enabled" type="checkbox" role="switch">开启语音</label><p id="tts-notice" role="status"></p><div id="voice-options" hidden><label for="tts-voice">音色</label><select id="tts-voice"></select><p id="voice-module-status" role="status"></p><label for="tts-volume">音量 <output id="tts-volume-label"></output></label><input id="tts-volume" type="range" min="0" max="1" step="0.05"><label for="tts-rate">语速 <output id="tts-rate-label"></output></label><input id="tts-rate" type="range" min="-3" max="3" step="1"><div id="tts-natural-options"><label for="tts-style">说话风格</label><select id="tts-style"><option value="natural">自然</option><option value="soft">轻柔</option><option value="happy">开心</option><option value="calm">平静</option></select><label class="voice-switch"><input id="tts-streaming" type="checkbox">分块播放</label></div><div class="buttons"><button id="tts-save" type="button">保存声音</button><button id="tts-preview" type="button">试听一句</button><button id="tts-stop" type="button">停止说话</button><button id="voice-reload" type="button" hidden>重新加载</button></div><details id="voice-create-panel"><summary>制作一个音色</summary><p class="note">准备3–30秒清晰单人录音（WAV/FLAC/MP3），填写其中说的话。</p><button id="voice-reference" type="button">选择参考录音</button><p id="voice-reference-name" class="note">尚未选择</p><label for="voice-name">音色名称</label><input id="voice-name" type="text" maxlength="40" placeholder="给这个声音起个名字"><label for="voice-transcript">录音对应文字</label><textarea id="voice-transcript" maxlength="500" placeholder="按录音原文填写，不需要添加提示词…"></textarea><button id="voice-create" type="button">生成并保存音色</button><p id="voice-create-notice" role="status"></p></details></div><dialog id="voice-info" aria-labelledby="voice-info-title"><div class="food-heading"><h2 id="voice-info-title">关于她的声音</h2><button id="voice-info-close" class="icon-button" type="button" aria-label="关闭说明">×</button></div><p>Windows声音随基础程序提供调用能力，使用系统已安装的音色，不需要安装CosyVoice3。CosyVoice3在本机运行，需要另装可选语音包。开启语音或切换自然音色后提前加载，准备好后保留模型直到关闭语音或退出程序，会持续占用部分显存。预加载省去后续冷启动，但新句子仍需要合成时间。</p><p>自然语音可以选择自然、轻柔、开心和平静风格，保持所选音色；实际表达请通过试听确认。默认语速支持分块生成和连续播放，先缓冲少量音频，减少等待整句生成；较快/较慢语速仍按整句合成，保留语速效果。关闭分块播放可使用整句模式。设备合成速度不足时仍可能等待后续音频。</p><p>首次默认关闭；已有声音开关会保留。开启后自动说重点，也可主动点读。文字交流模式始终静默，语音输入快捷键沿用原设置。</p><p>自制音色使用参考音频提取特征，无需训练或云服务。支持20MB以内、3–30秒、单/双声道、8–96kHz的WAV/FLAC/MP3。尽量避免伴奏、回声和多人混说，文字应与录音一致。MP3在本机自动转换为WAV副本；原文件不修改，副本和音色特征保存在本机，重启后可继续选择；中断失败的准备材料不出现在音色列表中。</p><p>官方示例仅用于试听，最终内置音色仍由你决定。公开发布音色前需确认参考声音可随程序分发。关闭语音不会删除已保存的音色。</p></dialog>';
  document.getElementById('page-voice').append(section); const $ = id => document.getElementById(id);
  let saved, moduleValue, optionsLoaded = false, loadingOptions, busy = false, referenceToken;
  function labels() { $('tts-volume-label').textContent = Math.round(Number($('tts-volume').value) * 100) + '%'; const rate = Number($('tts-rate').value); $('tts-rate-label').textContent = !rate ? '正常' : rate > 0 ? '较快 ' + rate : '较慢 ' + Math.abs(rate); }
  function visible() { $('voice-options').hidden = !$('tts-enabled').checked; $('tts-natural-options').hidden = !($('tts-voice').value || saved?.voice || '').startsWith('cosyvoice3:'); }
  function fill(settings) { saved = settings; $('tts-enabled').checked = settings.enabled; $('tts-volume').value = settings.volume; $('tts-rate').value = settings.rate; $('tts-style').value = settings.style || 'natural'; $('tts-streaming').checked = settings.streaming !== false; $('tts-voice').value = settings.voice; labels(); visible(); }
  function moduleState(value) {
    moduleValue = value;
    const phase = { loading: '正在预加载声音…', recovering: '正在重新准备声音（仅重试一次）…', preparing: '正在准备音色…', ready: '声音已就绪', stopping: '正在停止声音…', idle: '等待加载', error: '声音暂不可用' }[value.phase] || value.phase;
    $('voice-module-status').textContent = value.error || (value.selection === 'cosyvoice3' ? !value.installed ? 'CosyVoice3语音包尚未安装，可选择Windows声音。' : phase : 'Windows声音 · 随时可以说话');
    $('voice-create-panel').hidden = value.selection !== 'cosyvoice3' || !value.installed;
    $('voice-reload').hidden = value.selection !== 'cosyvoice3' || !['error', 'idle'].includes(value.phase);
  }
  async function loadOptions(force = false) {
    if (loadingOptions) return loadingOptions;
    if (optionsLoaded && !force) return;
    loadingOptions = (async () => { const result = await host.getVoices(); if (!result.ok) throw Error(result.error); const selected = $('tts-voice').value || saved.voice;
      $('tts-voice').replaceChildren(...result.voices.map(voice => { const option = document.createElement('option'); option.value = voice.name; option.textContent = voice.label || voice.name; return option; }));
      if (![...$('tts-voice').options].some(o => o.value === selected)) { const missing = document.createElement('option'); missing.value = selected; missing.textContent = selected.startsWith('cosyvoice3:') ? '已选音色暂不可用，请重新选择' : selected; $('tts-voice').append(missing); }
      $('tts-voice').value = selected; optionsLoaded = true; visible();
    })(); try { await loadingOptions; } finally { loadingOptions = null; }
  }
  async function save() {
    if (!saved) throw Error('设置尚未就绪');
    const result = await host.saveTts({ enabled: $('tts-enabled').checked, voice: $('tts-voice').value || saved.voice, volume: Number($('tts-volume').value), rate: Number($('tts-rate').value), style: $('tts-style').value, streaming: $('tts-streaming').checked });
    if (!result.ok) throw Error(result.error); saved = result.value.settings; visible(); return result;
  }
  async function operation(action) { if (busy) return; busy = true; $('tts-enabled').disabled = true; try { await action(); } catch (error) { $('tts-notice').textContent = error.message; if (saved) { $('tts-enabled').checked = saved.enabled; visible(); } } finally { busy = false; $('tts-enabled').disabled = false; } }
  $('tts-enabled').disabled = true;
  Promise.all([host.getTts(), host.getVoiceModule()]).then(async ([state, module]) => { fill(state.settings); moduleState(module); if (saved.enabled) await loadOptions(); }).catch(error => { $('tts-notice').textContent = error.message; }).finally(() => { $('tts-enabled').disabled = false; });
  host.onVoiceModule(moduleState);
  $('tts-enabled').onchange = () => { visible(); void operation(async () => { if ($('tts-enabled').checked) await loadOptions(); await save(); $('tts-notice').textContent = saved.enabled ? '语音已开启' : '语音已关闭'; }); };
  $('tts-voice').onchange = () => operation(async () => { await save(); $('tts-notice').textContent = '音色已切换'; });
  $('tts-style').onchange = () => operation(async () => { await save(); $('tts-notice').textContent = '风格已保存，可以试听'; });
  $('tts-streaming').onchange = () => operation(async () => { await save(); $('tts-notice').textContent = saved.streaming ? '已启用分块播放' : '已切换整句播放'; });
  $('tts-volume').oninput = labels; $('tts-rate').oninput = labels;
  $('tts-save').onclick = () => operation(async () => { await save(); $('tts-notice').textContent = '声音已保存'; });
  $('tts-preview').onclick = () => operation(async () => { await save(); const result = await host.ttsCommand('preview'); if (!result.ok) throw Error(result.error); });
  $('tts-stop').onclick = () => operation(async () => { const result = await host.ttsCommand('stop'); if (!result.ok) throw Error(result.error); });
  $('voice-reload').onclick = () => operation(async () => { await save(); });
  $('voice-reference').onclick = async () => { try { const result = await host.selectVoiceReference(); if (!result.ok) throw Error(result.error); if (result.reference) { referenceToken = result.reference.token; $('voice-reference-name').textContent = result.reference.name; } } catch (error) { $('voice-create-notice').textContent = error.message; } };
  $('voice-create').onclick = async () => {
    $('voice-create').disabled = true; $('voice-create-notice').textContent = '正在提取音色并保存…';
    try { const result = await host.createVoice({ token: referenceToken, name: $('voice-name').value, text: $('voice-transcript').value }); if (!result.ok) throw Error(result.error); referenceToken = null; $('voice-reference-name').textContent = '尚未选择';
      await loadOptions(true); $('tts-voice').value = 'cosyvoice3:' + result.profile.id;
      if ($('tts-enabled').checked) await operation(async () => { await save(); });
      $('voice-create-notice').textContent = '已保存「' + result.profile.name + '」，可在音色列表中再次选择。';
    } catch (error) { $('voice-create-notice').textContent = error.message; } finally { $('voice-create').disabled = false; }
  };
  $('voice-info-open').onclick = () => $('voice-info').showModal(); $('voice-info-close').onclick = () => $('voice-info').close();
  host.onTts(state => { $('tts-notice').textContent = state.error || (state.phase === 'playing' ? '正在说话' : state.phase === 'synthesizing' ? '正在准备声音' : state.phase === 'cancelled' ? '已停止说话' : ''); });
})();
