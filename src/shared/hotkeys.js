/**
 * 熱鍵引擎 — FR-07。
 *
 * 這裡只處理「什麼時候該觸發什麼」：按鍵比對、冷卻、串接、自動停止、衝突偵測。
 * 實際的動作執行（播動畫、切表情…）由呼叫端以 executor 注入，
 * 因此本模組不依賴 three.js、Electron 或 DOM，可獨立測試。
 */

/**
 * 熱鍵動作清單 — FR-07-B。
 *
 * 對應規格的 14 種動作。`target` 標示該動作需要哪一種目標，
 * 供介面決定要顯示哪個下拉選單。
 */
export const HOTKEY_ACTIONS = {
  TriggerAnimation: { code: 0, label: '播放一次性動畫', target: 'animation' },
  ChangeIdleAnimation: { code: 1, label: '切換待機動畫', target: 'animation' },
  ToggleExpression: { code: 2, label: '開關表情', target: 'expression' },
  RemoveAllExpressions: { code: 3, label: '清除所有表情', target: null },
  TogglePose: { code: 4, label: '開關靜態姿勢', target: 'pose' },
  MoveModel: { code: 5, label: '移動模型至預設位置', target: 'transform' },
  ChangeBackground: { code: 6, label: '切換背景', target: 'background' },
  ChangeLighting: { code: 7, label: '套用光照預設', target: 'lighting' },
  ReloadMicrophone: { code: 8, label: '重新載入／靜音麥克風', target: null },
  CalibrateTracking: { code: 9, label: '追蹤校準', target: null },
  ChangeModel: { code: 10, label: '切換模型', target: 'model' },
  TakeScreenshot: { code: 11, label: '拍攝截圖', target: null },
  ToggleTracker: { code: 12, label: '開關追蹤來源', target: 'tracker' },
  PlaySound: { code: 13, label: '播放音效', target: 'sound', requires: 'FR-13' },
};

/** 畫面按鈕上限（規格 L-20） */
export const MAX_SCREEN_BUTTONS = 8;
/** 單一熱鍵可串接的動作數上限（規格 L-22） */
export const MAX_CHAINED_ACTIONS = 4;

/** Electron accelerator 可接受的修飾鍵 */
const MODIFIERS = new Set(['Ctrl', 'Alt', 'Shift', 'Super']);

/** 最多可搭配的修飾鍵數量 */
const MAX_MODIFIERS = 2;

/**
 * 主鍵一律以 KeyboardEvent.code（實體按鍵位置）記錄，而非 event.key。
 *
 * 原因：小鍵盤與主鍵盤數字列的 event.key 完全相同（都是 "1"），
 * 用 key 記錄會導致綁定小鍵盤時實際註冊到數字列，按小鍵盤毫無反應。
 * code 則能區分 Digit1 與 Numpad1。
 *
 * 下表把 code 轉成 Electron accelerator 的寫法。
 * 未列出者原樣輸出（F1–F24、Space、Tab… Electron 皆可直接接受）。
 */
const CODE_TO_ACCELERATOR = {
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  Escape: 'Esc', Enter: 'Return', NumpadEnter: 'Return',
  NumpadAdd: 'numadd', NumpadSubtract: 'numsub',
  NumpadMultiply: 'nummult', NumpadDivide: 'numdiv', NumpadDecimal: 'numdec',
  Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']',
  Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/',
  Backquote: '`',
};

/** 把單一主鍵 token 轉成 Electron accelerator */
function keyToAccelerator(token) {
  if (!token) return null;

  let m;
  if ((m = /^Digit(\d)$/.exec(token))) return m[1];        // Digit1 → 1
  if ((m = /^Numpad(\d)$/.exec(token))) return `num${m[1]}`; // Numpad1 → num1
  if ((m = /^Key([A-Z])$/.exec(token))) return m[1];       // KeyA → A
  if (CODE_TO_ACCELERATOR[token]) return CODE_TO_ACCELERATOR[token];

  // 舊版設定檔直接存了 "1" / "A" / "F5"，原樣沿用以維持相容
  return token;
}

/** 供介面顯示的可讀名稱 */
export function keyLabel(token) {
  let m;
  if ((m = /^Digit(\d)$/.exec(token))) return m[1];
  if ((m = /^Numpad(\d)$/.exec(token))) return `小鍵盤${m[1]}`;
  if ((m = /^Key([A-Z])$/.exec(token))) return m[1];
  if (token?.startsWith('Numpad')) return `小鍵盤${token.slice(6)}`;
  return token;
}

/** 整組按鍵的可讀名稱 */
export function comboLabel(keys) {
  if (!keys?.length) return null;
  return keys.map(keyLabel).join(' + ');
}

