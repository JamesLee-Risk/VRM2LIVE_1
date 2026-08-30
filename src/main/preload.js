/**
 * Preload 橋接。
 *
 * renderer 以 contextIsolation 執行，不得直接取用 Node API。
 * 這裡只暴露明確列舉的能力，不轉發任意 ipc 通道。
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('vrm2live', {
  info: () => ipcRenderer.invoke('app:info'),

  config: {
    loadApp: () => ipcRenderer.invoke('config:loadApp'),
    saveApp: (cfg) => ipcRenderer.invoke('config:saveApp', cfg),
    loadModel: (vrmPath) => ipcRenderer.invoke('config:loadModel', vrmPath),
    saveModel: (vrmPath, cfg) => ipcRenderer.invoke('config:saveModel', vrmPath, cfg),
    loadCalibration: () => ipcRenderer.invoke('config:loadCalibration'),
    saveCalibration: (data) => ipcRenderer.invoke('config:saveCalibration', data),
  },

  models: {
    scan: () => ipcRenderer.invoke('models:scan'),
    openFolder: () => ipcRenderer.invoke('models:openFolder'),
    import: () => ipcRenderer.invoke('models:import'),
    toUrl: (p) => ipcRenderer.invoke('models:toUrl', p),
  },

  animations: {
    scan: () => ipcRenderer.invoke('animations:scan'),
    openFolder: () => ipcRenderer.invoke('animations:openFolder'),
  },

  backgrounds: {
    scan: () => ipcRenderer.invoke('backgrounds:scan'),
    openFolder: () => ipcRenderer.invoke('backgrounds:openFolder'),
  },

  output: {
    sendState: (state) => ipcRenderer.send('output:state', state),
    sendScene: (scene) => ipcRenderer.send('output:scene', scene),
    status: () => ipcRenderer.invoke('output:status'),
  },

  screenshot: {
    save: (dataUrl, options) => ipcRenderer.invoke('screenshot:save', dataUrl, options),
    openFolder: (dir) => ipcRenderer.invoke('screenshot:openFolder', dir),
  },

  hotkeys: {
    register: (bindings) => ipcRenderer.invoke('hotkeys:register', bindings),
    configureApi: (enabled) => ipcRenderer.invoke('hotkeys:configureApi', enabled),
    onFired: (cb) => {
      const handler = (_e, id) => cb(id);
      ipcRenderer.on('hotkey:fired', handler);
      return () => ipcRenderer.removeListener('hotkey:fired', handler);
    },
  },

  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  log: (level, msg) => ipcRenderer.send('log', level, msg),

  // 自我測試：由 --selftest 啟動旗標觸發，用於驗收準則之自動化驗證
  selftest: {
    onRun: (cb) => ipcRenderer.on('selftest:run', () => cb()),
    report: (result) => ipcRenderer.send('selftest:result', result),
  },
});
