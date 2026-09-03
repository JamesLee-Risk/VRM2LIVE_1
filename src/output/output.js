/**
 * OBS 輸出頁面 — FR-15-01、FR-15-02、FR-15-03、FR-15-14。
 *
 * 這個頁面**不執行任何追蹤運算**。它只做兩件事：
 *   1. 載入與主視窗相同的 VRM
 *   2. 以 WebSocket 接收主視窗已解算好的目標值表並套用
 *
 * 這正是 FR-15-02 的要求：開啟 OBS 來源不會讓追蹤跑第二次。
 */
import { Stage } from '../shared/stage.js';

const canvas = document.getElementById('stage');
const statusEl = document.getElementById('status');
const params = new URLSearchParams(location.search);

// ?w= / ?h= 指定輸出解析度（FR-15-03）；未指定則填滿視窗
const wantW = Number(params.get('w')) || 0;
const wantH = Number(params.get('h')) || 0;
const silent = params.get('silent') === '1';

if (silent) statusEl.remove();

if (wantW && wantH) {
  // 固定內部解析度，避免 OBS 來源尺寸與渲染尺寸不一致造成模糊
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  document.body.style.aspectRatio = `${wantW} / ${wantH}`;
}

const stage = new Stage(canvas, { transparent: true });

let currentModelUrl = null;
let receivedFirstState = false;
let lastTime = performance.now();

function setStatus(text, hide = false) {
  if (!statusEl.isConnected) return;
  if (hide) {
    statusEl.remove();
    return;
  }
  statusEl.textContent = text;
}

// ────────────────────────────────────────────────────────────────
// WebSocket
// ────────────────────────────────────────────────────────────────

let ws = null;
let reconnectDelay = 500;

function connect() {
  ws = new WebSocket(`ws://${location.host}/ws`);

  ws.addEventListener('open', () => {
    reconnectDelay = 500;
    setStatus('已連線，等待場景…');
  });

  ws.addEventListener('message', async (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }

    if (msg.type === 'scene') {
      await applyScene(msg.payload);
    } else if (msg.type === 'state') {
      // __pose 為主視窗算好的動畫骨骼姿勢，__body 為身體追蹤姿態（FR-02-D）。
      // 兩者都已在主視窗解算完畢，此頁不重跑動畫時間軸也不重跑姿態估計（FR-02-79）
      const { __pose: pose, __body: body, ...resolved } = msg.payload;
      stage.applySolved(resolved, { pose: pose ?? null, body: body ?? null });
      if (!receivedFirstState) {
        receivedFirstState = true;
        setStatus('', true);
      }
    }
  });

  ws.addEventListener('close', () => {
    setStatus('連線中斷，重新連線中…');
    // 指數退避，上限 5 秒——OBS 可能比主程式先啟動
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 1.6, 5000);
  });

  ws.addEventListener('error', () => ws.close());
}

async function applyScene(scene) {
  try {
    if (scene.modelUrl && scene.modelUrl !== currentModelUrl) {
      setStatus('載入模型…');
      currentModelUrl = scene.modelUrl;
      await stage.loadVRM(scene.modelUrl);
    }

    // 必須在模型載入之後：setSpringBone 用的是 loadVRM 當下快取的原始參數
    if (scene.springBone) stage.setSpringBone(scene.springBone);
    if (scene.transform) stage.setModelTransform(scene.transform);
    if (scene.camera?.preset) stage.applyCameraPreset(scene.camera.preset);
    if (scene.lighting) stage.setLighting(scene.lighting);

    if (scene.background) {
      const bg = scene.background;
      // 輸出頁面預設一律透明；只有明確指定非透明背景時才套用
      await stage.setBackground(
        bg.mode === 'transparent' ? { mode: 'transparent' } : { ...bg, url: bg.url ?? null }
      );
    }
  } catch (err) {
    setStatus(`場景載入失敗：${err.message}`);
    console.error(err);
  }
}

// ────────────────────────────────────────────────────────────────
// 渲染迴圈
// ────────────────────────────────────────────────────────────────

function frame() {
  requestAnimationFrame(frame);
  const now = performance.now();
  const dt = Math.min((now - lastTime) / 1000, 0.25);
  lastTime = now;
  // 只做渲染與 SpringBone 推進；姿勢由 applySolved 從外部餵入
  stage.render(dt);
}

// 供自我測試查詢的診斷介面（不影響輸出畫面）
window.__vrm2liveOutput = {
  get modelLoaded() {
    return Boolean(stage.vrm);
  },
  get modelUrl() {
    return currentModelUrl;
  },
  get receivedState() {
    return receivedFirstState;
  },
  get socketOpen() {
    return ws?.readyState === 1;
  },
};

connect();
requestAnimationFrame(frame);
