@echo off
title VRM2LIVE
cd /d "%~dp0"

rem ===========================================================
rem  VRM2LIVE launcher
rem
rem  處理三件直接打 npm start 會踩到的事:
rem    1. 清除 ELECTRON_RUN_AS_NODE (VS Code 整合終端機會設定此變數,
rem       會讓 electron.exe 退化成純 Node 而開不出視窗)
rem    2. 把免安裝版 Node (.tools\node) 加進 PATH
rem    3. 首次執行時自動安裝相依套件並下載追蹤模型
rem
rem  用法: 直接雙擊本檔。
rem        也可加參數, 例如:  VRM2LIVE.bat --dev   (開啟 DevTools)
rem
rem  注意: 本檔以 Big5 (cp950) 編碼儲存, 因為 cmd.exe 會以系統 OEM codepage
rem        讀取批次檔; 若改存成 UTF-8, 中文位元組會被誤判為 Big5 前導位元組
rem        而吃掉換行, 導致整份指令碼解析錯亂。
rem ===========================================================

rem --- 1. 這個變數一定要清掉, 否則 Electron 不會啟動視窗 ---
set "ELECTRON_RUN_AS_NODE="

echo.
echo    VRM2LIVE
echo    ========
echo.

rem --- 2. 準備 Node ---
if exist ".tools\node\node.exe" set "PATH=%CD%\.tools\node;%PATH%"

where node >nul 2>&1
if errorlevel 1 goto no_node

rem --- 3. 相依套件 ---
if exist "node_modules\electron\dist\electron.exe" goto deps_ok

echo    [1/3] 首次執行, 安裝相依套件 (約需 1-2 分鐘) ...
call npm install --no-fund --no-audit
if errorlevel 1 goto install_failed

rem npm 11 預設封鎖安裝腳本, 而 electron/esbuild 需要它下載執行檔
if exist "node_modules\electron\dist\electron.exe" goto deps_ok
echo    核准 electron 與 esbuild 的安裝腳本 ...
call npm install-scripts approve electron >nul 2>&1
call npm install-scripts approve esbuild >nul 2>&1
call npm rebuild electron esbuild
if not exist "node_modules\electron\dist\electron.exe" goto install_failed

:deps_ok
echo    [1/3] 相依套件已就緒

rem --- 4. 臉部辨識模型 ---
if exist "vendor\face_landmarker.task" goto assets_ok
echo    [2/3] 下載臉部辨識模型 (約 3.8 MB, 只需一次) ...
call npm run fetch-assets
if errorlevel 1 goto fetch_failed

:assets_ok
echo    [2/3] 臉部辨識模型已就緒

rem --- 5. 建置 ---
echo    [3/3] 建置中 ...
call npm run build >nul 2>&1
if errorlevel 1 goto build_failed

rem --- 6. 啟動 ---
echo.
echo    啟動完成, 視窗即將開啟。
echo    OBS 來源網址請見程式內「輸出」分頁。
echo.

start "" "%CD%\node_modules\electron\dist\electron.exe" "%CD%" %*
exit /b 0


rem ===========================================================
rem  錯誤處理: 出錯時保留視窗, 讓使用者看得到訊息
rem ===========================================================

:no_node
echo.
echo    [錯誤] 找不到 Node.js。
echo.
echo    請擇一處理:
echo      a) 安裝 Node.js 20 以上: https://nodejs.org/
echo      b) 把免安裝版解壓到本資料夾的 .tools\node\
echo         (該目錄下應直接看得到 node.exe)
echo.
pause
exit /b 1

:install_failed
echo.
echo    [錯誤] 相依套件安裝失敗。
echo    請確認網路連線後重試; 若持續失敗, 可手動執行:
echo        npm install
echo.
pause
exit /b 1

:fetch_failed
echo.
echo    [錯誤] 臉部辨識模型下載失敗。
echo    這只影響攝影機追蹤, 其餘功能仍可使用。
echo    可稍後手動執行:  npm run fetch-assets
echo.
pause
exit /b 1

:build_failed
echo.
echo    [錯誤] 建置失敗。詳細訊息:
echo.
call npm run build
echo.
pause
exit /b 1
