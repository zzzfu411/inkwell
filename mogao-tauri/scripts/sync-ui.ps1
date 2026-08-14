$ErrorActionPreference = "Stop"
$tauri = Split-Path $PSScriptRoot -Parent
$writer = Join-Path (Split-Path $tauri -Parent) "novel-writer"
$manifestPath = Join-Path $tauri "ui-files.txt"
$targets = @(
  (Join-Path $tauri "release\ui"),
  (Join-Path $tauri "src-tauri\ui-embed")
)

if (-not (Test-Path $writer)) { throw "missing canonical UI source: $writer" }
if (-not (Test-Path $manifestPath)) { throw "missing UI manifest: $manifestPath" }

$files = @(Get-Content $manifestPath -Encoding UTF8 | ForEach-Object { $_.Trim() } | Where-Object { $_ -and -not $_.StartsWith("#") })
if ($files.Count -eq 0) { throw "UI manifest is empty" }
$normalized = @($files | ForEach-Object { $_.Replace("\", "/") })
$duplicates = @($normalized | Group-Object | Where-Object { $_.Count -gt 1 } | ForEach-Object { $_.Name })
if ($duplicates.Count -gt 0) { throw "duplicate UI manifest entries: $($duplicates -join ', ')" }
foreach ($file in $normalized) {
  if ([System.IO.Path]::IsPathRooted($file) -or (($file -split "/") -contains "..")) {
    throw "unsafe UI manifest entry: $file"
  }
}
$files = $normalized

foreach ($file in $files) {
  $source = Join-Path $writer $file
  if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
    throw "canonical UI file missing: $file"
  }
}

foreach ($targetRoot in $targets) {
  New-Item -ItemType Directory -Force -Path $targetRoot | Out-Null
  foreach ($file in $files) {
    $source = Join-Path $writer $file
    $target = Join-Path $targetRoot $file
    $parent = Split-Path $target -Parent
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
    Copy-Item -LiteralPath $source -Destination $target -Force
  }
  Write-Host "synced $($files.Count) UI assets -> $targetRoot"
}
