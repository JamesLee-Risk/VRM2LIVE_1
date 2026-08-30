/**
 * 自動設定（Auto-Setup）— FR-01-09、FR-01-10。
 *
 * 依模型實際具備的表情預設與 Humanoid 骨骼，自動產生一整套輸入→輸出映射。
 * 關鍵是**退化處理**：模型缺少某個標準預設或非必要骨骼時，必須自動改走替代路徑
 * 並回報給使用者，而不是靜默產生無效映射（FR-01-10、NFR-C-05）。
 *
 * 注意 three-vrm v3 會把 VRM 0.x 的表情名正規化為 VRM 1.0 命名：
 *   a→aa、i→ih、u→ou、e→ee、o→oh、blink_l→blinkLeft、blink_r→blinkRight
 * 因此本模組一律以 1.0 命名判斷，不需區分模型版本。
 */

/** 附錄 A-3：單一輸入分散至多節骨骼的預設比例 */
const HEAD_CHAINS = {
  FaceAngleX: {
    axis: 'y',
    total: 30,
    chain: [
      ['head', 0.3],
      ['neck', 0.4],
      ['spine', 0.3],
    ],
  },
  FaceAngleY: {
    axis: 'x',
    total: 25,
    chain: [
      ['head', 0.4],
      ['neck', 0.4],
      ['chest', 0.2],
    ],
  },
  FaceAngleZ: {
    axis: 'z',
    total: 20,
    chain: [
      ['head', 0.5],
      ['neck', 0.5],
    ],
  },
};

const VOWEL_MAP = [
  ['VoiceA', 'aa'],
  ['VoiceI', 'ih'],
  ['VoiceU', 'ou'],
  ['VoiceE', 'ee'],
  ['VoiceO', 'oh'],
];

let seq = 0;
function mid(prefix) {
  seq += 1;
  return `${prefix}-${seq}`;
}

/**
 * @typedef {object} ModelCapabilities
 * @property {Set<string>} expressions 模型具備的表情名（正規化後）
 * @property {Set<string>} bones       模型具備的 Humanoid 骨骼名
 * @property {boolean} hasLookAt       模型是否具備 lookAt（不論 bone 或 expression 型態）
 * @property {string} lookAtType       'bone' | 'expression' | 'none'
 */

/**
 * 產生自動設定結果。
 *
 * @param {ModelCapabilities} caps
 * @returns {{mappings: object[], settingsPatch: object, notes: string[]}}
 *   notes 為需要回報給使用者的退化說明（FR-01-10）。
 */
