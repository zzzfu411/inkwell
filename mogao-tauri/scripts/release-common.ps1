$ErrorActionPreference = "Stop"

function ConvertFrom-UnicodeCodePoints([int[]]$CodePoints) {
  -join @($CodePoints | ForEach-Object { [char]$_ })
}

function Get-ReleaseNames {
  $productName = ConvertFrom-UnicodeCodePoints @(0x58A8, 0x7A3F)
  $guideStem = ConvertFrom-UnicodeCodePoints @(0x4F7F, 0x7528, 0x8BF4, 0x660E)
  $legacyProductName = ConvertFrom-UnicodeCodePoints @(0x6FA7, 0x3127, 0xE7C8)
  $legacyGuideStem = ConvertFrom-UnicodeCodePoints @(0x6D63, 0x8DE8, 0x6564, 0x7487, 0x5B58, 0x69D1)

  [ordered]@{
    CompatibilityExe = $productName + "-Tauri.exe"
    GuideMarkdown = $guideStem + ".md"
    ObsoleteGuideText = $guideStem + ".txt"
    LegacyCompatibilityExe = $legacyProductName + "-Tauri.exe"
    LegacyGuideText = $legacyGuideStem + ".txt"
  }
}

function Get-FileSha256([string]$Path) {
  (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Test-SourcePathExcluded([string]$RelativePath, [string[]]$ExcludedPrefixes) {
  $normalized = $RelativePath.Replace("\", "/").TrimStart("/")
  foreach ($prefixValue in @($ExcludedPrefixes)) {
    $prefix = $prefixValue.Replace("\", "/").Trim("/")
    if (-not $prefix) { continue }
    if ($normalized.Equals($prefix, [System.StringComparison]::OrdinalIgnoreCase) -or
        $normalized.StartsWith($prefix + "/", [System.StringComparison]::OrdinalIgnoreCase)) {
      return $true
    }
  }

  $cacheSegments = @(
    "__pycache__",
    ".pytest_cache",
    ".playwright-cli",
    ".visual-vault",
    "node_modules",
    "playwright-report",
    "test-results"
  )
  foreach ($segment in $normalized.Split("/")) {
    if ($cacheSegments -contains $segment.ToLowerInvariant()) { return $true }
  }
  return $normalized.EndsWith(".pyc", [System.StringComparison]::OrdinalIgnoreCase) -or
    $normalized.EndsWith(".pyo", [System.StringComparison]::OrdinalIgnoreCase)
}

function Get-GitStatusPaths([string]$StatusLine) {
  if (-not $StatusLine -or $StatusLine.Length -lt 4) { return @() }
  $payload = $StatusLine.Substring(3).Trim()
  if (-not $payload) { return @() }
  $parts = if ($payload.Contains(" -> ")) { $payload.Split(@(" -> "), 2, [System.StringSplitOptions]::None) } else { @($payload) }
  @($parts | ForEach-Object { $_.Trim().Trim('"') } | Where-Object { $_ })
}

function Test-GitStatusEntryExcluded([string]$StatusLine, [string[]]$ExcludedPrefixes) {
  $paths = @(Get-GitStatusPaths $StatusLine)
  if ($paths.Count -eq 0) { return $false }
  foreach ($path in $paths) {
    if (-not (Test-SourcePathExcluded $path $ExcludedPrefixes)) { return $false }
  }
  return $true
}

function Get-SourceTreeSha256([string]$Repo, [string[]]$ExcludedPrefixes = @()) {
  if (-not (Test-Path -LiteralPath (Join-Path $Repo ".git"))) {
    throw "Git repository missing: $Repo"
  }

  $safeDirectory = "safe.directory=$Repo"
  $gitOutput = @(& git -c $safeDirectory -c core.quotepath=false -C $Repo ls-files --cached --others --exclude-standard 2>&1)
  if ($LASTEXITCODE -ne 0) {
    throw "Git file listing failed for $Repo`: $($gitOutput -join ' ')"
  }

  $files = [string[]]@($gitOutput | ForEach-Object { [string]$_ } | Where-Object {
    $_ -and -not (Test-SourcePathExcluded $_ $ExcludedPrefixes)
  })
  [Array]::Sort($files, [System.StringComparer]::Ordinal)

  $records = New-Object "System.Collections.Generic.List[string]"
  foreach ($relativePath in $files) {
    $normalized = $relativePath.Replace("\", "/")
    $path = Join-Path $Repo $relativePath
    $hash = if (Test-Path -LiteralPath $path -PathType Leaf) {
      Get-FileSha256 $path
    } else {
      "missing"
    }
    [void]$records.Add($normalized + "`t" + $hash + "`n")
  }

  $payload = [System.Text.Encoding]::UTF8.GetBytes(($records -join ""))
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $digest = $sha.ComputeHash($payload)
  } finally {
    $sha.Dispose()
  }
  -join @($digest | ForEach-Object { $_.ToString("x2") })
}

function Get-GitState([string]$Repo, [string[]]$ExcludedPrefixes = @()) {
  if (-not (Test-Path -LiteralPath (Join-Path $Repo ".git"))) {
    throw "Git repository missing: $Repo"
  }
  $safeDirectory = "safe.directory=$Repo"
  $commitOutput = @(& git -c $safeDirectory -C $Repo rev-parse HEAD 2>&1)
  if ($LASTEXITCODE -ne 0) {
    throw "Git commit lookup failed for $Repo`: $($commitOutput -join ' ')"
  }
  $commit = ($commitOutput | Out-String).Trim()
  if (-not $commit) { throw "Git commit lookup returned empty output for $Repo" }

  $statusOutput = @(& git -c $safeDirectory -c core.quotepath=false -C $Repo status --porcelain=v1 --untracked-files=all 2>&1)
  if ($LASTEXITCODE -ne 0) {
    throw "Git status failed for $Repo`: $($statusOutput -join ' ')"
  }
  $changes = @($statusOutput | Where-Object {
    $_ -and -not (Test-GitStatusEntryExcluded ([string]$_) $ExcludedPrefixes)
  })
  [ordered]@{
    commit = $commit
    dirty = $changes.Count -gt 0
    changeCount = $changes.Count
    sourceTreeSha256 = Get-SourceTreeSha256 $Repo $ExcludedPrefixes
  }
}

function Assert-CleanReleaseSources([string]$TauriRepo, [string]$FrontendRepo, [switch]$AllowDirty) {
  $states = @(
    [pscustomobject]@{ Label = "mogao-tauri"; Repo = $TauriRepo; State = Get-GitState $TauriRepo @("release", "src-tauri/target", "src-tauri/ui-embed", "vault", "output") },
    [pscustomobject]@{ Label = "novel-writer"; Repo = $FrontendRepo; State = Get-GitState $FrontendRepo @("output") }
  )
  $dirty = @($states | Where-Object { $_.State.dirty })
  if ($dirty.Count -eq 0) {
    Write-Host "Release source gate: both repositories are clean"
    return
  }
  $details = @($dirty | ForEach-Object { "$($_.Label)=$($_.State.changeCount) change(s)" }) -join ", "
  if (-not $AllowDirty) {
    throw "Release source gate blocked a dirty build ($details). Review and commit the intended changes, or pass -AllowDirty for a clearly marked development build."
  }
  Write-Warning "Building from dirty sources by explicit request: $details. The manifest will record dirty=true and the source-tree hashes."
}

function Assert-ReleaseExecutableSet([string]$Release, [string]$ExpectedCompatibilityName) {
  $compatibilityExecutables = @(Get-ChildItem -LiteralPath $Release -File | Where-Object {
    $_.Name.EndsWith("-Tauri.exe", [System.StringComparison]::OrdinalIgnoreCase)
  })
  if ($compatibilityExecutables.Count -ne 1 -or
      -not $compatibilityExecutables[0].Name.Equals($ExpectedCompatibilityName, [System.StringComparison]::Ordinal)) {
    $actual = @($compatibilityExecutables | ForEach-Object { $_.Name }) -join ", "
    throw "unexpected compatibility executable set: $actual"
  }
}
