@echo off
chcp 65001 >nul
title 创建 AICraft 桌面快捷方式
set "EXE=%~dp0app\electron-dist\AICraft.exe"
set "WD=%~dp0app\electron-dist"

if not exist "%EXE%" (
  echo [错误] 未找到主程序：%EXE%
  echo 请确认文件夹解压完整后重试。
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -Command "$ws=New-Object -ComObject WScript.Shell; $d=$ws.SpecialFolders('Desktop'); $p=Join-Path $d 'AICraft.lnk'; $lnk=$ws.CreateShortcut($p); $lnk.TargetPath='%EXE%'; $lnk.WorkingDirectory='%WD%'; $lnk.IconLocation='%EXE%,0'; $lnk.Description='AICraft — AI 工人沙盒'; $lnk.Save(); Write-Host ''; Write-Host '已在桌面创建快捷方式：AICraft' -ForegroundColor Green; Write-Host ('位置：' + $p)"

echo.
echo 以后双击桌面上的 AICraft 图标即可开始游戏。
pause
