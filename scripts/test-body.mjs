/**
 * 身體追蹤解算測試 — 驗證 src/shared/bodysolver.js（FR-02-D）。
 *
 * 純幾何測試：不需攝影機、不需 Electron、不需 VRM 模型。
 * 骨架與地標都在此合成，且**刻意用與解算器不同的方式**驗證結果——
 * 解算器輸出的是逐骨骼的「局部四元數」，測試則以正向運動學把整條鏈重新組回
 * 世界方向再比對。若兩邊共用同一套公式，測到的只會是「自己等於自己」。
 *
 * 執行：node scripts/test-body.mjs
 */
import * as esbuild from 'esbuild';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpDir = path.join(root, 'build', '.test-body');
const bundle = path.join(tmpDir, 'bodysolver.mjs');

await mkdir(tmpDir, { recursive: true });
await esbuild.build({
  entryPoints: [path.join(root, 'src/shared/bodysolver.js')],
  bundle: true,
  format: 'esm',
  outfile: bundle,
  logLevel: 'silent',
});

const B = await import(pathToFileURL(bundle).href);
const THREE = await import('three');

const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  OK  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
};

const V = (x, y, z) => new THREE.Vector3(x, y, z);

// ────────────────────────────────────────────────────────────────
// 合成骨架
// ────────────────────────────────────────────────────────────────

/**
 * 一副 T-pose 骨架的節點位置（VRM 1.0 朝向：角色左手在 +X、正面朝 +Z）。
 * 座標大致取自真人比例，單位公尺。
 */
function baseSkeleton() {
  const n = {
    hips: [V(0, 0.95, 0), null],
    spine: [V(0, 1.05, 0), 'hips'],
    chest: [V(0, 1.18, 0), 'spine'],
    upperChest: [V(0, 1.3, 0), 'chest'],
    neck: [V(0, 1.42, 0), 'upperChest'],
    head: [V(0, 1.5, 0), 'neck'],
  };

  for (const side of ['left', 'right']) {
    const s = side === 'left' ? 1 : -1;
    const S = (name, v, parent) => {
      n[side + name] = [V(v[0] * s, v[1], v[2]), parent === null ? null : side + parent];
    };
    n[side + 'Shoulder'] = [V(0.05 * s, 1.38, 0), 'upperChest'];
    S('UpperArm', [0.15, 1.38, 0], 'Shoulder');
    S('LowerArm', [0.42, 1.38, 0], 'UpperArm');
    S('Hand', [0.66, 1.38, 0], 'LowerArm');

    // 手指：沿 +X 向外，以 z 分開五指（掌面朝下）
    const fingers = [
      ['Thumb', ['Metacarpal', 'Proximal', 'Distal'], 0.05, -0.02],
      ['Index', ['Proximal', 'Intermediate', 'Distal'], 0.03, 0],
      ['Middle', ['Proximal', 'Intermediate', 'Distal'], 0.01, 0],
      ['Ring', ['Proximal', 'Intermediate', 'Distal'], -0.01, 0],
      ['Little', ['Proximal', 'Intermediate', 'Distal'], -0.03, 0],
    ];
    for (const [finger, joints, z, dy] of fingers) {
      let parent = 'Hand';
      let x = 0.7;
      for (const j of joints) {
        S(finger + j, [x, 1.38 + dy, z], parent);
        parent = finger + j;
        x += 0.03;
      }
    }

    S('UpperLeg', [0.09, 0.9, 0], null);
    n[side + 'UpperLeg'][1] = 'hips';
    S('LowerLeg', [0.09, 0.5, 0], 'UpperLeg');
    S('Foot', [0.09, 0.08, 0], 'LowerLeg');
    S('Toes', [0.09, 0.04, 0.12], 'Foot');
  }
  return n;
}

/** @param {(name:string)=>boolean} [filter] 只保留通過篩選的骨骼，用於測試退化路徑 */
function makeInfo(skeleton, { rotate180 = false, filter = null } = {}) {
  const info = new Map();
  for (const [bone, [pos, parent]] of Object.entries(skeleton)) {
    if (filter && !filter(bone)) continue;
    // VRM 0.x 的預設朝向與 1.0 差 180 度。轉一圈就能驗證
    // 「基底自模型量測」是否真的成立（FR-02-65）
    const p = rotate180 ? V(-pos.x, pos.y, -pos.z) : pos.clone();
    // 被濾掉的父骨骼要往上接，模擬 three-vrm 的實際階層
    let par = parent;
    while (par && filter && !filter(par)) par = skeleton[par][1];
    info.set(bone, { pos: p, parent: par });
  }
  return info;
}

