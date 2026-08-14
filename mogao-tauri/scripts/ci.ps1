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
& (Join-Path $PSScriptRoot "check-version.ps1")
Require-Success "version consistency"

Write-Host "== release helper regression =="
& (Join-Path $PSScriptRoot "test-release-common.ps1")
Require-Success "release helper regression"

Write-Host "== UI manifest + sync =="
& (Join-Path $PSScriptRoot "check-ui-sync.ps1")
Require-Success "UI sync"

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

Write-Host "== JavaScript syntax + functional tests =="
Push-Location $writer
try {
  $files = @(Get-Content $uiManifest -Encoding UTF8 | ForEach-Object { $_.Trim() } | Where-Object { $_ -and $_.EndsWith(".js") -and -not $_.StartsWith("#") })
  foreach ($file in $files) {
    node --check $file
    Require-Success "node --check $file"
  }
  $tests = @(Get-ChildItem (Join-Path $writer "tests") -Filter "*.mjs" | ForEach-Object { $_.FullName })
  if ($tests.Count -eq 0) { throw "no Node functional tests discovered" }
  node --test $tests
  Require-Success "Node functional tests"
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

Write-Host "== Browser layout smoke =="
& (Join-Path $PSScriptRoot "browser-layout-smoke.ps1")
Require-Success "browser layout smoke"

Write-Host "== Approved visual baselines =="
& (Join-Path $PSScriptRoot "visual-regression.ps1")
Require-Success "visual baseline regression"

Write-Host "CI ALL GREEN"
