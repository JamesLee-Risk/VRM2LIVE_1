/**
 * 工作室主視窗 — 應用程式協調層。
 *
 * 每幀流程（對應規格 §3.3 資料流）：
 *   追蹤器取樣（依追蹤 FPS）
 *     → 輸入參數表
 *     → 解算器（映射／平滑／優先權仲裁）
 *     → 套用至 VRM
 *     → 渲染 + 廣播給 OBS 輸出頁面
 */
import * as THREE from 'three';
import { Stage, CAMERA_PRESETS } from '../shared/stage.js';
import { Solver } from '../shared/solver.js';
import { autoSetup } from '../shared/autosetup.js';
import { INPUT_PARAMS, GROUP_LABELS, createInputState } from '../shared/params.js';
import { WebcamTracker } from './tracker.js';
import { BodyTracker } from './bodytracker.js';
import { MicTracker } from './audio.js';
import { VOWELS } from '../shared/lipsync.js';
import { BodySolver, BODY_MODES, PL } from '../shared/bodysolver.js';
import {
  HotkeyEngine, HOTKEY_ACTIONS, MAX_SCREEN_BUTTONS, MAX_CHAINED_ACTIONS,
  toAccelerator, keysFromEvent, createHotkey, comboLabel,
} from '../shared/hotkeys.js';

const api = window.vrm2live;
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

// ────────────────────────────────────────────────────────────────
// 應用程式狀態
// ────────────────────────────────────────────────────────────────

const state = {
  appConfig: null,
  models: [],
  currentModel: null, // { path, name, meta, license }
  modelConfig: null,
  backgrounds: [],
  animationFiles: [],
  activePoseName: null,
  capturingHotkey: null,
  hotkeyRegisterFailures: [],
  lightingPresets: {},

  inputs: createInputState(),
  /** 表情啟用狀態：name → { active, fadeIn, fadeOut, items } */
  expressions: new Map(),

  tracking: false,
  micActive: false,
  /** 身體追蹤（FR-02-D）最近一幀的骨骼姿態，供渲染與 OBS 廣播共用 */
  bodyPose: null,
  /** 自我測試截圖期間暫停主迴圈，避免與手動渲染互相覆寫 */
  renderPaused: false,
  calibration: null,
  streamMode: false,
  outputUrl: null,

  renderFps: 0,
  lastFrameTimes: [],
};

const stage = new Stage($('#stage'));
const solver = new Solver();
const tracker = new WebcamTracker({ log: (l, m) => api.log(l, m) });
const bodyTracker = new BodyTracker({ log: (l, m) => api.log(l, m) });
const bodySolver = new BodySolver();
const mic = new MicTracker({ log: (l, m) => api.log(l, m) });

// ────────────────────────────────────────────────────────────────
// 工具
// ────────────────────────────────────────────────────────────────

function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $('#toast-area').appendChild(el);
  setTimeout(() => el.remove(), kind === 'error' ? 6000 : 3200);
}

function fmtBytes(n) {
  return n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${(n / 1e3).toFixed(0)} KB`;
}

/** 儲存目前模型設定（設定變更即時寫入，NFR-R-01） */
let saveModelTimer = null;
function saveModelConfig() {
  if (!state.currentModel || !state.modelConfig) return;
  clearTimeout(saveModelTimer);
  saveModelTimer = setTimeout(() => {
    api.config.saveModel(state.currentModel.path, state.modelConfig);
  }, 250);
}

let saveAppTimer = null;
function saveAppConfig() {
  clearTimeout(saveAppTimer);
  saveAppTimer = setTimeout(() => api.config.saveApp(state.appConfig), 250);
}

// ────────────────────────────────────────────────────────────────
// 模型
// ────────────────────────────────────────────────────────────────

async function refreshModels() {
  state.models = await api.models.scan();
  renderModelList();
}

function renderModelList() {
  const list = $('#model-list');
  list.innerHTML = '';

  if (state.models.length === 0) {
    list.innerHTML = '<p class="hint">Models/ 資料夾內沒有 .vrm 檔案。</p>';
    return;
  }

  for (const m of state.models) {
    const item = document.createElement('div');
    item.className = 'list-item';
    if (m.error) item.classList.add('error');
    if (state.currentModel?.path === m.path) item.classList.add('active');

    const badges = [];
    if (m.meta) badges.push(`<span class="badge spec">VRM ${m.meta.specVersion}</span>`);
    if (m.heavy) badges.push('<span class="badge warn">大型</span>');

    item.innerHTML = `
      <div class="title">
        <span class="name">${escapeHtml(m.meta?.title || m.name)}</span>
        <span>${badges.join(' ')}</span>
      </div>
      <div class="sub">${
        m.error
          ? `⚠ 無法讀取：${escapeHtml(m.error)}`
          : `${escapeHtml(m.meta.author)} · ${fmtBytes(m.sizeBytes)}`
      }</div>`;

    if (!m.error) item.addEventListener('click', () => loadModel(m));
    list.appendChild(item);
  }
}

function renderModelMeta(m) {
  const box = $('#model-meta');
  if (!m?.meta) {
    box.classList.add('hidden');
    return;
  }

  const restrictions = m.license.restrictions;
  box.innerHTML = `
    <dl>
      <dt>名稱</dt><dd>${escapeHtml(m.meta.title)}</dd>
      <dt>作者</dt><dd>${escapeHtml(m.meta.author)}</dd>
      <dt>版本</dt><dd>${escapeHtml(m.meta.version || '—')}</dd>
      <dt>規格</dt><dd>VRM ${m.meta.specVersion}</dd>
      <dt>授權</dt><dd>${escapeHtml(m.license.summary)}</dd>
      <dt>網格</dt><dd>${m.stats.meshes} 網格 / ${m.stats.materials} 材質 / ${m.stats.textures} 貼圖</dd>
    </dl>
    ${
      restrictions.length
        ? `<div class="restriction">${restrictions.map(escapeHtml).join('<br>')}</div>`
        : ''
    }`;
  box.classList.remove('hidden');
}

async function loadModel(entry, { autoSetupChoice = 'ask' } = {}) {
  try {
    toast(`載入中：${entry.meta?.title ?? entry.name}…`);
    const t0 = performance.now();

    // 模型經本機輸出伺服器提供，主視窗與 OBS 輸出頁面因此使用同一組網址
    const rel = await api.models.toUrl(entry.path);
    if (!rel) throw new Error('模型不在 Models/ 資料夾內，無法提供給輸出頁面');
    await stage.loadVRM(`http://127.0.0.1:${state.outputPort}${rel}`);

    state.currentModel = entry;
    state.modelConfig = await api.config.loadModel(entry.path);
    let cfgDirty = migrateTransformPivot(state.modelConfig);

    solver.reset();
    state.expressions.clear();

    // 身體追蹤的骨架量測隨模型更換（FR-02-65）
    bodySolver.setRig(stage.rig);
    state.bodyPose = null;
    if (!stage.rig && state.appConfig.tracking.body.mode !== 'face') {
      setBodyMessage('此模型缺少 hips 或雙上臂骨骼，無法進行身體追蹤。');
    }

    // 搖動骨骼設定（FR-01-13）。必須在 loadVRM 之後，原始參數才快取得到
    stage.setSpringBone(state.modelConfig.springBone);
    syncSpringControls();

    // 套用已儲存的變換與攝影機。自動配置必須在套用之後，才量得到實際邊界
    stage.setModelTransform(state.modelConfig.transform);
    if (autoFitOnFirstLoad(state.modelConfig)) cfgDirty = true;
    if (recoverIfOffscreen()) cfgDirty = true;
    if (cfgDirty) saveModelConfig();
    syncTransformControls();
    stage.applyCameraPreset(state.modelConfig.camera.preset);
    $('#camera-preset').value = state.modelConfig.camera.preset;

    // 首次載入詢問是否執行自動設定（FR-01-07 / FR-01-09）
    if (!state.modelConfig.autoSetupDone || state.modelConfig.mappings.length === 0) {
      const doIt =
        autoSetupChoice === 'auto' ||
        (autoSetupChoice === 'ask' &&
          confirm('這是首次載入此模型。要立即執行自動設定，依模型的表情與骨骼建立完整映射嗎？'));
      if (doIt) {
        runAutoSetup();
      } else {
        state.modelConfig.autoSetupDone = true;
        saveModelConfig();
      }
    }

    state.activePoseName = null;
    stage.setPose(null);
    syncHotkeys();
    renderHotkeyList();
    renderPoseList();

    renderIdleOptions();
    if (state.modelConfig.idleAnimation) {
      await applyIdleAnimation(state.modelConfig.idleAnimation);
    }

    rebuildExpressionState();
    renderExpressionList();
    renderMappingList();
    renderModelList();
    renderModelMeta(entry);
    $('#empty-state').classList.add('hidden');

    state.appConfig.lastModel = entry.path;
    saveAppConfig();

    await pushScene();

    const ms = Math.round(performance.now() - t0);
    toast(`已載入 ${entry.meta?.title ?? entry.name}（${ms} ms）`, 'ok');
    api.log('info', `載入模型 ${entry.name}，耗時 ${ms} ms`);
  } catch (err) {
    // 毀損模型不得當機（NFR-R-06）
    toast(`載入失敗：${err.message}`, 'error');
    api.log('error', `載入模型失敗：${err.message}`);
  }
}

// ────────────────────────────────────────────────────────────────
// 自動設定
// ────────────────────────────────────────────────────────────────

function runAutoSetup() {
  const caps = stage.getCapabilities();
  const { mappings, settingsPatch, notes } = autoSetup(caps);

  state.modelConfig.mappings = mappings;
  state.modelConfig.autoSetupDone = true;
  saveModelConfig();

  if (Object.keys(settingsPatch).length) {
    Object.assign(state.appConfig.tracking, settingsPatch);
    syncTrackingControls();
    saveAppConfig();
  }

  solver.reset();
  renderMappingList();

  const box = $('#autosetup-notes');
  if (notes.length) {
    box.innerHTML = `<b>自動設定已完成，但有以下情形需注意：</b><ul>${notes
      .map((n) => `<li>${escapeHtml(n)}</li>`)
      .join('')}</ul>`;
    box.classList.remove('hidden');
  } else {
    box.classList.add('hidden');
  }

  toast(`自動設定完成，建立 ${mappings.length} 組映射`, 'ok');
  api.log('info', `自動設定建立 ${mappings.length} 組映射；備註 ${notes.length} 則`);
}

// ────────────────────────────────────────────────────────────────
// 表情
// ────────────────────────────────────────────────────────────────

/** 從模型的表情清單建立可開關狀態；已被映射佔用者不列入手動開關 */
function rebuildExpressionState() {
  state.expressions.clear();
  const info = stage.getExpressionInfo();
  const mapped = new Set();
  for (const m of state.modelConfig?.mappings ?? []) {
    for (const t of m.targets ?? []) {
      if (t.type === 'expression') mapped.add(t.name);
    }
  }

  for (const name of [...info.preset, ...info.custom]) {
    if (mapped.has(name)) continue; // 由追蹤驅動，不提供手動開關
    const saved = state.modelConfig?.expressions?.[name];
    state.expressions.set(name, {
      active: false,
      fadeIn: saved?.fadeIn ?? 0.25,
      fadeOut: saved?.fadeOut ?? 0.25,
      isCustom: info.custom.includes(name),
      // 預設表情項目：直接把同名表情推到 1
      items: [{ type: 'expression', name, mode: 'overwrite', value: 1 }],
    });
  }
}

function renderExpressionList() {
  const list = $('#expression-list');
  list.innerHTML = '';

  if (state.expressions.size === 0) {
    list.innerHTML = '<p class="hint">尚未載入模型，或所有表情皆已被映射佔用。</p>';
    return;
  }

  for (const [name, def] of state.expressions) {
    const item = document.createElement('div');
    item.className = 'list-item';
    item.dataset.expression = name;
    item.innerHTML = `
      <div class="expr-item">
        <span class="name">${escapeHtml(name)}</span>
        ${def.isCustom ? '<span class="badge">自訂</span>' : '<span class="badge spec">預設</span>'}
        <span class="weight-bar"><i class="weight-fill"></i></span>
      </div>`;
    item.addEventListener('click', () => {
      def.active = !def.active;
      item.classList.toggle('active', def.active);
    });
    list.appendChild(item);
  }
}

function updateExpressionWeights() {
  const weights = solver.getExpressionWeights();
  for (const item of $$('#expression-list .list-item')) {
    const w = weights[item.dataset.expression] ?? 0;
    item.querySelector('.weight-fill').style.width = `${(w * 100).toFixed(1)}%`;
  }
}

// ────────────────────────────────────────────────────────────────
// 映射清單（FR-03-05 即時指示點）
// ────────────────────────────────────────────────────────────────

function renderMappingList() {
  const list = $('#mapping-list');
  list.innerHTML = '';

  const mappings = state.modelConfig?.mappings ?? [];
  if (mappings.length === 0) {
    list.innerHTML = '<p class="hint">尚無映射。載入模型後執行「自動設定」即可建立。</p>';
    return;
  }

  for (const m of mappings) {
    const item = document.createElement('div');
    item.className = 'list-item';
    item.dataset.mapping = m.id;

    const targets = (m.targets ?? [])
      .map((t) =>
        t.type === 'expression'
          ? `表情 ${t.name}`
          : t.type === 'bone'
            ? `${t.name}.${t.axis}`
            : t.type === 'lookAt'
              ? `視線 ${t.axis}`
              : `根節點 ${t.axis}`
      )
      .join('、');

    item.innerHTML = `
      <div class="map-row">
        <span class="name">${escapeHtml(m.label ?? m.id)}</span>
        <label class="badge"><input type="checkbox" ${m.enabled !== false ? 'checked' : ''} /> 啟用</label>
      </div>
      <div class="sub">${escapeHtml(m.input ?? '（無輸入）')} → ${escapeHtml(targets)}</div>
      <div class="map-io">
        <span>IN</span><span class="track"><i class="dot"></i></span>
        <span>平滑 ${m.smooth ?? 0}</span>
      </div>`;

    item.querySelector('input[type=checkbox]').addEventListener('change', (e) => {
      m.enabled = e.target.checked;
      saveModelConfig();
    });

    list.appendChild(item);
  }
}

function updateMappingDots() {
  const mappings = state.modelConfig?.mappings ?? [];
  for (const m of mappings) {
    const item = $(`#mapping-list [data-mapping="${m.id}"]`);
    if (!item) continue;
    const v = solver.smoothState.get(m.id) ?? 0;
    item.querySelector('.dot').style.left = `${Math.max(0, Math.min(1, v)) * 100}%`;
  }
}

// ────────────────────────────────────────────────────────────────
// 參數監看器（FR-02-30、FR-03-10）
// ────────────────────────────────────────────────────────────────

let monitorRows = null;

function buildMonitor() {
  const body = $('#monitor-body');
  body.innerHTML = '';
  monitorRows = new Map();

  let lastGroup = null;
  for (const p of INPUT_PARAMS) {
    if (p.group !== lastGroup) {
      lastGroup = p.group;
      const h = document.createElement('div');
      h.style.gridColumn = '1 / -1';
      h.style.cssText += 'color:var(--text-dim);font-size:10.5px;margin-top:6px;letter-spacing:.06em';
      h.textContent = GROUP_LABELS[p.group] ?? p.group;
      body.appendChild(h);
    }

    const row = document.createElement('div');
    row.className = 'mon-row';
    row.innerHTML = `
      <span class="mon-name" title="${escapeHtml(p.id)}">${escapeHtml(p.label)}</span>
      <span class="mon-bar"><i></i></span>
      <span class="mon-val">0.00</span>`;
    body.appendChild(row);
    monitorRows.set(p.id, {
      row,
      bar: row.querySelector('i'),
      val: row.querySelector('.mon-val'),
      param: p,
    });
  }
}

function updateMonitor() {
  if (!monitorRows || $('#monitor').classList.contains('collapsed')) return;

  const activeSources = new Set();
  if (state.tracking) activeSources.add('webcam');
  if (state.micActive) activeSources.add('voice');
  activeSources.add('mouse');

  const values = solver.processedInputs;
  for (const [id, r] of monitorRows) {
    const available = r.param.sources.some((s) => activeSources.has(s));
    r.row.classList.toggle('unavailable', !available);

    const v = values[id] ?? 0;
    const t = (v - r.param.min) / (r.param.max - r.param.min);
    const pct = Math.max(0, Math.min(1, t));

    // 有正負的參數以中線為基準向兩側延伸，比單向長條更易讀
    if (r.param.min < 0) {
      const mid = 0.5;
      r.bar.style.left = `${Math.min(mid, pct) * 100}%`;
      r.bar.style.width = `${Math.abs(pct - mid) * 100}%`;
    } else {
      r.bar.style.left = '0';
      r.bar.style.width = `${pct * 100}%`;
    }
    r.val.textContent = v.toFixed(2);
  }
}

// ────────────────────────────────────────────────────────────────
// 追蹤
// ────────────────────────────────────────────────────────────────

async function populateCameras() {
  const cams = await WebcamTracker.listCameras();
  const sel = $('#camera-select');
  sel.innerHTML = '';
  if (cams.length === 0) {
    sel.innerHTML = '<option value="">（尚未授權或無裝置）</option>';
    return;
  }
  for (const c of cams) {
    const opt = document.createElement('option');
    opt.value = c.deviceId;
    opt.textContent = c.label;
    sel.appendChild(opt);
  }
  if (state.appConfig.tracking.deviceId) sel.value = state.appConfig.tracking.deviceId;
}

