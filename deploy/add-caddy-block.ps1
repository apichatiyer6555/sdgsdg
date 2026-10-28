# Adds the zaliv.vibecods.xyz block to the shared Caddyfile: backup first, validate, roll back automatically on any failure, then reload Caddy.
param([string]$CaddyDir = 'D:\server-projects\reverse-proxy', [string]$Container = 'server-caddy')
$cf = Join-Path $CaddyDir 'Caddyfile'
$text = [IO.File]::ReadAllText($cf)
if ($text -match '(?m)^zaliv\.vibecods\.xyz\s*\{') { Write-Host 'zaliv block already present - nothing to do'; exit 0 }
$backup = "$cf.backup-zaliv-" + (Get-Date -Format 'yyyyMMdd-HHmmss')
Copy-Item $cf $backup
$block = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'caddy-zaliv.conf'))
if (-not $text.EndsWith("`n")) { $text += "`n" }
$utf8 = New-Object Text.UTF8Encoding($false)
[IO.File]::WriteAllText($cf, $text + "`n" + $block.TrimEnd() + "`n", $utf8)
docker exec $Container caddy validate --config /etc/caddy/Caddyfile
if ($LASTEXITCODE -ne 0) { Copy-Item $backup $cf -Force; Write-Host 'VALIDATION FAILED - Caddyfile restored from backup'; exit 1 }
docker exec $Container caddy reload --config /etc/caddy/Caddyfile
if ($LASTEXITCODE -ne 0) { Copy-Item $backup $cf -Force; Write-Host 'RELOAD FAILED - Caddyfile restored from backup'; exit 1 }
Write-Host "OK: zaliv block added, Caddy reloaded. Backup: $backup"
