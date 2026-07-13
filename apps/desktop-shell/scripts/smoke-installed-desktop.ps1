[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$InstallerPath,

  [Parameter(Mandatory = $true)]
  [string]$OutputPath,

  [string]$SourceCommit = $env:GITHUB_SHA,

  [switch]$AllowDirtyWorkspace
)

$ErrorActionPreference = "Stop"

function Get-Sha256([string]$Path) {
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

if (-not $SourceCommit -or $SourceCommit -notmatch "^[0-9a-fA-F]{7,64}$") {
  throw "SourceCommit or GITHUB_SHA must contain the source commit"
}
if (-not (Test-Path -LiteralPath $InstallerPath -PathType Leaf)) {
  throw "Installer not found: $InstallerPath"
}

$installRoot = Join-Path $env:LOCALAPPDATA ("ArcWriter-RC-Smoke-" + [Guid]::NewGuid().ToString("N"))
$applicationPath = Join-Path $installRoot "ArcWriter.exe"
$uninstallerPath = Join-Path $installRoot "Uninstall ArcWriter.exe"
$process = $null
$started = $false
$wasRunning = $false
$uninstallCompleted = $false

try {
  # NSIS requires /D to be the final argument and does not accept a quoted value.
  $installerProcess = Start-Process -FilePath $InstallerPath -ArgumentList "/S", "/D=$installRoot" -Wait -PassThru
  if ($installerProcess.ExitCode -ne 0) {
    throw "Installer exited with code $($installerProcess.ExitCode)"
  }
  if (-not (Test-Path -LiteralPath $applicationPath -PathType Leaf)) {
    throw "Installed application not found: $applicationPath"
  }

  $process = Start-Process -FilePath $applicationPath -PassThru
  $started = $true
  Start-Sleep -Seconds 12
  $wasRunning = -not $process.HasExited
  if (-not $wasRunning) {
    throw "Installed application exited before the startup observation window"
  }
  Stop-Process -Id $process.Id -Force
  $process.WaitForExit()

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
  if ($process -and -not $process.HasExited) {
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
  }
}

$evidence = [ordered]@{
  schema_version = 1
  source_commit = $SourceCommit
  workspace_dirty = [bool]$AllowDirtyWorkspace
  generated_at = [DateTime]::UtcNow.ToString("o")
  installer_path = (Resolve-Path -LiteralPath $InstallerPath).Path
  installer_sha256 = Get-Sha256 $InstallerPath
  application_started = $started
  application_was_running = $wasRunning
  uninstall_completed = $uninstallCompleted
}

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $OutputPath) | Out-Null
$evidence | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $OutputPath -Encoding utf8
Write-Host "Installed smoke evidence written to $OutputPath"
