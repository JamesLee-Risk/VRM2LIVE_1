/**
 * 輸出伺服器 — FR-15-01、FR-15-02、FR-15-03、FR-16-11、NFR-S-06。
 *
 * 提供兩件事：
 *   1. HTTP 靜態服務：把 build/output.html 交給 OBS 的「瀏覽器來源」
 *   2. WebSocket 廣播：把主視窗解算好的狀態推給輸出頁面
 *
 * 關鍵設計：輸出頁面**不執行追蹤**，只接收既有結果後渲染（FR-15-02），
 * 因此開啟 OBS 來源不會讓追蹤運算跑第二次。
 *
 * 預設僅綁定 127.0.0.1（NFR-S-06）。
 */
const http = require('node:http');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { WebSocketServer } = require('ws');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.task': 'application/octet-stream',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.vrm': 'model/gltf-binary',
  '.vrma': 'model/gltf-binary',
  '.bvh': 'text/plain; charset=utf-8',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

class OutputServer {
  /**
   * @param {object} opts
   * @param {string} opts.buildDir  build/ 目錄（靜態資源）
   * @param {string} opts.rootDir   應用程式根目錄（供模型／背景檔案讀取）
   * @param {(level:string,msg:string)=>void} opts.log
   */
  constructor({ buildDir, rootDir, log = () => {} }) {
    /** 熱鍵 HTTP 觸發設定（FR-07-05），由主行程設定 */
    this.hotkeyApi = { enabled: false, token: null, onTrigger: null };
    this.buildDir = buildDir;
    this.rootDir = rootDir;
    this.log = log;
    this.server = null;
    this.wss = null;
    this.port = null;
    this.clients = new Set();
    /** 最後一次狀態，供新連入的用戶端立即補上（避免黑畫面） */
    this.lastState = null;
    this.lastScene = null;
  }

  /**
   * 啟動。埠被占用時自動遞增（FR-16-11）。
   * @returns {Promise<number>} 實際使用的埠
   */
  async start(preferredPort = 8790, host = '127.0.0.1', maxTries = 20) {
    for (let i = 0; i < maxTries; i += 1) {
      const port = preferredPort + i;
      try {
        await this._listen(port, host);
        this.port = port;
        if (i > 0) {
          this.log('warn', `埠 ${preferredPort} 已被占用，改用 ${port}`);
        }
        this.log('info', `輸出伺服器啟動：http://${host}:${port}/output.html`);
        return port;
      } catch (err) {
        if (err.code !== 'EADDRINUSE') throw err;
      }
    }
    throw new Error(`自 ${preferredPort} 起連續 ${maxTries} 個埠皆被占用`);
  }

  _listen(port, host) {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => this._handle(req, res));

