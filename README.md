# VRM2LIVE

以 VRM 3D 模型為核心的虛擬形象直播軟體。規格見 [VRM2LIVE_規格需求書.md](VRM2LIVE_規格需求書.md)；
接手開發前請先看 [開發交接.md](開發交接.md)（環境陷阱、進行中事項、未解決問題）。

目前完成度：**里程碑 M2（能播）與 M2.5（能動全身）完成** — 模型、臉部追蹤、半身／全身追蹤（含十指）、
語音口型、表情、動畫、熱鍵、場景、輸出皆可用。

---

## 快速開始

**雙擊 [`VRM2LIVE.bat`](VRM2LIVE.bat)** 即可。首次執行會自動安裝相依套件並下載臉部辨識模型，之後只需幾秒。

若偏好指令列：

```bash
npm install
npm run fetch-assets   # 下載 MediaPipe 臉部／姿態／手部模型（約 27 MB，只需一次）
npm start
```

> **為什麼要用 .bat 而不是直接 `npm start`**
> VS Code 的整合終端機會設定 `ELECTRON_RUN_AS_NODE=1`，這會讓 `electron.exe`
> 退化成純 Node 而開不出視窗（錯誤訊息為 `Cannot read properties of undefined
> (reading 'isPackaged')`）。`.bat` 會先清掉這個變數，並把免安裝版 Node
> 加進 PATH。
>
> `.bat` 本身以 **Big5 (cp950)** 編碼儲存 —— `cmd.exe` 以系統 OEM 編碼讀取批次檔，
> 若存成 UTF-8，中文位元組會被誤判為 Big5 前導位元組而吃掉換行，使整份指令碼解析錯亂。
> 編輯該檔時請維持此編碼。

把 `.vrm` 檔案放進 `Models/` 資料夾（或用介面上的「匯入 VRM…」），首次載入時會詢問是否執行自動設定。

> **本儲存庫不含任何 `.vrm` 模型。**
> 開發期使用的範例模型授權為 `Redistribution_Prohibited`（禁止再散布），
> 隨程式碼一起發布即構成再散布。`.gitignore` 因此排除所有 `.vrm`。
> 請自備模型；VRoid Hub、BOOTH 上都能取得可自由使用的 VRM。
>
> 測試用的動畫檔同樣未納入版控，執行 `npm run make-anims` 即可產生。

### 接到 OBS

1. 在「輸出」分頁複製網址（預設 `http://127.0.0.1:8790/output.html?w=1920&h=1080`）
2. OBS →「來源」→ 加入「瀏覽器」，貼上網址，寬高設為相同數值
3. 勾選「不可見時關閉來源」

輸出畫面帶透明通道、不含任何介面元素，且**不會重跑追蹤運算**——主視窗解算完把結果經 WebSocket 推給輸出頁面。

---

## 開發

| 指令 | 用途 |
| --- | --- |
| `npm run build` | 以 esbuild 打包 renderer 與 output |
| `npm run watch` | 監看模式 |
| `npm run dev` | 開啟 DevTools 啟動 |
| `npm start` | 建置後啟動 |
| `npm test` | 執行所有純邏輯測試 |
| `npm run test:dsp` | 語音口型訊號處理測試（不需麥克風／Electron）|
| `npm run test:hotkeys` | 熱鍵引擎測試（比對／冷卻／串接／衝突）|
| `npm run test:body` | 身體追蹤解算測試（合成骨架與地標，不需攝影機）|
| `npm run make-anims` | 產生測試用 `.vrma` / `.bvh` 動畫檔 |


### 打包成安裝檔

```bash
npm run icon    # 只在要重新產生圖示時執行
npm run dist    # 建置 + 產生 dist/VRM2LIVE-Setup-<版本>.exe
```

以 electron-builder 產生 NSIS 安裝檔。幾個刻意的設定：

