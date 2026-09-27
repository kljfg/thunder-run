@echo off
rem ============================================================
rem  雷霆酷跑 · 本地测试：Vite 调试壳（先 tsc -b 产出各包，再起 dev server）
rem  测试地址 http://127.0.0.1:8767/index.html?debug
rem  若提示缺少 node_modules，先在项目目录执行 npm install
rem  （离线静态兜底：npm run build:web 后 python tools\serve.py）
rem ============================================================
setlocal
cd /d "%~dp0"
call npm run dev
endlocal
pause
