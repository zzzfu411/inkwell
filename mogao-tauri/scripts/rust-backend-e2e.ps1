param(
  [switch]$KeepArtifacts,
  [ValidateSet("msedge", "chrome", "firefox", "webkit")]
  [string]$Browser = "msedge"
)

$ErrorActionPreference = "Stop"
$tauri = Split-Path $PSScriptRoot -Parent
$repo = Split-Path $tauri -Parent
$writer = Join-Path $repo "novel-writer"
$cargoRoot = Join-Path $tauri "src-tauri"
$binary = Join-Path $cargoRoot "target\debug\inkwell-http.exe"
$playwright = Join-Path $tauri "node_modules\.bin\playwright.cmd"
$config = Join-Path $tauri "playwright.config.mjs"
$spec = "scripts/playwright/rust-backend.spec.mjs"
$tempRoot = if ($KeepArtifacts) {
  [System.IO.Path]::GetFullPath((Join-Path $tauri "output\playwright\rust-backend"))
} else {
  [System.IO.Path]::GetFullPath((Join-Path ([System.IO.Path]::GetTempPath()) ("inkwell-rust-e2e-" + [guid]::NewGuid().ToString("N"))))
}
$allowedBase = if ($KeepArtifacts) {
  [System.IO.Path]::GetFullPath((Join-Path $tauri "output\playwright"))
} else {
  [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
}
$allowedPrefix = $allowedBase.TrimEnd([char[]]"\/") + [System.IO.Path]::DirectorySeparatorChar
if (-not $tempRoot.StartsWith($allowedPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "unsafe Rust E2E artifact path: $tempRoot"
}
if ($KeepArtifacts -and (Test-Path -LiteralPath $tempRoot)) {
  Remove-Item -LiteralPath $tempRoot -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null
. (Join-Path $PSScriptRoot "backend-test-common.ps1")

$backend = $null
$oldBaseUrl = $env:INKWELL_TEST_BASE_URL
$oldToken = $env:INKWELL_TEST_TOKEN
$oldOutput = $env:INKWELL_TEST_OUTPUT
$oldBrowser = $env:INKWELL_TEST_BROWSER
try {
  Push-Location $cargoRoot
  try {
    cargo build --locked --bin inkwell-http
    if ($LASTEXITCODE -ne 0) { throw "Rust HTTP test backend build failed" }
  } finally { Pop-Location }

  $backend = Start-InkwellRustBackend -Binary $binary -Vault (Join-Path $tempRoot "vault") -DataDir (Join-Path $tempRoot "data") -UiDir $writer -LogRoot $tempRoot
  $artifactRoot = Join-Path $tempRoot "test-results"
  New-Item -ItemType Directory -Force -Path $artifactRoot | Out-Null
  $env:INKWELL_TEST_BASE_URL = $backend.BaseUrl
  $env:INKWELL_TEST_TOKEN = $backend.Token
  $env:INKWELL_TEST_OUTPUT = $artifactRoot
  $env:INKWELL_TEST_BROWSER = $Browser
  Push-Location $tauri
  try {
    & $playwright test $spec --config $config --workers=1
    if ($LASTEXITCODE -ne 0) { throw "formal Rust backend E2E failed with exit code $LASTEXITCODE" }
  } finally { Pop-Location }
  $firstOrigin = $backend.BaseUrl
  Stop-InkwellTestBackend $backend
  $backend = Start-InkwellRustBackend -Binary $binary -Vault (Join-Path $tempRoot "vault") -DataDir (Join-Path $tempRoot "data") -UiDir $writer -LogRoot $tempRoot
  if ($backend.BaseUrl -eq $firstOrigin) { throw "Restart test requires a different origin" }
  $env:INKWELL_TEST_BASE_URL = $backend.BaseUrl
  $env:INKWELL_TEST_TOKEN = $backend.Token
  Push-Location $tauri
  try {
    & $playwright test scripts/playwright/restart-recovery.spec.mjs scripts/playwright/storage-scale.spec.mjs --config $config --workers=1
    if ($LASTEXITCODE -ne 0) { throw "restart recovery failed" }
    @{ previousOrigin = $firstOrigin; restartedOrigin = $backend.BaseUrl; recovered = $true } | ConvertTo-Json | Set-Content (Join-Path $tempRoot "restart-evidence.json") -Encoding utf8
  } finally { Pop-Location }
  Write-Host "Formal Rust backend E2E passed ($Browser)"
  if ($KeepArtifacts) { Write-Host "Artifacts: $tempRoot" }
} finally {
  Stop-InkwellTestBackend $backend
  $env:INKWELL_TEST_BASE_URL = $oldBaseUrl
  $env:INKWELL_TEST_TOKEN = $oldToken
  $env:INKWELL_TEST_OUTPUT = $oldOutput
  $env:INKWELL_TEST_BROWSER = $oldBrowser
  if (-not $KeepArtifacts -and (Test-Path -LiteralPath $tempRoot)) {
    Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}
