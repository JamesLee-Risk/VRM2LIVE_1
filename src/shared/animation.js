/**
 * 動畫系統 — FR-06。
 *
 * 支援 `.vrma`（VRM Animation，主要格式）與 `.bvh`（次要，需骨骼名稱重定向）。
 *
 * 與追蹤的分層關係直接對應規格 FR-03 的優先權表：
 *
 *   P1 待機動畫  ─ 低於追蹤。播放後追蹤再疊加上去，
 *                  因此「身體有待機動作、頭部仍跟著你動」是預設行為。
 *   P2 臉部追蹤
 *   P3 一次性動畫 ─ 高於追蹤。播放期間其遮罩內的骨骼完全由動畫接管，
 *                  追蹤不得再疊加，否則揮手動作會被頭部追蹤扭曲。
 *
 * 這個「誰擁有哪些骨骼」的判斷由 {@link AnimationController.ownedBones} 提供，
 * 渲染層據此略過對應的追蹤寫入。
 */
import * as THREE from 'three';
import { createVRMAnimationClip } from '@pixiv/three-vrm-animation';

/** VRM 人形骨骼的分組，供骨骼遮罩使用（FR-06-09） */
const LOWER_BODY = [
  'hips',
  'leftUpperLeg', 'rightUpperLeg',
  'leftLowerLeg', 'rightLowerLeg',
  'leftFoot', 'rightFoot',
  'leftToes', 'rightToes',
];

const ARM_BONES = [
  'leftShoulder', 'rightShoulder',
  'leftUpperArm', 'rightUpperArm',
  'leftLowerArm', 'rightLowerArm',
  'leftHand', 'rightHand',
];

/** 手指骨骼以名稱樣式判斷，避免列出 30 個名稱 */
const FINGER_RE = /^(left|right)(Thumb|Index|Middle|Ring|Little)(Proximal|Intermediate|Distal)$/;

const isFinger = (b) => FINGER_RE.test(b);
const isLower = (b) => LOWER_BODY.includes(b);
const isArm = (b) => ARM_BONES.includes(b) || isFinger(b);

/**
 * 骨骼遮罩定義。回傳 true 表示該骨骼由動畫驅動。
 * `custom` 由呼叫端提供明確的骨骼清單。
 */
export const BONE_MASKS = {
  full: { label: '全身', test: () => true },
  upper: { label: '僅上半身', test: (b) => !isLower(b) },
  lower: { label: '僅下半身', test: (b) => isLower(b) },
  arms: { label: '僅手臂', test: (b) => isArm(b) },
};

/**
 * BVH 關節名稱 → VRM 人形骨骼名稱。
 *
 * BVH 沒有標準骨骼命名，各家匯出工具差異很大，因此比對前先正規化：
 * 轉小寫並移除底線、冒號、空白與常見前綴（如 mixamorig:）。
 */
const BVH_ALIASES = {
  hips: 'hips', pelvis: 'hips', root: 'hips',
  spine: 'spine', spine1: 'chest', spine2: 'upperChest', chest: 'chest',
  neck: 'neck', head: 'head',
  leftshoulder: 'leftShoulder', lshoulder: 'leftShoulder', leftcollar: 'leftShoulder',
  rightshoulder: 'rightShoulder', rshoulder: 'rightShoulder', rightcollar: 'rightShoulder',
  leftarm: 'leftUpperArm', lupperarm: 'leftUpperArm', leftupperarm: 'leftUpperArm',
  rightarm: 'rightUpperArm', rupperarm: 'rightUpperArm', rightupperarm: 'rightUpperArm',
  leftforearm: 'leftLowerArm', llowerarm: 'leftLowerArm', leftlowerarm: 'leftLowerArm',
  rightforearm: 'rightLowerArm', rlowerarm: 'rightLowerArm', rightlowerarm: 'rightLowerArm',
  lefthand: 'leftHand', lhand: 'leftHand',
  righthand: 'rightHand', rhand: 'rightHand',
  leftupleg: 'leftUpperLeg', leftthigh: 'leftUpperLeg', leftupperleg: 'leftUpperLeg',
  rightupleg: 'rightUpperLeg', rightthigh: 'rightUpperLeg', rightupperleg: 'rightUpperLeg',
  leftleg: 'leftLowerLeg', leftshin: 'leftLowerLeg', leftlowerleg: 'leftLowerLeg',
  rightleg: 'rightLowerLeg', rightshin: 'rightLowerLeg', rightlowerleg: 'rightLowerLeg',
  leftfoot: 'leftFoot', rightfoot: 'rightFoot',
  lefttoebase: 'leftToes', righttoebase: 'rightToes',
  lefttoes: 'leftToes', righttoes: 'rightToes',
};

