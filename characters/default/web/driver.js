// Cute-Partner · 角色运动驱动（单一写入者的参数目标计算）
// 本模块不访问 DOM。页面每帧调用一次 update()，把返回值写进模型；
// 模型切换、缺参数保护、场景与控件都在 app.js 中完成。

export const clamp = (value, min, max) =>
  Math.max(min, Math.min(max, Number.isFinite(value) ? value : 0));

// 默认调参：时间常数、增益和呼吸/眨眼节奏集中在这里。
export const TUNING = Object.freeze({
  eyeSmoothingSeconds: 0.13,
  headSmoothingSeconds: 0.35,
  bodySmoothingSeconds: 0.8,
  headGain: Object.freeze({ x: 20, y: 15, z: -10 }),
  bodyGain: Object.freeze({ x: 6, y: 4, z: -3 }),
  breathPeriodSeconds: 4.4,
  blinkCloseSeconds: 0.09,
  blinkHoldSeconds: 0.05,
  blinkOpenSeconds: 0.16,
  blinkIntervalSeconds: Object.freeze([2.8, 6.0]),
  firstBlinkSeconds: Object.freeze([2.0, 5.0]),
});

// 滑块与开关的默认值；页面把这里的常量写进控件初始状态。
export const DEFAULT_SETTINGS = Object.freeze({
  followMouse: true,
  eye: true,
  head: true,
  body: true,
  blink: true,
  breathe: true,
  breathAmplitude: 0.8,
  breathPeriod: 4.4,
  linkage: 1.0,
  followSpeed: 1.0,
});

// 页面按参数组写入；模型缺少的参数 ID 会被 app.js 跳过。
export const PARAM_GROUPS = Object.freeze({
  eye: Object.freeze(['ParamEyeBallX', 'ParamEyeBallY']),
  blink: Object.freeze(['ParamEyeLOpen', 'ParamEyeROpen']),
  head: Object.freeze(['ParamAngleX', 'ParamAngleY', 'ParamAngleZ']),
  body: Object.freeze(['ParamBodyAngleX', 'ParamBodyAngleY', 'ParamBodyAngleZ']),
  breath: Object.freeze(['ParamBreath']),
});

// 基线对照只驱动旧版真实绑定的 5 个参数；新模型驱动全部 11 个。
export const BASELINE_PARAM_IDS = Object.freeze([
  ...PARAM_GROUPS.eye,
  ...PARAM_GROUPS.blink,
  ...PARAM_GROUPS.breath,
]);

export const NEW_MODEL_PARAM_IDS = Object.freeze([
  ...BASELINE_PARAM_IDS,
  ...PARAM_GROUPS.head,
  ...PARAM_GROUPS.body,
]);

const approachFactor = (dt, tau, speed) =>
  1 - Math.exp((-dt * speed) / Math.max(0.001, tau));

export class PreviewMotionDriver {
  constructor(random = Math.random) {
    this.random = random;
    this.settings = { ...DEFAULT_SETTINGS };
    this.paused = false;
    this.time = 0;
    this.breathPhase = 0;
    this.mouse = { x: 0, y: 0 };
    this.fixed = null;
    this.eye = { x: 0, y: 0 };
    this.head = { x: 0, y: 0 };
    this.body = { x: 0, y: 0 };
    this.breathLevel = 1;
    this.open = 1;
    this.blinkAge = null;
    const [firstMin, firstMax] = TUNING.firstBlinkSeconds;
    this.nextBlink = firstMin + random() * (firstMax - firstMin);
    this.values = {};
    this.update(0);
  }

  setPaused(paused) {
    this.paused = Boolean(paused);
  }

  setMouse(x, y) {
    this.mouse.x = clamp(x, -1, 1);
    this.mouse.y = clamp(y, -1, 1);
  }

  setFixedTarget(x, y) {
    this.fixed = { x: clamp(x, -1, 1), y: clamp(y, -1, 1) };
    this.settings.followMouse = false;
  }

  clearFixedTarget() {
    this.fixed = null;
  }

  triggerBlink() {
    if (this.blinkAge === null) this.blinkAge = 0;
  }

  setSetting(name, value) {
    switch (name) {
      case 'followMouse':
        this.settings.followMouse = Boolean(value);
        if (this.settings.followMouse) this.fixed = null;
        break;
      case 'eye':
      case 'head':
      case 'body':
      case 'blink':
      case 'breathe':
        this.settings[name] = Boolean(value);
        break;
      case 'linkage':
        this.settings.linkage = clamp(value, 0.3, 1.5);
        break;
      case 'followSpeed':
        this.settings.followSpeed = clamp(value, 0.5, 2.0);
        break;
      case 'breathAmplitude':
        this.settings.breathAmplitude = clamp(value, 0.3, 1.0);
        break;
      case 'breathPeriod':
        this.settings.breathPeriod = clamp(value, 3, 7);
        break;
      default:
        break;
    }
  }

