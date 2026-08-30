/**
 * Webcam 臉部追蹤 — FR-02-01、FR-02-20～FR-02-31。
 *
 * 以 MediaPipe Face Landmarker 取得 52 項 ARKit 相容 blendshape 與頭部姿態矩陣，
 * 再換算為規格附錄 A-1 定義的輸入參數。
 *
 * ─── 隱私（FR-02-20 / NFR-S-02）───────────────────────────────
 * <video> 元素以 createElement 建立後**永不 appendChild**，也不繪製到任何 canvas。
 * 影像只在記憶體中交給 MediaPipe，介面上不存在顯示攝影機畫面的程式路徑。
 * 修改本檔時務必維持此性質。
 */
import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';
import * as THREE from 'three';

const DEG = 180 / Math.PI;

/** 取得 blendshape 分數的小工具 */
function score(map, name) {
  return map.get(name) ?? 0;
}

export class WebcamTracker {
  constructor({ log = () => {} } = {}) {
    this.log = log;
    this.landmarker = null;
    this.stream = null;
    this.running = false;

    // 刻意不加入 DOM——見檔頭隱私說明
    this.video = document.createElement('video');
    this.video.playsInline = true;
    this.video.muted = true;

    this.lastVideoTime = -1;
    this.lastResultTime = 0;
    this.detectedAt = 0;
    this.faceFound = false;

    /** 追蹤器輸出的原始參數 */
    this.raw = Object.create(null);
    /** 校準偏移（FR-02-24） */
    this.calibration = { angleX: 0, angleY: 0, angleZ: 0, posX: 0, posY: 0, posZ: 0 };

    this.fpsCounter = { frames: 0, since: performance.now(), value: 0 };

    this._matrix = new THREE.Matrix4();
    this._euler = new THREE.Euler(0, 0, 0, 'YXZ');
  }

