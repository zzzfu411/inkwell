param([switch]$KeepArtifacts)

$ErrorActionPreference = "Stop"
$tauri = Split-Path $PSScriptRoot -Parent
$repo = Split-Path $tauri -Parent
$writer = Join-Path $repo "novel-writer"
$cargoRoot = Join-Path $tauri "src-tauri"
$runner = Join-Path $PSScriptRoot "contract\backend-contract-runner.mjs"
$binary = Join-Path $cargoRoot "target\debug\inkwell-http.exe"
$tempRoot = if ($KeepArtifacts) {
  [System.IO.Path]::GetFullPath((Join-Path $tauri "output\backend-contract"))
} else {
  [System.IO.Path]::GetFullPath((Join-Path ([System.IO.Path]::GetTempPath()) ("inkwell-contract-" + [guid]::NewGuid().ToString("N"))))
}
$allowedBase = if ($KeepArtifacts) {
  [System.IO.Path]::GetFullPath((Join-Path $tauri "output"))
} else {
  [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
}
$allowedPrefix = $allowedBase.TrimEnd([char[]]"\/") + [System.IO.Path]::DirectorySeparatorChar
if (-not $tempRoot.StartsWith($allowedPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "unsafe contract artifact path: $tempRoot"
}
if ($KeepArtifacts -and (Test-Path -LiteralPath $tempRoot)) {
  Remove-Item -LiteralPath $tempRoot -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null
. (Join-Path $PSScriptRoot "backend-test-common.ps1")

$pythonBackend = $null
$rustBackend = $null
try {
  node --check $runner
  if ($LASTEXITCODE -ne 0) { throw "contract runner syntax check failed" }

  Push-Location $cargoRoot
  try {
    cargo build --locked --bin inkwell-http
    if ($LASTEXITCODE -ne 0) { throw "Rust HTTP test backend build failed" }
  } finally { Pop-Location }

  $pythonRoot = Join-Path $tempRoot "python"
  New-Item -ItemType Directory -Force -Path $pythonRoot | Out-Null
  $pythonBackend = Start-InkwellPythonBackend -Writer $writer -Vault (Join-Path $pythonRoot "vault") -Settings (Join-Path $pythonRoot "settings.json") -LogRoot $pythonRoot
  & node $runner --base-url $pythonBackend.BaseUrl --backend python
  if ($LASTEXITCODE -ne 0) { throw "Python backend contract failed with exit code $LASTEXITCODE" }
  Stop-InkwellTestBackend $pythonBackend
  $pythonBackend = $null

  $rustRoot = Join-Path $tempRoot "rust"
  New-Item -ItemType Directory -Force -Path $rustRoot | Out-Null
  $rustBackend = Start-InkwellRustBackend -Binary $binary -Vault (Join-Path $rustRoot "vault") -DataDir (Join-Path $rustRoot "data") -UiDir $writer -LogRoot $rustRoot
  & node $runner --base-url $rustBackend.BaseUrl --backend rust --token $rustBackend.Token
  if ($LASTEXITCODE -ne 0) { throw "Rust backend contract failed with exit code $LASTEXITCODE" }
  Write-Host "BACKEND CONTRACT ALL GREEN"
  if ($KeepArtifacts) { Write-Host "Artifacts: $tempRoot" }
} finally {
  Stop-InkwellTestBackend $pythonBackend
  Stop-InkwellTestBackend $rustBackend
  if (-not $KeepArtifacts -and (Test-Path -LiteralPath $tempRoot)) {
    Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}
