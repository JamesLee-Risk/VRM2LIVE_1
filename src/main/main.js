/**
 * Electron 主行程 — 應用程式進入點。
 *
 * 職責：視窗生命週期、檔案系統存取、設定持久化、輸出伺服器。
 * 追蹤與渲染一律在 renderer 進行，主行程不碰 GPU 工作。
 */
const { app, BrowserWindow, ipcMain, shell, dialog, globalShortcut } = require('electron');
const fsp = require('node:fs/promises');
const crypto = require('node:crypto');
const path = require('node:path');

const { ConfigStore } = require('./config');
const { scanModels } = require('./models');
const { OutputServer } = require('./output-server');

// 應用程式根目錄：開發時為專案根，打包後為執行檔所在目錄
const ROOT_DIR = app.isPackaged ? path.dirname(app.getPath('exe')) : path.join(__dirname, '..', '..');
const BUILD_DIR = path.join(__dirname, '..', '..', 'build');
const LOG_DIR = path.join(ROOT_DIR, 'Logs');

let mainWindow = null;
let store = null;
let outputServer = null;
let logStream = null;

// ────────────────────────────────────────────────────────────────
// 日誌（NFR-S-04：純文字、本機、不含 IP 與完整路徑）
// ────────────────────────────────────────────────────────────────

async function initLog() {
  await fsp.mkdir(LOG_DIR, { recursive: true });
  const file = path.join(LOG_DIR, `vrm2live-${new Date().toISOString().slice(0, 10)}.log`);
  const fh = await fsp.open(file, 'a');
  logStream = fh.createWriteStream();
}

function log(level, msg) {
  const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] ${msg}\n`;
  if (logStream) logStream.write(line);
  if (level === 'error') console.error(line.trim());
  else console.log(line.trim());
}

// ────────────────────────────────────────────────────────────────
// 視窗
// ────────────────────────────────────────────────────────────────

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    backgroundColor: '#14161c',
    title: 'VRM2LIVE',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // 主視窗刻意經本機 HTTP 伺服器載入，而非 file://。
  // 原因：MediaPipe 的 wasm 執行期以 fetch() 取得資源，而 Chromium 禁止
  // file:// 來源發出 fetch；改用 http://127.0.0.1 後，追蹤引擎、模型檔與
  // 輸出頁面三者共用同一組來源規則，行為一致且無跨來源例外。
  if (outputServer?.port) {
    mainWindow.loadURL(`http://127.0.0.1:${outputServer.port}/index.html`);
  } else {
    log('error', '輸出伺服器未啟動，改以 file:// 載入；攝影機追蹤將無法使用');
    mainWindow.loadFile(path.join(BUILD_DIR, 'index.html'));
  }
  mainWindow.once('ready-to-show', () => mainWindow.show());

  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  // 自我測試模式：載入完成後請 renderer 跑完整管線並回報，接著結束程式
  if (process.argv.includes('--selftest')) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(() => mainWindow.webContents.send('selftest:run'), 800);
    });
    ipcMain.once('selftest:result', async (_e, result) => {
      // 追加一項只有主行程能驗證的檢查：真的開一個瀏覽器來源頁面，
      // 確認它會連上 WebSocket、收到場景、並把模型載起來（FR-15-01／FR-15-02）。
      result.checks.push(await verifyOutputPage());
      result.pass = result.checks.every((c) => c.ok);

      console.log('\n===== SELFTEST RESULT =====');
      console.log(JSON.stringify(result, null, 2));
      console.log('===== END SELFTEST =====\n');
      setTimeout(() => app.exit(result.pass ? 0 : 1), 300);
    });
    setTimeout(() => {
      console.log('\n===== SELFTEST TIMEOUT =====\n');
      app.exit(2);
    }, 120000);
  }

  // renderer 的未捕捉錯誤要進到日誌，否則除錯時完全看不到
  mainWindow.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    if (level >= 2) log('warn', `[renderer] ${message} (${sourceId}:${line})`);
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

