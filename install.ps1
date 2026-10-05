# ivlyrics-sidecar installer (Windows, PowerShell 5+).
# Run from a cloned repo:   .\install.ps1
# Or straight from GitHub:  irm https://raw.githubusercontent.com/gigacook/ivlyrics-sidecar/main/install.ps1 | iex
# Copies the extension and the playlist-home app into Spicetify, registers them
# and runs `spicetify apply` (Spotify restarts).

$ErrorActionPreference = "Stop"
$Repo = "https://raw.githubusercontent.com/gigacook/ivlyrics-sidecar/main"

function Say($msg, $color = "Gray") { Write-Host "  $msg" -ForegroundColor $color }

Write-Host "`nivlyrics-sidecar installer`n" -ForegroundColor Cyan

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

if (-not (Test-Path (Join-Path $userData "CustomApps\ivLyrics"))) {
  Say "ivLyrics is not installed as a Spicetify custom app. ivlyrics-sidecar needs it." Yellow
  Say "Install ivLyrics first (Spicetify Marketplace), then run this again." Yellow
  return
}

# Local clone if available, else download from GitHub.
$files = @{
  "extension/ivlyrics-sidecar.js"     = Join-Path $extDir "ivlyrics-sidecar.js"
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

# Pre-release builds were called ivlyrics-library.js; swap it out if present.
$old = Join-Path $extDir "ivlyrics-library.js"
if (Test-Path $old) {
  spicetify config extensions ivlyrics-library.js- 2>$null | Out-Null
  Remove-Item $old -Force
  Say "removed old ivlyrics-library.js"
}

spicetify config extensions ivlyrics-sidecar.js | Out-Null
spicetify config custom_apps playlist-home | Out-Null
Say "registered extension + playlist-home app"

Say "running spicetify apply (Spotify will restart)..." Cyan
spicetify apply
Write-Host "`nDone. Click the deck icon in Spotifys top bar, then press Left or Right.`n" -ForegroundColor Green
