# Pure guards shared by the verifier and offline regression tests (PS 5.1 compatible).
function Test-WorkspaceChild {
  param([string]$Path, [string]$Root, [switch]$AllowEqual)
  try {
    if (-not [IO.Path]::IsPathRooted($Path)) { return $false }
    $full = [IO.Path]::GetFullPath($Path).TrimEnd('\','/')
    $base = [IO.Path]::GetFullPath($Root).TrimEnd('\','/')
    if (-not ($full.StartsWith($base + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -or
        ($AllowEqual -and $full.Equals($base, [StringComparison]::OrdinalIgnoreCase)))) { return $false }
    # Resolve lexical traversal first, then reject existing junction/symlink components.
    $part = $full
    while ($part) {
      if (Test-Path -LiteralPath $part) {
        if (((Get-Item -LiteralPath $part -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { return $false }
      }
      $parent = [IO.Path]::GetDirectoryName($part)
      if ($parent -eq $part) { break }
      $part = $parent
    }
    return $true
  } catch { return $false }
}

function Test-StepDependencies {
  param([object[]]$Steps, [string[]]$Names)
  foreach ($name in $Names) {
    $matching = @($Steps | Where-Object { $_.name -eq $name })
    if ($matching.Count -ne 1 -or $matching[0].status -ne 'passed') { return $false }
  }
  return $true
}

function Get-FixtureGuard {
  param([string]$Fixture, [string]$TestRoot, [string]$Family)
  try {
    $data = Get-Content -LiteralPath $Fixture -Raw -Encoding UTF8 | ConvertFrom-Json
    if (-not (Test-WorkspaceChild $data.runtime $TestRoot)) { throw 'runtime-outside-isolation' }
    if (-not (Test-Path -LiteralPath $data.runtime -PathType Container)) { throw 'runtime-missing' }
    $owned = Split-Path -Parent ([IO.Path]::GetFullPath($data.runtime))
    $familyRoot = Join-Path $TestRoot $Family
    if ((Split-Path -Leaf $data.runtime) -ne 'runtime' -or
        -not (Split-Path -Parent $owned).Equals($familyRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'fixture-family-mismatch' }
    $marker = Join-Path $owned '.test-owner.json'
    if (-not (Test-WorkspaceChild $marker $owned) -or -not (Test-Path -LiteralPath $marker -PathType Leaf)) { throw 'owner-missing' }
    $owner = Get-Content -LiteralPath $marker -Raw -Encoding UTF8 | ConvertFrom-Json
    if (-not ($owner.purpose -is [string]) -or -not $owner.purpose.Trim()) { throw 'owner-invalid' }
    # Absolute auxiliary files (entry/config/library/exports/images) must share the owner.
    foreach ($property in $data.PSObject.Properties) {
      if ($property.Name -in @('runtime','root','entry','config','library','pending_file','large','export_parent','document','observed','fault','trace')) {
        if (-not ($property.Value -is [string]) -or -not [IO.Path]::IsPathRooted($property.Value)) { throw ('relative-fixture-field:' + $property.Name) }
      }
      if ($property.Value -is [string]) {
        # PS5.1/.NET Framework throws for multiline non-path metadata (e.g. real stdout).
        # Required path fields were validated above and still reject invalid characters.
        $rooted = $false
        try { $rooted = [IO.Path]::IsPathRooted($property.Value) } catch { }
        if ($rooted -and -not (Test-WorkspaceChild $property.Value $owned -AllowEqual)) { throw ('foreign-fixture-field:' + $property.Name) }
      }
    }
    if ($data.entry -and -not (Test-Path -LiteralPath $data.entry -PathType Leaf)) { throw 'entry-missing' }
    return @{ status = 'ok' }
  } catch { return @{ status = 'blocked:invalid-fixture'; note = ('Fixture rejected: ' + $_.Exception.Message) } }
}

# Signature includes content and metadata: rewriting identical JSON is still a new report.
function Get-EvidenceStamp {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
  $file = Get-Item -LiteralPath $Path -Force
  $sha = [Security.Cryptography.SHA256]::Create()
  try { $hash = [BitConverter]::ToString($sha.ComputeHash([IO.File]::ReadAllBytes($Path))) }
  finally { $sha.Dispose() }
  return "$($file.LastWriteTimeUtc.Ticks):$($file.Length):$hash"
}
