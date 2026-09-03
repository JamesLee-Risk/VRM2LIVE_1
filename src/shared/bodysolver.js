/**
 * 身體姿態解算 — FR-02-D。
 *
 * 把 MediaPipe 的姿態／手部地標換算成 Humanoid 骨骼的**局部四元數**。
 * 與 FR-03 的映射引擎是兩條獨立通道：映射引擎處理「純量 → 單軸角度」，
 * 這裡處理「地標 → 完整骨骼朝向」，兩者在渲染層疊加（FR-02-64、FR-03-15）。
 *
 * 本模組不依賴 three-vrm、DOM 與 Electron，只用到 three 的數學型別，
 * 因此可由 scripts/test-body.mjs 以合成地標直接測試。
 *
 * ─── 座標系 ─────────────────────────────────────────────────
 * 地標為影像座標：x 向影像右方、y 向下、z 越小越靠近鏡頭。
 * 模型側的基底於載入時**自模型量測**（見 buildRig），不硬編碼軸向——
 * VRM 0.x 預設朝 -Z、1.0 朝 +Z，寫死任一種都會讓另一種左右顛倒（FR-02-65）。
 */
import * as THREE from 'three';

/** 追蹤模式（FR-02-60） */
export const BODY_MODES = ['face', 'half', 'full'];

export const BODY_MODE_LABELS = {
  face: '僅臉部＋軀幹',
  half: '半身追蹤',
  full: '全身追蹤',
};

/** MediaPipe Pose Landmarker 地標索引 */
export const PL = {
  NOSE: 0,
  LEFT_SHOULDER: 11, RIGHT_SHOULDER: 12,
  LEFT_ELBOW: 13, RIGHT_ELBOW: 14,
  LEFT_WRIST: 15, RIGHT_WRIST: 16,
  LEFT_PINKY: 17, RIGHT_PINKY: 18,
  LEFT_INDEX: 19, RIGHT_INDEX: 20,
  LEFT_HIP: 23, RIGHT_HIP: 24,
  LEFT_KNEE: 25, RIGHT_KNEE: 26,
  LEFT_ANKLE: 27, RIGHT_ANKLE: 28,
  LEFT_HEEL: 29, RIGHT_HEEL: 30,
  LEFT_FOOT_INDEX: 31, RIGHT_FOOT_INDEX: 32,
};

/**
 * 骨節方向的量測對象：骨骼 → 依序嘗試的子骨骼。
 * 取第一個模型實際具備者；全部缺席時退化為父骨骼方向（FR-02-77）。
 */
const SEGMENT_CHILDREN = {
  hips: ['spine', 'chest', 'upperChest'],
  spine: ['chest', 'upperChest', 'neck'],
  chest: ['upperChest', 'neck', 'head'],
  upperChest: ['neck', 'head'],

  leftShoulder: ['leftUpperArm'],
  rightShoulder: ['rightUpperArm'],
  leftUpperArm: ['leftLowerArm'],
  rightUpperArm: ['rightLowerArm'],
  leftLowerArm: ['leftHand'],
  rightLowerArm: ['rightHand'],
  leftHand: ['leftMiddleProximal', 'leftIndexProximal'],
  rightHand: ['rightMiddleProximal', 'rightIndexProximal'],

  leftUpperLeg: ['leftLowerLeg'],
  rightUpperLeg: ['rightLowerLeg'],
  leftLowerLeg: ['leftFoot'],
  rightLowerLeg: ['rightFoot'],
  leftFoot: ['leftToes'],
  rightFoot: ['rightToes'],
};

/** 十指：骨骼字尾 + 對應的手部地標索引（起點 → 終點），見附錄 A-6 */
const FINGERS = [
  { bones: ['ThumbMetacarpal', 'ThumbProximal', 'ThumbDistal'], pts: [[1, 2], [2, 3], [3, 4]] },
  { bones: ['IndexProximal', 'IndexIntermediate', 'IndexDistal'], pts: [[5, 6], [6, 7], [7, 8]] },
  { bones: ['MiddleProximal', 'MiddleIntermediate', 'MiddleDistal'], pts: [[9, 10], [10, 11], [11, 12]] },
  { bones: ['RingProximal', 'RingIntermediate', 'RingDistal'], pts: [[13, 14], [14, 15], [15, 16]] },
  { bones: ['LittleProximal', 'LittleIntermediate', 'LittleDistal'], pts: [[17, 18], [18, 19], [19, 20]] },
];