const rigA = B.buildRig(makeInfo(baseSkeleton()));
const rigB = B.buildRig(makeInfo(baseSkeleton(), { rotate180: true }));

// ────────────────────────────────────────────────────────────────
// 驗證工具：正向運動學
// ────────────────────────────────────────────────────────────────

/** 把解算出的局部四元數沿鏈組回世界旋轉，再轉出骨節的世界方向 */
function worldDir(rig, bones, bone) {
  const chain = [];
  for (let b = bone; b; b = rig.rest.get(b)?.parent ?? null) chain.unshift(b);
  const q = new THREE.Quaternion();
  for (const b of chain) {
    if (bones[b]) q.multiply(new THREE.Quaternion().fromArray(bones[b]));
  }
  return rig.rest.get(bone).dir.clone().applyQuaternion(q);
}

const close = (a, b, eps = 0.02) => Math.abs(a - b) <= eps;
const vecClose = (v, x, y, z, eps = 0.05) =>
  close(v.x, x, eps) && close(v.y, y, eps) && close(v.z, z, eps);

// ────────────────────────────────────────────────────────────────
// 合成地標
// ────────────────────────────────────────────────────────────────

const LM = (x, y, z) => ({ x, y, z });

/**
 * 一組站姿地標（MediaPipe 世界座標：x 向影像右、y 向下、z 越小越近鏡頭）。
 * 使用者面向鏡頭，因此使用者的左半身出現在影像右側，x 為正。
 */
function standingPose({ leftArmUp = false, rightArmUp = false, crouch = 0 } = {}) {
  const p = new Array(33).fill(null).map(() => LM(0, 0, 0));
  p[B.PL.LEFT_SHOULDER] = LM(0.18, -0.55 + crouch, 0);
  p[B.PL.RIGHT_SHOULDER] = LM(-0.18, -0.55 + crouch, 0);
  p[B.PL.LEFT_HIP] = LM(0.1, 0, 0);
  p[B.PL.RIGHT_HIP] = LM(-0.1, 0, 0);

  p[B.PL.LEFT_ELBOW] = leftArmUp ? LM(0.2, -0.8, 0) : LM(0.22, -0.28, 0);
  p[B.PL.LEFT_WRIST] = leftArmUp ? LM(0.21, -1.05, 0) : LM(0.24, -0.02, 0);
  p[B.PL.LEFT_INDEX] = leftArmUp ? LM(0.21, -1.13, 0) : LM(0.25, 0.06, 0);

  p[B.PL.RIGHT_ELBOW] = rightArmUp ? LM(-0.2, -0.8, 0) : LM(-0.22, -0.28, 0);
  p[B.PL.RIGHT_WRIST] = rightArmUp ? LM(-0.21, -1.05, 0) : LM(-0.24, -0.02, 0);
  p[B.PL.RIGHT_INDEX] = rightArmUp ? LM(-0.21, -1.13, 0) : LM(-0.25, 0.06, 0);

  p[B.PL.LEFT_KNEE] = LM(0.1, 0.42, 0);
  p[B.PL.RIGHT_KNEE] = LM(-0.1, 0.42, 0);
  p[B.PL.LEFT_ANKLE] = LM(0.1, 0.85, 0);
  p[B.PL.RIGHT_ANKLE] = LM(-0.1, 0.85, 0);
  p[B.PL.LEFT_FOOT_INDEX] = LM(0.1, 0.9, -0.15);
  p[B.PL.RIGHT_FOOT_INDEX] = LM(-0.1, 0.9, -0.15);
  return p;
}

/**
 * 一隻攤平的手（21 點世界地標，腕為原點）。curl 為 0 時手指伸直，
 * 為 1 時彎向掌心。手掌沿 +x 伸出、掌面朝下。
 */