function normalizeJointName(name) {
  return String(name)
    .replace(/^.*[:|]/, '') // 去掉 mixamorig: 之類的前綴
    .replace(/[\s_\-.]/g, '')
    .toLowerCase();
}

export function bvhJointToHumanBone(jointName) {
  return BVH_ALIASES[normalizeJointName(jointName)] ?? null;
}

// ────────────────────────────────────────────────────────────────

/**
 * 一個已載入、可播放的動畫。
 * @typedef {object} LoadedAnimation
 * @property {string} name
 * @property {string} kind      'vrma' | 'bvh'
 * @property {THREE.AnimationClip} clip
 * @property {number} duration
 * @property {string[]} bones   此動畫實際驅動的人形骨骼
 */

export class AnimationController {
  /**
   * @param {import('@pixiv/three-vrm').VRM} vrm
   */
  constructor(vrm) {
    this.vrm = vrm;
    this.mixer = new THREE.AnimationMixer(vrm.scene);

    /** @type {Map<string, LoadedAnimation>} */
    this.animations = new Map();

    /** 待機動畫（P1） */
    this.idle = null;
    /** 一次性動畫（P3） */
    this.oneShot = null;

    /** 遮罩後的 clip 快取，見 _maskClip 的說明 */
    this.clipCache = new Map();

    /** 由節點名稱反查人形骨骼名稱，用於依遮罩過濾軌道 */
    this.nodeToBone = new Map();
    for (const bone of Object.keys(vrm.humanoid.humanBones)) {
      const node = vrm.humanoid.getNormalizedBoneNode(bone);
      if (node) this.nodeToBone.set(node.name, bone);
    }
  }

  // ── 載入 ────────────────────────────────────────────────

  /**
   * 由已解析的 VRMAnimation 建立可播放項目。
   * @param {string} name
   * @param {import('@pixiv/three-vrm-animation').VRMAnimation} vrmAnimation
   */
  addVRMA(name, vrmAnimation) {
    const clip = createVRMAnimationClip(vrmAnimation, this.vrm);
    return this._register(name, 'vrma', clip);
  }

  /**
   * 由 BVH 載入結果建立可播放項目（FR-06-03）。
   *
   * BVH 的骨架與 VRM 無關，必須依關節名稱重定向；同時 BVH 的旋轉是
   * 相對於其自身 rest pose，直接套到 VRM 上只能算近似，故僅列為次要格式。
   *
   * @param {string} name
   * @param {{clip: THREE.AnimationClip, skeleton: THREE.Skeleton}} bvh
   */
  addBVH(name, bvh) {
    const tracks = [];
    const unmapped = new Set();

    for (const track of bvh.clip.tracks) {
      // BVHLoader 的軌道名稱形如 "Hips.quaternion"
      const dot = track.name.lastIndexOf('.');
      const joint = track.name.slice(0, dot);
      const prop = track.name.slice(dot + 1);

      const bone = bvhJointToHumanBone(joint);
      if (!bone) {
        unmapped.add(joint);
        continue;
      }
      const node = this.vrm.humanoid.getNormalizedBoneNode(bone);
      if (!node) continue;

      // 只採用旋轉；位移僅取 hips，其餘位移會把模型拆散
      if (prop === 'quaternion') {
        const t = track.clone();
        t.name = `${node.name}.quaternion`;
        tracks.push(t);
      } else if (prop === 'position' && bone === 'hips') {
        const t = track.clone();
        t.name = `${node.name}.position`;
        tracks.push(t);
      }
    }

    if (tracks.length === 0) {
      throw new Error(
        `BVH 沒有任何關節能對應到 VRM 人形骨骼（未識別：${[...unmapped].slice(0, 6).join('、')}）`
      );
    }

    const clip = new THREE.AnimationClip(name, bvh.clip.duration, tracks);
    const entry = this._register(name, 'bvh', clip);
    entry.unmapped = [...unmapped];
    return entry;
  }

