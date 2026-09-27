@echo off
rem ============================================================
rem  雷霆酷跑 · 一键质量检查：编译 + 单元测试 + 配置校验 + 架构禁令
rem  全部通过输出 ALL PASS；任何一步失败会停住并显示原因
rem ============================================================
setlocal
cd /d "%~dp0"
set NODE="D:\qoder cn\Qoder CN.exe"
set ELECTRON_RUN_AS_NODE=1

echo [1/4] 编译 TypeScript...
%NODE% "%~dp0tools\vendor\typescript\lib\tsc.js" -p "%~dp0tsconfig.json" || goto fail

echo [2/4] 运行单元测试...
%NODE% --test || goto fail

echo [3/4] 配置校验...
%NODE% "%~dp0tools\validate-config.mjs" || goto fail

echo [4/4] 架构禁令检查...
%NODE% "%~dp0tools\check-import-rules.mjs" || goto fail

echo.
echo ============ ALL PASS ============
goto end
:fail
echo.
echo ############ 存在失败项，请先修复 ############
exit /b 1
:end
pause
