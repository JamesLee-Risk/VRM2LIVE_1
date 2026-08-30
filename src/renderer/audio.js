/**
 * 麥克風語音口型追蹤 — FR-02-C。
 *
 * 只負責 Web Audio 接線與時序；母音判別的訊號處理全在 shared/lipsync.js，
 * 那一份是純函式且有獨立測試（scripts/test-dsp.mjs）。
 */
import {
  createMelBanks,
  melEnergies,
  spectrumToFeature,
  spectralCentroid,
  shapeVolume,
  VowelMatcher,
  VOWELS,
} from '../shared/lipsync.js';

const FFT_SIZE = 1024;
const MEL_BANDS = 24;

/** 校準時要蒐集的幀數（約 1 秒） */
const CALIBRATION_FRAMES = 30;

export class MicTracker {
  constructor({ log = () => {} } = {}) {
    this.log = log;
    this.ctx = null;
    this.stream = null;
    this.analyser = null;
    this.running = false;
    this.muted = false;

    /** 輸出參數，與 WebcamTracker 一樣由 app.js 併入輸入表 */
    this.raw = Object.create(null);

    this.banks = null;
    this.matcher = null;

    this._spectrum = null;
    this._waveform = null;

    /** 進行中的校準：{ vowel, frames: number[][] } */
    this.calibration = null;

    this.level = 0; // 供 UI 顯示的音量表
    this.silenceTimer = 0;
  }

