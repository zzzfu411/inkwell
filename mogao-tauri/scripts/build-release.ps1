param(
  [switch]$OpenRelease,
  [switch]$AllowDirty,
  [switch]$Candidate
)

$ErrorActionPreference = "Stop"
$tauri = Split-Path $PSScriptRoot -Parent
$writer = Join-Path (Split-Path $tauri -Parent) "novel-writer"
$release = if ($Candidate) { Join-Path $tauri "output\candidate-release" } else { Join-Path $tauri "release" }
$targetDir = Join-Path $tauri "src-tauri"
$targetExe = Join-Path $targetDir "target\release\mogao-tauri.exe"
$outputRoot = Join-Path $tauri "output"
$stage = Join-Path $outputRoot ("release-stage-" + [guid]::NewGuid().ToString("N"))
. (Join-Path $PSScriptRoot "release-common.ps1")
$releaseNames = Get-ReleaseNames
$guideSource = Join-Path $tauri $releaseNames.GuideMarkdown
$published = $false

function Require-Success($label) {
  if ($null -ne $LASTEXITCODE -and $LASTEXITCODE -ne 0) {
    throw "$label failed with exit code $LASTEXITCODE"
  }
}

Assert-CleanReleaseSources $tauri $writer -AllowDirty:$AllowDirty

try {
  Write-Host "[1/6] Sync canonical frontend to generated ui-embed only"
  & (Join-Path $PSScriptRoot "sync-ui.ps1")
  Require-Success "UI embed sync"

  Write-Host "[2/6] Run the complete source CI"
  & (Join-Path $PSScriptRoot "ci.ps1")
  Require-Success "CI"

  Write-Host "[3/6] Build locked release executable"
  Push-Location $targetDir
  try {
    cargo build --release --locked
    Require-Success "cargo build --release --locked"
  } finally {
    Pop-Location
  }
  if (-not (Test-Path -LiteralPath $targetExe -PathType Leaf)) {
    throw "release executable missing: $targetExe"
  }
  if (-not (Test-Path -LiteralPath $guideSource -PathType Leaf)) {
    throw "release guide missing: $guideSource"
  }

  Write-Host "[4/6] Assemble isolated release stage"
  New-Item -ItemType Directory -Force -Path (Join-Path $stage "ui") | Out-Null
  $uiManifest = Join-Path $tauri "ui-files.txt"
  $uiFiles = @(Get-ValidatedUiManifestFiles $uiManifest)
  Copy-ManifestFiles $writer (Join-Path $stage "ui") $uiFiles
  Copy-Item -LiteralPath $targetExe -Destination (Join-Path $stage "Inkwell.exe")
  Copy-Item -LiteralPath $targetExe -Destination (Join-Path $stage $releaseNames.CompatibilityExe)
  Copy-Item -LiteralPath $guideSource -Destination (Join-Path $stage $releaseNames.GuideMarkdown)
  Assert-ExactFileSet (Join-Path $stage "ui") $uiFiles "staged release UI"
  Assert-ReleaseExecutableSet $stage $releaseNames.CompatibilityExe

  Write-Host "[5/6] Seal and verify stage against source provenance"
  & (Join-Path $PSScriptRoot "write-release-manifest.ps1") -ReleaseRoot $stage -BuildSourcePath $targetExe
  Require-Success "release manifest"
  & (Join-Path $PSScriptRoot "verify-release.ps1") -ReleaseRoot $stage -CompareSource
  Require-Success "staged release verification"

  Write-Host "[6/6] Atomically publish the verified stage"
  $validator = {
    param($publishedRoot)
    $global:LASTEXITCODE = 0
    & (Join-Path $PSScriptRoot "verify-release.ps1") -ReleaseRoot $publishedRoot
    if ($LASTEXITCODE -ne 0) { throw "published release verification failed with exit code $LASTEXITCODE" }
  }
  Publish-DirectoryStage $stage $release $validator
  $published = $true

  $mainExe = Join-Path $release "Inkwell.exe"
  $item = Get-Item -LiteralPath $mainExe
  Write-Host "Release complete: $($item.FullName) ($($item.Length) bytes, SHA-256 $(Get-FileSha256 $mainExe))"
  Write-Host "Manifest checksum: $(Get-Content -Raw -LiteralPath (Join-Path $release 'manifest.sha256'))"
  if ($OpenRelease) {
    Start-Process explorer.exe -ArgumentList $release -WindowStyle Hidden
  }
} catch {
  if (Test-Path -LiteralPath $stage -PathType Container) {
    Write-Warning "release failed before publication; diagnostic stage preserved at $stage"
  }
  throw
} finally {
  if ($published -and (Test-Path -LiteralPath $stage)) {
    Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
  }
}
