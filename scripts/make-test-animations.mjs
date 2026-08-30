/**
 * 產生測試用動畫檔 — 供 FR-06 開發與自我測試使用。
 *
 * 產出：
 *   Animations/測試_揮手.vrma   一次性動畫：右臂舉起並揮動
 *   Animations/測試_待機.vrma   循環動畫：軀幹輕微擺動
 *   Animations/測試_手臂.bvh    BVH 格式，用於驗證關節名稱重定向
 *
 * 之所以自己產生而非下載現成檔案：測試需要「已知內容」才能斷言
 * （例如「這個動畫只該驅動右臂」），下載來的動畫無法保證這一點。
 *
 * 執行：node scripts/make-test-animations.mjs
 */
import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'Animations');

// ────────────────────────────────────────────────────────────────
// 小工具
// ────────────────────────────────────────────────────────────────

const deg = (d) => (d * Math.PI) / 180;

/** 繞單一軸的四元數 */
function quatAxis(axis, radians) {
  const h = radians / 2;
  const s = Math.sin(h);
  const c = Math.cos(h);
  return axis === 'x' ? [s, 0, 0, c] : axis === 'y' ? [0, s, 0, c] : [0, 0, s, c];
}

/**
 * VRM 1.0 必要的人形骨骼。VRMA 至少要描述這些，
 * 否則部分檢視器會拒絕載入。
 */
const REQUIRED_BONES = [
  'hips', 'spine', 'chest', 'neck', 'head',
  'leftUpperArm', 'leftLowerArm', 'leftHand',
  'rightUpperArm', 'rightLowerArm', 'rightHand',
  'leftUpperLeg', 'leftLowerLeg', 'leftFoot',
  'rightUpperLeg', 'rightLowerLeg', 'rightFoot',
];

/** 骨骼階層（父 → 子），用來建立 glTF 節點樹 */
const PARENT = {
  hips: null,
  spine: 'hips', chest: 'spine', neck: 'chest', head: 'neck',
  leftUpperArm: 'chest', leftLowerArm: 'leftUpperArm', leftHand: 'leftLowerArm',
  rightUpperArm: 'chest', rightLowerArm: 'rightUpperArm', rightHand: 'rightLowerArm',
  leftUpperLeg: 'hips', leftLowerLeg: 'leftUpperLeg', leftFoot: 'leftLowerLeg',
  rightUpperLeg: 'hips', rightLowerLeg: 'rightUpperLeg', rightFoot: 'rightLowerLeg',
};

/** 各骨骼在 rest pose（T-pose）中的相對位置，單位公尺 */
const REST_OFFSET = {
  hips: [0, 1.0, 0],
  spine: [0, 0.1, 0], chest: [0, 0.12, 0], neck: [0, 0.16, 0], head: [0, 0.08, 0],
  leftUpperArm: [0.08, 0.12, 0], leftLowerArm: [0.25, 0, 0], leftHand: [0.25, 0, 0],
  rightUpperArm: [-0.08, 0.12, 0], rightLowerArm: [-0.25, 0, 0], rightHand: [-0.25, 0, 0],
  leftUpperLeg: [0.08, -0.05, 0], leftLowerLeg: [0, -0.4, 0], leftFoot: [0, -0.4, 0],
  rightUpperLeg: [-0.08, -0.05, 0], rightLowerLeg: [0, -0.4, 0], rightFoot: [0, -0.4, 0],
};

/**
 * 組出一個 .vrma（GLB 容器 + VRMC_vrm_animation 擴充）。
 *
 * @param {object} opts
 * @param {number} opts.duration 秒
 * @param {number} opts.fps
 * @param {(t: number) => Record<string, number[]>} opts.sample
 *        給定時間，回傳「骨骼名 → 四元數」；未列出的骨骼該幀不變
 */