/**
 * 以一個隱藏視窗模擬 OBS 瀏覽器來源，驗證輸出管線確實可用。
 * 僅在 --selftest 時呼叫。
 */
async function verifyOutputPage() {
  const check = { id: 'FR-15-02', desc: 'OBS 輸出頁面連線並載入模型（不重跑追蹤）', ok: false, detail: '' };
  if (!outputServer?.port) {
    check.detail = '輸出伺服器未啟動';
    return check;
  }

  const win = new BrowserWindow({
    width: 640,
    height: 480,
    show: false,
    webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false },
  });

  try {
    await win.loadURL(`http://127.0.0.1:${outputServer.port}/output.html?w=1920&h=1080&silent=1`);

    const deadline = Date.now() + 25000;
    let snap = null;
    while (Date.now() < deadline) {
      snap = await win.webContents.executeJavaScript(
        `(() => { const o = window.__vrm2liveOutput;
           return o ? { loaded: o.modelLoaded, url: o.modelUrl, state: o.receivedState, sock: o.socketOpen } : null; })()`
      );
      if (snap?.loaded && snap?.state) break;
      await new Promise((r) => setTimeout(r, 400));
    }

    check.ok = Boolean(snap?.loaded && snap?.state);
    check.detail = snap
      ? `socket=${snap.sock} 模型=${snap.loaded} 已收狀態=${snap.state} url=${snap.url ?? '無'}`
      : '頁面未暴露診斷介面';
  } catch (err) {
    check.detail = `例外：${err.message}`;
  } finally {
    win.destroy();
  }

  return check;
}

// ────────────────────────────────────────────────────────────────
// IPC
// ────────────────────────────────────────────────────────────────

