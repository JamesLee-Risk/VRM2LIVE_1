/**
 * 設定檔持久層 — FR-01-03、FR-01-16、FR-01-17、NFR-R-01～R-04。
 *
 * 兩類設定檔：
 *   Config/app_config.json      全域設定
 *   <模型>.vrmlive.json         逐模型設定（與 .vrm 同目錄）
 *
 * 三項不可妥協的性質：
 *   1. 人類可讀、未加密（NFR-R-02）
 *   2. 原子寫入：先寫 .tmp 再更名，避免寫入中斷造成半截檔（NFR-R-03）
 *   3. 損毀可復原：解析失敗時備份原檔並以預設值重建，絕不當機（NFR-R-04）
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

/** 設定檔結構版本，供跨版本遷移使用（NFR-M-02） */
const SCHEMA_VERSION = 1;

const BACKUP_KEEP = 10;
const BACKUP_INTERVAL_MS = 5 * 60 * 1000;

function defaultAppConfig() {
  return {
    schemaVersion: SCHEMA_VERSION,
    language: 'zh-TW',
    lastModel: null,
    render: { fps: 60, vsync: true, pixelRatio: 1 },
    output: { port: 8790, enabled: true },
    tracking: {
      source: 'webcam',
      deviceId: null,
      mirror: true,
      trackingFps: 30,
      lostBehavior: 'freeze', // 'freeze' | 'reset'
      lostResetSeconds: 1.5,
      blinkLink: 'never',
      blinkLinkAngle: 18,
      deadZone: 0.01,
      sensitivity: { headRotation: 1, headPosition: 1, eye: 1, brow: 1, mouth: 1 },
      // 語音口型（FR-02-C）
      lipsync: {
        enabled: false,
        deviceId: null,
        volumeGain: 4,
        volumeCutoff: 0.015,
        frequencyGain: 1,
        // 口型來源三選一（FR-02-48）：mic / camera / mixed
        mouthSource: 'mixed',
      },
    },
    scene: {
      background: { mode: 'transparent', color: '#00b140', url: null },
      lighting: {
        ambientColor: '#ffffff',
        ambientIntensity: 0.85,
        dirColor: '#ffffff',
        dirIntensity: 0.95,
        dirAzimuth: 30,
        dirElevation: 45,
        rimColor: '#aaccff',
        rimIntensity: 0,
      },
      lockModel: false,
      rememberScene: true,
    },
    // 熱鍵（FR-07）
    // global 標記的熱鍵存在這裡，切換模型時不會失效（FR-07-07）
    globalHotkeys: [],
    screenButtons: { visible: true, opacity: 0.75 },
    // 本機 HTTP 觸發（FR-07-05）：預設關閉，啟用時強制要求權杖
    hotkeyApi: { enabled: false, token: null },

    // 動畫（FR-06）
    animation: {
      mask: 'full',
      fade: 0.2,
      speed: 1,
      stopOnLastFrame: false,
    },
    screenshot: { dir: null, scale: 2, includeBackground: false },
  };
}

function defaultModelConfig(modelName) {
  return {
    schemaVersion: SCHEMA_VERSION,
    modelName,
    displayName: modelName,
    thumbnail: null,
    autoSetupDone: false,
    mappings: [],
    expressions: {},
    expressionGroups: [],
    hotkeys: [],
    poses: {},
    transformPresets: {},
    transform: { x: 0, y: 0, z: 0, rotY: 0, scale: 1 },
    camera: { preset: 'half', fov: 30 },
    springBone: { intensity: 1, colliders: true },
    idleAnimation: null,
  };
}

