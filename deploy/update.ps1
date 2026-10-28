# Pull the latest code and rebuild/restart the container. Run from anywhere: powershell -File deploy\update.ps1
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
git pull --ff-only
docker compose up -d --build
docker compose ps
