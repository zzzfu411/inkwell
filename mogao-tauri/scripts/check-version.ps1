$ErrorActionPreference = "Stop"
$tauri = Split-Path $PSScriptRoot -Parent
$writer = Join-Path (Split-Path $tauri -Parent) "novel-writer"

function Match-Version($path, $pattern, $label) {
  $text = Get-Content $path -Raw -Encoding UTF8
  $match = [regex]::Match($text, $pattern)
  if (-not $match.Success) { throw "cannot find $label version in $path" }
  $match.Groups[1].Value
}

# One file can carry several version strings (app.js has three fallbacks).
# Collect them all: a missed one makes the displayed version disagree with the loaded frontend.
function Match-All-Versions($path, $pattern, $label) {
  $text = Get-Content $path -Raw -Encoding UTF8
  $found = [regex]::Matches($text, $pattern)
  if ($found.Count -eq 0) { throw "cannot find $label version in $path" }
  @($found | ForEach-Object { $_.Groups[1].Value } | Select-Object -Unique)
}

$versions = [ordered]@{
  package = (Get-Content (Join-Path $tauri "package.json") -Raw -Encoding UTF8 | ConvertFrom-Json).version
  packageLock = Match-Version (Join-Path $tauri "package-lock.json") '(?m)^\s*"version"\s*:\s*"([^"]+)"' "package-lock"
  cargo = Match-Version (Join-Path $tauri "src-tauri\Cargo.toml") '(?m)^version\s*=\s*"([^"]+)"' "Cargo"
  cargoLock = Match-Version (Join-Path $tauri "src-tauri\Cargo.lock") '(?ms)\[\[package\]\]\s+name\s*=\s*"mogao-tauri"\s+version\s*=\s*"([^"]+)"' "Cargo.lock"
  tauri = (Get-Content (Join-Path $tauri "src-tauri\tauri.conf.json") -Raw -Encoding UTF8 | ConvertFrom-Json).version
  rust = Match-Version (Join-Path $tauri "src-tauri\src\vault\mod.rs") 'VERSION:\s*&str\s*=\s*"([^"]+)"' "Rust"
  frontend = Match-Version (Join-Path $writer "config.js") 'NOVEL_APP_VERSION\s*=\s*"([^"]+)"' "frontend"
  python = Match-Version (Join-Path $writer "server.py") '(?m)^VERSION\s*=\s*"([^"]+)"' "Python"
  html = Match-Version (Join-Path $writer "index.html") 'id="appVersion"[^>]*>v([0-9][^<]*)<' "index.html"
  appFallback = (Match-All-Versions (Join-Path $writer "app.js") 'NOVEL_APP_VERSION \|\| "([^"]+)"' "app.js fallback") -join ","
}

$unique = @($versions.Values | Select-Object -Unique)
if ($unique.Count -ne 1) {
  $details = ($versions.GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value)" }) -join ", "
  throw "version mismatch: $details"
}
Write-Host "OK: all product versions are $($unique[0])"
