/**
 * Webcam 身體與手部追蹤 — FR-02-D。
 *
 * 與 tracker.js 共用**同一個** <video> 元素與同一份攝影機串流：
 * 開啟半身／全身模式不會再開一次攝影機，也不會影響臉部追蹤的取樣。
 *
 * ─── 隱私（FR-02-20 / NFR-S-02）───────────────────────────────
 * 同 tracker.js：影像只在記憶體中交給 MediaPipe，不繪製、不顯示、不落地。
 * 地標資料僅存在於記憶體並直接餵給解算器，不寫檔也不外傳。
 *
 * 骨骼求解本身在 shared/bodysolver.js，本檔只負責「取得地標」。
 */
import { PoseLandmarker, HandLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';

/** 姿態模型精度二選一（FR-02-71） */
const POSE_MODELS = {
  lite: './pose_landmarker_lite.task',
  full: './pose_landmarker_full.task',
};

/** 手腕地標索引，用於把偵測到的手歸屬給左右（FR-02-73） */
const POSE_LEFT_WRIST = 15;
const POSE_RIGHT_WRIST = 16;

export class BodyTracker {
  constructor({ log = () => {} } = {}) {
    this.log = log;
    this.pose = null;
    this.hands = null;
    this.quality = null;
    this.handsEnabled = true;

    /** 最近一次成功的取樣，供解算器使用 */
    this.sample = null;
    this.lastVideoTime = -1;
    this.detectedAt = 0;

    this.fpsCounter = { frames: 0, since: performance.now(), value: 0 };
    this._loading = null;
  }

  get ready() {
    return Boolean(this.pose);
  }

  /**
   * 載入姿態與手部模型。首次啟用時才呼叫，載入後常駐（NFR-P-11）。
   * @param {{quality?: 'lite'|'full', hands?: boolean}} opts
   */
  async init({ quality = 'lite', hands = true } = {}) {
    this.handsEnabled = hands;
    if (this.pose && this.quality === quality) return;
    if (this._loading) return this._loading;

    this._loading = this._load(quality).finally(() => {
      this._loading = null;
    });
    return this._loading;
  }

  async _load(quality) {
    const fileset = await FilesetResolver.forVisionTasks('./mediapipe-wasm');

    // 切換精度時必須先關掉舊的，否則兩份模型會同時佔用 GPU 記憶體
    if (this.pose) {
      this.pose.close?.();
      this.pose = null;
    }

    try {
      this.pose = await PoseLandmarker.createFromOptions(fileset, {
        baseOptions: {
          modelAssetPath: POSE_MODELS[quality] ?? POSE_MODELS.lite,
          delegate: 'GPU',
        },
        runningMode: 'VIDEO',
        numPoses: 1, // 同時僅支援 1 人（規格 L-26）
        minPoseDetectionConfidence: 0.5,
        minPosePresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
        outputSegmentationMasks: false,
      });
      this.quality = quality;
    } catch (err) {
      throw new Error(`姿態模型載入失敗（${quality}）：${err.message}。若為首次使用，請先執行 npm run fetch-assets`);
    }

    if (!this.hands) {
      try {
        this.hands = await HandLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: './hand_landmarker.task', delegate: 'GPU' },
          runningMode: 'VIDEO',
          numHands: 2, // 最多 2 隻（規格 L-26）
          minHandDetectionConfidence: 0.5,
          minHandPresenceConfidence: 0.5,
          minTrackingConfidence: 0.5,
        });
      } catch (err) {
        // 手部模型缺席不應讓整個身體追蹤失效，退化為無手指
        this.log('warn', `手部模型載入失敗，手指追蹤停用：${err.message}`);
        this.hands = null;
      }
    }

    this.log('info', `身體追蹤引擎已就緒（精度：${quality}${this.hands ? '，含手指' : '，無手指'}）`);
  }

  /**
   * 推進一次偵測。應以身體追蹤 FPS 呼叫（FR-02-70），與臉部取樣分開。
   * @param {HTMLVideoElement} video 與臉部追蹤共用的來源
   * @param {{mirror?: boolean, parts?: object}} settings
   * @returns {boolean} 本次是否產生新結果
   */
  tick(video, settings = {}) {
    if (!this.pose || !video || video.readyState < 2) return false;
    if (video.currentTime === this.lastVideoTime) return false;
    this.lastVideoTime = video.currentTime;

    let poseResult;
    try {
      poseResult = this.pose.detectForVideo(video, performance.now());
    } catch (err) {
      this.log('warn', `姿態偵測失敗：${err.message}`);
      return false;
    }

    this._countFps();

    const world = poseResult?.worldLandmarks?.[0];
    const image = poseResult?.landmarks?.[0];
    if (!world || !image) {
      this.sample = null;
      return true;
    }

    const sample = {
      pose: world,
      hands: { left: null, right: null },
      mirror: settings.mirror !== false,
    };

    if (this.hands && this.handsEnabled && settings.parts?.hands !== false) {
      this._detectHands(video, image, sample);
    }

    this.sample = sample;
    this.detectedAt = performance.now();
    return true;
  }

  /**
   * 手部偵測與左右歸屬。
   *
   * **不使用** MediaPipe 回報的 handedness：那個標籤以「輸入影像已鏡像」為前提，
   * 而我們餵進去的是未鏡像的原始串流，直接採信會讓左右手完全顛倒（FR-02-73）。
   * 改以手腕地標與姿態地標的距離就近歸屬，這與影像是否鏡像無關。
   */
  _detectHands(video, poseImage, sample) {
    let result;
    try {
      result = this.hands.detectForVideo(video, performance.now());
    } catch (err) {
      this.log('warn', `手部偵測失敗：${err.message}`);
      return;
    }

    const list = result?.worldLandmarks ?? [];
    const image = result?.landmarks ?? [];
    if (!list.length) return;

    const anchors = {
      left: poseImage[POSE_LEFT_WRIST],
      right: poseImage[POSE_RIGHT_WRIST],
    };

    // 逐手算出「離哪一側手腕比較近」，再以差距最明顯者優先認領，
    // 避免雙手交疊時兩隻手都被判給同一側
    const claims = [];
    for (let i = 0; i < list.length; i += 1) {
      const wrist = image[i]?.[0];
      if (!wrist) continue;
      const dl = dist2(wrist, anchors.left);
      const dr = dist2(wrist, anchors.right);
      claims.push({ index: i, side: dl <= dr ? 'left' : 'right', margin: Math.abs(dl - dr) });
    }
    claims.sort((a, b) => b.margin - a.margin);

    for (const c of claims) {
      const side = sample.hands[c.side] ? other(c.side) : c.side;
      if (sample.hands[side]) continue;
      sample.hands[side] = list[c.index];
    }
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

  get fps() {
    return this.fpsCounter.value;
  }

  /** 停止取樣但保留模型於記憶體，以利快速再啟用（NFR-P-11） */
  suspend() {
    this.sample = null;
    this.lastVideoTime = -1;
    this.fpsCounter.value = 0;
  }

  dispose() {
    this.pose?.close?.();
    this.hands?.close?.();
    this.pose = null;
    this.hands = null;
    this.quality = null;
    this.sample = null;
  }
}

function dist2(a, b) {
  if (!a || !b) return Number.POSITIVE_INFINITY;
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

function other(side) {
  return side === 'left' ? 'right' : 'left';
}
