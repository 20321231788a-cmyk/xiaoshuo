[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$BaselineInstallerPath,

  [Parameter(Mandatory = $true)]
  [string]$CandidateInstallerPath,

  [Parameter(Mandatory = $true)]
  [string]$OutputPath,

  [string]$SourceCommit = $env:GITHUB_SHA,

  [switch]$AllowDirtyWorkspace
)

$ErrorActionPreference = "Stop"

function Get-Sha256([string]$Path) {
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Install-ArcWriter([string]$InstallerPath, [string]$InstallRoot) {
  $process = Start-Process -FilePath $InstallerPath -ArgumentList "/S", "/D=$InstallRoot" -Wait -PassThru
  if ($process.ExitCode -ne 0) {
    throw "Installer exited with code $($process.ExitCode): $InstallerPath"
  }
}

function Start-And-StopArcWriter([string]$ApplicationPath, [string]$Stage) {
  if (-not (Test-Path -LiteralPath $ApplicationPath -PathType Leaf)) {
    throw "$Stage application was not found: $ApplicationPath"
  }
  $process = Start-Process -FilePath $ApplicationPath -PassThru
  try {
    Start-Sleep -Seconds 8
    if ($process.HasExited) {
      throw "$Stage application exited before the startup observation window"
    }
  } finally {
    if (-not $process.HasExited) {
      Stop-Process -Id $process.Id -Force
      $process.WaitForExit()
    }
  }
}

if (-not $SourceCommit -or $SourceCommit -notmatch "^[0-9a-fA-F]{7,64}$") {
  throw "SourceCommit or GITHUB_SHA must contain the source commit"
}
foreach ($installerPath in @($BaselineInstallerPath, $CandidateInstallerPath)) {
  if (-not (Test-Path -LiteralPath $installerPath -PathType Leaf)) {
    throw "Installer not found: $installerPath"
  }
}

$installRoot = Join-Path $env:LOCALAPPDATA ("ArcWriter-Upgrade-Smoke-" + [Guid]::NewGuid().ToString("N"))
$applicationPath = Join-Path $installRoot "ArcWriter.exe"
$uninstallerPath = Join-Path $installRoot "Uninstall ArcWriter.exe"
$uninstallCompleted = $false
$stages = [ordered]@{
  baseline_install = $false
  baseline_started = $false
  candidate_upgrade = $false
  candidate_started = $false
  baseline_rollback = $false
  rollback_started = $false
}

try {
  Install-ArcWriter $BaselineInstallerPath $installRoot
  $stages.baseline_install = $true
  Start-And-StopArcWriter $applicationPath "Baseline"
  $stages.baseline_started = $true

  Install-ArcWriter $CandidateInstallerPath $installRoot
  $stages.candidate_upgrade = $true
  Start-And-StopArcWriter $applicationPath "Candidate"
  $stages.candidate_started = $true

  Install-ArcWriter $BaselineInstallerPath $installRoot
  $stages.baseline_rollback = $true
  Start-And-StopArcWriter $applicationPath "Rollback"
  $stages.rollback_started = $true

  if (-not (Test-Path -LiteralPath $uninstallerPath -PathType Leaf)) {
    throw "Installed uninstaller not found: $uninstallerPath"
  }
  $uninstallerProcess = Start-Process -FilePath $uninstallerPath -ArgumentList "/S" -Wait -PassThru
  if ($uninstallerProcess.ExitCode -ne 0) {
    throw "Uninstaller exited with code $($uninstallerProcess.ExitCode)"
  }
  $uninstallCompleted = -not (Test-Path -LiteralPath $applicationPath -PathType Leaf)
  if (-not $uninstallCompleted) {
    throw "Application still exists after uninstall: $applicationPath"
  }
} finally {
  $remaining = Get-Process -Name "ArcWriter" -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$installRoot*" }
  foreach ($process in $remaining) {
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
  }
}

$evidence = [ordered]@{
  schema_version = 1
  source_commit = $SourceCommit
  workspace_dirty = [bool]$AllowDirtyWorkspace
  generated_at = [DateTime]::UtcNow.ToString("o")
  baseline_installer_path = (Resolve-Path -LiteralPath $BaselineInstallerPath).Path
  baseline_installer_sha256 = Get-Sha256 $BaselineInstallerPath
  candidate_installer_path = (Resolve-Path -LiteralPath $CandidateInstallerPath).Path
  candidate_installer_sha256 = Get-Sha256 $CandidateInstallerPath
  stages = $stages
  uninstall_completed = $uninstallCompleted
}

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $OutputPath) | Out-Null
$evidence | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $OutputPath -Encoding utf8
Write-Host "Upgrade and rollback smoke evidence written to $OutputPath"