  _register(name, kind, clip) {
    const bones = [];
    const expressions = [];
    for (const track of clip.tracks) {
      const nodeName = track.name.slice(0, track.name.lastIndexOf('.'));
      const bone = this.nodeToBone.get(nodeName);
      if (bone && !bones.includes(bone)) bones.push(bone);
      // 表情軌道的節點名稱形如 VRMExpression_happy
      const m = /^VRMExpression_(.+)$/.exec(nodeName);
      if (m && !expressions.includes(m[1])) expressions.push(m[1]);
    }

    const entry = { name, kind, clip, duration: clip.duration, bones, expressions };
    this.animations.set(name, entry);
    return entry;
  }

  remove(name) {
    const entry = this.animations.get(name);
    if (!entry) return;
    this.mixer.uncacheClip(entry.clip);
    this.animations.delete(name);
  }

  // ── 遮罩 ────────────────────────────────────────────────

  /**
   * 依遮罩過濾出一份新的 clip。
   *
   * 用「刪掉軌道」而非「調權重」來實作遮罩，是因為 three.js 的 AnimationAction
   * 權重是整個 action 一體適用的，無法逐骨骼設定。刪掉軌道後，遮罩外的骨骼
   * 完全不被寫入，自然維持由追蹤或其他動畫驅動。
   *
   * @param {THREE.AnimationClip} clip
   * @param {(bone: string) => boolean} test
   * @param {Set<string>} [exclude] 額外排除的人形骨骼
   */
  _maskClip(clip, test, exclude, cacheKey) {
    // 快取極為重要：每次播放都新建 AnimationClip 會讓 AnimationMixer 為同一個
    // 屬性不斷產生新的 action，反覆 activate/deactivate 共用的 PropertyMixer，
    // 最終綁定會停止套用——動畫看似在跑（action.time 正常前進、權重為 1），
    // 卻完全不寫入骨骼。重複使用同一份 clip 即可重複使用同一個 action。
    if (cacheKey && this.clipCache.has(cacheKey)) return this.clipCache.get(cacheKey);

    const tracks = clip.tracks.filter((track) => {
      const nodeName = track.name.slice(0, track.name.lastIndexOf('.'));
      const bone = this.nodeToBone.get(nodeName);
      // 非人形骨骼的軌道（表情、lookAt）一律保留
      if (!bone) return true;
      if (exclude?.has(bone)) return false;
      return test(bone);
    });

    const masked = new THREE.AnimationClip(
      `${clip.name}__${cacheKey ?? 'masked'}`,
      clip.duration,
      tracks
    );
    if (cacheKey) this.clipCache.set(cacheKey, masked);
    return masked;
  }

  /** 產生穩定的快取鍵；骨骼集合需排序，否則同一組會產生不同鍵 */
  _cacheKey(name, mask, exclude) {
    const ex = exclude?.size ? [...exclude].sort().join(',') : '';
    return `${name}|${mask}|${ex}`;
  }

  // ── 播放 ────────────────────────────────────────────────

  /**
   * 設定循環待機動畫（FR-06-02、FR-06-04）。
   * @param {string|null} name  傳 null 表示停用
   * @param {object} options
   */
  setIdle(name, { fade = 0.4, mask = 'full', speed = 1 } = {}) {
    const prev = this.idle;

    if (!name) {
      if (prev) prev.action.fadeOut(fade);
      this.idle = null;
      return null;
    }

    const entry = this.animations.get(name);
    if (!entry) return null;

    const maskDef = BONE_MASKS[mask] ?? BONE_MASKS.full;
    const clip = this._maskClip(entry.clip, maskDef.test, null, this._cacheKey(name, `idle:${mask}`));
    const action = this.mixer.clipAction(clip);
    action.setLoop(THREE.LoopRepeat, Infinity);
    action.timeScale = speed;
    action.clampWhenFinished = false;
    action.reset();

    if (prev && fade > 0) {
      action.setEffectiveWeight(1);
      action.enabled = true;
      action.play();
      prev.action.crossFadeTo(action, fade, false);
    } else {
      if (prev) prev.action.stop();
      startAction(action, fade);
    }

    this.idle = {
      name, action, clip, entry, mask,
      bones: new Set(entry.bones.filter((b) => maskDef.test(b))),
    };
    return this.idle;
  }

