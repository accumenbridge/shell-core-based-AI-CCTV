param(
  [Parameter(Mandatory=$true)][string]$ProjectRoot,
  [Parameter(Mandatory=$true)][string]$OperationId,
  [Parameter(Mandatory=$true)][string]$InstanceId,
  [Parameter(Mandatory=$true)][string]$TargetDigest,
  [Parameter(Mandatory=$true)][string]$Nonce
)
$ErrorActionPreference='Stop'
if($Nonce -notmatch '^[a-f0-9]{48}$' -or $OperationId -notmatch '^[0-9a-fA-F-]{36}$' -or
   $InstanceId -notmatch '^runtime-[0-9a-fA-F-]{36}$' -or $TargetDigest -notmatch '^[a-f0-9]{64}$' -or
   -not [IO.Path]::IsPathRooted($ProjectRoot)) {
  [Console]::Error.WriteLine('Invalid fixed runtime upgrade publication request'); exit 2
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
function Emit([string]$Value,[int]$Code){[Console]::Out.WriteLine("QB_UPGRADE_MOVE:${Nonce}:${Value}");[Console]::Out.Flush();exit $Code}
$ProjectRoot=[IO.Path]::GetFullPath($ProjectRoot)
$LocalRoot=[IO.Path]::GetFullPath((Join-Path $ProjectRoot '.local'))
$UpgradeRoot=[IO.Path]::GetFullPath((Join-Path $LocalRoot 'platform-runtime-upgrades'))
$OperationRoot=[IO.Path]::GetFullPath((Join-Path $UpgradeRoot $OperationId))
$PayloadRoot=[IO.Path]::GetFullPath((Join-Path $OperationRoot 'payload'))
$Source=[IO.Path]::GetFullPath((Join-Path $PayloadRoot 'data'))
$DataRoot=[IO.Path]::GetFullPath((Join-Path $LocalRoot 'platform-runtime-data'))
$InstanceRoot=[IO.Path]::GetFullPath((Join-Path $DataRoot $InstanceId))
$Destination=[IO.Path]::GetFullPath((Join-Path $InstanceRoot $TargetDigest))
try {
  $ProjectRoot=Assert-Directory $ProjectRoot;Assert-Chain $ProjectRoot
  $LocalRoot=Assert-Directory $LocalRoot;$UpgradeRoot=Assert-Directory $UpgradeRoot
  $OperationRoot=Assert-Directory $OperationRoot;$PayloadRoot=Assert-Directory $PayloadRoot;$Source=Assert-Directory $Source
  $DataRoot=Assert-Directory $DataRoot;$InstanceRoot=Assert-Directory $InstanceRoot
  Assert-Chain $Source;Assert-Chain $InstanceRoot
  if($OperationRoot -ne [IO.Path]::GetFullPath((Join-Path $UpgradeRoot $OperationId)) -or
     $Source -ne [IO.Path]::GetFullPath((Join-Path $PayloadRoot 'data')) -or
     $Destination -ne [IO.Path]::GetFullPath((Join-Path $InstanceRoot $TargetDigest)) -or
     [IO.Path]::GetPathRoot($Source) -ne [IO.Path]::GetPathRoot($Destination) -or $Source.Length -ge 240 -or $Destination.Length -ge 240){throw 'fixed-path-mismatch'}
  if([IO.Directory]::Exists($Destination) -or [IO.File]::Exists($Destination)){Emit 'EXISTS' 3}
} catch { [Console]::Error.WriteLine('Fixed runtime upgrade paths failed ownership checks');Emit 'FAILED' 1 }
if(-not('QuadbridgeUpgradePublisher' -as [type])){
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class QuadbridgeUpgradePublisher {
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true,EntryPoint="MoveFileExW")]
  [return:MarshalAs(UnmanagedType.Bool)] public static extern bool Move(string source,string destination,int flags);
}
'@
}
try {
  # Revalidate both complete parent chains immediately before a no-replace, same-volume move.
  Assert-Chain $Source;Assert-Chain $InstanceRoot;Assert-Directory $Source | Out-Null;Assert-Directory $InstanceRoot | Out-Null
  if([IO.Path]::GetPathRoot($Source) -ne [IO.Path]::GetPathRoot($Destination) -or
     [IO.Directory]::Exists($Destination) -or [IO.File]::Exists($Destination)){Emit 'EXISTS' 3}
} catch { [Console]::Error.WriteLine('Fixed runtime upgrade paths changed before publication');Emit 'FAILED' 1 }
if([QuadbridgeUpgradePublisher]::Move($Source,$Destination,0)){Emit 'MOVED' 0}
$code=[Runtime.InteropServices.Marshal]::GetLastWin32Error()
if($code -eq 80 -or $code -eq 183){Emit 'EXISTS' 3}
[Console]::Error.WriteLine("Fixed runtime upgrade publication failed with Win32 code $code");Emit 'FAILED' 1