function handLandmarks({ curl = 0 } = {}) {
  const h = new Array(21).fill(null).map(() => LM(0, 0, 0));
  h[0] = LM(0, 0, 0);
  const spread = { 1: -0.035, 5: -0.02, 9: 0, 13: 0.018, 17: 0.035 };
  const chains = [[1, 2, 3, 4], [5, 6, 7, 8], [9, 10, 11, 12], [13, 14, 15, 16], [17, 18, 19, 20]];
  for (const chain of chains) {
    const z = spread[chain[0]];
    let x = 0.06;
    let y = 0;
    for (let i = 0; i < chain.length; i += 1) {
      h[chain[i]] = LM(x, y, z);
      // 彎曲時指節往下（+y 為影像下方＝掌心方向）
      x += 0.028 * (1 - 0.7 * curl);
      y += 0.028 * curl;
    }
  }
  return h;
}

function cfg(patch = {}) {
  return {
    mode: 'half',
    fps: 30,
    smooth: 0,
    fadeSeconds: 0.05,
    handTwist: 0.5,
    parts: { torso: true, shoulders: true, arms: true, hands: true, legs: true, rootMotion: false },
    sensitivity: { torso: 1, shoulders: 1, arms: 1, hands: 1, fingers: 1, legs: 1, rootMotion: 1 },
    lostBehavior: 'freeze',
    lostResetSeconds: 1.5,
    ...patch,
  };
}

/** 跑數幀讓淡接權重升滿，回傳最後一幀的結果 */
function run(rig, sample, c, frames = 8) {
  const solver = new B.BodySolver();
  solver.setRig(rig);
  let out = null;
  for (let i = 0; i < frames; i += 1) out = solver.update(1 / 30, sample, c, true);
  return { out, solver };
}

console.log('\n身體追蹤解算測試（FR-02-D）\n' + '='.repeat(60));

// ── 1. 骨架量測（FR-02-65）──
console.log('\n[1] 骨架量測：基底自模型量出，不硬編碼軸向');

record('VRM 1.0 朝向：X 軸指向角色左方 (+X)', vecClose(rigA.basis.x, 1, 0, 0));
record('VRM 1.0 朝向：Y 軸向上 (+Y)', vecClose(rigA.basis.y, 0, 1, 0));
record('VRM 1.0 朝向：Z 軸為正面 (+Z)', vecClose(rigA.basis.z, 0, 0, 1));
record('VRM 0.x 朝向：X 軸自動翻為 -X', vecClose(rigB.basis.x, -1, 0, 0));
record('VRM 0.x 朝向：Z 軸自動翻為 -Z', vecClose(rigB.basis.z, 0, 0, -1));
record('基底為右手系（X × Y = Z）',
  vecClose(new THREE.Vector3().crossVectors(rigA.basis.x, rigA.basis.y), 0, 0, 1));

record('骨節方向：左上臂沿 +X', vecClose(rigA.rest.get('leftUpperArm').dir, 1, 0, 0));
record('骨節方向：hips 朝上', vecClose(rigA.rest.get('hips').dir, 0, 1, 0));
record('骨節方向：右上臂沿 -X', vecClose(rigA.rest.get('rightUpperArm').dir, -1, 0, 0));

const noToes = B.buildRig(makeInfo(baseSkeleton(), { filter: (b) => !b.endsWith('Toes') }));
record('缺腳趾骨時腳掌朝向正面而非地面（FR-02-77）',
  vecClose(noToes.rest.get('leftFoot').dir, 0, 0, 1));
record('缺必要骨骼時 buildRig 回傳 null',
  B.buildRig(makeInfo(baseSkeleton(), { filter: (b) => b !== 'hips' })) === null);

// ── 2. 鏡像與左右歸屬（FR-02-74）──
//
// 身體側的鏡射方向必須與臉部追蹤同向，否則會出現「頭轉左、身體轉右」。
// 對齊的常數是 bodysolver.js 的 INVERT_BODY_MIRROR，因此
// `mirror: true`（預設）在身體側解算出來的是「不翻左右」。
console.log('\n[2] 鏡像：身體的左右歸屬與臉部追蹤同向');

const upMirror = run(rigA, { pose: standingPose({ leftArmUp: true }), hands: {}, mirror: true }, cfg());
const dirLeftArm = worldDir(rigA, upMirror.out.bones, 'leftUpperArm');
const dirRightArm = worldDir(rigA, upMirror.out.bones, 'rightUpperArm');
record('鏡像開啟（預設）：使用者舉左手 → 模型抬起左上臂',
  dirLeftArm.y > 0.9, `左上臂方向 y=${dirLeftArm.y.toFixed(3)}`);