  /** 列出可用攝影機（FR-02-21） */
  static async listCameras() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      return devices
        .filter((d) => d.kind === 'videoinput')
        .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `攝影機 ${i + 1}` }));
    } catch {
      return [];
    }
  }

  async init() {
    if (this.landmarker) return;
    const fileset = await FilesetResolver.forVisionTasks('./mediapipe-wasm');
    this.landmarker = await FaceLandmarker.createFromOptions(fileset, {
      baseOptions: {
        modelAssetPath: './face_landmarker.task',
        delegate: 'GPU',
      },
      runningMode: 'VIDEO',
      numFaces: 1,
      outputFaceBlendshapes: true,
      outputFacialTransformationMatrixes: true,
    });
    this.log('info', '追蹤引擎已初始化');
  }

  async start({ deviceId = null, width = 1280, height = 720 } = {}) {
    await this.init();
    await this.stop();

    this.stream = await navigator.mediaDevices.getUserMedia({
      video: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        width: { ideal: width },
        height: { ideal: height },
        frameRate: { ideal: 30 },
      },
      audio: false,
    });

    this.video.srcObject = this.stream;
    await this.video.play();
    this.running = true;
    this.log('info', `攝影機追蹤已啟動（${this.video.videoWidth}×${this.video.videoHeight}）`);
  }

  async stop() {
    this.running = false;
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop();
      this.stream = null;
    }
    this.video.srcObject = null;
    this.faceFound = false;
  }

  /** 以當前姿勢為中性原點（FR-02-24） */
  calibrate() {
    if (!this.faceFound) return false;
    this.calibration = {
      angleX: this._lastAngle.x,
      angleY: this._lastAngle.y,
      angleZ: this._lastAngle.z,
      posX: this._lastPos.x,
      posY: this._lastPos.y,
      posZ: this._lastPos.z,
    };
    this.log('info', '追蹤已校準');
    return true;
  }

  resetCalibration() {
    this.calibration = { angleX: 0, angleY: 0, angleZ: 0, posX: 0, posY: 0, posZ: 0 };
  }

  /**
   * 推進一次偵測。應以追蹤 FPS 呼叫，而非渲染 FPS。
   * @param {object} settings 追蹤設定
   * @returns {boolean} 本次是否產生新結果
   */
  tick(settings = {}) {
    if (!this.running || !this.landmarker) return false;
    if (this.video.readyState < 2) return false;
    if (this.video.currentTime === this.lastVideoTime) return false;

    this.lastVideoTime = this.video.currentTime;

    let result;
    try {
      result = this.landmarker.detectForVideo(this.video, performance.now());
    } catch (err) {
      this.log('warn', `偵測失敗：${err.message}`);
      return false;
    }

    this._countFps();

    const shapes = result.faceBlendshapes?.[0];
    const matrix = result.facialTransformationMatrixes?.[0];

    if (!shapes || !matrix) {
      // 追蹤遺失（FR-02-25 由上層依設定決定行為）
      this.faceFound = false;
      return true;
    }

    this.faceFound = true;
    this.detectedAt = performance.now();

    const map = new Map();
    for (const c of shapes.categories) map.set(c.categoryName, c.score);

    this._extractPose(matrix.data, settings);
    this._extractExpressions(map, settings);

    return true;
  }

  _countFps() {
    this.fpsCounter.frames += 1;
    const now = performance.now();
    const elapsed = now - this.fpsCounter.since;
    if (elapsed >= 1000) {
      this.fpsCounter.value = (this.fpsCounter.frames * 1000) / elapsed;
      this.fpsCounter.frames = 0;
      this.fpsCounter.since = now;
    }
  }

  /** 由 4×4 姿態矩陣取出頭部旋轉與位移 */
  _extractPose(data, settings) {
    this._matrix.fromArray(data);
    this._euler.setFromRotationMatrix(this._matrix, 'YXZ');

    const mirror = settings.mirror !== false;
    const sign = mirror ? -1 : 1;

    const angle = {
      x: this._euler.y * DEG * sign, // Yaw
      y: -this._euler.x * DEG, // Pitch：向上看為正
      z: this._euler.z * DEG * sign, // Roll
    };

    // 位移：矩陣第 4 欄，單位約為公分等級，正規化到 -1～1
    const pos = {
      x: (data[12] / 30) * sign,
      y: data[13] / 30,
      z: (data[14] + 50) / 40,
    };

    this._lastAngle = angle;
    this._lastPos = pos;

    const c = this.calibration;
    const dz = settings.deadZone ?? 0;

    this.raw.FaceAngleX = deadZone(angle.x - c.angleX, dz * 30);
    this.raw.FaceAngleY = deadZone(angle.y - c.angleY, dz * 30);
    this.raw.FaceAngleZ = deadZone(angle.z - c.angleZ, dz * 30);

    this.raw.FacePositionX = deadZone(pos.x - c.posX, dz);
    this.raw.FacePositionY = deadZone(pos.y - c.posY, dz);
    this.raw.FacePositionZ = deadZone(pos.z - c.posZ, dz);
  }

  /** 由 blendshape 分數換算出附錄 A-1 的表情類參數 */
  _extractExpressions(m, settings) {
    // MediaPipe 的 Left/Right 以影像座標為準；是否對調交由設定決定，
    // 因為「鏡像」與「模型的左右」兩種直覺會得到相反結果。
    const swap = settings.swapEyes === true;
    const L = swap ? 'Right' : 'Left';
    const R = swap ? 'Left' : 'Right';

    // ── 眼睛開闔 ──
    this.raw.EyeOpenLeft = 1 - clamp01(score(m, `eyeBlink${L}`) * 1.4);
    this.raw.EyeOpenRight = 1 - clamp01(score(m, `eyeBlink${R}`) * 1.4);

    // ── 視線 ──
    const gazeLX = score(m, `eyeLookOut${L}`) - score(m, `eyeLookIn${L}`);
    const gazeRX = score(m, `eyeLookIn${R}`) - score(m, `eyeLookOut${R}`);
    const gazeLY = score(m, `eyeLookUp${L}`) - score(m, `eyeLookDown${L}`);
    const gazeRY = score(m, `eyeLookUp${R}`) - score(m, `eyeLookDown${R}`);

    this.raw.EyeLeftX = clampSigned(gazeLX * 2);
    this.raw.EyeRightX = clampSigned(gazeRX * 2);
    this.raw.EyeLeftY = clampSigned(gazeLY * 2);
    this.raw.EyeRightY = clampSigned(gazeRY * 2);

    // 合併視線：VRM 的 lookAt 只接受單一 yaw/pitch
    const gazeSign = settings.mirror !== false ? -1 : 1;
    this.raw.EyeGazeX = clampSigned(((gazeLX + gazeRX) / 2) * 2 * gazeSign);
    this.raw.EyeGazeY = clampSigned(((gazeLY + gazeRY) / 2) * 2);

    // ── 眉毛 ──
    const browL = score(m, `browOuterUp${L}`) + score(m, 'browInnerUp') * 0.5 - score(m, `browDown${L}`);
    const browR = score(m, `browOuterUp${R}`) + score(m, 'browInnerUp') * 0.5 - score(m, `browDown${R}`);
    this.raw.BrowLeftY = clampSigned(browL * 1.5);
    this.raw.BrowRightY = clampSigned(browR * 1.5);
    this.raw.Brows = clampSigned(((browL + browR) / 2) * 1.5);

    // ── 嘴 ──
    this.raw.MouthOpen = clamp01(score(m, 'jawOpen') * 1.3);
    this.raw.MouthSmile = clamp01(
      ((score(m, 'mouthSmileLeft') + score(m, 'mouthSmileRight')) / 2) * 1.6
    );
    const mouthSign = settings.mirror !== false ? -1 : 1;
    this.raw.MouthX = clampSigned((score(m, 'mouthRight') - score(m, 'mouthLeft')) * 2 * mouthSign);

    // ── 僅部分來源可用者 ──
    this.raw.CheekPuff = clamp01(
      ((score(m, 'cheekPuff') ?? 0)) * 1.5
    );
    this.raw.TongueOut = 0; // webcam 不支援（規格 L-08）
  }

  /** 距離上次成功偵測的秒數 */
  get secondsSinceDetection() {
    return (performance.now() - this.detectedAt) / 1000;
  }

  get fps() {
    return this.fpsCounter.value;
  }

  dispose() {
    this.stop();
    this.landmarker?.close?.();
    this.landmarker = null;
  }
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function clampSigned(v) {
  return v < -1 ? -1 : v > 1 ? 1 : v;
}

function deadZone(v, threshold) {
  if (!threshold) return v;
  return Math.abs(v) < threshold ? 0 : v;
}