// 手指骨節的量測對象。VRM 0.x 的拇指命名與 1.0 錯開一節，
// 但 three-vrm 於載入時已統一為 1.0 命名，故此處只需一套名稱。
for (const side of ['left', 'right']) {
  for (const f of FINGERS) {
    for (let i = 0; i < f.bones.length - 1; i += 1) {
      SEGMENT_CHILDREN[side + f.bones[i]] = [side + f.bones[i + 1]];
    }
  }
}

function fingerBones() {
  const out = [];
  for (const side of ['left', 'right']) {
    for (const f of FINGERS) for (const b of f.bones) out.push(side + b);
  }
  return out;
}

/** 身體追蹤驅動的骨骼分組，供逐部位開關與 UI 使用（FR-02-69） */
export const BODY_PART_BONES = {
  torso: ['hips', 'spine', 'chest', 'upperChest'],
  shoulders: ['leftShoulder', 'rightShoulder'],
  arms: ['leftUpperArm', 'rightUpperArm', 'leftLowerArm', 'rightLowerArm', 'leftHand', 'rightHand'],
  hands: fingerBones(),
  legs: ['leftUpperLeg', 'rightUpperLeg', 'leftLowerLeg', 'rightLowerLeg', 'leftFoot', 'rightFoot'],
};

/** 本模組**絕不**寫入的骨骼：頭頸與眼球由臉部追蹤負責（FR-02-67） */
export const FACE_OWNED_BONES = new Set(['neck', 'head', 'leftEye', 'rightEye', 'jaw']);

/**
 * 身體側的鏡射方向是否要與 `mirror` 旗標**反過來**解讀。
 *
 * 兩條追蹤路徑的輸入格式完全不同：臉部拿到的是 MediaPipe 的臉部姿態**矩陣**
 * （鏡像＝把 yaw／roll 取負），身體拿到的是**地標座標**
 * （鏡像＝x 分量取負 + 左右歸屬對調）。兩者各自都是正確的鏡射，
 * 但基準朝向差了半圈，同一個旗標套下去會讓頭與身體轉向相反——
 * 試用者回報的正是「身體跟頭剛好不同方向，一個有鏡像、一個沒有」。
 *
 * 臉部側的方向已由使用者長期實測確認無誤，因此對齊的責任放在這裡。
 *
 * ─── 之後若還要調整，只需動這兩個地方 ────────────────────────
 *   頭與身體**互相**相反 → 改這個常數
 *   頭與身體**一起**反了 → 改 tracker.js `_extractPose` 的 sign
 * 兩者不會互相影響，不要同時改。
 */
const INVERT_BODY_MIRROR = true;

/** 解出身體側實際要不要鏡射。所有用到 mirror 的地方都必須經過這裡 */
function resolveMirror(sample) {
  const on = sample?.mirror !== false;
  return INVERT_BODY_MIRROR ? !on : on;
}

// ────────────────────────────────────────────────────────────────
// 骨架量測
// ────────────────────────────────────────────────────────────────

/**
 * 由模型的 rest pose 建立解算所需的骨架資料（FR-02-65）。
 *
 * @param {Map<string, {pos: THREE.Vector3, parent: string|null}>} info
 *        每根 Humanoid 骨骼在 **rig 空間**（已除去 rig 根節點旋轉）的位置與父骨骼。
 * @returns {object|null} 缺少必要骨骼時回傳 null
 */
