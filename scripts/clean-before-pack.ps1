# clean-before-pack.ps1 — 打包前清理（开发机上跑）
# 注意：本脚本只做"安全的清理项"，**不清 key、不删 config.json 本体**。
#       清 key 必须由用户在干净机上确认后手动执行（脚本只打印醒目提示）。
# 用法：powershell -ExecutionPolicy Bypass -File scripts\clean-before-pack.ps1
$ErrorActionPreference = 'Continue'
$ROOT = Split-Path -Parent $PSScriptRoot
Write-Host "=== AICraft 打包前清理 ===" -ForegroundColor Cyan
Write-Host "项目根: $ROOT`n"

$steps = @()

# 1. 清日志
$logs = Join-Path $ROOT 'logs'
if (Test-Path -LiteralPath $logs) {
  Get-ChildItem -LiteralPath $logs -Recurse -File | ForEach-Object {
    try { Remove-Item -LiteralPath $_.FullName -Force; $steps += "删 $($_.FullName)" } catch {}
  }
  Write-Host "[1/6] logs\ 已清空" -ForegroundColor Green
}

# 2. 清 server\logs
$srvLogs = Join-Path $ROOT 'server\logs'
if (Test-Path -LiteralPath $srvLogs) {
  Get-ChildItem -LiteralPath $srvLogs -Recurse -File | ForEach-Object { try { Remove-Item -LiteralPath $_.FullName -Force } catch {} }
  Write-Host "[2/6] server\logs\ 已清空" -ForegroundColor Green
}

# 3. 删 server\snapshots（快照是开发者本机状态，不进发行包）
$snap = Join-Path $ROOT 'server\snapshots'
if (Test-Path -LiteralPath $snap) {
  Remove-Item -LiteralPath $snap -Recurse -Force
  Write-Host "[3/6] server\snapshots\ 已删除" -ForegroundColor Green
}

# 4. 删 *.bak-*（除主调度统一备份外，残留的开发 .bak 全清）
Get-ChildItem -LiteralPath $ROOT -Recurse -Filter '*.bak-*' -File | ForEach-Object {
  try { Remove-Item -LiteralPath $_.FullName -Force; $steps += "删 $($_.FullName)" } catch {}
}
Write-Host "[4/6] *.bak-* 残留已清理" -ForegroundColor Green

# 5. server.properties 的 management-server-secret 清空（不碰 rcon.password，首启 center 会重新生成）
$props = Join-Path $ROOT 'server\server.properties'
if (Test-Path -LiteralPath $props) {
  $content = Get-Content -LiteralPath $props -Raw -Encoding UTF8
  $content = $content -replace 'management-server-secret=.*', 'management-server-secret='
  Set-Content -LiteralPath $props -Value $content -Encoding UTF8 -NoNewline
  Write-Host "[5/6] server.properties management-server-secret 已清空" -ForegroundColor Green
}

# 6. 检查 config.json / config.template.json
$cfg = Join-Path $ROOT 'config.json'
$tpl = Join-Path $ROOT 'config.template.json'
Write-Host "[6/6] 配置文件检查:" -ForegroundColor Green
if (Test-Path -LiteralPath $cfg) { Write-Host "  保留开发 config.json（含真实 key，**不删**）" -ForegroundColor Yellow }
if (Test-Path -LiteralPath $tpl) { Write-Host "  config.template.json 在位（key 全空，可随包发）" }

Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host "⚠️  清 key 需用户在干净机确认后手动执行：" -ForegroundColor Red
Write-Host "   - 把 config.template.json 复制为 config.json" -ForegroundColor Red
Write-Host "   - 删除所有 config.json.bak-*" -ForegroundColor Red
Write-Host "   - 确认 bots\personas\*.json 不含任何 key" -ForegroundColor Red
Write-Host "   - 删除 server\world\（首启 MC 全新生成）" -ForegroundColor Red
Write-Host "========================================`n" -ForegroundColor Cyan
Write-Host "清理完成，共处理 $($steps.Count) 个文件。" -ForegroundColor Green
