param(
  [string]$ReleaseRoot = "",
  [string]$BuildSourcePath = ""
)

$ErrorActionPreference = "Stop"
$tauri = Split-Path $PSScriptRoot -Parent
$writer = Join-Path (Split-Path $tauri -Parent) "novel-writer"
$release = if ($ReleaseRoot) { [System.IO.Path]::GetFullPath($ReleaseRoot) } else { Join-Path $tauri "release" }
$targetExe = if ($BuildSourcePath) { [System.IO.Path]::GetFullPath($BuildSourcePath) } else {
  Join-Path $tauri "src-tauri\target\release\mogao-tauri.exe"
}
$mainExe = Join-Path $release "Inkwell.exe"
. (Join-Path $PSScriptRoot "release-common.ps1")
$releaseNames = Get-ReleaseNames
$compatExe = Join-Path $release $releaseNames.CompatibilityExe
$guide = Join-Path $release $releaseNames.GuideMarkdown
$uiRoot = Join-Path $release "ui"
$uiManifest = Join-Path $tauri "ui-files.txt"

foreach ($path in @($targetExe, $mainExe, $compatExe, $guide, $uiManifest)) {
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "release input missing: $path" }
}

function Release-Artifact([string]$Path) {
  $item = Get-Item -LiteralPath $Path
  $releasePrefix = [System.IO.Path]::GetFullPath($release).TrimEnd([char[]]"\/") + [System.IO.Path]::DirectorySeparatorChar
  if (-not $item.FullName.StartsWith($releasePrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "artifact is outside release stage: $Path"
  }
  [ordered]@{
    file = $item.FullName.Substring($releasePrefix.Length).Replace("\", "/")
    bytes = $item.Length
    sha256 = Get-FileSha256 $Path
  }
}

function Build-Artifact([string]$Path) {
  $item = Get-Item -LiteralPath $Path
  [ordered]@{
    file = $item.Name
    bytes = $item.Length
    sha256 = Get-FileSha256 $Path
  }
}

function Tool-Version($command, $arguments) {
  try { return ((& $command $arguments 2>$null) | Out-String).Trim() } catch { return $null }
}

$version = (Get-Content (Join-Path $tauri "src-tauri\tauri.conf.json") -Raw -Encoding UTF8 | ConvertFrom-Json).version
$files = @(Get-ValidatedUiManifestFiles $uiManifest)
Assert-ExactFileSet $uiRoot $files "release UI"
$ui = [ordered]@{}
foreach ($file in $files) {
  $path = Resolve-SafeChildPath $uiRoot $file
  $ui[$file] = Get-FileSha256 $path
}

Assert-ReleaseExecutableSet $release $releaseNames.CompatibilityExe
$tauriExclusions = @("release", "src-tauri/target", "src-tauri/ui-embed", "vault", "output")
$frontendExclusions = @("output")

$manifest = [ordered]@{
  schemaVersion = 4
  product = "Inkwell"
  version = $version
  builtAtUtc = [DateTime]::UtcNow.ToString("o")
  source = [ordered]@{
    tauri = Get-GitState $tauri $tauriExclusions
    frontend = Get-GitState $writer $frontendExclusions
    cargoLockSha256 = Get-FileSha256 (Join-Path $tauri "src-tauri\Cargo.lock")
    uiManifestSha256 = Get-FileSha256 $uiManifest
    uiFileCount = $files.Count
  }
  toolchain = [ordered]@{
    rustc = Tool-Version "rustc" "--version"
    cargo = Tool-Version "cargo" "--version"
    node = Tool-Version "node" "--version"
  }
  buildSource = Build-Artifact $targetExe
  artifacts = [ordered]@{
    inkwell = Release-Artifact $mainExe
    compatibility = Release-Artifact $compatExe
    guide = Release-Artifact $guide
  }
  ui = $ui
  integrity = [ordered]@{
    algorithm = "sha256"
    manifest = "manifest.json"
    checksum = "manifest.sha256"
  }
}

$manifestPath = Join-Path $release "manifest.json"
$checksumPath = Join-Path $release "manifest.sha256"
$json = $manifest | ConvertTo-Json -Depth 10
[System.IO.File]::WriteAllText($manifestPath, $json + "`n", [System.Text.UTF8Encoding]::new($false))
$manifestHash = Get-FileSha256 $manifestPath
[System.IO.File]::WriteAllText($checksumPath, "$manifestHash  manifest.json`n", [System.Text.UTF8Encoding]::new($false))
Write-Host "release manifest: $manifestPath"
Write-Host "release manifest SHA-256: $manifestHash"
