param([Parameter(Mandatory=$true)][string]$BackupFile)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$dstDir = Join-Path $root "instance"
$dst = Join-Path $dstDir "quality_dashboard.db"
if (!(Test-Path $BackupFile)) { throw "백업 파일이 없습니다: $BackupFile" }
New-Item -ItemType Directory -Force $dstDir | Out-Null
Copy-Item -LiteralPath $BackupFile -Destination $dst -Force
Write-Host "복구 완료: $dst"