export function buildRig(info) {
  for (const b of ['hips', 'leftUpperArm', 'rightUpperArm']) {
    if (!info.has(b)) return null;
  }

  // ── 基底：X = 角色左方、Y = 上、Z = 正面 ──
  const x = new THREE.Vector3()
    .subVectors(info.get('leftUpperArm').pos, info.get('rightUpperArm').pos);
  if (x.lengthSq() < 1e-10) return null;
  x.normalize();

  const topBone = ['head', 'neck', 'upperChest', 'chest', 'spine'].find((b) => info.has(b));
  const y = topBone
    ? new THREE.Vector3().subVectors(info.get(topBone).pos, info.get('hips').pos).normalize()
    : new THREE.Vector3(0, 1, 0);

  // 正交化。右手系下「左方 × 上方 = 正面」
  const z = new THREE.Vector3().crossVectors(x, y).normalize();
  y.crossVectors(z, x).normalize();

  const basis = { x, y, z };

  // ── 逐骨骼的 rest 骨節方向 ──
  const rest = new Map();
  for (const [bone, entry] of info) {
    rest.set(bone, { parent: entry.parent, pos: entry.pos, dir: null });
  }
  for (const [bone, entry] of rest) {
    entry.dir = measureDir(bone, info, basis);
  }
  // 量不到方向者（末端骨骼，如指尖節）沿用最近的已知父骨骼方向
  for (const entry of rest.values()) {
    if (entry.dir) continue;
    let p = entry.parent;
    while (p && !rest.get(p)?.dir) p = rest.get(p)?.parent ?? null;
    entry.dir = p ? rest.get(p).dir.clone() : basis.y.clone();
  }

  return {
    basis,
    rest,
    has: (b) => rest.has(b),
    /** 掌面基底（rest 姿勢下），用於決定手掌扭轉 */
    palmRest: { left: palmBasis(rest, 'left'), right: palmBasis(rest, 'right') },
  };
}

function measureDir(bone, info, basis) {
  const self = info.get(bone);
  for (const c of SEGMENT_CHILDREN[bone] ?? []) {
    const child = info.get(c);
    if (!child) continue;
    const d = new THREE.Vector3().subVectors(child.pos, self.pos);
    if (d.lengthSq() > 1e-12) return d.normalize();
  }
  // 腳掌缺腳趾骨時朝向正面。若沿用小腿方向會讓腳掌指向地面，整條腿看起來像斷了
  if (bone === 'leftFoot' || bone === 'rightFoot') return basis.z.clone();
  return null;
}

/** 掌面基底：沿手掌方向 + 食指側方向，供求解手腕扭轉 */
function palmBasis(rest, side) {
  const hand = rest.get(side + 'Hand');
  const idx = rest.get(side + 'IndexProximal');
  const little = rest.get(side + 'LittleProximal');
  if (!hand || !idx || !little) return null;
  return orthoBasis(hand.dir.clone(), new THREE.Vector3().subVectors(idx.pos, little.pos));
}

/**
 * 以 forward 為主軸、across 為次軸建立右手正交基底。
 * @returns {{x:THREE.Vector3,y:THREE.Vector3,z:THREE.Vector3}|null}
 */
function orthoBasis(forward, across) {
  const f = forward.clone();
  if (f.lengthSq() < 1e-10) return null;
  f.normalize();
  const a = across.clone().addScaledVector(f, -across.dot(f));
  if (a.lengthSq() < 1e-10) return null;
  a.normalize();
  return { x: a, y: new THREE.Vector3().crossVectors(f, a), z: f };
}

// ────────────────────────────────────────────────────────────────
// 解算器
// ────────────────────────────────────────────────────────────────

const IDENTITY = new THREE.Quaternion();

/** 脊椎鏈的旋轉分配（累積比例），對應附錄 A-6 的 40%／35%／25% */
const SPINE_BLEND = { spine: 0.4, chest: 0.75, upperChest: 1 };

export class BodySolver {
  constructor() {
    /** @type {object|null} */
    this.rig = null;
    /** 平滑後的局部四元數 */
    this.smoothed = new Map();
    /** 淡接權重 0–1（FR-02-68） */
    this.weight = 0;
    this.rootY = 0;
    /** 中性姿勢校準（FR-02-76） */
    this.calibration = { shoulderY: null };
    this.detected = { body: false, leftHand: false, rightHand: false };

    this._m = new THREE.Matrix4();
    this._m2 = new THREE.Matrix4();
  }

  setRig(rig) {
    this.rig = rig;
    this.reset();
  }

  reset() {
    this.smoothed.clear();
    this.weight = 0;
    this.rootY = 0;
    this.detected = { body: false, leftHand: false, rightHand: false };
  }