  /**
   * 播放一次性動畫（FR-06-02、FR-06-04 ～ FR-06-08）。
   *
   * @param {string} name
   * @param {object} options
   * @param {number} options.fade          淡入淡出秒數
   * @param {string} options.mask          骨骼遮罩
   * @param {boolean} options.stopOnLastFrame 播完保持最後一幀（FR-06-07）
   * @param {Set<string>} options.trackedBones 目前由追蹤驅動的骨骼（FR-06-08）
   * @param {number} options.speed
   */
  playOneShot(name, {
    fade = 0.2,
    mask = 'full',
    stopOnLastFrame = false,
    trackedBones = new Set(),
    speed = 1,
  } = {}) {
    const entry = this.animations.get(name);
    if (!entry) return null;

    this.stopOneShot(0);

    const maskDef = BONE_MASKS[mask] ?? BONE_MASKS.full;
    const actions = [];

    if (stopOnLastFrame) {
      // FR-06-08：「停在最後一幀」不得凍結那些同時是追蹤輸出的骨骼，
      // 否則播完一個揮手動畫之後，頭就再也不跟著你動了。
      // 作法是把動畫拆成兩個互補的 action：
      //   hold    ─ 非追蹤骨骼，clampWhenFinished 保持最後一幀
      //   release ─ 追蹤骨骼，播完即淡出，交還給追蹤
      const holdClip = this._maskClip(
        entry.clip, maskDef.test, trackedBones,
        this._cacheKey(name, `hold:${mask}`, trackedBones)
      );
      const releaseClip = this._maskClip(
        entry.clip,
        (b) => maskDef.test(b) && trackedBones.has(b),
        null,
        this._cacheKey(name, `release:${mask}`, trackedBones)
      );

      if (holdClip.tracks.length) {
        const a = this.mixer.clipAction(holdClip);
        a.setLoop(THREE.LoopOnce, 1);
        a.clampWhenFinished = true;
        a.timeScale = speed;
        startAction(a, fade);
        actions.push({ action: a, clip: holdClip, holds: true });
      }
      if (releaseClip.tracks.length) {
        const a = this.mixer.clipAction(releaseClip);
        a.setLoop(THREE.LoopOnce, 1);
        a.clampWhenFinished = false;
        a.timeScale = speed;
        startAction(a, fade);
        actions.push({ action: a, clip: releaseClip, holds: false });
      }
    } else {
      const clip = this._maskClip(entry.clip, maskDef.test, null, this._cacheKey(name, `once:${mask}`));
      const a = this.mixer.clipAction(clip);
      a.setLoop(THREE.LoopOnce, 1);
      a.clampWhenFinished = false;
      a.timeScale = speed;
      startAction(a, fade);
      actions.push({ action: a, clip, holds: false });
    }

    this.oneShot = {
      name,
      entry,
      actions,
      mask,
      fade,
      stopOnLastFrame,
      trackedBones,
      // 擁有的骨骼：播放期間追蹤不得再疊加（P3 > P2）
      owned: new Set(entry.bones.filter((b) => maskDef.test(b))),
      startedAt: performance.now() / 1000,
      duration: entry.duration / (speed || 1),
      finished: false,
    };
    return this.oneShot;
  }

  /** 停止一次性動畫（FR-06-06 的「放開按鍵即停止」） */
  stopOneShot(fade = 0.2) {
    if (!this.oneShot) return;
    for (const { action } of this.oneShot.actions) {
      if (fade > 0) action.fadeOut(fade);
      else action.stop();
    }
    this.oneShot = null;
  }

