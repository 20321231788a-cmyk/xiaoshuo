import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { readBaselineInstallerMetadata } from "./baseline-installer-provenance.mjs";

function fail(message) {
  throw new Error(`[release-evidence] ${message}`);
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value) {
      fail(`expected --key value pairs, received: ${argv.join(" ")}`);
    }
    const normalizedKey = key.slice(2);
    if (values.has(normalizedKey)) {
      fail(`duplicate argument: ${key}`);
    }
    values.set(normalizedKey, value);
  }
  return values;
}

async function sha256(filePath) {
  const contents = await fs.readFile(filePath);
  return createHash("sha256").update(contents).digest("hex");
}

async function releaseFiles(artifactDir, desktopVersion) {
  const entries = await fs.readdir(artifactDir, { withFileTypes: true });
  if (entries.some((entry) => !entry.isFile())) {
    fail(`release directory must contain files only: ${artifactDir}`);
  }
  const installerName = `ArcWriter-Setup-${desktopVersion}.exe`;
  const expectedNames = [installerName, `${installerName}.blockmap`, "latest.yml"].sort();
  const actualNames = entries.map((entry) => entry.name).sort();
  if (actualNames.length !== expectedNames.length || actualNames.some((name, index) => name !== expectedNames[index])) {
    fail(`release directory must contain exactly ${expectedNames.join(", ")}`);
  }
  return {
    installerPath: path.join(artifactDir, installerName),
    names: expectedNames
  };
}

