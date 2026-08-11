import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";
import {
  CURRENT_EXECUTION_STORE_SCHEMA_VERSION,
  EXECUTION_STORE_MIGRATIONS,
  openExecutionStore
} from "@xiaoshuo/agent-runtime";

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

function stampedHash(value) {
  return `sha256:${hash(value)}`;
}

function relativePath(root, target) {
  return path.relative(root, target).replace(/\\/g, "/");
}

async function ensureMissing(directory) {
  const entries = await fs.readdir(directory).catch(() => null);
  if (entries && entries.length) {
    fail(`project root must be empty: ${directory}`);
  }
  await fs.mkdir(directory, { recursive: true });
}

const args = parseArgs(process.argv.slice(2));
const projectRoot = path.resolve(args.get("project-root") || fail("--project-root is required"));
const outputPath = path.resolve(args.get("out") || fail("--out is required"));
const sourceCommit = String(args.get("source-commit") || process.env.GITHUB_SHA || "").trim();
if (!/^[0-9a-f]{7,64}$/i.test(sourceCommit)) {
  fail("--source-commit or GITHUB_SHA must contain the candidate commit");
}

await ensureMissing(projectRoot);
const projectId = randomUUID();
const outlinePath = path.join(projectRoot, "01_大纲", "大纲.txt");
const chapterPath = path.join(projectRoot, "02_正文", "第一章.txt");
const backupPath = `${chapterPath}.upgrade-smoke.bak`;
const manifestPath = path.join(projectRoot, "00_设定集", ".agent", "project_manifest.json");
const createdAt = "2026-07-13T00:00:00.000Z";
const oldChapter = "升级前章节内容\n";
const currentChapter = "升级回滚验证章节内容\n";

await fs.mkdir(path.dirname(outlinePath), { recursive: true });
await fs.mkdir(path.dirname(chapterPath), { recursive: true });
await fs.mkdir(path.dirname(manifestPath), { recursive: true });
await fs.writeFile(outlinePath, "升级回滚验证大纲\n", "utf8");
await fs.writeFile(chapterPath, currentChapter, "utf8");
await fs.writeFile(backupPath, oldChapter, "utf8");
await fs.writeFile(manifestPath, `${JSON.stringify({
  project_path: projectRoot,
  project_id: projectId,
  version: 1,
  generated_at: createdAt,
  entries: []
}, null, 2)}\n`, "utf8");

const runId = "rc-upgrade-pending-run";
const journalId = "rc-upgrade-backup-journal";
const migrationSourceVersion = CURRENT_EXECUTION_STORE_SCHEMA_VERSION - 1;
const targetMigration = EXECUTION_STORE_MIGRATIONS.find((migration) => migration.version === CURRENT_EXECUTION_STORE_SCHEMA_VERSION);
if (CURRENT_EXECUTION_STORE_SCHEMA_VERSION !== 3 || migrationSourceVersion !== 2 || !targetMigration) {
  fail("upgrade smoke schema fixture must be reviewed for the current execution-store migration");
}
const store = openExecutionStore(projectRoot, { backupBeforeMigration: false, now: () => new Date(createdAt) });
const storePath = store.databasePath;
let projectFiles;
try {
  store.createRun({
    schema_version: store.schemaVersion,
    version: 1,
    run_id: runId,
    request_id: "rc-upgrade-request",
    conversation_id: "",
    project_id: projectId,
    project_path: projectRoot,
    goal: {
      instruction: "Keep this pending run intact through installer upgrade and rollback.",
      autonomy_mode: "execute",
      requested_outputs: [],
      success_criteria: [],
      assumptions: [],
      blocking_questions: [],
      request_snapshot: { content: "upgrade smoke", attachment_refs: [], selected_file_refs: [], settings_snapshot: {}, feature_flag_snapshot: {} }
    },
    goal_revision: 1,
    plan_version: 1,
    plan_status: "draft",
    status: "queued",
    current_step_id: "",
    runtime_instance_id: "",
    heartbeat_at: "",
    lease_expires_at: "",
    pause_requested_at: "",
    cancel_requested_at: "",
    recovery_reason: "",
    error_code: "",
    error: "",
    steps: [],
    artifacts: [],
    budget: {
      schema_version: 1,
      budget_id: "budget-rc-upgrade",
      profile_id: "rc-upgrade-smoke",
      max_steps: 3,
      max_replans: 1,
      max_model_calls: 3,
      max_input_tokens: 32000,
      max_output_tokens: 8000,
      max_estimated_cost: 1,
      deadline_at: "2030-01-01T00:00:00.000Z",
      used_steps: 0,
      used_replans: 0,
      used_model_calls: 0,
      used_input_tokens: 0,
      used_output_tokens: 0,
      estimated_cost: 0
    },
    last_event_sequence: 0,
    created_at: createdAt,
    updated_at: createdAt
  });
  store.createCommitJournal({
    journal_id: journalId,
    run_id: runId,
    step_id: "step-rc-upgrade",
    attempt_id: "attempt-rc-upgrade",
    action: "replace_file",
    target_path: chapterPath,
    base_hash: stampedHash(oldChapter),
    new_hash: stampedHash(currentChapter),
    temp_path: `${chapterPath}.${journalId}.tmp`,
    backup_path: backupPath,
    document_version: 1,
    timeline_ref: journalId,
    idempotency_key: "rc-upgrade-backup",
    fencing_token: 1,
    stage: "finalized",
    version: 1,
    manifest: { project_id: projectId, relative_path: relativePath(projectRoot, chapterPath) },
    error_code: "",
    error: "",
    created_at: createdAt,
    updated_at: createdAt,
    finalized_at: createdAt
  });
  if (store.quickCheck() !== "ok") {
    fail("new execution store did not pass quick_check");
  }
  projectFiles = await Promise.all([outlinePath, chapterPath, manifestPath].map(async (target) => ({
    relative_path: relativePath(projectRoot, target),
    sha256: hash(await fs.readFile(target))
  })));
} finally {
  store.close();
}

