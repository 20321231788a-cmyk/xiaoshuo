import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const verifierPath = path.join(rootDir, "apps", "desktop-shell", "scripts", "verify-release-evidence.mjs");
const desktopPackage = JSON.parse(await fs.readFile(path.join(rootDir, "apps", "desktop-shell", "package.json"), "utf8"));
const sourceCommit = "a".repeat(40);

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function writeJson(target, value) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function runVerifier(args) {
  return spawnSync(process.execPath, [verifierPath, ...args], {
    cwd: rootDir,
    encoding: "utf8",
    env: { ...process.env, XIAOSHUO_SOURCE_COMMIT: sourceCommit }
  });
}

async function createFixture(root) {
  const repository = "owner/repo";
  const baselineVersion = "0.3.2";
  const releaseDir = path.join(root, "release");
  const evidenceDir = path.join(root, "evidence");
  const projectRoot = path.join(root, "project");
  await fs.mkdir(releaseDir, { recursive: true });
  await fs.mkdir(projectRoot, { recursive: true });
  const installerName = `ArcWriter-Setup-${desktopPackage.version}.exe`;
  const installerPath = path.join(releaseDir, installerName);
  await fs.writeFile(installerPath, "candidate-installer");
  await fs.writeFile(`${installerPath}.blockmap`, "candidate-blockmap");
  await fs.writeFile(path.join(releaseDir, "latest.yml"), `path: ${installerName}\n`);
  const installerHash = hash(await fs.readFile(installerPath));
  const pendingRunId = "pending-run";
  const projectId = "11111111-1111-4111-8111-111111111111";
  const migrationBackup = {
    relative_path: ".agent/store.sqlite.backup-v2-test",
    sha256: "b".repeat(64),
    quick_check: "ok",
    schema_version: 2
  };
  const contract = {
    schema_version: 2,
    source_commit: sourceCommit,
    project_root: projectRoot,
    project_id: projectId,
    project_files: [{ relative_path: "chapter.txt", sha256: "d".repeat(64) }],
    runtime_probe: { required_phase: "candidate_after_start", pending_run_id: pendingRunId },
    execution_store: {
      relative_path: ".agent/store.sqlite",
      quick_check: "ok",
      phases: {
        baseline_after_start: { schema_version: 2, target_migration_applied: false, migration_backup_count: 0 },
        candidate_after_start: { schema_version: 3, target_migration_applied: true, migration_backup_count: 1 },
        rollback_after_start: { schema_version: 3, target_migration_applied: true, migration_backup_count: 1 }
      },
      migration: {
        from_schema_version: 2,
        to_schema_version: 3,
        version: 3,
        name: "migration-v3",
        checksum: "c".repeat(64),
        backup_directory: ".agent",
        backup_filename_prefix: "store.sqlite.backup-v2-"
      },
      pending_runs: [{ run_id: pendingRunId, allowed_statuses: ["queued", "running"] }],
      journal_backups: [{ journal_id: "journal-1", relative_path: ".agent/journal.bak", sha256: "e".repeat(64) }]
    }
  };
  const contractPath = path.join(evidenceDir, "upgrade-state-contract.json");
  await writeJson(contractPath, contract);
  const contractHash = hash(await fs.readFile(contractPath));
  const baselineMetadataPath = path.join(evidenceDir, "baseline-release.json");
  const baselineMetadata = {
    schema_version: 1,
    repository,
    candidate_version: desktopPackage.version,
    baseline_version: baselineVersion,
    version_relation: "previous",
    tag: `v${baselineVersion}`,
    release_id: 301,
    asset_id: 302,
    asset_name: `ArcWriter-Setup-${baselineVersion}.exe`,
    asset_url: `https://github.com/${repository}/releases/download/v${baselineVersion}/ArcWriter-Setup-${baselineVersion}.exe`,
    sha256: "f".repeat(64),
    published_at: "2026-07-01T00:00:00Z"
  };
  await writeJson(baselineMetadataPath, baselineMetadata);
  const baselineMetadataHash = hash(await fs.readFile(baselineMetadataPath));
  const stateResult = (phase, schemaVersion, applied, backups) => ({
    schema_version: 2,
    source_commit: sourceCommit,
    phase,
    project_root: projectRoot,
    project_id: projectId,
    verified_at: "2026-07-13T00:00:00.000Z",
    state_contract_sha256: contractHash,
    project_file_hashes_verified: true,
    execution_store: {
      quick_check: "ok",
      schema_version: schemaVersion,
      pending_run_ids: [pendingRunId],
      journal_backups_verified: ["journal-1"],
      target_migration: { version: 3, applied },
      migration_backups: backups
    }
  });
  const upgradeEvidence = {
    schema_version: 2,
    source_commit: sourceCommit,
    workspace_dirty: false,
    runtime_port: 18453,
    generated_at: "2026-07-13T00:00:00.000Z",
    candidate_version: desktopPackage.version,
    baseline_installer_sha256: "f".repeat(64),
    baseline_installer_metadata_sha256: baselineMetadataHash,
    baseline_installer: {
      ...baselineMetadata,
      published_at: new Date(baselineMetadata.published_at).toISOString()
    },
    candidate_installer_sha256: installerHash,
    state_contract_sha256: contractHash,
    runtime_probe: {
      schema_version: 1,
      kind: "upgrade-rollback-runtime-probe",
      ok: true,
      app_version: desktopPackage.version,
      project_root: projectRoot,
      opened_project_path: projectRoot,
      project_id: projectId,
      pending_run: { run_id: pendingRunId, status: "queued" },
      verified_at: "2026-07-13T00:00:01.000Z"
    },
    state_verification: {
      baseline_after_start: stateResult("baseline_after_start", 2, false, []),
      candidate_after_start: stateResult("candidate_after_start", 3, true, [migrationBackup]),
      rollback_after_start: stateResult("rollback_after_start", 3, true, [migrationBackup])
    },
    stages: {
      baseline_install: true,
      baseline_started: true,
      candidate_upgrade: true,
      candidate_started: true,
      baseline_rollback: true,
      rollback_started: true
    },
    startup_observations: {
      baseline: {
        application: { product_version: `${baselineVersion}.0`, normalized_version: baselineVersion },
        health: { ok: true, runtime: "typescript-electron", runtime_version: baselineVersion, observed_at: "2026-07-13T00:00:00.100Z" },
        project_probe: { ok: true, mode: "legacy-runtime-api", project_root: projectRoot, opened_project_path: projectRoot }
      },
      candidate: {
        application: { product_version: `${desktopPackage.version}.0`, normalized_version: desktopPackage.version },
        health: { ok: true, runtime: "typescript-electron", runtime_version: desktopPackage.version, observed_at: "2026-07-13T00:00:01.100Z" },
        project_probe: { ok: true, mode: "main-process-authenticated", project_root: projectRoot, opened_project_path: projectRoot }
      },
      rollback: {
        application: { product_version: `${baselineVersion}.0`, normalized_version: baselineVersion },
        health: { ok: true, runtime: "typescript-electron", runtime_version: baselineVersion, observed_at: "2026-07-13T00:00:02.100Z" },
        project_probe: { ok: true, mode: "legacy-runtime-api", project_root: projectRoot, opened_project_path: projectRoot }
      }
    },
    uninstall_completed: true
  };
  const installedEvidence = {
    schema_version: 1,
    source_commit: sourceCommit,
    workspace_dirty: false,
    installer_sha256: installerHash,
    application_started: true,
    application_was_running: true,
    uninstall_completed: true
  };
  const installedPath = path.join(evidenceDir, "installed-smoke.json");
  const upgradePath = path.join(evidenceDir, "upgrade-rollback-smoke.json");
  await writeJson(installedPath, installedEvidence);
  await writeJson(upgradePath, upgradeEvidence);
  return { releaseDir, evidenceDir, contractPath, baselineMetadataPath, baselineMetadata, repository, installedPath, upgradePath, upgradeEvidence };
}

