param(
  [Parameter(Mandatory=$true)][string]$RegistryRoot,
  [Parameter(Mandatory=$true)][string]$OperationId,
  [Parameter(Mandatory=$true)][string]$ArtifactDigest,
  [Alias('RunnerNonce')][Parameter(Mandatory=$true)][string]$Nonce
)
[Console]::Out.WriteLine('BINDING_OK')
