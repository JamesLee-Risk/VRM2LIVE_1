/**
 * 產生應用程式圖示 `packaging/icon.png`（512×512）。
 *
 * 刻意不引入影像函式庫：整個專案的相依只有 three、mediapipe、ws 與 esbuild，
 * 為了一張圖示再拉一包進來並不划算。PNG 的最小可用編碼（IHDR + IDAT + IEND、
 * 濾波器一律 0）用 node:zlib 就寫得完。
 *
 * .ico 由 electron-builder 於打包時自 PNG 轉出，因此這裡只需要一張夠大的 PNG。
 *
 * 執行：node scripts/make-icon.mjs
 */
import zlib from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SIZE = 512;
const SS = 3; // 超取樣倍率，用來做邊緣抗鋸齒

// 介面配色（與 style.css 的 --bg / --accent 一致）
const BG = [0x14, 0x16, 0x1c];
const ACCENT = [0x4d, 0xa3, 0xff];

/** 圓角正方形：回傳該點是否位於形狀內 */
function inRoundedRect(x, y, size, radius) {
  const cx = Math.min(Math.max(x, radius), size - radius);
  const cy = Math.min(Math.max(y, radius), size - radius);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= radius * radius;
}

/** 頭肩剪影：頭部圓形 + 肩部橢圓上緣，中間留一段頸部空隙 */
function inBust(x, y) {
  const head = (x - 256) ** 2 + (y - 196) ** 2 <= 86 ** 2;
  const shoulders =
    ((x - 256) / 176) ** 2 + ((y - 470) / 168) ** 2 <= 1 && y >= 300 && y <= 430;
  return head || shoulders;
}

const rgba = Buffer.alloc(SIZE * SIZE * 4);

for (let y = 0; y < SIZE; y += 1) {
  for (let x = 0; x < SIZE; x += 1) {
    let bgHits = 0;
    let fgHits = 0;
    for (let sy = 0; sy < SS; sy += 1) {
      for (let sx = 0; sx < SS; sx += 1) {
        const px = x + (sx + 0.5) / SS;
        const py = y + (sy + 0.5) / SS;
        if (!inRoundedRect(px, py, SIZE, 96)) continue;
        bgHits += 1;
        if (inBust(px, py)) fgHits += 1;
      }
    }

    const total = SS * SS;
    const alpha = Math.round((bgHits / total) * 255);
    // 前景覆蓋率以背景為底做混合，邊緣才不會出現黑邊
    const k = bgHits ? fgHits / bgHits : 0;
    const i = (y * SIZE + x) * 4;
    for (let c = 0; c < 3; c += 1) {
      rgba[i + c] = Math.round(BG[c] * (1 - k) + ACCENT[c] * k);
    }
    rgba[i + 3] = alpha;
  }
}

// ── PNG 編碼 ──────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
// 10–12：壓縮、濾波、交錯皆為 0

// 每列前面補一個濾波器位元組（0 = None）
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y += 1) {
  raw[y * (SIZE * 4 + 1)] = 0;
  rgba.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const dest = path.join(root, 'packaging', 'icon.png');
await mkdir(path.dirname(dest), { recursive: true });
await writeFile(dest, png);
console.log(`[icon] 已產生 ${path.relative(root, dest)}（${SIZE}×${SIZE}，${(png.length / 1024).toFixed(1)} KB）`);