| 設定 | 值 | 理由 |
| --- | --- | --- |
| `directories.buildResources` | `packaging/` | electron-builder 預設是 `build/`，那正好是 esbuild 的輸出目錄；不改的話它會把整包 bundle 當成打包資源而**排除在應用程式之外** |
| `perMachine` | `false` | 安裝到 `%LOCALAPPDATA%\Programs\VRM2LIVE`，不需要系統管理員權限。這也讓執行檔旁邊的 `Models/`、`Config/`、`Logs/` 可寫入——`ROOT_DIR` 在打包後就是執行檔所在目錄 |
| `files` 排除 `three`／`@pixiv`／`@mediapipe` | — | 這三包已由 esbuild 打進 `build/renderer.js`，執行期不會 `require`。不排除的話安裝檔會多出上百 MB |
| `files` 排除 `**/*.vrm` | — | **授權要求**，見下方「授權提醒」 |

安裝檔**不含任何 `.vrm` 模型與動畫素材**。首次啟動會在執行檔旁建立
`Models/`、`Animations/`、`Backgrounds/`、`Sounds/`、`Config/`、`Logs/`、`Backups/`，
把自己的 `.vrm` 放進 `Models/` 或用介面上的「匯入 VRM…」即可。

> 安裝檔**未經數位簽章**，Windows SmartScreen 會顯示「已保護您的電腦」。
> 需點「其他資訊」→「仍要執行」。要消除這個提示需要購買程式碼簽章憑證。

### 自我測試

```bash
node_modules/electron/dist/electron.exe . --selftest
```

會實際載入 `Models/` 內第一個模型、跑完整解算管線、開一個模擬 OBS 來源的隱藏視窗，
最後把 64–65 項檢查結果以 JSON 印出並依結果設定 exit code（項數視模型而定，含碰撞體的模型會多跑一項）。**打包後的執行檔同樣可以跑**（`dist\win-unpacked\VRM2LIVE.exe --selftest`），用來驗證打包沒有漏掉資源。截圖存到 `Logs/`（全身、臉部閉口、
臉部發 /a/、揮手中各一張，用於人工確認口型、著色與動畫）。

其中身體追蹤（FR-02-D）以**合成地標**驗證：量測真實模型的骨架 → 解算 → 套用 → 讀回骨骼世界座標，
確認「使用者舉左手」真的讓模型的右手抬高約 0.95 公尺，而不只是算出一組數字。

另有三組不需 Electron 的純邏輯測試（`npm test`）：
- **20 項**訊號處理測試：五母音辨識、音量無關性、噪音閘，以及
  「校準能否救回共振峰偏移 15% 的說話者」（實測 3/5 → 5/5）
- **47 項**熱鍵測試：accelerator 轉換、小鍵盤與數字列的區隔、系統全域與本機觸發的分流、
  衝突偵測、動作串接、冷卻、自動停止
- **47 項**身體追蹤測試：骨架基底量測（VRM 0.x／1.0 兩種朝向）、鏡像左右歸屬、肢段鏈、
  十指彎曲、缺骨骼退化、淡接與追蹤遺失、球面插值平滑、扭轉分解

> **在 VS Code 整合終端機執行時**：VS Code 會設定 `ELECTRON_RUN_AS_NODE=1`，
> 這會讓 `electron.exe` 退化成純 Node 而無法啟動視窗。執行前先清除該變數。

### 本機環境備註

本專案的 Node.js 以免安裝 zip 版放在 `.tools/node`（未進版控）。
若該目錄不存在，安裝任一 Node 20+ 即可，無特殊需求。

---

## 專案結構

