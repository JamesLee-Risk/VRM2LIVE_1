/**
 * VRM2LIVE 建置腳本
 *
 * 以 esbuild 將兩個進入點打包為單一檔案：
 *   - src/renderer/app.js  → build/renderer.js  （主視窗 / 工作室介面）
 *   - src/output/output.js → build/output.js    （OBS 瀏覽器來源頁面，FR-15-01）
 *
 * 兩者共用 src/shared/ 之解算與渲染程式碼，但為獨立 bundle：
 * 輸出頁面必須能以純 HTTP 交付給 OBS，不得依賴 Electron 的模組解析。
 */
import * as esbuild from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outdir = path.join(root, 'build');
const watch = process.argv.includes('--watch');

const options = {
  entryPoints: {
    renderer: path.join(root, 'src/renderer/app.js'),
    output: path.join(root, 'src/output/output.js'),
  },
  bundle: true,
  format: 'esm',
  splitting: false,
  outdir,
  sourcemap: true,
  target: ['chrome124'],
  logLevel: 'info',
  // MediaPipe 的 wasm loader 會探測 node 專屬全域變數，明確標示為瀏覽器平台
  platform: 'browser',
  define: { 'process.env.NODE_ENV': '"development"' },
};

async function copyStaticAssets() {
  await mkdir(outdir, { recursive: true });

  // MediaPipe wasm 執行期：自 node_modules 複製，不自 CDN 載入（NFR-S-01）
  const wasmSrc = path.join(root, 'node_modules/@mediapipe/tasks-vision/wasm');
  const wasmDst = path.join(outdir, 'mediapipe-wasm');
  if (existsSync(wasmSrc)) {
    await rm(wasmDst, { recursive: true, force: true });
    await cp(wasmSrc, wasmDst, { recursive: true });
  } else {
    console.warn('[build] 找不到 MediaPipe wasm，請先執行 npm install');
  }

  // 辨識模型檔（由 scripts/fetch-assets.mjs 取得）。
  // 缺少姿態／手部模型只會讓身體追蹤（FR-02-D）不可用，不影響臉部追蹤，故僅警告。
  for (const name of [
    'face_landmarker.task',
    'pose_landmarker_lite.task',
    'pose_landmarker_full.task',
    'hand_landmarker.task',
  ]) {
    const src = path.join(root, 'vendor', name);
    if (existsSync(src)) {
      await cp(src, path.join(outdir, name));
    } else {
      console.warn(`[build] 缺少 vendor/${name}，請執行: npm run fetch-assets`);
    }
  }

  // 靜態頁面
  for (const [from, to] of [
    ['src/renderer/index.html', 'index.html'],
    ['src/renderer/style.css', 'style.css'],
    ['src/output/output.html', 'output.html'],
  ]) {
    await cp(path.join(root, from), path.join(outdir, to));
  }
}

if (watch) {
  await copyStaticAssets();
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log('[build] 監看模式啟動');
} else {
  await esbuild.build(options);
  await copyStaticAssets();
  console.log('[build] 完成');
}