  /** 以當前姿勢為中性原點（FR-02-76） */
  calibrate(sample) {
    if (!this.rig || !sample?.pose) return false;
    const pts = this._toRig(sample.pose, resolveMirror(sample));
    const shoulderMid = mid(pts[PL.LEFT_SHOULDER], pts[PL.RIGHT_SHOULDER]);
    this.calibration.shoulderY = shoulderMid.dot(this.rig.basis.y);
    return true;
  }

  resetCalibration() {
    this.calibration.shoulderY = null;
  }

  /**
   * 推進一幀。
   *
   * @param {number} dt
   * @param {object|null} sample 追蹤結果 `{ pose, hands:{left,right}, mirror }`；
   *                             pose 為 33 點世界地標，hands 之鍵為**使用者本人**的左右手
   * @param {object} cfg         設定，見 config.js 的 tracking.body
   * @param {boolean} active     模式為 half／full 且追蹤開啟
   * @returns {{bones: Record<string, number[]>, weight: number, rootY: number}|null}
   */
  update(dt, sample, cfg = {}, active = false) {
    if (!this.rig) return null;

    const hasSample = Boolean(sample?.pose?.length);
    // 追蹤遺失時依 FR-02-25 的設定處理（FR-02-75）：
    // freeze 保持當前姿勢，reset 才在 lostResetSeconds 內淡出
    const freeze = (cfg.lostBehavior ?? 'freeze') === 'freeze';
    const on = active && (hasSample || freeze);
    const fade = !active || hasSample || freeze
      ? Math.max(0.01, cfg.fadeSeconds ?? 0.35)
      : Math.max(0.01, cfg.lostResetSeconds ?? 1.5);

    const step = dt / fade;
    const target = on ? 1 : 0;
    this.weight += clamp(target - this.weight, -step, step);

    if (this.weight <= 0.0005 && target === 0) {
      this.reset();
      return null;
    }

    if (active && hasSample) this._solve(sample, cfg, dt);
    else if (!hasSample) this.detected = { body: false, leftHand: false, rightHand: false };

    if (!this.smoothed.size) return null;

    const bones = Object.create(null);
    for (const [bone, q] of this.smoothed) bones[bone] = [r4(q.x), r4(q.y), r4(q.z), r4(q.w)];
    return { bones, weight: r4(this.weight), rootY: r4(this.rootY) };
  }

  // ── 內部：解算 ────────────────────────────────────────────