```
src/
├── main/                 Electron 主行程（Node 環境）
│   ├── main.js           視窗、IPC、啟動流程
│   ├── preload.js        contextBridge，只暴露列舉過的能力
│   ├── config.js         設定持久化：原子寫入、備份輪替、損毀復原
│   ├── models.js         掃描 Models/、解析 VRM 中繼資料與授權
│   └── output-server.js  HTTP 靜態服務 + WebSocket 狀態廣播
├── shared/               主視窗與輸出頁面共用（瀏覽器環境）
│   ├── params.js         輸入參數登錄表（規格附錄 A-1）
│   ├── solver.js         映射引擎：區間映射、平滑、優先權仲裁
│   ├── autosetup.js      依模型能力自動建立映射，含退化處理
│   ├── lipsync.js        語音口型訊號處理（純函式，有獨立測試）
│   ├── animation.js      動畫層：.vrma/.bvh、骨骼遮罩、與追蹤的優先權仲裁
│   ├── hotkeys.js        熱鍵引擎：比對、冷卻、串接、衝突偵測（純邏輯，有獨立測試）
│   ├── bodysolver.js     身體姿態解算：地標 → 骨骼四元數（純幾何，有獨立測試）
│   └── stage.js          three.js + three-vrm 渲染舞台
├── renderer/             工作室主視窗
│   ├── app.js            協調層與介面繫結
│   ├── tracker.js        MediaPipe 臉部追蹤
│   ├── bodytracker.js    MediaPipe 姿態與手部追蹤（與臉部共用同一支攝影機）
│   └── audio.js          麥克風接線（訊號處理在 shared/lipsync.js）
└── output/               OBS 瀏覽器來源頁面
```

資料流見規格書 §3.3。

---

## 已實作 / 未實作

**已實作**

- FR-01 模型管理：掃描、VRM 0.x 與 1.0、授權旗標與警語、設定檔、備份、變換與攝影機
- FR-02 追蹤：Webcam（MediaPipe，52 項 ARKit blendshape）、滑鼠、校準（可持久化）、遺失行為、眨眼連動、靈敏度、參數監看器
- FR-02-C 語音口型：麥克風五母音辨識（mel 頻帶 + 倒頻譜比對）、音量增益／噪音閘／頻率增益、
  逐母音錄音校準、口型來源三選一（麥克風／攝影機／混合）
- FR-02-D 半身／全身追蹤：三種模式（僅臉部＋軀幹／半身／全身）即時切換與淡接、
  軀幹與脊椎鏈、肩膀、手臂、手腕、**十指**（每手 15 根骨骼）、腿部與腳掌、蹲下起立、
  逐部位開關與靈敏度、獨立取樣 FPS、姿態模型精度二選一、身體校準
- FR-03 映射引擎：三型態輸出目標、區間映射與反向、限幅、平滑、自動眨眼／呼吸、六級優先權仲裁
- FR-05 表情：清單、直接開關、淡入淡出、Overwrite／Add／Multiply
- FR-06 動畫：`.vrma` 與 `.bvh`（關節名稱重定向）、循環待機與一次性播放、骨骼遮罩
  （全身／上半身／下半身／手臂）、淡入淡出、播放速度、停在最後一幀（且不凍結追蹤骨骼）
- FR-07 熱鍵：鍵盤（預設僅視窗聚焦時生效，可逐項選擇加入系統全域；最多 2 修飾鍵 + 1 主鍵；
  小鍵盤可獨立綁定）、滑鼠、畫面按鈕（最多 8 個）、
  本機 HTTP 觸發（預設關閉、需權杖）、14 種動作、動作串接（最多 4 個）、
  冷卻、自動停止、放開即停、衝突偵測、逐項測試按鈕
- FR-01-13 搖動骨骼：硬度倍率、追加重力、阻尼倍率、碰撞體半徑倍率與開關，並顯示模型原始參數摘要
- FR-01-11 模型變換：位置／旋轉／縮放數值控制、滾輪與 Ctrl＋滾輪縮放（以注視點為支點）、
  依模型高度自動配置、落在鏡頭外時自動救回
- FR-11 場景：背景四模式、光照（環境／方向／邊緣）、攝影機取景、模型拖曳與鎖定
- FR-15 輸出：OBS 瀏覽器來源（透明）、串流模式、PNG 截圖

**尚未實作**

- FR-06 之錄製功能（FR-06-12：把追蹤結果錄成 `.vrma`）
- FR-02-08 所列之遊戲控制器輸入、眼動儀、外部動捕硬體（VR Tracker、慣性動捕服）
- FR-13 音效系統（`PlaySound` 熱鍵動作已保留編號，觸發時會明確提示尚未實作）
- FR-16 手機串流、FR-18 多人協作

---

## 實作備忘