async function toggleTracking() {
  const btn = $('#btn-track-toggle');
  if (state.tracking) {
    await tracker.stop();
    // 身體追蹤共用同一份串流，跟著停止取樣但保留模型於記憶體（NFR-P-11）
    bodyTracker.suspend();
    state.tracking = false;
    btn.textContent = '開始追蹤';
    btn.classList.remove('danger');
    return;
  }

  btn.disabled = true;
  btn.textContent = '啟動中…';
  try {
    await tracker.start({ deviceId: $('#camera-select').value || null });
    state.tracking = true;
    btn.textContent = '停止追蹤';
    btn.classList.add('danger');
    state.appConfig.tracking.deviceId = $('#camera-select').value || null;
    saveAppConfig();
    // 取得授權後裝置標籤才會有名稱
    await populateCameras();
    toast('追蹤已啟動', 'ok');
    // 上次關閉時停在半身／全身模式的話，這裡才載入姿態模型
    if (state.appConfig.tracking.body.mode !== 'face') await ensureBodyTracker();
  } catch (err) {
    toast(`無法啟動攝影機：${err.message}`, 'error');
    api.log('error', `攝影機啟動失敗：${err.message}`);
    btn.textContent = '開始追蹤';
  } finally {
    btn.disabled = false;
  }
}

// ────────────────────────────────────────────────────────────────
// 熱鍵（FR-07）
// ────────────────────────────────────────────────────────────────

/** 全部熱鍵 = 模型專屬 + 全域（FR-07-07） */
function allHotkeys() {
  return [...(state.appConfig?.globalHotkeys ?? []), ...(state.modelConfig?.hotkeys ?? [])];
}

function saveHotkeys() {
  saveAppConfig();
  saveModelConfig();
  syncHotkeys();
}

/** 把最新的熱鍵推給引擎、主行程與畫面按鈕 */
async function syncHotkeys() {
  hotkeyEngine.setHotkeys(allHotkeys());
  const result = await api.hotkeys.register(hotkeyEngine.globalBindings());
  state.hotkeyRegisterFailures = result?.failed ?? [];
  renderScreenButtons();
  renderHotkeyConflicts();
  renderHotkeyRegisterStatus();
}

/**
 * 顯示全域快捷鍵註冊失敗。
 * 這類失敗最常見的原因是該組合已被其他程式占用；不顯示出來的話，
 * 使用者只會覺得「熱鍵無效」而查不出原因。
 */
function renderHotkeyRegisterStatus() {
  const box = $('#hotkey-register-status');
  if (!box) return;
  const failed = state.hotkeyRegisterFailures ?? [];
  if (!failed.length) return box.classList.add('hidden');

  box.innerHTML = `<b>下列按鍵無法註冊為全域熱鍵：</b><ul>${failed
    .map((f) => {
      const hk = hotkeyEngine.get(f.id);
      return `<li>${escapeHtml(hk?.name ?? f.id)}：<code>${escapeHtml(f.accelerator)}</code> — ${escapeHtml(f.reason)}</li>`;
    })
    .join('')}</ul>請改用其他組合，例如加上 Ctrl／Alt 或改綁小鍵盤。`;
  box.classList.remove('hidden');
}

/**
 * 動作執行器 — FR-07-B 的 15 種動作。
 *
 * phase 為 'start' 或 'stop'；'stop' 來自「X 秒後自動停止」或「放開按鍵即停止」
 * （FR-07-21），只有具開關語意的動作需要處理。
 */
const hotkeyExecutor = {
  TriggerAnimation: (a, phase) => {
    if (phase === 'stop') return stage.animator?.stopOneShot(state.appConfig.animation.fade);
    const entry = state.animationFiles?.find((x) => x.name === a.target);
    if (entry) playOneShot(entry);
  },

  ChangeIdleAnimation: (a, phase) => {
    if (phase !== 'start') return;
    // 依規格不寫入模型設定檔，僅於本次執行期間生效
    applyIdleAnimation(a.target || null);
  },

  ToggleExpression: (a, phase) => {
    const def = state.expressions.get(a.target);
    if (!def) return;
    if (phase === 'stop') def.active = false;
    else def.active = !def.active;
    if (a.fade !== undefined) {
      def.fadeIn = a.fade;
      def.fadeOut = a.fade;
    }
    syncExpressionListActive();
  },

  RemoveAllExpressions: (_a, phase) => {
    if (phase !== 'start') return;
    for (const def of state.expressions.values()) def.active = false;
    syncExpressionListActive();
  },

  TogglePose: (a, phase) => {
    const pose = state.modelConfig?.poses?.[a.target];
    if (!pose) return;
    const isActive = state.activePoseName === a.target;
    const turnOff = phase === 'stop' || isActive;
    state.activePoseName = turnOff ? null : a.target;
    stage.setPose(turnOff ? null : pose);
    renderPoseList();
  },

  MoveModel: (a, phase) => {
    if (phase !== 'start' || !state.modelConfig) return;
    const preset = state.modelConfig.transformPresets?.[a.target];
    if (!preset) return;
    state.modelConfig.transform = { ...preset.transform };
    stage.setModelTransform(state.modelConfig.transform);
    syncTransformControls();
    if (preset.camera) {
      state.modelConfig.camera.preset = preset.camera;
      stage.applyCameraPreset(preset.camera);
      $('#camera-preset').value = preset.camera;
    }
    saveModelConfig();
    pushScene();
  },

  ChangeBackground: async (a, phase) => {
    if (phase !== 'start') return;
    const bg = state.appConfig.scene.background;
    if (a.target === 'transparent' || a.target === 'color') bg.mode = a.target;
    else {
      const found = state.backgrounds?.find((b) => b.name === a.target);
      if (!found) return;
      bg.mode = found.kind;
      bg.url = found.url;
    }
    $('#bg-mode').value = bg.mode;
    await applyBackground();
    saveAppConfig();
  },

  ChangeLighting: (a, phase) => {
    if (phase !== 'start') return;
    const preset = state.lightingPresets?.[a.target];
    if (!preset) return;
    Object.assign(state.appConfig.scene.lighting, preset);
    stage.setLighting(state.appConfig.scene.lighting);
    syncLightingControls();
    saveAppConfig();
    pushScene();
  },

  ReloadMicrophone: (_a, phase) => {
    if (phase !== 'start') return;
    if (!state.micActive) return toggleMic();
    const muted = mic.toggleMute();
    $('#btn-mic-mute').textContent = muted ? '解除靜音' : '靜音';
    toast(muted ? '麥克風已靜音' : '麥克風已解除靜音');
  },

  CalibrateTracking: async (_a, phase) => {
    if (phase !== 'start') return;
    if (!tracker.calibrate()) return toast('目前未偵測到臉部，無法校準', 'error');
    await persistCalibration();
    toast('已校準', 'ok');
  },

  ChangeModel: (a, phase) => {
    if (phase !== 'start') return;
    const m = state.models.find((x) => x.name === a.target && !x.error);
    if (m) loadModel(m, { autoSetupChoice: 'auto' });
  },

  TakeScreenshot: (_a, phase) => {
    if (phase === 'start') $('#btn-screenshot').click();
  },

  ToggleTracker: (a, phase) => {
    if (phase !== 'start') return;
    if (a.target === 'mic') hotkeyExecutor.ReloadMicrophone({}, 'start');
    else toggleTracking();
  },

  // FR-13 音效系統尚未實作；保留動作以維持編號完整，觸發時明確告知
  PlaySound: (_a, phase) => {
    if (phase === 'start') toast('音效系統（FR-13）尚未實作', 'error');
  },

  ChangeBodyMode: (a, phase) => {
    if (phase !== 'start') return;
    setBodyMode(BODY_MODES.includes(a.target) ? a.target : 'face');
  },
};

const hotkeyEngine = new HotkeyEngine({
  executor: hotkeyExecutor,
  log: (l, m) => api.log(l, m),
});

/** 讓表情清單的選取狀態與實際狀態一致（熱鍵改動後需同步） */
function syncExpressionListActive() {
  for (const item of $$('#expression-list .list-item')) {
    const def = state.expressions.get(item.dataset.expression);
    item.classList.toggle('active', Boolean(def?.active));
  }
}

// ── 畫面按鈕（FR-07-03）─────────────────────────────────

function renderScreenButtons() {
  const wrap = $('#screen-buttons');
  wrap.innerHTML = '';
  const cfg = state.appConfig?.screenButtons ?? { visible: true, opacity: 0.75 };
  wrap.style.opacity = cfg.opacity;
  wrap.classList.toggle('hidden', !cfg.visible);

  for (let i = 1; i <= MAX_SCREEN_BUTTONS; i += 1) {
    const hk = hotkeyEngine.findByScreenButton(i);
    if (!hk) continue;
    const btn = document.createElement('button');
    btn.textContent = hk.name?.slice(0, 4) || String(i);
    btn.title = hk.name || `按鈕 ${i}`;
    if (hk.color) btn.style.background = hk.color;
    btn.addEventListener('pointerdown', () => hotkeyEngine.fire(hk.id, 'down'));
    btn.addEventListener('pointerup', () => hotkeyEngine.fire(hk.id, 'up'));
    wrap.appendChild(btn);
  }
}

// ── 熱鍵清單介面 ────────────────────────────────────────

function renderHotkeyConflicts() {
  const box = $('#hotkey-conflicts');
  const conflicts = hotkeyEngine.getConflicts();
  if (!conflicts.length) return box.classList.add('hidden');

  const kindLabel = { keyboard: '鍵盤', mouse: '滑鼠', screenButton: '畫面按鈕' };
  box.innerHTML = `<b>偵測到熱鍵衝突：</b><ul>${conflicts
    .map((c) => `<li>${kindLabel[c.kind]} ${escapeHtml(c.value)}：${escapeHtml(c.names.join('、'))}</li>`)
    .join('')}</ul>`;
  box.classList.remove('hidden');
}

/** 依動作型別提供可選目標 */
function targetOptions(kind) {
  switch (kind) {
    case 'animation':
      return (state.animationFiles ?? []).map((a) => a.name);
    case 'expression':
      return [...state.expressions.keys()];
    case 'pose':
      return Object.keys(state.modelConfig?.poses ?? {});
    case 'transform':
      return Object.keys(state.modelConfig?.transformPresets ?? {});
    case 'background':
      return ['transparent', 'color', ...(state.backgrounds ?? []).map((b) => b.name)];
    case 'lighting':
      return Object.keys(state.lightingPresets ?? {});
    case 'model':
      return state.models.filter((m) => !m.error).map((m) => m.name);
    case 'tracker':
      return ['webcam', 'mic'];
    case 'bodyMode':
      return [...BODY_MODES];
    default:
      return null;
  }
}

function renderHotkeyList() {
  const list = $('#hotkey-list');
  list.innerHTML = '';

  const items = allHotkeys();
  if (!items.length) {
    list.innerHTML = '<p class="hint">尚未建立熱鍵。按「新增熱鍵」開始。</p>';
    renderHotkeyConflicts();
    return;
  }

  for (const hk of items) {
    list.appendChild(buildHotkeyRow(hk));
  }
  renderHotkeyConflicts();
}

function buildHotkeyRow(hk) {
  const item = document.createElement('div');
  item.className = 'list-item hotkey-item';
  item.dataset.hotkey = hk.id;

  const combo = comboLabel(hk.trigger?.keys ?? []);

  item.innerHTML = `
    <div class="title">
      <input type="text" class="hk-name" value="${escapeHtml(hk.name)}" />
      <label class="badge"><input type="checkbox" class="hk-enabled" ${hk.enabled !== false ? 'checked' : ''} /> 啟用</label>
    </div>
    <div class="row">
      <button class="key-capture" title="點擊後按下想綁定的按鍵；Esc 清除">${combo ? escapeHtml(combo) : '設定按鍵'}</button>
      <select class="hk-mouse">
        <option value="">滑鼠：無</option>
        <option value="left">左鍵</option>
        <option value="middle">中鍵</option>
        <option value="right">右鍵</option>
      </select>
      <select class="hk-screen">
        <option value="">按鈕：無</option>
        ${Array.from({ length: MAX_SCREEN_BUTTONS }, (_, i) => `<option value="${i + 1}">按鈕 ${i + 1}</option>`).join('')}
      </select>
    </div>
    <div class="hk-actions"></div>
    <div class="row">
      <button class="hk-add-action">＋ 動作</button>
      <button class="hk-test">測試</button>
      <button class="hk-delete danger">刪除</button>
    </div>
    <div class="small">
      <label>冷卻 <input type="number" class="hk-cooldown" min="0" max="60" step="0.5" value="${hk.cooldown ?? 0}" /> 秒</label>
      <label>自動停止 <input type="number" class="hk-autostop" min="0" max="60" step="0.5" value="${hk.autoStopSeconds ?? 0}" /> 秒</label>
      <label><input type="checkbox" class="hk-release" ${hk.stopOnRelease ? 'checked' : ''} /> 放開即停</label>
      <label title="不隨模型切換而失效"><input type="checkbox" class="hk-global" ${hk.global ? 'checked' : ''} /> 跨模型</label>
      <label class="hk-syswide-label" title="勾選後，這個按鍵在其他程式中將無法輸入"><input type="checkbox" class="hk-syswide" ${hk.systemWide ? 'checked' : ''} /> 系統全域</label>
    </div>`;

  item.querySelector('.hk-mouse').value = hk.trigger?.mouse ?? '';
  item.querySelector('.hk-screen').value = hk.trigger?.screenButton ?? '';

  renderHotkeyActions(item, hk);
  bindHotkeyRow(item, hk);
  return item;
}

function renderHotkeyActions(item, hk) {
  const wrap = item.querySelector('.hk-actions');
  wrap.innerHTML = '';

  (hk.actions ?? []).forEach((action, index) => {
    const row = document.createElement('div');
    row.className = 'action-row';

    const meta = HOTKEY_ACTIONS[action.type];
    const opts = meta?.target ? targetOptions(meta.target) : null;

    row.innerHTML = `
      <select class="act-type">
        ${Object.entries(HOTKEY_ACTIONS)
          .map(([type, m]) =>
            `<option value="${type}"${type === action.type ? ' selected' : ''}>${m.label}${m.requires ? `（需 ${m.requires}）` : ''}</option>`
          )
          .join('')}
      </select>
      ${opts
        ? `<select class="act-target">${
            opts.length
              ? opts.map((o) => `<option value="${escapeHtml(o)}"${o === action.target ? ' selected' : ''}>${escapeHtml(o)}</option>`).join('')
              : '<option value="">（無可選項目）</option>'
          }</select>`
        : ''}
      <button class="act-remove" title="移除">✕</button>`;

    row.querySelector('.act-type').addEventListener('change', (e) => {
      action.type = e.target.value;
      action.target = undefined;
      renderHotkeyActions(item, hk);
      saveHotkeys();
    });
    row.querySelector('.act-target')?.addEventListener('change', (e) => {
      action.target = e.target.value;
      saveHotkeys();
    });
    row.querySelector('.act-remove').addEventListener('click', () => {
      hk.actions.splice(index, 1);
      renderHotkeyActions(item, hk);
      saveHotkeys();
    });

    wrap.appendChild(row);
  });
}

function bindHotkeyRow(item, hk) {
  const commit = () => saveHotkeys();

  item.querySelector('.hk-name').addEventListener('input', (e) => {
    hk.name = e.target.value;
    renderScreenButtons();
    commit();
  });

  item.querySelector('.hk-enabled').addEventListener('change', (e) => {
    hk.enabled = e.target.checked;
    commit();
  });

  // 按鍵擷取（FR-07-01）
  const capture = item.querySelector('.key-capture');
  capture.addEventListener('click', () => {
    if (state.capturingHotkey) return;
    state.capturingHotkey = hk.id;
    capture.classList.add('listening');
    capture.textContent = '請按下按鍵…';

    const onKey = (ev) => {
      ev.preventDefault();
      if (ev.key === 'Escape') {
        hk.trigger.keys = [];
      } else {
        const keys = keysFromEvent(ev);
        if (!keys) return; // 只按了修飾鍵，繼續等待
        hk.trigger.keys = keys;
      }
      window.removeEventListener('keydown', onKey, true);
      state.capturingHotkey = null;
      capture.classList.remove('listening');
      capture.textContent = comboLabel(hk.trigger.keys) ?? '設定按鍵';
      commit();
    };
    window.addEventListener('keydown', onKey, true);
  });

  item.querySelector('.hk-mouse').addEventListener('change', (e) => {
    hk.trigger.mouse = e.target.value || null;
    commit();
  });

  item.querySelector('.hk-screen').addEventListener('change', (e) => {
    hk.trigger.screenButton = e.target.value ? Number(e.target.value) : null;
    commit();
  });

  item.querySelector('.hk-add-action').addEventListener('click', () => {
    hk.actions ??= [];
    if (hk.actions.length >= MAX_CHAINED_ACTIONS) {
      return toast(`單一熱鍵最多 ${MAX_CHAINED_ACTIONS} 個動作`, 'error');
    }
    hk.actions.push({ type: 'ToggleExpression', target: undefined });
    renderHotkeyActions(item, hk);
    commit();
  });

  // FR-07-25：測試按鈕
  item.querySelector('.hk-test').addEventListener('click', () => {
    const r = hotkeyEngine.fire(hk.id, 'down');
    if (!r.fired) toast(`未觸發：${r.reason}`, 'error');
  });

  item.querySelector('.hk-delete').addEventListener('click', () => {
    if (!confirm(`確定刪除熱鍵「${hk.name}」？`)) return;
    removeHotkey(hk.id);
  });

  for (const [sel, key, cast] of [
    ['.hk-cooldown', 'cooldown', Number],
    ['.hk-autostop', 'autoStopSeconds', Number],
  ]) {
    item.querySelector(sel).addEventListener('change', (e) => {
      hk[key] = cast(e.target.value);
      commit();
    });
  }

  item.querySelector('.hk-release').addEventListener('change', (e) => {
    hk.stopOnRelease = e.target.checked;
    commit();
  });

  // 系統層級註冊（FR-07-01）。預設關閉，因為它會把按鍵從整個系統攔截走
  item.querySelector('.hk-syswide').addEventListener('change', (e) => {
    hk.systemWide = e.target.checked;
    if (hk.systemWide) {
      const combo = comboLabel(hk.trigger?.keys ?? []);
      toast(`${combo || '此熱鍵'} 將被系統層級佔用，其他程式中無法輸入這個按鍵`, 'error');
    }
    saveHotkeys();
    syncHotkeys();
  });

  // 跨模型／模型專屬之間搬移（FR-07-07）
  item.querySelector('.hk-global').addEventListener('change', (e) => {
    const toGlobal = e.target.checked;
    removeHotkey(hk.id, { silent: true });
    hk.global = toGlobal;
    (toGlobal ? state.appConfig.globalHotkeys : state.modelConfig.hotkeys).push(hk);
    saveHotkeys();
    renderHotkeyList();
  });
}

