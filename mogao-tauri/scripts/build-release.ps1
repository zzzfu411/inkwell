param(
  [switch]$OpenRelease,
  [switch]$AllowDirty
)

$ErrorActionPreference = "Stop"
$tauri = Split-Path $PSScriptRoot -Parent
$release = Join-Path $tauri "release"
$targetDir = Join-Path $tauri "src-tauri"
$targetExe = Join-Path $targetDir "target\release\mogao-tauri.exe"
$mainExe = Join-Path $release "Inkwell.exe"
. (Join-Path $PSScriptRoot "release-common.ps1")
$releaseNames = Get-ReleaseNames
$writer = Join-Path (Split-Path $tauri -Parent) "novel-writer"
$compatExe = Join-Path $release $releaseNames.CompatibilityExe
$guideSource = Join-Path $tauri $releaseNames.GuideMarkdown
$guideDestination = Join-Path $release $releaseNames.GuideMarkdown

function Require-Success($label) {
  if ($null -ne $LASTEXITCODE -and $LASTEXITCODE -ne 0) {
    throw "$label failed with exit code $LASTEXITCODE"
  }
}

Assert-CleanReleaseSources $tauri $writer -AllowDirty:$AllowDirty

Write-Host "[1/5] Sync canonical frontend to release/ui and ui-embed"
& (Join-Path $PSScriptRoot "sync-ui.ps1")
Require-Success "UI sync"

Write-Host "[2/5] Run full CI"
& (Join-Path $PSScriptRoot "ci.ps1")
Require-Success "CI"

Write-Host "[3/5] Build locked release executable"
Push-Location $targetDir
try {
  cargo build --release --locked
  Require-Success "cargo build --release --locked"
} finally {
  Pop-Location
}

Write-Host "[4/5] Assemble release directory"
if (-not (Test-Path -LiteralPath $targetExe -PathType Leaf)) {
  throw "release executable missing: $targetExe"
}
if (-not (Test-Path -LiteralPath $guideSource -PathType Leaf)) {
  throw "release guide missing: $guideSource"
}
New-Item -ItemType Directory -Force -Path $release | Out-Null
Get-ChildItem -LiteralPath $release -File | Where-Object {
  $_.Name.EndsWith("-Tauri.exe", [System.StringComparison]::OrdinalIgnoreCase)
} | Remove-Item -Force
foreach ($obsoleteGuide in @($releaseNames.ObsoleteGuideText, $releaseNames.LegacyGuideText)) {
  $obsoletePath = Join-Path $release $obsoleteGuide
  if (Test-Path -LiteralPath $obsoletePath -PathType Leaf) {
    Remove-Item -LiteralPath $obsoletePath -Force
  }
}
Copy-Item -LiteralPath $targetExe -Destination $mainExe -Force
Copy-Item -LiteralPath $targetExe -Destination $compatExe -Force
Copy-Item -LiteralPath $guideSource -Destination $guideDestination -Force

Assert-ReleaseExecutableSet $release $releaseNames.CompatibilityExe
if ((Get-FileSha256 $mainExe) -ne (Get-FileSha256 $compatExe)) {
  throw "release executables differ after assembly"
}

Write-Host "[5/5] Write and verify release manifest"
& (Join-Path $PSScriptRoot "write-release-manifest.ps1")
Require-Success "release manifest"
& (Join-Path $PSScriptRoot "verify-release.ps1") -CompareSource
Require-Success "release verification"

$item = Get-Item -LiteralPath $mainExe
Write-Host "Release complete: $($item.FullName) ($($item.Length) bytes, SHA-256 $(Get-FileSha256 $mainExe))"
if ($OpenRelease) {
  Start-Process explorer.exe -ArgumentList $release -WindowStyle Hidden
}