/** 深層合併：以 defaults 補齊 loaded 缺漏的欄位，容忍舊版設定檔 */
function mergeDefaults(loaded, defaults) {
  if (loaded === undefined) return structuredClone(defaults);

  // 預設值為 null 代表「這個欄位選用、且沒有型別資訊」（如 idleAnimation、
  // lipsync.templates）。此時必須原樣採用存檔的值：
  //   - 若往下走，Object.keys(null) 會直接拋例外
  //   - 若當成型別不符而回傳預設值，會把使用者的設定悄悄丟掉
  if (defaults === null) return loaded;

  if (loaded === null) return structuredClone(defaults);
  if (Array.isArray(defaults)) return Array.isArray(loaded) ? loaded : structuredClone(defaults);
  if (typeof defaults !== 'object') return typeof loaded === typeof defaults ? loaded : defaults;
  if (typeof loaded !== 'object' || Array.isArray(loaded)) return structuredClone(defaults);

  const out = {};
  for (const key of new Set([...Object.keys(defaults), ...Object.keys(loaded)])) {
    out[key] = key in defaults ? mergeDefaults(loaded[key], defaults[key]) : loaded[key];
  }
  return out;
}

class ConfigStore {
  /**
   * @param {string} rootDir 應用程式根目錄
   * @param {(level: string, msg: string) => void} log
   */
  constructor(rootDir, log = () => {}) {
    this.rootDir = rootDir;
    this.log = log;
    this.configDir = path.join(rootDir, 'Config');
    this.backupDir = path.join(rootDir, 'Backups');
    this.appConfigPath = path.join(this.configDir, 'app_config.json');
    this.calibrationPath = path.join(this.configDir, 'tracking_calibration.json');

    /** 待寫入的髒資料：path → object */
    this.dirty = new Map();
    /** 各檔案上次備份時間 */
    this.lastBackup = new Map();
    /** 唯讀檔案清單，避免重複警告（FR-01-17） */
    this.readOnly = new Set();

    this.warnings = [];
  }

  async init() {
    for (const dir of ['Config', 'Backups', 'Models', 'Animations', 'Backgrounds', 'Sounds', 'Logs']) {
      await fsp.mkdir(path.join(this.rootDir, dir), { recursive: true });
    }
    this.backupTimer = setInterval(() => this.runBackupSweep(), BACKUP_INTERVAL_MS);
  }

  // ── 讀取 ────────────────────────────────────────────────

  /**
   * 讀取 JSON；解析失敗時將原檔改名為 .corrupt-<時間> 後回傳 null，
   * 由呼叫端以預設值重建（NFR-R-04）。
   */
  async readJson(file) {
    let text;
    try {
      text = await fsp.readFile(file, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') this.log('warn', `讀取失敗 ${file}：${err.message}`);
      return null;
    }

    try {
      return JSON.parse(text);
    } catch (err) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const quarantine = `${file}.corrupt-${stamp}`;
      try {
        await fsp.rename(file, quarantine);
      } catch {
        /* 無法改名也不應阻斷啟動 */
      }
      const msg = `設定檔損毀，已隔離為 ${path.basename(quarantine)} 並以預設值重建：${path.basename(file)}`;
      this.log('error', `${msg}（${err.message}）`);
      this.warnings.push(msg);
      return null;
    }
  }

  async loadAppConfig() {
    const loaded = await this.readJson(this.appConfigPath);
    const cfg = mergeDefaults(loaded, defaultAppConfig());
    cfg.schemaVersion = SCHEMA_VERSION;
    if (!loaded) await this.writeJson(this.appConfigPath, cfg);
    this.appConfig = cfg;
    return cfg;
  }

  /**
   * 追蹤校準資料（FR-02-24、FR-02-44）。
   * 依規格 §6.3 存放於 Config/tracking_calibration.json，與模型設定分離，
   * 因為校準屬於「這台機器 / 這個人」的性質，換模型不應重做。
   */
  async loadCalibration() {
    const loaded = await this.readJson(this.calibrationPath);
    return mergeDefaults(loaded, {
      schemaVersion: SCHEMA_VERSION,
      // 攝影機中性原點
      webcam: { angleX: 0, angleY: 0, angleZ: 0, posX: 0, posY: 0, posZ: 0 },
      // 五母音樣板；null 表示使用內建的共振峰合成樣板
      lipsync: { templates: null, bandCount: 24 },
    });
  }