  /**
   * 目前由一次性動畫接管、追蹤不應再寫入的骨骼。
   * 停在最後一幀之後，追蹤骨骼會被交還，因此不再列入。
   */
  get ownedBones() {
    if (!this.oneShot) return EMPTY_SET;
    if (this.oneShot.finished && this.oneShot.stopOnLastFrame) {
      // 已進入保持狀態：追蹤骨骼已交還
      const owned = new Set(this.oneShot.owned);
      for (const b of this.oneShot.trackedBones) owned.delete(b);
      return owned;
    }
    return this.oneShot.owned;
  }

  /**
   * 一次性動畫接管的表情。與 ownedBones 同理：P3 高於 P2，
   * 播放期間動畫指定的表情不應被追蹤映射（例如母音口型）蓋掉。
   */
  get ownedExpressions() {
    if (!this.oneShot || this.oneShot.finished) return EMPTY_SET;
    return new Set(this.oneShot.entry.expressions);
  }

  /**
   * 目前有任何動畫層在寫入的骨骼（不分優先權）。
   *
   * 渲染層必須據此略過基準姿勢的寫入。原因是 three.js 的 PropertyMixer 在
   * 「本次算出的值與上次寫入的值相同」時會跳過寫入（一項效能最佳化）。
   * 動畫一旦進入靜止段落（例如揮手動作把手臂舉到定位後角度不再變化），
   * 混合器就不再寫入，於是每幀都寫的基準姿勢會把動畫成果蓋掉，
   * 表現為「動畫播到一半手臂突然掉回垂下姿勢」。
   */
  get animatedBones() {
    if (!this.idle && !this.oneShot) return EMPTY_SET;
    const out = new Set();
    if (this.idle) for (const b of this.idle.bones) out.add(b);
    if (this.oneShot) for (const b of this.oneShot.owned) out.add(b);
    return out;
  }

  /** 是否有任何動畫正在作用 */
  get active() {
    return Boolean(this.idle || this.oneShot);
  }

  update(dt) {
    this.mixer.update(dt);

    // 判定一次性動畫是否播完
    const os = this.oneShot;
    if (os && !os.finished) {
      const elapsed = performance.now() / 1000 - os.startedAt;
      if (elapsed >= os.duration) {
        os.finished = true;
        if (!os.stopOnLastFrame) {
          // 未設定保持最後一幀：淡出後完全交還控制權
          this.stopOneShot(os.fade);
        }
      }
    }
  }

  /**
   * 取出目前動畫驅動之骨骼的世界旋轉，供 OBS 輸出頁面同步（FR-15-02）。
   * 只在有動畫作用時回傳資料，靜止時為 null 以節省頻寬。
   * @returns {Record<string, number[]> | null}
   */
  getPose() {
    if (!this.active) return null;

    const bones = new Set();
    if (this.idle) for (const b of this.idle.entry.bones) bones.add(b);
    if (this.oneShot) for (const b of this.oneShot.entry.bones) bones.add(b);
    if (bones.size === 0) return null;

    const pose = {};
    for (const bone of bones) {
      const node = this.vrm.humanoid.getNormalizedBoneNode(bone);
      if (!node) continue;
      const q = node.quaternion;
      pose[bone] = [round4(q.x), round4(q.y), round4(q.z), round4(q.w)];
      if (bone === 'hips') {
        const p = node.position;
        pose['hips@pos'] = [round4(p.x), round4(p.y), round4(p.z)];
      }
    }
    return pose;
  }

  dispose() {
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.vrm.scene);
    this.animations.clear();
    this.clipCache.clear();
    this.idle = null;
    this.oneShot = null;
  }
}

/**
 * 啟動一個 action。
 *
 * 不直接用 `action.fadeIn(0)`：three.js 會為此排入一段 0 秒的權重插值，
 * 權重有機會停在起始值 0，導致動畫看似在播放卻完全沒有效果。
 * 因此先明確把有效權重設為 1，只有真的需要淡入時才呼叫 fadeIn。
 */
function startAction(action, fade) {
  action.reset();
  action.setEffectiveWeight(1);
  action.enabled = true;
  if (fade > 0) action.fadeIn(fade);
  action.play();
  return action;
}

const EMPTY_SET = new Set();

function round4(v) {
  return Math.round(v * 10000) / 10000;
}