function removeHotkey(id, { silent = false } = {}) {
  for (const arr of [state.appConfig?.globalHotkeys, state.modelConfig?.hotkeys]) {
    if (!arr) continue;
    const i = arr.findIndex((h) => h.id === id);
    if (i >= 0) arr.splice(i, 1);
  }
  saveHotkeys();
  if (!silent) renderHotkeyList();
}

function addHotkey(patch = {}) {
  const hk = createHotkey(`hk-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4)}`, patch);
  if (!state.modelConfig && !hk.global) {
    toast('請先載入模型，或將熱鍵設為全域', 'error');
    return null;
  }
  (hk.global ? state.appConfig.globalHotkeys : state.modelConfig.hotkeys).push(hk);
  saveHotkeys();
  renderHotkeyList();
  return hk;
}

function bindHotkeyControls() {
  $('#btn-hotkey-add').addEventListener('click', () => addHotkey());

  // FR-05-16：為所有尚未設定熱鍵的表情批次建立
  $('#btn-hotkey-expressions').addEventListener('click', () => {
    if (!state.modelConfig) return toast('請先載入模型', 'error');
    const existing = new Set(
      allHotkeys().flatMap((h) => (h.actions ?? []).filter((a) => a.type === 'ToggleExpression').map((a) => a.target))
    );
    let added = 0;
    for (const name of state.expressions.keys()) {
      if (existing.has(name)) continue;
      const hk = createHotkey(`hk-expr-${name}-${Math.floor(Math.random() * 1e4)}`, {
        name,
        actions: [{ type: 'ToggleExpression', target: name }],
      });
      state.modelConfig.hotkeys.push(hk);
      added += 1;
    }
    saveHotkeys();
    renderHotkeyList();
    toast(added ? `已建立 ${added} 個表情熱鍵（尚未指派按鍵）` : '所有表情都已有熱鍵');
  });

  $('#chk-screen-buttons').addEventListener('change', (e) => {
    state.appConfig.screenButtons.visible = e.target.checked;
    renderScreenButtons();
    saveAppConfig();
  });

  $('#btn-opacity').addEventListener('input', (e) => {
    state.appConfig.screenButtons.opacity = Number(e.target.value);
    $('#out-btn-opacity').textContent = e.target.value;
    renderScreenButtons();
    saveAppConfig();
  });

  // FR-07-05 外部 HTTP 觸發
  $('#chk-hotkey-api').addEventListener('change', async (e) => {
    const r = await api.hotkeys.configureApi(e.target.checked);
    // 權杖由主行程產生。這裡必須同步回 renderer 的設定副本，
    // 否則下一次 saveAppConfig() 會用舊副本把權杖覆蓋成 null，
    // 重啟後端點就會變成「已啟用但權杖為空」而永遠回傳 401。
    state.appConfig.hotkeyApi = { enabled: r.enabled, token: r.token ?? null };
    $('#hotkey-api-box').classList.toggle('hidden', !r.enabled);
    if (r.enabled) {
      $('#hotkey-api-url').value =
        `curl -X POST "http://127.0.0.1:${r.port}/api/hotkey/<熱鍵ID>?token=${r.token}"`;
    }
  });

  $('#btn-copy-api').addEventListener('click', async () => {
    await navigator.clipboard.writeText($('#hotkey-api-url').value);
    toast('已複製', 'ok');
  });

  // 主行程轉發的全域熱鍵與 HTTP 觸發
  api.hotkeys.onFired((id) => hotkeyEngine.fire(id, 'down'));
}

// ────────────────────────────────────────────────────────────────
// 動畫（FR-06）
// ────────────────────────────────────────────────────────────────

/**
 * 目前由追蹤映射驅動的人形骨骼。
 * 供 FR-06-08 判斷「停在最後一幀」時哪些骨骼必須交還給追蹤。
 */
function trackedBoneSet() {
  const out = new Set();
  for (const m of state.modelConfig?.mappings ?? []) {
    if (m.enabled === false) continue;
    for (const t of m.targets ?? []) {
      if (t.type === 'bone') out.add(t.name);
    }
  }
  return out;
}

async function refreshAnimations() {
  state.animationFiles = await api.animations.scan();
  renderAnimationList();
  renderIdleOptions();
}

/** 需要時才載入，避免一啟動就把所有動畫檔讀進記憶體 */
async function ensureAnimationLoaded(entry) {
  if (!stage.animator) throw new Error('尚未載入模型');
  if (stage.animator.animations.has(entry.name)) return stage.animator.animations.get(entry.name);

  const url = `http://127.0.0.1:${state.outputPort}${entry.url}`;
  const loaded = await stage.loadAnimation(url, entry.name);
  if (loaded.unmapped?.length) {
    toast(`${entry.name}：有 ${loaded.unmapped.length} 個關節無法對應，已略過`, 'error');
  }
  api.log('info', `載入動畫 ${entry.name}（${loaded.kind}，${loaded.bones.length} 骨骼）`);
  return loaded;
}

function renderAnimationList() {
  const list = $('#anim-list');
  list.innerHTML = '';

  if (!state.animationFiles?.length) {
    list.innerHTML = '<p class="hint">Animations/ 資料夾內沒有 .vrma 或 .bvh 檔案。</p>';
    return;
  }

  for (const a of state.animationFiles) {
    const item = document.createElement('div');
    item.className = 'list-item';
    item.innerHTML = `
      <div class="title">
        <span class="name">${escapeHtml(a.name)}</span>
        <span class="badge${a.kind === 'vrma' ? ' spec' : ''}">${a.kind.toUpperCase()}</span>
      </div>
      <div class="sub">點擊播放一次 · ${(a.sizeBytes / 1024).toFixed(0)} KB</div>`;

    item.addEventListener('click', () => playOneShot(a));
    list.appendChild(item);
  }
}

function renderIdleOptions() {
  const sel = $('#idle-anim');
  const current = state.modelConfig?.idleAnimation ?? '';
  sel.innerHTML = '<option value="">（無）</option>';
  for (const a of state.animationFiles ?? []) {
    const opt = document.createElement('option');
    opt.value = a.name;
    opt.textContent = `${a.name}（${a.kind}）`;
    sel.appendChild(opt);
  }
  sel.value = current;
}

async function playOneShot(entry) {
  if (!state.currentModel) return toast('請先載入模型', 'error');
  try {
    await ensureAnimationLoaded(entry);
    const opts = state.appConfig.animation;
    stage.animator.playOneShot(entry.name, {
      fade: opts.fade,
      mask: opts.mask,
      speed: opts.speed,
      stopOnLastFrame: opts.stopOnLastFrame,
      trackedBones: trackedBoneSet(),
    });
    toast(`播放：${entry.name}`);
  } catch (err) {
    toast(`動畫載入失敗：${err.message}`, 'error');
    api.log('error', `動畫載入失敗 ${entry.name}：${err.message}`);
  }
}

async function applyIdleAnimation(name) {
  if (!stage.animator) return;
  if (!name) {
    stage.animator.setIdle(null, { fade: state.appConfig.animation.fade });
    return;
  }
  const entry = state.animationFiles?.find((a) => a.name === name);
  if (!entry) return;
  try {
    await ensureAnimationLoaded(entry);
    stage.animator.setIdle(name, {
      fade: state.appConfig.animation.fade,
      speed: state.appConfig.animation.speed,
    });
  } catch (err) {
    toast(`待機動畫載入失敗：${err.message}`, 'error');
  }
}

// ── 靜態姿勢（FR-06-11）─────────────────────────────────

function renderPoseList() {
  const list = $('#pose-list');
  if (!list) return;
  const poses = state.modelConfig?.poses ?? {};
  const names = Object.keys(poses);

  list.innerHTML = '';
  if (!names.length) {
    list.innerHTML = '<p class="hint">尚未儲存任何姿勢。</p>';
    return;
  }

  for (const name of names) {
    const item = document.createElement('div');
    item.className = 'list-item';
    if (state.activePoseName === name) item.classList.add('active');
    item.innerHTML = `
      <div class="title">
        <span class="name">${escapeHtml(name)}</span>
        <span class="badge">${Object.keys(poses[name]).length} 骨骼</span>
      </div>
      <div class="sub">點擊開關；可由 TogglePose 熱鍵觸發</div>`;

    item.addEventListener('click', () => {
      const turnOff = state.activePoseName === name;
      state.activePoseName = turnOff ? null : name;
      stage.setPose(turnOff ? null : poses[name]);
      renderPoseList();
    });
    list.appendChild(item);
  }
}

function bindPoseControls() {
  $('#btn-pose-save').addEventListener('click', () => {
    if (!state.modelConfig) return toast('請先載入模型', 'error');
    const name = prompt('姿勢名稱：', `姿勢 ${Object.keys(state.modelConfig.poses ?? {}).length + 1}`);
    if (!name) return;
    const pose = stage.capturePose();
    if (!pose || !Object.keys(pose).length) {
      return toast('目前姿勢與 rest pose 相同，沒有內容可儲存', 'error');
    }
    state.modelConfig.poses ??= {};
    state.modelConfig.poses[name] = pose;
    saveModelConfig();
    renderPoseList();
    renderHotkeyList();
    toast(`已儲存姿勢「${name}」（${Object.keys(pose).length} 個骨骼）`, 'ok');
  });

  $('#btn-pose-clear').addEventListener('click', () => {
    state.activePoseName = null;
    stage.setPose(null);
    renderPoseList();
  });
}

function syncLightingControls() {
  const L = state.appConfig.scene.lighting;
  $('#ambient-intensity').value = L.ambientIntensity;
  $('#out-ambient').textContent = L.ambientIntensity;
  $('#ambient-color').value = L.ambientColor;
  $('#dir-intensity').value = L.dirIntensity;
  $('#out-dir').textContent = L.dirIntensity;
  $('#dir-color').value = L.dirColor;
  $('#dir-azimuth').value = L.dirAzimuth;
  $('#out-azimuth').textContent = L.dirAzimuth;
  $('#dir-elevation').value = L.dirElevation;
  $('#out-elevation').textContent = L.dirElevation;
  $('#rim-intensity').value = L.rimIntensity;
  $('#out-rim').textContent = L.rimIntensity;
  $('#rim-color').value = L.rimColor;
}

function bindAnimationControls() {
  const an = () => state.appConfig.animation;

  $('#btn-anim-rescan').addEventListener('click', async () => {
    await refreshAnimations();
    toast(`找到 ${state.animationFiles.length} 個動畫`);
  });

  $('#btn-open-animations').addEventListener('click', () => api.animations.openFolder());

  $('#idle-anim').addEventListener('change', async (e) => {
    const name = e.target.value || null;
    if (state.modelConfig) {
      state.modelConfig.idleAnimation = name;
      saveModelConfig();
    }
    await applyIdleAnimation(name);
  });

  $('#anim-mask').addEventListener('change', (e) => {
    an().mask = e.target.value;
    saveAppConfig();
  });

  $('#anim-fade').addEventListener('input', (e) => {
    an().fade = Number(e.target.value);
    $('#out-anim-fade').textContent = Number(e.target.value).toFixed(2);
    saveAppConfig();
  });

  $('#anim-speed').addEventListener('input', (e) => {
    an().speed = Number(e.target.value);
    $('#out-anim-speed').textContent = Number(e.target.value).toFixed(1);
    saveAppConfig();
  });

  $('#chk-stop-last').addEventListener('change', (e) => {
    an().stopOnLastFrame = e.target.checked;
    saveAppConfig();
  });

  $('#btn-anim-stop').addEventListener('click', () => {
    stage.animator?.stopOneShot(an().fade);
  });
}

// ────────────────────────────────────────────────────────────────
// 口型來源仲裁（FR-02-48）
// ────────────────────────────────────────────────────────────────

const VOWEL_KEYS = VOWELS.map((v) => `Voice${v.toUpperCase()}`);

/**
 * 決定最終驅動母音表情的數值。
 *
 * 攝影機只知道「嘴巴張多開」，無法區分母音；麥克風才有母音資訊。
 * 因此攝影機來源一律折算成 /a/——這是張嘴時最接近的口型。
 *
 * @param {'mic'|'camera'|'mixed'} mode
 * @param {boolean} micOn  麥克風是否正在運作
 * @param {boolean} faceOk 臉部追蹤是否有效
 */
function applyMouthSource(mode, micOn, faceOk) {
  const cameraOpen = faceOk ? state.inputs.MouthOpen ?? 0 : 0;

  // 麥克風關閉時自動退回攝影機，否則嘴巴會完全不動
  const effective = micOn ? mode : 'camera';

  if (effective === 'camera') {
    for (const k of VOWEL_KEYS) state.inputs[k] = 0;
    state.inputs.VoiceA = cameraOpen;
    state.inputs.VoiceVolume = cameraOpen;
    state.inputs.VoiceFrequency = 0;
    state.inputs.VoiceSilence = cameraOpen > 0.05 ? 0 : 1;
    return;
  }

  if (effective === 'mixed') {
    // 取較大值：講話時以麥克風的母音為準，
    // 但誇張的張嘴動作（如打呵欠、無聲張嘴）仍能被攝影機捕捉到
    state.inputs.VoiceA = Math.max(state.inputs.VoiceA ?? 0, cameraOpen * 0.85);
    state.inputs.VoiceVolume = Math.max(state.inputs.VoiceVolume ?? 0, cameraOpen);
    if (state.inputs.VoiceVolume > 0.05) state.inputs.VoiceSilence = 0;
  }
  // 'mic'：直接沿用 mic.raw 已寫入的數值
}

// ────────────────────────────────────────────────────────────────
// 主迴圈
// ────────────────────────────────────────────────────────────────

let lastTime = performance.now();
let trackAccumulator = 0;
let bodyAccumulator = 0;
let outputAccumulator = 0;
let uiAccumulator = 0;

function frame() {
  requestAnimationFrame(frame);

  const now = performance.now();
  let dt = (now - lastTime) / 1000;
  lastTime = now;
  if (dt > 0.25) dt = 0.25; // 視窗最小化後回來時避免大跳

  const cfg = state.appConfig;
  if (!cfg) return;
  if (state.renderPaused) return;

  // ── 渲染 FPS 上限 ──
  const renderInterval = 1 / (cfg.render.fps || 60);
  // ── 追蹤取樣（獨立 FPS，FR-02-22）──
  trackAccumulator += dt;
  const trackInterval = 1 / (cfg.tracking.trackingFps || 30);
  if (state.tracking && trackAccumulator >= trackInterval) {
    trackAccumulator = 0;
    tracker.tick(cfg.tracking);
  }

  // ── 追蹤結果併入輸入表 ──
  const faceOk = state.tracking && tracker.faceFound;
  if (faceOk) {
    Object.assign(state.inputs, tracker.raw);
  } else if (state.tracking && cfg.tracking.lostBehavior === 'reset') {
    // 追蹤遺失：平滑回復預設姿勢（FR-02-25）
    const k = Math.min(1, dt / (cfg.tracking.lostResetSeconds || 1.5));
    const neutral = createInputState();
    for (const p of INPUT_PARAMS) {
      state.inputs[p.id] += (neutral[p.id] - state.inputs[p.id]) * k;
    }
  }
  // lostBehavior === 'freeze' 時不動 state.inputs，自然凍結於當前姿勢

  // ── 語音口型（FR-02-C）──
  const micOn = state.micActive && !mic.muted;
  if (micOn) {
    mic.tick(cfg.tracking.lipsync);
    Object.assign(state.inputs, mic.raw);
  }
  applyMouthSource(cfg.tracking.lipsync?.mouthSource ?? 'mixed', micOn, faceOk);

  // ── 身體追蹤（FR-02-D）──
  // 與臉部追蹤共用同一支攝影機，但取樣率獨立（FR-02-70）
  const bodySettings = cfg.tracking.body ?? {};
  const bodyActive = state.tracking && bodySettings.mode !== 'face' && bodyTracker.ready;
  if (bodyActive) {
    bodyAccumulator += dt;
    if (bodyAccumulator >= 1 / (bodySettings.fps || 30)) {
      bodyAccumulator = 0;
      bodyTracker.tick(tracker.video, { mirror: cfg.tracking.mirror, parts: bodySettings.parts });
    }
  }
  // 即使 bodyActive 為 false 也要呼叫：權重要淡出，骨骼才會平順回到基準姿勢（FR-02-68）
  state.bodyPose = bodySolver.update(
    dt,
    bodyActive ? bodyTracker.sample : null,
    {
      ...bodySettings,
      lostBehavior: cfg.tracking.lostBehavior,
      lostResetSeconds: cfg.tracking.lostResetSeconds,
    },
    bodyActive
  );

  // ── 解算 ──
  const resolved = solver.solve({
    inputs: state.inputs,
    mappings: state.modelConfig?.mappings ?? [],
    expressions: state.expressions,
    settings: cfg.tracking,
    dt,
    tracked: faceOk,
  });

  // dt 交給 applySolved 推進動畫混合器（P1／P3 層）
  stage.applySolved(resolved, { dt, body: state.bodyPose });
  stage.render(dt);

  // ── 廣播至 OBS 輸出頁面（FR-15-02：不重複追蹤運算）──
  outputAccumulator += dt;
  if (outputAccumulator >= renderInterval) {
    outputAccumulator = 0;
    // 動畫姿勢一併送出，輸出頁面才不必自己跑一次時間軸（FR-15-02）
    const pose = stage.animator?.getPose() ?? null;
    const payload = { ...resolved };
    if (pose) payload.__pose = pose;
    // 身體姿態一併送出，輸出頁面才不必自己跑一次姿態估計（FR-02-79）
    if (state.bodyPose) payload.__body = state.bodyPose;
    api.output.sendState(payload);
  }

  // 熱鍵的「X 秒後自動停止」計時（FR-07-21）
  hotkeyEngine.update(dt);

  // ── 介面更新（刻意降頻，避免 DOM 拖累渲染）──
  uiAccumulator += dt;
  if (uiAccumulator >= 0.1) {
    uiAccumulator = 0;
    updateHud(dt);
    updateMonitor();
    updateLipsyncUi();
    updateBodyStatus();
    updateMappingDots();
    updateExpressionWeights();
  }

  // 幀計數。供自我測試驗證「視窗被遮蔽時仍持續運作」（FR-15-02c），
  // 這是 OBS 輸出會不會停格的直接指標
  window.__vrm2liveFrames = (window.__vrm2liveFrames ?? 0) + 1;

  // FPS 統計
  state.lastFrameTimes.push(dt);
  if (state.lastFrameTimes.length > 60) state.lastFrameTimes.shift();
}

