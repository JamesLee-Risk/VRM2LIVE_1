/**
 * 語音口型同步 — FR-02-C（FR-02-40 ～ FR-02-48）。
 *
 * 本模組只做訊號處理，不碰 Web Audio API，因此可獨立測試。
 * 麥克風的接線在 src/renderer/audio.js。
 *
 * 作法（與 uLipSync 同一路線）：
 *   1. 把 FFT 頻譜壓成一組 mel 頻帶能量，得到與音量無關的「音色向量」
 *   2. 與五個母音樣板做餘弦相似度比對
 *   3. 以 softmax 轉成權重，確保任一時刻只有一個母音佔主導
 *
 * 母音樣板不寫死魔術數字，而是由已知的共振峰（formant）頻率合成而來，
 * 這樣既可讀又便於調整；使用者另可用錄音校準覆寫（FR-02-44）。
 */

/** 五母音的前兩個共振峰（Hz）。數值取一般成人發音的常見範圍。 */
export const VOWEL_FORMANTS = {
  a: { f1: 800, f2: 1200 },
  i: { f1: 300, f2: 2300 },
  u: { f1: 350, f2: 800 },
  e: { f1: 500, f2: 1900 },
  o: { f1: 500, f2: 900 },
};

export const VOWELS = ['a', 'i', 'u', 'e', 'o'];

const MEL_MIN_HZ = 80;
const MEL_MAX_HZ = 4000;

const hzToMel = (hz) => 2595 * Math.log10(1 + hz / 700);
const melToHz = (mel) => 700 * (10 ** (mel / 2595) - 1);

/**
 * 建立 mel 頻帶對照表。
 *
 * @param {number} sampleRate
 * @param {number} fftSize      AnalyserNode 的 fftSize（bin 數為其一半）
 * @param {number} bandCount
 * @returns {{centers: number[], ranges: Array<[number, number]>, binHz: number}}
 */
export function createMelBanks(sampleRate, fftSize, bandCount = 24) {
  const binCount = fftSize / 2;
  const binHz = sampleRate / fftSize;

  const melLo = hzToMel(MEL_MIN_HZ);
  const melHi = hzToMel(MEL_MAX_HZ);

  const centers = [];
  const ranges = [];

  for (let i = 0; i < bandCount; i += 1) {
    // 每個頻帶取三角窗：以 [i, i+2] 為底、i+1 為峰
    const mLo = melLo + ((melHi - melLo) * i) / (bandCount + 1);
    const mHi = melLo + ((melHi - melLo) * (i + 2)) / (bandCount + 1);
    const mMid = (mLo + mHi) / 2;

    const binLo = Math.max(0, Math.floor(melToHz(mLo) / binHz));
    const binHi = Math.min(binCount - 1, Math.ceil(melToHz(mHi) / binHz));

    centers.push(melToHz(mMid));
    ranges.push([binLo, Math.max(binLo + 1, binHi)]);
  }

  return { centers, ranges, binHz };
}

/**
 * 由頻譜（dB 值，AnalyserNode.getFloatFrequencyData 的輸出）算出各 mel 頻帶能量。
 *
 * @param {Float32Array|number[]} spectrumDb
 * @param {ReturnType<createMelBanks>} banks
 * @param {number} floorDb  低於此值視為無訊號
 * @returns {number[]} 長度為 bandCount 的線性能量
 */
export function melEnergies(spectrumDb, banks, floorDb = -100) {
  const out = new Array(banks.ranges.length);

  for (let b = 0; b < banks.ranges.length; b += 1) {
    const [lo, hi] = banks.ranges[b];
    let sum = 0;
    let n = 0;
    for (let i = lo; i <= hi; i += 1) {
      const db = spectrumDb[i];
      if (db === undefined) continue;
      // 低於底噪者夾到底噪，而**不是**歸零。歸零會讓後續取對數時
      // 產生極端負值離群點，反而蓋掉真正的共振峰結構。
      const clamped = db < floorDb ? floorDb : db;
      // 功率域（10^(dB/10)）為 mel 濾波器組的標準作法
      sum += 10 ** (clamped / 10);
      n += 1;
    }
    out[b] = n > 0 ? sum / n : 0;
  }

  return out;
}

/**
 * 正規化成單位向量並移除整體亮度差異，使比對只看「音色形狀」而非音量。
 * 全零輸入回傳全零（呼叫端據此判定為靜音）。
 */