test("release evidence binds RC files, state migration, runtime probe, and promotion provenance", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "release-evidence-test-"));
  try {
    const fixture = await createFixture(root);
    const rcEvidencePath = path.join(fixture.evidenceDir, "release-evidence.json");
    const common = [
      "--artifact-dir", fixture.releaseDir,
      "--installed-evidence", fixture.installedPath,
      "--upgrade-rollback-evidence", fixture.upgradePath,
      "--state-contract", fixture.contractPath,
      "--baseline-metadata", fixture.baselineMetadataPath,
      "--repository", fixture.repository
    ];
    const rc = runVerifier([...common, "--channel", "rc", "--out", rcEvidencePath]);
    assert.equal(rc.status, 0, rc.stderr || rc.stdout);
    const rcEvidence = JSON.parse(await fs.readFile(rcEvidencePath, "utf8"));
    assert.equal(rcEvidence.schema_version, 2);
    assert.equal(rcEvidence.channel, "rc");
    assert.equal(rcEvidence.files.length, 3);
    assert.equal(rcEvidence.baseline_installer.published_at, "2026-07-01T00:00:00.000Z");
    const originalRcEvidence = await fs.readFile(rcEvidencePath);
    const originalRcEvidenceHash = hash(originalRcEvidence);

    const promotionPath = path.join(root, "publish", "release-evidence.json");
    const promotion = runVerifier([
      ...common,
      "--existing-evidence", rcEvidencePath,
      "--channel", "release",
      "--rc-run-id", "101",
      "--rc-run-attempt", "2",
      "--installer-artifact-id", "201",
      "--eval-artifact-id", "202",
      "--out", promotionPath
    ]);
    assert.equal(promotion.status, 0, promotion.stderr || promotion.stdout);
    const promotionEvidence = JSON.parse(await fs.readFile(promotionPath, "utf8"));
    assert.equal(promotionEvidence.channel, "release");
    assert.deepEqual(promotionEvidence.promotion, {
      rc_run_id: 101,
      rc_run_attempt: 2,
      installer_artifact_id: 201,
      eval_artifact_id: 202,
      existing_rc_evidence_sha256: originalRcEvidenceHash
    });
    assert.deepEqual(await fs.readFile(rcEvidencePath), originalRcEvidence);

    fixture.baselineMetadata.asset_id += 1;
    await writeJson(fixture.baselineMetadataPath, fixture.baselineMetadata);
    const tamperedMetadata = runVerifier([...common, "--channel", "rc", "--out", path.join(fixture.evidenceDir, "tampered-metadata.json")]);
    assert.notEqual(tamperedMetadata.status, 0);
    assert.match(tamperedMetadata.stderr, /baseline metadata|baseline provenance/);
    fixture.baselineMetadata.asset_id -= 1;
    await writeJson(fixture.baselineMetadataPath, fixture.baselineMetadata);

    await fs.writeFile(path.join(fixture.releaseDir, "unexpected.txt"), "unexpected");
    const extraFile = runVerifier([...common, "--channel", "rc", "--out", path.join(fixture.evidenceDir, "extra.json")]);
    assert.notEqual(extraFile.status, 0);
    assert.match(extraFile.stderr, /must contain exactly/);
    await fs.rm(path.join(fixture.releaseDir, "unexpected.txt"));

    fixture.upgradeEvidence.runtime_probe.ok = false;
    await writeJson(fixture.upgradePath, fixture.upgradeEvidence);
    const failedProbe = runVerifier([...common, "--channel", "rc", "--out", path.join(fixture.evidenceDir, "probe.json")]);
    assert.notEqual(failedProbe.status, 0);
    assert.match(failedProbe.stderr, /runtime probe/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
