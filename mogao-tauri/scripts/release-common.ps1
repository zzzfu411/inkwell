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
  $stream = [System.IO.File]::OpenRead($Path)
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $digest = $sha.ComputeHash($stream)
  } finally {
    $sha.Dispose()
    $stream.Dispose()
  }
  -join @($digest | ForEach-Object { $_.ToString("x2") })
}

function Resolve-SafeChildPath([string]$Root, [string]$RelativePath) {
  if (-not $RelativePath) { throw "relative path is empty" }
  $normalized = $RelativePath.Replace("\", "/")
  if ([System.IO.Path]::IsPathRooted($normalized) -or (($normalized -split "/") -contains "..")) {
    throw "unsafe relative path: $RelativePath"
  }
  $resolvedRoot = [System.IO.Path]::GetFullPath($Root).TrimEnd([char[]]"\/")
  $resolvedPath = [System.IO.Path]::GetFullPath((Join-Path $resolvedRoot $normalized))
  $prefix = $resolvedRoot + [System.IO.Path]::DirectorySeparatorChar
  if (-not $resolvedPath.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "path escapes root: $RelativePath"
  }
  $resolvedPath
}

function Get-ValidatedUiManifestFiles([string]$ManifestPath) {
  if (-not (Test-Path -LiteralPath $ManifestPath -PathType Leaf)) {
    throw "missing UI manifest: $ManifestPath"
  }
  $files = @(Get-Content -LiteralPath $ManifestPath -Encoding UTF8 | ForEach-Object { $_.Trim() } | Where-Object {
    $_ -and -not $_.StartsWith("#")
  } | ForEach-Object { $_.Replace("\", "/") })
  if ($files.Count -eq 0) { throw "UI manifest is empty: $ManifestPath" }
  $duplicates = @($files | Group-Object { $_.ToLowerInvariant() } | Where-Object { $_.Count -gt 1 } | ForEach-Object {
    $_.Group[0]
  })
  if ($duplicates.Count -gt 0) { throw "duplicate UI manifest entries: $($duplicates -join ', ')" }
  foreach ($file in $files) {
    if ([System.IO.Path]::IsPathRooted($file) -or (($file -split "/") -contains "..")) {
      throw "unsafe UI manifest entry: $file"
    }
  }
  $files
}

function Copy-ManifestFiles([string]$SourceRoot, [string]$DestinationRoot, [string[]]$Files) {
  if (-not (Test-Path -LiteralPath $SourceRoot -PathType Container)) {
    throw "manifest source directory is missing: $SourceRoot"
  }
  New-Item -ItemType Directory -Force -Path $DestinationRoot | Out-Null
  foreach ($file in @($Files)) {
    $source = Resolve-SafeChildPath $SourceRoot $file
    $destination = Resolve-SafeChildPath $DestinationRoot $file
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
      throw "manifest source file is missing: $file"
    }
    $parent = Split-Path $destination -Parent
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
    Copy-Item -LiteralPath $source -Destination $destination -Force
  }
}

function Get-RelativeLeafFiles([string]$Root) {
  $resolvedRoot = [System.IO.Path]::GetFullPath($Root).TrimEnd([char[]]"\/")
  if (-not (Test-Path -LiteralPath $resolvedRoot -PathType Container)) { return @() }
  @(
    Get-ChildItem -LiteralPath $resolvedRoot -Recurse -File | ForEach-Object {
      $_.FullName.Substring($resolvedRoot.Length + 1).Replace("\", "/")
    } | Sort-Object
  )
}

function Assert-ExactFileSet([string]$Root, [string[]]$ExpectedFiles, [string]$Label = "directory") {
  $expected = @($ExpectedFiles | ForEach-Object { $_.Replace("\", "/") } | Sort-Object -Unique)
  $actual = @(Get-RelativeLeafFiles $Root)
  $missing = @($expected | Where-Object { $actual -notcontains $_ })
  $extra = @($actual | Where-Object { $expected -notcontains $_ })
  if ($missing.Count -gt 0 -or $extra.Count -gt 0) {
    throw "$Label file set mismatch; missing=[$($missing -join ', ')]; extra=[$($extra -join ', ')]"
  }
}

function Publish-DirectoryStage(
  [string]$Stage,
  [string]$Destination,
  [scriptblock]$Validate = $null
) {
  $stagePath = [System.IO.Path]::GetFullPath($Stage).TrimEnd([char[]]"\/")
  $destinationPath = [System.IO.Path]::GetFullPath($Destination).TrimEnd([char[]]"\/")
  if (-not (Test-Path -LiteralPath $stagePath -PathType Container)) {
    throw "publish stage is missing: $stagePath"
  }
  if ([System.IO.Path]::GetPathRoot($stagePath) -ne [System.IO.Path]::GetPathRoot($destinationPath)) {
    throw "stage and destination must be on the same volume"
  }
  if ($stagePath.Equals($destinationPath, [System.StringComparison]::OrdinalIgnoreCase) -or
      $stagePath.StartsWith($destinationPath + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase) -or
      $destinationPath.StartsWith($stagePath + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "stage and destination must be disjoint directories"
  }

  $destinationParent = Split-Path $destinationPath -Parent
  New-Item -ItemType Directory -Force -Path $destinationParent | Out-Null
  $backupPath = Join-Path $destinationParent ((Split-Path $destinationPath -Leaf) + ".backup-" + [guid]::NewGuid().ToString("N"))
  $hadDestination = Test-Path -LiteralPath $destinationPath -PathType Container
  $published = $false
  try {
    if ($hadDestination) { Move-Item -LiteralPath $destinationPath -Destination $backupPath }
    Move-Item -LiteralPath $stagePath -Destination $destinationPath
    $published = $true
    if ($Validate) { & $Validate $destinationPath }
    if ($hadDestination -and (Test-Path -LiteralPath $backupPath)) {
      Remove-Item -LiteralPath $backupPath -Recurse -Force
    }
  } catch {
    $publishError = $_
    if ($published -and (Test-Path -LiteralPath $destinationPath) -and -not (Test-Path -LiteralPath $stagePath)) {
      Move-Item -LiteralPath $destinationPath -Destination $stagePath -ErrorAction SilentlyContinue
    }
    if ($hadDestination -and (Test-Path -LiteralPath $backupPath) -and -not (Test-Path -LiteralPath $destinationPath)) {
      Move-Item -LiteralPath $backupPath -Destination $destinationPath -ErrorAction SilentlyContinue
    }
    throw $publishError
  }
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

function Get-ContainingGitRoot([string]$Repo) {
  $candidate = [System.IO.Path]::GetFullPath($Repo).TrimEnd([char[]]"\/")
  while ($candidate) {
    if (Test-Path -LiteralPath (Join-Path $candidate ".git")) { return $candidate }
    $parent = Split-Path $candidate -Parent
    if ($parent -eq $candidate) { break }
    $candidate = $parent
  }
  throw "Git repository missing: $Repo"
}

function Get-SourceTreeSha256([string]$Repo, [string[]]$ExcludedPrefixes = @()) {
  $safeDirectory = "safe.directory=$(Get-ContainingGitRoot $Repo)"
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
  $gitRoot = Get-ContainingGitRoot $Repo
  $safeDirectory = "safe.directory=$gitRoot"
  $commitOutput = @(& git -c $safeDirectory -C $Repo rev-parse HEAD 2>&1)
  if ($LASTEXITCODE -ne 0) {
    throw "Git commit lookup failed for $Repo`: $($commitOutput -join ' ')"
  }
  $commit = ($commitOutput | Out-String).Trim()
  if (-not $commit) { throw "Git commit lookup returned empty output for $Repo" }

  $statusOutput = @(& git -c $safeDirectory -c core.quotepath=false -C $Repo status --porcelain=v1 --untracked-files=all -- . 2>&1)
  if ($LASTEXITCODE -ne 0) {
    throw "Git status failed for $Repo`: $($statusOutput -join ' ')"
  }
  $prefix = [System.IO.Path]::GetFullPath($Repo).Substring($gitRoot.Length).Replace("\", "/").Trim("/")
  $statusExclusions = @($ExcludedPrefixes | ForEach-Object { if ($prefix) { "$prefix/$_" } else { $_ } })
  $changes = @($statusOutput | Where-Object {
    $_ -and -not (Test-GitStatusEntryExcluded ([string]$_) $statusExclusions)
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
