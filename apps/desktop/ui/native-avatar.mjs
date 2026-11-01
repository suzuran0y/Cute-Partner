import { CubismFramework } from '/runtime/web/sdk/live2dcubismframework.js';
import { CubismUserModel } from '/runtime/web/sdk/model/cubismusermodel.js';
import { CubismMatrix44 } from '/runtime/web/sdk/math/cubismmatrix44.js';
import { CubismShaderManager_WebGL } from '/runtime/web/sdk/rendering/cubismshader_webgl.js';
import { InteractionMotionDriver } from '/runtime/web/interaction-driver.js';
import { loadActionLibrary } from '/runtime/web/action-library.js';

const BASE = new URL('/runtime/', location.origin);
const SHADERS = ['vertshadersrc.vert', 'vertshadersrcmasked.vert', 'vertshadersrcsetupmask.vert', 'fragshadersrcsetupmask.frag', 'fragshadersrcpremultipliedalpha.frag', 'fragshadersrcmaskpremultipliedalpha.frag', 'fragshadersrcmaskinvertedpremultipliedalpha.frag', 'vertshadersrccopy.vert', 'fragshadersrccopy.frag', 'fragshadersrccolorblend.frag', 'fragshadersrcalphablend.frag', 'vertshadersrcblend.vert', 'fragshadersrcpremultipliedalphablend.frag'];
// The character driver freezes its cached output while paused. Silence that owned
// cache before freezing; NativeAvatar remains the sole writer to the model.
class DesktopMotionDriver extends InteractionMotionDriver {
  silenceAudio() { this.setAudioLevel(0); this.mouthLevel = 0; if (this.output) this.output.ParamMouthOpenY = 0; }
}