record('鏡像開啟：模型右上臂維持垂下',
  dirRightArm.y < -0.5, `右上臂方向 y=${dirRightArm.y.toFixed(3)}`);

const upPlain = run(rigA, { pose: standingPose({ leftArmUp: true }), hands: {}, mirror: false }, cfg());
record('鏡像關閉：改由模型的右上臂抬起（左右對調）',
  worldDir(rigA, upPlain.out.bones, 'rightUpperArm').y > 0.9);
record('鏡像開關確實改變左右歸屬，不是兩邊都一樣',
  worldDir(rigA, upPlain.out.bones, 'leftUpperArm').y < -0.5);

const upVrm0 = run(rigB, { pose: standingPose({ leftArmUp: true }), hands: {}, mirror: true }, cfg());
record('VRM 0.x 朝向的模型結果一致（不受預設朝向影響）',
  worldDir(rigB, upVrm0.out.bones, 'leftUpperArm').y > 0.9);

// ── 3. 前臂與手肘 ──
console.log('\n[3] 肢段鏈：前臂承接上臂之後仍指向手腕');

const armChain = run(rigA, { pose: standingPose({ leftArmUp: true }), hands: {}, mirror: true }, cfg());
record('前臂世界方向朝上（局部四元數已扣除父骨骼旋轉）',
  worldDir(rigA, armChain.out.bones, 'leftLowerArm').y > 0.9);

// ── 4. 頭頸不得被身體追蹤驅動（FR-02-67）──
console.log('\n[4] 分工：頭、頸、眼球一律留給臉部追蹤');

const owned = ['head', 'neck', 'leftEye', 'rightEye'];
record('輸出不含頭／頸／眼球骨骼',
  owned.every((b) => !(b in armChain.out.bones)),
  `實際輸出 ${Object.keys(armChain.out.bones).length} 根骨骼`);

// ── 5. 模式與逐部位開關（FR-02-63、FR-02-69）──
console.log('\n[5] 模式與逐部位開關');

const half = run(rigA, { pose: standingPose(), hands: {}, mirror: true }, cfg({ mode: 'half' }));
const full = run(rigA, { pose: standingPose(), hands: {}, mirror: true }, cfg({ mode: 'full' }));
record('half 模式不驅動腿部骨骼', !('leftUpperLeg' in half.out.bones));
record('full 模式驅動腿部骨骼', 'leftUpperLeg' in full.out.bones && 'leftFoot' in full.out.bones);
record('half 模式仍驅動軀幹與手臂',
  'spine' in half.out.bones && 'leftUpperArm' in half.out.bones);

const noLegs = run(rigA, { pose: standingPose(), hands: {}, mirror: true },
  cfg({ mode: 'full', parts: { ...cfg().parts, legs: false } }));
record('關閉腿部後 full 模式不再輸出腿骨', !('leftUpperLeg' in noLegs.out.bones));

const zeroSens = run(rigA, { pose: standingPose({ leftArmUp: true }), hands: {}, mirror: true },
  cfg({ sensitivity: { ...cfg().sensitivity, arms: 0 } }));
const zq = new THREE.Quaternion().fromArray(zeroSens.out.bones.rightUpperArm);
record('靈敏度 0 時該部位維持無旋轉', close(Math.abs(zq.w), 1, 0.01), `w=${zq.w.toFixed(4)}`);

// ── 6. 手指（FR-02-62）──
console.log('\n[6] 手指：15 根骨骼與彎曲方向');

const openHand = { pose: standingPose(), hands: { left: handLandmarks({ curl: 0 }) }, mirror: true };
const curlHand = { pose: standingPose(), hands: { left: handLandmarks({ curl: 1 }) }, mirror: true };
const openOut = run(rigA, openHand, cfg()).out;
const curlOut = run(rigA, curlHand, cfg()).out;

const fingerCount = Object.keys(openOut.bones).filter((b) => b.startsWith('left')
  && /Thumb|Index|Middle|Ring|Little/.test(b)).length;
record('單手輸出 15 根手指骨骼', fingerCount === 15, `實際 ${fingerCount}`);

const openIdx = worldDir(rigA, openOut.bones, 'leftIndexProximal');
const curlIdx = worldDir(rigA, curlOut.bones, 'leftIndexProximal');
record('手指伸直時食指沿手掌方向', openIdx.x > 0.9, `x=${openIdx.x.toFixed(3)}`);
record('手指彎曲時食指轉向掌心（-Y）',
  curlIdx.y < -0.4 && curlIdx.y < openIdx.y - 0.3,
  `伸直 y=${openIdx.y.toFixed(3)} → 彎曲 y=${curlIdx.y.toFixed(3)}`);

