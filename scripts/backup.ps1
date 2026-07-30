$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$src = Join-Path $root "instance\quality_dashboard.db"
$backupDir = Join-Path $root "backups"
New-Item -ItemType Directory -Force $backupDir | Out-Null
if (!(Test-Path $src)) { throw "DB 파일이 없습니다: $src" }
$stamp = Get-Date -Format "yyyyMMdd_HHmmss"
$dst = Join-Path $backupDir "quality_dashboard_$stamp.db"
Copy-Item -LiteralPath $src -Destination $dst
Write-Host "백업 완료: $dst"
