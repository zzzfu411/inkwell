$ErrorActionPreference = "Stop"
$tauri = Split-Path $PSScriptRoot -Parent
$writer = Join-Path (Split-Path $tauri -Parent) "novel-writer"
$manifestPath = Join-Path $tauri "ui-files.txt"
$embed = Join-Path $tauri "src-tauri\ui-embed"
$stage = Join-Path $tauri ("src-tauri\ui-embed.stage-" + [guid]::NewGuid().ToString("N"))
. (Join-Path $PSScriptRoot "release-common.ps1")

if (-not (Test-Path -LiteralPath $writer -PathType Container)) {
  throw "missing canonical UI source: $writer"
}
$files = @(Get-ValidatedUiManifestFiles $manifestPath)

try {
  Copy-ManifestFiles $writer $stage $files
  [System.IO.File]::WriteAllText(
    (Join-Path $stage ".embed-built"),
    "generated from ui-files.txt`n",
    [System.Text.UTF8Encoding]::new($false)
  )

  $validator = {
    param($published)
    Assert-ExactFileSet $published (@($files) + ".embed-built") "ui-embed"
    foreach ($file in $files) {
      $source = Resolve-SafeChildPath $writer $file
      $target = Resolve-SafeChildPath $published $file
      if ((Get-FileSha256 $source) -ne (Get-FileSha256 $target)) {
        throw "ui-embed hash mismatch after publish: $file"
      }
    }
  }
  Publish-DirectoryStage $stage $embed $validator
} finally {
  if (Test-Path -LiteralPath $stage) {
    Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
  }
}

Write-Host "synced $($files.Count) canonical UI assets -> $embed"
Write-Host "release/ was not touched; only build-release.ps1 may publish it"
