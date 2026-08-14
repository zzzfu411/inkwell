param(
  [switch]$KeepArtifacts,
  [ValidateSet("msedge", "chrome", "firefox", "webkit")]
  [string]$Browser = "msedge"
)

& (Join-Path $PSScriptRoot "visual-regression.ps1") -Suite layout -KeepArtifacts:$KeepArtifacts -Browser $Browser
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