const noHands = run(rigA, openHand, cfg({ parts: { ...cfg().parts, hands: false } })).out;
record('關閉手指後不輸出手指骨骼',
  !Object.keys(noHands.bones).some((b) => b.includes('IndexProximal')));

const mirroredHand = run(rigA,
  { pose: standingPose(), hands: { left: handLandmarks({ curl: 1 }) }, mirror: false }, cfg()).out;
record('鏡像關閉時使用者左手的手指改為驅動模型右手',
  'rightIndexProximal' in mirroredHand.bones && !('leftIndexProximal' in mirroredHand.bones));

// ── 7. 退化（FR-02-77、NFR-C-05）──
console.log('\n[7] 缺骨骼模型的退化');

const lean = standingPose();
lean[B.PL.LEFT_SHOULDER] = LM(0.16, -0.62, 0);
lean[B.PL.RIGHT_SHOULDER] = LM(-0.2, -0.48, 0);

const rigLean = B.buildRig(makeInfo(baseSkeleton()));
const leanOut = run(rigLean, { pose: lean, hands: {}, mirror: false }, cfg()).out;
const chestDir = worldDir(rigLean, leanOut.bones, 'chest');

const rigMin = B.buildRig(makeInfo(baseSkeleton(), {
  filter: (b) => b !== 'upperChest' && !b.endsWith('Shoulder'),
}));
record('缺 upperChest 與肩膀時仍可建立骨架', rigMin !== null);
const minOut = run(rigMin, { pose: lean, hands: {}, mirror: false }, cfg()).out;
record('缺骨骼時不丟例外且仍驅動胸骨', Boolean(minOut) && 'chest' in minOut.bones);
record('缺席骨骼不會出現在輸出中',
  !('upperChest' in minOut.bones) && !('leftShoulder' in minOut.bones));
const minChest = worldDir(rigMin, minOut.bones, 'chest');
record('胸骨傾斜方向與完整骨架一致（份額併入現存父骨骼）',
  minChest.dot(chestDir) > 0.9, `內積 ${minChest.dot(chestDir).toFixed(3)}`);

// ── 8. 淡接與追蹤遺失（FR-02-68、FR-02-75）──
console.log('\n[8] 淡接與追蹤遺失');

const sample = { pose: standingPose(), hands: {}, mirror: true };
const fadeSolver = new B.BodySolver();
fadeSolver.setRig(rigA);
const c = cfg({ fadeSeconds: 0.5 });
const w1 = fadeSolver.update(0.1, sample, c, true).weight;
record('啟用後權重自 0 漸增', w1 > 0.15 && w1 < 0.25, `0.1 秒後 weight=${w1.toFixed(3)}`);
for (let i = 0; i < 10; i += 1) fadeSolver.update(0.1, sample, c, true);
record('淡接時間內權重升到 1', close(fadeSolver.weight, 1, 0.001));

const frozen = fadeSolver.update(0.1, null, c, true);
record('追蹤遺失且設為凍結時，權重不下降（FR-02-75）',
  close(frozen.weight, 1, 0.001), `weight=${frozen.weight.toFixed(3)}`);

const resetCfg = cfg({ fadeSeconds: 0.5, lostBehavior: 'reset', lostResetSeconds: 1 });
const lost = fadeSolver.update(0.5, null, resetCfg, true);
record('設為平滑回復時，遺失後權重下降',
  lost.weight < 0.6, `weight=${lost.weight.toFixed(3)}`);

let off = null;
for (let i = 0; i < 20; i += 1) off = fadeSolver.update(0.1, null, c, false);
record('切回僅臉部模式後最終回傳 null（骨骼交還基準姿勢）', off === null);

// ── 9. 平滑（FR-02-72）──
console.log('\n[9] 平滑：球面插值');

const smoothSolver = new B.BodySolver();
smoothSolver.setRig(rigA);
const cs = cfg({ smooth: 80, fadeSeconds: 0.01 });
const armDown = { pose: standingPose(), hands: {}, mirror: true };
const armUp = { pose: standingPose({ leftArmUp: true }), hands: {}, mirror: true };