  async saveCalibration(data) {
    return this.save(this.calibrationPath, data);
  }

  /** @param {string} vrmPath .vrm 檔案完整路徑 */
  modelConfigPath(vrmPath) {
    const dir = path.dirname(vrmPath);
    const base = path.basename(vrmPath, path.extname(vrmPath));
    return path.join(dir, `${base}.vrmlive.json`);
  }

  async loadModelConfig(vrmPath) {
    const file = this.modelConfigPath(vrmPath);
    const name = path.basename(vrmPath, path.extname(vrmPath));
    const loaded = await this.readJson(file);
    const cfg = mergeDefaults(loaded, defaultModelConfig(name));
    cfg.schemaVersion = SCHEMA_VERSION;
    if (!loaded) await this.writeJson(file, cfg);
    return cfg;
  }

  // ── 寫入 ────────────────────────────────────────────────

  /**
   * 原子寫入（NFR-R-03）。目標檔唯讀時不寫入，改為記錄警告（FR-01-17）。
   * @returns {Promise<boolean>} 是否實際寫入
   */
  async writeJson(file, data) {
    if (await this._isReadOnly(file)) {
      if (!this.readOnly.has(file)) {
        this.readOnly.add(file);
        const msg = `設定檔為唯讀，變更不會被儲存：${path.basename(file)}`;
        this.log('warn', msg);
        this.warnings.push(msg);
      }
      return false;
    }

    const tmp = `${file}.tmp`;
    const text = JSON.stringify(data, null, 2);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(tmp, text, 'utf8');
    await fsp.rename(tmp, file);
    this.readOnly.delete(file);
    return true;
  }

  async _isReadOnly(file) {
    try {
      await fsp.access(file, fs.constants.W_OK);
      return false;
    } catch (err) {
      // 檔案不存在不算唯讀；只有存在但不可寫才算
      return err.code !== 'ENOENT';
    }
  }

  /** 標記為待寫入。設定變更即時寫入（NFR-R-01），此處僅做同幀合併。 */
  async save(file, data) {
    this.dirty.set(file, data);
    const ok = await this.writeJson(file, data);
    if (ok) await this._maybeBackup(file, data);
    return ok;
  }

  // ── 備份（FR-01-16）─────────────────────────────────────

  async _maybeBackup(file, data) {
    const last = this.lastBackup.get(file) ?? 0;
    if (Date.now() - last < BACKUP_INTERVAL_MS) return;
    await this.backup(file, data);
  }

  async backup(file, data) {
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const name = `${path.basename(file, '.json')}--${stamp}.json`;
      await fsp.mkdir(this.backupDir, { recursive: true });
      await fsp.writeFile(path.join(this.backupDir, name), JSON.stringify(data, null, 2), 'utf8');
      this.lastBackup.set(file, Date.now());
      await this._pruneBackups(path.basename(file, '.json'));
    } catch (err) {
      this.log('warn', `備份失敗 ${file}：${err.message}`);
    }
  }

  /** 每個來源檔僅保留最近 BACKUP_KEEP 份 */
  async _pruneBackups(prefix) {
    let entries;
    try {
      entries = await fsp.readdir(this.backupDir);
    } catch {
      return;
    }
    const mine = entries.filter((e) => e.startsWith(`${prefix}--`)).sort();
    for (const old of mine.slice(0, Math.max(0, mine.length - BACKUP_KEEP))) {
      await fsp.unlink(path.join(this.backupDir, old)).catch(() => {});
    }
  }

  /** 定期檢查：有變更才備份 */
  async runBackupSweep() {
    for (const [file, data] of this.dirty) {
      await this._maybeBackup(file, data);
    }
    this.dirty.clear();
  }

  dispose() {
    if (this.backupTimer) clearInterval(this.backupTimer);
  }

  takeWarnings() {
    const w = this.warnings;
    this.warnings = [];
    return w;
  }
}

module.exports = { ConfigStore, defaultAppConfig, defaultModelConfig, SCHEMA_VERSION };