/**
 * 把按鍵陣列轉為 Electron accelerator 字串。
 *
 * 修飾鍵必須排在前面（Electron 只接受 "Ctrl+A"，不接受 "A+Ctrl"）。
 * 允許最多 2 個修飾鍵搭配 1 個主鍵——規格 FR-07-01 原訂上限為 2 鍵，
 * 這裡放寬到 3 個 token，目的是讓使用者能綁 Ctrl+Shift+X 這類組合，
 * 避免打字時誤觸。
 *
 * @param {string[]} keys
 * @returns {string|null} 無效時回傳 null
 */
export function toAccelerator(keys) {
  if (!Array.isArray(keys) || keys.length === 0) return null;

  const mods = keys.filter((k) => MODIFIERS.has(k));
  const plain = keys.filter((k) => !MODIFIERS.has(k));

  // 必須恰有一個非修飾鍵；單獨的修飾鍵無法註冊為全域熱鍵
  if (plain.length !== 1) return null;
  if (mods.length > MAX_MODIFIERS) return null;

  const main = keyToAccelerator(plain[0]);
  if (!main) return null;

  return [...mods, main].join('+');
}

/**
 * 由瀏覽器的 KeyboardEvent 取出按鍵組合。
 * @returns {string[]|null} 只按下修飾鍵時回傳 null，代表「繼續等待主鍵」
 */
export function keysFromEvent(event) {
  const mods = [];
  if (event.ctrlKey) mods.push('Ctrl');
  if (event.altKey) mods.push('Alt');
  if (event.shiftKey) mods.push('Shift');
  if (event.metaKey) mods.push('Super');

  const main = mainKeyFromEvent(event);
  if (!main) return null;

  return [...mods.slice(0, MAX_MODIFIERS), main];
}

/** 由事件取出主鍵 token；只按修飾鍵時回傳 null */
function mainKeyFromEvent(event) {
  const code = event.code;

  // 修飾鍵本身不能當主鍵
  if (/^(Control|Alt|Shift|Meta|OS)(Left|Right)?$/.test(code ?? '')) return null;
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(event.key)) return null;

  if (code) return code;

  // 極少數情況拿不到 code（如虛擬鍵盤），退回 key
  const key = event.key;
  if (!key) return null;
  if (key.length === 1) return key.toUpperCase();
  return key;
}

/**
 * 偵測熱鍵衝突 — FR-07-08。
 *
 * 三種來源各自獨立比對：鍵盤組合、滑鼠鍵、畫面按鈕。
 * @param {object[]} hotkeys
 * @returns {Array<{kind: string, value: string, ids: string[], names: string[]}>}
 */
export function detectConflicts(hotkeys) {
  const buckets = new Map();

  const put = (kind, value, hk) => {
    if (value === null || value === undefined || value === '') return;
    const key = `${kind}:${value}`;
    if (!buckets.has(key)) buckets.set(key, { kind, value: String(value), items: [] });
    buckets.get(key).items.push(hk);
  };

  for (const hk of hotkeys) {
    if (hk.enabled === false) continue;
    const acc = toAccelerator(hk.trigger?.keys ?? []);
    put('keyboard', acc, hk);
    put('mouse', hk.trigger?.mouse, hk);
    put('screenButton', hk.trigger?.screenButton, hk);
  }

  return [...buckets.values()]
    .filter((b) => b.items.length > 1)
    .map((b) => ({
      kind: b.kind,
      value: b.value,
      ids: b.items.map((h) => h.id),
      names: b.items.map((h) => h.name || h.id),
    }));
}

/** 建立一個具備預設值的空熱鍵 */
export function createHotkey(id, patch = {}) {
  return {
    id,
    name: '新熱鍵',
    enabled: true,
    global: false,
    trigger: { keys: [], mouse: null, screenButton: null },
    actions: [],
    cooldown: 0,
    autoStopSeconds: 0,
    stopOnRelease: false,
    ...patch,
  };
}

// ────────────────────────────────────────────────────────────────

/**
 * 熱鍵引擎。
 */
export class HotkeyEngine {
  /**
   * @param {object} opts
   * @param {Record<string, (action: object, phase: string) => void>} opts.executor
   *        動作型別 → 執行函式
   * @param {(level: string, msg: string) => void} [opts.log]
   */
  constructor({ executor, log = () => {} }) {
    this.executor = executor;
    this.log = log;

    /** @type {object[]} */
    this.hotkeys = [];
    /** 上次觸發時間（秒），用於冷卻 */
    this.lastFired = new Map();
    /** 進行中的自動停止計時：id → 剩餘秒數 */
    this.autoStop = new Map();
    /** 目前處於「按住」狀態的熱鍵，供 stopOnRelease 使用 */
    this.held = new Set();
  }