async function readJson(filePath, label) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    fail(`unable to read ${label} ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function requiredHash(value, label) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    fail(`${label} must be a SHA-256 hash`);
  }
  return normalized;
}

function requiredString(value, label) {
  const normalized = String(value || "").trim();
  if (!normalized) fail(`${label} must be a non-empty string`);
  return normalized;
}

function normalizedProductVersion(value, label) {
  const raw = requiredString(value, label);
  const match = /^((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))(?:\.0)?$/.exec(raw);
  if (!match) {
    fail(`${label} must be a three-part Windows ProductVersion with an optional .0 suffix`);
  }
  return match[1];
}

function requiredRelativePath(value, label) {
  const normalized = requiredString(value, label).replace(/\\/g, "/");
  if (path.isAbsolute(normalized) || normalized === "." || normalized.split("/").includes("..")) {
    fail(`${label} must be a safe relative path`);
  }
  return normalized;
}

function sameResolvedPath(actual, expected) {
  return path.relative(path.resolve(actual), path.resolve(expected)) === "";
}

function requiredPositiveInteger(value, label) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 1) {
    fail(`${label} must be a positive safe integer`);
  }
  return normalized;
}

function stableJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function readInstalledEvidence(evidencePath, installerHash, commit) {
  const evidence = await readJson(evidencePath, "installed smoke evidence");
  if (evidence.schema_version !== 1) {
    fail("installed smoke evidence has an unsupported schema version");
  }
  if (evidence.source_commit !== commit) {
    fail(`installed smoke commit ${evidence.source_commit} does not match ${commit}`);
  }
  if (evidence.workspace_dirty !== false) {
    fail("installed smoke was run from a dirty workspace and cannot be used as release evidence");
  }
  if (requiredHash(evidence.installer_sha256, "installed smoke installer hash") !== installerHash) {
    fail("installed smoke was not run against this installer");
  }
  if (!evidence.application_started || !evidence.application_was_running || !evidence.uninstall_completed) {
    fail("installed smoke evidence is incomplete");
  }
  return evidence;
}

async function readUpgradeRollbackEvidence(evidencePath, installerHash, commit) {
  const evidence = await readJson(evidencePath, "upgrade and rollback smoke evidence");
  if (evidence.schema_version !== 2) {
    fail("upgrade and rollback smoke evidence has an unsupported schema version");
  }
  if (evidence.source_commit !== commit) {
    fail(`upgrade and rollback smoke commit ${evidence.source_commit} does not match ${commit}`);
  }
  if (evidence.workspace_dirty !== false) {
    fail("upgrade and rollback smoke was run from a dirty workspace and cannot be used as release evidence");
  }
  if (requiredHash(evidence.candidate_installer_sha256, "upgrade smoke candidate installer hash") !== installerHash) {
    fail("upgrade and rollback smoke was not run against this installer");
  }
  const baselineHash = requiredHash(evidence.baseline_installer_sha256, "upgrade smoke baseline installer hash");
  if (baselineHash === installerHash) {
    fail("upgrade and rollback smoke used the candidate installer as its baseline");
  }
  const stages = evidence.stages || {};
  for (const stage of ["baseline_install", "baseline_started", "candidate_upgrade", "candidate_started", "baseline_rollback", "rollback_started"]) {
    if (stages[stage] !== true) {
      fail(`upgrade and rollback smoke is missing successful stage ${stage}`);
    }
  }
  if (evidence.uninstall_completed !== true) {
    fail("upgrade and rollback smoke did not uninstall the application");
  }
  if (evidence.runtime_port !== 18453) {
    fail("upgrade and rollback smoke did not use the isolated RC runtime port");
  }
  const startupObservations = evidence.startup_observations;
  const expectedProbeModes = {
    baseline: "legacy-runtime-api",
    candidate: "main-process-authenticated",
    rollback: "legacy-runtime-api"
  };
  for (const stage of Object.keys(expectedProbeModes)) {
    const observation = startupObservations?.[stage];
    const application = observation?.application;
    const health = observation?.health;
    const projectProbe = observation?.project_probe;
    const installedVersion = normalizedProductVersion(application?.product_version, `${stage} installed ProductVersion`);
    if (!application || application.normalized_version !== installedVersion ||
        !health || health.ok !== true || health.runtime !== "typescript-electron" ||
        !requiredString(health.runtime_version, `${stage} startup runtime version`) ||
        !Number.isFinite(Date.parse(requiredString(health.observed_at, `${stage} startup observed_at`))) ||
        !projectProbe || projectProbe.ok !== true || projectProbe.mode !== expectedProbeModes[stage] ||
        !sameResolvedPath(projectProbe.project_root, projectProbe.opened_project_path)) {
      fail(`upgrade and rollback smoke has no valid ${stage} installed-runtime health observation`);
    }
  }
  return evidence;
}

function validateUpgradeBaselineProvenance(evidence, provenance, desktopVersion) {
  if (evidence.candidate_version !== desktopVersion) {
    fail("upgrade and rollback smoke candidate version does not match the desktop package");
  }
  if (requiredHash(evidence.baseline_installer_metadata_sha256, "upgrade smoke baseline metadata hash") !== provenance.metadata_sha256) {
    fail("upgrade and rollback smoke did not use the supplied baseline metadata file");
  }
  if (stableJson(evidence.baseline_installer) !== stableJson(provenance.metadata)) {
    fail("upgrade and rollback smoke baseline provenance does not match the supplied metadata");
  }
  if (requiredHash(evidence.baseline_installer_sha256, "upgrade smoke baseline installer hash") !== provenance.metadata.sha256) {
    fail("upgrade and rollback smoke baseline bytes do not match the supplied metadata");
  }
  const expectedVersions = {
    baseline: provenance.metadata.baseline_version,
    candidate: desktopVersion,
    rollback: provenance.metadata.baseline_version
  };
  for (const [stage, expectedVersion] of Object.entries(expectedVersions)) {
    if (evidence.startup_observations?.[stage]?.application?.normalized_version !== expectedVersion) {
      fail(`${stage} installed executable version does not match baseline provenance`);
    }
  }
}

async function readStateContract(contractPath, commit) {
  const bytes = await fs.readFile(contractPath);
  let contract;
  try {
    contract = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    fail(`unable to parse upgrade state contract: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (contract.schema_version !== 2 || contract.source_commit !== commit || !Array.isArray(contract.project_files) || !contract.project_files.length || !contract.execution_store) {
    fail("upgrade state contract is invalid or does not match the source commit");
  }
  const projectId = requiredString(contract.project_id, "state contract project id");
  const projectRoot = requiredString(contract.project_root, "state contract project root");
  if (!path.isAbsolute(projectRoot)) {
    fail("state contract project root must be absolute");
  }
  if (contract.execution_store.quick_check !== "ok") {
    fail("upgrade state contract must require SQLite quick_check=ok");
  }
  requiredRelativePath(contract.execution_store.relative_path, "state contract execution-store path");
  const phaseNames = ["baseline_after_start", "candidate_after_start", "rollback_after_start"];
  const phaseContracts = {};
  for (const phase of phaseNames) {
    const phaseContract = contract.execution_store.phases?.[phase];
    if (!phaseContract || !Number.isSafeInteger(phaseContract.schema_version) || phaseContract.schema_version < 1 ||
        typeof phaseContract.target_migration_applied !== "boolean" ||
        !Number.isSafeInteger(phaseContract.migration_backup_count) || phaseContract.migration_backup_count < 0) {
      fail(`state contract has an invalid phase declaration for ${phase}`);
    }
    phaseContracts[phase] = {
      schemaVersion: phaseContract.schema_version,
      targetMigrationApplied: phaseContract.target_migration_applied,
      migrationBackupCount: phaseContract.migration_backup_count
    };
  }
  const migration = contract.execution_store.migration;
  if (!migration || !Number.isSafeInteger(migration.from_schema_version) || migration.from_schema_version < 1 ||
      !Number.isSafeInteger(migration.to_schema_version) || migration.to_schema_version <= migration.from_schema_version ||
      !Number.isSafeInteger(migration.version) || migration.version !== migration.to_schema_version) {
    fail("state contract has an invalid execution-store migration version");
  }
  const normalizedMigration = {
    fromSchemaVersion: migration.from_schema_version,
    toSchemaVersion: migration.to_schema_version,
    version: migration.version,
    name: requiredString(migration.name, "state contract migration name"),
    checksum: requiredHash(migration.checksum, "state contract migration checksum"),
    backupDirectory: requiredRelativePath(migration.backup_directory, "state contract migration backup directory"),
    backupFilenamePrefix: requiredString(migration.backup_filename_prefix, "state contract migration backup filename prefix")
  };
  if (/[\\/]/.test(normalizedMigration.backupFilenamePrefix)) {
    fail("state contract migration backup filename prefix must not contain path separators");
  }
  const baselinePhase = phaseContracts.baseline_after_start;
  const candidatePhase = phaseContracts.candidate_after_start;
  const rollbackPhase = phaseContracts.rollback_after_start;
  if (baselinePhase.schemaVersion !== normalizedMigration.fromSchemaVersion || baselinePhase.targetMigrationApplied || baselinePhase.migrationBackupCount !== 0 ||
      candidatePhase.schemaVersion !== normalizedMigration.toSchemaVersion || !candidatePhase.targetMigrationApplied || candidatePhase.migrationBackupCount !== 1 ||
      rollbackPhase.schemaVersion !== normalizedMigration.toSchemaVersion || !rollbackPhase.targetMigrationApplied || rollbackPhase.migrationBackupCount !== 1) {
    fail("state contract phases do not describe the required v2-to-v3 migration and preserved backup");
  }
  const projectFilePaths = new Set();
  for (const entry of contract.project_files) {
    const relativePath = requiredRelativePath(entry?.relative_path, "state contract project file path");
    if (projectFilePaths.has(relativePath)) {
      fail(`state contract contains a duplicate project file path: ${relativePath}`);
    }
    requiredHash(entry?.sha256, `state contract project file hash for ${relativePath}`);
    projectFilePaths.add(relativePath);
  }
  const pendingRuns = contract.execution_store.pending_runs || [];
  const pendingRunStatuses = new Map();
  const pendingRunIds = new Set(pendingRuns.map((entry) => {
    const runId = requiredString(entry?.run_id, "state contract pending run id");
    if (!Array.isArray(entry?.allowed_statuses) || !entry.allowed_statuses.length) {
      fail(`state contract pending run ${runId} has no allowed status`);
    }
    const allowedStatuses = [...new Set(entry.allowed_statuses.map((status) => requiredString(status, `state contract pending run ${runId} status`)))].sort();
    if (allowedStatuses.length !== entry.allowed_statuses.length) {
      fail(`state contract pending run ${runId} contains duplicate statuses`);
    }
    pendingRunStatuses.set(runId, allowedStatuses);
    return runId;
  }));
  const journalBackups = contract.execution_store.journal_backups || [];
  const journalIds = new Set(journalBackups.map((entry) => {
    const journalId = requiredString(entry?.journal_id, "state contract journal id");
    requiredRelativePath(entry?.relative_path, `state contract journal ${journalId} backup path`);
    requiredHash(entry?.sha256, `state contract journal ${journalId} backup hash`);
    return journalId;
  }));
  if (pendingRunIds.size !== pendingRuns.length || journalIds.size !== journalBackups.length) {
    fail("upgrade state contract contains duplicate run or journal identifiers");
  }
  if (!pendingRunIds.size || !journalIds.size) {
    fail("upgrade state contract must include an unfinished run and journal backup");
  }
  const runtimeProbe = contract.runtime_probe;
  const requiredProbePhase = requiredString(runtimeProbe?.required_phase, "state contract runtime probe phase");
  const runtimePendingRunId = requiredString(runtimeProbe?.pending_run_id, "state contract runtime probe pending run id");
  if (requiredProbePhase !== "candidate_after_start" || !pendingRunIds.has(runtimePendingRunId)) {
    fail("state contract runtime probe must target the candidate phase and a declared pending run");
  }
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    projectId,
    projectRoot: path.resolve(projectRoot),
    phaseContracts,
    migration: normalizedMigration,
    runtimeProbe: {
      requiredPhase: requiredProbePhase,
      pendingRunId: runtimePendingRunId
    },
    pendingRunStatuses,
    pendingRunIds: [...pendingRunIds].sort(),
    journalIds: [...journalIds].sort()
  };
}

