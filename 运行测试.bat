@echo off
rem ============================================================
rem  雷霆酷跑 · 一键质量检查：编译 + 单元测试 + 配置校验 + 架构禁令
rem  全部通过输出 ALL PASS；任何一步失败会停住并显示原因
rem  依赖本机 Node v24 + npm（首次使用请先执行 npm install）
rem ============================================================
setlocal
cd /d "%~dp0"
call node tools\check.mjs
if not %errorlevel%==0 echo ############ 存在失败项，请先修复 ############
endlocal
pause