function buildVRMA({ duration, fps, sample }) {
  const frameCount = Math.round(duration * fps) + 1;
  const times = Array.from({ length: frameCount }, (_, i) => i / fps);

  // 先取樣，決定哪些骨骼真的有動畫
  const samples = times.map((t) => sample(t));
  const animatedBones = [...new Set(samples.flatMap((s) => Object.keys(s)))];

  // ── glTF 節點 ──
  const nodes = [];
  const nodeIndex = {};
  REQUIRED_BONES.forEach((bone, i) => {
    nodeIndex[bone] = i;
    nodes.push({
      name: bone,
      translation: REST_OFFSET[bone] ?? [0, 0, 0],
      rotation: [0, 0, 0, 1],
    });
  });
  for (const bone of REQUIRED_BONES) {
    const parent = PARENT[bone];
    if (!parent) continue;
    const p = nodes[nodeIndex[parent]];
    (p.children ??= []).push(nodeIndex[bone]);
  }

  // ── 二進位資料 ──
  const buffers = [];
  const accessors = [];
  const bufferViews = [];
  let offset = 0;

  const pushAccessor = (data, type, componentCount) => {
    const arr = new Float32Array(data);
    const bytes = Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
    buffers.push(bytes);

    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length });
    offset += bytes.length;

    const count = data.length / componentCount;
    const accessor = {
      bufferView: bufferViews.length - 1,
      componentType: 5126, // FLOAT
      count,
      type,
    };
    // 時間軸的 min/max 為必要欄位
    if (type === 'SCALAR') {
      accessor.min = [Math.min(...data)];
      accessor.max = [Math.max(...data)];
    }
    accessors.push(accessor);
    return accessors.length - 1;
  };

  const timeAccessor = pushAccessor(times, 'SCALAR', 1);

  const channels = [];
  const samplers = [];

  for (const bone of animatedBones) {
    // 缺漏的幀沿用上一幀，避免取樣函式必須每幀都列出所有骨骼
    let last = [0, 0, 0, 1];
    const flat = [];
    for (const s of samples) {
      if (s[bone]) last = s[bone];
      flat.push(...last);
    }

    const outAccessor = pushAccessor(flat, 'VEC4', 4);
    samplers.push({ input: timeAccessor, output: outAccessor, interpolation: 'LINEAR' });
    channels.push({
      sampler: samplers.length - 1,
      target: { node: nodeIndex[bone], path: 'rotation' },
    });
  }

  // ── VRMC_vrm_animation 擴充 ──
  const humanBones = {};
  for (const bone of REQUIRED_BONES) humanBones[bone] = { node: nodeIndex[bone] };

  const binLength = offset;
  const json = {
    asset: { version: '2.0', generator: 'VRM2LIVE test animation generator' },
    extensionsUsed: ['VRMC_vrm_animation'],
    extensions: {
      VRMC_vrm_animation: {
        specVersion: '1.0',
        humanoid: { humanBones },
      },
    },
    nodes,
    scenes: [{ nodes: [nodeIndex.hips] }],
    scene: 0,
    animations: [{ name: 'clip', channels, samplers }],
    accessors,
    bufferViews,
    buffers: [{ byteLength: binLength }],
  };

  return packGLB(json, Buffer.concat(buffers));
}

/** 依 glTF 2.0 規格組出 GLB 容器 */
function packGLB(json, bin) {
  const jsonBuf = Buffer.from(JSON.stringify(json), 'utf8');
  const jsonPad = (4 - (jsonBuf.length % 4)) % 4;
  const jsonChunk = Buffer.concat([jsonBuf, Buffer.alloc(jsonPad, 0x20)]); // 以空白填補

  const binPad = (4 - (bin.length % 4)) % 4;
  const binChunk = Buffer.concat([bin, Buffer.alloc(binPad, 0)]);

  const total = 12 + 8 + jsonChunk.length + 8 + binChunk.length;
  const out = Buffer.alloc(total);
  let p = 0;

  out.writeUInt32LE(0x46546c67, p); p += 4; // 'glTF'
  out.writeUInt32LE(2, p); p += 4;
  out.writeUInt32LE(total, p); p += 4;

  out.writeUInt32LE(jsonChunk.length, p); p += 4;
  out.writeUInt32LE(0x4e4f534a, p); p += 4; // 'JSON'
  jsonChunk.copy(out, p); p += jsonChunk.length;

  out.writeUInt32LE(binChunk.length, p); p += 4;
  out.writeUInt32LE(0x004e4942, p); p += 4; // 'BIN'
  binChunk.copy(out, p);

  return out;
}

// ────────────────────────────────────────────────────────────────
// 內容定義
// ────────────────────────────────────────────────────────────────

/**
 * 揮手：右臂舉起後前臂左右擺動。
 * 只驅動右臂三節骨骼——這是測試骨骼遮罩與 ownedBones 的關鍵前提。
 */
