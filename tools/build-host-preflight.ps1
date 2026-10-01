$ErrorActionPreference = 'Stop'
$scopes = @{}
Get-ExecutionPolicy -List | ForEach-Object { $scopes[[string]$_.Scope] = [string]$_.ExecutionPolicy }
$report = [ordered]@{
  version = $PSVersionTable.PSVersion.ToString()
  effectivePolicy = [string](Get-ExecutionPolicy)
  machinePolicy = $scopes['MachinePolicy']
  userPolicy = $scopes['UserPolicy']
  processPolicy = $scopes['Process']
  currentUserPolicy = $scopes['CurrentUser']
  localMachinePolicy = $scopes['LocalMachine']
}
Write-Output ('QB_BUILD_HOST:' + ($report | ConvertTo-Json -Compress))