export class NativeAvatar {
  constructor(canvas) {
    this.canvas = canvas; this.driver = new DesktopMotionDriver();
    this.abort = new AbortController(); this.textures = []; this.entries = new Map();
    this.ready = false; this.disposed = false; this.frames = 0; this.last = 0; this.lastHit = -Infinity;
    this.mask = document.createElement('canvas'); this.mask.width = 144; this.mask.height = 192;
    this.maskContext = this.mask.getContext('2d', { willReadFrequently: true }); this.pixels = null;
  }
  check() { this.abort.signal.throwIfAborted(); if (this.disposed) throw Error('角色已释放'); }
  url(relative, base = BASE) {
    const url = new URL(relative, base);
    if (url.origin !== BASE.origin || !url.pathname.startsWith(BASE.pathname)) throw Error('资源路径超出角色运行包');
    return url;
  }
  async fetch(relative, format = 'json', base = BASE) {
    this.check(); const url = this.url(relative, base);
    const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(15000)]) });
    if (!response.ok) throw Error(`资源加载失败：${url.pathname}（${response.status}）`);
    const value = await response[format](); this.check(); return value;
  }
  async load() {
    try {
      this.gl = this.canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: true });
      if (!this.gl) throw Error('无法创建 WebGL 画布');
      if (!globalThis.Live2DCubismCore || !CubismFramework.startUp()) throw Error('Cubism Core 未就绪');
      if (!CubismFramework.isInitialized()) CubismFramework.initialize();
      const entry = this.url('model/character.model3.json');
      const [setting, contract, library] = await Promise.all([
        this.fetch(entry), this.fetch('parameter-contract.json'),
        loadActionLibrary(relative => this.fetch(relative.replace(/^\//, ''))),
      ]);
      const expected = contract.parameters.filter(item => item.bound === true);
      if (contract.version !== 'cute-partner-character-v1' || expected.length !== 26 || setting.FileReferences?.Textures?.length !== 2) throw Error('资源版本或参数/纹理数量不符合 角色契约 v1');
      this.driver.installLibrary(library);
      const buffer = await this.fetch(setting.FileReferences.Moc, 'arrayBuffer', entry);
      this.userModel = new CubismUserModel(); this.userModel.loadModel(buffer, true);
      this.model = this.userModel.getModel(); if (!this.model) throw Error('Core 拒绝加载 moc3');
      const actual = new Map();
      for (let i = 0; i < this.model.getParameterCount(); i++) {
        const handle = this.model.getParameterId(i);
        actual.set(handle.getString(), { handle, min: this.model.getParameterMinimumValue(i), max: this.model.getParameterMaximumValue(i) });
      }
      for (const parameter of expected) {
        const native = actual.get(parameter.id);
        if (!native || native.min !== parameter.min || native.max !== parameter.max) throw Error(`原生参数缺失或范围不符：${parameter.id}`);
        this.entries.set(parameter.id, native);
      }
      this.resize();
      this.userModel.createRenderer(this.canvas.width, this.canvas.height);
      this.renderer = this.userModel.getRenderer(); this.renderer.startUp(this.gl);
      this.renderer.setIsPremultipliedAlpha(true);
      const gl = this.gl;
      for (const [index, file] of setting.FileReferences.Textures.entries()) {
        const blob = await this.fetch(file, 'blob', entry);
        const bitmap = await createImageBitmap(blob, { premultiplyAlpha: 'none' });
        try {
          this.check();
          const texture = gl.createTexture(); if (!texture) throw Error('纹理分配失败');
          this.textures.push(texture); gl.bindTexture(gl.TEXTURE_2D, texture);
          // ImageBitmap ignores UNPACK_PREMULTIPLY_ALPHA_WEBGL; upload an HTML image instead below.
          const image = document.createElement('canvas'); image.width = bitmap.width; image.height = bitmap.height;
          image.getContext('2d').drawImage(bitmap, 0, 0);
          gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
          this.renderer.bindTexture(index, texture);
        } finally { bitmap.close(); }
      }
      // Preload with our timeout/abort checks before SDK compilation, so release cannot race network loads.
      const shaderPath = this.url('web/Framework/Shaders/WebGL/').href;
      const sources = new Map(await Promise.all(SHADERS.map(async file => [shaderPath + file, await this.fetch(shaderPath + file, 'text')])));
      this.check();
      const shader = CubismShaderManager_WebGL.getInstance().getShader(gl);
      shader.loadShader = async url => { if (!sources.has(url)) throw Error('未知着色器'); return sources.get(url); };
      this.renderer.loadShaders(shaderPath);
      // Shader compilation runs after the immediately resolved source promises.
      await new Promise(resolve => setTimeout(resolve, 0)); this.check();
      // The SDK reserves unused slots (for excluded blend combinations).
      if (!shader._isShaderLoaded || !shader._shaderSets[1]?.shaderProgram || shader._shaderSets.some(item => item.shaderProgram !== undefined && (!item.shaderProgram || !gl.getProgramParameter(item.shaderProgram, gl.LINK_STATUS)))) throw Error('WebGL 着色器编译失败');
      this.ready = true; this.render(performance.now(), true);
      const head = this.model.getDrawableIndex(CubismFramework.getIdManager().getId('Headband'));
      if (head >= 0) { const vertices = this.model.getDrawableVertices(head); const xs = [], ys = []; for (let i = 0; i < vertices.length; i += 2) { xs.push(vertices[i]); ys.push(vertices[i + 1]); } this.neutralHead = { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: Math.max(...ys) }; }
      if (!this.pixels?.some((value, i) => i % 4 === 3 && value > 16)) throw Error('模型未绘制出可见像素');
      return this;
    } catch (error) { this.dispose(); throw error; }
  }
  resize() {
    const rect = this.canvas.getBoundingClientRect(), ratio = Math.min(devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(rect.width * ratio)), height = Math.max(1, Math.round(rect.height * ratio));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width; this.canvas.height = height;
      this.userModel?.setRenderTargetSize(width, height); this.lastHit = -Infinity;
    }
  }
  render(now, force = false) {
    if (!this.ready || this.disposed || this.gl.isContextLost()) return;
    if (!force && now - this.last < 1000 / 30 - 1) return;
    const dt = this.last ? Math.min(.05, Math.max(0, (now - this.last) / 1000)) : 0;
    this.last = now; this.resize(); this.driver.setAudioLevel(window.audioOutput?.mouthLevel?.() ?? window.audioOutput?.level() ?? 0);
    const values = this.driver.update(dt), written = {};
    for (const [id, entry] of this.entries) {
      const value = values[id]; if (!Number.isFinite(value)) throw Error(`角色参数不是有限值：${id}`);
      written[id] = Math.max(entry.min, Math.min(entry.max, value));
      this.model.setParameterValueById(entry.handle, written[id]);
    }
    this.model.update();
    const gl = this.gl, w = this.canvas.width, h = this.canvas.height;
    const fit = Math.min(1.84 / this.model.getCanvasHeight(), 1.84 * w / h / this.model.getCanvasWidth());
    const matrix = new CubismMatrix44(); matrix.scale(fit * h / w, fit);
    gl.viewport(0, 0, w, h); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    this.renderer.setMvpMatrix(matrix); this.renderer.setRenderState(null, [0, 0, w, h]); this.renderer.drawModel();
    if (now - this.lastHit >= 150) {
      this.maskContext.clearRect(0, 0, 144, 192); this.maskContext.drawImage(this.canvas, 0, 0, 144, 192);
      this.pixels = this.maskContext.getImageData(0, 0, 144, 192).data; this.lastHit = now;
    }
    this.values = written; this.frames++;
  }
  hitTest(x, y) {
    if (!this.pixels || x < 0 || y < 0 || x >= 1 || y >= 1) return false;
    return this.pixels[(Math.floor(y * 192) * 144 + Math.floor(x * 144)) * 4 + 3] > 16;
  }
  anchor() {
    if (this.pixels) for (let y = 191; y >= 0; y--) for (let x = 0; x < 144; x++) if (this.pixels[(y * 144 + x) * 4 + 3] > 16) return { x: .5, y: (y + 1) / 192 };
    return { x: .5, y: .9 };
  }
  headAnchor() {
    if (!this.neutralHead) return null;
    const rect = this.canvas.getBoundingClientRect(), w = this.canvas.width, h = this.canvas.height;
    const fit = Math.min(1.84 / this.model.getCanvasHeight(), 1.84 * w / h / this.model.getCanvasWidth());
    return { x: (rect.left + (this.neutralHead.x * fit * h / w + 1) / 2 * rect.width) / innerWidth, y: (rect.top + (1 - this.neutralHead.y * fit) / 2 * rect.height) / innerHeight, source: 'Headband-neutral-projection' };
  }
  silenceAudio() { this.driver.silenceAudio(); if (this.ready && !this.disposed) this.render(performance.now(), true); }
  mouthValue() { const entry = this.entries.get('ParamMouthOpenY'); return this.ready && this.model && entry ? this.model.getParameterValueById(entry.handle) : 0; }
  suspend() { this.driver.endDrag(); this.driver.setMouse(0, 0); this.driver.silenceAudio(); this.last = 0; if (this.ready && !this.disposed) this.render(performance.now(), true); }
  dispose() {
    if (this.disposed) return; this.disposed = true; this.ready = false; this.abort.abort();
    this.driver.endDrag(); this.driver.setAudioLevel(0);
    try { this.userModel?.release(); } finally {
      for (const texture of this.textures) this.gl?.deleteTexture(texture);
      this.textures = []; this.model = null; this.userModel = null; this.renderer = null;
      if (CubismFramework.isInitialized()) CubismFramework.dispose();
    }
  }
}
