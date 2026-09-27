@echo off
rem ============================================================
rem  雷霆酷跑 · 编译代码（tsc -b：packages/* + apps/web 全量增量编译）
rem  依赖本机 Node v24 + npm workspaces（首次使用请先执行 npm install）
rem  旧「借 Qoder Electron 当 Node」方案已退役；离线兜底仍可用
rem  node tools\vendor\typescript\lib\tsc.js -b （无网络机器）
rem ============================================================
setlocal
cd /d "%~dp0"
call npm run build
if %errorlevel%==0 (echo [OK] 编译成功) else (echo [FAIL] 编译失败，请看上方错误)
endlocal
pause
