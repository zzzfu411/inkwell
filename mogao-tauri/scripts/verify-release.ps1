param(
  [string]$ReleaseRoot = "",
  [switch]$CompareSource
)

$ErrorActionPreference = "Stop"
$tauri = Split-Path $PSScriptRoot -Parent
$writer = Join-Path (Split-Path $tauri -Parent) "novel-writer"
$release = if ($ReleaseRoot) { [System.IO.Path]::GetFullPath($ReleaseRoot) } else { Join-Path $tauri "release" }
$manifestPath = Join-Path $release "manifest.json"
. (Join-Path $PSScriptRoot "release-common.ps1")
$releaseNames = Get-ReleaseNames

if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
  throw "missing release manifest: $manifestPath"
}
$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$schemaVersion = [int]$manifest.schemaVersion
if ($schemaVersion -notin @(3, 4)) { throw "unsupported release manifest schema: $schemaVersion" }
if ($manifest.product -ne "Inkwell") { throw "release manifest product is not Inkwell" }
if (-not ([string]$manifest.version -match '^\d+\.\d+\.\d+$')) { throw "release manifest version is invalid" }
if (-not $manifest.source -or -not $manifest.buildSource -or -not $manifest.artifacts -or -not $manifest.ui) {
  throw "release manifest is missing required provenance sections"
}

if ($schemaVersion -eq 4) {
  if ($manifest.integrity.algorithm -ne "sha256" -or $manifest.integrity.manifest -ne "manifest.json" -or
      $manifest.integrity.checksum -ne "manifest.sha256") {
    throw "release manifest integrity metadata is invalid"
  }
  $checksumPath = Join-Path $release "manifest.sha256"
  if (-not (Test-Path -LiteralPath $checksumPath -PathType Leaf)) { throw "missing manifest checksum: $checksumPath" }
  $checksumText = (Get-Content -LiteralPath $checksumPath -Raw -Encoding UTF8).Trim()
  $checksumMatch = [regex]::Match($checksumText, '^([0-9a-fA-F]{64})\s+\*?manifest\.json$')
  if (-not $checksumMatch.Success) { throw "manifest.sha256 has an invalid format" }
  if ((Get-FileSha256 $manifestPath) -ne $checksumMatch.Groups[1].Value.ToLowerInvariant()) {
    throw "release manifest checksum mismatch"
  }
}

function Verify-Artifact($artifact, [string]$expectedFile = "") {
  if (-not $artifact -or -not $artifact.file) { throw "manifest artifact has no file name" }
  if ($expectedFile -and -not ([string]$artifact.file).Equals($expectedFile, [System.StringComparison]::Ordinal)) {
    throw "manifest artifact name mismatch: expected $expectedFile, got $($artifact.file)"
  }
  $path = Resolve-SafeChildPath $release ([string]$artifact.file)
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "missing release artifact: $path" }
  $item = Get-Item -LiteralPath $path
  if ([int64]$artifact.bytes -ne $item.Length) { throw "artifact size mismatch: $($artifact.file)" }
  $actual = Get-FileSha256 $path
  if ($actual -ne [string]$artifact.sha256) { throw "artifact hash mismatch: $($artifact.file)" }
  $actual
}

$primaryHash = Verify-Artifact $manifest.artifacts.inkwell "Inkwell.exe"
$compatibilityHash = Verify-Artifact $manifest.artifacts.compatibility $releaseNames.CompatibilityExe
if ($primaryHash -ne $compatibilityHash) { throw "release executable hashes differ" }
Assert-ReleaseExecutableSet $release $releaseNames.CompatibilityExe

$guidePath = Join-Path $release $releaseNames.GuideMarkdown
if ($schemaVersion -eq 4) {
  Verify-Artifact $manifest.artifacts.guide $releaseNames.GuideMarkdown | Out-Null
} elseif (-not (Test-Path -LiteralPath $guidePath -PathType Leaf)) {
  throw "release guide is missing"
}
foreach ($obsoleteName in @($releaseNames.ObsoleteGuideText, $releaseNames.LegacyGuideText, $releaseNames.LegacyCompatibilityExe)) {
  if (Test-Path -LiteralPath (Join-Path $release $obsoleteName)) {
    throw "obsolete release alias is still present: $obsoleteName"
  }
}
if ([string]$manifest.buildSource.sha256 -ne $primaryHash -or
    [int64]$manifest.buildSource.bytes -ne [int64]$manifest.artifacts.inkwell.bytes) {
  throw "release executable differs from recorded build source"
}