  _solve(sample, cfg, dt) {
    const rig = this.rig;
    const parts = cfg.parts ?? {};
    const sens = cfg.sensitivity ?? {};
    const full = cfg.mode === 'full';
    // 與臉部追蹤對齊，見 INVERT_BODY_MIRROR 的說明
    const mirror = resolveMirror(sample);

    // 鏡像的完整定義是「對矢狀面鏡射」＝ x 分量取負 **且** 左右歸屬對調。
    // 只做其中一半會得到「舉左手、模型卻抬起同側但姿勢扭曲的手」（FR-02-74）。
    const SIDE = mirror
      ? { left: 'RIGHT', right: 'LEFT' }
      : { left: 'LEFT', right: 'RIGHT' };
    const HAND_OF = mirror ? { left: 'right', right: 'left' } : { left: 'left', right: 'right' };

    const pts = this._toRig(sample.pose, mirror);
    const at = (side, name) => pts[PL[SIDE[side] + '_' + name]];
    this.detected.body = true;

    /** 已解算的世界（rig 空間）旋轉 */
    const world = new Map();
    /** 本幀的目標局部旋轉 */
    const local = new Map();

    const put = (bone, qWorld, strength = 1) => {
      if (!rig.has(bone) || FACE_OWNED_BONES.has(bone)) return;
      world.set(bone, qWorld);
      const q = this._parentWorld(bone, world).clone().invert().multiply(qWorld);
      if (strength < 0.999) q.slerp(IDENTITY, 1 - clamp(strength, 0, 1)).normalize();
      local.set(bone, q);
    };
    const aim = (bone, from, to, strength) => {
      const entry = rig.rest.get(bone);
      if (!entry) return;
      const dir = new THREE.Vector3().subVectors(to, from);
      if (dir.lengthSq() < 1e-8) return;
      put(bone, new THREE.Quaternion().setFromUnitVectors(entry.dir, dir.normalize()), strength);
    };

    // ── 軀幹 ───────────────────────────────────────────────
    const hipMid = mid(at('left', 'HIP'), at('right', 'HIP'));
    const shoulderMid = mid(at('left', 'SHOULDER'), at('right', 'SHOULDER'));
    const up = new THREE.Vector3().subVectors(shoulderMid, hipMid);

    if (parts.torso !== false) {
      const qHips = this._basisQuat(
        new THREE.Vector3().subVectors(at('left', 'HIP'), at('right', 'HIP')), up
      );
      const qTorso = this._basisQuat(
        new THREE.Vector3().subVectors(at('left', 'SHOULDER'), at('right', 'SHOULDER')), up
      );
      if (qHips && qTorso) {
        const s = sens.torso ?? 1;
        put('hips', qHips, s);
        for (const bone of ['spine', 'chest', 'upperChest']) {
          if (!rig.has(bone)) continue;
          put(bone, qHips.clone().slerp(qTorso, SPINE_BLEND[bone]), s);
        }
      }
    }

    // ── 肩膀 ───────────────────────────────────────────────
    if (parts.shoulders !== false) {
      // 地標的肩點幾乎就落在肩線上，全量套用會讓聳肩幅度誇張到不自然
      const s = (sens.shoulders ?? 1) * 0.5;
      aim('leftShoulder', shoulderMid, at('left', 'SHOULDER'), s);
      aim('rightShoulder', shoulderMid, at('right', 'SHOULDER'), s);
    }

    // ── 手臂 ───────────────────────────────────────────────
    if (parts.arms !== false) {
      const s = sens.arms ?? 1;
      for (const side of ['left', 'right']) {
        aim(side + 'UpperArm', at(side, 'SHOULDER'), at(side, 'ELBOW'), s);
        aim(side + 'LowerArm', at(side, 'ELBOW'), at(side, 'WRIST'), s);
      }
    }

    // ── 手掌與十指 ─────────────────────────────────────────
    for (const side of ['left', 'right']) {
      const hand = sample.hands?.[HAND_OF[side]];
      this.detected[side === 'left' ? 'leftHand' : 'rightHand'] = Boolean(hand);

      if (hand && parts.hands !== false) {
        this._solveHand(side, hand, mirror, cfg, put, aim, world);
      } else if (parts.arms !== false) {
        // 沒有手部地標時，以姿態地標的食指點粗略決定手掌朝向
        aim(side + 'Hand', at(side, 'WRIST'), at(side, 'INDEX'), sens.arms ?? 1);
      }
    }

    // ── 腿部（僅全身模式）───────────────────────────────────
    if (full && parts.legs !== false) {
      const s = sens.legs ?? 1;
      for (const side of ['left', 'right']) {
        aim(side + 'UpperLeg', at(side, 'HIP'), at(side, 'KNEE'), s);
        aim(side + 'LowerLeg', at(side, 'KNEE'), at(side, 'ANKLE'), s);
        aim(side + 'Foot', at(side, 'ANKLE'), at(side, 'FOOT_INDEX'), s);
      }
    }

    // ── 根節點垂直位移（僅全身模式）─────────────────────────
    let rootY = 0;
    if (full && parts.rootMotion) {
      const h = shoulderMid.dot(rig.basis.y);
      if (this.calibration.shoulderY === null) this.calibration.shoulderY = h;
      rootY = clamp((h - this.calibration.shoulderY) * (sens.rootMotion ?? 1), -0.6, 0.3);
    }

    // ── 平滑（FR-02-72：球面插值；逐軸插值會在跨 ±180° 時翻轉）──
    const alpha = smoothAlpha(cfg.smooth ?? 45, dt);
    for (const [bone, q] of local) {
      const prev = this.smoothed.get(bone);
      if (prev) prev.slerp(q, alpha);
      else this.smoothed.set(bone, q.clone());
    }
    // 本幀沒解出來的骨骼（例如剛被關掉的部位）平滑回到無旋轉，而非瞬間彈回
    for (const [bone, prev] of this.smoothed) {
      if (!local.has(bone)) prev.slerp(IDENTITY, alpha);
    }
    this.rootY += (rootY - this.rootY) * alpha;
  }

