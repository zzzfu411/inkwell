# Compare novel-writer vs release/ui and ui-embed; throw on drift.
# GOAL-AUDIT-R3 #3: embed drift gate
$ErrorActionPreference = "Stop"
$tauri = Split-Path $PSScriptRoot -Parent
$src = Join-Path (Split-Path $tauri -Parent) "novel-writer"
$ui = Join-Path $tauri "release\ui"
$embed = Join-Path $tauri "src-tauri\ui-embed"

$manifest = Join-Path $tauri "ui-files.txt"
if (-not (Test-Path $manifest)) { Write-Error "missing canonical UI manifest: $manifest" }
$files = @(Get-Content $manifest -Encoding UTF8 | ForEach-Object { $_.Trim() } | Where-Object { $_ -and -not $_.StartsWith("#") })
$files = @($files | ForEach-Object { $_.Replace("\", "/") })

if (-not (Test-Path $src)) { Write-Error "missing novel-writer: $src" }
if (-not (Test-Path $ui)) { Write-Error "missing release/ui: $ui - run build-release.bat" }

$bad = @()
$duplicates = @($files | Group-Object | Where-Object { $_.Count -gt 1 } | ForEach-Object { $_.Name })
if ($duplicates.Count -gt 0) { $bad += "duplicate manifest entries: $($duplicates -join ', ')" }
foreach ($file in $files) {
  if ([System.IO.Path]::IsPathRooted($file) -or (($file -split "/") -contains "..")) {
    $bad += "unsafe manifest entry $file"
  }
}

function Get-RelativeFiles($root) {
  $rootPath = [System.IO.Path]::GetFullPath($root).TrimEnd("\", "/")
  if (-not (Test-Path -LiteralPath $rootPath -PathType Container)) { return @() }
  return @(Get-ChildItem -LiteralPath $rootPath -Recurse -File | ForEach-Object {
    $_.FullName.Substring($rootPath.Length + 1).Replace("\", "/")
  })
}

function Check-ExactFileSet($label, $root, $allowedExtras) {
  $expected = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
  foreach ($file in $files) { [void]$expected.Add($file) }
  foreach ($file in $allowedExtras) { [void]$expected.Add($file) }
  foreach ($actual in Get-RelativeFiles $root) {
    if (-not $expected.Contains($actual)) { $script:bad += "extra $label $actual" }
  }
}

# 1) novel-writer <-> release/ui
foreach ($f in $files) {
  $a = Join-Path $src $f
  $b = Join-Path $ui $f
  if (-not (Test-Path $a)) { $bad += "missing src $f"; continue }
  if (-not (Test-Path $b)) { $bad += "missing ui $f"; continue }
  $ha = (Get-FileHash $a -Algorithm SHA256).Hash
  $hb = (Get-FileHash $b -Algorithm SHA256).Hash
  if ($ha -ne $hb) { $bad += "DIFF release/ui $f" }
}
Check-ExactFileSet "release/ui" $ui @()

# 2) build.rs must consume the canonical manifest
$buildRs = Join-Path $tauri "src-tauri\build.rs"
if (Test-Path $buildRs) {
  $buildText = Get-Content $buildRs -Raw -Encoding UTF8
  if ($buildText.IndexOf('ui-files.txt') -lt 0) { $bad += "build.rs does not consume ui-files.txt" }
}

# 3) ui-embed must exist and match src for core files
if (Test-Path $embed) {
  foreach ($f in $files) {
    $a = Join-Path $src $f
    $e = Join-Path $embed $f
    if (-not (Test-Path $a)) { continue }
    if (-not (Test-Path $e)) {
      $bad += "missing ui-embed $f"
      continue
    }
    $ha = (Get-FileHash $a -Algorithm SHA256).Hash
    $he = (Get-FileHash $e -Algorithm SHA256).Hash
    if ($ha -ne $he) { $bad += "DIFF ui-embed $f" }
  }
  Check-ExactFileSet "ui-embed" $embed @(".embed-built")
} else {
  $bad += "missing ui-embed dir - run cargo build once"
}

if ($bad.Count -gt 0) {
  Write-Host "UI out of sync:"
  $bad | ForEach-Object { Write-Host "  $_" }
  throw "UI assets are out of sync ($($bad.Count) problems)"
}
Write-Host "OK: release/ui + ui-embed match canonical manifest ($($files.Count) files)"