export function autoSetup(caps) {
  const mappings = [];
  const notes = [];
  const settingsPatch = {};

  // FR-03-04：同一輸出目標只能被指派一次。這裡逐一登記已用掉的目標，
  // 後續產生的映射必須避開，否則會產生自我衝突的設定。
  const used = new Set();
  const keyOf = (t) =>
    t.type === 'bone' ? `bone:${t.name}:${t.axis}`
    : t.type === 'expression' ? `expression:${t.name}`
    : `${t.type}:${t.axis}`;
  const claim = (mapping) => {
    for (const t of mapping.targets ?? []) used.add(keyOf(t));
    mappings.push(mapping);
    return mapping;
  };

  // ── 頭部旋轉 → 骨骼鏈 ────────────────────────────────────
  for (const [input, spec] of Object.entries(HEAD_CHAINS)) {
    const resolved = resolveChain(spec.chain, caps.bones);
    if (resolved.length === 0) {
      notes.push(`模型缺少頭頸骨骼，無法建立 ${input} 映射`);
      continue;
    }
    if (resolved.dropped.length) {
      notes.push(
        `模型缺少骨骼 ${resolved.dropped.join('、')}，其旋轉份額已併入 ${resolved[resolved.length - 1].bone}`
      );
    }
    claim({
      id: mid('head'),
      enabled: true,
      input,
      mode: 'map',
      inRange: [-spec.total, spec.total],
      limit: true,
      smooth: 25,
      label: `頭部 ${spec.axis.toUpperCase()} 軸`,
      targets: resolved.map((r) => ({
        type: 'bone',
        name: r.bone,
        axis: spec.axis,
        outRange: [-spec.total * r.share, spec.total * r.share],
      })),
    });
  }

  // ── 頭部位移 → 根節點 ────────────────────────────────────
  claim(positionMapping('FacePositionX', 'x', 0.2));
  claim(positionMapping('FacePositionY', 'y', 0.1));

  // ── 眨眼 ────────────────────────────────────────────────
  const hasWink = caps.expressions.has('blinkLeft') && caps.expressions.has('blinkRight');
  if (hasWink) {
    claim(blinkMapping('EyeOpenLeft', 'blinkLeft', '左眼眨眼'));
    claim(blinkMapping('EyeOpenRight', 'blinkRight', '右眼眨眼'));
  } else if (caps.expressions.has('blink')) {
    // 退化：僅有 blink，改為雙眼連動（FR-01-10）
    claim(blinkMapping('EyeOpenLeft', 'blink', '眨眼（雙眼連動）'));
    settingsPatch.blinkLink = 'always';
    notes.push('模型僅有 blink 而無 blinkLeft／blinkRight，已退化為雙眼連動模式');
  } else {
    notes.push('模型無任何眨眼表情，已略過眨眼映射');
  }

  // ── 五母音口型 ──────────────────────────────────────────
  const missingVowels = [];
  for (const [input, expr] of VOWEL_MAP) {
    if (!caps.expressions.has(expr)) {
      missingVowels.push(expr);
      continue;
    }
    claim({
      id: mid('vowel'),
      enabled: true,
      input,
      mode: 'map',
      inRange: [0, 1],
      limit: true,
      smooth: 10,
      label: `母音 ${expr}`,
      targets: [{ type: 'expression', name: expr, outRange: [0, 1] }],
    });
  }
  if (missingVowels.length) {
    notes.push(`模型缺少母音表情 ${missingVowels.join('、')}，該部分口型將無作用`);
  }

  // ── 視線 ────────────────────────────────────────────────
  if (caps.hasLookAt) {
    // three-vrm 的 lookAt 會依模型的 applier 型態（bone 或 expression）
    // 自動轉譯 yaw/pitch，故此處不需分支處理。
    claim(gazeMapping('EyeGazeX', 'yaw', 12, '視線水平'));
    claim(gazeMapping('EyeGazeY', 'pitch', 8, '視線垂直'));
    if (caps.lookAtType === 'bone') {
      notes.push('模型視線型態為 Bone，已建立眼球骨骼驅動之視線映射');
    }
  } else if (caps.bones.has('leftEye') && caps.bones.has('rightEye')) {
    // 退化：無 lookAt 定義但有眼球骨骼，直接驅動骨骼
    claim({
      id: mid('gaze'),
      enabled: true,
      input: 'EyeGazeX',
      mode: 'map',
      inRange: [-1, 1],
      limit: true,
      smooth: 20,
      label: '視線水平（骨骼）',
      targets: [
        { type: 'bone', name: 'leftEye', axis: 'y', outRange: [-12, 12] },
        { type: 'bone', name: 'rightEye', axis: 'y', outRange: [-12, 12] },
      ],
    });
    notes.push('模型未定義 lookAt，已改以眼球骨骼直接驅動視線');
  } else {
    notes.push('模型無 lookAt 亦無眼球骨骼，已略過視線映射');
  }

  // ── 自動呼吸 ────────────────────────────────────────────
  // 頭部俯仰的骨骼鏈通常已佔用 chest.x，因此必須挑一個尚未被指派的目標，
  // 否則會違反 FR-03-04（同一輸出目標僅能被指派一次）。
  const breathBone = ['chest', 'upperChest', 'spine'].find(
    (b) => caps.bones.has(b) && !used.has(`bone:${b}:x`)
  );
  if (breathBone) {
    claim({
      id: mid('breath'),
      enabled: true,
      input: null,
      mode: 'autoBreath',
      inRange: [0, 1],
      limit: true,
      smooth: 0,
      label: '自動呼吸',
      options: { period: 4 },
      targets: [{ type: 'bone', name: breathBone, axis: 'x', outRange: [0, 2] }],
    });
  } else {
    notes.push('胸腔骨骼已被頭部俯仰映射佔用，已略過自動呼吸；可於映射分頁手動指派其他目標');
  }

  return { mappings, settingsPatch, notes };
}

function positionMapping(input, axis, range) {
  return {
    id: mid('pos'),
    enabled: true,
    input,
    mode: 'map',
    inRange: [-1, 1],
    limit: true,
    smooth: 35,
    label: `模型位移 ${axis.toUpperCase()}`,
    targets: [{ type: 'root', axis, outRange: [-range, range] }],
  };
}

function blinkMapping(input, expression, label) {
  return {
    id: mid('blink'),
    enabled: true,
    input,
    // 預設為單純映射；使用者可於介面切換為 autoBlink 以加入隨機眨眼
    mode: 'map',
    // 反向：輸入 1（睜眼）對應表情 0（未眨眼）
    inRange: [1, 0],
    limit: true,
    smooth: 8,
    label,
    options: { interval: 4, duration: 0.12 },
    targets: [{ type: 'expression', name: expression, outRange: [0, 1] }],
  };
}

function gazeMapping(input, axis, range, label) {
  return {
    id: mid('gaze'),
    enabled: true,
    input,
    mode: 'map',
    inRange: [-1, 1],
    limit: true,
    smooth: 20,
    label,
    targets: [{ type: 'lookAt', axis, outRange: [-range, range] }],
  };
}

/**
 * 依模型實際具備的骨骼解析骨骼鏈，並把缺漏骨骼的份額併入最後一個存在的骨骼。
 * 回傳陣列另掛 `dropped` 屬性列出被略過者（NFR-C-05）。
 */
function resolveChain(chain, bones) {
  const present = [];
  const dropped = [];
  let orphanShare = 0;

  for (const [bone, share] of chain) {
    if (bones.has(bone)) present.push({ bone, share });
    else {
      dropped.push(bone);
      orphanShare += share;
    }
  }

  if (present.length && orphanShare > 0) {
    present[present.length - 1].share += orphanShare;
  }

  present.dropped = dropped;
  return present;
}