/** 保留的倒頻譜係數個數（不含 C0） */
const CEPSTRUM_COEFFS = 12;

/**
 * 把 mel 頻帶能量轉成可比對的特徵向量（實質上就是 MFCC）。
 *
 * 為什麼不能直接拿 log-mel 做餘弦相似度：所有母音的頻譜都被聲門源的
 * -12 dB/oct 傾斜主導，低頻能量遠高於高頻。這個「共同形狀」會佔滿相似度分數，
 * 使真正有區辨力的 F2 位置淪為微小擾動，結果就是不論說什麼都判成低頻母音 /u/。
 *
 * 解法是取對數後做 DCT 並**丟掉 C0**：
 *   - C0 代表整體音量，丟掉即自動獲得音量無關性
 *   - 其餘係數把頻譜形狀去相關化，共同的傾斜集中在 C1，
 *     不再攤平到每一維去稀釋共振峰資訊
 *
 * @param {number[]} melVec 各 mel 頻帶的功率
 * @returns {number[]} 單位長度的特徵向量；全靜音時回傳零向量
 */
export function spectrumToFeature(melVec, numCoeffs = CEPSTRUM_COEFFS) {
  const n = melVec.length;

  let max = 0;
  for (const v of melVec) if (v > max) max = v;
  if (max <= 1e-12) return new Array(numCoeffs).fill(0);

  // 動態範圍下限取「相對於本幀最大值」，安靜與大聲時才會得到相同的形狀
  const floor = max * 1e-5; // 相對 -50 dB
  const log = melVec.map((v) => Math.log(v > floor ? v : floor));

  // DCT-II，k 由 1 起算（跳過 C0）
  const out = new Array(numCoeffs);
  for (let k = 1; k <= numCoeffs; k += 1) {
    let s = 0;
    for (let i = 0; i < n; i += 1) {
      s += log[i] * Math.cos((Math.PI * k * (i + 0.5)) / n);
    }
    out[k - 1] = s;
  }

  let norm = 0;
  for (const v of out) norm += v * v;
  norm = Math.sqrt(norm);
  if (norm <= 1e-9) return new Array(numCoeffs).fill(0);

  return out.map((v) => v / norm);
}

/**
 * 由共振峰頻率合成母音樣板。
 *
 * 採串接式共振峰合成器（Klatt cascade）：聲門源頻譜傾斜 × 各共振峰的
 * 二階共振器頻率響應。這是聲道實際的物理行為，比高斯凸起近似準確得多——
 * 共振器的響應在高頻側衰減得比低頻側慢，這個不對稱正是區辨母音的關鍵。
 */
export function synthesizeTemplate(formants, banks) {
  // 聲門源頻譜傾斜（約 -12 dB/oct）
  const source = (hz) => 1 / Math.sqrt(1 + (hz / 200) ** 2);

  const F = [formants.f1, formants.f2, formants.f2 * 1.35, 3300];
  // 共振峰頻寬（Hz）。真實語音的頻寬大致固定，不隨中心頻率等比放大。
  const BW = [90, 110, 150, 220];

  const raw = banks.centers.map((hz) => {
    let mag = source(hz);
    for (let k = 0; k < F.length; k += 1) {
      const q = F[k] / BW[k];
      const r = hz / F[k];
      mag *= 1 / Math.max(Math.sqrt((1 - r * r) ** 2 + (r / q) ** 2), 1e-4);
    }
    return mag * mag; // 功率域，與 melEnergies 的輸出一致
  });

  return spectrumToFeature(raw);
}

/** 建立五個母音的預設樣板 */
export function defaultTemplates(banks) {
  const out = {};
  for (const v of VOWELS) out[v] = synthesizeTemplate(VOWEL_FORMANTS[v], banks);
  return out;
}

function cosine(a, b) {
  let dot = 0;
  for (let i = 0; i < a.length; i += 1) dot += a[i] * b[i];
  return dot; // 兩者皆為單位向量
}

/**
 * 母音比對器。
 */
function unitize(vec) {
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm);
  if (norm <= 1e-9) return null;
  return vec.map((v) => v / norm);
}

export class VowelMatcher {
  /**
   * @param {ReturnType<createMelBanks>} banks
   * @param {number} sharpness softmax 溫度倒數；越大越「贏者全拿」
   */
  constructor(banks, sharpness = 12) {
    this.banks = banks;
    this.sharpness = sharpness;
    this.templates = defaultTemplates(banks);
    this._rebuild();
  }