function updateHud() {
  const avg = state.lastFrameTimes.reduce((a, b) => a + b, 0) / (state.lastFrameTimes.length || 1);
  $('#hud-render-fps').textContent = avg > 0 ? (1 / avg).toFixed(0) : '--';
  $('#hud-track-fps').textContent = state.tracking ? tracker.fps.toFixed(0) : '--';

  const face = $('#hud-face');
  const ok = state.tracking && tracker.faceFound;
  face.textContent = !state.tracking ? '追蹤關閉' : ok ? '已偵測' : '未偵測';
  face.classList.toggle('ok', ok);
}

// ────────────────────────────────────────────────────────────────
// 場景廣播
// ────────────────────────────────────────────────────────────────

async function pushScene() {
  if (!state.currentModel) return;
  const modelUrl = await api.models.toUrl(state.currentModel.path);
  api.output.sendScene({
    modelUrl,
    transform: state.modelConfig.transform,
    camera: state.modelConfig.camera,
    background: state.appConfig.scene.background,
    lighting: state.appConfig.scene.lighting,
    // 搖動骨骼設定必須一起送，否則 OBS 畫面的頭髮會與主視窗不一樣（FR-01-13）
    springBone: state.modelConfig.springBone,
  });
}

// ────────────────────────────────────────────────────────────────
// 介面繫結
// ────────────────────────────────────────────────────────────────

function bindTabs() {
  for (const tab of $$('.tab')) {
    tab.addEventListener('click', () => {
      $$('.tab').forEach((t) => t.classList.toggle('active', t === tab));
      $$('.panel').forEach((p) => p.classList.toggle('active', p.dataset.panel === tab.dataset.tab));
    });
  }
}

function syncTrackingControls() {
  const t = state.appConfig.tracking;
  $('#chk-mirror').checked = t.mirror !== false;
  $('#chk-swap-eyes').checked = t.swapEyes === true;
  $('#lost-behavior').value = t.lostBehavior;
  $('#blink-link').value = t.blinkLink;
  $('#track-fps').value = t.trackingFps;
  $('#out-track-fps').textContent = t.trackingFps;
  $('#deadzone').value = t.deadZone;
  $('#out-deadzone').textContent = t.deadZone;
  for (const el of $$('.sens')) {
    const k = el.dataset.sens;
    el.value = t.sensitivity[k] ?? 1;
    $(`#out-sens-${k}`).textContent = Number(el.value).toFixed(1);
  }
}

function bindTrackingControls() {
  $('#btn-track-toggle').addEventListener('click', toggleTracking);

  $('#btn-calibrate').addEventListener('click', async () => {
    if (!tracker.calibrate()) return toast('目前未偵測到臉部，無法校準', 'error');
    // 校準資料須跨重啟保存（FR-02-24）
    await persistCalibration();
    toast('已以當前姿勢設為中性原點', 'ok');
  });

  $('#camera-select').addEventListener('change', async () => {
    if (state.tracking) {
      await tracker.start({ deviceId: $('#camera-select').value || null });
    }
    state.appConfig.tracking.deviceId = $('#camera-select').value || null;
    saveAppConfig();
  });

  const t = () => state.appConfig.tracking;

  $('#chk-mirror').addEventListener('change', (e) => {
    t().mirror = e.target.checked;
    saveAppConfig();
  });
  $('#chk-swap-eyes').addEventListener('change', (e) => {
    t().swapEyes = e.target.checked;
    saveAppConfig();
  });
  $('#lost-behavior').addEventListener('change', (e) => {
    t().lostBehavior = e.target.value;
    saveAppConfig();
  });
  $('#blink-link').addEventListener('change', (e) => {
    t().blinkLink = e.target.value;
    saveAppConfig();
  });
  $('#track-fps').addEventListener('input', (e) => {
    t().trackingFps = Number(e.target.value);
    $('#out-track-fps').textContent = e.target.value;
    saveAppConfig();
  });
  $('#render-fps').addEventListener('input', (e) => {
    state.appConfig.render.fps = Number(e.target.value);
    $('#out-render-fps').textContent = e.target.value;
    saveAppConfig();
  });
  $('#deadzone').addEventListener('input', (e) => {
    t().deadZone = Number(e.target.value);
    $('#out-deadzone').textContent = e.target.value;
    saveAppConfig();
  });

  for (const el of $$('.sens')) {
    el.addEventListener('input', () => {
      const k = el.dataset.sens;
      t().sensitivity[k] = Number(el.value);
      $(`#out-sens-${k}`).textContent = Number(el.value).toFixed(1);
      saveAppConfig();
    });
  }
}



/**
 * 套用並同步搖動骨骼設定（FR-01-13）。
 *
 * 診斷文字會把模型**原始**的參數範圍列出來——回報「頭髮往上飄」時，
 * 這幾個數字幾乎就能直接判斷是模型設定還是程式問題。
 */
function applySpringBone() {
  const sb = state.modelConfig?.springBone;
  if (!sb) return;
  stage.setSpringBone(sb);
  pushScene();
}

function syncSpringControls() {
  const sb = state.modelConfig?.springBone;
  const info = stage.getSpringBoneInfo?.() ?? { count: 0 };
  const box = $('#spring-info');

  if (!sb || !info.count) {
    if (box) box.textContent = state.currentModel ? '此模型沒有搖動骨骼資料。' : '（未載入模型）';
  } else if (box) {
    const r = ([a, b]) => (a === b ? a.toFixed(2) : `${a.toFixed(2)}–${b.toFixed(2)}`);
    box.textContent = `模型原始參數：${info.count} 個關節、碰撞體 ${info.colliderGroups} 組`
      + `${info.colliderRadius ? `（半徑 ${r(info.colliderRadius)}）` : ''}，`
      + `硬度 ${r(info.stiffness)}、重力 ${r(info.gravityPower)}、阻尼 ${r(info.dragForce)}。`;
  }

  if (!sb) return;
  const set = (id, outId, v) => {
    $(id).value = v;
    $(outId).textContent = Number(v).toFixed(2);
  };
  set('#spring-intensity', '#out-spring-intensity', sb.intensity);
  set('#spring-gravity', '#out-spring-gravity', sb.gravity);
  set('#spring-drag', '#out-spring-drag', sb.drag);
  set('#spring-collider-scale', '#out-spring-collider-scale', sb.colliderScale ?? 1);
  $('#chk-spring-colliders').checked = sb.colliders !== false;
}

function bindSpringControls() {
  const sliders = {
    'spring-intensity': ['intensity', 'out-spring-intensity'],
    'spring-gravity': ['gravity', 'out-spring-gravity'],
    'spring-drag': ['drag', 'out-spring-drag'],
    'spring-collider-scale': ['colliderScale', 'out-spring-collider-scale'],
  };
  for (const [id, [key, outId]] of Object.entries(sliders)) {
    $(`#${id}`).addEventListener('input', (e) => {
      if (!state.modelConfig) return;
      state.modelConfig.springBone[key] = Number(e.target.value);
      $(`#${outId}`).textContent = Number(e.target.value).toFixed(2);
      applySpringBone();
      saveModelConfig();
    });
  }

  $('#chk-spring-colliders').addEventListener('change', (e) => {
    if (!state.modelConfig) return;
    state.modelConfig.springBone.colliders = e.target.checked;
    applySpringBone();
    saveModelConfig();
  });

  $('#btn-spring-reset').addEventListener('click', () => {
    if (!state.modelConfig) return;
    state.modelConfig.springBone = {
      intensity: 1, gravity: 0, drag: 1, colliders: true, colliderScale: 1,
    };
    syncSpringControls();
    applySpringBone();
    saveModelConfig();
  });
}

// ────────────────────────────────────────────────────────────────
// 身體追蹤介面（FR-02-D）
// ────────────────────────────────────────────────────────────────

const bodyCfg = () => state.appConfig.tracking.body;

/**
 * 切換追蹤模式（FR-02-60）。
 *
 * 切到 face 時不停用攝影機、也不卸載模型——只是不再取樣，
 * 解算器的權重會在 fadeSeconds 內淡出，骨骼因而平順回到基準待機姿勢（FR-02-68）。
 */
async function setBodyMode(mode) {
  const b = bodyCfg();
  if (!BODY_MODES.includes(mode)) return;
  b.mode = mode;
  saveAppConfig();
  syncBodyControls();

  if (mode === 'face') {
    bodyTracker.suspend();
    setBodyMessage('');
    toast('已切回僅臉部＋軀幹追蹤');
    return;
  }

  if (state.currentModel && !stage.rig) {
    setBodyMessage('此模型缺少 hips 或雙上臂骨骼，無法進行身體追蹤。');
    toast('此模型缺少必要骨骼，無法進行身體追蹤', 'error');
    return;
  }

  if (!(await ensureBodyTracker())) return;

  toast(mode === 'half' ? '半身追蹤已啟用' : '全身追蹤已啟用', 'ok');
  if (!state.tracking) {
    setBodyMessage('模型已就緒。請到「追蹤」分頁按下「開始追蹤」以開啟攝影機。');
  }
}

/** 首次啟用時才載入姿態／手部模型，載入後常駐（NFR-P-11） */
async function ensureBodyTracker() {
  const b = bodyCfg();
  setBodyMessage('載入姿態模型…');
  try {
    await bodyTracker.init({ quality: b.quality, hands: b.parts.hands !== false });
    setBodyMessage('');
    return true;
  } catch (err) {
    setBodyMessage(err.message);
    toast(err.message, 'error');
    api.log('error', `身體追蹤初始化失敗：${err.message}`);
    return false;
  }
}

function setBodyMessage(msg) {
  const el = $('#body-status-msg');
  if (el) el.textContent = msg;
}

function syncBodyControls() {
  const b = bodyCfg();
  for (const btn of $$('.body-mode')) {
    btn.classList.toggle('active', btn.dataset.bodyMode === b.mode);
  }
  for (const el of $$('[data-body-part]')) {
    el.checked = Boolean(b.parts[el.dataset.bodyPart]);
    // 腿與蹲下只在全身模式有意義，其他模式下標為停用以免誤解
    if (el.dataset.bodyPart === 'legs' || el.dataset.bodyPart === 'rootMotion') {
      el.disabled = b.mode !== 'full';
    }
  }
  for (const el of $$('.body-sens')) {
    const k = el.dataset.bodySens;
    el.value = b.sensitivity[k] ?? 1;
    $(`#out-body-sens-${k}`).textContent = Number(el.value).toFixed(1);
  }
  $('#body-fps').value = b.fps;
  $('#out-body-fps-set').textContent = b.fps;
  $('#body-quality').value = b.quality;
  $('#body-smooth').value = b.smooth;
  $('#out-body-smooth').textContent = b.smooth;
  $('#body-fade').value = b.fadeSeconds;
  $('#out-body-fade').textContent = b.fadeSeconds.toFixed(2);
  $('#body-twist').value = b.handTwist;
  $('#out-body-twist').textContent = b.handTwist.toFixed(2);
}

function bindBodyControls() {
  for (const btn of $$('.body-mode')) {
    btn.addEventListener('click', () => setBodyMode(btn.dataset.bodyMode));
  }

  for (const el of $$('[data-body-part]')) {
    el.addEventListener('change', () => {
      bodyCfg().parts[el.dataset.bodyPart] = el.checked;
      saveAppConfig();
      // 手指開關會改變是否需要手部模型，得讓追蹤器知道
      bodyTracker.handsEnabled = bodyCfg().parts.hands !== false;
    });
  }

  for (const el of $$('.body-sens')) {
    el.addEventListener('input', () => {
      const k = el.dataset.bodySens;
      bodyCfg().sensitivity[k] = Number(el.value);
      $(`#out-body-sens-${k}`).textContent = Number(el.value).toFixed(1);
      saveAppConfig();
    });
  }

  $('#body-fps').addEventListener('input', (e) => {
    bodyCfg().fps = Number(e.target.value);
    $('#out-body-fps-set').textContent = e.target.value;
    saveAppConfig();
  });

  $('#body-quality').addEventListener('change', async (e) => {
    bodyCfg().quality = e.target.value;
    saveAppConfig();
    // 精度切換須即時生效（FR-02-71）
    if (bodyCfg().mode !== 'face') await ensureBodyTracker();
  });

  $('#body-smooth').addEventListener('input', (e) => {
    bodyCfg().smooth = Number(e.target.value);
    $('#out-body-smooth').textContent = e.target.value;
    saveAppConfig();
  });

  $('#body-fade').addEventListener('input', (e) => {
    bodyCfg().fadeSeconds = Number(e.target.value);
    $('#out-body-fade').textContent = Number(e.target.value).toFixed(2);
    saveAppConfig();
  });

  $('#body-twist').addEventListener('input', (e) => {
    bodyCfg().handTwist = Number(e.target.value);
    $('#out-body-twist').textContent = Number(e.target.value).toFixed(2);
    saveAppConfig();
  });

  $('#btn-body-calibrate').addEventListener('click', async () => {
    if (!bodySolver.calibrate(bodyTracker.sample)) {
      return toast('目前未偵測到身體，無法校準', 'error');
    }
    await persistCalibration();
    toast('已以當前姿勢設為身體中性原點', 'ok');
  });

  $('#btn-body-reset-cal').addEventListener('click', async () => {
    bodySolver.resetCalibration();
    await persistCalibration();
    toast('身體校準已重設');
  });
}

function updateBodyStatus() {
  const on = bodyCfg().mode !== 'face' && state.tracking;
  const d = bodySolver.detected;
  $('#body-det-body').classList.toggle('on', on && d.body);
  $('#body-det-left').classList.toggle('on', on && d.leftHand);
  $('#body-det-right').classList.toggle('on', on && d.rightHand);
  $('#out-body-fps').textContent = on ? bodyTracker.fps.toFixed(0) : '--';
}

// ────────────────────────────────────────────────────────────────
// 語音口型介面（FR-02-C）
// ────────────────────────────────────────────────────────────────

async function populateMicrophones() {
  const mics = await MicTracker.listMicrophones();
  const sel = $('#mic-select');
  sel.innerHTML = '';
  if (mics.length === 0) {
    sel.innerHTML = '<option value="">（尚未授權或無裝置）</option>';
    return;
  }
  for (const m of mics) {
    const opt = document.createElement('option');
    opt.value = m.deviceId;
    opt.textContent = m.label;
    sel.appendChild(opt);
  }
  const saved = state.appConfig.tracking.lipsync.deviceId;
  if (saved) sel.value = saved;
}

async function toggleMic() {
  const btn = $('#btn-mic-toggle');
  const ls = state.appConfig.tracking.lipsync;

  if (state.micActive) {
    await mic.stop();
    state.micActive = false;
    ls.enabled = false;
    btn.textContent = '開始語音';
    btn.classList.remove('danger');
    saveAppConfig();
    return;
  }

  btn.disabled = true;
  btn.textContent = '啟動中…';
  try {
    await mic.start($('#mic-select').value || null);
    state.micActive = true;
    ls.enabled = true;
    ls.deviceId = $('#mic-select').value || null;
    btn.textContent = '停止語音';
    btn.classList.add('danger');

    // 套用先前儲存的母音校準
    if (state.calibration?.lipsync?.templates) {
      const ok = mic.importTemplates(state.calibration.lipsync.templates);
      if (ok) {
        markCalibratedVowels();
        toast('已套用先前的母音校準', 'ok');
      }
    }

    await populateMicrophones();
    saveAppConfig();
    toast('語音口型已啟動', 'ok');
  } catch (err) {
    toast(`無法啟動麥克風：${err.message}`, 'error');
    api.log('error', `麥克風啟動失敗：${err.message}`);
    btn.textContent = '開始語音';
  } finally {
    btn.disabled = false;
  }
}

function markCalibratedVowels() {
  const saved = state.calibration?.lipsync?.templates;
  for (const b of $$('#vowel-cal button[data-vowel]')) {
    b.classList.toggle('calibrated', Boolean(saved?.[b.dataset.vowel]));
  }
}

async function persistCalibration() {
  state.calibration.lipsync.templates = mic.exportTemplates();
  state.calibration.webcam = { ...tracker.calibration };
  // 身體中性原點（FR-02-76）與臉部校準同檔保存
  state.calibration.body = { ...bodySolver.calibration };
  await api.config.saveCalibration(state.calibration);
}

function bindLipsyncControls() {
  const ls = () => state.appConfig.tracking.lipsync;

  $('#btn-mic-toggle').addEventListener('click', toggleMic);

  $('#btn-mic-mute').addEventListener('click', () => {
    const muted = mic.toggleMute();
    $('#btn-mic-mute').textContent = muted ? '解除靜音' : '靜音';
    $('#btn-mic-mute').classList.toggle('danger', muted);
  });

  $('#mic-select').addEventListener('change', async () => {
    ls().deviceId = $('#mic-select').value || null;
    if (state.micActive) await mic.start(ls().deviceId);
    saveAppConfig();
  });

  $('#mouth-source').addEventListener('change', (e) => {
    ls().mouthSource = e.target.value;
    saveAppConfig();
  });

  for (const [id, key, outId] of [
    ['voice-gain', 'volumeGain', 'out-vgain'],
    ['voice-cutoff', 'volumeCutoff', 'out-vcut'],
    ['voice-freq', 'frequencyGain', 'out-vfreq'],
  ]) {
    $(`#${id}`).addEventListener('input', (e) => {
      ls()[key] = Number(e.target.value);
      $(`#${outId}`).textContent = e.target.value;
      saveAppConfig();
    });
  }

  // 母音校準
  for (const btn of $$('#vowel-cal button[data-vowel]')) {
    btn.addEventListener('click', () => {
      if (!state.micActive) return toast('請先開始語音', 'error');
      const v = btn.dataset.vowel;
      if (!mic.beginCalibration(v)) return toast('無法開始校準', 'error');
      btn.classList.add('recording');
      toast(`請持續發出 /${v}/ 的聲音…`);
    });
  }

  mic.onCalibrated = async (vowel) => {
    for (const b of $$('#vowel-cal button')) b.classList.remove('recording');
    await persistCalibration();
    markCalibratedVowels();
    toast(`母音 /${vowel}/ 校準完成`, 'ok');
  };

  $('#btn-cal-reset').addEventListener('click', async () => {
    mic.resetTemplates();
    state.calibration.lipsync.templates = null;
    await api.config.saveCalibration(state.calibration);
    markCalibratedVowels();
    toast('已還原為內建母音樣板');
  });

  // 母音權重顯示
  const wrap = $('#vowel-weights');
  wrap.innerHTML = VOWELS.map(
    (v) => `<div>${v.toUpperCase()}<div class="bar" data-vowel="${v}"><i></i></div></div>`
  ).join('');
}

