$ErrorActionPreference = "Stop"

function Get-InkwellFreeTcpPort {
  $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
  $listener.Start()
  try { return ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port } finally { $listener.Stop() }
}

function Get-InkwellLogText([string]$Path) {
  if (Test-Path -LiteralPath $Path -PathType Leaf) {
    return Get-Content -Raw -LiteralPath $Path -ErrorAction SilentlyContinue
  }
  return ""
}

function Wait-InkwellHealth([string]$BaseUrl, [System.Diagnostics.Process]$Process, [string]$Stdout, [string]$Stderr) {
  $lastError = ""
  for ($attempt = 0; $attempt -lt 120; $attempt++) {
    if ($Process.HasExited) { break }
    try {
      $client = New-Object System.Net.WebClient
      try {
        $client.Proxy = [System.Net.GlobalProxySelection]::GetEmptyWebProxy()
        $client.Encoding = [System.Text.Encoding]::UTF8
        $health = $client.DownloadString($BaseUrl + "api/health") | ConvertFrom-Json
      } finally {
        $client.Dispose()
      }
      if ($health.ok) { return }
    } catch {
      $lastError = $_.Exception.Message
    }
    Start-Sleep -Milliseconds 100
  }
  $state = if ($Process.HasExited) { "exit code $($Process.ExitCode)" } else { "still running" }
  throw "backend did not become ready at $BaseUrl ($state)`nlast probe: $lastError`nstdout:`n$(Get-InkwellLogText $Stdout)`nstderr:`n$(Get-InkwellLogText $Stderr)"
}

function Start-InkwellPythonBackend {
  param(
    [Parameter(Mandatory = $true)][string]$Writer,
    [Parameter(Mandatory = $true)][string]$Vault,
    [Parameter(Mandatory = $true)][string]$Settings,
    [Parameter(Mandatory = $true)][string]$LogRoot
  )
  $python = Get-Command python -ErrorAction SilentlyContinue
  $arguments = @("server.py")
  if (-not $python) {
    $python = Get-Command py -ErrorAction SilentlyContinue
    $arguments = @("-3", "server.py")
  }
  if (-not $python) { throw "Python was not found" }

  $port = Get-InkwellFreeTcpPort
  $stdout = Join-Path $LogRoot "python.stdout.log"
  $stderr = Join-Path $LogRoot "python.stderr.log"
  $oldPort = $env:MOGAO_PORT
  $oldVault = $env:MOGAO_VAULT
  $oldSettings = $env:MOGAO_SETTINGS
  try {
    $env:MOGAO_PORT = [string]$port
    $env:MOGAO_VAULT = $Vault
    $env:MOGAO_SETTINGS = $Settings
    $process = Start-Process -FilePath $python.Source -ArgumentList $arguments -WorkingDirectory $Writer -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr
  } finally {
    $env:MOGAO_PORT = $oldPort
    $env:MOGAO_VAULT = $oldVault
    $env:MOGAO_SETTINGS = $oldSettings
  }
  $baseUrl = "http://127.0.0.1:$port/"
  Wait-InkwellHealth $baseUrl $process $stdout $stderr
  return [pscustomobject]@{ Process = $process; BaseUrl = $baseUrl; Token = ""; Stdout = $stdout; Stderr = $stderr }
}

function Start-InkwellRustBackend {
  param(
    [Parameter(Mandatory = $true)][string]$Binary,
    [Parameter(Mandatory = $true)][string]$Vault,
    [Parameter(Mandatory = $true)][string]$DataDir,
    [Parameter(Mandatory = $true)][string]$UiDir,
    [Parameter(Mandatory = $true)][string]$LogRoot
  )
  if (-not (Test-Path -LiteralPath $Binary -PathType Leaf)) { throw "Rust HTTP binary missing: $Binary" }
  $stdout = Join-Path $LogRoot "rust.stdout.log"
  $stderr = Join-Path $LogRoot "rust.stderr.log"
  $oldVault = $env:MOGAO_VAULT
  $oldDataDir = $env:INKWELL_DATA_DIR
  $oldUiDir = $env:INKWELL_UI_DIR
  try {
    $env:MOGAO_VAULT = $Vault
    $env:INKWELL_DATA_DIR = $DataDir
    $env:INKWELL_UI_DIR = $UiDir
    $process = Start-Process -FilePath $Binary -WorkingDirectory (Split-Path $Binary -Parent) -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr
  } finally {
    $env:MOGAO_VAULT = $oldVault
    $env:INKWELL_DATA_DIR = $oldDataDir
    $env:INKWELL_UI_DIR = $oldUiDir
  }

  $port = $null
  $token = $null
  for ($attempt = 0; $attempt -lt 120; $attempt++) {
    if ($process.HasExited) { break }
    $raw = Get-InkwellLogText $stdout
    if ($raw -match 'INKWELL_HTTP_READY port=(\d+) token=([^\s]+)') {
      $port = [int]$Matches[1]
      $token = $Matches[2]
      break
    }
    Start-Sleep -Milliseconds 100
  }
  if (-not $port -or -not $token) {
    $state = if ($process.HasExited) { "exit code $($process.ExitCode)" } else { "still running" }
    throw "Rust backend did not publish readiness ($state)`nstdout:`n$(Get-InkwellLogText $stdout)`nstderr:`n$(Get-InkwellLogText $stderr)"
  }
  $baseUrl = "http://127.0.0.1:$port/"
  Wait-InkwellHealth $baseUrl $process $stdout $stderr
  return [pscustomobject]@{ Process = $process; BaseUrl = $baseUrl; Token = $token; Stdout = $stdout; Stderr = $stderr }
}

function Stop-InkwellTestBackend($Backend) {
  if ($Backend -and $Backend.Process -and -not $Backend.Process.HasExited) {
    Stop-Process -Id $Backend.Process.Id -Force -ErrorAction SilentlyContinue
  }
}