  /**
   * 由原始樣板算出「區辨向量」。
   *
   * 直接拿原始樣板做餘弦比對會失敗：五個母音的頻譜有大量共同成分
   * （低頻能量遠高於高頻），使得低頻型的 /u/ 樣板與**每一個**母音都高度相似，
   * 結果不論說什麼都判成 /u/。
   *
   * 解法是先減去五個樣板的平均，讓每個樣板只保留「此母音與平均母音的差異」，
   * 比對時對輸入做同樣處理。如此比較的是區辨方向，而非共同的頻譜輪廓。
   */
  _rebuild() {
    const vecs = VOWELS.map((v) => this.templates[v]);
    const dim = vecs[0].length;

    this.mean = new Array(dim).fill(0);
    for (const vec of vecs) {
      for (let i = 0; i < dim; i += 1) this.mean[i] += vec[i] / vecs.length;
    }

    this.discriminative = {};
    for (const v of VOWELS) {
      const centered = this.templates[v].map((x, i) => x - this.mean[i]);
      this.discriminative[v] = unitize(centered) ?? new Array(dim).fill(0);
    }
  }

  /** 以錄製到的特徵向量覆寫某個母音的樣板（FR-02-44） */
  setTemplate(vowel, featureVec) {
    if (!VOWELS.includes(vowel)) return;
    this.templates[vowel] = featureVec.slice();
    this._rebuild();
  }

  resetTemplates() {
    this.templates = defaultTemplates(this.banks);
    this._rebuild();
  }

  /**
   * @param {number[]} feature 由 spectrumToFeature 得到的特徵向量
   * @returns {{a:number,i:number,u:number,e:number,o:number}} 權重，總和為 1
   *
   * FR-02-42：以 softmax 正規化，總和恆為 1，因此不可能有兩個母音同時到 1。
   */
  match(feature) {
    const centered = unitize(feature.map((x, i) => x - this.mean[i]));

    // 靜音（零向量）時不做判定，回傳均等權重；呼叫端會再乘上音量而歸零
    if (!centered || feature.every((x) => x === 0)) {
      const flat = {};
      for (const v of VOWELS) flat[v] = 1 / VOWELS.length;
      return flat;
    }

    const scores = VOWELS.map((v) => cosine(centered, this.discriminative[v]));
    const max = Math.max(...scores);
    const exps = scores.map((s) => Math.exp(this.sharpness * (s - max)));
    const sum = exps.reduce((a, b) => a + b, 0);

    const out = {};
    VOWELS.forEach((v, i) => {
      out[v] = exps[i] / sum;
    });
    return out;
  }
}

/**
 * 由頻譜算出頻譜重心（spectral centroid），正規化為 0–1。
 * 對應輸出參數 VoiceFrequency。
 */
export function spectralCentroid(melVec, banks) {
  let max = 0;
  for (const v of melVec) if (v > max) max = v;
  if (max <= 1e-12) return 0;

  // 以對數（感知）域加權，而非線性功率。線性功率會被 F1 完全壓過——
  // 由於聲門源的 -12 dB/oct 傾斜，任何母音的低頻能量都比高頻高 30 dB 以上，
  // 導致 /i/ 與 /u/ 的重心幾乎相同，失去做為 VoiceFrequency 的意義。
  const floorDb = -50;
  let num = 0;
  let den = 0;
  for (let i = 0; i < melVec.length; i += 1) {
    const db = 10 * Math.log10(Math.max(melVec[i] / max, 1e-9));
    const w = Math.max(0, db - floorDb); // 相對 -50 dB 以下不計
    num += w * banks.centers[i];
    den += w;
  }
  if (den <= 1e-9) return 0;

  const hz = num / den;
  return Math.min(1, Math.max(0, (hz - MEL_MIN_HZ) / (MEL_MAX_HZ - MEL_MIN_HZ)));
}

/**
 * 把原始音量套上增益與噪音閘（FR-02-43）。
 *
 * @param {number} rms      0–1 的原始均方根音量
 * @param {number} gain     音量增益
 * @param {number} cutoff   噪音閘門檻；低於此值輸出 0
 * @returns {number} 0–1
 */
export function shapeVolume(rms, gain = 1, cutoff = 0.02) {
  const boosted = rms * gain;
  if (boosted <= cutoff) return 0;
  // 扣掉門檻後重新伸展至 0–1，避免剛過門檻時數值突跳
  return Math.min(1, (boosted - cutoff) / (1 - cutoff));
}
