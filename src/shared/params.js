/**
 * 輸入參數登錄表 — 對應規格附錄 A-1。
 *
 * 此表為單一事實來源：追蹤器負責填值，映射引擎與 UI 皆由此表驅動。
 * 新增追蹤來源時只需在此登錄參數，不需修改解算迴圈（NFR-M-01）。
 */

/** 追蹤來源識別碼 */
export const SOURCES = {
  WEBCAM: 'webcam',
  PHONE: 'phone',
  ARKIT: 'arkit',
  VOICE: 'voice',
  MOUSE: 'mouse',
};

/**
 * @typedef {object} InputParam
 * @property {string} id       參數識別碼
 * @property {string} label    介面顯示名稱
 * @property {number} min      合理下限
 * @property {number} max      合理上限
 * @property {string} group    分組（供 UI 折疊）
 * @property {string[]} sources 哪些來源可提供此參數（FR-03-10 動態可用性）
 */

/** @type {InputParam[]} */
export const INPUT_PARAMS = [
  // ── 頭部位置 ──────────────────────────────────────────────
  { id: 'FacePositionX', label: '臉部水平位置', min: -1, max: 1, group: 'head', sources: ['webcam', 'phone', 'arkit'] },
  { id: 'FacePositionY', label: '臉部垂直位置', min: -1, max: 1, group: 'head', sources: ['webcam', 'phone', 'arkit'] },
  { id: 'FacePositionZ', label: '與鏡頭距離', min: -1, max: 1, group: 'head', sources: ['webcam', 'phone', 'arkit'] },

  // ── 頭部旋轉（度）─────────────────────────────────────────
  { id: 'FaceAngleX', label: '頭部左右旋轉 (Yaw)', min: -30, max: 30, group: 'head', sources: ['webcam', 'phone', 'arkit'] },
  { id: 'FaceAngleY', label: '頭部上下旋轉 (Pitch)', min: -30, max: 30, group: 'head', sources: ['webcam', 'phone', 'arkit'] },
  { id: 'FaceAngleZ', label: '頭部左右傾斜 (Roll)', min: -30, max: 30, group: 'head', sources: ['webcam', 'phone', 'arkit'] },

  // ── 眼睛 ─────────────────────────────────────────────────
  { id: 'EyeOpenLeft', label: '左眼張開', min: 0, max: 1, group: 'eye', sources: ['webcam', 'phone', 'arkit'] },
  { id: 'EyeOpenRight', label: '右眼張開', min: 0, max: 1, group: 'eye', sources: ['webcam', 'phone', 'arkit'] },
  { id: 'EyeLeftX', label: '左眼視線 X', min: -1, max: 1, group: 'eye', sources: ['webcam', 'phone', 'arkit'] },
  { id: 'EyeLeftY', label: '左眼視線 Y', min: -1, max: 1, group: 'eye', sources: ['webcam', 'phone', 'arkit'] },
  { id: 'EyeRightX', label: '右眼視線 X', min: -1, max: 1, group: 'eye', sources: ['webcam', 'phone', 'arkit'] },
  { id: 'EyeRightY', label: '右眼視線 Y', min: -1, max: 1, group: 'eye', sources: ['webcam', 'phone', 'arkit'] },
  // 合併視線：VRM 的 lookAt 只接受單一 yaw/pitch，故需雙眼平均值作為驅動來源。
  // 此為附錄 A-1 之外的衍生參數，由追蹤器自左右眼計算得出。
  { id: 'EyeGazeX', label: '雙眼視線 X（合併）', min: -1, max: 1, group: 'eye', sources: ['webcam', 'phone', 'arkit'] },
  { id: 'EyeGazeY', label: '雙眼視線 Y（合併）', min: -1, max: 1, group: 'eye', sources: ['webcam', 'phone', 'arkit'] },

  // ── 眉毛 ─────────────────────────────────────────────────
  { id: 'Brows', label: '雙眉合併上下', min: -1, max: 1, group: 'brow', sources: ['webcam', 'phone', 'arkit'] },
  { id: 'BrowLeftY', label: '左眉上下', min: -1, max: 1, group: 'brow', sources: ['webcam', 'phone', 'arkit'] },
  { id: 'BrowRightY', label: '右眉上下', min: -1, max: 1, group: 'brow', sources: ['webcam', 'phone', 'arkit'] },

  // ── 嘴 ───────────────────────────────────────────────────
  { id: 'MouthOpen', label: '張嘴程度', min: 0, max: 1, group: 'mouth', sources: ['webcam', 'phone', 'arkit'] },
  { id: 'MouthSmile', label: '微笑程度', min: 0, max: 1, group: 'mouth', sources: ['webcam', 'phone', 'arkit'] },
  { id: 'MouthX', label: '嘴部左右位移', min: -1, max: 1, group: 'mouth', sources: ['webcam', 'phone', 'arkit'] },

  // ── 僅 ARKit 可用（規格 L-08）────────────────────────────
  { id: 'CheekPuff', label: '鼓臉頰', min: 0, max: 1, group: 'mouth', sources: ['arkit'] },
  { id: 'TongueOut', label: '伸舌', min: 0, max: 1, group: 'mouth', sources: ['arkit'] },

  // ── 滑鼠 ─────────────────────────────────────────────────
  { id: 'MousePositionX', label: '滑鼠位置 X', min: -1, max: 1, group: 'mouse', sources: ['mouse'] },
  { id: 'MousePositionY', label: '滑鼠位置 Y', min: -1, max: 1, group: 'mouse', sources: ['mouse'] },

  // ── 語音（FR-02-41）──────────────────────────────────────
  { id: 'VoiceVolume', label: '麥克風音量', min: 0, max: 1, group: 'voice', sources: ['voice'] },
  { id: 'VoiceFrequency', label: '音素頻率', min: 0, max: 1, group: 'voice', sources: ['voice'] },
  { id: 'VoiceSilence', label: '靜音偵測', min: 0, max: 1, group: 'voice', sources: ['voice'] },
  { id: 'VoiceA', label: '母音 A', min: 0, max: 1, group: 'voice', sources: ['voice'] },
  { id: 'VoiceI', label: '母音 I', min: 0, max: 1, group: 'voice', sources: ['voice'] },
  { id: 'VoiceU', label: '母音 U', min: 0, max: 1, group: 'voice', sources: ['voice'] },
  { id: 'VoiceE', label: '母音 E', min: 0, max: 1, group: 'voice', sources: ['voice'] },
  { id: 'VoiceO', label: '母音 O', min: 0, max: 1, group: 'voice', sources: ['voice'] },
];

export const PARAM_BY_ID = new Map(INPUT_PARAMS.map((p) => [p.id, p]));

export const GROUP_LABELS = {
  head: '頭部',
  eye: '眼睛',
  brow: '眉毛',
  mouth: '嘴部',
  mouse: '滑鼠',
  voice: '語音',
};

/**
 * 建立一份所有輸入參數歸零的初始值表。
 * 眼睛張開度預設為 1（睜眼），否則模型初始會是閉眼。
 */
export function createInputState() {
  const state = Object.create(null);
  for (const p of INPUT_PARAMS) state[p.id] = 0;
  state.EyeOpenLeft = 1;
  state.EyeOpenRight = 1;
  state.VoiceSilence = 1;
  return state;
}
