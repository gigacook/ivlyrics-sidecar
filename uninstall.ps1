# spotiflux uninstaller: unregisters and deletes the extension (and its older
# ivlyrics-sidecar.js name) and the playlist-home app, then runs `spicetify apply`.

$ErrorActionPreference = "Stop"
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator)
if ($admin) { Write-Host "Run this from a normal (non-administrator) PowerShell window." -ForegroundColor Red; return }

$userData = try { "$(spicetify path userdata 2>$null | Select-Object -Last 1)".Trim() } catch { "" }
if (-not $userData -or -not (Test-Path $userData)) { $userData = Join-Path $env:APPDATA "spicetify" }

foreach ($name in "spotiflux.js", "ivlyrics-sidecar.js") {
  try { spicetify config extensions "$name-" 2>$null | Out-Null } catch {}
  Remove-Item (Join-Path $userData "Extensions\$name") -Force -ErrorAction SilentlyContinue
}
try { spicetify config custom_apps playlist-home- 2>$null | Out-Null } catch {}
Remove-Item (Join-Path $userData "CustomApps\playlist-home") -Recurse -Force -ErrorAction SilentlyContinue

spicetify apply
if ($LASTEXITCODE -ne 0) { Write-Host "spicetify apply failed. Run 'spicetify backup apply', then run this again." -ForegroundColor Red; return }
Write-Host "spotiflux removed." -ForegroundColor Green
