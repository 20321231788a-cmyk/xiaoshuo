import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";

function fail(message) {
  throw new Error(`[upgrade-state] ${message}`);
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value) {
      fail(`expected --key value pairs, received: ${argv.join(" ")}`);
    }
    values.set(key.slice(2), value);
  }
  return values;
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function within(root, relativePath, label) {
  const resolved = path.resolve(root, String(relativePath || ""));
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    fail(`${label} escapes the project root`);
  }
  return resolved;
}

async function readJson(target, label) {
  try {
    return JSON.parse(await fs.readFile(target, "utf8"));
  } catch (error) {
    fail(`unable to read ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const args = parseArgs(process.argv.slice(2));
const contractPath = path.resolve(args.get("contract") || fail("--contract is required"));
const phase = String(args.get("phase") || "").trim();
const outputPath = path.resolve(args.get("out") || fail("--out is required"));
const expectedCommit = String(args.get("source-commit") || process.env.GITHUB_SHA || process.env.XIAOSHUO_SOURCE_COMMIT || "").trim();
const contractBytes = await fs.readFile(contractPath);
const contract = JSON.parse(contractBytes.toString("utf8"));
if (contract.schema_version !== 2 || !Array.isArray(contract.project_files) || !contract.execution_store) {
  fail("invalid upgrade state contract");
}
if (expectedCommit && contract.source_commit !== expectedCommit) {
  fail(`state contract commit ${contract.source_commit} does not match ${expectedCommit}`);
}
if (!phase) {
  fail("--phase is required");
}
const phaseContract = contract.execution_store.phases?.[phase];
if (
  !phaseContract ||
  !Number.isSafeInteger(phaseContract.schema_version) ||
  typeof phaseContract.target_migration_applied !== "boolean" ||
  !Number.isSafeInteger(phaseContract.migration_backup_count) ||
  phaseContract.migration_backup_count < 0
) {
  fail(`state contract does not declare phase ${phase}`);
}
const migrationContract = contract.execution_store.migration;
if (
  !migrationContract ||
  !Number.isSafeInteger(migrationContract.from_schema_version) ||
  !Number.isSafeInteger(migrationContract.to_schema_version) ||
  !Number.isSafeInteger(migrationContract.version) ||
  migrationContract.version !== migrationContract.to_schema_version ||
  typeof migrationContract.name !== "string" ||
  !/^[0-9a-f]{64}$/i.test(String(migrationContract.checksum || "")) ||
  typeof migrationContract.backup_filename_prefix !== "string" ||
  !migrationContract.backup_filename_prefix ||
  /[\\/]/.test(migrationContract.backup_filename_prefix)
) {
  fail("invalid execution-store migration contract");
}
const projectRoot = path.resolve(String(contract.project_root || ""));
const projectFileResults = [];
for (const expected of contract.project_files) {
  const target = within(projectRoot, expected.relative_path, "project file");
  const actual = hash(await fs.readFile(target));
  if (actual !== expected.sha256) {
    fail(`project file hash changed: ${expected.relative_path}`);
  }
  projectFileResults.push(expected.relative_path);
}

const storePath = within(projectRoot, contract.execution_store.relative_path, "execution store");
const database = new DatabaseSync(storePath, { readOnly: true });
let schemaVersion;
let quickCheck;
let pendingRunIds = [];
let backups = [];
let targetMigrationVerified = false;
try {
  const quickRow = database.prepare("PRAGMA quick_check").get();
  quickCheck = String(quickRow?.quick_check || "");
  if (quickCheck !== "ok" || quickCheck !== contract.execution_store.quick_check) {
    fail(`execution store quick_check failed: ${quickCheck || "<empty>"}`);
  }
  const schemaRow = database.prepare("PRAGMA user_version").get();
  schemaVersion = Number(schemaRow?.user_version || 0);
  if (schemaVersion !== phaseContract.schema_version) {
    fail(`execution store schema ${schemaVersion} does not match phase ${phase}`);
  }
  const migrationVersion = Number(database.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM agent_schema_migrations").get()?.version || 0);
  if (migrationVersion !== schemaVersion) {
    fail(`execution store migration registry ${migrationVersion} does not match schema ${schemaVersion}`);
  }
  const targetMigration = database
    .prepare("SELECT version, name, checksum FROM agent_schema_migrations WHERE version = ?")
    .get(migrationContract.version);
  targetMigrationVerified = Boolean(targetMigration);
  if (targetMigrationVerified !== phaseContract.target_migration_applied) {
    fail(`target migration ${migrationContract.version} state does not match phase ${phase}`);
  }
  if (
    targetMigration &&
    (targetMigration.name !== migrationContract.name || targetMigration.checksum !== migrationContract.checksum)
  ) {
    fail(`target migration ${migrationContract.version} identity changed`);
  }
  for (const expected of contract.execution_store.pending_runs || []) {
    const row = database.prepare("SELECT run_id, status FROM agent_runs WHERE run_id = ?").get(expected.run_id);
    if (!row || !Array.isArray(expected.allowed_statuses) || !expected.allowed_statuses.includes(row.status)) {
      fail(`unfinished run was lost or became terminal: ${expected.run_id}`);
    }
    pendingRunIds.push(row.run_id);
  }
  for (const expected of contract.execution_store.journal_backups || []) {
    const backupPath = within(projectRoot, expected.relative_path, "journal backup");
    const backupHash = hash(await fs.readFile(backupPath));
    if (backupHash !== expected.sha256) {
      fail(`journal backup hash changed: ${expected.relative_path}`);
    }
    const journal = database.prepare("SELECT journal_id, backup_path FROM agent_commit_journal WHERE journal_id = ?").get(expected.journal_id);
    if (!journal || path.resolve(String(journal.backup_path || "")) !== backupPath) {
      fail(`commit journal backup reference changed: ${expected.journal_id}`);
    }
    backups.push(expected.journal_id);
  }
} finally {
  database.close();
}

const migrationBackupDirectory = within(projectRoot, migrationContract.backup_directory, "migration backup directory");
const migrationBackupNames = (await fs.readdir(migrationBackupDirectory))
  .filter((entry) =>
    entry.startsWith(migrationContract.backup_filename_prefix) &&
    !entry.endsWith("-shm") &&
    !entry.endsWith("-wal") &&
    !entry.endsWith("-journal") &&
    !entry.includes(".partial-")
  )
  .sort();
if (migrationBackupNames.length !== phaseContract.migration_backup_count) {
  fail(`migration backup count ${migrationBackupNames.length} does not match phase ${phase}`);
}
const migrationBackups = [];
for (const filename of migrationBackupNames) {
  const backupPath = within(projectRoot, path.join(migrationContract.backup_directory, filename), "migration backup");
  const backupDatabase = new DatabaseSync(backupPath, { readOnly: true });
  let backupQuickCheck;
  let backupSchemaVersion;
  try {
    backupQuickCheck = String(backupDatabase.prepare("PRAGMA quick_check").get()?.quick_check || "");
    backupSchemaVersion = Number(backupDatabase.prepare("PRAGMA user_version").get()?.user_version || 0);
    const backupMigrationVersion = Number(
      backupDatabase.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM agent_schema_migrations").get()?.version || 0
    );
    if (
      backupQuickCheck !== "ok" ||
      backupSchemaVersion !== migrationContract.from_schema_version ||
      backupMigrationVersion !== migrationContract.from_schema_version
    ) {
      fail(`migration backup is not a valid schema v${migrationContract.from_schema_version} database: ${filename}`);
    }
  } finally {
    backupDatabase.close();
  }
  migrationBackups.push({
    relative_path: relativePath(projectRoot, backupPath),
    sha256: hash(await fs.readFile(backupPath)),
    quick_check: backupQuickCheck,
    schema_version: backupSchemaVersion
  });
}

const evidence = {
  schema_version: 2,
  source_commit: contract.source_commit,
  phase,
  project_root: projectRoot,
  project_id: contract.project_id,
  verified_at: new Date().toISOString(),
  state_contract_sha256: hash(contractBytes),
  project_file_hashes_verified: projectFileResults.length === contract.project_files.length,
  execution_store: {
    quick_check: quickCheck,
    schema_version: schemaVersion,
    pending_run_ids: pendingRunIds,
    journal_backups_verified: backups,
    target_migration: {
      version: migrationContract.version,
      applied: targetMigrationVerified
    },
    migration_backups: migrationBackups
  }
};
await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
console.log(`[upgrade-state] verified ${phase}`);

function relativePath(root, target) {
  return path.relative(root, target).replace(/\\/g, "/");
}