function sameStringSet(actual, expected, label) {
  if (!Array.isArray(actual)) {
    fail(`${label} must be an array`);
  }
  const normalized = [...new Set(actual.map((value) => requiredString(value, label)))].sort();
  if (normalized.length !== actual.length || normalized.length !== expected.length || normalized.some((value, index) => value !== expected[index])) {
    fail(`${label} does not match the upgrade state contract`);
  }
}

function validateMigrationBackups(backups, expectedCount, contract, label) {
  if (!Array.isArray(backups) || backups.length !== expectedCount) {
    fail(`${label}.migration_backups does not match the state contract`);
  }
  const paths = new Set();
  const normalized = backups.map((backup) => {
    const relativePath = requiredRelativePath(backup?.relative_path, `${label} migration backup path`);
    if (paths.has(relativePath)) {
      fail(`${label} contains a duplicate migration backup path`);
    }
    paths.add(relativePath);
    if (backup.quick_check !== "ok" || backup.schema_version !== contract.migration.fromSchemaVersion) {
      fail(`${label} migration backup is not a healthy pre-migration database`);
    }
    const backupDirectory = path.posix.dirname(relativePath);
    const backupName = path.posix.basename(relativePath);
    if (backupDirectory !== contract.migration.backupDirectory || !backupName.startsWith(contract.migration.backupFilenamePrefix)) {
      fail(`${label} migration backup does not match the contracted directory and filename prefix`);
    }
    return {
      relativePath,
      sha256: requiredHash(backup.sha256, `${label} migration backup hash`),
      quickCheck: backup.quick_check,
      schemaVersion: backup.schema_version
    };
  });
  return normalized.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function validateRuntimeProbe(evidence, contract, desktopVersion, candidateState) {
  const probe = evidence.runtime_probe;
  if (!probe || probe.schema_version !== 1 || probe.kind !== "upgrade-rollback-runtime-probe" || probe.ok !== true) {
    fail("upgrade and rollback smoke has no successful installed candidate runtime probe");
  }
  if (probe.app_version !== desktopVersion || probe.project_id !== contract.projectId ||
      !sameResolvedPath(probe.project_root, contract.projectRoot) ||
      !sameResolvedPath(probe.opened_project_path, contract.projectRoot)) {
    fail("installed candidate runtime probe is not bound to this version and project");
  }
  const pendingRun = probe.pending_run;
  const allowedStatuses = contract.pendingRunStatuses.get(contract.runtimeProbe.pendingRunId) || [];
  if (!pendingRun || pendingRun.run_id !== contract.runtimeProbe.pendingRunId || !allowedStatuses.includes(pendingRun.status)) {
    fail("installed candidate runtime probe did not observe the declared pending run");
  }
  if (!candidateState.execution_store.pending_run_ids.includes(pendingRun.run_id)) {
    fail("installed candidate runtime probe and candidate state evidence disagree on the pending run");
  }
  if (!Number.isFinite(Date.parse(requiredString(probe.verified_at, "runtime probe verified_at")))) {
    fail("installed candidate runtime probe has an invalid verification timestamp");
  }
}

async function validateStateIntegrity(evidence, contract, desktopVersion) {
  const phases = evidence.state_verification;
  const phaseNames = ["baseline_after_start", "candidate_after_start", "rollback_after_start"];
  if (!phases || typeof phases !== "object" || Array.isArray(phases) ||
      Object.keys(phases).sort().join("\n") !== [...phaseNames].sort().join("\n")) {
    fail("upgrade and rollback smoke has no state integrity evidence");
  }
  for (const stage of ["baseline", "candidate", "rollback"]) {
    const projectProbe = evidence.startup_observations?.[stage]?.project_probe;
    if (!projectProbe || !sameResolvedPath(projectProbe.project_root, contract.projectRoot) ||
        !sameResolvedPath(projectProbe.opened_project_path, contract.projectRoot)) {
      fail(`${stage} installed-runtime project probe is not bound to the contract project`);
    }
  }
  const validatedPhases = {};
  for (const phase of phaseNames) {
    const result = phases[phase];
    const phaseContract = contract.phaseContracts[phase];
    if (!result || typeof result !== "object" || result.schema_version !== 2) {
      fail(`upgrade and rollback smoke is missing state evidence for ${phase}`);
    }
    if (result.phase !== phase || requiredHash(result.state_contract_sha256, `${phase}.state_contract_sha256`) !== contract.sha256) {
      fail(`state evidence for ${phase} is not bound to the supplied state contract`);
    }
    if (result.source_commit !== evidence.source_commit) {
      fail(`state evidence for ${phase} is not bound to the candidate commit`);
    }
    if (result.project_id !== contract.projectId || !sameResolvedPath(result.project_root, contract.projectRoot)) {
      fail(`state evidence for ${phase} is not bound to the contract project`);
    }
    if (result.project_file_hashes_verified !== true) {
      fail(`state evidence for ${phase} did not preserve project file hashes`);
    }
    const store = result.execution_store;
    if (!store || store.quick_check !== "ok" || store.schema_version !== phaseContract.schemaVersion) {
      fail(`state evidence for ${phase} did not preserve a healthy execution store and schema`);
    }
    sameStringSet(store.pending_run_ids, contract.pendingRunIds, `${phase}.pending_run_ids`);
    sameStringSet(store.journal_backups_verified, contract.journalIds, `${phase}.journal_backups_verified`);
    if (!store.target_migration || store.target_migration.version !== contract.migration.version ||
        store.target_migration.applied !== phaseContract.targetMigrationApplied) {
      fail(`state evidence for ${phase} does not match the target migration contract`);
    }
    const migrationBackups = validateMigrationBackups(
      store.migration_backups,
      phaseContract.migrationBackupCount,
      contract,
      phase
    );
    validatedPhases[phase] = { ...result, execution_store: { ...store, migrationBackups } };
  }
  const candidateBackups = validatedPhases.candidate_after_start.execution_store.migrationBackups;
  const rollbackBackups = validatedPhases.rollback_after_start.execution_store.migrationBackups;
  if (stableJson(candidateBackups) !== stableJson(rollbackBackups)) {
    fail("rollback did not preserve the exact candidate migration backup");
  }
  validateRuntimeProbe(evidence, contract, desktopVersion, validatedPhases[contract.runtimeProbe.requiredPhase]);
}

async function verifyExistingEvidence(existingPath, artifactDir, installerPath, installerHash, installedEvidence, installedEvidenceHash, upgradeEvidence, upgradeEvidenceHash, baselineProvenance, contract, commit, desktopVersion) {
  const evidence = await readJson(existingPath, "existing RC release evidence");
  if (evidence.schema_version !== 2 || evidence.source_commit !== commit || evidence.channel !== "rc" || evidence.desktop_version !== desktopVersion) {
    fail("existing RC release evidence is not bound to this source commit and desktop version");
  }
  if (evidence.installer?.name !== path.basename(installerPath) || evidence.installer?.sha256 !== installerHash) {
    fail("existing RC release evidence is not bound to the downloaded installer");
  }
  if (requiredHash(evidence.installed_smoke_sha256, "existing RC installed smoke evidence hash") !== installedEvidenceHash ||
      requiredHash(evidence.upgrade_rollback_smoke_sha256, "existing RC upgrade smoke evidence hash") !== upgradeEvidenceHash ||
      requiredHash(evidence.baseline_installer_metadata_sha256, "existing RC baseline metadata hash") !== baselineProvenance.metadata_sha256 ||
      stableJson(evidence.installed_smoke) !== stableJson(installedEvidence) ||
      stableJson(evidence.upgrade_rollback_smoke) !== stableJson(upgradeEvidence) ||
      stableJson(evidence.baseline_installer) !== stableJson(baselineProvenance.metadata)) {
    fail("existing RC release evidence does not match its downloaded smoke evidence");
  }
  if (!Array.isArray(evidence.files)) {
    fail("existing RC release evidence has no release file inventory");
  }
  const expectedFiles = new Map();
  for (const entry of evidence.files) {
    const name = requiredString(entry?.name, "existing RC release file name");
    if (path.basename(name) !== name || expectedFiles.has(name)) {
      fail(`existing RC release evidence contains an unsafe or duplicate file name: ${name}`);
    }
    expectedFiles.set(name, requiredHash(entry?.sha256, `existing RC release file hash for ${name}`));
  }
  const actualFiles = await Promise.all(
    (await fs.readdir(artifactDir, { withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map(async (entry) => [entry.name, await sha256(path.join(artifactDir, entry.name))])
  );
  if (expectedFiles.size !== evidence.files.length || expectedFiles.size !== actualFiles.length) {
    fail("existing RC release evidence does not enumerate the downloaded release files exactly");
  }
  for (const [name, fileHash] of actualFiles) {
    if (expectedFiles.get(name) !== fileHash) {
      fail(`existing RC release evidence hash mismatch for ${name}`);
    }
  }
  if (requiredHash(evidence.upgrade_state_contract_sha256, "existing RC upgrade state contract hash") !== contract.sha256) {
    fail("existing RC release evidence does not match the downloaded state contract");
  }
  await validateStateIntegrity(evidence.upgrade_rollback_smoke, contract, desktopVersion);
  return {
    evidence,
    sha256: await sha256(existingPath)
  };
}

const args = parseArgs(process.argv.slice(2));
const artifactDir = path.resolve(args.get("artifact-dir") || fail("--artifact-dir is required"));
const outputPath = path.resolve(args.get("out") || fail("--out is required"));
const outputRelativeToRelease = path.relative(artifactDir, outputPath);
if (!outputRelativeToRelease || (!outputRelativeToRelease.startsWith("..") && !path.isAbsolute(outputRelativeToRelease))) {
  fail("--out must be outside the immutable release file directory");
}
const channel = requiredString(args.get("channel") || fail("--channel is required"), "channel");
if (!["nightly", "rc", "release"].includes(channel)) {
  fail(`unsupported release evidence channel: ${channel}`);
}
const stateContractPath = args.get("state-contract") || fail("--state-contract is required");
const baselineMetadataPath = args.get("baseline-metadata") || fail("--baseline-metadata is required");
const repository = requiredString(args.get("repository") || process.env.GITHUB_REPOSITORY || fail("--repository is required"), "repository");
const sourceCommit = String(process.env.XIAOSHUO_SOURCE_COMMIT || process.env.GITHUB_SHA || "").trim().toLowerCase();
if (!/^[0-9a-f]{40}$/.test(sourceCommit)) {
  fail("GITHUB_SHA or XIAOSHUO_SOURCE_COMMIT must contain the source commit");
}

const desktopPackage = JSON.parse(
  await fs.readFile(path.resolve("apps", "desktop-shell", "package.json"), "utf8")
);
const desktopVersion = requiredString(desktopPackage.version, "desktop package version");
if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(desktopVersion)) {
  fail(`desktop package version is invalid: ${desktopVersion}`);
}
const stagedRelease = await releaseFiles(artifactDir, desktopVersion);
const installerPath = stagedRelease.installerPath;
const installerHash = await sha256(installerPath);
const installedEvidencePath = args.get("installed-evidence");
const installedEvidence = installedEvidencePath
  ? await readInstalledEvidence(path.resolve(installedEvidencePath), installerHash, sourceCommit)
  : null;
const installedEvidenceHash = installedEvidencePath ? await sha256(path.resolve(installedEvidencePath)) : "";
const upgradeRollbackEvidencePath = args.get("upgrade-rollback-evidence");
const upgradeRollbackEvidence = upgradeRollbackEvidencePath
  ? await readUpgradeRollbackEvidence(path.resolve(upgradeRollbackEvidencePath), installerHash, sourceCommit)
  : null;
const upgradeRollbackEvidenceHash = upgradeRollbackEvidencePath ? await sha256(path.resolve(upgradeRollbackEvidencePath)) : "";
if (!installedEvidence || !upgradeRollbackEvidence) {
  fail("installed and upgrade/rollback smoke evidence are both required");
}
let baselineProvenance;
try {
  baselineProvenance = await readBaselineInstallerMetadata(path.resolve(baselineMetadataPath), {
    repository,
    candidateVersion: desktopVersion,
    baselineInstallerSha256: upgradeRollbackEvidence.baseline_installer_sha256
  });
} catch (error) {
  fail(`baseline installer metadata is invalid: ${error instanceof Error ? error.message : String(error)}`);
}
validateUpgradeBaselineProvenance(upgradeRollbackEvidence, baselineProvenance, desktopVersion);
const stateContract = await readStateContract(path.resolve(stateContractPath), sourceCommit);
if (requiredHash(upgradeRollbackEvidence.state_contract_sha256, "upgrade smoke state contract hash") !== stateContract.sha256) {
  fail("upgrade and rollback smoke did not use the supplied state contract");
}
await validateStateIntegrity(upgradeRollbackEvidence, stateContract, desktopVersion);

const files = await Promise.all(
  stagedRelease.names.map(async (name) => ({
      name,
      sha256: await sha256(path.join(artifactDir, name))
    }))
);

const evidence = {
  schema_version: 2,
  source_commit: sourceCommit,
  channel,
  desktop_version: desktopVersion,
  generated_at: new Date().toISOString(),
  installer: {
    name: path.basename(installerPath),
    sha256: installerHash
  },
  files,
  installed_smoke_sha256: installedEvidenceHash,
  installed_smoke: installedEvidence,
  upgrade_rollback_smoke_sha256: upgradeRollbackEvidenceHash,
  upgrade_rollback_smoke: upgradeRollbackEvidence,
  baseline_installer_metadata_sha256: baselineProvenance.metadata_sha256,
  baseline_installer: baselineProvenance.metadata,
  upgrade_state_contract_sha256: stateContract.sha256
};

const existingEvidencePath = args.get("existing-evidence");
if (existingEvidencePath && sameResolvedPath(existingEvidencePath, outputPath)) {
  fail("release verification output must not overwrite the existing RC evidence");
}
if (channel === "release" && !existingEvidencePath) {
  fail("release promotion requires --existing-evidence from the RC artifact");
}
if (channel !== "release" && existingEvidencePath) {
  fail("--existing-evidence is allowed only for release promotion");
}
if (existingEvidencePath) {
  const existingEvidence = await verifyExistingEvidence(
    path.resolve(existingEvidencePath),
    artifactDir,
    installerPath,
    installerHash,
    installedEvidence,
    installedEvidenceHash,
    upgradeRollbackEvidence,
    upgradeRollbackEvidenceHash,
    baselineProvenance,
    stateContract,
    sourceCommit,
    desktopVersion
  );
  const rcRunId = requiredPositiveInteger(args.get("rc-run-id"), "RC run id");
  const rcRunAttempt = requiredPositiveInteger(args.get("rc-run-attempt"), "RC run attempt");
  const installerArtifactId = requiredPositiveInteger(args.get("installer-artifact-id"), "installer artifact id");
  const evalArtifactId = requiredPositiveInteger(args.get("eval-artifact-id"), "eval artifact id");
  if (installerArtifactId === evalArtifactId) {
    fail("installer and evaluation artifacts must have distinct ids");
  }
  evidence.promotion = {
    rc_run_id: rcRunId,
    rc_run_attempt: rcRunAttempt,
    installer_artifact_id: installerArtifactId,
    eval_artifact_id: evalArtifactId,
    existing_rc_evidence_sha256: existingEvidence.sha256
  };
}

await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
console.log(`[release-evidence] wrote ${outputPath} for ${sourceCommit}`);