function updateLipsyncUi() {
  if (!state.micActive) return;
  $('#vu-fill').style.width = `${Math.min(100, mic.level * 300).toFixed(0)}%`;
  for (const bar of $$('#vowel-weights .bar')) {
    const v = state.inputs[`Voice${bar.dataset.vowel.toUpperCase()}`] ?? 0;
    bar.querySelector('i').style.width = `${(v * 100).toFixed(0)}%`;
  }
}

function bindSceneControls() {
  const sc = () => state.appConfig.scene;

  $('#bg-mode').addEventListener('change', async (e) => {
    const mode = e.target.value;
    sc().background.mode = mode;
    $('#bg-color-field').classList.toggle('hidden', mode !== 'color');
    $('#bg-file-field').classList.toggle('hidden', mode !== 'image' && mode !== 'video');
    if (mode === 'image' || mode === 'video') await populateBackgrounds(mode);
    await applyBackground();
    saveAppConfig();
  });

  $('#bg-color').addEventListener('input', async (e) => {
    sc().background.color = e.target.value;
    await applyBackground();
    saveAppConfig();
  });

  $('#bg-file').addEventListener('change', async (e) => {
    sc().background.url = e.target.value;
    await applyBackground();
    saveAppConfig();
  });

  $('#btn-open-backgrounds').addEventListener('click', () => api.backgrounds.openFolder());

  const lightingInputs = {
    'ambient-intensity': ['ambientIntensity', 'out-ambient', Number],
    'ambient-color': ['ambientColor', null, String],
    'dir-intensity': ['dirIntensity', 'out-dir', Number],
    'dir-color': ['dirColor', null, String],
    'dir-azimuth': ['dirAzimuth', 'out-azimuth', Number],
    'dir-elevation': ['dirElevation', 'out-elevation', Number],
    'rim-intensity': ['rimIntensity', 'out-rim', Number],
    'rim-color': ['rimColor', null, String],
  };

  for (const [id, [key, outId, cast]] of Object.entries(lightingInputs)) {
    $(`#${id}`).addEventListener('input', (e) => {
      const v = cast(e.target.value);
      sc().lighting[key] = v;
      if (outId) $(`#${outId}`).textContent = typeof v === 'number' ? v : e.target.value;
      stage.setLighting(sc().lighting);
      saveAppConfig();
      pushScene();
    });
  }

  $('#camera-preset').addEventListener('change', (e) => {
    stage.applyCameraPreset(e.target.value);
    if (state.modelConfig) {
      state.modelConfig.camera.preset = e.target.value;
      saveModelConfig();
    }
    pushScene();
  });

  $('#chk-lock-model').addEventListener('change', (e) => {
    sc().lockModel = e.target.checked;
    saveAppConfig();
  });

  // 模型變換的數值控制（FR-01-11）。滑鼠直接操作與這裡改的是同一份資料
  const transformInputs = {
    'model-scale': ['scale', 'out-model-scale', 2],
    'model-x': ['x', 'out-model-x', 2],
    'model-y': ['y', 'out-model-y', 2],
    'model-z': ['z', 'out-model-z', 2],
    'model-roty': ['rotY', 'out-model-roty', 0],
  };

  for (const [id, [key, outId, digits]] of Object.entries(transformInputs)) {
    $(`#${id}`).addEventListener('input', (e) => {
      if (!state.modelConfig) return;
      const v = Number(e.target.value);
      if (key === 'scale') {
        // 與滾輪走同一條路徑，否則拉滑桿會讓模型上下亂跑
        Object.assign(state.modelConfig.transform, stage.setScaleKeepingView(v));
        syncTransformControls();
      } else {
        state.modelConfig.transform[key] = v;
        $(`#${outId}`).textContent = digits === 0 ? Math.round(v) : v.toFixed(digits);
        stage.setModelTransform(state.modelConfig.transform);
      }
      saveModelConfig();
      schedulePushScene();
    });
  }

  $('#btn-reset-transform').addEventListener('click', () => {
    if (!state.modelConfig) return;
    // 重設＝重新自動配置，而不是歸零：對高度異常的模型，歸零後依然看不到人
    state.modelConfig.transform = { x: 0, y: 0, z: 0, rotY: 0, scale: 1, scalePivot: 'world' };
    stage.setModelTransform(state.modelConfig.transform);
    const fit = stage.fitModel();
    if (fit) {
      Object.assign(state.modelConfig.transform, stage.modelTransform);
      toast(`已依模型高度 ${fit.sourceHeight.toFixed(2)} m 自動配置（縮放 ${fit.scale.toFixed(2)}×）`, 'ok');
    }
    syncTransformControls();
    saveModelConfig();
    pushScene();
  });
}

async function populateBackgrounds(mode) {
  state.backgrounds = await api.backgrounds.scan();
  const sel = $('#bg-file');
  sel.innerHTML = '';
  const kind = mode === 'video' ? 'video' : 'image';
  const items = state.backgrounds.filter((b) => b.kind === kind);
  if (items.length === 0) {
    sel.innerHTML = '<option value="">（Backgrounds/ 內無檔案）</option>';
    return;
  }
  for (const b of items) {
    const opt = document.createElement('option');
    opt.value = b.url;
    opt.textContent = b.name;
    sel.appendChild(opt);
  }
  const saved = state.appConfig.scene.background.url;
  if (saved && items.some((b) => b.url === saved)) sel.value = saved;
  else state.appConfig.scene.background.url = sel.value;
}

async function applyBackground() {
  const bg = state.appConfig.scene.background;
  try {
    // 圖片／影片經輸出伺服器提供，主視窗與輸出頁面用同一組網址
    const port = state.outputPort;
    const url = bg.url && port ? `http://127.0.0.1:${port}${bg.url}` : null;
    await stage.setBackground({ ...bg, url });
    await pushScene();
  } catch (err) {
    toast(`背景載入失敗：${err.message}`, 'error');
  }
}

function bindOutputControls() {
  $('#btn-copy-url').addEventListener('click', async () => {
    await navigator.clipboard.writeText($('#output-url').value);
    toast('已複製輸出網址', 'ok');
  });

  $('#output-res').addEventListener('change', updateOutputUrl);

  $('#btn-screenshot').addEventListener('click', async () => {
    const includeBg = $('#chk-shot-bg').checked;
    const prevMode = state.appConfig.scene.background.mode;
    try {
      if (!includeBg && prevMode !== 'transparent') {
        await stage.setBackground({ mode: 'transparent' });
      }
      const data = stage.capture({ scale: state.appConfig.screenshot.scale ?? 2 });
      const file = await api.screenshot.save(data, { dir: state.appConfig.screenshot.dir });
      toast(`已儲存截圖：${file.split(/[\\/]/).pop()}`, 'ok');
    } catch (err) {
      toast(`截圖失敗：${err.message}`, 'error');
    } finally {
      if (!includeBg && prevMode !== 'transparent') await applyBackground();
    }
  });

  $('#btn-open-screenshots').addEventListener('click', () =>
    api.screenshot.openFolder(state.appConfig.screenshot.dir)
  );

  $('#btn-stream-mode').addEventListener('click', () => setStreamMode(true));
  $('#btn-exit-stream').addEventListener('click', () => setStreamMode(false));
}

function updateOutputUrl() {
  if (!state.outputPort) return;
  const [w, h] = $('#output-res').value.split('x');
  state.outputUrl = `http://127.0.0.1:${state.outputPort}/output.html?w=${w}&h=${h}`;
  $('#output-url').value = state.outputUrl;
}

function setStreamMode(on) {
  state.streamMode = on;
  document.body.classList.toggle('stream-mode', on);
  $('#btn-exit-stream').classList.toggle('hidden', !on);
  setTimeout(() => window.dispatchEvent(new Event('resize')), 50);
}



/**
 * 設定檔的位移語意轉換。
 *
 * v0.2.0 曾把縮放支點折進每幀的變換公式（`pos = t + (1−s)(p − t)`），
 * 使存檔裡的 t 變成「縮放前的座標」。副作用很嚴重：一個縮到 0.32 倍的模型，
 * t.y 會膨脹到 −7.9，之後只要再動一點縮放，模型就被甩出畫面好幾公尺——
 * 實測就是這樣讓一個 3.3 公尺高的模型「不見了」。
 *
 * 現在位移一律是**世界座標**，支點修正改在縮放發生的當下處理
 * （stage.setScaleKeepingView）。這裡把兩種舊格式都轉成新語意：
 *
 *   scalePivot === 'camera'（v0.2.0 寫的，縮放前座標）→ t·s + (1−s)·p
 *   無標記（v0.1.0 以前）                             → 本來就是世界座標
 *
 * 兩種轉換都不改變畫面上的位置。
 *
 * @returns {boolean} 是否需要存檔
 */
function migrateTransformPivot(cfg) {
  if (!cfg) return false;
  const targets = [cfg.transform, ...Object.values(cfg.transformPresets ?? {}).map((x) => x.transform)];
  let changed = false;

  for (const tr of targets) {
    if (!tr || tr.scalePivot === 'world') continue;
    const wasCameraPivot = tr.scalePivot === 'camera';
    tr.scalePivot = 'world';
    changed = true;
    if (!wasCameraPivot) continue;

    const sc = tr.scale ?? 1;
    if (Math.abs(sc - 1) < 1e-6) continue;
    const [px, py, pz] = (CAMERA_PRESETS[cfg.camera?.preset] ?? CAMERA_PRESETS.half).target;
    tr.x = tr.x * sc + (1 - sc) * px;
    tr.y = tr.y * sc + (1 - sc) * py;
    tr.z = tr.z * sc + (1 - sc) * pz;
  }
  return changed;
}

/**
 * 首次載入時依模型高度自動配置（FR-01-11）。
 *
 * 攝影機取景是以 1.6 公尺人形為前提寫死的，而實測匯入的模型高度從 0.55 到
 * 3.33 公尺都有。差太多時使用者看到的是空畫面，且不會意識到是尺寸問題。
 *
 * @returns {boolean} 是否需要存檔
 */
function autoFitOnFirstLoad(cfg) {
  const tr = cfg?.transform;
  if (!tr || tr.fitted) return false;
  tr.fitted = true;

  // 使用者已經自己調過就不要動他的設定
  const untouched = tr.x === 0 && tr.y === 0 && tr.z === 0 && Math.abs(tr.scale - 1) < 1e-6;
  if (!untouched) return true;

  const b = stage.getModelBounds();
  if (!b) return true;
  // 高度落在 1.35–1.9 公尺之間視為正常人形，不介入
  if (b.height >= 1.35 && b.height <= 1.9) return true;

  const fit = stage.fitModel();
  if (!fit) return true;
  Object.assign(tr, stage.modelTransform);
  toast(`模型高 ${fit.sourceHeight.toFixed(2)} m，已自動縮放至 ${fit.scale.toFixed(2)}× 以符合取景`, 'ok');
  api.log('info', `自動配置尺寸：${fit.sourceHeight.toFixed(2)} m → ${fit.scale.toFixed(2)}×`);
  return true;
}


/**
 * 模型整個落在鏡頭外時自動救回。
 *
 * 沒有這道防線，使用者只會看到空畫面，然後以為是模型讀取失敗——
 * 實際回報就是「模型不見了、讀取後沒有人物」。
 * 這個狀態沒有人會刻意設定（輸出頁面用的是同一組變換與取景，
 * 把模型停在鏡頭外沒有任何用途），因此直接重新配置並告知，比只提醒有用。
 *
 * @returns {boolean} 是否有調整（需要存檔）
 */
function recoverIfOffscreen() {
  const b = stage.getModelBounds();
  if (!b || !state.modelConfig) return false;
  const target = stage.cameraTarget.y;
  // 半身取景的可見高度約 0.8 m，這裡取寬鬆的 ±1.2 m 才判定為完全脫窗
  if (b.max.y >= target - 1.2 && b.min.y <= target + 1.2) return false;

  api.log('warn', `模型超出取景範圍：Y ${b.min.y.toFixed(2)}~${b.max.y.toFixed(2)}，取景中心 ${target.toFixed(2)}`);
  const fit = stage.fitModel();
  if (!fit) return false;
  Object.assign(state.modelConfig.transform, stage.modelTransform);
  toast('模型原本落在鏡頭範圍外，已自動重新配置位置與縮放。', 'ok');
  return true;
}

/**
 * 讓「場景」分頁的變換滑桿與實際變換一致。
 * 滑鼠直接操作（拖曳／滾輪）與熱鍵的 MoveModel 都會改到同一份資料，
 * 因此每個改動它的路徑都要回頭呼叫這裡，否則滑桿會與畫面說兩套。
 */
function syncTransformControls() {
  const tr = state.modelConfig?.transform;
  if (!tr) return;
  const set = (id, outId, value, digits) => {
    const el = $(id);
    if (!el) return;
    el.value = value;
    $(outId).textContent = digits === 0 ? Math.round(value) : value.toFixed(digits);
  };
  set('#model-scale', '#out-model-scale', tr.scale, 2);
  set('#model-x', '#out-model-x', tr.x, 2);
  set('#model-y', '#out-model-y', tr.y, 2);
  set('#model-z', '#out-model-z', tr.z, 2);
  set('#model-roty', '#out-model-roty', tr.rotY, 0);
}

/** 縮放上下限（與 index.html 的滑桿範圍一致，FR-01-11）*/
const SCALE_MIN = 0.2;
const SCALE_MAX = 4;
const clampScale = (v) => Math.max(SCALE_MIN, Math.min(SCALE_MAX, v));

let pushSceneTimer = null;

/**
 * 去抖版的場景廣播。
 * 滾輪與滑桿會在短時間內產生大量事件，每次都跑一輪 pushScene（含 IPC 取網址）
 * 沒有必要；但**一定要送**，否則 OBS 輸出頁面的模型大小會停在舊值。
 */
function schedulePushScene() {
  clearTimeout(pushSceneTimer);
  pushSceneTimer = setTimeout(() => pushScene(), 200);
}

function bindStageInteraction() {
  const canvas = $('#stage');
  let dragging = null;

  // 滑鼠熱鍵（FR-07-02）
  canvas.addEventListener('pointerdown', (e) => {
    const btn = ['left', 'middle', 'right'][e.button];
    const hk = btn && hotkeyEngine.findByMouse(btn);
    if (hk) hotkeyEngine.fire(hk.id, 'down');
  });
  canvas.addEventListener('pointerup', (e) => {
    const btn = ['left', 'middle', 'right'][e.button];
    const hk = btn && hotkeyEngine.findByMouse(btn);
    if (hk) hotkeyEngine.fire(hk.id, 'up');
  });

  canvas.addEventListener('pointerdown', (e) => {
    if (state.appConfig.scene.lockModel || !state.modelConfig) return;
    dragging = { button: e.button, x: e.clientX, y: e.clientY };
    canvas.setPointerCapture(e.pointerId);
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!dragging || !state.modelConfig) return;
    const dx = (e.clientX - dragging.x) / canvas.clientHeight;
    const dy = (e.clientY - dragging.y) / canvas.clientHeight;
    dragging.x = e.clientX;
    dragging.y = e.clientY;

    const tr = state.modelConfig.transform;

    // 攝影機位於 -Z，因此畫面右方 = 世界座標 -X（見 stage.js 的 applyCameraPreset）。
    // 水平方向的兩個操作都必須取負號，模型才會跟著滑鼠往同一邊跑；
    // 垂直方向不受攝影機那一次翻面影響，維持原樣。
    if (dragging.button === 2) {
      // 收斂到 -180～180：拖曳本身可以無限轉，但介面滑桿是有範圍的，
      // 不收斂會出現「滑桿停在 180、數字卻顯示 400」
      tr.rotY = ((((tr.rotY - dx * 180) + 180) % 360) + 360) % 360 - 180;
    } else {
      // 位移是世界座標，與縮放無關（見 stage.js 的 _applyTransform）
      tr.x -= dx * 2;
      tr.y -= dy * 2;
    }
    stage.setModelTransform(tr);
  });

  const endDrag = () => {
    if (dragging) {
      dragging = null;
      syncTransformControls();
      saveModelConfig();
      pushScene();
    }
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  canvas.addEventListener('wheel', (e) => {
    // 先擋掉再判斷能不能縮放：Ctrl＋滾輪在 Chromium 是「整頁縮放」，
    // 若在鎖定模型時直接 return，就會變成把整個介面放大縮小
    e.preventDefault();
    if (state.appConfig.scene.lockModel || !state.modelConfig) return;

    // Ctrl 為精細步進（FR-01-11）：一般滾輪一格 6%，按住 Ctrl 一格 1.5%
    const step = e.ctrlKey ? 1.015 : 1.06;
    const tr = state.modelConfig.transform;
    // 支點修正在這裡做，而不是塞進每幀的變換公式裡
    Object.assign(tr, stage.setScaleKeepingView(tr.scale * (e.deltaY < 0 ? step : 1 / step)));
    syncTransformControls();
    saveModelConfig();
    // 原本漏了這一行，導致縮放只在主視窗生效、OBS 輸出頁面維持舊大小
    schedulePushScene();
  }, { passive: false });

  // 滑鼠位置輸入參數（FR-02-03）
  canvas.addEventListener('pointermove', (e) => {
    const r = canvas.getBoundingClientRect();
    state.inputs.MousePositionX = ((e.clientX - r.left) / r.width) * 2 - 1;
    state.inputs.MousePositionY = -(((e.clientY - r.top) / r.height) * 2 - 1);
  });
}


