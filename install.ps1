# spotiflux installer (Windows, PowerShell 5+).
# Run from a cloned repo:   .\install.ps1
# Or straight from GitHub:  irm https://raw.githubusercontent.com/gigacook/spotiflux/main/install.ps1 | iex
# Copies the extension and the playlist-home app into Spicetify, registers them
# and runs `spicetify apply` (Spotify restarts).

$ErrorActionPreference = "Stop"
$Repo = "https://raw.githubusercontent.com/gigacook/spotiflux/main"

function Say($msg, $color = "Gray") { Write-Host "  $msg" -ForegroundColor $color }

Write-Host "`nspotiflux installer`n" -ForegroundColor Cyan

# Spicetify refuses to run elevated (it can leave Spotify with a black window).
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator)
if ($admin) { Say "Run this from a normal (non-administrator) PowerShell window." Red; return }

if (-not (Get-Command spicetify -ErrorAction SilentlyContinue)) {
  Say "Spicetify not found. Install it first: https://spicetify.app" Red; return
}

$userData = (spicetify path userdata 2>$null | Select-Object -Last 1).Trim()
if (-not $userData -or -not (Test-Path $userData)) { $userData = Join-Path $env:APPDATA "spicetify" }
$extDir = Join-Path $userData "Extensions"
$appDir = Join-Path $userData "CustomApps\playlist-home"
New-Item -ItemType Directory -Force -Path $extDir, $appDir | Out-Null

# Local clone if available, else download from GitHub.
$files = @{
  "extension/spotiflux.js"            = Join-Path $extDir "spotiflux.js"
  "apps/playlist-home/index.js"       = Join-Path $appDir "index.js"
  "apps/playlist-home/manifest.json"  = Join-Path $appDir "manifest.json"
}
$here = if ($PSScriptRoot) { $PSScriptRoot } else { $null }
foreach ($src in $files.Keys) {
  $local = if ($here) { Join-Path $here $src } else { $null }
  if ($local -and (Test-Path $local)) { Copy-Item $local $files[$src] -Force }
  else { Invoke-WebRequest "$Repo/$src" -OutFile $files[$src] -UseBasicParsing }
  Say "copied $src"
}

# Earlier names of this extension: ivlyrics-library.js (pre-release) and
# ivlyrics-sidecar.js (1.x). Unregister and delete them so only one copy runs.
# Settings stay: they live in Spotify's local storage, not in these files.
foreach ($name in "ivlyrics-library.js", "ivlyrics-sidecar.js") {
  $old = Join-Path $extDir $name
  # try: on Windows PowerShell, stderr from a name that isn't registered would stop the script.
  try { spicetify config extensions "$name-" 2>$null | Out-Null } catch {}
  if (Test-Path $old) { Remove-Item $old -Force; Say "removed old $name" }
}

spicetify config extensions spotiflux.js | Out-Null
spicetify config custom_apps playlist-home | Out-Null
Say "registered extension + playlist-home app"

Say "running spicetify apply (Spotify will restart)..." Cyan
spicetify apply
Write-Host "`nDone. Spotify opens straight into the spotiflux deck (or click the deck icon in the top bar)." -ForegroundColor Green
Write-Host "Press Ctrl+Shift+H in the deck for every key. Settings: profile menu > spotiflux settings.`n" -ForegroundColor Green
