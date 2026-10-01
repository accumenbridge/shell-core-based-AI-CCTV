param(
  [Parameter(Mandatory=$true)][string]$RegistryRoot,
  [Parameter(Mandatory=$true)][string]$OperationId,
  [Parameter(Mandatory=$true)][string]$ArtifactDigest,
  [Parameter(Mandatory=$true)][string]$Nonce
)
$ErrorActionPreference = 'Stop'
if ($Nonce -notmatch '^[A-Za-z0-9_-]{24,64}$' -or $OperationId -notmatch '^[0-9a-fA-F-]{36}$' -or $ArtifactDigest -notmatch '^[0-9a-f]{64}$' -or -not [IO.Path]::IsPathRooted($RegistryRoot)) {
  [Console]::Error.WriteLine('Invalid fixed registry publication request')
  exit 2
}
$Source = [IO.Path]::GetFullPath((Join-Path $RegistryRoot (Join-Path 'staging' (Join-Path $OperationId 'payload'))))
$Destination = [IO.Path]::GetFullPath((Join-Path $RegistryRoot (Join-Path 'objects' $ArtifactDigest)))
function Assert-PhysicalDirectory([string]$Path) {
  $full = [IO.Path]::GetFullPath($Path)
  $item = Get-Item -Force -LiteralPath $full
  if (-not $item.PSIsContainer -or (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) { throw 'unsafe-directory' }
  return $full
}
function Assert-PhysicalChain([string]$Path) {
  $current = [IO.Path]::GetFullPath($Path)
  while ($true) {
    $item = Get-Item -Force -LiteralPath $current
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'unsafe-path' }
    $parent = [IO.Directory]::GetParent($current)
    if ($null -eq $parent -or $parent.FullName -eq $current) { break }
    $current = $parent.FullName
  }
}
function Emit-NoPublication([string]$Reason) {
  [Console]::Error.WriteLine($Reason)
  [Console]::Out.WriteLine("QB_REGISTRY_MOVE:${Nonce}:FAILED")
  exit 1
}
try {
  $RegistryRoot = Assert-PhysicalDirectory $RegistryRoot
  $StagingRoot = Assert-PhysicalDirectory (Join-Path $RegistryRoot 'staging')
  $OperationRoot = Assert-PhysicalDirectory (Join-Path $StagingRoot $OperationId)
  $Source = Assert-PhysicalDirectory $Source
  $ObjectsRoot = Assert-PhysicalDirectory (Join-Path $RegistryRoot 'objects')
  Assert-PhysicalChain $RegistryRoot
  if ([IO.Path]::GetPathRoot($Source) -ne [IO.Path]::GetPathRoot($ObjectsRoot)) { throw 'different-volume' }
  if ($Source.Length -ge 240 -or $Destination.Length -ge 240) { throw 'unsupported-path-length' }
} catch {
  Emit-NoPublication 'Fixed registry paths failed physical ownership checks'
}
if (-not ('QuadbridgeRegistryPublisher' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class QuadbridgeRegistryPublisher {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true, EntryPoint="MoveFileExW")]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool Move(string existingName, string newName, int flags);
}
'@
}
try {
  # Revalidate after host startup and immediately before MoveFileExW; flags 0 never replace.
  Assert-PhysicalChain $RegistryRoot
  Assert-PhysicalDirectory $RegistryRoot | Out-Null
  Assert-PhysicalDirectory $StagingRoot | Out-Null
  Assert-PhysicalDirectory $OperationRoot | Out-Null
  Assert-PhysicalDirectory $Source | Out-Null
  Assert-PhysicalDirectory $ObjectsRoot | Out-Null
} catch {
  Emit-NoPublication 'Fixed registry paths changed before the no-overwrite publication'
}
if ([QuadbridgeRegistryPublisher]::Move($Source, $Destination, 0)) {
  [Console]::Out.WriteLine("QB_REGISTRY_MOVE:${Nonce}:MOVED")
  exit 0
}
$code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
if ($code -eq 80 -or $code -eq 183) {
  [Console]::Out.WriteLine("QB_REGISTRY_MOVE:${Nonce}:EXISTS")
  exit 3
}
[Console]::Error.WriteLine("Fixed registry publication failed with Win32 code $code")
[Console]::Out.WriteLine("QB_REGISTRY_MOVE:${Nonce}:FAILED")
exit 1