$uiRoot = Join-Path $release "ui"
$uiProperties = @($manifest.ui.PSObject.Properties)
if ($uiProperties.Count -eq 0) { throw "release manifest contains no UI files" }
$expectedReleaseFiles = @("manifest.json", "Inkwell.exe", $releaseNames.CompatibilityExe, $releaseNames.GuideMarkdown)
if ($schemaVersion -eq 4) { $expectedReleaseFiles += "manifest.sha256" }
foreach ($property in $uiProperties) {
  $relative = [string]$property.Name
  $path = Resolve-SafeChildPath $uiRoot $relative
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "missing release UI file: $relative" }
  $actual = Get-FileSha256 $path
  if ($actual -ne [string]$property.Value) { throw "manifest UI hash mismatch: $relative" }
  $expectedReleaseFiles += "ui/$relative"
}
Assert-ExactFileSet $release $expectedReleaseFiles "release artifact"

function Invoke-Gate([string]$Path, [string]$Label) {
  $global:LASTEXITCODE = 0
  & $Path
  if ($LASTEXITCODE -ne 0) { throw "$Label failed with exit code $LASTEXITCODE" }
}

if ($CompareSource) {
  Invoke-Gate (Join-Path $PSScriptRoot "check-version.ps1") "version consistency"
  Invoke-Gate (Join-Path $PSScriptRoot "check-ui-sync.ps1") "UI embed sync"
  $sourceVersion = (Get-Content (Join-Path $tauri "src-tauri\tauri.conf.json") -Raw -Encoding UTF8 | ConvertFrom-Json).version
  if ([string]$manifest.version -ne [string]$sourceVersion) {
    throw "release version differs from current source"
  }

  $manifestFiles = @($uiProperties.Name | Sort-Object)
  $uiManifest = Join-Path $tauri "ui-files.txt"
  $expectedFiles = @(Get-ValidatedUiManifestFiles $uiManifest | Sort-Object)
  if (($manifestFiles -join "`n") -ne ($expectedFiles -join "`n")) {
    throw "release manifest UI file set differs from ui-files.txt"
  }
  if ($schemaVersion -eq 4 -and [int]$manifest.source.uiFileCount -ne $expectedFiles.Count) {
    throw "release manifest UI count differs from ui-files.txt"
  }
  foreach ($file in $expectedFiles) {
    $sourcePath = Resolve-SafeChildPath $writer $file
    if ((Get-FileSha256 $sourcePath) -ne [string]$manifest.ui.$file) {
      throw "release UI differs from canonical source: $file"
    }
  }

  $cargoLock = Join-Path $tauri "src-tauri\Cargo.lock"
  if ((Get-FileSha256 $cargoLock) -ne [string]$manifest.source.cargoLockSha256) {
    throw "Cargo.lock differs from the recorded release source"
  }
  if ((Get-FileSha256 $uiManifest) -ne [string]$manifest.source.uiManifestSha256) {
    throw "ui-files.txt differs from the recorded release source"
  }

  $tauriExclusions = @("release", "src-tauri/target", "src-tauri/ui-embed", "vault", "output")
  $frontendExclusions = @("output")
  foreach ($entry in @(
    @{ Label = "tauri"; Repo = $tauri; Recorded = $manifest.source.tauri; Exclusions = $tauriExclusions },
    @{ Label = "frontend"; Repo = $writer; Recorded = $manifest.source.frontend; Exclusions = $frontendExclusions }
  )) {
    $actual = Get-GitState $entry.Repo $entry.Exclusions
    if ($actual.commit -ne $entry.Recorded.commit -or
        $actual.dirty -ne [bool]$entry.Recorded.dirty -or
        $actual.changeCount -ne [int]$entry.Recorded.changeCount -or
        $actual.sourceTreeSha256 -ne $entry.Recorded.sourceTreeSha256) {
      throw "$($entry.Label) Git state differs from the release manifest"
    }
  }

  $targetExe = Join-Path $tauri "src-tauri\target\release\mogao-tauri.exe"
  if (-not (Test-Path -LiteralPath $targetExe -PathType Leaf)) {
    throw "release build source is missing: $targetExe"
  }
  $target = Get-Item -LiteralPath $targetExe
  if ($target.Name -ne $manifest.buildSource.file -or
      $target.Length -ne [int64]$manifest.buildSource.bytes -or
      (Get-FileSha256 $targetExe) -ne [string]$manifest.buildSource.sha256) {
    throw "target release executable differs from the recorded build source"
  }
}

Write-Host "OK: immutable release v$($manifest.version), schema $schemaVersion, 2 executables and $($uiProperties.Count) UI hashes verified"
