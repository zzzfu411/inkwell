param([switch]$CompareSource)

$ErrorActionPreference = "Stop"
$tauri = Split-Path $PSScriptRoot -Parent
$writer = Join-Path (Split-Path $tauri -Parent) "novel-writer"
$release = Join-Path $tauri "release"
$manifestPath = Join-Path $release "manifest.json"
. (Join-Path $PSScriptRoot "release-common.ps1")
$releaseNames = Get-ReleaseNames
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw "missing release manifest: $manifestPath" }

function Invoke-Gate($path, $label) {
  $global:LASTEXITCODE = 0
  & $path
  if ($null -ne $LASTEXITCODE -and $LASTEXITCODE -ne 0) {
    throw "$label failed with exit code $LASTEXITCODE"
  }
}

if ($CompareSource) {
  Invoke-Gate (Join-Path $PSScriptRoot "check-version.ps1") "version consistency"
  Invoke-Gate (Join-Path $PSScriptRoot "check-ui-sync.ps1") "UI sync"
}

$manifest = Get-Content $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($manifest.schemaVersion -ne 3) { throw "unsupported release manifest schema: $($manifest.schemaVersion)" }
if (-not $manifest.artifacts.inkwell.file.Equals("Inkwell.exe", [System.StringComparison]::Ordinal)) {
  throw "manifest primary executable name is unexpected"
}
if (-not $manifest.artifacts.compatibility.file.Equals($releaseNames.CompatibilityExe, [System.StringComparison]::Ordinal)) {
  throw "manifest compatibility file name is not the expected Unicode name"
}
Assert-ReleaseExecutableSet $release $releaseNames.CompatibilityExe
foreach ($obsoleteName in @($releaseNames.ObsoleteGuideText, $releaseNames.LegacyGuideText, $releaseNames.LegacyCompatibilityExe)) {
  if (Test-Path -LiteralPath (Join-Path $release $obsoleteName)) {
    throw "obsolete release alias is still present: $obsoleteName"
  }
}
if (-not (Test-Path -LiteralPath (Join-Path $release $releaseNames.GuideMarkdown) -PathType Leaf)) {
  throw "release guide is missing"
}

function Verify-Artifact($artifact) {
  if (-not $artifact.file) { throw "manifest artifact has no file name" }
  $path = Join-Path $release $artifact.file
  $resolvedRelease = [System.IO.Path]::GetFullPath($release).TrimEnd("\") + "\"
  $resolvedPath = [System.IO.Path]::GetFullPath($path)
  if (-not $resolvedPath.StartsWith($resolvedRelease, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "manifest artifact escapes the release directory: $($artifact.file)"
  }
  if (-not (Test-Path -LiteralPath $resolvedPath -PathType Leaf)) { throw "missing release artifact: $resolvedPath" }
  $item = Get-Item -LiteralPath $resolvedPath
  if ([int64]$artifact.bytes -ne $item.Length) { throw "artifact size mismatch: $($artifact.file)" }
  $actual = Get-FileSha256 $resolvedPath
  if ($actual -ne $artifact.sha256) { throw "artifact hash mismatch: $($artifact.file)" }
  return $actual
}

$artifactHashes = @()
foreach ($property in $manifest.artifacts.PSObject.Properties) {
  $artifactHashes += Verify-Artifact $property.Value
}
if (($artifactHashes | Select-Object -Unique).Count -ne 1) {
  throw "release executable hashes differ: $($artifactHashes -join ', ')"
}
if (-not $manifest.buildSource) {
  throw "release manifest does not record the build source"
}
if ($manifest.buildSource.sha256 -ne $artifactHashes[0]) {
  throw "release executable differs from recorded build source"
}

$uiRoot = Join-Path $release "ui"
foreach ($property in $manifest.ui.PSObject.Properties) {
  $path = Join-Path $uiRoot $property.Name
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "missing release UI file: $($property.Name)" }
  $actual = Get-FileSha256 $path
  if ($actual -ne $property.Value) { throw "manifest UI hash mismatch: $($property.Name)" }
}

if ($CompareSource) {
  $manifestFiles = @($manifest.ui.PSObject.Properties.Name | Sort-Object)
  $expectedFiles = @(Get-Content (Join-Path $tauri "ui-files.txt") -Encoding UTF8 | ForEach-Object { $_.Trim() } | Where-Object { $_ -and -not $_.StartsWith("#") } | Sort-Object)
  if (($manifestFiles -join "`n") -ne ($expectedFiles -join "`n")) {
    throw "release manifest UI file set differs from ui-files.txt"
  }

  $cargoLock = Join-Path $tauri "src-tauri\Cargo.lock"
  $uiManifest = Join-Path $tauri "ui-files.txt"
  if ((Get-FileSha256 $cargoLock) -ne $manifest.source.cargoLockSha256) {
    throw "Cargo.lock differs from the recorded release source"
  }
  if ((Get-FileSha256 $uiManifest) -ne $manifest.source.uiManifestSha256) {
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
      (Get-FileSha256 $targetExe) -ne $manifest.buildSource.sha256) {
    throw "target release executable differs from the recorded build source"
  }
}

$uiCount = @($manifest.ui.PSObject.Properties).Count
Write-Host "OK: standalone release manifest, executables and $uiCount UI hashes verified (v$($manifest.version))"