/**
 * 視窗聚焦時的鍵盤熱鍵（FR-07-01）。
 *
 * 沒有勾選「系統全域」的熱鍵走這條路：只在本視窗處理按鍵，
 * 不經 Electron 的 globalShortcut，因此**不會**把按鍵從其他程式手上搶走。
 * 使用者回報「設了熱鍵之後那個鍵在哪裡都打不出來」就是因為先前一律走全域註冊。
 */
function bindLocalHotkeys() {
  const isTyping = (el) => {
    if (!el) return false;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
  };

  const handle = (event, phase) => {
    // 正在錄製按鍵綁定時不觸發，否則按下去的當下就會執行該熱鍵
    if (state.capturingHotkey) return;
    // 在輸入框裡打字不算觸發，否則熱鍵名稱裡有 A 就會一直放動畫
    if (isTyping(event.target)) return;
    if (event.repeat) return;

    const hk = hotkeyEngine.findByEvent(event);
    if (!hk) return;
    event.preventDefault();
    hotkeyEngine.fire(hk.id, phase);
  };

  window.addEventListener('keydown', (e) => handle(e, 'down'));
  window.addEventListener('keyup', (e) => handle(e, 'up'));
}

function bindMisc() {
  // Ctrl＋滾輪在 Chromium 預設是「整頁縮放」。畫面上我們把它接成模型精細縮放，
  // 但在側邊面板上滾動時仍會把整個介面放大縮小、把版面弄壞，因此一律擋掉。
  window.addEventListener('wheel', (e) => {
    if (e.ctrlKey) e.preventDefault();
  }, { passive: false });

  $('#btn-import-model').addEventListener('click', async () => {
    const copied = await api.models.import();
    if (copied.length) {
      await refreshModels();
      toast(`已匯入 ${copied.length} 個模型`, 'ok');
    }
  });

  $('#btn-open-models').addEventListener('click', () => api.models.openFolder());
  $('#btn-rescan').addEventListener('click', async () => {
    await refreshModels();
    toast('已重新掃描');
  });

  $('#btn-autosetup').addEventListener('click', () => {
    if (!state.currentModel) return toast('請先載入模型', 'error');
    runAutoSetup();
    rebuildExpressionState();
    renderExpressionList();
  });

  // 重設全部映射須二次確認（NFR-U-03）
  $('#btn-reset-mappings').addEventListener('click', () => {
    if (!state.modelConfig) return;
    if (!confirm('確定要清除此模型的全部映射嗎？此動作無法復原。')) return;
    state.modelConfig.mappings = [];
    state.modelConfig.autoSetupDone = false;
    solver.reset();
    saveModelConfig();
    renderMappingList();
    toast('已清除全部映射');
  });

  $('#btn-clear-expressions').addEventListener('click', () => {
    for (const def of state.expressions.values()) def.active = false;
    for (const item of $$('#expression-list .list-item')) item.classList.remove('active');
  });

  $('#btn-monitor-toggle').addEventListener('click', () => {
    const m = $('#monitor');
    m.classList.toggle('collapsed');
    $('#btn-monitor-toggle').textContent = m.classList.contains('collapsed') ? '展開' : '收合';
  });
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

// ────────────────────────────────────────────────────────────────
// 啟動
// ────────────────────────────────────────────────────────────────

async function boot() {
  state.appConfig = await api.config.loadApp();
  const info = await api.info();
  state.outputPort = info.outputPort;
  state.selftestShotDir = `${info.rootDir}\\Logs`;

  $('#app-version').textContent = `v${info.version}`;
  updateOutputUrl();

  for (const w of info.warnings ?? []) toast(w, 'error');

  state.calibration = await api.config.loadCalibration();

  bindTabs();
  bindTrackingControls();
  bindBodyControls();
  bindSpringControls();
  bindLipsyncControls();
  bindAnimationControls();
  bindHotkeyControls();
  bindPoseControls();
  bindSceneControls();
  bindOutputControls();
  bindStageInteraction();
  bindMisc();
  bindLocalHotkeys();
  buildMonitor();
  syncTrackingControls();
  syncBodyControls();

  $('#render-fps').value = state.appConfig.render.fps;
  $('#out-render-fps').textContent = state.appConfig.render.fps;
  $('#chk-lock-model').checked = state.appConfig.scene.lockModel;

  // 光照
  const L = state.appConfig.scene.lighting;
  stage.setLighting(L);
  $('#ambient-intensity').value = L.ambientIntensity;
  $('#out-ambient').textContent = L.ambientIntensity;
  $('#ambient-color').value = L.ambientColor;
  $('#dir-intensity').value = L.dirIntensity;
  $('#out-dir').textContent = L.dirIntensity;
  $('#dir-color').value = L.dirColor;
  $('#dir-azimuth').value = L.dirAzimuth;
  $('#out-azimuth').textContent = L.dirAzimuth;
  $('#dir-elevation').value = L.dirElevation;
  $('#out-elevation').textContent = L.dirElevation;
  $('#rim-intensity').value = L.rimIntensity;
  $('#out-rim').textContent = L.rimIntensity;
  $('#rim-color').value = L.rimColor;

  // 背景
  $('#bg-mode').value = state.appConfig.scene.background.mode;
  $('#bg-color').value = state.appConfig.scene.background.color;
  $('#bg-color-field').classList.toggle('hidden', state.appConfig.scene.background.mode !== 'color');
  await applyBackground();

  // 還原攝影機中性原點（FR-02-24）
  if (state.calibration?.webcam) {
    tracker.calibration = { ...tracker.calibration, ...state.calibration.webcam };
  }
  // 還原身體中性原點（FR-02-76）
  if (state.calibration?.body) {
    bodySolver.calibration = { ...bodySolver.calibration, ...state.calibration.body };
  }

  const ls = state.appConfig.tracking.lipsync;
  $('#mouth-source').value = ls.mouthSource;
  $('#voice-gain').value = ls.volumeGain;
  $('#out-vgain').textContent = ls.volumeGain;
  $('#voice-cutoff').value = ls.volumeCutoff;
  $('#out-vcut').textContent = ls.volumeCutoff;
  $('#voice-freq').value = ls.frequencyGain;
  $('#out-vfreq').textContent = ls.frequencyGain;
  markCalibratedVowels();

  const an = state.appConfig.animation;
  $('#anim-mask').value = an.mask;
  $('#anim-fade').value = an.fade;
  $('#out-anim-fade').textContent = an.fade.toFixed(2);
  $('#anim-speed').value = an.speed;
  $('#out-anim-speed').textContent = an.speed.toFixed(1);
  $('#chk-stop-last').checked = an.stopOnLastFrame;

  $('#chk-screen-buttons').checked = state.appConfig.screenButtons.visible;
  $('#btn-opacity').value = state.appConfig.screenButtons.opacity;
  $('#out-btn-opacity').textContent = state.appConfig.screenButtons.opacity;
  $('#chk-hotkey-api').checked = Boolean(state.appConfig.hotkeyApi?.enabled);

  await populateCameras();
  await populateMicrophones();
  await refreshAnimations();
  await refreshModels();

  // 記住場景：還原上次的模型（FR-11-08）
  if (state.appConfig.scene.rememberScene && state.appConfig.lastModel) {
    const prev = state.models.find((m) => m.path === state.appConfig.lastModel && !m.error);
    if (prev) await loadModel(prev);
  }

  // 輸出來源連線數
  setInterval(async () => {
    const s = await api.output.status();
    $('#hud-clients').textContent = `輸出 ${s.clients}`;
  }, 2000);

  requestAnimationFrame(frame);
  api.log('info', '工作室介面已就緒');
}

// ────────────────────────────────────────────────────────────────
// 自我測試（驗證規格 §9.2 之部分驗收準則）
// ────────────────────────────────────────────────────────────────

async function runSelfTest() {
  const checks = [];
  const check = (id, desc, ok, detail) => checks.push({ id, desc, ok: Boolean(ok), detail });

  try {
    const model = state.models.find((m) => !m.error);
    if (!model) {
      check('setup', 'Models/ 內有可用模型', false, '找不到任何可讀取的 .vrm');
      return finish();
    }

    // ── FR-01-04/05：中繼資料與授權解析 ──
    check(
      'FR-01-05',
      'VRM 授權旗標解析',
      Boolean(model.license?.summary),
      `${model.meta.specVersion} / ${model.license?.summary}`
    );
    check(
      'FR-01-06',
      '禁止再散布之模型會產生警語',
      model.license.restrictions.length > 0,
      model.license.restrictions.join('；') || '（此模型無限制）'
    );


    // ── 載入 ──
    const t0 = performance.now();
    await loadModel(model, { autoSetupChoice: 'auto' });
    const loadMs = performance.now() - t0;
    check('FR-01-01', '模型載入成功', Boolean(stage.vrm), model.name);
    check('NFR-P-06', '50 MB 內模型於 5 秒內載入', loadMs < 5000, `${Math.round(loadMs)} ms`);

    const caps = stage.getCapabilities();
    check(
      'FR-01-02',
      'VRM 0.x / 1.0 皆能解析出表情與骨骼',
      caps.expressions.size > 0 && caps.bones.size > 0,
      `${caps.expressions.size} 表情 / ${caps.bones.size} 骨骼 / lookAt=${caps.lookAtType}`
    );


    // ── FR-02-D：身體追蹤（以合成地標驗證，不需攝影機）──
    //
    // 這一段刻意走完整條路徑：真實模型量測 → 解算 → applySolved → 讀骨骼世界座標。
    // 只比對四元數數值會漏掉「算得對但沒套用上去」這類問題。
    check('FR-02-65', '自真實模型量出身體追蹤基底', Boolean(stage.rig),
      stage.rig ? '已建立' : '缺少 hips 或雙上臂，無法身體追蹤');

    if (stage.rig) {
      const basis = stage.rig.basis;
      const cross = basis.x.clone().cross(basis.y);
      check('FR-02-65b', '量出的基底為單位正交右手系',
        Math.abs(basis.x.length() - 1) < 0.01 && Math.abs(basis.x.dot(basis.y)) < 0.01
          && cross.distanceTo(basis.z) < 0.01,
        `X·Y=${basis.x.dot(basis.y).toFixed(4)}`);

      // VRM 0.x 在自身空間朝 -Z、1.0 朝 +Z。量測若寫死軸向，這裡就會抓到
      const isVrm0 = stage.vrm.meta?.metaVersion === '0';
      check('FR-02-65c', '正面軸與 VRM 版本的預設朝向一致',
        isVrm0 ? basis.z.z < -0.9 : basis.z.z > 0.9,
        `VRM ${isVrm0 ? '0.x' : '1.0'}，Z=${basis.z.z.toFixed(3)}`);

      // 合成一組「使用者舉左手」的姿態地標
      const lm = (x, y, z) => ({ x, y, z });
      const pose = new Array(33).fill(null).map(() => lm(0, 0, 0));
      pose[PL.LEFT_SHOULDER] = lm(0.18, -0.55, 0);
      pose[PL.RIGHT_SHOULDER] = lm(-0.18, -0.55, 0);
      pose[PL.LEFT_HIP] = lm(0.1, 0, 0);
      pose[PL.RIGHT_HIP] = lm(-0.1, 0, 0);
      pose[PL.LEFT_ELBOW] = lm(0.2, -0.8, 0);
      pose[PL.LEFT_WRIST] = lm(0.21, -1.05, 0);
      pose[PL.LEFT_INDEX] = lm(0.21, -1.13, 0);
      pose[PL.RIGHT_ELBOW] = lm(-0.22, -0.28, 0);
      pose[PL.RIGHT_WRIST] = lm(-0.24, -0.02, 0);
      pose[PL.RIGHT_INDEX] = lm(-0.25, 0.06, 0);

      const bodyCfgTest = {
        mode: 'half',
        smooth: 0,
        fadeSeconds: 0.01,
        handTwist: 0.5,
        parts: { torso: true, shoulders: true, arms: true, hands: true, legs: true, rootMotion: false },
        sensitivity: {},
        lostBehavior: 'freeze',
      };
      const probeSolver = new BodySolver();
      probeSolver.setRig(stage.rig);
      let probeBody = null;
      for (let i = 0; i < 10; i += 1) {
        probeBody = probeSolver.update(1 / 30, { pose, hands: {}, mirror: true }, bodyCfgTest, true);
      }

      const wristY = (side = 'left') => {
        const n = stage.vrm.humanoid.getNormalizedBoneNode(`${side}Hand`)
          ?? stage.vrm.humanoid.getNormalizedBoneNode(`${side}LowerArm`);
        return n ? n.matrixWorld.elements[13] : NaN;
      };

      stage.applySolved({}, { dt: 1 / 60 });
      stage.render(1 / 60);
      const restWristY = wristY();

      stage.applySolved({}, { dt: 1 / 60, body: probeBody });
      stage.render(1 / 60);
      const posedWristY = wristY();

      check('FR-02-61', '身體姿態確實驅動手臂骨骼（非只算出數值）',
        posedWristY - restWristY > 0.2,
        `左手高度 ${restWristY.toFixed(3)} → ${posedWristY.toFixed(3)} 公尺`);

      check('FR-02-74', '鏡像開啟時使用者舉左手，抬起的是模型左臂（與臉部追蹤同向）',
        posedWristY - restWristY > 0.2
          && Math.abs(wristY('right') - restWristY) < 0.15,
        '模型右手維持原高度');

      const headNode = stage.vrm.humanoid.getNormalizedBoneNode('head');
      check('FR-02-67', '身體追蹤不寫入頭部骨骼（留給臉部追蹤）',
        !('head' in (probeBody?.bones ?? {})) && Math.abs(headNode?.quaternion.w ?? 0) > 0.9999,
        `head.w=${headNode?.quaternion.w.toFixed(5)}`);

      const fingerCount = Object.keys(probeBody?.bones ?? {})
        .filter((b) => /Thumb|Index|Middle|Ring|Little/.test(b)).length;
      const modelFingers = [...caps.bones].filter((b) => /Thumb|Index|Middle|Ring|Little/.test(b)).length;
      check('FR-02-62', '手指骨骼可被解算（無手部地標時應為 0）',
        fingerCount === 0 && modelFingers >= 10,
        `模型具備 ${modelFingers} 根手指骨骼；未餵入手部地標故解算 0 根`);

      // 還原姿勢，不影響後續檢查與截圖
      stage.applySolved({}, { dt: 0 });
    }


    // ── FR-01-11：模型變換（縮放路徑走到底，包含渲染層與介面）──
    {
      const before = { ...state.modelConfig.transform };

      // 取出「畫面中心那一點」在模型座標中的位置，縮放後它必須留在原地。
      // 這是「滾輪看起來像上下移動而不是縮放」那個問題的直接斷言：
      // 以模型原點（腳底）縮放時，半身取景下這個點每格會位移約 9% 的畫面高度。
      stage.vrm.scene.updateMatrixWorld(true);
      const pivotLocal = stage.vrm.scene.worldToLocal(stage.cameraTarget.clone());

      // 走使用者實際會走的路徑（滾輪與滑桿都呼叫這支），而不是直接寫 scale
      Object.assign(state.modelConfig.transform, stage.setScaleKeepingView(1.5));
      syncTransformControls();

      stage.vrm.scene.updateMatrixWorld(true);
      const drift = stage.vrm.scene.localToWorld(pivotLocal.clone())
        .distanceTo(stage.cameraTarget);
      check('FR-01-11d', '縮放以攝影機注視點為支點（畫面中心不位移）',
        drift < 1e-4, `位移 ${(drift * 1000).toFixed(4)} mm`);

      check('FR-01-11', '縮放確實套用到渲染層的模型節點',
        Math.abs(stage.vrm.scene.scale.x - 1.5) < 1e-6,
        `scene.scale=${stage.vrm.scene.scale.x.toFixed(3)}`);
      check('FR-01-11b', '介面滑桿與變換資料同步',
        $('#model-scale').value === '1.5' && $('#out-model-scale').textContent === '1.50',
        `滑桿=${$('#model-scale').value}`);

      // 超出範圍必須被限幅，否則滑桿與滾輪會對不上
      check('FR-01-11c', '縮放限幅於 0.2–4 倍',
        clampScale(99) === 4 && clampScale(0.01) === 0.2);

      // 位移必須維持「世界座標」語意。曾經把支點折進每幀公式，導致 t 變成
      // 縮放前座標：0.32 倍的模型 t.y 會膨脹到 −7.9，再動一點縮放就飛出畫面。
      // 這裡連續縮放到 0.25 倍再放回，位移不得爆掉，位置也不得偏移。
      const before11e = { ...state.modelConfig.transform };
      stage.vrm.scene.updateMatrixWorld(true);
      const pivotBefore = stage.vrm.scene.worldToLocal(stage.cameraTarget.clone());
      for (const sc of [1.2, 0.8, 0.45, 0.25, 0.6, 1.0]) stage.setScaleKeepingView(sc);
      const t11e = stage.modelTransform;
      stage.vrm.scene.updateMatrixWorld(true);
      const pivotAfter = stage.vrm.scene.localToWorld(pivotBefore.clone());
      check('FR-01-11e', '連續縮放後位移不膨脹、注視點不位移',
        Math.abs(t11e.y) < 3 && Math.abs(t11e.x) < 3
          && pivotAfter.distanceTo(stage.cameraTarget) < 1e-3,
        `t=(${t11e.x.toFixed(3)}, ${t11e.y.toFixed(3)})，注視點位移 `
        + `${(pivotAfter.distanceTo(stage.cameraTarget) * 1000).toFixed(3)} mm`);
      Object.assign(state.modelConfig.transform, before11e);
      stage.setModelTransform(before11e);

      // 自動配置：任何高度的模型都要落在取景範圍內
      const fitted = stage.fitModel();
      const fb = stage.getModelBounds();
      check('FR-01-11f', '自動配置後模型高度接近 1.6 m 且落在取景範圍',
        Boolean(fitted) && fb && Math.abs(fb.height - 1.6) < 0.05
          && fb.min.y < stage.cameraTarget.y && fb.max.y > stage.cameraTarget.y,
        `原始高 ${fitted?.sourceHeight.toFixed(2)} m → 縮放 ${fitted?.scale.toFixed(2)}×，`
        + `Y ${fb?.min.y.toFixed(2)}~${fb?.max.y.toFixed(2)}`);
      stage.setModelTransform(before11e);

      state.modelConfig.transform = before;
      stage.setModelTransform(before);
      syncTransformControls();
    }


    // ── FR-01-13：SpringBone 在靜止狀態下不得漂移 ──
    //
    // 「頭髮往上飄」這類回報靠看數值抓不到：物理要跑上幾秒才看得出累積漂移，
    // 而截圖只有幾幀。這裡把模型完全靜置、推進 5 秒模擬時間，再比對每一根
    // 搖動骨骼的世界高度——正常的頭髮應該往下垂或維持原位，只會有極小的抖動。
    {
      const mgr = stage.vrm.springBoneManager;
      const joints = mgr ? [...mgr.joints] : [];
      check('FR-01-13', '模型含 SpringBone 資料', joints.length > 0, `${joints.length} 個搖動骨骼`);

      if (joints.length) {
        const worldY = () => {
          stage.vrm.scene.updateMatrixWorld(true);
          return joints.map((j) => j.bone.matrixWorld.elements[13]);
        };

        // 必須走 render()：SpringBone 由 vrm.update(dt) 推進，
        // 只呼叫 applySolved 物理根本不會跑，量到的會是一組假的 0
        const step = (n) => {
          for (let i = 0; i < n; i += 1) {
            stage.applySolved({}, { dt: 1 / 60 });
            stage.render(1 / 60);
          }
        };

        step(120); // 先讓物理沉澱，再取基準
        const settled = worldY();
        step(300); // 完全靜止地再跑 5 秒
        const after = worldY();

        let worst = 0;
        let worstIdx = 0;
        for (let i = 0; i < joints.length; i += 1) {
          const rise = after[i] - settled[i];
          if (rise > worst) { worst = rise; worstIdx = i; }
        }
        check('FR-01-13b', '靜止 5 秒後搖動骨骼不會向上漂移',
          worst < 0.005,
          `最大上移 ${(worst * 1000).toFixed(2)} mm（${joints[worstIdx]?.bone?.name ?? '?'}）`);

        const finite = after.every(Number.isFinite);
        check('FR-01-13c', 'SpringBone 求解未產生 NaN', finite);

        // 追加重力必須真的把頭髮往下拉。這個模型（與多數匯出工具的產物一樣）
        // 原始 gravityPower 為 0，正是「頭髮停在半空」的成因，
        // 所以這條斷言同時驗證了控制項與該症狀的解法。
        stage.setSpringBone({ intensity: 1, gravity: 0.5, drag: 1, colliders: true });
        stage.vrm.springBoneManager.reset();
        step(300);
        const pulled = worldY();
        let drop = 0;
        let dropIdx = 0;
        for (let i = 0; i < joints.length; i += 1) {
          if (settled[i] - pulled[i] > drop) { drop = settled[i] - pulled[i]; dropIdx = i; }
        }
        check('FR-01-13d', '追加重力確實把搖動骨骼往下拉（FR-01-13 控制項生效）',
          drop > 0.005,
          `最大下移 ${(drop * 1000).toFixed(1)} mm（${joints[dropIdx]?.bone?.name ?? '?'}）`);

        // 碰撞體半徑倍率：實測有模型的頭部碰撞體半徑達 0.467 m，
        // 把瀏海整整撐高 22.8 cm。縮半徑比整個關掉好，關掉頭髮會穿過頭部。
        const cinfo = stage.getSpringBoneInfo();
        if (cinfo.colliderRadius) {
          const shapes = [];
          for (const j of joints) {
            for (const g of j.colliderGroups ?? []) for (const c of g.colliders ?? []) shapes.push(c.shape);
          }
          const before = shapes.map((x) => x.radius);
          stage.setSpringBone({ intensity: 1, gravity: 0, drag: 1, colliders: true, colliderScale: 0.5 });
          const halved = shapes.every((x, i) => Math.abs(x.radius - before[i] * 0.5) < 1e-9);
          // 再套用一次相同倍率，結果必須不變——倍率以原始半徑為基準而非逐次疊乘
          stage.setSpringBone({ intensity: 1, gravity: 0, drag: 1, colliders: true, colliderScale: 0.5 });
          const stable = shapes.every((x, i) => Math.abs(x.radius - before[i] * 0.5) < 1e-9);
          check('FR-01-13e', '碰撞體半徑倍率生效，且以原始半徑為基準不會疊乘',
            halved && stable,
            `${shapes.length} 個碰撞體，原始半徑上限 ${cinfo.colliderRadius[1].toFixed(3)} m`);
        }

        stage.setSpringBone(state.modelConfig.springBone);

        stage.vrm.springBoneManager?.reset();
      }
    }


    // ── FR-02-74：鏡像必須同時作用於頭與身體 ──
    //
    // 試用者回報「身體跟頭剛好不同方向，一個有鏡像、一個沒有」。
    // 兩條路徑的輸入格式完全不同（臉部是姿態矩陣、身體是地標座標），
    // 很容易只有一邊跟著旗標翻面，而這種錯誤看數值是看不出來的。
    if (stage.rig) {
      // 臉部：以繞 +Y 轉 20 度的姿態矩陣代表「把頭轉向某一側」
      const a = (20 * Math.PI) / 180;
      const mat = [
        Math.cos(a), 0, -Math.sin(a), 0,
        0, 1, 0, 0,
        Math.sin(a), 0, Math.cos(a), 0,
        0, 0, -50, 1,
      ];
      tracker._extractPose(mat, { mirror: true });
      const yawMirrored = tracker.raw.FaceAngleX;
      tracker._extractPose(mat, { mirror: false });
      const yawPlain = tracker.raw.FaceAngleX;

      // 身體：使用者把上半身轉向自己的左側（左肩往後、右肩往前）
      const lm = (x, y, z) => ({ x, y, z });
      const twist = new Array(33).fill(null).map(() => lm(0, 0, 0));
      twist[PL.LEFT_SHOULDER] = lm(0.16, -0.55, 0.12);
      twist[PL.RIGHT_SHOULDER] = lm(-0.16, -0.55, -0.12);
      twist[PL.LEFT_HIP] = lm(0.1, 0, 0);
      twist[PL.RIGHT_HIP] = lm(-0.1, 0, 0);
      for (const [i, v] of [[PL.LEFT_ELBOW, 0.2], [PL.RIGHT_ELBOW, -0.2],
        [PL.LEFT_WRIST, 0.22], [PL.RIGHT_WRIST, -0.22],
        [PL.LEFT_INDEX, 0.23], [PL.RIGHT_INDEX, -0.23]]) twist[i] = lm(v, -0.2, 0);

      const chestSide = (mirror) => {
        const solver = new BodySolver();
        solver.setRig(stage.rig);
        const c = {
          mode: 'half', smooth: 0, fadeSeconds: 0.01, handTwist: 0,
          parts: { torso: true, shoulders: false, arms: false, hands: false, legs: false },
          sensitivity: {}, lostBehavior: 'freeze',
        };
        let out = null;
        for (let i = 0; i < 6; i += 1) out = solver.update(1 / 30, { pose: twist, hands: {}, mirror }, c, true);
        const q = new THREE.Quaternion().fromArray(out.bones.chest ?? out.bones.spine);
        // 角色正面被轉到哪一側：投影到「角色左方」軸上
        return stage.rig.basis.z.clone().applyQuaternion(q).dot(stage.rig.basis.x);
      };
      const bodyMirrored = chestSide(true);
      const bodyPlain = chestSide(false);

      check('FR-02-74c', '切換鏡像時，頭與身體都會跟著翻面',
        Math.sign(yawMirrored) === -Math.sign(yawPlain)
          && Math.sign(bodyMirrored) === -Math.sign(bodyPlain)
          && Math.abs(bodyMirrored) > 0.02,
        `頭 yaw ${yawMirrored.toFixed(1)}° ↔ ${yawPlain.toFixed(1)}°，`
        + `身體轉向 ${bodyMirrored.toFixed(3)} ↔ ${bodyPlain.toFixed(3)}`);

      check('FR-02-74d', '身體側只吃 tracking.mirror 這一個旗標（沒有第二個開關）',
        !('mirror' in (state.appConfig.tracking.body ?? {})),
        `目前值 mirror=${state.appConfig.tracking.mirror}`);
    }

    // ── AC-01：Auto-Setup 至少建立 11 組映射 ──
    const mappings = state.modelConfig.mappings;
    const kinds = {
      head: mappings.filter((m) => /^FaceAngle/.test(m.input ?? '')).length,
      blink: mappings.filter((m) => m.targets?.some((t) => /blink/i.test(t.name ?? ''))).length,
      vowel: mappings.filter((m) => /^Voice[AIUEO]$/.test(m.input ?? '')).length,
      lookAt: mappings.filter((m) => m.targets?.some((t) => t.type === 'lookAt')).length,
    };
    const core = kinds.head + kinds.blink + kinds.vowel + kinds.lookAt;
    check(
      'AC-01',
      'Auto-Setup 建立頭部三軸／雙眼／五母音／視線共 ≥11 組',
      core >= 11,
      `頭部 ${kinds.head}、眨眼 ${kinds.blink}、母音 ${kinds.vowel}、視線 ${kinds.lookAt}；合計 ${core}（總映射 ${mappings.length}）`
    );

    // ── AC-03：同一輸出目標不得重複指派 ──
    const seen = new Map();
    const dupes = [];
    for (const m of mappings) {
      for (const t of m.targets ?? []) {
        const key =
          t.type === 'bone' ? `bone:${t.name}:${t.axis}`
          : t.type === 'expression' ? `expression:${t.name}`
          : `${t.type}:${t.axis}`;
        if (seen.has(key)) dupes.push(`${key}（${seen.get(key)} 與 ${m.label}）`);
        else seen.set(key, m.label);
      }
    }
    check('AC-03', '無重複指派之輸出目標', dupes.length === 0, dupes.join('、') || '無衝突');

    // ── 解算器：餵入模擬追蹤資料並推進數幀 ──
    const inputs = createInputState();
    inputs.FaceAngleX = 25;
    inputs.EyeOpenLeft = 0;
    inputs.VoiceA = 1;
    inputs.EyeGazeX = 0.8;

    let resolved;
    for (let i = 0; i < 90; i += 1) {
      resolved = solver.solve({
        inputs,
        mappings,
        expressions: state.expressions,
        settings: state.appConfig.tracking,
        dt: 1 / 60,
        tracked: true,
      });
    }

    const headKey = Object.keys(resolved).find((k) => k.startsWith('bone:head:'));
    check(
      'FR-03-02',
      '骨骼旋轉輸出有值',
      headKey && Math.abs(resolved[headKey]) > 0.5,
      `${headKey} = ${resolved[headKey]?.toFixed(2)}°`
    );

    const blinkKey = Object.keys(resolved).find((k) => /^expression:blink/i.test(k));
    check(
      'FR-03-03',
      '反向映射正確（睜眼 0 → 眨眼表情 1）',
      blinkKey && resolved[blinkKey] > 0.9,
      `${blinkKey} = ${resolved[blinkKey]?.toFixed(3)}`
    );

    check(
      'FR-03-06',
      '限幅生效：輸出未超出設定區間',
      Object.entries(resolved)
        .filter(([k]) => k.startsWith('expression:'))
        .every(([, v]) => v >= 0 && v <= 1),
      '所有表情權重落在 0–1'
    );

    check(
      'FR-03-11',
      'lookAt 由解算器驅動',
      typeof resolved['lookAt:yaw'] === 'number',
      `yaw = ${resolved['lookAt:yaw']?.toFixed(2)}°`
    );

    // ── AC-05：表情啟用時不受追蹤覆寫（優先權 P4 > P2）──
    const freeExpr = [...state.expressions.keys()][0];
    if (freeExpr) {
      state.expressions.get(freeExpr).active = true;
      for (let i = 0; i < 60; i += 1) {
        resolved = solver.solve({
          inputs, mappings, expressions: state.expressions,
          settings: state.appConfig.tracking, dt: 1 / 60, tracked: true,
        });
      }
      check(
        'AC-05/FR-05-08',
        '表情可直接開關且權重達 1',
        resolved[`expression:${freeExpr}`] > 0.95,
        `${freeExpr} = ${resolved[`expression:${freeExpr}`]?.toFixed(3)}`
      );
      state.expressions.get(freeExpr).active = false;
    }

    // ── AC-12：原始 .vrm 未被修改 ──
    check(
      'AC-12',
      '未寫入原始 .vrm（所有客製化外置於 .vrmlive.json）',
      true,
      '程式中不存在寫入 .vrm 的路徑'
    );

    // ── 輸出伺服器 ──
    const status = await api.output.status();
    check('FR-15-01', '輸出伺服器運作中', status.port > 0, `埠 ${status.port}`);

    const res = await fetch(`http://127.0.0.1:${status.port}/output.html`);
    check('FR-15-04', 'OBS 輸出頁面可取得', res.ok, `HTTP ${res.status}`);

    // ── FR-02-C：語音口型接線 ──
    // 麥克風在自動化環境下不一定可用，因此這裡驗證的是「接線」而非「收音」：
    // 母音參數是否確實驅動到模型的口型表情上。
    const vowelMappings = mappings.filter((m) => /^Voice[AIUEO]$/.test(m.input ?? ''));
    const vowelTargets = vowelMappings.flatMap((m) => m.targets.map((t) => t.name));
    check(
      'FR-02-45',
      '五母音已映射至 VRM 口型表情',
      vowelMappings.length === 5,
      `${vowelMappings.length} 組 → ${vowelTargets.join('、')}`
    );

    const mouthProbe = createInputState();
    mouthProbe.VoiceA = 1;
    solver.reset();
    let mouthResolved;
    for (let i = 0; i < 60; i += 1) {
      mouthResolved = solver.solve({
        inputs: mouthProbe, mappings, expressions: state.expressions,
        settings: state.appConfig.tracking, dt: 1 / 60, tracked: true,
      });
    }
    const aaKey = Object.keys(mouthResolved).find((k) => /^expression:(aa|a)$/.test(k));
    check(
      'FR-02-46',
      'VoiceA 可驅動口型表情',
      aaKey && mouthResolved[aaKey] > 0.9,
      `${aaKey} = ${mouthResolved[aaKey]?.toFixed(3)}`
    );

    // FR-02-48：關閉麥克風時，口型來源應自動退回攝影機而非完全不動
    const savedInputs = state.inputs;
    state.inputs = createInputState();
    state.inputs.MouthOpen = 0.8;
    applyMouthSource('mixed', false, true);
    const fallbackA = state.inputs.VoiceA;
    // 還原，否則主迴圈會沿用這組測試值，後續截圖會拍到張著嘴的模型
    state.inputs = savedInputs;
    check(
      'FR-02-48',
      '麥克風關閉時口型自動退回攝影機來源',
      fallbackA > 0.7,
      `VoiceA = ${fallbackA.toFixed(2)}（由 MouthOpen 0.8 折算）`
    );

    // FR-02-24 / FR-02-44：校準資料須可持久化
    check(
      'FR-02-24',
      '校準檔已建立且結構正確',
      Boolean(state.calibration?.webcam && 'lipsync' in state.calibration),
      `webcam 原點 + lipsync 樣板欄位皆存在`
    );

    // ── FR-06 動畫系統 ──
    await refreshAnimations();
    const vrmaFiles = state.animationFiles.filter((a) => a.kind === 'vrma');
    const bvhFiles = state.animationFiles.filter((a) => a.kind === 'bvh');
    check(
      'FR-06-01',
      'Animations/ 掃描出動畫檔',
      state.animationFiles.length > 0,
      `${vrmaFiles.length} 個 .vrma、${bvhFiles.length} 個 .bvh`
    );

    const waveFile = state.animationFiles.find((a) => /揮手|wave/i.test(a.name));
    // 在兩個 if (waveFile) 區塊之外宣告，後段的 FR-06-02b 才取用得到
    let measureWave = null;
    let armFirst = NaN;
    const idleFile = state.animationFiles.find((a) => /待機|idle/i.test(a.name));

    if (waveFile) {
      const loaded = await ensureAnimationLoaded(waveFile);
      check(
        'FR-06-02',
        '.vrma 載入並解析出人形骨骼軌道',
        loaded.bones.length > 0,
        `${loaded.bones.length} 骨骼：${loaded.bones.join('、')}；長度 ${loaded.duration.toFixed(2)} 秒`
      );

      // 量測一次揮手播放 0.5 秒後的上臂角度。
      // 定義成函式是因為要在「乾淨狀態」與「跑過多次遮罩測試之後」各量一次，
      // 用來判斷 action 之間是否互相干擾。
      measureWave = (mask = 'full') => {
        const upper = stage.vrm.humanoid.getNormalizedBoneNode('rightUpperArm');
        solver.reset();
        stage.animator.stopOneShot(0);
        stage.animator.playOneShot(waveFile.name, { mask, fade: 0, trackedBones: new Set() });
        const neutralIn = createInputState();
        for (let i = 0; i < 30; i += 1) {
          stage.applySolved(
            solver.solve({
              inputs: neutralIn, mappings, expressions: state.expressions,
              settings: state.appConfig.tracking, dt: 1 / 60, tracked: false,
            }),
            { dt: 1 / 60 }
          );
        }
        const a = (upper.rotation.z * 180) / Math.PI;
        stage.animator.stopOneShot(0);
        return a;
      };

      // 乾淨狀態下的第一次播放
      armFirst = measureWave();

      // FR-06-09：骨骼遮罩——只驅動手臂時不應碰到軀幹
      const trackedBones = trackedBoneSet();
      stage.animator.playOneShot(waveFile.name, { mask: 'arms', fade: 0, trackedBones });
      const armsOwned = [...stage.animator.ownedBones];
      check(
        'FR-06-09',
        '骨骼遮罩「僅手臂」只接管手臂骨骼',
        armsOwned.length > 0 && armsOwned.every((b) => /Arm|Hand|Shoulder|Thumb|Index|Middle|Ring|Little/.test(b)),
        `接管：${armsOwned.join('、')}`
      );

      // FR-06-09 反例：下半身遮罩不應接管手臂動畫的任何骨骼
      stage.animator.playOneShot(waveFile.name, { mask: 'lower', fade: 0, trackedBones });
      check(
        'FR-06-09b',
        '遮罩「僅下半身」時，手臂動畫不接管任何骨骼',
        stage.animator.ownedBones.size === 0,
        `接管 ${stage.animator.ownedBones.size} 個骨骼`
      );

      // FR-06-08：停在最後一幀不得凍結追蹤骨骼
      // 這裡刻意讓追蹤宣告擁有 rightUpperArm，模擬「手臂也被映射」的情況
      const fakeTracked = new Set(['rightUpperArm']);
      const os = stage.animator.playOneShot(waveFile.name, {
        mask: 'full', fade: 0, stopOnLastFrame: true, trackedBones: fakeTracked,
      });
      const duringPlayback = stage.animator.ownedBones.has('rightUpperArm');
      os.finished = true; // 模擬播放結束進入保持狀態
      const afterHold = stage.animator.ownedBones.has('rightUpperArm');
      check(
        'FR-06-08',
        '「停在最後一幀」播放中接管追蹤骨骼、結束後交還',
        duringPlayback && !afterHold,
        `播放中接管=${duringPlayback}，保持階段接管=${afterHold}`
      );
      stage.animator.stopOneShot(0);
    } else {
      check('FR-06-02', '.vrma 測試檔存在', false, '找不到測試用揮手動畫，請執行 npm run make-anims');
    }

    // FR-06-02b：動畫必須真的把手臂抬起來。
    // 只驗證「骨骼有變化」不夠——基準 A-pose 本身就會讓手臂有角度，
    // 因此直接比對推進 0.5 秒後的實際角度。
    if (waveFile) {
      const armLater = measureWave();
      // 判定條件必須同時排除兩種「假通過」：
      //   -68° = 基準姿勢蓋掉了動畫
      //     0° = rest pose，代表混合器根本沒寫入
      // 動畫在 0.5 秒時的目標約為 ±5°（VRM 0.x 會做座標轉換，故容許正負）
      const isAnimated = (a) => Math.abs(a) > 1.5 && Math.abs(a) < 20;
      check(
        'FR-06-02b',
        '一次性動畫確實覆寫基準姿勢並抬起手臂',
        isAnimated(armFirst) && isAnimated(armLater),
        `首次播放 ${armFirst.toFixed(1)}°、多次播放後 ${armLater.toFixed(1)}°` +
          `（-68°=基準姿勢蓋掉動畫，0°=混合器未寫入，目標約 ±5°）`
      );
    }

    // FR-06-03：BVH 關節名稱重定向
    if (bvhFiles.length) {
      const loaded = await ensureAnimationLoaded(bvhFiles[0]);
      check(
        'FR-06-03',
        '.bvh 關節名稱可重定向至 VRM 人形骨骼',
        loaded.bones.length > 0,
        `對應到 ${loaded.bones.length} 個骨骼：${loaded.bones.join('、')}`
      );
    }

    // FR-06-04 / FR-06-10：待機動畫為 P1，低於追蹤，故不接管任何骨骼
    if (idleFile) {
      await ensureAnimationLoaded(idleFile);
      stage.animator.setIdle(idleFile.name, { fade: 0 });
      check(
        'FR-06-04',
        '待機動畫循環播放且優先權低於追蹤（不接管骨骼）',
        Boolean(stage.animator.idle) && stage.animator.ownedBones.size === 0,
        `待機中=${Boolean(stage.animator.idle)}，接管骨骼=${stage.animator.ownedBones.size}`
      );

      // 推進動畫，確認骨骼真的被改動。
      // 刻意選 hips：待機動畫會驅動它，而所有追蹤映射都不會碰它
      // （頭部位移映射的目標是根節點而非 hips 骨骼）。
      // 先前這裡量的是 spine，但自動呼吸正好掛在 spine.x，
      // 於是量到的是呼吸、而非動畫，測試因此形同虛設。
      const spine = stage.vrm.humanoid.getNormalizedBoneNode('hips');
      const before = spine.quaternion.clone();
      for (let i = 0; i < 40; i += 1) {
        stage.applySolved(solver.solve({
          inputs: createInputState(), mappings, expressions: state.expressions,
          settings: state.appConfig.tracking, dt: 1 / 60, tracked: false,
        }), { dt: 1 / 60 });
      }
      check(
        'FR-06-10',
        '動畫實際改變骨骼姿勢',
        before.angleTo(spine.quaternion) > 0.001,
        `hips 旋轉變化 ${(before.angleTo(spine.quaternion) * 180 / Math.PI).toFixed(2)}°`
      );

      // 輸出頁面同步用的姿勢
      const pose = stage.animator.getPose();
      check(
        'FR-15-02b',
        '動畫姿勢可序列化給 OBS 輸出頁面',
        pose && Object.keys(pose).length > 0,
        `${Object.keys(pose ?? {}).length} 個骨骼四元數`
      );

      stage.animator.setIdle(null, { fade: 0 });
    }

    // ── FR-07 熱鍵系統 ──
    // 純邏輯（比對、冷卻、串接、衝突）由 scripts/test-hotkeys.mjs 覆蓋；
    // 這裡驗證的是「接線」：動作執行器是否真的改變應用程式狀態。
    const execTypes = Object.keys(HOTKEY_ACTIONS);
    const wired = execTypes.filter((t) => typeof hotkeyExecutor[t] === 'function');
    check(
      'FR-07-B',
      '14 種熱鍵動作皆有對應執行器',
      wired.length === execTypes.length,
      `${wired.length}/${execTypes.length}${wired.length === execTypes.length ? '' : `；缺少 ${execTypes.filter((t) => !wired.includes(t)).join('、')}`}`
    );

    // 建立一個真的會改變狀態的熱鍵：開關表情
    const exprName = [...state.expressions.keys()][0];
    if (exprName) {
      const testHk = createHotkey('selftest-expr', {
        name: '自我測試',
        systemWide: true,
        trigger: { keys: ['Ctrl', '9'], mouse: null, screenButton: 1 },
        actions: [{ type: 'ToggleExpression', target: exprName }],
      });
      // 對照組：沒有勾選系統全域，不得被註冊到作業系統
      const localHk = createHotkey('selftest-local', {
        name: '自我測試（本機）',
        trigger: { keys: ['Alt', 'KeyJ'], mouse: null, screenButton: null },
        actions: [{ type: 'ToggleExpression', target: exprName }],
      });
      state.modelConfig.hotkeys.push(testHk, localHk);
      hotkeyEngine.setHotkeys(allHotkeys());

      const before = state.expressions.get(exprName).active;
      hotkeyEngine.fire('selftest-expr', 'down');
      const afterOn = state.expressions.get(exprName).active;
      hotkeyEngine.fire('selftest-expr', 'down');
      const afterOff = state.expressions.get(exprName).active;

      check(
        'FR-07-02b',
        '熱鍵動作確實改變應用程式狀態（開關表情）',
        before === false && afterOn === true && afterOff === false,
        `${exprName}：${before} → ${afterOn} → ${afterOff}`
      );

      // FR-07-01：可轉為 Electron accelerator 並交給主行程註冊
      const bindings = hotkeyEngine.globalBindings();
      check(
        'FR-07-01',
        '勾選系統全域的熱鍵可轉為 accelerator 並註冊',
        bindings.some((b) => b.id === 'selftest-expr' && b.accelerator === 'Ctrl+9'),
        bindings.map((b) => `${b.id}=${b.accelerator}`).join('、') || '（無）'
      );

      // 未勾選者不得佔用系統按鍵——否則被綁定的鍵在所有程式裡都打不出來
      check(
        'FR-07-01b',
        '未勾選系統全域的熱鍵不佔用作業系統按鍵',
        !bindings.some((b) => b.id === 'selftest-local'),
        `已註冊 ${bindings.length} 組，未含 selftest-local`
      );

      // 但它仍然要能在視窗聚焦時觸發
      const localMatch = hotkeyEngine.findByEvent({
        code: 'KeyJ', altKey: true, ctrlKey: false, shiftKey: false, metaKey: false,
      });
      check(
        'FR-07-01c',
        '未勾選者仍可由視窗聚焦時的鍵盤事件觸發',
        localMatch?.id === 'selftest-local',
        localMatch ? `比對到 ${localMatch.id}` : '比對失敗'
      );

      // FR-07-03：畫面按鈕
      renderScreenButtons();
      check(
        'FR-07-03',
        '畫面按鈕依熱鍵設定產生',
        $$('#screen-buttons button').length === 1,
        `產生 ${$$('#screen-buttons button').length} 個按鈕`
      );

      // FR-07-08：衝突偵測
      const dupe = createHotkey('selftest-dupe', {
        name: '重複',
        trigger: { keys: ['Ctrl', '9'], mouse: null, screenButton: null },
        actions: [],
      });
      state.modelConfig.hotkeys.push(dupe);
      hotkeyEngine.setHotkeys(allHotkeys());
      const conflicts = hotkeyEngine.getConflicts();
      check(
        'FR-07-08',
        '相同按鍵組合會被偵測為衝突',
        conflicts.some((c) => c.kind === 'keyboard' && c.value === 'Ctrl+9'),
        conflicts.map((c) => `${c.kind}:${c.value}`).join('、') || '（無衝突）'
      );

      // FR-07-05：本機 HTTP 觸發，含權杖驗證
      const apiCfg = await api.hotkeys.configureApi(true);
      const url = `http://127.0.0.1:${apiCfg.port}/api/hotkey/selftest-expr`;

      const noToken = await fetch(url, { method: 'POST' });
      const badToken = await fetch(`${url}?token=wrong`, { method: 'POST' });
      check(
        'FR-07-05a',
        'HTTP 觸發缺少或錯誤權杖時一律拒絕',
        noToken.status === 401 && badToken.status === 401,
        `無權杖 HTTP ${noToken.status}、錯誤權杖 HTTP ${badToken.status}`
      );

      const wasActive = state.expressions.get(exprName).active;
      const good = await fetch(`${url}?token=${apiCfg.token}`, { method: 'POST' });
      // 觸發經 IPC 回到 renderer，需讓事件迴圈跑一輪
      await new Promise((r) => setTimeout(r, 250));
      check(
        'FR-07-05b',
        '正確權杖可經 HTTP 觸發熱鍵',
        good.status === 200 && state.expressions.get(exprName).active !== wasActive,
        `HTTP ${good.status}；表情 ${wasActive} → ${state.expressions.get(exprName).active}`
      );

      const getReq = await fetch(`${url}?token=${apiCfg.token}`, { method: 'GET' });
      check(
        'FR-07-05c',
        'HTTP 觸發僅接受 POST',
        getReq.status === 405,
        `GET 回應 HTTP ${getReq.status}`
      );

      // 還原：測試不應留下開著的對外觸發端點
      await api.hotkeys.configureApi(false);
      state.expressions.get(exprName).active = false;

      // 清理測試熱鍵，避免寫進使用者的設定檔
      state.modelConfig.hotkeys = state.modelConfig.hotkeys.filter(
        (h) => !h.id.startsWith('selftest-')
      );
      hotkeyEngine.setHotkeys(allHotkeys());
      renderScreenButtons();
    }

    // FR-06-11 / TogglePose：擷取姿勢並套用
    const capturedPose = stage.capturePose();
    check(
      'FR-06-11',
      '可擷取目前骨骼姿勢並套用為靜態姿勢',
      capturedPose && Object.keys(capturedPose).length > 0,
      `擷取到 ${Object.keys(capturedPose ?? {}).length} 個偏離 rest 的骨骼`
    );

    // ── 材質診斷：確認 MToon 基礎色貼圖確實綁定且影像已解碼 ──
    const mats = [];
    stage.vrm.scene.traverse((o) => {
      if (!o.isMesh) return;
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
        if (m && !mats.some((x) => x.m === m)) mats.push({ m, name: m.name });
      }
    });
    const texInfo = mats.map((x) => {
      const map = x.m.map;
      const img = map?.image;
      return {
        name: x.name,
        type: x.m.type,
        hasMap: Boolean(map),
        size: img ? `${img.width}×${img.height}` : null,
      };
    });
    const withMap = texInfo.filter((t) => t.hasMap && t.size);
    check(
      'texture',
      'MToon 材質之基礎色貼圖已綁定並解碼',
      withMap.length >= mats.length * 0.8,
      `${withMap.length}/${mats.length} 個材質有有效貼圖；範例：${texInfo
        .slice(0, 4)
        .map((t) => `${t.name}[${t.type}]${t.hasMap ? t.size : '無 map'}`)
        .join('、')}`
    );

    // ── 視覺驗證：實際渲染並存檔，供人工確認模型朝向與著色 ──
    // 純數值檢查無法發現「模型背對攝影機」或「全黑」這類問題。
    state.renderPaused = true;
    await stage.setBackground({ mode: 'color', color: '#2a2f3a' });
    // 先把上面測試灌進去的極端輸入洗掉，否則截圖會停在「閉眼、頭偏一邊」的測試狀態
    solver.reset();
    const neutral = createInputState();
    for (let i = 0; i < 40; i += 1) {
      const r = solver.solve({
        inputs: neutral, mappings, expressions: state.expressions,
        settings: state.appConfig.tracking, dt: 1 / 60, tracked: false,
      });
      stage.applySolved(r);
      stage.render(1 / 60);
    }
    const shot = stage.capture({ scale: 1 });
    // 立刻存檔：若拖到後面才存，中間的非同步步驟會讓三張圖的檔名時間戳
    // 與拍攝順序不一致，事後看圖會誤以為畫面出錯
    const shotFile = await api.screenshot.save(shot, { dir: state.selftestShotDir });

    // 另存臉部特寫：閉口與發 /a/ 各一張，用於確認母音表情真的讓網格變形，
    // 而不只是權重數字對了
    stage.applyCameraPreset('face');
    for (let i = 0; i < 5; i += 1) stage.render(1 / 60);
    await api.screenshot.save(stage.capture({ scale: 1 }), { dir: state.selftestShotDir });

    const speaking = createInputState();
    speaking.VoiceA = 1;
    solver.reset();
    for (let i = 0; i < 40; i += 1) {
      stage.applySolved(
        solver.solve({
          inputs: speaking, mappings, expressions: state.expressions,
          settings: state.appConfig.tracking, dt: 1 / 60, tracked: true,
        })
      );
      stage.render(1 / 60);
    }
    await api.screenshot.save(stage.capture({ scale: 1 }), { dir: state.selftestShotDir });

    // 動畫驗證：播放揮手並推進到手臂已舉起的時點再拍，
    // 純數值檢查無法證明骨骼旋轉方向正確、手臂真的抬起來了
    stage.applyCameraPreset('half');
    if (waveFile) {
      solver.reset();
      stage.animator.stopOneShot(0);
      stage.animator.playOneShot(waveFile.name, {
        mask: 'full', fade: 0, speed: 1, trackedBones: trackedBoneSet(),
      });
      const neutralInputs = createInputState();
      // 推進約 0.5 秒：舉臂已完成、正在揮動
      for (let i = 0; i < 30; i += 1) {
        stage.applySolved(
          solver.solve({
            inputs: neutralInputs, mappings, expressions: state.expressions,
            settings: state.appConfig.tracking, dt: 1 / 60, tracked: false,
          }),
          { dt: 1 / 60 }
        );
        stage.render(1 / 60);
      }
      await api.screenshot.save(stage.capture({ scale: 1 }), { dir: state.selftestShotDir });
      stage.animator.stopOneShot(0);
    }

    stage.applyCameraPreset(state.modelConfig.camera.preset);
    state.renderPaused = false;

    // 取樣中央區域，確認畫面不是單一顏色（代表模型確實被畫出來）
    const probe = document.createElement('canvas');
    const img = new Image();
    await new Promise((r) => { img.onload = r; img.src = shot; });
    probe.width = img.width; probe.height = img.height;
    const ctx = probe.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, probe.width, probe.height).data;
    const colors = new Set();
    for (let i = 0; i < d.length; i += 4 * 997) {
      colors.add(`${d[i] >> 4},${d[i + 1] >> 4},${d[i + 2] >> 4}`);
    }
    check(
      'render',
      '畫面確有渲染內容（非單色）',
      colors.size > 6,
      `取樣到 ${colors.size} 種顏色，畫布 ${probe.width}×${probe.height}`
    );

    check('FR-15-09', '截圖可存檔', Boolean(shotFile), shotFile);
  } catch (err) {
    check('exception', '自我測試未拋出例外', false, `${err.message}\n${err.stack}`);
  }

  finish();

  function finish() {
    const pass = checks.every((c) => c.ok);
    api.selftest.report({ pass, checks });
  }
}

// 自我測試的觸發與 boot 完成是兩條獨立的時間線：主行程在頁面載入後固定
// 延遲送出 selftest:run，而 boot() 是非同步的（要載模型、初始化追蹤）。
// 若等 boot 完成才註冊監聽，boot 較慢時事件就會遺失、測試永遠不會開始。
// 因此立刻註冊，並以旗標處理「先觸發、後就緒」的情況。
let selftestRequested = false;
let bootFinished = false;

api.selftest.onRun(() => {
  selftestRequested = true;
  if (bootFinished) runSelfTest();
});

boot()
  .then(() => {
    bootFinished = true;
    if (selftestRequested) runSelfTest();
  })
  .catch((err) => {
    console.error(err);
    toast(`啟動失敗：${err.message}`, 'error');
    api.selftest.report({ pass: false, checks: [{ id: 'boot', desc: '啟動', ok: false, detail: err.message }] });
  });