      const onError = (err) => {
        server.removeListener('listening', onListening);
        server.close();
        reject(err);
      };
      const onListening = () => {
        server.removeListener('error', onError);
        this.server = server;
        this._attachWebSocket(server);
        resolve();
      };

      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, host);
    });
  }

  _attachWebSocket(server) {
    this.wss = new WebSocketServer({ server, path: '/ws' });
    this.wss.on('connection', (ws) => {
      this.clients.add(ws);
      this.log('info', `輸出頁面已連線（目前 ${this.clients.size} 個）`);

      // 立即補送場景與最後狀態，讓新來源不必等下一幀
      if (this.lastScene) ws.send(JSON.stringify({ type: 'scene', payload: this.lastScene }));
      if (this.lastState) ws.send(JSON.stringify({ type: 'state', payload: this.lastState }));

      ws.on('close', () => {
        this.clients.delete(ws);
        this.log('info', `輸出頁面已離線（剩 ${this.clients.size} 個）`);
      });
      ws.on('error', () => this.clients.delete(ws));
    });
  }

  /** 廣播每幀解算結果。刻意不做序列化快取以外的處理，維持低延遲。 */
  broadcastState(state) {
    this.lastState = state;
    if (this.clients.size === 0) return;
    const msg = JSON.stringify({ type: 'state', payload: state });
    for (const ws of this.clients) {
      if (ws.readyState === 1) ws.send(msg);
    }
  }

  /** 廣播場景變更（換模型、背景、光照、攝影機） */
  broadcastScene(scene) {
    this.lastScene = scene;
    const msg = JSON.stringify({ type: 'scene', payload: scene });
    for (const ws of this.clients) {
      if (ws.readyState === 1) ws.send(msg);
    }
  }

  get clientCount() {
    return this.clients.size;
  }

  async _handle(req, res) {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      let pathname = decodeURIComponent(url.pathname);

      // 熱鍵 HTTP 觸發（FR-07-05）。預設關閉；啟用時仍要求權杖，
      // 避免本機上任何程式都能操控直播畫面。
      if (pathname.startsWith('/api/hotkey/')) {
        return this._handleHotkey(req, res, pathname.slice('/api/hotkey/'.length));
      }

      if (pathname === '/') pathname = '/output.html';

      // /models/ 與 /backgrounds/ 對應到應用程式根目錄下的使用者資料夾
      let filePath;
      if (pathname.startsWith('/models/')) {
        filePath = path.join(this.rootDir, 'Models', pathname.slice('/models/'.length));
        if (!this._isInside(filePath, path.join(this.rootDir, 'Models'))) return this._deny(res);
      } else if (pathname.startsWith('/animations/')) {
        filePath = path.join(this.rootDir, 'Animations', pathname.slice('/animations/'.length));
        if (!this._isInside(filePath, path.join(this.rootDir, 'Animations'))) return this._deny(res);
      } else if (pathname.startsWith('/backgrounds/')) {
        filePath = path.join(this.rootDir, 'Backgrounds', pathname.slice('/backgrounds/'.length));
        if (!this._isInside(filePath, path.join(this.rootDir, 'Backgrounds'))) return this._deny(res);
      } else {
        filePath = path.join(this.buildDir, pathname);
        if (!this._isInside(filePath, this.buildDir)) return this._deny(res);
      }

      const data = await fsp.readFile(filePath);
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME[ext] ?? 'application/octet-stream',
        'Cache-Control': 'no-store',
        'Cross-Origin-Resource-Policy': 'cross-origin',
      });
      res.end(data);
    } catch (err) {
      if (err.code === 'ENOENT') {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('404 找不到資源');
      } else {
        this.log('warn', `輸出伺服器錯誤：${err.message}`);
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('500 伺服器錯誤');
      }
    }
  }

  _handleHotkey(req, res, id) {
    const send = (code, body) => {
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
    };

    if (!this.hotkeyApi.enabled) return send(404, { error: '熱鍵 HTTP 觸發未啟用' });
    if (req.method !== 'POST') return send(405, { error: '僅接受 POST' });

    const token =
      req.headers['x-vrm2live-token'] ||
      new URL(req.url, 'http://localhost').searchParams.get('token');
    if (!this.hotkeyApi.token || token !== this.hotkeyApi.token) {
      this.log('warn', '熱鍵 HTTP 觸發：權杖錯誤，已拒絕');
      return send(401, { error: '權杖錯誤' });
    }

    if (!id) return send(400, { error: '缺少熱鍵 ID' });
    this.hotkeyApi.onTrigger?.(id);
    return send(200, { ok: true, id });
  }

  /** 防目錄穿越 */
  _isInside(target, base) {
    const rel = path.relative(base, target);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  }

  _deny(res) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('403 拒絕存取');
  }

  async stop() {
    for (const ws of this.clients) ws.terminate();
    this.clients.clear();
    if (this.wss) await new Promise((r) => this.wss.close(r));
    if (this.server) await new Promise((r) => this.server.close(r));
    this.server = null;
    this.wss = null;
  }
}

module.exports = { OutputServer };
