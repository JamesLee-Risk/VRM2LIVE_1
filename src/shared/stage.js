/**
 * VRM 渲染舞台 — FR-01（載入／變換／攝影機）、FR-11（背景／光照）。
 *
 * 這個模組被**兩個**進入點共用：工作室主視窗與 OBS 輸出頁面。
 * 兩者渲染同一份解算結果，但輸出頁面不執行追蹤（FR-15-02）。
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import { VRMAnimationLoaderPlugin, VRMLookAtQuaternionProxy } from '@pixiv/three-vrm-animation';
import { BVHLoader } from 'three/examples/jsm/loaders/BVHLoader.js';
import { AnimationController } from './animation.js';
import { buildRig } from './bodysolver.js';

const EMPTY_SET = new Set();

const r4 = (v) => Math.round(v * 10000) / 10000;

/** 攝影機取景預設（FR-01-12） */
export const CAMERA_PRESETS = {
  full: { label: '全身', target: [0, 0.95, 0], distance: 3.0, height: 0.95 },
  half: { label: '半身', target: [0, 1.25, 0], distance: 1.5, height: 1.25 },
  face: { label: '臉部特寫', target: [0, 1.42, 0], distance: 0.72, height: 1.42 },
};

export class Stage {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{transparent?: boolean}} [options]
   */
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.vrm = null;
    this.clock = new THREE.Clock();

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: true,
      premultipliedAlpha: true,
      // 截圖（FR-15-09）必需：預設值 false 會讓 WebGL 在合成後清空繪圖緩衝區，
      // 使 toDataURL 取到空白或上一幀的內容，截圖時有時對、有時錯。
      preserveDrawingBuffer: true,
    });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.scene = new THREE.Scene();

    this.camera = new THREE.PerspectiveCamera(30, 1, 0.05, 40);
    this.cameraTarget = new THREE.Vector3(0, 1.25, 0);
    this.applyCameraPreset('half');

    // ── 光照（FR-11-11、FR-11-12）────────────────────────────
    this.ambient = new THREE.AmbientLight(0xffffff, 0.85);
    this.scene.add(this.ambient);

    this.directional = new THREE.DirectionalLight(0xffffff, 0.95);
    this.directional.position.set(1, 2, -2);
    this.scene.add(this.directional);

    // 邊緣光以第二盞方向光自模型後方打亮輪廓，使其自背景分離
    this.rim = new THREE.DirectionalLight(0xaaccff, 0.0);
    this.rim.position.set(-1.5, 1.5, 2);
    this.scene.add(this.rim);

    // ── 背景（FR-11-04、FR-11-05）───────────────────────────
    this.backgroundMode = options.transparent ? 'transparent' : 'transparent';
    this.backgroundTexture = null;
    this.backgroundVideo = null;

    /** 目前套用的靜態姿勢（FR-06-11）：骨骼名 → 四元數 */
    this.activePose = null;

    // 預設待機姿勢設定（見 applyBasePose）
    this.basePoseEnabled = true;
    this.basePoseArmAngle = 68;

    // 模型變換（FR-01-11）
    this.modelTransform = { x: 0, y: 0, z: 0, rotY: 0, scale: 1 };
    // 由追蹤驅動的根節點位移，與使用者設定的位移分開累加
    this.trackedOffset = { x: 0, y: 0, z: 0 };

    /** 身體追蹤用的骨架量測結果（FR-02-D），於 loadVRM 建立 */
    this.rig = null;
    this._bodyQuat = new THREE.Quaternion();

    this._onResize = this._onResize.bind(this);
    window.addEventListener('resize', this._onResize);
    this._onResize();
  }

  // ── 模型 ────────────────────────────────────────────────

  /**
   * 載入 VRM。
   * @param {string} url  可為 file:// 或 http:// 位址
   * @returns {Promise<import('@pixiv/three-vrm').VRM>}
   */
  async loadVRM(url, onProgress) {
    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));

    const gltf = await loader.loadAsync(url, (e) => {
      if (onProgress && e.total) onProgress(e.loaded / e.total);
    });

    const vrm = gltf.userData.vrm;
    if (!vrm) throw new Error('檔案不是有效的 VRM（缺少 VRM 擴充）');

    this.disposeVRM();

    // 模型基準朝向。
    //
    // 不使用 VRMUtils.rotateVRM0()：它的作法是設定 vrm.scene.rotation.y，
    // 而我們每幀都會用 _applyTransform() 覆寫同一個屬性，等於讓它失效。
    // 這裡改為自己記住基準角度，再把使用者的旋轉疊加上去。
    //
    // 兩代規格的預設朝向差 180°：VRM 0.x 在旋轉 0 時面向 -Z，1.0 則面向 +Z。
    // 攝影機位於 -Z，因此 1.0 需要額外轉半圈才會正面朝向鏡頭。
    this._baseRotationY = vrm.meta?.metaVersion === '0' ? 0 : Math.PI;

    // 效能最佳化：合併骨架與移除未使用頂點（NFR-P-01）
    VRMUtils.combineSkeletons(vrm.scene);
    VRMUtils.removeUnnecessaryVertices(vrm.scene);

    // 關閉自動視線，改由解算器以 yaw/pitch 驅動
    if (vrm.lookAt) vrm.lookAt.autoUpdate = false;

    // VRMA 的視線軌道是以四元數表示的，需要一個代理物件掛進場景圖，
    // AnimationMixer 才能依名稱找到並驅動它
    if (vrm.lookAt) {
      const proxy = new VRMLookAtQuaternionProxy(vrm.lookAt);
      proxy.name = 'VRMLookAtQuaternionProxy';
      vrm.scene.add(proxy);
    }

    vrm.scene.traverse((obj) => {
      obj.frustumCulled = false;
    });

    this.scene.add(vrm.scene);
    this.vrm = vrm;

    // 快取正規化骨骼的 rest pose。每幀要「只重設沒有被動畫驅動的骨骼」，
    // 因此需要自己的重設實作，不能用 resetNormalizedPose()（它會重設全部）。
    vrm.humanoid.resetNormalizedPose();
    this._restPose = new Map();
    for (const bone of Object.keys(vrm.humanoid.humanBones)) {
      const node = vrm.humanoid.getNormalizedBoneNode(bone);
      if (node) this._restPose.set(bone, node.quaternion.clone());
    }
    const hipsNode = vrm.humanoid.getNormalizedBoneNode('hips');
    this._restHipsPos = hipsNode ? hipsNode.position.clone() : null;

    // 身體追蹤的骨架量測（FR-02-65）。必須在 rest pose 下進行，故緊接著上面做完
    this.rig = this.measureRig();

    // 記住模型原本的搖動骨骼參數，之後的倍率一律以這份為基準，
    // 否則反覆調整滑桿會把倍率一次次疊乘上去（FR-01-13）
    this._captureSpringDefaults();

    this.animator = new AnimationController(vrm);
    this._applyTransform();
    return vrm;
  }

  // ── 動畫（FR-06）────────────────────────────────────────

  /**
   * 載入動畫檔。副檔名決定解析方式：
   *   .vrma → VRM Animation（主要格式，骨骼語意與 VRM 一致）
   *   .bvh  → 需依關節名稱重定向，僅為近似
   *
   * @param {string} url
   * @param {string} name 顯示名稱
   */
  async loadAnimation(url, name) {
    if (!this.vrm) throw new Error('尚未載入模型，無法載入動畫');

    const lower = url.toLowerCase().split('?')[0];

    if (lower.endsWith('.bvh')) {
      const bvh = await new BVHLoader().loadAsync(url);
      return this.animator.addBVH(name, bvh);
    }

    const loader = new GLTFLoader();
    loader.register((parser) => new VRMAnimationLoaderPlugin(parser));
    const gltf = await loader.loadAsync(url);
    const vrmAnimations = gltf.userData.vrmAnimations;
    if (!vrmAnimations?.length) {
      throw new Error('檔案不含 VRMC_vrm_animation 資料，可能不是有效的 .vrma');
    }
    return this.animator.addVRMA(name, vrmAnimations[0]);
  }

  /**
   * 預設待機姿勢。
   *
   * VRM 的 rest pose 是 T-pose（雙臂水平張開），直接拿來直播並不堪用。
   * 在尚未載入待機動畫（FR-06）之前，這裡提供一個放下雙臂的 A-pose 作為基準姿勢，
   * 於每幀重設骨骼後、套用追蹤結果前施加，因此追蹤旋轉仍可正常疊加其上。
   */
  applyBasePose() {
    const vrm = this.vrm;
    if (!vrm || !this.basePoseEnabled) return;

    // 動畫正在驅動的骨骼不可再寫入基準姿勢，理由見
    // AnimationController.animatedBones 的說明。
    const skip = this.drivenBones;

    const deg = THREE.MathUtils.degToRad;
    // 上臂：左臂沿 +X 延伸，繞 Z 負向轉即向下；右臂沿 -X，方向相反
    const set = (bone, x, y, z) => {
      if (skip.has(bone)) return;
      const node = vrm.humanoid.getNormalizedBoneNode(bone);
      if (node) node.rotation.set(deg(x), deg(y), deg(z));
    };

    // 符號說明：本模型在基準朝向下，骨骼的局部 X 軸與畫面左右相反，
    // 因此「放下手臂」在左臂為正向 Z 旋轉、右臂為負向——與直覺相反。
    set('leftUpperArm', 0, 0, this.basePoseArmAngle);
    set('rightUpperArm', 0, 0, -this.basePoseArmAngle);
    // 略微內收的前臂，避免手臂完全筆直而顯得僵硬
    set('leftLowerArm', 0, 8, 6);
    set('rightLowerArm', 0, -8, -6);
  }


  /**
   * 量測骨架，供身體追蹤解算使用（FR-02-D、FR-02-65）。
   *
   * 不硬編碼座標軸：基底與每根骨骼的骨節方向都自模型的 rest pose 量出來，
   * 因此 VRM 0.x（預設朝 -Z）與 1.0（朝 +Z）走的是同一條程式路徑。
   *
   * @returns {object|null} 缺少必要骨骼時回傳 null（該模型無法做身體追蹤）
   */
  measureRig() {
    const vrm = this.vrm;
    if (!vrm) return null;

    vrm.humanoid.resetNormalizedPose();
    const hips = vrm.humanoid.getNormalizedBoneNode('hips');
    if (!hips) return null;
    hips.updateWorldMatrix(true, true);

    // 正規化骨架在 rest pose 下每根骨骼的局部旋轉都是單位四元數，
    // 因此所有骨骼的世界旋轉都等於 rig 根節點的旋轉。把它除掉之後，
    // 解算器的四元數鏈就能從單位四元數開始累乘，不必再處理根節點朝向。
    const rootInv = new THREE.Quaternion();
    hips.getWorldQuaternion(rootInv);
    rootInv.invert();

    const nodes = new Map();
    for (const bone of Object.keys(vrm.humanoid.humanBones)) {
      const node = vrm.humanoid.getNormalizedBoneNode(bone);
      if (node) nodes.set(bone, node);
    }
    // 父骨骼由實際的場景圖往上找，不寫死 Humanoid 階層——
    // 缺 upperChest、缺肩膀的模型才能自動退化（FR-02-77）
    const boneOf = new Map();
    for (const [bone, node] of nodes) boneOf.set(node, bone);

    const info = new Map();
    for (const [bone, node] of nodes) {
      const pos = new THREE.Vector3()
        .setFromMatrixPosition(node.matrixWorld)
        .applyQuaternion(rootInv);
      let parent = null;
      for (let p = node.parent; p; p = p.parent) {
        if (boneOf.has(p)) { parent = boneOf.get(p); break; }
      }
      info.set(bone, { pos, parent });
    }

    return buildRig(info);
  }

  /**
   * 套用身體追蹤姿態（FR-02-D）。
   *
   * 呼叫時骨骼上已是基準待機姿勢，因此權重未滿時的球面插值
   * 正好就是「模式切換淡接」與「切回僅臉部時平順回到待機姿勢」（FR-02-68）。
   *
   * @param {{bones: Record<string, number[]>, weight: number}} body
   * @param {Set<string>} ownedBones 動畫接管的骨骼，不得覆寫（FR-02-66）
   */
  _applyBodyPose(body, ownedBones) {
    const vrm = this.vrm;
    const w = Math.min(1, body.weight ?? 1);
    for (const bone in body.bones) {
      if (ownedBones.has(bone)) continue;
      const node = vrm.humanoid.getNormalizedBoneNode(bone);
      if (!node) continue;
      this._bodyQuat.fromArray(body.bones[bone]);
      if (w >= 0.999) node.quaternion.copy(this._bodyQuat);
      else node.quaternion.slerp(this._bodyQuat, w);
    }
  }


  // ── 搖動骨骼 SpringBone（FR-01-13）────────────────────────

  /** 快取模型原始的搖動參數，作為倍率的基準 */
  _captureSpringDefaults() {
    const mgr = this.vrm?.springBoneManager;
    this._springDefaults = mgr
      ? [...mgr.joints].map((joint) => ({
        joint,
        stiffness: joint.settings.stiffness,
        gravityPower: joint.settings.gravityPower,
        dragForce: joint.settings.dragForce,
        colliderGroups: joint.colliderGroups,
      }))
      : null;

    // 碰撞體是多個關節共用的物件，要去重收集，否則半徑倍率會被重複套用
    const shapes = new Set();
    for (const d of this._springDefaults ?? []) {
      for (const g of d.colliderGroups ?? []) {
        for (const c of g.colliders ?? []) {
          if (c.shape && typeof c.shape.radius === 'number') shapes.add(c.shape);
        }
      }
    }
    this._colliderDefaults = [...shapes].map((shape) => ({ shape, radius: shape.radius }));
  }

  /**
   * 模型原始搖動參數的摘要，供 UI 診斷顯示。
   *
   * 「頭髮往上飄」的回報幾乎都要靠這幾個數字才判斷得出是模型設定還是程式問題，
   * 所以直接顯示在介面上，使用者回報時能一起附上。
   */
  getSpringBoneInfo() {
    const d = this._springDefaults;
    if (!d?.length) return { count: 0 };
    const range = (key) => {
      const v = d.map((x) => x[key]);
      return [Math.min(...v), Math.max(...v)];
    };
    return {
      count: d.length,
      stiffness: range('stiffness'),
      gravityPower: range('gravityPower'),
      dragForce: range('dragForce'),
      colliderGroups: d.reduce((n, x) => n + (x.colliderGroups?.length ?? 0), 0),
      colliderRadius: this._colliderDefaults?.length
        ? [Math.min(...this._colliderDefaults.map((c) => c.radius)),
          Math.max(...this._colliderDefaults.map((c) => c.radius))]
        : null,
    };
  }

  /**
   * 套用搖動骨骼設定（FR-01-13）。
   *
   * @param {object} s
   * @param {number} [s.intensity]  硬度倍率 0–2；越高越貼合原姿勢、擺動越小
   * @param {number} [s.gravity]    **追加**重力 0–1
   * @param {number} [s.drag]       阻尼倍率 0–2，結果限幅於 0–1
   * @param {boolean} [s.colliders]    碰撞體開關
   * @param {number}  [s.colliderScale] 碰撞體半徑倍率 0.2–1.5
   */
  setSpringBone({ intensity = 1, gravity = 0, drag = 1, colliders = true, colliderScale = 1 } = {}) {
    // 碰撞體過大是頭髮「靜止位置被墊高」的直接成因：實測有模型的頭部碰撞體
    // 半徑達 0.467 m，把瀏海整整撐高 22.8 cm。縮半徑比整個關掉好，
    // 因為關掉之後頭髮會直接穿過頭部。
    for (const c of this._colliderDefaults ?? []) {
      c.shape.radius = c.radius * (colliders ? colliderScale : 1);
    }
    if (!this._springDefaults) return;
    for (const d of this._springDefaults) {
      d.joint.settings.stiffness = d.stiffness * intensity;
      // 重力是「加」而不是「乘」：多數製作工具匯出的 gravityPower 就是 0
      //（本專案的範例模型 122 個關節全部為 0），乘上任何倍率仍然是 0。
      // 而頭髮停在綁定姿勢、不往下垂的症狀，正是零重力才會出現的。
      d.joint.settings.gravityPower = d.gravityPower + gravity;
      d.joint.settings.dragForce = Math.min(1, Math.max(0, d.dragForce * drag));
      d.joint.colliderGroups = colliders ? d.colliderGroups : [];
    }
  }


  /**
   * 模型的世界邊界（供取景判斷與自動配置使用）。
   *
   * **不使用** `Box3.setFromObject()`：它對蒙皮網格取的是
   * `geometry.computeBoundingBox()` 的結果，而該方法會把**所有 morph target
   * 的極值**一起算進去。表情數量多的模型因此會量出離譜的尺寸——實測一個
   * 1.62 公尺的模型被算成 13 公尺，連帶讓自動配置做出錯誤決定。
   *
   * 這裡只取 position 屬性本身的極值（等同綁定姿勢的輪廓），再乘上世界矩陣。
   * 結果與直接解析 glTF accessor 的 min/max 一致。
   */
  getModelBounds() {
    if (!this.vrm) return null;
    this.vrm.scene.updateMatrixWorld(true);

    const box = new THREE.Box3();
    const local = new THREE.Box3();
    const v = new THREE.Vector3();
    let found = false;

    this.vrm.scene.traverse((obj) => {
      const geo = obj.geometry;
      if (!geo?.attributes?.position) return;

      // 每個 geometry 只算一次，之後沿用
      let raw = geo.userData.__basePoseBox;
      if (!raw) {
        const pos = geo.attributes.position;
        local.makeEmpty();
        for (let i = 0; i < pos.count; i += 1) {
          local.expandByPoint(v.fromBufferAttribute(pos, i));
        }
        raw = local.clone();
        geo.userData.__basePoseBox = raw;
      }
      box.union(raw.clone().applyMatrix4(obj.matrixWorld));
      found = true;
    });

    if (!found || box.isEmpty()) return null;
    const size = new THREE.Vector3();
    box.getSize(size);
    return { min: box.min.clone(), max: box.max.clone(), size, height: size.y };
  }

  /**
   * 搖動骨骼與碰撞體的關係診斷。
   *
   * 回報「有多少搖動骨骼的根部落在某個碰撞體內部」——這是頭髮被碰撞體
   * 推開後回不去、看起來浮在半空的直接成因，光看參數表看不出來。
   */
  getSpringColliderDiagnosis() {
    const mgr = this.vrm?.springBoneManager;
    if (!mgr) return null;

    this.vrm.scene.updateMatrixWorld(true);
    const jointPos = new THREE.Vector3();
    const colliderPos = new THREE.Vector3();
    let inside = 0;
    let total = 0;
    let worstOverlap = 0;

    for (const joint of mgr.joints) {
      total += 1;
      jointPos.setFromMatrixPosition(joint.bone.matrixWorld);
      for (const group of joint.colliderGroups ?? []) {
        for (const collider of group.colliders ?? []) {
          const shape = collider.shape;
          const radius = shape?.radius;
          if (radius == null) continue;
          collider.updateWorldMatrix?.(true, false);
          colliderPos.setFromMatrixPosition(collider.matrixWorld);
          if (shape.offset) colliderPos.add(shape.offset.clone().applyQuaternion(
            collider.getWorldQuaternion(new THREE.Quaternion())
          ));
          const d = jointPos.distanceTo(colliderPos);
          const overlap = radius + joint.settings.hitRadius - d;
          if (overlap > 0) {
            inside += 1;
            worstOverlap = Math.max(worstOverlap, overlap);
            break;
          }
        }
      }
    }
    return { total, inside, worstOverlap };
  }

  disposeVRM() {
    if (!this.vrm) return;
    this.animator?.dispose();
    this.animator = null;
    this.rig = null;
    this._springDefaults = null;
    this._colliderDefaults = null;
    this.scene.remove(this.vrm.scene);
    VRMUtils.deepDispose(this.vrm.scene);
    this.vrm = null;
  }

  /**
   * 取得模型能力，供 Auto-Setup 使用（FR-01-09）。
   * @returns {import('./autosetup.js').ModelCapabilities}
   */
  getCapabilities() {
    const vrm = this.vrm;
    if (!vrm) return { expressions: new Set(), bones: new Set(), hasLookAt: false, lookAtType: 'none' };

    const expressions = new Set();
    if (vrm.expressionManager) {
      for (const e of vrm.expressionManager.expressions) {
        expressions.add(e.expressionName);
      }
    }

    const bones = new Set();
    for (const name of Object.keys(vrm.humanoid.humanBones)) {
      if (vrm.humanoid.getNormalizedBoneNode(name)) bones.add(name);
    }

    let lookAtType = 'none';
    if (vrm.lookAt?.applier) {
      // VRMLookAtBoneApplier / VRMLookAtExpressionApplier
      lookAtType = vrm.lookAt.applier.constructor.name.includes('Bone') ? 'bone' : 'expression';
    }

    return { expressions, bones, hasLookAt: Boolean(vrm.lookAt), lookAtType };
  }

  /** 表情清單，區分預設與自訂（FR-05-01） */
  getExpressionInfo() {
    const em = this.vrm?.expressionManager;
    if (!em) return { preset: [], custom: [] };
    return {
      preset: Object.keys(em.presetExpressionMap ?? {}),
      custom: Object.keys(em.customExpressionMap ?? {}),
    };
  }

  /** VRM 中繼資料與授權旗標（FR-01-04、FR-01-05） */
  getMeta() {
    return this.vrm?.meta ?? null;
  }

  // ── 套用解算結果 ────────────────────────────────────────

  /**
   * 將解算器輸出的目標值表套用至 VRM。
   * @param {Record<string, number>} resolved
   */
  /**
   * @param {Record<string, number>} resolved 解算器輸出
   * @param {object} [opts]
   * @param {number} [opts.dt]    推進動畫用的時間差（工作室端）
   * @param {object} [opts.pose]  外部餵入的動畫姿勢（OBS 輸出頁面端）
   * @param {object} [opts.body]  身體追蹤姿態（FR-02-D），兩端皆由主視窗解算
   */
  applySolved(resolved, opts = {}) {
    const vrm = this.vrm;
    if (!vrm) return;

    const { dt = 0, pose = null, body = null } = opts;

    // 先把 humanoid 回到 rest pose，否則骨骼旋轉會逐幀累加。
    //
    // 但**不能**重設由動畫驅動的骨骼：three.js 的 PropertyMixer 在算出的值
    // 與它上次寫入的值相同時會跳過寫入。我們若在兩次 mixer 更新之間把骨骼
    // 改回 rest，混合器並不知情，遇到動畫的靜止段落（值不再變動）就不會重寫，
    // 骨骼於是卡在 rest pose——表現為動畫播到一半姿勢突然掉回去。
    this._resetPoseExcept(this.drivenBones);
    // 再疊上基準待機姿勢；追蹤結果會以 += 累加於其上
    this.applyBasePose();
    // 表情同理：未在本幀寫入的表情必須歸零，否則淡出時間為 0 的表情
    // 會因為停止送值而卡在最後的權重上。
    // 必須在動畫之前歸零，否則會把動畫寫入的表情權重一併清掉。
    vrm.expressionManager?.resetValues();

    // ── 動畫層（P1 待機 / P3 一次性）──
    // 工作室端推進 mixer；輸出頁面端則直接套用主視窗算好的姿勢，
    // 兩者結果一致且輸出端不需重跑動畫時間軸。
    let ownedBones = EMPTY_SET;
    let ownedExpressions = EMPTY_SET;

    // 靜態姿勢先套用，動畫層隨後可覆寫（動畫優先權高於靜態姿勢）
    if (this.activePose) {
      for (const bone in this.activePose) {
        const node = vrm.humanoid.getNormalizedBoneNode(bone);
        if (node) node.quaternion.fromArray(this.activePose[bone]);
      }
    }

    if (this.animator && dt > 0) {
      this.animator.update(dt);
      ownedBones = this.animator.ownedBones;
      ownedExpressions = this.animator.ownedExpressions;
    } else if (pose) {
      this._applyPose(pose);
      ownedBones = new Set(Object.keys(pose));
    }

    // ── 身體追蹤層（P2，FR-02-D）──
    // 必須在逐軸映射之前：頭部追蹤等映射以 += 疊加於此姿態之上（FR-02-67）
    if (body?.bones && (body.weight ?? 0) > 0.0005) {
      this._applyBodyPose(body, ownedBones);
    }

    this.trackedOffset.x = 0;
    this.trackedOffset.y = 0;
    this.trackedOffset.z = 0;

    let lookYaw = null;
    let lookPitch = null;

    for (const key in resolved) {
      const value = resolved[key];
      const sep1 = key.indexOf(':');
      const kind = key.slice(0, sep1);

      if (kind === 'expression') {
        const name = key.slice(sep1 + 1);
        // 一次性動畫（P3）高於追蹤（P2）：其驅動的表情不接受追蹤覆寫
        if (!ownedExpressions.has(name)) vrm.expressionManager?.setValue(name, value);
      } else if (kind === 'bone') {
        const sep2 = key.indexOf(':', sep1 + 1);
        const boneName = key.slice(sep1 + 1, sep2);
        const axis = key.slice(sep2 + 1);
        // 同理：動畫接管的骨骼不再疊加追蹤旋轉，
        // 否則揮手之類的動作會被頭部追蹤扭曲
        if (ownedBones.has(boneName)) continue;
        const node = vrm.humanoid.getNormalizedBoneNode(boneName);
        if (node) node.rotation[axis] += THREE.MathUtils.degToRad(value);
      } else if (kind === 'lookAt') {
        if (key.endsWith('yaw')) lookYaw = value;
        else lookPitch = value;
      } else if (kind === 'root') {
        this.trackedOffset[key.slice(sep1 + 1)] = value;
      }
    }

    // 全身模式的蹲下／起立（FR-02-63）疊加在映射的根節點位移之上
    if (body?.rootY) this.trackedOffset.y += body.rootY * (body.weight ?? 1);

    if (vrm.lookAt) {
      if (lookYaw !== null) vrm.lookAt.yaw = lookYaw;
      if (lookPitch !== null) vrm.lookAt.pitch = lookPitch;
    }

    this._applyTransform();
  }

  /**
   * 目前被動畫或靜態姿勢驅動的骨骼。
   * 每幀重設與基準姿勢都必須略過這些骨骼，理由見
   * AnimationController.animatedBones 的說明。
   */
  get drivenBones() {
    const anim = this.animator?.animatedBones;
    const poseBones = this.activePose ? Object.keys(this.activePose) : null;
    if (!poseBones?.length) return anim ?? EMPTY_SET;

    const out = new Set(anim ?? []);
    for (const b of poseBones) out.add(b);
    return out;
  }

  /** 擷取目前的正規化骨骼姿勢，供儲存為靜態姿勢（FR-06-11） */
  capturePose() {
    if (!this.vrm) return null;
    const pose = {};
    for (const bone of this._restPose.keys()) {
      const node = this.vrm.humanoid.getNormalizedBoneNode(bone);
      if (!node) continue;
      const q = node.quaternion;
      // 與 rest 幾乎相同的骨骼不必存，姿勢檔會小很多也更好讀
      const rest = this._restPose.get(bone);
      if (rest && rest.angleTo(q) < 0.005) continue;
      pose[bone] = [r4(q.x), r4(q.y), r4(q.z), r4(q.w)];
    }
    return pose;
  }

  /** 套用／清除靜態姿勢 */
  setPose(pose) {
    this.activePose = pose && Object.keys(pose).length ? pose : null;
  }

  /**
   * 重設正規化骨骼至 rest pose，但略過指定骨骼。
   * @param {Set<string>} skip
   */
  _resetPoseExcept(skip) {
    const vrm = this.vrm;
    if (!this._restPose) {
      vrm.humanoid.resetNormalizedPose();
      return;
    }
    for (const [bone, quat] of this._restPose) {
      if (skip.has(bone)) continue;
      const node = vrm.humanoid.getNormalizedBoneNode(bone);
      if (node) node.quaternion.copy(quat);
    }
    if (this._restHipsPos && !skip.has('hips')) {
      const hips = vrm.humanoid.getNormalizedBoneNode('hips');
      if (hips) hips.position.copy(this._restHipsPos);
    }
  }

  /**
   * 套用主視窗傳來的動畫姿勢（OBS 輸出頁面用）。
   * @param {Record<string, number[]>} pose 骨骼名 → 四元數 [x,y,z,w]
   */
  _applyPose(pose) {
    const vrm = this.vrm;
    for (const bone in pose) {
      if (bone === 'hips@pos') {
        const node = vrm.humanoid.getNormalizedBoneNode('hips');
        if (node) node.position.fromArray(pose[bone]);
        continue;
      }
      const node = vrm.humanoid.getNormalizedBoneNode(bone);
      if (node) node.quaternion.fromArray(pose[bone]);
    }
  }

  /**
   * 套用模型變換。位移就是**世界座標的位移**，不隨縮放改變語意。
   *
   * 早期版本曾把「縮放支點」折進這個公式（pos = t + (1−s)(p − t)），
   * 副作用是 t 變成「縮放前的座標」：縮放 0.32 倍的模型，t.y 會膨脹到 −7.9，
   * 之後只要再動一點點縮放，模型就會被甩出畫面好幾公尺。實測就是這樣讓
   * 一個 3.3 公尺高的模型「不見了」。
   *
   * 支點修正改到「縮放發生的當下」做（見 setScaleKeepingView），
   * t 因此永遠是有界的世界座標，滑桿與拖曳的語意也才一致。
   */
  _applyTransform() {
    if (!this.vrm) return;
    const t = this.modelTransform;
    const o = this.trackedOffset;
    this.vrm.scene.position.set(t.x + o.x, t.y + o.y, t.z + o.z);
    this.vrm.scene.rotation.y = (this._baseRotationY ?? 0) + THREE.MathUtils.degToRad(t.rotY);
    this.vrm.scene.scale.setScalar(t.scale);
  }

  /**
   * 改變縮放，並讓「攝影機正在看的那一點」留在原地（FR-01-11）。
   *
   * 推導：世界座標 world(L) = t + s·R·L。設目前位於支點 p 的模型點為 L₀，
   * 則 R·L₀ = (p − t)/s₁；縮放為 s₂ 後要 t′ + s₂·R·L₀ = p，
   * 得 t′ = p − (s₂/s₁)·(p − t)。與旋轉無關，故對任何朝向都成立。
   */
  setScaleKeepingView(newScale) {
    const t = this.modelTransform;
    const s1 = t.scale || 1;
    const s2 = Math.max(0.2, Math.min(4, newScale));
    const p = this.cameraTarget;
    const k = s2 / s1;
    t.x = p.x - k * (p.x - t.x);
    t.y = p.y - k * (p.y - t.y);
    t.z = p.z - k * (p.z - t.z);
    t.scale = s2;
    this._applyTransform();
    return t;
  }

  /**
   * 依模型實際高度自動配置縮放與位置（FR-01-11）。
   *
   * 攝影機取景預設是以「身高約 1.6 公尺的人形」寫死的。實測匯入的模型
   * 從 0.55 到 3.33 公尺都有，差到兩倍以上時畫面上根本看不到人。
   *
   * @returns {{scale:number, sourceHeight:number}|null}
   */
  fitModel(targetHeight = 1.6) {
    const b = this.getModelBounds();
    if (!b || b.height < 1e-4) return null;

    const t = this.modelTransform;
    // 先取快照：b 是「套用目前變換之後」的世界邊界，要先還原成模型本身的尺寸
    const oldScale = t.scale || 1;
    const sourceHeight = b.height / oldScale;
    const sourceMinY = (b.min.y - t.y) / oldScale;

    t.scale = Math.max(0.2, Math.min(4, targetHeight / sourceHeight));
    t.x = 0;
    t.z = 0;
    t.y = -sourceMinY * t.scale; // 腳底落在 y = 0
    this._applyTransform();
    return { scale: t.scale, sourceHeight };
  }

  setModelTransform(patch) {
    Object.assign(this.modelTransform, patch);
    this._applyTransform();
  }

  // ── 攝影機 ──────────────────────────────────────────────

  applyCameraPreset(name) {
    const p = CAMERA_PRESETS[name] ?? CAMERA_PRESETS.half;
    this.cameraTarget.set(...p.target);
    // 攝影機置於 -Z 側，模型的基準朝向（見 loadVRM 的 _baseRotationY）
    // 已配合此位置調整為正面朝鏡頭。
    //
    // 重要：攝影機在 -Z 時，畫面右方對應世界座標的 **-X**（而非 +X）。
    // 任何把滑鼠水平位移換算成世界座標的程式碼都必須考慮這一點，
    // 否則拖曳方向會與滑鼠相反。
    this.camera.position.set(0, p.height, -p.distance);
    this.camera.lookAt(this.cameraTarget);
    this.cameraPreset = name;
  }

  setCamera({ x, y, z, fov }) {
    if (fov !== undefined) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
    if (x !== undefined) this.camera.position.x = x;
    if (y !== undefined) this.camera.position.y = y;
    if (z !== undefined) this.camera.position.z = z;
    this.camera.lookAt(this.cameraTarget);
  }

  // ── 背景與光照 ──────────────────────────────────────────

  /** @param {{mode:'transparent'|'color'|'image'|'video', color?:string, url?:string}} bg */
  async setBackground(bg) {
    this._clearBackground();
    this.backgroundMode = bg.mode;

    if (bg.mode === 'transparent') {
      this.scene.background = null;
      this.renderer.setClearColor(0x000000, 0);
    } else if (bg.mode === 'color') {
      this.scene.background = null;
      this.renderer.setClearColor(new THREE.Color(bg.color ?? '#00b140'), 1);
    } else if (bg.mode === 'image') {
      const tex = await new THREE.TextureLoader().loadAsync(bg.url);
      tex.colorSpace = THREE.SRGBColorSpace;
      this.backgroundTexture = tex;
      this.scene.background = tex;
    } else if (bg.mode === 'video') {
      const video = document.createElement('video');
      video.src = bg.url;
      video.loop = true;
      video.muted = true;
      video.playsInline = true;
      await video.play().catch(() => {});
      const tex = new THREE.VideoTexture(video);
      tex.colorSpace = THREE.SRGBColorSpace;
      this.backgroundVideo = video;
      this.backgroundTexture = tex;
      this.scene.background = tex;
    }
  }

  _clearBackground() {
    if (this.backgroundVideo) {
      this.backgroundVideo.pause();
      this.backgroundVideo.src = '';
      this.backgroundVideo = null;
    }
    if (this.backgroundTexture) {
      this.backgroundTexture.dispose();
      this.backgroundTexture = null;
    }
    this.scene.background = null;
  }

  /** FR-11-11、FR-11-12 */
  setLighting({ ambientColor, ambientIntensity, dirColor, dirIntensity, dirAzimuth, dirElevation, rimColor, rimIntensity }) {
    if (ambientColor !== undefined) this.ambient.color.set(ambientColor);
    if (ambientIntensity !== undefined) this.ambient.intensity = ambientIntensity;
    if (dirColor !== undefined) this.directional.color.set(dirColor);
    if (dirIntensity !== undefined) this.directional.intensity = dirIntensity;
    if (dirAzimuth !== undefined || dirElevation !== undefined) {
      this._dirAzimuth = dirAzimuth ?? this._dirAzimuth ?? 30;
      this._dirElevation = dirElevation ?? this._dirElevation ?? 45;
      const az = THREE.MathUtils.degToRad(this._dirAzimuth);
      const el = THREE.MathUtils.degToRad(this._dirElevation);
      // 方位角 0° 定義為「正面」（即攝影機所在的 -Z 側），
      // 因此 z 分量取負號，使滑桿的直覺方向與畫面一致。
      this.directional.position.set(
        Math.sin(az) * Math.cos(el) * 3,
        Math.sin(el) * 3,
        -Math.cos(az) * Math.cos(el) * 3
      );
    }
    if (rimColor !== undefined) this.rim.color.set(rimColor);
    if (rimIntensity !== undefined) this.rim.intensity = rimIntensity;
  }

  // ── 渲染 ────────────────────────────────────────────────

  /** 推進一幀。傳入 dt 以與解算器共用同一時基。 */
  render(dt) {
    if (this.vrm) this.vrm.update(dt);
    this.renderer.render(this.scene, this.camera);
  }

  _onResize() {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    if (w === 0 || h === 0) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** 截圖（FR-15-09）；回傳 PNG dataURL，支援透明背景 */
  capture({ scale = 1 } = {}) {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (scale !== 1) {
      this.renderer.setSize(w * scale, h * scale, false);
      this.camera.updateProjectionMatrix();
    }
    this.renderer.render(this.scene, this.camera);
    const data = this.canvas.toDataURL('image/png');
    if (scale !== 1) this._onResize();
    return data;
  }

  dispose() {
    window.removeEventListener('resize', this._onResize);
    this.disposeVRM();
    this._clearBackground();
    this.renderer.dispose();
  }
}
