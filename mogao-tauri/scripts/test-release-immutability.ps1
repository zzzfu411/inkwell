$ErrorActionPreference = "Stop"
$tauri = Split-Path $PSScriptRoot -Parent
$verify = Join-Path $PSScriptRoot "verify-release.ps1"
. (Join-Path $PSScriptRoot "release-common.ps1")
$releaseNames = Get-ReleaseNames
$tempBase = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd([char[]]"\/")
$fixtureRoot = Join-Path $tempBase ("inkwell-release-immutability-" + [guid]::NewGuid().ToString("N"))
if (-not ([System.IO.Path]::GetFullPath($fixtureRoot)).StartsWith($tempBase + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "unsafe immutable release fixture path"
}

function Write-Utf8([string]$Path, [string]$Value) {
  $parent = Split-Path $Path -Parent
  New-Item -ItemType Directory -Force -Path $parent | Out-Null
  [System.IO.File]::WriteAllText($Path, $Value, [System.Text.UTF8Encoding]::new($false))
}

function Artifact([string]$Path, [string]$RelativeName) {
  $item = Get-Item -LiteralPath $Path
  [ordered]@{ file = $RelativeName; bytes = $item.Length; sha256 = Get-FileSha256 $Path }
}

function Seal-Fixture([string]$Root, [int]$SchemaVersion) {
  New-Item -ItemType Directory -Force -Path (Join-Path $Root "ui") | Out-Null
  Write-Utf8 (Join-Path $Root "Inkwell.exe") "fake executable bytes"
  Copy-Item -LiteralPath (Join-Path $Root "Inkwell.exe") -Destination (Join-Path $Root $releaseNames.CompatibilityExe)
  Write-Utf8 (Join-Path $Root $releaseNames.GuideMarkdown) "fixture guide"
  Write-Utf8 (Join-Path $Root "ui\index.html") "<title>immutable fixture</title>"
  $primary = Artifact (Join-Path $Root "Inkwell.exe") "Inkwell.exe"
  $compatibility = Artifact (Join-Path $Root $releaseNames.CompatibilityExe) $releaseNames.CompatibilityExe
  $artifacts = [ordered]@{ inkwell = $primary; compatibility = $compatibility }
  if ($SchemaVersion -eq 4) {
    $artifacts["guide"] = Artifact (Join-Path $Root $releaseNames.GuideMarkdown) $releaseNames.GuideMarkdown
  }
  $manifest = [ordered]@{
    schemaVersion = $SchemaVersion
    product = "Inkwell"
    version = "0.19.0"
    builtAtUtc = "2000-01-01T00:00:00.0000000Z"
    source = [ordered]@{
      tauri = [ordered]@{ commit = ("a" * 40); dirty = $false; changeCount = 0; sourceTreeSha256 = ("b" * 64) }
      frontend = [ordered]@{ commit = ("c" * 40); dirty = $false; changeCount = 0; sourceTreeSha256 = ("d" * 64) }
      cargoLockSha256 = ("e" * 64)
      uiManifestSha256 = ("f" * 64)
      uiFileCount = 1
    }
    toolchain = [ordered]@{ rustc = "fixture"; cargo = "fixture"; node = "fixture" }
    buildSource = [ordered]@{ file = "mogao-tauri.exe"; bytes = $primary.bytes; sha256 = $primary.sha256 }
    artifacts = $artifacts
    ui = [ordered]@{ "index.html" = Get-FileSha256 (Join-Path $Root "ui\index.html") }
  }
  if ($SchemaVersion -eq 4) {
    $manifest["integrity"] = [ordered]@{ algorithm = "sha256"; manifest = "manifest.json"; checksum = "manifest.sha256" }
  }
  $manifestPath = Join-Path $Root "manifest.json"
  Write-Utf8 $manifestPath (($manifest | ConvertTo-Json -Depth 10) + "`n")
  if ($SchemaVersion -eq 4) {
    Write-Utf8 (Join-Path $Root "manifest.sha256") ((Get-FileSha256 $manifestPath) + "  manifest.json`n")
  }
}

function Verify-Fixture([string]$Root) {
  $global:LASTEXITCODE = 0
  & $verify -ReleaseRoot $Root
  if ($LASTEXITCODE -ne 0) { throw "fixture verification exited $LASTEXITCODE" }
}

function Expect-VerifyFailure([string]$Label, [string]$Root, [string]$Pattern) {
  try {
    Verify-Fixture $Root
  } catch {
    if (-not $_.Exception.Message.Contains($Pattern)) {
      throw "$Label failed for an unexpected reason: $($_.Exception.Message)"
    }
    return
  }
  throw "$Label unexpectedly passed immutable verification"
}

New-Item -ItemType Directory -Force -Path $fixtureRoot | Out-Null
try {
  $pristine = Join-Path $fixtureRoot "pristine-v4"
  Seal-Fixture $pristine 4
  # This fixture deliberately has no relationship to the current canonical source. A default
  # verification pass therefore proves that historical artifacts are checked against themselves.
  Verify-Fixture $pristine

  $uiTamper = Join-Path $fixtureRoot "ui-tamper"
  Copy-Item -LiteralPath $pristine -Destination $uiTamper -Recurse
  Write-Utf8 (Join-Path $uiTamper "ui\index.html") "tampered"
  Expect-VerifyFailure "UI tamper" $uiTamper "manifest UI hash mismatch"

  $extraFile = Join-Path $fixtureRoot "extra-file"
  Copy-Item -LiteralPath $pristine -Destination $extraFile -Recurse
  Write-Utf8 (Join-Path $extraFile "unexpected.txt") "not declared"
  Expect-VerifyFailure "extra file" $extraFile "file set mismatch"

  $manifestTamper = Join-Path $fixtureRoot "manifest-tamper"
  Copy-Item -LiteralPath $pristine -Destination $manifestTamper -Recurse
  [System.IO.File]::AppendAllText((Join-Path $manifestTamper "manifest.json"), " `n", [System.Text.UTF8Encoding]::new($false))
  Expect-VerifyFailure "manifest tamper" $manifestTamper "manifest checksum mismatch"

  $legacy = Join-Path $fixtureRoot "legacy-v3"
  Seal-Fixture $legacy 3
  Verify-Fixture $legacy
} finally {
  if (Test-Path -LiteralPath $fixtureRoot) { Remove-Item -LiteralPath $fixtureRoot -Recurse -Force }
}

Write-Host "release immutability tests: OK"
