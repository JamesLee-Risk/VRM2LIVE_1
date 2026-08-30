/**
 * 參數映射引擎 — FR-03。
 *
 * 職責：把輸入參數表（追蹤／語音／滑鼠）解算成一份「輸出目標值表」，
 * 交由渲染層套用到 VRM 上。此模組**不依賴 three.js**，故可被測試與重用。
 *
 * 核心概念是「輸出匯流排」(OutputBus)：所有值提供者以**優先權**寫入同一組 key，
 * 高優先權覆寫低優先權（FR-03-11）；Add／Multiply 修飾則不參與覆寫仲裁，
 * 而是在最後統一套用——先全部乘、再全部加（FR-03 加法／乘法例外）。
 *
 * 輸出目標 key 格式：
 *   expression:<表情名>
 *   bone:<骨骼名>:<軸 x|y|z>     （單位：度）
 *   lookAt:<yaw|pitch>            （單位：度）
 *   root:<x|y|z>                  （單位：公尺）
 */

/** 值提供者優先權（規格 FR-03 表） */
export const PRIORITY = {
  DEFAULT: 0,      // P0 VRM 預設姿勢
  IDLE_ANIM: 1,    // P1 待機動畫
  TRACKING: 2,     // P2 臉部追蹤／語音／滑鼠
  ONESHOT_ANIM: 3, // P3 一次性動畫
  EXPRESSION: 4,   // P4 表情
  // P5 SpringBone 由 three-vrm 於渲染階段自行套用，不經此匯流排
};

/** 平滑度 100 對應的時間常數（秒） */
const MAX_SMOOTH_TAU = 0.35;

export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/** 將 v 由 [inLo,inHi] 線性映射至 [outLo,outHi]；容許反向區間（FR-03-03） */
export function remap(v, inLo, inHi, outLo, outHi) {
  const span = inHi - inLo;
  if (span === 0) return outLo;
  const t = (v - inLo) / span;
  return outLo + t * (outHi - outLo);
}

/** 依 dt 計算指數平滑係數；smooth 為 0–100 */
function smoothAlpha(smooth, dt) {
  if (!smooth) return 1;
  const tau = (smooth / 100) * MAX_SMOOTH_TAU;
  if (tau <= 0) return 1;
  return 1 - Math.exp(-dt / tau);
}

// ────────────────────────────────────────────────────────────────
// 輸出匯流排
// ────────────────────────────────────────────────────────────────

class OutputBus {
  constructor() {
    /** @type {Map<string, {value:number, priority:number}>} */
    this.base = new Map();
    /** @type {Map<string, number>} */
    this.multipliers = new Map();
    /** @type {Map<string, number>} */
    this.addends = new Map();
  }

  begin() {
    this.base.clear();
    this.multipliers.clear();
    this.addends.clear();
  }

  /** 以優先權寫入；同 key 僅保留最高優先權者（同優先權時後寫者勝，對應 FR-05-07） */
  write(key, value, priority) {
    const cur = this.base.get(key);
    if (cur === undefined || priority >= cur.priority) {
      this.base.set(key, { value, priority });
    }
  }

  /** Multiply 修飾（FR-05-05）：連乘 */
  multiply(key, factor) {
    this.multipliers.set(key, (this.multipliers.get(key) ?? 1) * factor);
  }

  /** Add 修飾（FR-05-04）：累加 */
  add(key, amount) {
    this.addends.set(key, (this.addends.get(key) ?? 0) + amount);
  }

  /**
   * 解析為最終值表。先套用全部乘法、再套用全部加法，
   * 最後依輸出型態限幅（表情權重限 0–1）。
   */
  resolve() {
    /** @type {Record<string, number>} */
    const out = Object.create(null);

    const keys = new Set([...this.base.keys(), ...this.multipliers.keys(), ...this.addends.keys()]);
    for (const key of keys) {
      let v = this.base.get(key)?.value ?? 0;
      const m = this.multipliers.get(key);
      if (m !== undefined) v *= m;
      const a = this.addends.get(key);
      if (a !== undefined) v += a;
      if (key.startsWith('expression:')) v = clamp(v, 0, 1);
      out[key] = v;
    }
    return out;
  }
}

// ────────────────────────────────────────────────────────────────
// 自動眨眼 / 自動呼吸
// ────────────────────────────────────────────────────────────────

class AutoBlink {
  constructor() {
    this.timer = 0;
    this.next = this._pick(2);
    this.phase = 0; // 0 = 未眨眼
    this.weight = 0;
  }

  _pick(mean) {
    // 以平均值為中心的隨機間隔，避免機械式規律
    return mean * (0.6 + Math.random() * 0.9);
  }

