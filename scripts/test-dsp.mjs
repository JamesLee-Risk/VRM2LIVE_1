/**
 * 語音口型 DSP 測試 — 驗證 src/shared/lipsync.js。
 *
 * 這是純訊號處理的測試，不需要麥克風也不需要 Electron。
 *
 * 關鍵設計：測試訊號**不使用** synthesizeTemplate 產生，而是另外以共振器
 * 頻率響應（vocal tract filter）合成，並加入雜訊與整體增益變化。
 * 若兩者共用同一套公式，測試只會證明「自己等於自己」，毫無意義。
 *
 * 執行：node scripts/test-dsp.mjs
 */
import * as esbuild from 'esbuild';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpDir = path.join(root, 'build', '.test');
const bundle = path.join(tmpDir, 'lipsync.mjs');

await mkdir(tmpDir, { recursive: true });
await esbuild.build({
  entryPoints: [path.join(root, 'src/shared/lipsync.js')],
  bundle: true,
  format: 'esm',
  outfile: bundle,
  logLevel: 'silent',
});

const L = await import(pathToFileURL(bundle).href);

// ────────────────────────────────────────────────────────────────
// 測試訊號合成：二階共振器串接，與樣板的高斯模型是不同的數學形式
// ────────────────────────────────────────────────────────────────

const SAMPLE_RATE = 48000;
const FFT_SIZE = 1024;

/**
 * 以共振器頻率響應合成一段母音頻譜（回傳 dB 值）。
 * @param {{f1:number,f2:number}} formants
 * @param {number} gainDb  整體增益，用來確認比對不受音量影響
 * @param {number} noise   加入的隨機擾動量
 */
function synthesizeSpectrumDb(formants, { gainDb = 0, noise = 0, seed = 1 } = {}) {
  const bins = FFT_SIZE / 2;
  const binHz = SAMPLE_RATE / FFT_SIZE;
  const out = new Float32Array(bins);

  // 簡單的可重現亂數
  let s = seed;
  const rand = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff - 0.5;
  };

  // Q 值取真實語音的量級：共振峰頻寬約為中心頻率的 8–12%
  const F = [formants.f1, formants.f2, formants.f2 * 1.35, 3500];
  const Q = [8, 7, 6, 5];

  const mags = new Float32Array(bins);
  let peak = 0;

  for (let i = 0; i < bins; i += 1) {
    const f = Math.max(1, i * binHz);

    // 聲門源頻譜傾斜：-12 dB/oct
    let mag = 1 / (1 + (f / 200) ** 2) ** 0.5;

    // 聲道濾波器：二階共振器串接
    for (let k = 0; k < F.length; k += 1) {
      const r = f / F[k];
      const denom = Math.sqrt((1 - r * r) ** 2 + (r / Q[k]) ** 2);
      mag *= 1 / Math.max(denom, 1e-4);
    }

    mags[i] = mag;
    if (mag > peak) peak = mag;
  }

  // 正規化到 AnalyserNode 實際會輸出的範圍：峰值約 -25 dBFS、底噪 -100 dB
  for (let i = 0; i < bins; i += 1) {
    let db = 20 * Math.log10(Math.max(mags[i] / peak, 1e-9)) - 25 + gainDb;
    if (noise) db += rand() * noise;
    out[i] = Math.max(-100, Math.min(0, db));
  }

  return out;
}

// ────────────────────────────────────────────────────────────────
// 測試
// ────────────────────────────────────────────────────────────────

const banks = L.createMelBanks(SAMPLE_RATE, FFT_SIZE, 24);
const matcher = new L.VowelMatcher(banks);

const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  OK  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
};

console.log('\n語音口型 DSP 測試\n' + '='.repeat(60));

// ── 1. 五母音辨識 ──
console.log('\n[1] 母音辨識（測試訊號以共振器模型合成）');
let allCorrect = true;
const margins = [];

