# ivlyrics-sidecar uninstaller: unregisters and deletes the extension and the
# playlist-home app, then runs `spicetify apply`. ivLyrics itself is untouched.

$ErrorActionPreference = "Stop"
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator)
if ($admin) { Write-Host "Run this from a normal (non-administrator) PowerShell window." -ForegroundColor Red; return }

$userData = (spicetify path userdata 2>$null | Select-Object -Last 1).Trim()
if (-not $userData -or -not (Test-Path $userData)) { $userData = Join-Path $env:APPDATA "spicetify" }

spicetify config extensions ivlyrics-sidecar.js- 2>$null | Out-Null
spicetify config custom_apps playlist-home- 2>$null | Out-Null
Remove-Item (Join-Path $userData "Extensions\ivlyrics-sidecar.js") -Force -ErrorAction SilentlyContinue
Remove-Item (Join-Path $userData "CustomApps\playlist-home") -Recurse -Force -ErrorAction SilentlyContinue

spicetify apply
Write-Host "ivlyrics-sidecar removed." -ForegroundColor Green