downgradeToMigrationSource(storePath, migrationSourceVersion, CURRENT_EXECUTION_STORE_SCHEMA_VERSION);
const migrationBackupPrefix = `${path.basename(storePath)}.backup-v${migrationSourceVersion}-`;
const preexistingMigrationBackups = (await fs.readdir(path.dirname(storePath)))
  .filter((entry) => entry.startsWith(migrationBackupPrefix));
if (preexistingMigrationBackups.length) {
  fail("migration fixture unexpectedly created a backup before installed candidate startup");
}

const contract = {
  schema_version: 2,
  source_commit: sourceCommit,
  project_root: projectRoot,
  project_id: projectId,
  project_files: projectFiles,
  runtime_probe: {
    required_phase: "candidate_after_start",
    pending_run_id: runId
  },
  execution_store: {
    relative_path: relativePath(projectRoot, storePath),
    quick_check: "ok",
    phases: {
      baseline_after_start: {
        schema_version: migrationSourceVersion,
        target_migration_applied: false,
        migration_backup_count: 0
      },
      candidate_after_start: {
        schema_version: CURRENT_EXECUTION_STORE_SCHEMA_VERSION,
        target_migration_applied: true,
        migration_backup_count: 1
      },
      rollback_after_start: {
        schema_version: CURRENT_EXECUTION_STORE_SCHEMA_VERSION,
        target_migration_applied: true,
        migration_backup_count: 1
      }
    },
    migration: {
      from_schema_version: migrationSourceVersion,
      to_schema_version: CURRENT_EXECUTION_STORE_SCHEMA_VERSION,
      version: targetMigration.version,
      name: targetMigration.name,
      checksum: targetMigration.checksum,
      backup_directory: relativePath(projectRoot, path.dirname(storePath)),
      backup_filename_prefix: migrationBackupPrefix
    },
    pending_runs: [{ run_id: runId, allowed_statuses: ["queued", "planning", "running", "waiting_confirmation"] }],
    journal_backups: [{ journal_id: journalId, relative_path: relativePath(projectRoot, backupPath), sha256: hash(await fs.readFile(backupPath)) }]
  }
};
await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, `${JSON.stringify(contract, null, 2)}\n`, "utf8");
console.log(`[upgrade-state] wrote ${outputPath}`);

function downgradeToMigrationSource(databasePath, sourceVersion, targetVersion) {
  const database = new DatabaseSync(databasePath);
  let transactionOpen = false;
  try {
    const target = database.prepare("SELECT version FROM agent_schema_migrations WHERE version = ?").get(targetVersion);
    if (Number(target?.version || 0) !== targetVersion) {
      fail(`target migration ${targetVersion} was not present before fixture downgrade`);
    }
    database.exec("BEGIN IMMEDIATE");
    transactionOpen = true;
    database.exec("DROP TABLE agent_model_budget_reservations");
    database.prepare("DELETE FROM agent_schema_migrations WHERE version = ?").run(targetVersion);
    database.exec(`PRAGMA user_version = ${sourceVersion}`);
    database.exec("COMMIT");
    transactionOpen = false;
    database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const quickCheck = String(database.prepare("PRAGMA quick_check").get()?.quick_check || "");
    const actualVersion = Number(database.prepare("PRAGMA user_version").get()?.user_version || 0);
    const migrationVersion = Number(database.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM agent_schema_migrations").get()?.version || 0);
    if (quickCheck !== "ok" || actualVersion !== sourceVersion || migrationVersion !== sourceVersion) {
      fail("execution-store migration fixture downgrade failed integrity checks");
    }
  } catch (error) {
    if (transactionOpen) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // Preserve the fixture construction failure.
      }
    }
    throw error;
  } finally {
    database.close();
  }
}