  /** @returns {number} 眨眼權重 0–1 */
  update(dt, { interval = 4, duration = 0.12 } = {}) {
    if (this.phase === 0) {
      this.timer += dt;
      if (this.timer >= this.next) {
        this.timer = 0;
        this.next = this._pick(interval);
        this.phase = 1;
      }
      this.weight = 0;
    } else {
      this.timer += dt;
      const t = this.timer / duration;
      if (t >= 1) {
        this.phase = 0;
        this.timer = 0;
        this.weight = 0;
      } else {
        // 前半閉眼、後半睜眼
        this.weight = t < 0.5 ? t * 2 : (1 - t) * 2;
      }
    }
    return this.weight;
  }
}

class AutoBreath {
  constructor() {
    this.t = 0;
  }

  /** @returns {number} 0–1 之呼吸相位 */
  update(dt, { period = 4 } = {}) {
    this.t += dt;
    const p = period > 0 ? period : 4;
    return 0.5 - 0.5 * Math.cos((this.t / p) * Math.PI * 2);
  }
}

// ────────────────────────────────────────────────────────────────
// 主解算器
// ────────────────────────────────────────────────────────────────

export class Solver {
  constructor() {
    this.bus = new OutputBus();
    this.autoBlink = new AutoBlink();
    this.autoBreath = new AutoBreath();

    /** 逐映射之平滑狀態 */
    this.smoothState = new Map();
    /** 逐表情之淡入淡出狀態：name → {current, target, fadeIn, fadeOut} */
    this.expressionStates = new Map();
    /** 上一輪解算結果，供 UI 監看 */
    this.lastResolved = Object.create(null);
    /** 經前處理後的輸入值，供參數監看器顯示（FR-02-30） */
    this.processedInputs = Object.create(null);
  }

  /**
   * 輸入前處理：眨眼連動（FR-02-26）與靈敏度（FR-02-27）。
   * 回傳新的輸入值表，不修改原物件。
   */
  preprocess(inputs, settings = {}) {
    const out = { ...inputs };
    const sens = settings.sensitivity ?? {};

    const scaleAround = (v, k, center) => center + (v - center) * (k ?? 1);
    for (const id of ['FaceAngleX', 'FaceAngleY', 'FaceAngleZ']) {
      out[id] = scaleAround(out[id] ?? 0, sens.headRotation, 0);
    }
    for (const id of ['FacePositionX', 'FacePositionY', 'FacePositionZ']) {
      out[id] = scaleAround(out[id] ?? 0, sens.headPosition, 0);
    }
    for (const id of ['EyeOpenLeft', 'EyeOpenRight']) {
      out[id] = clamp(scaleAround(out[id] ?? 1, sens.eye, 1), 0, 1);
    }
    for (const id of ['Brows', 'BrowLeftY', 'BrowRightY']) {
      out[id] = scaleAround(out[id] ?? 0, sens.brow, 0);
    }
    for (const id of ['MouthOpen', 'MouthSmile']) {
      out[id] = clamp(scaleAround(out[id] ?? 0, sens.mouth, 0), 0, 1);
    }

    // 眨眼連動三種模式
    const mode = settings.blinkLink ?? 'never';
    const l = out.EyeOpenLeft ?? 1;
    const r = out.EyeOpenRight ?? 1;
    if (mode === 'always') {
      const avg = (l + r) / 2;
      out.EyeOpenLeft = avg;
      out.EyeOpenRight = avg;
    } else if (mode === 'onHeadTurn') {
      // 頭部大幅轉動時，被遮蔽的那隻眼睛數值不可信，改採仍可見的一側
      const yaw = out.FaceAngleX ?? 0;
      const threshold = settings.blinkLinkAngle ?? 18;
      if (yaw > threshold) {
        out.EyeOpenLeft = out.EyeOpenRight = r;
      } else if (yaw < -threshold) {
        out.EyeOpenLeft = out.EyeOpenRight = l;
      }
    }

    return out;
  }

  /**
   * 執行一次解算。
   *
   * @param {object} args
   * @param {Record<string, number>} args.inputs   原始輸入參數
   * @param {object[]} args.mappings               映射設定
   * @param {Map<string, object>} args.expressions 表情啟用狀態
   * @param {object} args.settings                 追蹤設定
   * @param {number} args.dt                       上一幀至今的秒數
   * @param {boolean} args.tracked                 目前是否有有效追蹤
   * @returns {Record<string, number>} 輸出目標值表
   */
  solve({ inputs, mappings = [], expressions = new Map(), settings = {}, dt, tracked = true }) {
    const processed = this.preprocess(inputs, settings);
    this.processedInputs = processed;

    const bus = this.bus;
    bus.begin();

    // ── P2：追蹤映射 ─────────────────────────────────────────
    for (const m of mappings) {
      if (m.enabled === false) continue;
      this._applyMapping(m, processed, dt, tracked, settings);
    }

    // ── P4：表情 ────────────────────────────────────────────
    this._applyExpressions(expressions, dt);

    const resolved = bus.resolve();
    this.lastResolved = resolved;
    return resolved;
  }

