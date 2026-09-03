/**
 * 取得建置期外部資產。
 *
 * 需要 MediaPipe 的臉部、姿態與手部模型檔。此為**建置期**下載，
 * 下載後即納入本機 vendor/ 目錄；應用程式執行期不得再連線外部網域（NFR-S-01）。
 */
import { mkdir, writeFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vendor = path.join(root, 'vendor');

const ASSETS = [
  {
    name: 'face_landmarker.task',
    url: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
    minBytes: 1_000_000,
  },
  // 身體追蹤（FR-02-D）。輕量與標準兩種精度都取，供 FR-02-71 即時切換
  {
    name: 'pose_landmarker_lite.task',
    url: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
    minBytes: 2_000_000,
  },
  {
    name: 'pose_landmarker_full.task',
    url: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task',
    minBytes: 5_000_000,
  },
  {
    name: 'hand_landmarker.task',
    url: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
    minBytes: 5_000_000,
  },
];

await mkdir(vendor, { recursive: true });

for (const asset of ASSETS) {
  const dest = path.join(vendor, asset.name);
  try {
    const s = await stat(dest);
    if (s.size >= asset.minBytes) {
      console.log(`[fetch] 已存在，略過：${asset.name}（${(s.size / 1e6).toFixed(1)} MB）`);
      continue;
    }
  } catch {
    // 不存在，往下下載
  }

  console.log(`[fetch] 下載 ${asset.name} …`);
  const res = await fetch(asset.url);
  if (!res.ok) throw new Error(`下載失敗 ${asset.url}：HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < asset.minBytes) {
    throw new Error(`${asset.name} 大小異常（${buf.length} bytes），可能下載不完整`);
  }
  await writeFile(dest, buf);
  console.log(`[fetch] 完成：${asset.name}（${(buf.length / 1e6).toFixed(1)} MB）`);
}

console.log('[fetch] 全部資產就緒');
