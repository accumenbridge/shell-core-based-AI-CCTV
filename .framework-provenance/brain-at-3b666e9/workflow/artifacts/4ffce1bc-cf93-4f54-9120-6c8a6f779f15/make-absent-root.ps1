$ErrorActionPreference = 'Stop'
$entityMoveProof = Get-Content -LiteralPath '.local/entity-builder-001/browser-pre-move-01.json' -Raw | ConvertFrom-Json
$entityFixtureRoot = [System.IO.Path]::GetFullPath($entityMoveProof.root)
$entityMoveSource = [System.IO.Path]::GetFullPath($entityMoveProof.source)
$entityMoveDestination = [System.IO.Path]::GetFullPath($entityMoveProof.destination)
foreach ($entityTarget in @($entityMoveSource, $entityMoveDestination)) {
  if (-not $entityTarget.StartsWith($entityFixtureRoot + '\', [System.StringComparison]::OrdinalIgnoreCase)) { throw 'Move target outside exact owned fixture' }
}
if (Test-Path -LiteralPath $entityMoveDestination) { throw 'Held destination already exists' }
if (-not (Test-Path -LiteralPath $entityMoveSource -PathType Container)) { throw 'Owned source data missing' }
$entitySourceInfo = Get-Item -LiteralPath $entityMoveSource
if ($entitySourceInfo.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { throw 'Linked source data' }
foreach ($entityFile in $entityMoveProof.files) {
  $entityFilePath = Join-Path $entityMoveSource $entityFile.path
  if ((Get-FileHash -LiteralPath $entityFilePath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $entityFile.sha256) { throw 'Stopped data changed before move' }
}
$entityHeldParent = [System.IO.Path]::GetDirectoryName($entityMoveDestination)
New-Item -ItemType Directory -Path $entityHeldParent -Force | Out-Null
Move-Item -LiteralPath $entityMoveSource -Destination $entityMoveDestination
if (Test-Path -LiteralPath $entityMoveSource) { throw 'Canonical data root remains present' }
foreach ($entityFile in $entityMoveProof.files) {
  $entityFilePath = Join-Path $entityMoveDestination $entityFile.path
  if ((Get-FileHash -LiteralPath $entityFilePath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $entityFile.sha256) { throw 'Held original data changed' }
}
$entityMoveResult = [ordered]@{fixtureId=$entityMoveProof.fixtureId; candidate=$entityMoveProof.candidate; observedAt=[DateTime]::UtcNow.ToString('o'); canonicalRootAbsent=$true; originalHeld=$true; heldBytesUnchanged=$true; files=$entityMoveProof.files.Count; source=$entityMoveSource; destination=$entityMoveDestination}
$entityMoveResult | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath '.local/entity-builder-001/browser-data-move-01.json' -Encoding utf8
$entityMoveResult | ConvertTo-Json -Compress