const wave = buildVRMA({
  duration: 2,
  fps: 30,
  sample: (t) => {
    // 前 0.35 秒舉起，其後持續揮動
    const raise = Math.min(1, t / 0.35);
    const upper = -68 + raise * 63; // 由垂下（-68°）舉到接近水平
    const swing = t > 0.35 ? Math.sin((t - 0.35) * Math.PI * 3.2) * 28 : 0;
    return {
      rightUpperArm: quatAxis('z', deg(upper)),
      rightLowerArm: quatAxis('z', deg(swing)),
      rightHand: quatAxis('z', deg(swing * 0.4)),
    };
  },
});

/**
 * 待機：軀幹極輕微地擺動與呼吸。
 * 刻意不動頭部，這樣「待機動畫播放時頭仍由追蹤驅動」才好驗證。
 */
const idle = buildVRMA({
  duration: 4,
  fps: 30,
  sample: (t) => {
    const phase = (t / 4) * Math.PI * 2;
    return {
      spine: quatAxis('y', deg(Math.sin(phase) * 2.5)),
      chest: quatAxis('x', deg(Math.sin(phase * 2) * 1.5)),
      hips: quatAxis('z', deg(Math.sin(phase) * 1.2)),
    };
  },
});

/**
 * BVH：以 Mixamo 風格的關節命名，驗證重定向表能正確對應。
 * 內容是左臂上下擺動。
 */
function buildBVH() {
  const joints = [
    ['Hips', null, [0, 0, 0]],
    ['Spine', 'Hips', [0, 10, 0]],
    ['Spine1', 'Spine', [0, 12, 0]],
    ['Neck', 'Spine1', [0, 16, 0]],
    ['Head', 'Neck', [0, 8, 0]],
    ['LeftShoulder', 'Spine1', [8, 12, 0]],
    ['LeftArm', 'LeftShoulder', [10, 0, 0]],
    ['LeftForeArm', 'LeftArm', [25, 0, 0]],
    ['LeftHand', 'LeftForeArm', [25, 0, 0]],
  ];

  // ── 階層段 ──
  const lines = ['HIERARCHY'];
  const childrenOf = (name) => joints.filter(([, p]) => p === name);

  const emit = (name, offset, indent, isRoot) => {
    const pad = '  '.repeat(indent);
    lines.push(`${pad}${isRoot ? 'ROOT' : 'JOINT'} ${name}`);
    lines.push(`${pad}{`);
    lines.push(`${pad}  OFFSET ${offset.join(' ')}`);
    lines.push(
      `${pad}  CHANNELS ${isRoot ? '6 Xposition Yposition Zposition ' : '3 '}Zrotation Xrotation Yrotation`
    );
    const kids = childrenOf(name);
    for (const [kn, , ko] of kids) emit(kn, ko, indent + 1, false);
    if (kids.length === 0) {
      lines.push(`${pad}  End Site`);
      lines.push(`${pad}  {`);
      lines.push(`${pad}    OFFSET 0 5 0`);
      lines.push(`${pad}  }`);
    }
    lines.push(`${pad}}`);
  };
  emit('Hips', [0, 0, 0], 0, true);

  // ── 動作段 ──
  const fps = 30;
  const frames = 60;
  lines.push('MOTION');
  lines.push(`Frames: ${frames}`);
  lines.push(`Frame Time: ${(1 / fps).toFixed(6)}`);

  for (let f = 0; f < frames; f += 1) {
    const t = f / fps;
    const swing = Math.sin(t * Math.PI * 2) * 35;
    const row = [0, 100, 0]; // Hips 位移
    for (const [name] of joints) {
      if (name === 'Hips') {
        row.push(0, 0, 0);
      } else if (name === 'LeftArm') {
        row.push(swing, 0, 0); // Zrotation
      } else if (name === 'LeftForeArm') {
        row.push(swing * 0.5, 0, 0);
      } else {
        row.push(0, 0, 0);
      }
    }
    lines.push(row.map((v) => v.toFixed(4)).join(' '));
  }

  return lines.join('\n');
}

// ────────────────────────────────────────────────────────────────

await mkdir(outDir, { recursive: true });

const files = [
  ['測試_揮手.vrma', wave],
  ['測試_待機.vrma', idle],
  ['測試_手臂.bvh', buildBVH()],
];

for (const [name, data] of files) {
  const file = path.join(outDir, name);
  await writeFile(file, data);
  const size = typeof data === 'string' ? Buffer.byteLength(data) : data.length;
  console.log(`  ${name}  ${(size / 1024).toFixed(1)} KB`);
}

console.log(`\n已產生 ${files.length} 個測試動畫至 Animations/`);