function registerIpc() {
  // ── 環境資訊 ──────────────────────────────────────────────
  ipcMain.handle('app:info', async () => ({
    rootDir: ROOT_DIR,
    outputPort: outputServer?.port ?? null,
    outputUrl: outputServer?.port ? `http://127.0.0.1:${outputServer.port}/output.html` : null,
    version: app.getVersion(),
    warnings: store.takeWarnings(),
  }));

  // ── 設定 ─────────────────────────────────────────────────
  ipcMain.handle('config:loadApp', async () => store.loadAppConfig());

  ipcMain.handle('config:saveApp', async (_e, cfg) => {
    store.appConfig = cfg;
    return store.save(store.appConfigPath, cfg);
  });

  ipcMain.handle('config:loadModel', async (_e, vrmPath) => store.loadModelConfig(vrmPath));

  ipcMain.handle('config:loadCalibration', async () => store.loadCalibration());
  ipcMain.handle('config:saveCalibration', async (_e, data) => store.saveCalibration(data));

  ipcMain.handle('config:saveModel', async (_e, vrmPath, cfg) =>
    store.save(store.modelConfigPath(vrmPath), cfg)
  );

  // ── 模型 ─────────────────────────────────────────────────
  ipcMain.handle('models:scan', async () => scanModels(path.join(ROOT_DIR, 'Models')));

  ipcMain.handle('models:openFolder', async () => {
    const dir = path.join(ROOT_DIR, 'Models');
    await fsp.mkdir(dir, { recursive: true });
    shell.openPath(dir);
  });

  ipcMain.handle('models:import', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '匯入 VRM 模型',
      filters: [{ name: 'VRM 模型', extensions: ['vrm'] }],
      properties: ['openFile', 'multiSelections'],
    });
    if (result.canceled) return [];

    const dest = path.join(ROOT_DIR, 'Models');
    await fsp.mkdir(dest, { recursive: true });
    const copied = [];
    for (const src of result.filePaths) {
      const target = path.join(dest, path.basename(src));
      await fsp.copyFile(src, target);
      copied.push(target);
      log('info', `已匯入模型 ${path.basename(src)}`);
    }
    return copied;
  });

  /** 把絕對路徑轉成輸出伺服器可用的相對 URL，供輸出頁面載入同一個模型 */
  ipcMain.handle('models:toUrl', async (_e, absPath) => {
    const rel = path.relative(path.join(ROOT_DIR, 'Models'), absPath);
    if (rel.startsWith('..')) return null;
    return `/models/${rel.split(path.sep).map(encodeURIComponent).join('/')}`;
  });

  // ── 動畫（FR-06-01）───────────────────────────────────────
  ipcMain.handle('animations:scan', async () => {
    const dir = path.join(ROOT_DIR, 'Animations');
    await fsp.mkdir(dir, { recursive: true });

    const found = [];
    async function walk(current, depth) {
      if (depth > 3) return;
      const entries = await fsp.readdir(current, { withFileTypes: true }).catch(() => []);
      for (const e of entries) {
        const full = path.join(current, e.name);
        if (e.isDirectory()) {
          await walk(full, depth + 1);
        } else if (/\.(vrma|bvh)$/i.test(e.name)) {
          const rel = path.relative(dir, full);
          const stat = await fsp.stat(full);
          found.push({
            name: path.basename(e.name, path.extname(e.name)),
            file: e.name,
            kind: e.name.toLowerCase().endsWith('.bvh') ? 'bvh' : 'vrma',
            sizeBytes: stat.size,
            url: `/animations/${rel.split(path.sep).map(encodeURIComponent).join('/')}`,
          });
        }
      }
    }
    await walk(dir, 0);
    found.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant'));
    return found;
  });

  ipcMain.handle('animations:openFolder', async () => {
    const dir = path.join(ROOT_DIR, 'Animations');
    await fsp.mkdir(dir, { recursive: true });
    shell.openPath(dir);
  });

  // ── 背景 ─────────────────────────────────────────────────
  ipcMain.handle('backgrounds:scan', async () => {
    const dir = path.join(ROOT_DIR, 'Backgrounds');
    await fsp.mkdir(dir, { recursive: true });
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && /\.(jpg|jpeg|png|mp4|webm)$/i.test(e.name))
      .map((e) => ({
        name: e.name,
        url: `/backgrounds/${encodeURIComponent(e.name)}`,
        kind: /\.(mp4|webm)$/i.test(e.name) ? 'video' : 'image',
      }));
  });

  ipcMain.handle('backgrounds:openFolder', async () => {
    const dir = path.join(ROOT_DIR, 'Backgrounds');
    await fsp.mkdir(dir, { recursive: true });
    shell.openPath(dir);
  });

  // ── 輸出 ─────────────────────────────────────────────────
  ipcMain.on('output:state', (_e, state) => outputServer?.broadcastState(state));
  ipcMain.on('output:scene', (_e, scene) => outputServer?.broadcastScene(scene));
  ipcMain.handle('output:status', async () => ({
    port: outputServer?.port ?? null,
    clients: outputServer?.clientCount ?? 0,
  }));

  // ── 截圖（FR-15-09、FR-15-11）─────────────────────────────
  ipcMain.handle('screenshot:save', async (_e, dataUrl, options = {}) => {
    const dir = options.dir || path.join(app.getPath('pictures'), 'VRM2LIVE');
    await fsp.mkdir(dir, { recursive: true });
    // 含毫秒：同一秒內連拍兩張時檔名不可相撞，否則後者會覆蓋前者
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('Z', '');
    const file = path.join(dir, `VRM2LIVE-${stamp}.png`);
    const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');
    await fsp.writeFile(file, Buffer.from(base64, 'base64'));
    log('info', `已儲存截圖 ${path.basename(file)}`);
    return file;
  });

  ipcMain.handle('screenshot:openFolder', async (_e, dir) => {
    const target = dir || path.join(app.getPath('pictures'), 'VRM2LIVE');
    await fsp.mkdir(target, { recursive: true });
    shell.openPath(target);
  });

  // ── 全域熱鍵（FR-07-01）───────────────────────────────────
  ipcMain.handle('hotkeys:register', async (_e, bindings) => {
    globalShortcut.unregisterAll();

    // 註冊結果必須回報給介面。全域快捷鍵可能因為被其他程式占用而失敗，
    // 若只寫進日誌，使用者只會看到「按了沒反應」而無從得知原因。
    const failed = [];
    const registered = [];

    for (const b of bindings) {
      if (!b.accelerator) continue;
      try {
        const ok = globalShortcut.register(b.accelerator, () => {
          mainWindow?.webContents.send('hotkey:fired', b.id);
        });
        if (ok) registered.push(b.accelerator);
        else failed.push({ id: b.id, accelerator: b.accelerator, reason: '已被其他程式占用' });
      } catch (err) {
        failed.push({ id: b.id, accelerator: b.accelerator, reason: err.message });
      }
    }

    if (failed.length) {
      log('warn', `熱鍵註冊失敗：${failed.map((f) => `${f.accelerator}（${f.reason}）`).join('、')}`);
    }
    return { failed, registered };
  });

  /**
   * 設定熱鍵 HTTP 觸發（FR-07-05）。
   * 權杖由主行程產生，renderer 不得自行指定，避免被弱權杖繞過。
   */
  ipcMain.handle('hotkeys:configureApi', async (_e, enabled) => {
    if (!outputServer) return { enabled: false, token: null };

    const cfg = store.appConfig?.hotkeyApi ?? {};
    if (enabled && !cfg.token) {
      cfg.token = crypto.randomUUID().replace(/-/g, '');
    }
    cfg.enabled = Boolean(enabled);
    outputServer.hotkeyApi.enabled = cfg.enabled;
    outputServer.hotkeyApi.token = cfg.token;
    outputServer.hotkeyApi.onTrigger = (id) => mainWindow?.webContents.send('hotkey:fired', id);

    if (store.appConfig) {
      store.appConfig.hotkeyApi = cfg;
      await store.save(store.appConfigPath, store.appConfig);
    }
    log('info', `熱鍵 HTTP 觸發已${cfg.enabled ? '啟用' : '停用'}`);
    return { enabled: cfg.enabled, token: cfg.token, port: outputServer.port };
  });

  ipcMain.on('log', (_e, level, msg) => log(level, msg));

  ipcMain.handle('shell:openExternal', async (_e, url) => {
    // 僅允許本機輸出網址，避免成為任意開啟外部連結的管道
    if (/^http:\/\/127\.0\.0\.1:\d+\//.test(url)) shell.openExternal(url);
  });
}

