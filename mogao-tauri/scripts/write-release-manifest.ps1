$ErrorActionPreference = "Stop"
$tauri = Split-Path $PSScriptRoot -Parent
$writer = Join-Path (Split-Path $tauri -Parent) "novel-writer"
$release = Join-Path $tauri "release"
$targetExe = Join-Path $tauri "src-tauri\target\release\mogao-tauri.exe"
$mainExe = Join-Path $release "Inkwell.exe"
. (Join-Path $PSScriptRoot "release-common.ps1")
$releaseNames = Get-ReleaseNames
$compatExe = Join-Path $release $releaseNames.CompatibilityExe
$uiRoot = Join-Path $release "ui"
$uiManifest = Join-Path $tauri "ui-files.txt"

foreach ($path in @($targetExe, $mainExe, $compatExe, $uiManifest)) {
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "release input missing: $path" }
}

function Artifact($path) {
  $item = Get-Item -LiteralPath $path
  [ordered]@{
    file = $item.Name
    bytes = $item.Length
    sha256 = Get-FileSha256 $path
  }
}

function Tool-Version($command, $arguments) {
  try { return ((& $command $arguments 2>$null) | Out-String).Trim() } catch { return $null }
}

$version = (Get-Content (Join-Path $tauri "src-tauri\tauri.conf.json") -Raw -Encoding UTF8 | ConvertFrom-Json).version
$ui = [ordered]@{}
$files = @(Get-Content $uiManifest -Encoding UTF8 | ForEach-Object { $_.Trim() } | Where-Object { $_ -and -not $_.StartsWith("#") })
foreach ($file in $files) {
  $path = Join-Path $uiRoot $file
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "release UI missing: $file" }
  $ui[$file] = Get-FileSha256 $path
}

Assert-ReleaseExecutableSet $release $releaseNames.CompatibilityExe
$tauriExclusions = @("release", "src-tauri/target", "src-tauri/ui-embed", "vault", "output")
$frontendExclusions = @("output")

$manifest = [ordered]@{
  schemaVersion = 3
  product = "Inkwell"
  version = $version
  builtAtUtc = [DateTime]::UtcNow.ToString("o")
  source = [ordered]@{
    tauri = Get-GitState $tauri $tauriExclusions
    frontend = Get-GitState $writer $frontendExclusions
    cargoLockSha256 = Get-FileSha256 (Join-Path $tauri "src-tauri\Cargo.lock")
    uiManifestSha256 = Get-FileSha256 $uiManifest
  }
  toolchain = [ordered]@{
    rustc = Tool-Version "rustc" "--version"
    cargo = Tool-Version "cargo" "--version"
    node = Tool-Version "node" "--version"
  }
  buildSource = Artifact $targetExe
  artifacts = [ordered]@{
    inkwell = Artifact $mainExe
    compatibility = Artifact $compatExe
  }
  ui = $ui
}

$output = Join-Path $release "manifest.json"
$manifest | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $output -Encoding UTF8
Write-Host "release manifest: $output"
