[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$BaselineInstallerPath,

  [Parameter(Mandatory = $true)]
  [string]$CandidateInstallerPath,

  [Parameter(Mandatory = $true)]
  [string]$BaselineMetadataPath,

  [Parameter(Mandatory = $true)]
  [string]$CandidateVersion,

  [Parameter(Mandatory = $true)]
  [string]$Repository,

  [Parameter(Mandatory = $true)]
  [string]$OutputPath,

  [Parameter(Mandatory = $true)]
  [string]$StateContractPath,

  [string]$SourceCommit = $env:GITHUB_SHA,

  [ValidateRange(1, 65535)]
  [int]$RuntimePort = 18453,

  [switch]$AllowDirtyWorkspace
)

$ErrorActionPreference = "Stop"

function Get-Sha256([string]$Path) {
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-BaselineInstallerProvenance(
  [string]$MetadataPath,
  [string]$BaselinePath,
  [string]$CandidatePath,
  [string]$Version,
  [string]$ExpectedRepository
) {
  $verifierPath = Join-Path $PSScriptRoot "baseline-installer-provenance.mjs"
  if (-not (Test-Path -LiteralPath $verifierPath -PathType Leaf)) {
    throw "Baseline installer provenance verifier not found: $verifierPath"
  }
  $verificationOutput = @(& node $verifierPath --metadata $MetadataPath --baseline-installer $BaselinePath --candidate-installer $CandidatePath --candidate-version $Version --repository $ExpectedRepository 2>&1)
  $verificationText = ($verificationOutput | Out-String).Trim()
  if ($LASTEXITCODE -ne 0) {
    throw "Baseline installer provenance validation failed: $verificationText"
  }
  try {
    $result = $verificationText | ConvertFrom-Json
  } catch {
    throw "Baseline installer provenance verifier returned invalid JSON"
  }
  try {
    $publishedTimestamp = [System.DateTimeOffset]$result.metadata.published_at
    $result.metadata.published_at = $publishedTimestamp.UtcDateTime.ToString(
      "yyyy-MM-dd'T'HH:mm:ss.fff'Z'",
      [System.Globalization.CultureInfo]::InvariantCulture
    )
  } catch {
    throw "Baseline installer provenance verifier returned an invalid published_at timestamp"
  }
  if ($result.metadata.schema_version -ne 1 -or $result.metadata.version_relation -ne "previous" -or $result.metadata_sha256 -notmatch "^[0-9a-f]{64}$") {
    throw "Baseline installer provenance verifier returned an invalid result"
  }
  return $result
}

function Get-InstalledApplicationVersion([string]$ApplicationPath, [string]$ExpectedVersion, [string]$Stage) {
  $rawVersion = [string](Get-Item -LiteralPath $ApplicationPath).VersionInfo.ProductVersion
  $match = [regex]::Match($rawVersion.Trim(), '^((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))(?:\.0)?$')
  if (-not $match.Success) {
    throw "$Stage installed executable has an invalid ProductVersion: $rawVersion"
  }
  $normalizedVersion = $match.Groups[1].Value
  if ($normalizedVersion -ne $ExpectedVersion) {
    throw "$Stage installed ProductVersion $normalizedVersion does not match expected version $ExpectedVersion"
  }
  return [ordered]@{
    product_version = $rawVersion
    normalized_version = $normalizedVersion
  }
}

function Get-WorkspaceState([string]$ExpectedCommit, [bool]$AllowDirty) {
  $repositoryRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..\..\..")).Path
  $actualCommit = (& git -C $repositoryRoot rev-parse HEAD 2>$null | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or $actualCommit -notmatch "^[0-9a-fA-F]{40}$") {
    throw "Unable to verify the source Git commit for upgrade smoke"
  }
  if ($actualCommit -ne $ExpectedCommit) {
    throw "Upgrade smoke source commit $actualCommit does not match $ExpectedCommit"
  }
  $statusLines = @(& git -C $repositoryRoot status --porcelain=v1 --untracked-files=all 2>$null)
  if ($LASTEXITCODE -ne 0) {
    throw "Unable to verify whether the source workspace is clean"
  }
  $dirty = $statusLines.Count -gt 0
  if ($dirty -and -not $AllowDirty) {
    throw "Upgrade smoke requires a clean source workspace; use -AllowDirtyWorkspace only for non-release local rehearsal"
  }
  return [ordered]@{
    repository_root = $repositoryRoot
    source_commit = $actualCommit
    dirty = $dirty
  }
}

function Install-ArcWriter([string]$InstallerPath, [string]$InstallRoot) {
  $process = Start-Process -FilePath $InstallerPath -ArgumentList "/S", "/D=$InstallRoot" -Wait -PassThru
  if ($process.ExitCode -ne 0) {
    throw "Installer exited with code $($process.ExitCode): $InstallerPath"
  }
}

function Quote-ProcessArgument([string]$Value) {
  if ($Value.Contains('"')) {
    throw "Process argument contains an unsupported quote"
  }
  return '"' + $Value + '"'
}

function Test-RuntimePortOpen() {
  $client = [System.Net.Sockets.TcpClient]::new()
  try {
    $connection = $client.BeginConnect("127.0.0.1", $RuntimePort, $null, $null)
    try {
      if (-not $connection.AsyncWaitHandle.WaitOne(500)) {
        return $false
      }
      $client.EndConnect($connection)
      return $true
    } catch {
      return $false
    } finally {
      $connection.AsyncWaitHandle.Close()
    }
  } finally {
    $client.Dispose()
  }
}

function Wait-RuntimeHealth([System.Diagnostics.Process]$Process, [string]$Stage, [string]$ProbeResultPath = "") {
  $deadline = [DateTime]::UtcNow.AddSeconds(90)
  while ([DateTime]::UtcNow -lt $deadline) {
    if ($Process.HasExited) {
      throw "$Stage application exited before its runtime became healthy"
    }
    if ($ProbeResultPath -and (Test-Path -LiteralPath $ProbeResultPath -PathType Leaf)) {
      try {
        $earlyProbe = Get-Content -LiteralPath $ProbeResultPath -Raw | ConvertFrom-Json
        if ($earlyProbe.schema_version -eq 1 -and $earlyProbe.kind -eq "upgrade-rollback-runtime-probe" -and $earlyProbe.ok -eq $false) {
          throw "$Stage runtime probe failed during startup: $($earlyProbe.error)"
        }
      } catch {
        if ($_.Exception.Message -like "$Stage runtime probe failed during startup:*") {
          throw
        }
        # The probe file may be visible before its small JSON write has completed.
      }
    }
    try {
      $health = Invoke-RestMethod -Uri "http://127.0.0.1:$RuntimePort/health" -Method Get -TimeoutSec 2
      if ($health.ok -eq $true -and $health.runtime -eq "typescript-electron") {
        return [ordered]@{
          ok = $true
          runtime = [string]$health.runtime
          runtime_version = [string]$health.version
          observed_at = [DateTime]::UtcNow.ToString("o")
        }
      }
    } catch {
      # Runtime startup is asynchronous; continue until the bounded deadline.
    }
    Start-Sleep -Milliseconds 500
  }
  throw "$Stage runtime did not become healthy within 90 seconds"
}

function Wait-RuntimePortClosed([string]$Stage) {
  $deadline = [DateTime]::UtcNow.AddSeconds(10)
  while ([DateTime]::UtcNow -lt $deadline) {
    if (-not (Test-RuntimePortOpen)) {
      return
    }
    Start-Sleep -Milliseconds 250
  }
  throw "$Stage runtime port remained open after the application stopped"
}

function Get-ArcWriterApplicationProcesses([string]$ApplicationPath) {
  $expectedPath = [System.IO.Path]::GetFullPath($ApplicationPath)
  return @(
    Get-Process -Name "ArcWriter" -ErrorAction SilentlyContinue | Where-Object {
      try {
        [string]::Equals(
          [System.IO.Path]::GetFullPath($_.Path),
          $expectedPath,
          [System.StringComparison]::OrdinalIgnoreCase
        )
      } catch {
        $false
      }
    }
  )
}

function Wait-ArcWriterApplicationClosed([string]$ApplicationPath, [int]$TimeoutSeconds) {
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  while ([DateTime]::UtcNow -lt $deadline) {
    if (@(Get-ArcWriterApplicationProcesses $ApplicationPath).Count -eq 0) {
      return $true
    }
    Start-Sleep -Milliseconds 250
  }
  return @(Get-ArcWriterApplicationProcesses $ApplicationPath).Count -eq 0
}

function Stop-ArcWriterApplication(
  [System.Diagnostics.Process]$Process,
  [string]$ApplicationPath,
  [string]$Stage
) {
  if (-not $Process.HasExited) {
    $closeRequested = $false
    try {
      $closeRequested = $Process.CloseMainWindow()
    } catch {
      # The process may exit between the HasExited check and the close request.
    }
    if ($closeRequested) {
      [void]$Process.WaitForExit(10000)
    }
  }

  if (-not (Wait-ArcWriterApplicationClosed $ApplicationPath 2)) {
    foreach ($remainingProcess in @(Get-ArcWriterApplicationProcesses $ApplicationPath)) {
      Stop-Process -Id $remainingProcess.Id -Force -ErrorAction SilentlyContinue
    }
  }
  if (-not (Wait-ArcWriterApplicationClosed $ApplicationPath 10)) {
    throw "$Stage application processes remained after shutdown"
  }
  Wait-RuntimePortClosed $Stage
}

function Start-And-StopArcWriter(
  [string]$ApplicationPath,
  [string]$Stage,
  [string]$ProjectRoot = "",
  [string]$ProbeResultPath = "",
  [string]$PendingRunId = "",
  [bool]$ExternalProjectProbe = $false,
  [string]$LogDirectory = ""
) {
  if (-not (Test-Path -LiteralPath $ApplicationPath -PathType Leaf)) {
    throw "$Stage application was not found: $ApplicationPath"
  }
  if (Test-RuntimePortOpen) {
    throw "$Stage cannot start because ArcWriter runtime port $RuntimePort is already in use"
  }
  if (@(Get-ArcWriterApplicationProcesses $ApplicationPath).Count -gt 0) {
    throw "$Stage cannot start because the installed ArcWriter application is already running"
  }
  $arguments = @()
  if ($ProbeResultPath -or $PendingRunId) {
    if (-not $ProjectRoot -or -not $ProbeResultPath -or -not $PendingRunId) {
      throw "$Stage runtime probe requires project, result, and run ID arguments"
    }
    if (Test-Path -LiteralPath $ProbeResultPath) {
      throw "$Stage runtime probe result already exists: $ProbeResultPath"
    }
    $arguments = @(
      "--safe-agent",
      "--rc-upgrade-smoke",
      "--rc-upgrade-smoke-project",
      (Quote-ProcessArgument $ProjectRoot),
      "--rc-upgrade-smoke-result",
      (Quote-ProcessArgument $ProbeResultPath),
      "--rc-upgrade-smoke-run-id",
      (Quote-ProcessArgument $PendingRunId)
    )
  }
  if ($ExternalProjectProbe -and -not $ProjectRoot) {
    throw "$Stage external project probe requires a project root"
  }
  $startOptions = @{ FilePath = $ApplicationPath; PassThru = $true }
  if ($arguments.Count -gt 0) {
    $startOptions.ArgumentList = $arguments
  }
  if ($LogDirectory) {
    New-Item -ItemType Directory -Force -Path $LogDirectory | Out-Null
    $logPrefix = $Stage.ToLowerInvariant() -replace '[^a-z0-9-]', '-'
    $stdoutPath = Join-Path $LogDirectory "$logPrefix.stdout.log"
    $stderrPath = Join-Path $LogDirectory "$logPrefix.stderr.log"
    foreach ($logPath in @($stdoutPath, $stderrPath)) {
      if (Test-Path -LiteralPath $logPath) {
        throw "$Stage startup log already exists: $logPath"
      }
    }
    $startOptions.RedirectStandardOutput = $stdoutPath
    $startOptions.RedirectStandardError = $stderrPath
  }
  $process = Start-Process @startOptions
  $stageFailure = $null
  try {
    $health = Wait-RuntimeHealth $process $Stage $ProbeResultPath
    if ($ExternalProjectProbe) {
      $requestBody = @{ path = $ProjectRoot } | ConvertTo-Json -Compress
      $opened = Invoke-RestMethod -Uri "http://127.0.0.1:$RuntimePort/api/projects/open" -Method Post -ContentType "application/json" -Body $requestBody -TimeoutSec 10
      $current = Invoke-RestMethod -Uri "http://127.0.0.1:$RuntimePort/api/projects/current" -Method Get -TimeoutSec 10
      $expectedProjectPath = [System.IO.Path]::GetFullPath($ProjectRoot)
      $openedProjectPath = [System.IO.Path]::GetFullPath([string]$opened.path)
      $currentProjectPath = [System.IO.Path]::GetFullPath([string]$current.path)
      if (
        -not [string]::Equals($openedProjectPath, $expectedProjectPath, [System.StringComparison]::OrdinalIgnoreCase) -or
        -not [string]::Equals($currentProjectPath, $expectedProjectPath, [System.StringComparison]::OrdinalIgnoreCase)
      ) {
        throw "$Stage runtime opened an unexpected project"
      }
      return [ordered]@{
        health = $health
        project_probe = [ordered]@{
          ok = $true
          mode = "legacy-runtime-api"
          project_root = $expectedProjectPath
          opened_project_path = $openedProjectPath
        }
        runtime_probe = $null
      }
    }
    if ($ProbeResultPath) {
      $deadline = [DateTime]::UtcNow.AddSeconds(60)
      $probe = $null
      $lastProbeParseError = ""
      while ([DateTime]::UtcNow -lt $deadline -and $null -eq $probe) {
        if ($process.HasExited) {
          throw "$Stage application exited before producing runtime probe evidence"
        }
        if (Test-Path -LiteralPath $ProbeResultPath -PathType Leaf) {
          try {
            $probe = Get-Content -LiteralPath $ProbeResultPath -Raw | ConvertFrom-Json
          } catch {
            $lastProbeParseError = $_.Exception.Message
          }
        }
        if ($null -eq $probe) {
          Start-Sleep -Milliseconds 500
        }
      }
      if ($null -eq $probe -and -not (Test-Path -LiteralPath $ProbeResultPath -PathType Leaf)) {
        throw "$Stage application did not produce runtime probe evidence within 60 seconds"
      }
      if ($null -eq $probe) {
        throw "$Stage application produced unreadable runtime probe evidence within 60 seconds: $lastProbeParseError"
      }
      if ($probe.schema_version -ne 1 -or $probe.kind -ne "upgrade-rollback-runtime-probe" -or -not $probe.ok) {
        throw "$Stage runtime probe failed: $($probe.error)"
      }
      return [ordered]@{
        health = $health
        project_probe = [ordered]@{
          ok = $true
          mode = "main-process-authenticated"
          project_root = [string]$probe.project_root
          opened_project_path = [string]$probe.opened_project_path
        }
        runtime_probe = $probe
      }
    }
    return [ordered]@{ health = $health; project_probe = $null; runtime_probe = $null }
  } catch {
    $stageFailure = $_
    throw
  } finally {
    try {
      Stop-ArcWriterApplication -Process $process -ApplicationPath $ApplicationPath -Stage $Stage
    } catch {
      if ($null -ne $stageFailure) {
        throw "$Stage failed: $($stageFailure.Exception.Message). Cleanup also failed: $($_.Exception.Message)"
      }
      throw
    }
  }
}

function Verify-PreservedState([string]$Phase, [string]$ContractPath, [string]$VerifierPath, [string]$EvidenceDirectory, [string]$Commit) {
  $verificationPath = Join-Path $EvidenceDirectory ("$Phase.json")
  $verificationOutput = @(& node $VerifierPath --contract $ContractPath --phase $Phase --out $verificationPath --source-commit $Commit 2>&1)
  $verificationText = ($verificationOutput | Out-String).Trim()
  if ($LASTEXITCODE -ne 0) {
    throw "State verification failed for ${Phase}: $verificationText"
  }
  if ($verificationText) {
    Write-Host $verificationText
  }
  if (-not (Test-Path -LiteralPath $verificationPath -PathType Leaf)) {
    throw "State verification did not create evidence for $Phase"
  }
  return (Get-Content -LiteralPath $verificationPath -Raw | ConvertFrom-Json)
}

if (-not $SourceCommit -or $SourceCommit -notmatch "^[0-9a-fA-F]{7,64}$") {
  throw "SourceCommit or GITHUB_SHA must contain the source commit"
}
$OutputPath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($OutputPath)
if (-not [System.IO.Path]::IsPathFullyQualified($OutputPath)) {
  throw "OutputPath could not be resolved to an absolute filesystem path"
}
$workspaceState = Get-WorkspaceState $SourceCommit ([bool]$AllowDirtyWorkspace)
$SourceCommit = [string]$workspaceState.source_commit
foreach ($installerPath in @($BaselineInstallerPath, $CandidateInstallerPath)) {
  if (-not (Test-Path -LiteralPath $installerPath -PathType Leaf)) {
    throw "Installer not found: $installerPath"
  }
}
if (-not (Test-Path -LiteralPath $BaselineMetadataPath -PathType Leaf)) {
  throw "Baseline installer metadata not found: $BaselineMetadataPath"
}
$baselineProvenance = Get-BaselineInstallerProvenance $BaselineMetadataPath $BaselineInstallerPath $CandidateInstallerPath $CandidateVersion $Repository
if (-not (Test-Path -LiteralPath $StateContractPath -PathType Leaf)) {
  throw "State contract not found: $StateContractPath"
}
$stateContract = Get-Content -LiteralPath $StateContractPath -Raw | ConvertFrom-Json
if ($stateContract.schema_version -ne 2 -or -not $stateContract.project_root -or -not $stateContract.runtime_probe.pending_run_id) {
  throw "State contract does not declare the installed runtime probe"
}
if ($stateContract.source_commit -ne $SourceCommit) {
  throw "State contract commit does not match SourceCommit"
}
$projectRoot = (Resolve-Path -LiteralPath $stateContract.project_root).Path
$pendingRunId = [string]$stateContract.runtime_probe.pending_run_id
$stateVerifierPath = Join-Path $PSScriptRoot "verify-upgrade-rollback-state.mjs"
if (-not (Test-Path -LiteralPath $stateVerifierPath -PathType Leaf)) {
  throw "State verifier not found: $stateVerifierPath"
}

$installRoot = Join-Path $env:LOCALAPPDATA ("ArcWriter-Upgrade-Smoke-" + [Guid]::NewGuid().ToString("N"))
$applicationPath = Join-Path $installRoot "ArcWriter.exe"
$uninstallerPath = Join-Path $installRoot "Uninstall ArcWriter.exe"
$stateEvidenceDirectory = Join-Path (Split-Path -Parent $OutputPath) "upgrade-rollback-state"
$runtimeProbePath = Join-Path $stateEvidenceDirectory "candidate-runtime-probe.json"
$stateVerifications = [ordered]@{}
$startupObservations = [ordered]@{}
$runtimeProbe = $null
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
  $baselineApplication = Get-InstalledApplicationVersion $applicationPath ([string]$baselineProvenance.metadata.baseline_version) "Baseline"
  $baselineStart = Start-And-StopArcWriter -ApplicationPath $applicationPath -Stage "Baseline" -ProjectRoot $projectRoot -ExternalProjectProbe $true -LogDirectory $stateEvidenceDirectory
  $startupObservations.baseline = [ordered]@{ application = $baselineApplication; health = $baselineStart.health; project_probe = $baselineStart.project_probe }
  $stages.baseline_started = $true
  $stateVerifications.baseline_after_start = Verify-PreservedState "baseline_after_start" $StateContractPath $stateVerifierPath $stateEvidenceDirectory $SourceCommit

  Install-ArcWriter $CandidateInstallerPath $installRoot
  $stages.candidate_upgrade = $true
  $candidateApplication = Get-InstalledApplicationVersion $applicationPath $CandidateVersion "Candidate"
  $candidateStart = Start-And-StopArcWriter -ApplicationPath $applicationPath -Stage "Candidate" -ProjectRoot $projectRoot -ProbeResultPath $runtimeProbePath -PendingRunId $pendingRunId -LogDirectory $stateEvidenceDirectory
  $startupObservations.candidate = [ordered]@{ application = $candidateApplication; health = $candidateStart.health; project_probe = $candidateStart.project_probe }
  $runtimeProbe = $candidateStart.runtime_probe
  $stages.candidate_started = $true
  $stateVerifications.candidate_after_start = Verify-PreservedState "candidate_after_start" $StateContractPath $stateVerifierPath $stateEvidenceDirectory $SourceCommit

  Install-ArcWriter $BaselineInstallerPath $installRoot
  $stages.baseline_rollback = $true
  $rollbackApplication = Get-InstalledApplicationVersion $applicationPath ([string]$baselineProvenance.metadata.baseline_version) "Rollback"
  $rollbackStart = Start-And-StopArcWriter -ApplicationPath $applicationPath -Stage "Rollback" -ProjectRoot $projectRoot -ExternalProjectProbe $true -LogDirectory $stateEvidenceDirectory
  $startupObservations.rollback = [ordered]@{ application = $rollbackApplication; health = $rollbackStart.health; project_probe = $rollbackStart.project_probe }
  $stages.rollback_started = $true
  $stateVerifications.rollback_after_start = Verify-PreservedState "rollback_after_start" $StateContractPath $stateVerifierPath $stateEvidenceDirectory $SourceCommit

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
  schema_version = 2
  source_commit = $SourceCommit
  workspace_dirty = [bool]$workspaceState.dirty
  runtime_port = $RuntimePort
  generated_at = [DateTime]::UtcNow.ToString("o")
  baseline_installer_path = (Resolve-Path -LiteralPath $BaselineInstallerPath).Path
  baseline_installer_sha256 = Get-Sha256 $BaselineInstallerPath
  baseline_installer_metadata_path = (Resolve-Path -LiteralPath $BaselineMetadataPath).Path
  baseline_installer_metadata_sha256 = [string]$baselineProvenance.metadata_sha256
  baseline_installer = $baselineProvenance.metadata
  candidate_version = $CandidateVersion
  candidate_installer_path = (Resolve-Path -LiteralPath $CandidateInstallerPath).Path
  candidate_installer_sha256 = Get-Sha256 $CandidateInstallerPath
  state_contract_path = (Resolve-Path -LiteralPath $StateContractPath).Path
  state_contract_sha256 = Get-Sha256 $StateContractPath
  runtime_probe = $runtimeProbe
  startup_observations = $startupObservations
  state_verification = $stateVerifications
  stages = $stages
  uninstall_completed = $uninstallCompleted
}

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $OutputPath) | Out-Null
$evidence | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $OutputPath -Encoding utf8
Write-Host "Upgrade and rollback smoke evidence written to $OutputPath"
