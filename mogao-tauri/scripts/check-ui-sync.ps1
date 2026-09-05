# Compare the canonical writer UI with the generated Tauri embed only.
# release/ is an immutable artifact and must never participate in the daily source-sync gate.
$ErrorActionPreference = "Stop"
$tauri = Split-Path $PSScriptRoot -Parent
$writer = Join-Path (Split-Path $tauri -Parent) "novel-writer"
$embed = Join-Path $tauri "src-tauri\ui-embed"
$manifestPath = Join-Path $tauri "ui-files.txt"
. (Join-Path $PSScriptRoot "release-common.ps1")

if (-not (Test-Path -LiteralPath $writer -PathType Container)) {
  throw "missing canonical UI source: $writer"
}
if (-not (Test-Path -LiteralPath $embed -PathType Container)) {
  throw "missing ui-embed directory: $embed; run scripts/sync-ui.ps1"
}
$files = @(Get-ValidatedUiManifestFiles $manifestPath)
$problems = @()

foreach ($file in $files) {
  $source = Resolve-SafeChildPath $writer $file
  $target = Resolve-SafeChildPath $embed $file
  if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
    $problems += "missing canonical $file"
    continue
  }
  if (-not (Test-Path -LiteralPath $target -PathType Leaf)) {
    $problems += "missing ui-embed $file"
    continue
  }
  if ((Get-FileSha256 $source) -ne (Get-FileSha256 $target)) {
    $problems += "DIFF ui-embed $file"
  }
}

$expected = @($files) + ".embed-built"
$actual = @(Get-RelativeLeafFiles $embed)
$extra = @($actual | Where-Object { $expected -notcontains $_ })
foreach ($file in $extra) { $problems += "extra ui-embed $file" }

$buildRs = Join-Path $tauri "src-tauri\build.rs"
if (-not (Test-Path -LiteralPath $buildRs -PathType Leaf)) {
  $problems += "missing src-tauri/build.rs"
} else {
  $buildText = Get-Content -LiteralPath $buildRs -Raw -Encoding UTF8
  if ($buildText.IndexOf("ui-files.txt") -lt 0) { $problems += "build.rs does not consume ui-files.txt" }
}

if ($problems.Count -gt 0) {
  Write-Host "UI embed is out of sync:"
  $problems | ForEach-Object { Write-Host "  $_" }
  throw "canonical UI and ui-embed differ ($($problems.Count) problems)"
}
Write-Host "OK: ui-embed matches canonical manifest ($($files.Count) files); release not inspected"