  /** 列出可用麥克風（FR-02-40） */
  static async listMicrophones() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      return devices
        .filter((d) => d.kind === 'audioinput')
        .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `麥克風 ${i + 1}` }));
    } catch {
      return [];
    }
  }

  async start(deviceId = null) {
    await this.stop();

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        // 這三項必須關閉：它們是為了「讓人聽得舒服」而設計的，
        // 會壓縮動態範圍並改變頻譜形狀，正好破壞共振峰結構。
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
      video: false,
    });

    this.ctx = new AudioContext();
    // 部分瀏覽器啟動時 AudioContext 為 suspended，需明確恢復
    if (this.ctx.state === 'suspended') await this.ctx.resume();

    const source = this.ctx.createMediaStreamSource(this.stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = FFT_SIZE;
    // 一點點時域平滑可抑制逐幀抖動，但太高會讓子音的起始變鈍
    this.analyser.smoothingTimeConstant = 0.25;
    this.analyser.minDecibels = -100;
    this.analyser.maxDecibels = -10;
    source.connect(this.analyser);
    // 刻意不接到 destination，避免使用者聽見自己的回授

    this._spectrum = new Float32Array(this.analyser.frequencyBinCount);
    this._waveform = new Float32Array(this.analyser.fftSize);

    this.banks = createMelBanks(this.ctx.sampleRate, FFT_SIZE, MEL_BANDS);
    if (!this.matcher) {
      this.matcher = new VowelMatcher(this.banks);
    } else {
      // 取樣率可能與上次不同，頻帶表需重建
      this.matcher.banks = this.banks;
      this.matcher.resetTemplates();
    }

    this.running = true;
    this.log('info', `麥克風已啟動（${this.ctx.sampleRate} Hz）`);
  }

  async stop() {
    this.running = false;
    if (this.stream) {
      for (const t of this.stream.getTracks()) t.stop();
      this.stream = null;
    }
    if (this.ctx) {
      await this.ctx.close().catch(() => {});
      this.ctx = null;
    }
    this.analyser = null;
    this.level = 0;
    this._clearOutputs();
  }

  _clearOutputs() {
    for (const v of VOWELS) this.raw[`Voice${v.toUpperCase()}`] = 0;
    this.raw.VoiceVolume = 0;
    this.raw.VoiceFrequency = 0;
    this.raw.VoiceSilence = 1;
  }

  /** FR-02-47：靜音切換 */
  toggleMute() {
    this.muted = !this.muted;
    if (this.muted) this._clearOutputs();
    return this.muted;
  }

  /**
   * 推進一次分析。
   * @param {object} settings app_config.tracking.lipsync
   */
  tick(settings = {}) {
    if (!this.running || !this.analyser) return false;
    if (this.muted) {
      this._clearOutputs();
      return true;
    }

    this.analyser.getFloatFrequencyData(this._spectrum);
    this.analyser.getFloatTimeDomainData(this._waveform);

    // ── 音量 ──
    let sumSq = 0;
    for (let i = 0; i < this._waveform.length; i += 1) sumSq += this._waveform[i] ** 2;
    const rms = Math.sqrt(sumSq / this._waveform.length);
    this.level = rms;

    const volume = shapeVolume(rms, settings.volumeGain ?? 4, settings.volumeCutoff ?? 0.015);

    // ── 頻譜特徵 ──
    const mel = melEnergies(this._spectrum, this.banks);
    const feature = spectrumToFeature(mel);

    // ── 校準蒐集（FR-02-44）──
    if (this.calibration && volume > 0.05) {
      this.calibration.frames.push(feature);
      if (this.calibration.frames.length >= CALIBRATION_FRAMES) {
        this._finishCalibration();
      }
    }

    // ── 母音判別 ──
    const weights = this.matcher.match(feature);

    // 母音權重乘上音量包絡：不說話時嘴巴自然閉上。
    // softmax 已保證權重總和為 1，因此 FR-02-42（不會同時多個達到 1）成立。
    for (const v of VOWELS) {
      this.raw[`Voice${v.toUpperCase()}`] = weights[v] * volume;
    }

    this.raw.VoiceVolume = volume;
    this.raw.VoiceFrequency = Math.min(
      1,
      spectralCentroid(mel, this.banks) * (settings.frequencyGain ?? 1)
    );
    this.raw.VoiceSilence = volume > 0 ? 0 : 1;

    return true;
  }

  // ── 校準（FR-02-44）────────────────────────────────────

  /** 開始錄製某個母音；回傳 false 表示尚未啟動麥克風 */
  beginCalibration(vowel) {
    if (!this.running || !VOWELS.includes(vowel)) return false;
    this.calibration = { vowel, frames: [] };
    return true;
  }

  cancelCalibration() {
    this.calibration = null;
  }

  get calibrationProgress() {
    if (!this.calibration) return null;
    return {
      vowel: this.calibration.vowel,
      progress: this.calibration.frames.length / CALIBRATION_FRAMES,
    };
  }

  _finishCalibration() {
    const { vowel, frames } = this.calibration;
    this.calibration = null;
    if (frames.length === 0) return;

    // 取多幀平均以抑制單幀雜訊，再交由 matcher 正規化
    const dim = frames[0].length;
    const avg = new Array(dim).fill(0);
    for (const f of frames) {
      for (let i = 0; i < dim; i += 1) avg[i] += f[i] / frames.length;
    }

    this.matcher.setTemplate(vowel, avg);
    this.log('info', `母音 /${vowel}/ 校準完成（${frames.length} 幀）`);
    this.onCalibrated?.(vowel);
  }

  /** 匯出目前樣板供持久化 */
  exportTemplates() {
    if (!this.matcher) return null;
    const out = {};
    for (const v of VOWELS) out[v] = Array.from(this.matcher.templates[v]);
    return out;
  }

  /** 由設定檔還原樣板 */
  importTemplates(templates) {
    if (!this.matcher || !templates) return false;
    let applied = 0;
    for (const v of VOWELS) {
      if (Array.isArray(templates[v]) && templates[v].length) {
        this.matcher.templates[v] = templates[v].slice();
        applied += 1;
      }
    }
    if (applied) this.matcher._rebuild();
    return applied === VOWELS.length;
  }

  resetTemplates() {
    this.matcher?.resetTemplates();
  }

  dispose() {
    this.stop();
  }
}
