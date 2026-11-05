@echo off
chcp 65001 >nul
title AICraft — AI 工人沙盒
cd /d "%~dp0"
echo ============================================
echo    AICraft — AI 工人沙盒
echo    正在启动，请稍候…
echo ============================================
echo.

REM 绿色运行时主程序（与运行库同目录，会自动加载本程序并拉起后端）
set "AICRAFT_EXE=%~dp0app\electron-dist\AICraft.exe"
if not exist "%AICRAFT_EXE%" (
  echo [错误] 未找到主程序：%AICRAFT_EXE%
  echo 请确认文件夹解压完整后重试。
  pause
  exit /b 1
)

REM 以运行时目录为工作目录启动（双击 exe 等效）
start "" /D "%~dp0app\electron-dist" "%AICRAFT_EXE%"
exit /b 0
