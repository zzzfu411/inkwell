$ErrorActionPreference = "Stop"
$tauri = Split-Path $PSScriptRoot -Parent
$writer = Join-Path (Split-Path $tauri -Parent) "novel-writer"
$uiManifest = Join-Path $tauri "ui-files.txt"

function Require-Success($label) {
  if ($null -ne $LASTEXITCODE -and $LASTEXITCODE -ne 0) {
    throw "$label failed with exit code $LASTEXITCODE"
  }
}

Write-Host "== version consistency =="
& (Join-Path $PSScriptRoot "record-source-pair.ps1")
Require-Success "source pairing record"
& (Join-Path $PSScriptRoot "check-version.ps1")
Require-Success "version consistency"

Write-Host "== release helper regression =="
& (Join-Path $PSScriptRoot "test-release-common.ps1")
Require-Success "release helper regression"
& (Join-Path $PSScriptRoot "test-release-immutability.ps1")
Require-Success "release immutability regression"

Write-Host "== UI manifest + sync =="
& (Join-Path $PSScriptRoot "check-ui-sync.ps1")
Require-Success "UI sync"

Write-Host "== JavaScript correctness lint =="
Push-Location $tauri
try {
  npm run lint
  Require-Success "JavaScript lint"
} finally {
  Pop-Location
}

Write-Host "== Rust format/check/test =="
Push-Location (Join-Path $tauri "src-tauri")
try {
  cargo fmt -- --check
  Require-Success "cargo fmt"
  cargo check --locked
  Require-Success "cargo check"
  cargo test --locked
  Require-Success "cargo test"
} finally {
  Pop-Location
}

Write-Host "== JavaScript syntax =="
Push-Location $writer
try {
  $files = @(Get-Content $uiManifest -Encoding UTF8 | ForEach-Object { $_.Trim() } | Where-Object { $_ -and $_.EndsWith(".js") -and -not $_.StartsWith("#") })
  foreach ($file in $files) {
    node --check $file
    Require-Success "node --check $file"
  }
} finally {
  Pop-Location
}

Write-Host "== Node functional tests + pure domain coverage =="
Push-Location $tauri
try {
  npm run test:coverage
  Require-Success "Node functional tests and domain coverage"
} finally {
  Pop-Location
}

Write-Host "== Deterministic article-quality protocol fixture =="
Push-Location $tauri
try {
  npm run test:quality
  Require-Success "quality A/B protocol fixture"
  npm run verify:quality-release
  Require-Success "quality release evidence contract"
} finally {
  Pop-Location
}

Write-Host "== 20/100/400 chapter performance budgets =="
Push-Location $tauri
try {
  npm run test:performance
  Require-Success "performance budgets"
} finally {
  Pop-Location
}

Write-Host "== Python debug regression =="
Push-Location $writer
$oldPyBytecode = $env:PYTHONDONTWRITEBYTECODE
$env:PYTHONDONTWRITEBYTECODE = "1"
try {
  if (Get-Command python -ErrorAction SilentlyContinue) {
    python -m unittest discover -s tests -p "test_*.py"
  } elseif (Get-Command py -ErrorAction SilentlyContinue) {
    py -3 -m unittest discover -s tests -p "test_*.py"
  } else {
    throw "Python was not found"
  }
  Require-Success "Python tests"
} finally {
  $env:PYTHONDONTWRITEBYTECODE = $oldPyBytecode
  Pop-Location
}

Write-Host "== Shared Rust/Python backend contract =="
& (Join-Path $PSScriptRoot "backend-contract.ps1") -KeepArtifacts
Require-Success "backend contract"

Write-Host "== Formal Rust backend browser E2E =="
& (Join-Path $PSScriptRoot "rust-backend-e2e.ps1") -KeepArtifacts
Require-Success "formal Rust backend E2E"

Write-Host "== Browser layout smoke =="
& (Join-Path $PSScriptRoot "browser-layout-smoke.ps1") -KeepArtifacts
Require-Success "browser layout smoke"

Write-Host "== Approved visual baselines =="
& (Join-Path $PSScriptRoot "visual-regression.ps1") -KeepArtifacts
Require-Success "visual baseline regression"

Write-Host "CI ALL GREEN"
