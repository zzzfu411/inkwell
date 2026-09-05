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

$tempBase = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd([char[]]"\/")
$fixtureRoot = Join-Path $tempBase ("inkwell-release-common-" + [guid]::NewGuid().ToString("N"))
if (-not ([System.IO.Path]::GetFullPath($fixtureRoot)).StartsWith($tempBase + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "unsafe release-common fixture path"
}
New-Item -ItemType Directory -Force -Path $fixtureRoot | Out-Null
try {
  $manifestPath = Join-Path $fixtureRoot "ui-files.txt"
  @("index.html", "scripts/app.js") | Set-Content -LiteralPath $manifestPath -Encoding UTF8
  $manifestFiles = @(Get-ValidatedUiManifestFiles $manifestPath)
  Assert-True (($manifestFiles -join ",") -eq "index.html,scripts/app.js") "validated manifest order changed"
  $escaped = $false
  try { Resolve-SafeChildPath $fixtureRoot "../escape.txt" | Out-Null } catch { $escaped = $true }
  Assert-True $escaped "safe child resolver accepted traversal"

  $destination = Join-Path $fixtureRoot "published"
  New-Item -ItemType Directory -Force -Path $destination | Out-Null
  "old" | Set-Content -LiteralPath (Join-Path $destination "marker.txt") -Encoding UTF8
  $stage = Join-Path $fixtureRoot "stage-ok"
  New-Item -ItemType Directory -Force -Path $stage | Out-Null
  "new" | Set-Content -LiteralPath (Join-Path $stage "marker.txt") -Encoding UTF8
  Publish-DirectoryStage $stage $destination {
    param($published)
    if ((Get-Content -Raw -LiteralPath (Join-Path $published "marker.txt")).Trim() -ne "new") {
      throw "published content validation failed"
    }
  }
  Assert-True ((Get-Content -Raw -LiteralPath (Join-Path $destination "marker.txt")).Trim() -eq "new") "stage was not published"

  $failedStage = Join-Path $fixtureRoot "stage-fail"
  New-Item -ItemType Directory -Force -Path $failedStage | Out-Null
  "invalid" | Set-Content -LiteralPath (Join-Path $failedStage "marker.txt") -Encoding UTF8
  $rolledBack = $false
  try {
    Publish-DirectoryStage $failedStage $destination { throw "expected validation failure" }
  } catch {
    $rolledBack = $_.Exception.Message.Contains("expected validation failure")
  }
  Assert-True $rolledBack "publish validation failure did not propagate"
  Assert-True ((Get-Content -Raw -LiteralPath (Join-Path $destination "marker.txt")).Trim() -eq "new") "failed publish did not restore old destination"
  Assert-True (Test-Path -LiteralPath $failedStage -PathType Container) "failed stage was not preserved for diagnostics"

  $monorepo = Join-Path $fixtureRoot "monorepo"
  $writerFixture = Join-Path $monorepo "novel-writer"
  $tauriFixture = Join-Path $monorepo "mogao-tauri"
  New-Item -ItemType Directory -Force -Path $writerFixture,$tauriFixture | Out-Null
  "writer v1" | Set-Content -LiteralPath (Join-Path $writerFixture "app.js") -Encoding UTF8
  "tauri v1" | Set-Content -LiteralPath (Join-Path $tauriFixture "main.rs") -Encoding UTF8
  & git -C $monorepo init -q
  & git -c "safe.directory=$monorepo" -C $monorepo add -- .
  & git -c "safe.directory=$monorepo" -c "user.name=Inkwell Test" -c "user.email=test@example.invalid" -C $monorepo commit -q -m "fixture"
  if ($LASTEXITCODE -ne 0) { throw "could not create monorepo test fixture" }
  $before = Get-GitState $writerFixture @("output")
  Assert-True (-not $before.dirty) "fresh monorepo child must be clean"
  "tauri v2" | Set-Content -LiteralPath (Join-Path $tauriFixture "main.rs") -Encoding UTF8
  New-Item -ItemType Directory -Path (Join-Path $writerFixture "output") | Out-Null
  "artifact" | Set-Content -LiteralPath (Join-Path $writerFixture "output/report.txt") -Encoding UTF8
  $excluded = Get-GitState $writerFixture @("output")
  Assert-True (-not $excluded.dirty) "sibling changes and excluded artifacts must not dirty a monorepo child"
  Assert-True ($excluded.sourceTreeSha256 -eq $before.sourceTreeSha256) "child source hash must exclude sibling changes and artifacts"
  "writer v2" | Set-Content -LiteralPath (Join-Path $writerFixture "app.js") -Encoding UTF8
  $after = Get-GitState $writerFixture @("output")
  Assert-True ($after.dirty -and $after.changeCount -eq 1) "child source change must be detected exactly once"
  Assert-True ($after.sourceTreeSha256 -ne $before.sourceTreeSha256) "child source modification must change its hash"
  Assert-True ($after.commit -eq (Get-GitState $tauriFixture).commit) "monorepo children must record the same commit"
} finally {
  if (Test-Path -LiteralPath $fixtureRoot) { Remove-Item -LiteralPath $fixtureRoot -Recurse -Force }
}

Write-Host "release-common tests: OK"