  setHotkeys(list) {
    this.hotkeys = Array.isArray(list) ? list : [];
    // 已移除的熱鍵不應留下殘留計時
    const ids = new Set(this.hotkeys.map((h) => h.id));
    for (const id of [...this.autoStop.keys()]) if (!ids.has(id)) this.autoStop.delete(id);
    for (const id of [...this.held]) if (!ids.has(id)) this.held.delete(id);
  }

  get(id) {
    return this.hotkeys.find((h) => h.id === id) ?? null;
  }

  /** 依鍵盤組合尋找熱鍵 */
  findByAccelerator(accelerator) {
    return this.hotkeys.find(
      (h) => h.enabled !== false && toAccelerator(h.trigger?.keys ?? []) === accelerator
    ) ?? null;
  }

  findByMouse(button) {
    return this.hotkeys.find((h) => h.enabled !== false && h.trigger?.mouse === button) ?? null;
  }

  findByScreenButton(index) {
    return this.hotkeys.find(
      (h) => h.enabled !== false && h.trigger?.screenButton === index
    ) ?? null;
  }

  /** 冷卻剩餘秒數（FR-07-23） */
  cooldownRemaining(id, now = nowSeconds()) {
    const hk = this.get(id);
    if (!hk?.cooldown) return 0;
    const last = this.lastFired.get(id);
    if (last === undefined) return 0;
    return Math.max(0, hk.cooldown - (now - last));
  }

  /**
   * 觸發熱鍵。
   *
   * @param {string} id
   * @param {'down'|'up'} phase
   * @param {number} [now] 供測試注入時間
   * @returns {{fired: boolean, reason?: string}}
   */
  fire(id, phase = 'down', now = nowSeconds()) {
    const hk = this.get(id);
    if (!hk) return { fired: false, reason: 'not-found' };
    if (hk.enabled === false) return { fired: false, reason: 'disabled' };

    if (phase === 'up') {
      this.held.delete(id);
      if (hk.stopOnRelease) this._stop(hk, now);
      return { fired: false, reason: 'release' };
    }

    // 冷卻中：忽略且不排入佇列（FR-07-23）
    const remaining = this.cooldownRemaining(id, now);
    if (remaining > 0) {
      return { fired: false, reason: 'cooldown', remaining };
    }

    this.lastFired.set(id, now);
    this.held.add(id);

    // 串接動作依序執行（FR-07-24）
    const actions = (hk.actions ?? []).slice(0, MAX_CHAINED_ACTIONS);
    for (const action of actions) {
      this._run(hk, action, 'start');
    }

    // X 秒後自動停止（FR-07-21）
    if (hk.autoStopSeconds > 0) {
      this.autoStop.set(id, hk.autoStopSeconds);
    }

    this.log('info', `熱鍵觸發：${hk.name || id}（${actions.length} 個動作）`);
    return { fired: true };
  }

  _run(hk, action, phase) {
    const fn = this.executor[action.type];
    if (!fn) {
      this.log('warn', `熱鍵 ${hk.name || hk.id} 的動作 ${action.type} 沒有對應的執行器`);
      return;
    }
    try {
      fn(action, phase, hk);
    } catch (err) {
      // 單一動作失敗不應中斷其餘動作
      this.log('error', `熱鍵動作 ${action.type} 執行失敗：${err.message}`);
    }
  }

  _stop(hk, now) {
    for (const action of (hk.actions ?? []).slice(0, MAX_CHAINED_ACTIONS)) {
      this._run(hk, action, 'stop');
    }
    this.autoStop.delete(hk.id);
    this.log('info', `熱鍵停止：${hk.name || hk.id}`);
  }

  /** 每幀推進，處理自動停止計時 */
  update(dt, now = nowSeconds()) {
    if (this.autoStop.size === 0) return;
    for (const [id, remaining] of [...this.autoStop]) {
      const left = remaining - dt;
      if (left <= 0) {
        this.autoStop.delete(id);
        const hk = this.get(id);
        if (hk) this._stop(hk, now);
      } else {
        this.autoStop.set(id, left);
      }
    }
  }

  /** 供介面顯示：目前所有衝突 */
  getConflicts() {
    return detectConflicts(this.hotkeys);
  }

  /** 需要註冊為全域快捷鍵的項目（交給主行程） */
  globalBindings() {
    const out = [];
    for (const hk of this.hotkeys) {
      if (hk.enabled === false) continue;
      const accelerator = toAccelerator(hk.trigger?.keys ?? []);
      if (accelerator) out.push({ id: hk.id, accelerator });
    }
    return out;
  }
}

function nowSeconds() {
  return (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;
}