for (const v of L.VOWELS) {
  const spec = synthesizeSpectrumDb(L.VOWEL_FORMANTS[v], { noise: 1.5, seed: v.charCodeAt(0) });
  const mel = L.melEnergies(spec, banks);
  const norm = L.spectrumToFeature(mel);
  const w = matcher.match(norm);

  const ranked = Object.entries(w).sort((a, b) => b[1] - a[1]);
  const winner = ranked[0][0];
  const margin = ranked[0][1] - ranked[1][1];
  margins.push(margin);
  const correct = winner === v;
  if (!correct) allCorrect = false;

  record(
    `母音 /${v}/ → 判定 /${winner}/`,
    correct,
    `權重 ${ranked.map(([k, x]) => `${k}:${x.toFixed(2)}`).join(' ')}；領先 ${margin.toFixed(2)}`
  );
}
record('五母音全部辨識正確', allCorrect);

// ── 2. FR-02-42：不可同時多個母音達到 1 ──
console.log('\n[2] FR-02-42 母音權重約束');
let maxSum = 0;
let maxTwo = 0;
for (const v of L.VOWELS) {
  for (const gain of [-20, 0, 20]) {
    const spec = synthesizeSpectrumDb(L.VOWEL_FORMANTS[v], { gainDb: gain, noise: 3, seed: 7 });
    const w = matcher.match(L.spectrumToFeature(L.melEnergies(spec, banks)));
    const vals = Object.values(w).sort((a, b) => b - a);
    maxSum = Math.max(maxSum, vals.reduce((a, b) => a + b, 0));
    maxTwo = Math.max(maxTwo, vals[1]);
  }
}
record('權重總和恆為 1（softmax）', Math.abs(maxSum - 1) < 1e-6, `最大總和 ${maxSum.toFixed(6)}`);
record('次高權重不會同時達到 1', maxTwo < 0.5, `觀測到的最大次高值 ${maxTwo.toFixed(3)}`);

// ── 3. 音量無關性 ──
console.log('\n[3] 辨識結果不受音量影響');
let gainStable = true;
for (const v of L.VOWELS) {
  const winners = new Set();
  for (const gain of [-30, -15, 0, 15, 30]) {
    const spec = synthesizeSpectrumDb(L.VOWEL_FORMANTS[v], { gainDb: gain, seed: 3 });
    const w = matcher.match(L.spectrumToFeature(L.melEnergies(spec, banks)));
    winners.add(Object.entries(w).sort((a, b) => b[1] - a[1])[0][0]);
  }
  if (winners.size !== 1) gainStable = false;
}
record('增益變動 ±30 dB 下判定不變', gainStable);

// ── 4. 靜音處理 ──
console.log('\n[4] 靜音與噪音閘');
const silent = new Float32Array(FFT_SIZE / 2).fill(-100);
const silentNorm = L.spectrumToFeature(L.melEnergies(silent, banks));
record('全靜音頻譜轉出零向量', silentNorm.every((x) => x === 0));
record('噪音閘：低於門檻輸出 0', L.shapeVolume(0.01, 1, 0.02) === 0);
record('噪音閘：高於門檻線性伸展', L.shapeVolume(0.51, 1, 0.02) > 0.49 && L.shapeVolume(1, 1, 0.02) === 1);
record('音量增益生效', L.shapeVolume(0.1, 4, 0.02) > L.shapeVolume(0.1, 1, 0.02));

// ── 5. 校準覆寫 ──
console.log('\n[5] FR-02-44 錄音校準');
const fakeA = L.spectrumToFeature(
  L.melEnergies(synthesizeSpectrumDb(L.VOWEL_FORMANTS.i), banks)
);
matcher.setTemplate('a', fakeA);
const specI = synthesizeSpectrumDb(L.VOWEL_FORMANTS.i, { seed: 11 });
const wAfter = matcher.match(L.spectrumToFeature(L.melEnergies(specI, banks)));
record(
  '校準可覆寫樣板（把 /a/ 樣板換成 /i/ 後，/i/ 訊號應大幅提升 a 權重）',
  wAfter.a > 0.25,
  `a=${wAfter.a.toFixed(2)}`
);
matcher.resetTemplates();
const wReset = matcher.match(L.spectrumToFeature(L.melEnergies(specI, banks)));
record('重設樣板可還原', Object.entries(wReset).sort((a, b) => b[1] - a[1])[0][0] === 'i');

