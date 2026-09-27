@echo off
rem ============================================================
rem  雷霆酷跑 · 编译代码（TypeScript -> dist\）
rem  本机没有独立 Node.js，借用 Qoder 自带 Electron 以 Node 模式运行 tsc
rem ============================================================
setlocal
set ELECTRON_RUN_AS_NODE=1
"D:\qoder cn\Qoder CN.exe" "%~dp0tools\vendor\typescript\lib\tsc.js" -p "%~dp0tsconfig.json"
if %errorlevel%==0 (echo [OK] 编译成功) else (echo [FAIL] 编译失败，请看上方错误)
endlocal
pause
