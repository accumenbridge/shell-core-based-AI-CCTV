param(
  [Parameter(Mandatory=$true)][string]$ProjectRoot,
  [Parameter(Mandatory=$true)][string]$OperationId,
  [Parameter(Mandatory=$true)][ValidateSet('BACKUP','RESTORE')][string]$Kind,
  [Parameter(Mandatory=$true)][string]$ArtifactDigest,
  [Parameter(Mandatory=$true)][string]$BackupDigest,
  [Parameter(Mandatory=$true)][string]$InstanceId,
  [Parameter(Mandatory=$true)][string]$Nonce
)
$ErrorActionPreference='Stop'
if($Nonce -notmatch '^[A-Za-z0-9_-]{24,64}$' -or $OperationId -notmatch '^[0-9a-fA-F-]{36}$' -or
   $InstanceId -notmatch '^runtime-[0-9a-fA-F-]{36}$' -or $ArtifactDigest -notmatch '^[a-f0-9]{64}$' -or
   ($Kind -eq 'BACKUP' -and $BackupDigest -notmatch '^[a-f0-9]{64}$') -or
   ($Kind -eq 'RESTORE' -and $BackupDigest -ne 'none') -or -not [IO.Path]::IsPathRooted($ProjectRoot)) {
  [Console]::Error.WriteLine('Invalid fixed recovery publication request'); exit 2
}
$LocalRoot=[IO.Path]::GetFullPath((Join-Path $ProjectRoot '.local'))
$RecoveryRoot=[IO.Path]::GetFullPath((Join-Path $LocalRoot 'platform-runtime-backups'))
$Source=[IO.Path]::GetFullPath((Join-Path $RecoveryRoot (Join-Path 'staging' (Join-Path $OperationId 'payload'))))
if($Kind -eq 'BACKUP') {
  $Destination=[IO.Path]::GetFullPath((Join-Path $RecoveryRoot (Join-Path 'objects' $BackupDigest)))
} else {
  $Destination=[IO.Path]::GetFullPath((Join-Path $LocalRoot (Join-Path 'platform-runtime-data' (Join-Path $InstanceId $ArtifactDigest))))
}
function Assert-Directory([string]$Path) {
  $full=[IO.Path]::GetFullPath($Path);$item=Get-Item -Force -LiteralPath $full
  if(-not $item.PSIsContainer -or (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)){throw 'unsafe-directory'}
  return $full
}
function Assert-Chain([string]$Path) {
  $current=[IO.Path]::GetFullPath($Path)
  while($true){$item=Get-Item -Force -LiteralPath $current
    if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'unsafe-path'}
    $parent=[IO.Directory]::GetParent($current);if($null -eq $parent -or $parent.FullName -eq $current){break};$current=$parent.FullName}
}
function Emit([string]$Value,[int]$Code){[Console]::Out.WriteLine("QB_RECOVERY_MOVE:${Nonce}:${Value}");[Console]::Out.Flush();exit $Code}
try {
  $ProjectRoot=Assert-Directory $ProjectRoot;Assert-Chain $ProjectRoot
  $LocalRoot=Assert-Directory $LocalRoot;Assert-Directory $RecoveryRoot | Out-Null
  $StageRoot=Assert-Directory (Join-Path $RecoveryRoot 'staging');$OperationRoot=Assert-Directory (Join-Path $StageRoot $OperationId)
  $Source=Assert-Directory $Source
  if($Kind -eq 'BACKUP'){$DestinationRoot=Assert-Directory (Join-Path $RecoveryRoot 'objects')}
  else {$DataRoot=Assert-Directory (Join-Path $LocalRoot 'platform-runtime-data');$InstanceRoot=Assert-Directory (Join-Path $DataRoot $InstanceId)}
  Assert-Chain $Source;Assert-Chain ([IO.Path]::GetDirectoryName($Destination))
  if([IO.Path]::GetPathRoot($Source) -ne [IO.Path]::GetPathRoot($Destination)){throw 'different-volume'}
  if($Source.Length -ge 240 -or $Destination.Length -ge 240){throw 'unsupported-path-length'}
  if([IO.Directory]::Exists($Destination) -or [IO.File]::Exists($Destination)){Emit 'EXISTS' 3}
} catch { [Console]::Error.WriteLine('Fixed recovery paths failed physical ownership checks');Emit 'FAILED' 1 }
if(-not('QuadbridgeRecoveryPublisher' -as [type])){
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class QuadbridgeRecoveryPublisher {
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true,EntryPoint="MoveFileExW")]
  [return:MarshalAs(UnmanagedType.Bool)] public static extern bool Move(string source,string destination,int flags);
}
'@
}
try {
  # Validate every fixed parent again after PowerShell startup. MoveFileExW flags 0 never replace.
  Assert-Chain $Source;Assert-Chain $ProjectRoot;Assert-Chain ([IO.Path]::GetDirectoryName($Destination));Assert-Directory $Source | Out-Null
  if($Kind -eq 'BACKUP'){Assert-Directory $DestinationRoot | Out-Null}else{Assert-Directory $InstanceRoot | Out-Null}
} catch { [Console]::Error.WriteLine('Fixed recovery paths changed before publication');Emit 'FAILED' 1 }
if([QuadbridgeRecoveryPublisher]::Move($Source,$Destination,0)){Emit 'MOVED' 0}
$code=[Runtime.InteropServices.Marshal]::GetLastWin32Error()
if($code -eq 80 -or $code -eq 183){Emit 'EXISTS' 3}
[Console]::Error.WriteLine("Fixed recovery publication failed with Win32 code $code");Emit 'FAILED' 1
