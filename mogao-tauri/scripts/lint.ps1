$ErrorActionPreference = "Stop"
$tauri = Split-Path $PSScriptRoot -Parent
$writer = Join-Path (Split-Path $tauri -Parent) "novel-writer"
$eslint = Join-Path $tauri "node_modules\.bin\eslint.cmd"

if (-not (Test-Path -LiteralPath $eslint -PathType Leaf)) {
  throw "ESLint is not installed; run npm ci in $tauri"
}

Push-Location $writer
try {
  & $eslint --config (Join-Path $writer "eslint.config.mjs") "*.js" "scripts/**/*.mjs" "tests/**/*.mjs" "eslint.config.mjs"
  if ($LASTEXITCODE -ne 0) { throw "novel-writer ESLint failed with exit code $LASTEXITCODE" }
} finally {
  Pop-Location
}

Push-Location $tauri
try {
  & $eslint "scripts/**/*.mjs" "playwright.config.mjs" "eslint.config.mjs"
  if ($LASTEXITCODE -ne 0) { throw "mogao-tauri ESLint failed with exit code $LASTEXITCODE" }
} finally {
  Pop-Location
}