  resetSettings() {
    this.settings = { ...DEFAULT_SETTINGS };
    this.fixed = null;
    this.mouse = { x: 0, y: 0 };
    this.eye = { x: 0, y: 0 };
    this.head = { x: 0, y: 0 };
    this.body = { x: 0, y: 0 };
    this.time = 0;
    this.breathPhase = 0;
    this.breathLevel = 1;
    this.open = 1;
    this.blinkAge = null;
    const [min, max] = TUNING.firstBlinkSeconds;
    this.nextBlink = min + this.random() * (max - min);
    this.update(0);
  }

  getValues() {
    return this.values;
  }

  getState() {
    return {
      time: this.time,
      mouse: { ...this.mouse },
      fixed: this.fixed ? { ...this.fixed } : null,
      eye: { ...this.eye },
      head: { ...this.head },
      body: { ...this.body },
      breathLevel: this.breathLevel,
      open: this.open,
      settings: { ...this.settings },
    };
  }

  update(dtRaw = 0) {
    const dt = clamp(dtRaw, 0, 0.05);
    const settings = this.settings;

    if (!this.paused) {
      this.time += dt;
      this.breathPhase = (this.breathPhase + dt / settings.breathPeriod) % 1;

      // 目标优先级：固定目标 > 跟随鼠标 > 回中。
      const target = this.fixed ?? (settings.followMouse ? this.mouse : { x: 0, y: 0 });
      const speed = settings.followSpeed;
      const linkage = settings.linkage;

      const eyeTargetX = settings.eye ? target.x : 0;
      const eyeTargetY = settings.eye ? target.y : 0;
      const headTargetX = settings.head ? clamp(target.x * linkage, -1.5, 1.5) : 0;
      const headTargetY = settings.head ? clamp(target.y * linkage, -1.5, 1.5) : 0;
      const bodyTargetX = settings.body ? clamp(target.x * linkage, -1.5, 1.5) : 0;
      const bodyTargetY = settings.body ? clamp(target.y * linkage, -1.5, 1.5) : 0;

      const eyeFactor = approachFactor(dt, TUNING.eyeSmoothingSeconds, speed);
      this.eye.x += (eyeTargetX - this.eye.x) * eyeFactor;
      this.eye.y += (eyeTargetY - this.eye.y) * eyeFactor;

      const headFactor = approachFactor(dt, TUNING.headSmoothingSeconds, speed);
      this.head.x += (headTargetX - this.head.x) * headFactor;
      this.head.y += (headTargetY - this.head.y) * headFactor;

      const bodyFactor = approachFactor(dt, TUNING.bodySmoothingSeconds, speed);
      this.body.x += (bodyTargetX - this.body.x) * bodyFactor;
      this.body.y += (bodyTargetY - this.body.y) * bodyFactor;

      // 呼吸开关用短淡入淡出，避免突然跳变；脚底固定由模型绑定保证。
      const breathTarget = settings.breathe ? 1 : 0;
      this.breathLevel +=
        (breathTarget - this.breathLevel) *
        approachFactor(dt, settings.breathe ? 0.18 : 0.3, 1);

      this.#updateBlink(dt);
    }

    const wave =
      (1 - Math.cos(this.breathPhase * Math.PI * 2)) / 2;
    const breath = wave * settings.breathAmplitude * this.breathLevel;
    const open = clamp(this.open, 0, 1);

    this.values = {
      ParamEyeBallX: this.eye.x,
      ParamEyeBallY: this.eye.y,
      ParamEyeLOpen: open,
      ParamEyeROpen: open,
      ParamAngleX: this.head.x * TUNING.headGain.x,
      ParamAngleY: this.head.y * TUNING.headGain.y,
      ParamAngleZ: this.head.x * TUNING.headGain.z,
      ParamBodyAngleX: this.body.x * TUNING.bodyGain.x,
      ParamBodyAngleY: this.body.y * TUNING.bodyGain.y,
      ParamBodyAngleZ: this.body.x * TUNING.bodyGain.z,
      ParamBreath: breath,
    };
    return this.values;
  }

  #updateBlink(dt) {
    if (this.blinkAge === null) {
      this.open = 1;
      if (!this.settings.blink || this.time < this.nextBlink) return;
      this.blinkAge = 0;
    }

    // 关闭眨眼开关时也让当前这一次眨完，再保持睁开。
    this.blinkAge += dt;
    const t = this.blinkAge;
    const close = TUNING.blinkCloseSeconds;
    const holdEnd = close + TUNING.blinkHoldSeconds;
    const openEnd = holdEnd + TUNING.blinkOpenSeconds;

    if (t < close) this.open = 1 - t / close;
    else if (t < holdEnd) this.open = 0;
    else if (t < openEnd) this.open = (t - holdEnd) / TUNING.blinkOpenSeconds;
    else {
      this.open = 1;
      this.blinkAge = null;
      const [min, max] = TUNING.blinkIntervalSeconds;
      this.nextBlink = this.time + min + this.random() * (max - min);
    }
  }
}
