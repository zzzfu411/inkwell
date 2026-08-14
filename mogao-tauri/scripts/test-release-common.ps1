$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "release-common.ps1")

function Assert-True([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw $Message }
}

$generated = @("release", "src-tauri/target", "src-tauri/ui-embed", "output")
Assert-True (Test-GitStatusEntryExcluded " M release/Inkwell.exe" $generated) "tracked release output must be excluded"
Assert-True (Test-GitStatusEntryExcluded "?? output/playwright/failure.png" $generated) "untracked test output must be excluded"
Assert-True (Test-GitStatusEntryExcluded "R  release/old.exe -> release/new.exe" $generated) "rename inside an excluded tree must be excluded"
Assert-True (-not (Test-GitStatusEntryExcluded " M src-tauri/src/lib.rs" $generated)) "source changes must remain dirty"
Assert-True (-not (Test-GitStatusEntryExcluded "R  release/old.exe -> src-tauri/src/lib.rs" $generated)) "rename into source must remain dirty"
Assert-True (Test-GitStatusEntryExcluded "?? tests/__pycache__/case.pyc" @()) "known cache paths must be excluded"

Write-Host "release-common tests: OK"
