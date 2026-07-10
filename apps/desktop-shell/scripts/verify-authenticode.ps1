[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$InstallerPath
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $InstallerPath -PathType Leaf)) {
  throw "Installer not found: $InstallerPath"
}

$signature = Get-AuthenticodeSignature -LiteralPath $InstallerPath
if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
  throw "Authenticode validation failed for ${InstallerPath}: $($signature.Status) $($signature.StatusMessage)"
}

if (-not $signature.SignerCertificate) {
  throw "Authenticode validation did not return a signer certificate for $InstallerPath"
}

if (-not $signature.TimeStamperCertificate) {
  throw "Authenticode validation did not return a timestamp certificate for $InstallerPath"
}

Write-Host "Authenticode signature and timestamp are valid for $InstallerPath"