// ── 6. 頻譜重心 ──
console.log('\n[6] VoiceFrequency（頻譜重心）');
const centroidI = L.spectralCentroid(
  L.melEnergies(synthesizeSpectrumDb(L.VOWEL_FORMANTS.i), banks), banks
);
const centroidU = L.spectralCentroid(
  L.melEnergies(synthesizeSpectrumDb(L.VOWEL_FORMANTS.u), banks), banks
);
record(
  '/i/ 的頻譜重心高於 /u/（符合共振峰分佈）',
  centroidI > centroidU,
  `i=${centroidI.toFixed(3)} u=${centroidU.toFixed(3)}`
);

// ── 7. 說話者差異 ──
// 這是實務上最真實的考驗：不同性別、年齡的說話者共振峰頻率差異可達 ±15%，
// 樣板卻只有一組。若辨識在此崩潰，實際使用時就只有作者本人能用。
console.log('\n[7] 說話者共振峰差異容忍度');

/** 以指定的共振峰縮放比例測一輪辨識 */
function scoreSpeaker(scale, m = matcher) {
  let correct = 0;
  const detail = [];
  for (const v of L.VOWELS) {
    const f = L.VOWEL_FORMANTS[v];
    const spec = synthesizeSpectrumDb(
      { f1: f.f1 * scale, f2: f.f2 * scale },
      { noise: 2, seed: 23 }
    );
    const w = m.match(L.spectrumToFeature(L.melEnergies(spec, banks)));
    const winner = Object.entries(w).sort((a, b) => b[1] - a[1])[0][0];
    if (winner === v) correct += 1;
    else detail.push(`${v}→${winner}`);
  }
  return { correct, detail };
}

for (const scale of [0.92, 1.08]) {
  const { correct, detail } = scoreSpeaker(scale);
  record(
    `共振峰 ×${scale.toFixed(2)}（一般個體差異）`,
    correct >= 4,
    `${correct}/5 正確${detail.length ? `（誤判 ${detail.join(' ')}）` : ''}`
  );
}

// 極端偏移：預設樣板必然力有未逮，這是單一組樣板的物理極限而非程式缺陷。
// /u/(350,800) 與 /o/(500,900) 在共振峰空間中相鄰，+15% 會讓 /u/ 落到 /o/ 上。
const extreme = scoreSpeaker(1.15);
record(
  '共振峰 ×1.15（極端偏移）預設樣板尚可勉強運作',
  extreme.correct >= 3,
  `${extreme.correct}/5 正確（誤判 ${extreme.detail.join(' ')}）— 相鄰母音 u/o 混淆，需靠校準解決`
);

// FR-02-44 的存在理由：讓使用者用自己的聲音重建樣板。
// 這裡模擬「該說話者逐一錄下五個母音」後的結果。
const calibrated = new L.VowelMatcher(banks);
for (const v of L.VOWELS) {
  const f = L.VOWEL_FORMANTS[v];
  const spec = synthesizeSpectrumDb({ f1: f.f1 * 1.15, f2: f.f2 * 1.15 }, { noise: 1, seed: 5 });
  calibrated.setTemplate(v, L.spectrumToFeature(L.melEnergies(spec, banks)));
}
const after = scoreSpeaker(1.15, calibrated);
record(
  'FR-02-44 錄音校準後，極端偏移說話者恢復正常辨識',
  after.correct === 5,
  `校準前 ${extreme.correct}/5 → 校準後 ${after.correct}/5`
);

// ────────────────────────────────────────────────────────────────

await rm(tmpDir, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok);
console.log('\n' + '='.repeat(60));
console.log(`結果：${results.length - failed.length} / ${results.length} 通過`);
if (failed.length) {
  console.log('\n失敗項目：');
  for (const f of failed) console.log(`  - ${f.name}${f.detail ? ` (${f.detail})` : ''}`);
}
console.log(`平均辨識領先幅度：${(margins.reduce((a, b) => a + b, 0) / margins.length).toFixed(3)}\n`);

process.exit(failed.length ? 1 : 0);