開發過程中踩到、且不易從症狀反推原因的兩點：

**three.js 的 PropertyMixer 會跳過「值沒變」的寫入。**
若在兩次 `mixer.update()` 之間從外部改寫被動畫驅動的骨骼（例如每幀重設 rest pose
或套用基準 A-pose），混合器並不知情；一旦動畫進入靜止段落（值不再變動），
它就不再寫入，骨骼於是卡在外部寫入的值。症狀是「動畫播到一半，姿勢突然掉回去」，
而 `action.time`、`weight`、`isRunning()` 全部看起來正常。
因此 [stage.js](src/shared/stage.js) 的每幀重設與基準姿勢都會略過
`animator.animatedBones`。

**熱鍵必須以 `KeyboardEvent.code` 記錄，不能用 `event.key`。**
小鍵盤 1 與主鍵盤數字列 1 的 `key` 都是 `"1"`，用 `key` 記錄會讓「綁定小鍵盤」
實際註冊到數字列，按小鍵盤毫無反應。`code` 能區分 `Numpad1` 與 `Digit1`，
再分別轉成 Electron accelerator 的 `num1` 與 `1`。

**攝影機在 -Z 側，畫面右方等於世界座標 -X。**
任何把滑鼠水平位移換算成世界座標的程式碼都要取負號，否則拖曳方向會與滑鼠相反。
[stage.js](src/shared/stage.js) 的 `applyCameraPreset` 有相關註記。

**MediaPipe 的 handedness 標籤以「影像已鏡像」為前提。**
我們餵進去的是未鏡像的原始攝影機串流，直接採信 `handedness` 會讓左右手完全顛倒。
[bodytracker.js](src/renderer/bodytracker.js) 因此改以「手部地標的手腕位置離姿態地標的
哪一側手腕比較近」來歸屬，這與影像是否鏡像無關。

**「鏡像」是對矢狀面鏡射，x 分量取負與左右歸屬對調**兩件事**都要做**。
只做其中一件的症狀很難認：手會抬到正確的那一側，但整條手臂的彎曲方向是反的。
見 [bodysolver.js](src/shared/bodysolver.js) 的 `SIDE` 與 `HAND_OF` 對照表。

**身體追蹤的骨骼基準方向必須自模型量測，不能寫死座標軸。**
VRM 0.x 在自身空間朝 -Z、1.0 朝 +Z，寫死任一種都會讓另一種左右顛倒。
`buildRig` 以左右上臂連線、hips→head 連線建立基底，並把 rig 根節點的旋轉除掉，
使四元數鏈可以從單位四元數開始累乘。自我測試的 FR-02-65c 會抓出這類寫死。

**縮放的支點是攝影機注視點，不是模型原點。**
three.js 的 `scale` 以物件原點為支點，而 VRM 的原點在腳底；攝影機卻對著胸口
（半身 y=1.25）或臉（特寫 y=1.42）。以腳底縮放時，被看著的那一點會隨縮放上下跑：
半身取景一格滾輪只放大 6%，該點卻上移約 9% 的畫面高度，臉部特寫更達 22%。
**位移比大小變化還顯眼，使用者看到的是「模型往上移動」而不是「變大」。**
[stage.js](src/shared/stage.js) 的 `_applyTransform` 因此改為
`pos = t + (1 − s)·(p − t)`，讓縮放前位於注視點的那個模型點縮放後仍在原地。
自我測試的 FR-01-11d 直接斷言這個不變量。

**每次播放都新建 `AnimationClip` 會讓混合器的綁定失效。**
`clipAction()` 會為新的 clip 建立新的 action，反覆 activate/deactivate 共用的
PropertyMixer，最終導致不再套用。[animation.js](src/shared/animation.js)
因此以「動畫名＋遮罩＋排除骨骼」為鍵快取遮罩後的 clip。

---

## 授權提醒

`Models/` 內的 `.vrm` 檔案通常帶有作者授權限制。本軟體會在載入時顯示授權摘要，
並在涉及散布的功能上顯示警語。請自行確認你對所使用的模型具備合法使用權。
