param(
  [ValidateSet("layout", "visual")]
  [string]$Suite = "visual",
  [switch]$KeepArtifacts,
  [switch]$UpdateSnapshots,
  [ValidateSet("msedge", "chrome", "firefox", "webkit")]
  [string]$Browser = "msedge"
)

$ErrorActionPreference = "Stop"
$tauri = Split-Path $PSScriptRoot -Parent
$writer = Join-Path (Split-Path $tauri -Parent) "novel-writer"
$config = Join-Path $tauri "playwright.config.mjs"
$playwright = Join-Path $tauri "node_modules\.bin\playwright.cmd"
$specRelative = if ($Suite -eq "layout") {
  "scripts/playwright/layout-smoke.spec.mjs"
} else {
  "scripts/playwright/visual-regression.spec.mjs"
}
$spec = Join-Path $tauri ($specRelative.Replace("/", "\"))

if (-not (Test-Path -LiteralPath $playwright -PathType Leaf)) {
  throw "Pinned Playwright is missing. Run npm install in $tauri first."
}
if (-not (Test-Path -LiteralPath $config -PathType Leaf)) { throw "Playwright config missing: $config" }
if (-not (Test-Path -LiteralPath $spec -PathType Leaf)) { throw "Playwright spec missing: $spec" }

function Get-FreeTcpPort {
  $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
  $listener.Start()
  try { return ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port } finally { $listener.Stop() }
}

$tempRoot = [System.IO.Path]::GetFullPath((Join-Path ([System.IO.Path]::GetTempPath()) ("inkwell-browser-" + [guid]::NewGuid().ToString("N"))))
$tempBase = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
if (-not $tempRoot.StartsWith($tempBase, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "unsafe browser test temp path: $tempRoot"
}
New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null

$artifactRoot = if ($KeepArtifacts) {
  Join-Path $tauri "output\playwright\$Suite"
} else {
  Join-Path $tempRoot "test-results"
}
$artifactRoot = [System.IO.Path]::GetFullPath($artifactRoot)
if ($KeepArtifacts) {
  $allowedRoot = [System.IO.Path]::GetFullPath((Join-Path $tauri "output\playwright"))
  if (-not $artifactRoot.StartsWith($allowedRoot + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "unsafe browser artifact path: $artifactRoot"
  }
}
New-Item -ItemType Directory -Force -Path $artifactRoot | Out-Null

$port = Get-FreeTcpPort
$baseUrl = "http://127.0.0.1:$port/"
$vault = Join-Path $tempRoot "vault"
$settings = Join-Path $tempRoot "mogao-settings.json"
$serverStdout = Join-Path $tempRoot "server.stdout.log"
$serverStderr = Join-Path $tempRoot "server.stderr.log"
$server = $null
$oldPort = $env:MOGAO_PORT
$oldVault = $env:MOGAO_VAULT
$oldSettings = $env:MOGAO_SETTINGS
$oldBaseUrl = $env:INKWELL_TEST_BASE_URL
$oldOutput = $env:INKWELL_TEST_OUTPUT
$oldBrowser = $env:INKWELL_TEST_BROWSER

try {
  $env:MOGAO_PORT = [string]$port
  $env:MOGAO_VAULT = $vault
  $env:MOGAO_SETTINGS = $settings
  $env:INKWELL_TEST_BASE_URL = $baseUrl
  $env:INKWELL_TEST_OUTPUT = $artifactRoot
  $env:INKWELL_TEST_BROWSER = $Browser

  $python = Get-Command python -ErrorAction SilentlyContinue
  if ($python) {
    $server = Start-Process -FilePath $python.Source -ArgumentList @("server.py") -WorkingDirectory $writer -WindowStyle Hidden -PassThru -RedirectStandardOutput $serverStdout -RedirectStandardError $serverStderr
  } else {
    $py = Get-Command py -ErrorAction SilentlyContinue
    if (-not $py) { throw "Python was not found" }
    $server = Start-Process -FilePath $py.Source -ArgumentList @("-3", "server.py") -WorkingDirectory $writer -WindowStyle Hidden -PassThru -RedirectStandardOutput $serverStdout -RedirectStandardError $serverStderr
  }

  $ready = $false
  for ($attempt = 0; $attempt -lt 60; $attempt++) {
    if ($server.HasExited) { break }
    try {
      $health = Invoke-RestMethod -Uri ($baseUrl + "api/health") -TimeoutSec 1
      if ($health.ok) { $ready = $true; break }
    } catch {}
    Start-Sleep -Milliseconds 200
  }
  if (-not $ready) {
    $log = if (Test-Path -LiteralPath $serverStderr) { Get-Content -Raw -LiteralPath $serverStderr } else { "" }
    throw "debug server did not become ready at $baseUrl`n$log"
  }

  $args = @("test", $specRelative, "--config", $config, "--workers=1")
  if ($UpdateSnapshots) { $args += "--update-snapshots=all" }
  Push-Location $tauri
  try {
    & $playwright @args
    if ($LASTEXITCODE -ne 0) { throw "$Suite browser suite failed with exit code $LASTEXITCODE" }
  } finally {
    Pop-Location
  }
  Write-Host "Playwright $Suite suite passed ($Browser)"
  if ($KeepArtifacts) { Write-Host "Artifacts: $artifactRoot" }
} finally {
  if ($server -and -not $server.HasExited) {
    Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue
  }
  $env:MOGAO_PORT = $oldPort
  $env:MOGAO_VAULT = $oldVault
  $env:MOGAO_SETTINGS = $oldSettings
  $env:INKWELL_TEST_BASE_URL = $oldBaseUrl
  $env:INKWELL_TEST_OUTPUT = $oldOutput
  $env:INKWELL_TEST_BROWSER = $oldBrowser
  if (Test-Path -LiteralPath $tempRoot) {
    try { Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction Stop }
    catch { Write-Warning "browser test temp cleanup deferred: $tempRoot ($($_.Exception.Message))" }
  }
}
