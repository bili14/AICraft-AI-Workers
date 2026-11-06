# pack-aicraft.ps1 — AICraft 打包脚本（干净机测试通过后，用户在开发机跑）
# 做法：把整个项目按 scripts\pack-exclude-list.txt 的口径 robocopy 到暂存目录，
#       再把 config.template.json 作为首启 config.json（无 key），最后校验 viewer 回环 patch。
# 注意：本脚本不删开发机任何文件；运行前请先跑 clean-before-pack.ps1。
param(
  [string]$Out = 'E:\Doubao\DB work\release\AICraft'
)
$ErrorActionPreference = 'Stop'
$ROOT = Split-Path -Parent $PSScriptRoot
Write-Host "=== AICraft 打包 ===" -ForegroundColor Cyan
Write-Host "源: $ROOT"
Write-Host "暂存: $Out`n"

# 1) 清空/新建暂存目录
if (Test-Path -LiteralPath $Out) { Remove-Item -LiteralPath $Out -Recurse -Force }
New-Item -ItemType Directory -Path $Out -Force | Out-Null

# 2) robocopy（/MIR 镜像；/XD 排除目录；/XF 排除文件；/NFL /NDL 少打印）
$xd = @(
  (Join-Path $ROOT 'server\world'),
  (Join-Path $ROOT 'server\snapshots'),
  (Join-Path $ROOT '.git')
)
$xf = @(
  'config.json',
  'docs\公众号稿.md',
  'Thumbs.db',
  'Desktop.ini',
  '.DS_Store'
)
$args = @($ROOT, $Out, '/E', '/R:1', '/W:1', '/NFL', '/NDL', '/NJH')
if ($xd.Count) { $args += '/XD'; $args += $xd }
if ($xf.Count) { $args += '/XF'; $args += $xf }
& robocopy @args | Out-Null
# robocopy 退出码 0-7 都算成功
if ($LASTEXITCODE -ge 8) { throw "robocopy 失败 code=$LASTEXITCODE" }

# 3) 递归删除残留 .bak / *.pre-rollback / *.pre-reset / *.log / *.jsonl（exclude 口径）
Get-ChildItem -LiteralPath $Out -Recurse -Force -ErrorAction SilentlyContinue |
  Where-Object {
    $_.Name -like '*.bak-*' -or $_.Name -like '*.pre-rollback-*' -or
    $_.Name -like '*.pre-reset-*' -or $_.Name -like '*.log' -or $_.Name -like '*.jsonl' -or
    $_.Name -eq 'center.port.json' -or $_.Name -eq 'bot-state-*.json'
  } | ForEach-Object { try { Remove-Item -LiteralPath $_.FullName -Force -Recurse } catch {} }

# 4) 发行 config：用模板（无 key），首启向导会引导
$tpl = Join-Path $Out 'config.template.json'
$cfg = Join-Path $Out 'config.json'
if (Test-Path -LiteralPath $tpl) {
  Copy-Item -LiteralPath $tpl -Destination $cfg -Force
  Write-Host "[OK] 已用 config.template.json 生成首启 config.json（无 key）" -ForegroundColor Green
} else { throw '缺少 config.template.json' }

# 5) 校验 viewer 回环 patch
$node = Join-Path $ROOT 'runtime\node\node.exe'
$verify = Join-Path $ROOT 'scripts\verify-viewer-loopback.js'
& $node $verify
if ($LASTEXITCODE -ne 0) { throw 'viewer 回环校验失败' }

Write-Host "`n=== 打包完成 ===" -ForegroundColor Cyan
Write-Host "发行目录: $Out" -ForegroundColor Green
Write-Host "下一步：把 $Out 整个拷到干净机，按 clean-machine-smoke.md 20 项过。" -ForegroundColor Yellow