  _applyMapping(m, inputs, dt, tracked, settings) {
    let raw;

    if (m.mode === 'autoBreath') {
      // 不需輸入參數，且忽略任何輸入（FR-03-08）
      raw = this.autoBreath.update(dt, m.options);
    } else if (m.mode === 'autoBlink') {
      // 可與輸入參數併用，取較大值（FR-03-09）
      const auto = this.autoBlink.update(dt, m.options);
      const fromInput = m.input ? this._normalizedInput(m, inputs) : 0;
      raw = Math.max(auto, tracked ? fromInput : auto);
    } else {
      raw = this._normalizedInput(m, inputs);
    }

    // 平滑（FR-03-07）
    const key = m.id;
    const alpha = smoothAlpha(m.smooth ?? 0, dt);
    const prev = this.smoothState.get(key);
    const value = prev === undefined ? raw : prev + (raw - prev) * alpha;
    this.smoothState.set(key, value);

    // 分派至各輸出目標
    for (const t of m.targets ?? []) {
      const [outLo, outHi] = t.outRange ?? [0, 1];
      let v = remap(value, 0, 1, outLo, outHi);
      if (m.limit !== false) {
        const lo = Math.min(outLo, outHi);
        const hi = Math.max(outLo, outHi);
        v = clamp(v, lo, hi);
      }
      busWrite(this.bus, t, v, PRIORITY.TRACKING);
    }
  }

  /** 取得輸入值並正規化到 0–1（依映射之輸入區間） */
  _normalizedInput(m, inputs) {
    const v = inputs[m.input] ?? 0;
    const [lo, hi] = m.inRange ?? [0, 1];
    return clamp(remap(v, lo, hi, 0, 1), 0, 1);
  }

  /** 表情淡入淡出與 Overwrite/Add/Multiply 三模式（FR-05-04/05/09） */
  _applyExpressions(expressions, dt) {
    // 先更新所有已知表情的淡入淡出進度（含剛被關閉、仍在淡出者）
    for (const [name, st] of this.expressionStates) {
      const def = expressions.get(name);
      st.target = def?.active ? 1 : 0;
      const fade = st.target > st.current ? (def?.fadeIn ?? 0.25) : (st.fadeOut ?? def?.fadeOut ?? 0.25);
      st.fadeOut = def?.fadeOut ?? 0.25;
      if (fade <= 0) {
        st.current = st.target;
      } else {
        const step = dt / fade;
        st.current += clamp(st.target - st.current, -step, step);
      }
    }

    // 納入新出現的表情
    for (const [name, def] of expressions) {
      if (!this.expressionStates.has(name)) {
        this.expressionStates.set(name, {
          current: def.active ? 1 : 0,
          target: def.active ? 1 : 0,
          fadeOut: def.fadeOut ?? 0.25,
        });
      }
    }

    for (const [name, st] of this.expressionStates) {
      if (st.current <= 0.0001) continue;
      const def = expressions.get(name);
      if (!def) continue;

      for (const item of def.items ?? []) {
        const amount = item.value * st.current;
        switch (item.mode) {
          case 'add':
            busModify(this.bus, item, 'add', amount);
            break;
          case 'multiply':
            // 權重未滿時於 1 與目標倍率之間插值，避免淡入過程跳動
            busModify(this.bus, item, 'multiply', 1 + (item.value - 1) * st.current);
            break;
          default:
            busWrite(this.bus, item, amount, PRIORITY.EXPRESSION);
        }
      }
    }
  }

  /** 目前所有表情的實際權重（含淡入淡出中的中間值），供 UI 顯示 */
  getExpressionWeights() {
    const out = Object.create(null);
    for (const [name, st] of this.expressionStates) out[name] = st.current;
    return out;
  }

  reset() {
    this.smoothState.clear();
    this.expressionStates.clear();
  }
}

// ────────────────────────────────────────────────────────────────
// 目標 key 工具
// ────────────────────────────────────────────────────────────────

/** 由目標描述產生匯流排 key */
export function targetKey(t) {
  switch (t.type) {
    case 'expression':
      return `expression:${t.name}`;
    case 'bone':
      return `bone:${t.name}:${t.axis}`;
    case 'lookAt':
      return `lookAt:${t.axis}`;
    case 'root':
      return `root:${t.axis}`;
    default:
      return `unknown:${t.name ?? ''}`;
  }
}

/** 目標的人類可讀標籤，供 UI 與衝突提示使用 */
export function targetLabel(t) {
  switch (t.type) {
    case 'expression':
      return `表情 ${t.name}`;
    case 'bone':
      return `骨骼 ${t.name}.${t.axis}`;
    case 'lookAt':
      return `視線 ${t.axis}`;
    case 'root':
      return `根節點 ${t.axis}`;
    default:
      return '未知目標';
  }
}

function busWrite(bus, t, value, priority) {
  bus.write(targetKey(t), value, priority);
}

function busModify(bus, t, kind, value) {
  const key = targetKey(t);
  if (kind === 'add') bus.add(key, value);
  else bus.multiply(key, value);
}
