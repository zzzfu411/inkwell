$ErrorActionPreference = "Stop"
$tauri = Split-Path $PSScriptRoot -Parent
$writer = Join-Path (Split-Path $tauri -Parent) "novel-writer"
. (Join-Path $PSScriptRoot "release-common.ps1")
$output = Join-Path $tauri "output\source-pair.json"
New-Item -ItemType Directory -Force (Split-Path $output -Parent) | Out-Null
$pair = [ordered]@{
  schemaVersion = 1
  recordedAt = [DateTime]::UtcNow.ToString("o")
  writer = Get-GitState $writer @("output")
  tauri = Get-GitState $tauri @("release", "src-tauri/target", "src-tauri/ui-embed", "vault", "output")
}
$pair | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $output -Encoding utf8
Write-Host "Recorded actual source pair: $output"