// 第一次取樣沒有前一幀可插值，會直接落在目標上（否則模型會從 rest pose 彈進來），
// 因此要先跑穩一個姿勢，再切換姿勢才測得到平滑
for (let i = 0; i < 30; i += 1) smoothSolver.update(1 / 30, armDown, cs, true);
const stepOne = smoothSolver.update(1 / 30, armUp, cs, true);
const stepOneDir = worldDir(rigA, stepOne.bones, 'leftUpperArm');
for (let i = 0; i < 60; i += 1) smoothSolver.update(1 / 30, armUp, cs, true);
const settled = smoothSolver.update(1 / 30, armUp, cs, true);
const settledDir = worldDir(rigA, settled.bones, 'leftUpperArm');
record('高平滑度下姿勢突變的第一幀尚未到位', stepOneDir.y < settledDir.y - 0.2,
  `切換後第一幀 y=${stepOneDir.y.toFixed(3)} → 收斂 y=${settledDir.y.toFixed(3)}`);
record('持續同一姿勢後收斂到目標', settledDir.y > 0.9);

const instant = new B.BodySolver();
instant.setRig(rigA);
const firstFrame = instant.update(1 / 30, armUp, cfg({ smooth: 0 }), true);
record('首次取樣直接落在目標，不從 rest pose 彈入',
  worldDir(rigA, firstFrame.bones, 'leftUpperArm').y > 0.9);

const allFinite = Object.values(settled.bones).every((q) => q.every(Number.isFinite));
record('輸出四元數皆為有限值', allFinite);
const norms = Object.values(settled.bones).map((q) => Math.hypot(...q));
record('輸出四元數皆為單位長度',
  norms.every((n) => close(n, 1, 0.002)),
  `最大偏差 ${Math.max(...norms.map((n) => Math.abs(n - 1))).toFixed(5)}`);

// ── 10. 根節點升降（FR-02-63）──
console.log('\n[10] 蹲下／起立');

const stand = { pose: standingPose(), hands: {}, mirror: true };
const crouched = { pose: standingPose({ crouch: 0.25 }), hands: {}, mirror: true };
const rootCfg = cfg({ mode: 'full', parts: { ...cfg().parts, rootMotion: true }, fadeSeconds: 0.01 });

const rootSolver = new B.BodySolver();
rootSolver.setRig(rigA);
rootSolver.update(1 / 30, stand, rootCfg, true); // 首幀自動取為中性原點
for (let i = 0; i < 30; i += 1) rootSolver.update(1 / 30, crouched, rootCfg, true);
const crouchOut = rootSolver.update(1 / 30, crouched, rootCfg, true);
record('蹲下時根節點下降', crouchOut.rootY < -0.1, `rootY=${crouchOut.rootY.toFixed(3)}`);

const noRoot = run(rigA, crouched, cfg({ mode: 'full' })).out;
record('未啟用時根節點位移為 0', noRoot.rootY === 0);

// ── 11. 扭轉分解 ──
console.log('\n[11] 扭轉分解（手腕扭轉讓給前臂）');

const axis = V(1, 0, 0);
const pureTwist = new THREE.Quaternion().setFromAxisAngle(axis, 0.7);
const gotTwist = B.extractTwist(pureTwist, axis);
record('純扭轉可完整取回', close(gotTwist.angleTo(pureTwist), 0, 1e-4));

const pureSwing = new THREE.Quaternion().setFromAxisAngle(V(0, 1, 0), 0.7);
record('純擺動不含扭轉分量',
  close(B.extractTwist(pureSwing, axis).angleTo(new THREE.Quaternion()), 0, 1e-4));

const combined = pureSwing.clone().multiply(pureTwist);
const extracted = B.extractTwist(combined, axis);
record('混合旋轉取出的扭轉與原扭轉同軸',
  close(Math.abs(new THREE.Vector3(extracted.x, extracted.y, extracted.z).normalize().x), 1, 1e-3));

// ────────────────────────────────────────────────────────────────

await rm(tmpDir, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok);
console.log('\n' + '='.repeat(60));
console.log(`結果：${results.length - failed.length} / ${results.length} 通過`);
if (failed.length) {
  console.log('\n失敗項目：');
  for (const f of failed) console.log(`  - ${f.name}${f.detail ? ` (${f.detail})` : ''}`);
}
console.log('');

process.exit(failed.length ? 1 : 0);
