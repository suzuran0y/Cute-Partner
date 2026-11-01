'use strict';
const fs = require('node:fs'), path = require('node:path'), { randomUUID } = require('node:crypto');
const lock = require('../optional-modules/cosyvoice3/assets.lock.json');
const PROFILE_ID = /^voice-[a-f0-9-]{36}$/;
function readJson(file) { if (fs.statSync(file).size > 16384) throw Error('音色记录过大'); return JSON.parse(fs.readFileSync(file, 'utf8')); }
function validMetadata(value) { return typeof value?.name === 'string' && value.name.trim().length >= 1 && value.name.length <= 40 && !/[\x00-\x1f]/.test(value.name) && typeof value.text === 'string' && value.text.trim().length >= 1 && value.text.length <= 500 && !/[<>\x00-\x08]/.test(value.text); }
class VoiceProfiles {
  constructor(root, bundled = path.join(__dirname, '../assets/voice-presets')) { this.root = path.join(root, 'voice-profiles'); this.bundled = bundled; }
  find(id) {
    if (!PROFILE_ID.test(id || '')) throw Error('音色编号无效');
    for (const base of [this.bundled, this.root]) {
      try {
        const directory = path.join(base, id), value = readJson(path.join(directory, 'profile.json'));
        if (value.id !== id || !validMetadata(value) || value.engineRevision !== lock.engine.revision || value.modelRevision !== lock.model.revision || value.status !== 'ready' || !fs.statSync(path.join(directory, 'reference.wav')).isFile() || !fs.statSync(path.join(directory, 'prompt.pt')).isFile()) continue;
        return { directory, ...value, bundled: base === this.bundled };
      } catch {}
    }
    throw Error('音色尚未生成或版本不兼容');
  }
  list() {
    const ids = new Set(); for (const base of [this.bundled, this.root]) { try { for (const id of fs.readdirSync(base)) if (PROFILE_ID.test(id)) ids.add(id); } catch {} }
    return [...ids].slice(0, 100).flatMap(id => { try { const v = this.find(id); return [{ id, name: v.name, seconds: v.seconds, bundled: v.bundled }]; } catch { return []; } });
  }
  defaultVoice() { try { const id = readJson(path.join(this.bundled, 'manifest.json')).defaultVoiceId; this.find(id); return 'cosyvoice3:' + id; } catch { return null; } }
  prepare(source, input) {
    if (!validMetadata(input)) throw Error('请输入音色名称（40字以内）和录音对应文字（500字以内，不含控制标记）');
    if (!['.wav', '.flac', '.mp3'].includes(path.extname(source).toLowerCase())) throw Error('请选择 WAV、FLAC 或 MP3 参考录音');
    const stat = fs.statSync(source); if (!stat.isFile() || stat.size < 44 || stat.size > 20000000) throw Error('参考录音须为20MB以内的音频文件');
    if (this.list().length >= 100) throw Error('已保存音色达到100个，请先使用已有音色');
    const id = 'voice-' + randomUUID(), directory = path.join(this.root, id); fs.mkdirSync(directory, { recursive: true });
    const audioFile = 'input' + path.extname(source).toLowerCase(); fs.copyFileSync(source, path.join(directory, audioFile), fs.constants.COPYFILE_EXCL);
    fs.writeFileSync(path.join(directory, 'pending.json'), JSON.stringify({ id, name: input.name.trim(), text: input.text.trim(), audioFile, engineRevision: lock.engine.revision, modelRevision: lock.model.revision }), { flag: 'wx' });
    return id;
  }
}
module.exports = { VoiceProfiles, PROFILE_ID, validMetadata };