  /**
   * 手掌與十指。手掌取完整朝向（含扭轉），並把一部分扭轉讓給前臂——
   * 否則所有扭轉都堆在手腕，手掌會像被擰過一樣。
   */
  _solveHand(side, hand, mirror, cfg, put, aim, world) {
    const rig = this.rig;
    const sens = cfg.sensitivity ?? {};
    const H = this._toRig(hand, mirror);

    const palmRest = rig.palmRest[side];
    const palmNow = orthoBasis(
      new THREE.Vector3().subVectors(H[9], H[0]),
      new THREE.Vector3().subVectors(H[5], H[17])
    );

    if (palmRest && palmNow) {
      const qHand = this._alignBasis(palmRest, palmNow);

      const lowerArm = side + 'LowerArm';
      const twistFrac = cfg.handTwist ?? 0.5;
      if (twistFrac > 0 && world.has(lowerArm)) {
        const armWorld = world.get(lowerArm);
        const rel = armWorld.clone().invert().multiply(qHand);
        const twist = extractTwist(rel, rig.rest.get(lowerArm).dir);
        twist.slerp(IDENTITY, 1 - clamp(twistFrac, 0, 1));
        // 前臂吃掉一部分扭轉後，手掌的局部旋轉會由 put 自動扣除該分量
        put(lowerArm, armWorld.clone().multiply(twist), sens.arms ?? 1);
      }
      put(side + 'Hand', qHand, sens.hands ?? 1);
    }

    const s = sens.fingers ?? 1;
    for (const f of FINGERS) {
      for (let i = 0; i < f.bones.length; i += 1) {
        const [a, b] = f.pts[i];
        aim(side + f.bones[i], H[a], H[b], s);
      }
    }
  }

  /** 父骨骼的世界旋轉；缺席者往上找最近的已解算祖先（FR-02-77） */
  _parentWorld(bone, world) {
    let p = this.rig.rest.get(bone)?.parent ?? null;
    while (p) {
      const q = world.get(p);
      if (q) return q;
      p = this.rig.rest.get(p)?.parent ?? null;
    }
    return IDENTITY;
  }

  /** 由「左方向 + 上方向」建立目標基底，求出相對 rest 基底的旋轉 */
  _basisQuat(left, up) {
    const u = up.clone();
    if (u.lengthSq() < 1e-10) return null;
    u.normalize();
    const l = left.clone().addScaledVector(u, -left.dot(u));
    if (l.lengthSq() < 1e-10) return null;
    l.normalize();
    const f = new THREE.Vector3().crossVectors(l, u);
    return this._alignBasis(this.rig.basis, { x: l, y: u, z: f });
  }

  /** 求出把 from 基底轉到 to 基底的旋轉 */
  _alignBasis(from, to) {
    this._m.makeBasis(to.x, to.y, to.z);
    this._m2.makeBasis(from.x, from.y, from.z).transpose();
    this._m.multiply(this._m2);
    return new THREE.Quaternion().setFromRotationMatrix(this._m);
  }

  /** 地標 → rig 空間。左右歸屬的對調由呼叫端處理，這裡只負責座標軸 */
  _toRig(landmarks, mirror) {
    const { x, y, z } = this.rig.basis;
    const s = mirror ? -1 : 1;
    const out = [];
    for (const lm of landmarks) {
      out.push(new THREE.Vector3()
        .addScaledVector(x, s * lm.x)
        .addScaledVector(y, -lm.y)
        .addScaledVector(z, -lm.z));
    }
    return out;
  }
}

// ────────────────────────────────────────────────────────────────
// 小工具
// ────────────────────────────────────────────────────────────────

function mid(a, b) {
  return new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5);
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/** 取出四元數繞 axis 的扭轉分量（swing-twist 分解） */
export function extractTwist(q, axis) {
  const proj = new THREE.Vector3(q.x, q.y, q.z).projectOnVector(axis);
  const twist = new THREE.Quaternion(proj.x, proj.y, proj.z, q.w);
  if (twist.lengthSq() < 1e-10) return new THREE.Quaternion();
  return twist.normalize();
}

/** 平滑度 0–100 → 本幀插值係數 */
export function smoothAlpha(smooth, dt) {
  if (!smooth) return 1;
  const tau = (smooth / 100) * 0.25;
  return tau <= 0 ? 1 : 1 - Math.exp(-dt / tau);
}

function r4(v) {
  return Math.round(v * 10000) / 10000;
}
