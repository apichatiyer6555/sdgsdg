# Creates .env (with a fresh APP_KEY) next to docker-compose.yml. Never overwrites an existing .env.
$root = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $root '.env'
if (Test-Path $envFile) { Write-Host '.env already exists - left untouched'; exit 0 }
$bytes = New-Object byte[] 32
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$key = [Convert]::ToBase64String($bytes)
$text = (Get-Content (Join-Path $root '.env.example') -Raw) -replace '(?m)^APP_KEY=.*$', "APP_KEY=$key"
[IO.File]::WriteAllText($envFile, $text, (New-Object Text.UTF8Encoding($false)))
New-Item -ItemType Directory -Force -Path (Join-Path $root 'backups') | Out-Null
Write-Host '.env created, APP_KEY generated. Back .env up together with the database: without APP_KEY saved accounts cannot be decrypted.'