// ────────────────────────────────────────────────────────────────
// 啟動
// ────────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  await initLog();
  log('info', `VRM2LIVE ${app.getVersion()} 啟動，根目錄 ${app.isPackaged ? '(打包)' : '(開發)'}`);

  store = new ConfigStore(ROOT_DIR, log);
  await store.init();
  const cfg = await store.loadAppConfig();

  outputServer = new OutputServer({ buildDir: BUILD_DIR, rootDir: ROOT_DIR, log });
  try {
    await outputServer.start(cfg.output?.port ?? 8790);
  } catch (err) {
    log('error', `輸出伺服器啟動失敗：${err.message}`);
  }

  // 還原上次的熱鍵 HTTP 觸發設定
  // 若設定顯示為啟用但權杖遺失（例如舊版設定或被覆寫），重新產生一組，
  // 否則端點會處於「已啟用但無法通過驗證」的狀態
  if (cfg.hotkeyApi?.enabled && !cfg.hotkeyApi.token) {
    cfg.hotkeyApi.token = crypto.randomUUID().replace(/-/g, '');
    await store.save(store.appConfigPath, cfg);
    log('warn', '熱鍵 HTTP 觸發的權杖遺失，已重新產生');
  }
  if (outputServer && cfg.hotkeyApi?.enabled && cfg.hotkeyApi.token) {
    outputServer.hotkeyApi.enabled = true;
    outputServer.hotkeyApi.token = cfg.hotkeyApi.token;
    outputServer.hotkeyApi.onTrigger = (id) => mainWindow?.webContents.send('hotkey:fired', id);
  }

  registerIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', async () => {
  globalShortcut.unregisterAll();
  store?.dispose();
  await outputServer?.stop();
  log('info', 'VRM2LIVE 結束');
  logStream?.end();
});
