$ErrorActionPreference = "Stop"
$tauri = Split-Path $PSScriptRoot -Parent
$writer = Join-Path (Split-Path $tauri -Parent) "novel-writer"
$c8 = Join-Path $tauri "node_modules\.bin\c8.cmd"
$reportDir = Join-Path $tauri "output\coverage\domain"

if (-not (Test-Path -LiteralPath $c8 -PathType Leaf)) {
  throw "c8 is not installed; run npm ci in $tauri"
}
if (-not (Test-Path -LiteralPath $writer -PathType Container)) {
  throw "canonical UI repository was not found at $writer"
}

# This gate intentionally names the pure domain kernel, rather than counting adapters,
# controllers or presentation models as denominator padding. DOM-free application use cases
# remain covered by the full Node suite and the architecture boundary test.
$domainKernel = @(
  "chapter-state.js",
  "production-state.js",
  "production-quality.js",
  "quality-release-policy.js",
  "runtime-observability.js",
  "context-budget.js",
  "memory-reducers.js",
  "text-metrics.js"
)

foreach ($file in $domainKernel) {
  $path = Join-Path $writer $file
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
    throw "domain coverage input is missing: $path"
  }
}

$tests = @(Get-ChildItem (Join-Path $writer "tests") -Filter "*.mjs" | Sort-Object Name | ForEach-Object { $_.FullName })
if ($tests.Count -eq 0) {
  throw "no Node tests discovered under $(Join-Path $writer 'tests')"
}

$coverageArgs = @(
  "--all",
  "--src", ".",
  "--clean",
  "--temp-directory", (Join-Path $reportDir "tmp"),
  "--report-dir", $reportDir,
  "--reporter=text",
  "--reporter=json-summary",
  "--check-coverage",
  "--statements=80",
  "--branches=75",
  "--lines=80",
  "--functions=0"
)
foreach ($file in $domainKernel) {
  $coverageArgs += "--include=$file"
}

Write-Host "== pure domain kernel coverage (statements >=80%, branches >=75%) =="
Write-Host "Modules: $($domainKernel -join ', ')"
Write-Host "Report: $reportDir"
Push-Location $writer
try {
  & $c8 @coverageArgs node --test @tests
  $coverageExit = $LASTEXITCODE
} finally {
  Pop-Location
}

if ($coverageExit -ne 0) {
  throw "domain coverage gate failed with exit code $coverageExit; report: $reportDir"
}
