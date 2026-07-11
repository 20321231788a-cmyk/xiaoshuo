import type {
  AgentArtifactRef,
  AgentConfirmation,
  AgentExecutionStep,
  AgentRunDeleteResponse,
  AgentRunEvent,
  AgentRunExport,
  AgentRunState,
  AgentRunStatus,
  AgentStepStatus
} from "@xiaoshuo/shared";
import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync, statfsSync, statSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  AcquireWriteLeaseInput,
  ClaimStaleRunInput,
  CompleteControlOperationInput,
  ExecutionCasResult,
  ExecutionCommitJournalEntry,
  ExecutionControlOperation,
  ExecutionDatabase,
  ExecutionDatabaseAdapter,
  ExecutionDatabaseOpenOptions,
  ExecutionDatabaseStatement,
  ExecutionEventListOptions,
  ExecutionRunEventInput,
  ExecutionRunListOptions,
  AgentOutboundDisclosure,
  ExecutionRuntimeInstance,
  ExecutionSqlValue,
  ExecutionStepAttempt,
  ExecutionStoreMigrationRecord,
  ExecutionStoreFileSystem,
  ExecutionStorePort,
  ExecutionWriteLease,
  FinishAttemptInput,
  HeartbeatRunLeaseInput,
  HeartbeatRuntimeInstanceInput,
  RegisterRuntimeInstanceInput,
  ReleaseRuntimeInstanceInput,
  ReleaseWriteLeaseInput,
  RenewWriteLeaseInput,
  ReplaceRunStepsInput,
  ResolveConfirmationInput,
  StartAttemptInput,
  StoredAgentArtifact,
  StoredAgentConfirmation,
  StoredAgentExecutionStep,
  StoredAgentObservation,
  StoredAgentRunEvent,
  UpdateCommitJournalInput,
  UpdateRunStatusInput
} from "./execution-store-port.js";

export * from "./execution-store-port.js";

export const EXECUTION_STORE_RELATIVE_PATH = path.join("00_设定集", ".agent", "agent_runs.sqlite3");
export const CURRENT_EXECUTION_STORE_SCHEMA_VERSION = 2;
export const EXECUTION_STORE_BUSY_TIMEOUT_MS = 5_000;

const MIGRATION_ONE_SQL = `
CREATE TABLE agent_schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL,
  execution_ms INTEGER NOT NULL,
  min_reader_version INTEGER NOT NULL,
  min_writer_version INTEGER NOT NULL,
  rollback_notes TEXT NOT NULL
);

CREATE TABLE agent_runs (
  run_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL DEFAULT '',
  conversation_id TEXT NOT NULL DEFAULT '',
  project_id TEXT NOT NULL DEFAULT '',
  project_path TEXT NOT NULL DEFAULT '',
  schema_version INTEGER NOT NULL,
  version INTEGER NOT NULL,
  goal_json TEXT NOT NULL,
  goal_revision INTEGER NOT NULL DEFAULT 1,
  plan_version INTEGER NOT NULL DEFAULT 1,
  plan_status TEXT NOT NULL DEFAULT 'draft',
  status TEXT NOT NULL,
  current_step_id TEXT NOT NULL DEFAULT '',
  runtime_instance_id TEXT NOT NULL DEFAULT '',
  heartbeat_at TEXT NOT NULL DEFAULT '',
  lease_expires_at TEXT NOT NULL DEFAULT '',
  pause_requested_at TEXT NOT NULL DEFAULT '',
  cancel_requested_at TEXT NOT NULL DEFAULT '',
  recovery_reason TEXT NOT NULL DEFAULT '',
  error_code TEXT NOT NULL DEFAULT '',
  error TEXT NOT NULL DEFAULT '',
  budget_json TEXT NOT NULL,
  last_event_sequence INTEGER NOT NULL DEFAULT 0,
  state_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_agent_runs_request_id
  ON agent_runs (project_id, request_id) WHERE request_id <> '';
CREATE INDEX idx_agent_runs_status_updated
  ON agent_runs (status, updated_at DESC, run_id DESC);
CREATE INDEX idx_agent_runs_runtime_lease
  ON agent_runs (runtime_instance_id, lease_expires_at);

CREATE TABLE agent_steps (
  run_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  plan_version INTEGER NOT NULL DEFAULT 1,
  version INTEGER NOT NULL,
  step_index INTEGER NOT NULL,
  type TEXT NOT NULL,
  action_id TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  idempotency_key TEXT NOT NULL,
  observation_id TEXT NOT NULL DEFAULT '',
  error_code TEXT NOT NULL DEFAULT '',
  error TEXT NOT NULL DEFAULT '',
  started_at TEXT NOT NULL DEFAULT '',
  ended_at TEXT NOT NULL DEFAULT '',
  step_json TEXT NOT NULL,
  PRIMARY KEY (run_id, step_id),
  FOREIGN KEY (run_id) REFERENCES agent_runs(run_id) ON DELETE CASCADE
);
CREATE INDEX idx_agent_steps_run_order
  ON agent_steps (run_id, step_index, step_id);
CREATE UNIQUE INDEX idx_agent_steps_idempotency
  ON agent_steps (run_id, idempotency_key) WHERE idempotency_key <> '';

CREATE TABLE agent_step_attempts (
  attempt_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  version INTEGER NOT NULL,
  status TEXT NOT NULL,
  input_digest TEXT NOT NULL,
  observation_id TEXT NOT NULL DEFAULT '',
  idempotency_key TEXT NOT NULL,
  model_call_refs_json TEXT NOT NULL,
  error_code TEXT NOT NULL DEFAULT '',
  error TEXT NOT NULL DEFAULT '',
  started_at TEXT NOT NULL,
  ended_at TEXT NOT NULL DEFAULT '',
  UNIQUE (run_id, step_id, attempt),
  UNIQUE (run_id, idempotency_key),
  FOREIGN KEY (run_id, step_id) REFERENCES agent_steps(run_id, step_id) ON DELETE CASCADE
);
CREATE INDEX idx_agent_attempts_step
  ON agent_step_attempts (run_id, step_id, attempt);

CREATE TABLE agent_observations (
  observation_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  ok INTEGER NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  observation_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (attempt_id) REFERENCES agent_step_attempts(attempt_id) ON DELETE CASCADE,
  FOREIGN KEY (run_id, step_id) REFERENCES agent_steps(run_id, step_id) ON DELETE CASCADE
);
CREATE INDEX idx_agent_observations_step
  ON agent_observations (run_id, step_id, created_at);

CREATE TABLE agent_artifacts (
  artifact_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  path TEXT NOT NULL DEFAULT '',
  cache_id TEXT NOT NULL DEFAULT '',
  content_hash TEXT NOT NULL DEFAULT '',
  document_version INTEGER NOT NULL DEFAULT 0,
  chars INTEGER NOT NULL DEFAULT 0,
  created_by_step_id TEXT NOT NULL DEFAULT '',
  created_by_attempt_id TEXT NOT NULL DEFAULT '',
  artifact_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT '',
  FOREIGN KEY (run_id) REFERENCES agent_runs(run_id) ON DELETE CASCADE
);
CREATE INDEX idx_agent_artifacts_run
  ON agent_artifacts (run_id, artifact_id);

CREATE TABLE agent_confirmations (
  confirmation_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  action TEXT NOT NULL,
  risk_level TEXT NOT NULL,
  status TEXT NOT NULL,
  expires_at TEXT NOT NULL DEFAULT '',
  resolved_at TEXT NOT NULL DEFAULT '',
  resolved_by TEXT NOT NULL DEFAULT '',
  confirmation_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT '',
  FOREIGN KEY (run_id) REFERENCES agent_runs(run_id) ON DELETE CASCADE
);
CREATE INDEX idx_agent_confirmations_pending
  ON agent_confirmations (run_id, status, expires_at);

CREATE TABLE agent_run_events (
  event_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  step_id TEXT NOT NULL DEFAULT '',
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  published_at TEXT NOT NULL DEFAULT '',
  UNIQUE (run_id, sequence),
  FOREIGN KEY (run_id) REFERENCES agent_runs(run_id) ON DELETE CASCADE
);
CREATE INDEX idx_agent_run_events_replay
  ON agent_run_events (run_id, sequence);
CREATE INDEX idx_agent_run_events_outbox
  ON agent_run_events (published_at, created_at) WHERE published_at = '';

CREATE TABLE agent_write_leases (
  target_path TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  run_id TEXT NOT NULL DEFAULT '',
  step_id TEXT NOT NULL DEFAULT '',
  attempt_id TEXT NOT NULL DEFAULT '',
  fencing_token INTEGER NOT NULL,
  version INTEGER NOT NULL,
  acquired_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  released_at TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_agent_write_leases_expiry
  ON agent_write_leases (expires_at, released_at);

CREATE TABLE agent_control_operations (
  operation_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  step_id TEXT NOT NULL DEFAULT '',
  confirmation_id TEXT NOT NULL DEFAULT '',
  operation_type TEXT NOT NULL,
  expected_version INTEGER NOT NULL,
  version INTEGER NOT NULL,
  status TEXT NOT NULL,
  result_json TEXT NOT NULL,
  error_code TEXT NOT NULL DEFAULT '',
  error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  completed_at TEXT NOT NULL DEFAULT '',
  FOREIGN KEY (run_id) REFERENCES agent_runs(run_id) ON DELETE CASCADE
);
CREATE INDEX idx_agent_control_operations_run
  ON agent_control_operations (run_id, created_at);

CREATE TABLE agent_commit_journal (
  journal_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target_path TEXT NOT NULL,
  base_hash TEXT NOT NULL DEFAULT '',
  new_hash TEXT NOT NULL,
  temp_path TEXT NOT NULL,
  backup_path TEXT NOT NULL DEFAULT '',
  document_version INTEGER NOT NULL,
  timeline_ref TEXT NOT NULL DEFAULT '',
  idempotency_key TEXT NOT NULL UNIQUE,
  fencing_token INTEGER NOT NULL,
  stage TEXT NOT NULL,
  version INTEGER NOT NULL,
  manifest_json TEXT NOT NULL,
  error_code TEXT NOT NULL DEFAULT '',
  error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finalized_at TEXT NOT NULL DEFAULT '',
  FOREIGN KEY (run_id) REFERENCES agent_runs(run_id) ON DELETE CASCADE
);
CREATE INDEX idx_agent_commit_journal_open
  ON agent_commit_journal (stage, updated_at) WHERE stage <> 'finalized';

CREATE TABLE agent_runtime_instances (
  runtime_instance_id TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL,
  lease_expires_at TEXT NOT NULL,
  released_at TEXT NOT NULL DEFAULT '',
  metadata_json TEXT NOT NULL
);
CREATE INDEX idx_agent_runtime_instances_lease
  ON agent_runtime_instances (status, lease_expires_at);

CREATE TABLE agent_outbound_disclosures (
  disclosure_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  purpose TEXT NOT NULL,
  data_classes TEXT NOT NULL,
  content_digest TEXT NOT NULL,
  redacted_summary TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  consent_receipt_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (run_id) REFERENCES agent_runs(run_id) ON DELETE CASCADE
);
CREATE INDEX idx_agent_outbound_disclosures_run
  ON agent_outbound_disclosures (run_id);
`;

const MIGRATION_TWO_SQL = `
CREATE TABLE agent_artifact_feedback (
  feedback_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  action TEXT NOT NULL,
  task_type TEXT NOT NULL,
  diff_digest TEXT NOT NULL DEFAULT '',
  evidence_refs TEXT NOT NULL DEFAULT '[]',
  rubric_versions TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  FOREIGN KEY (run_id) REFERENCES agent_runs(run_id) ON DELETE CASCADE
);

CREATE TABLE preference_candidates (
  candidate_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL DEFAULT '',
  scope TEXT NOT NULL,
  target TEXT NOT NULL,
  key TEXT NOT NULL,
  proposed_value TEXT NOT NULL,
  evidence_feedback_ids TEXT NOT NULL DEFAULT '[]',
  counterexample_feedback_ids TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  resolved_by TEXT,
  resolved_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE preference_versions (
  preference_version TEXT PRIMARY KEY,
  parent_version TEXT,
  scope TEXT NOT NULL,
  applied_candidate_ids TEXT NOT NULL DEFAULT '[]',
  rubric_versions TEXT NOT NULL DEFAULT '{}',
  router_version TEXT NOT NULL DEFAULT '',
  eval_manifest_ref TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

export type ExecutionStoreMigration = {
  version: number;
  name: string;
  checksum: string;
  minReaderVersion: number;
  minWriterVersion: number;
  rollbackNotes: string;
  sql: string;
};

export const EXECUTION_STORE_MIGRATIONS: readonly ExecutionStoreMigration[] = Object.freeze([
  Object.freeze({
    version: 1,
    name: "p0_execution_store",
    checksum: createHash("sha256").update(MIGRATION_ONE_SQL, "utf8").digest("hex"),
    minReaderVersion: 1,
    minWriterVersion: 1,
    rollbackNotes: "Restore the pre-migration project-local database backup.",
    sql: MIGRATION_ONE_SQL
  }),
  Object.freeze({
    version: 2,
    name: "p5_feedback_store",
    checksum: createHash("sha256").update(MIGRATION_TWO_SQL, "utf8").digest("hex"),
    minReaderVersion: 2,
    minWriterVersion: 2,
    rollbackNotes: "Restore the pre-migration project-local database backup.",
    sql: MIGRATION_TWO_SQL
  })
]);

export type ExecutionStoreOpenOptions = {
  adapter?: ExecutionDatabaseAdapter;
  fileSystem?: ExecutionStoreFileSystem;
  now?: () => Date;
  backupBeforeMigration?: boolean;
};

export class UnsupportedExecutionStoreSchemaError extends Error {
  readonly foundVersion: number;
  readonly supportedVersion: number;
  readonly databasePath: string;

  constructor(foundVersion: number, supportedVersion: number, databasePath: string) {
    super(`Execution store schema ${foundVersion} is newer than supported schema ${supportedVersion}; writes are disabled`);
    this.name = "UnsupportedExecutionStoreSchemaError";
    this.foundVersion = foundVersion;
    this.supportedVersion = supportedVersion;
    this.databasePath = databasePath;
  }
}

export class ExecutionStoreClosedError extends Error {
  constructor() {
    super("Execution store is closed");
    this.name = "ExecutionStoreClosedError";
  }
}

export class ExecutionStoreIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExecutionStoreIntegrityError";
  }
}

class NodeSqliteStatement implements ExecutionDatabaseStatement {
  constructor(private readonly statement: ReturnType<DatabaseSync["prepare"]>) {}

  run(...parameters: ExecutionSqlValue[]) {
    return this.statement.run(...parameters);
  }

  get(...parameters: ExecutionSqlValue[]): unknown {
    return this.statement.get(...parameters);
  }

  all(...parameters: ExecutionSqlValue[]): unknown[] {
    return this.statement.all(...parameters);
  }
}

class NodeSqliteExecutionDatabase implements ExecutionDatabase {
  constructor(private readonly database: DatabaseSync) {}

  exec(source: string): void {
    this.database.exec(source);
  }

  prepare(source: string): ExecutionDatabaseStatement {
    return new NodeSqliteStatement(this.database.prepare(source));
  }

  close(): void {
    this.database.close();
  }
}

export class NodeSqliteExecutionDatabaseAdapter implements ExecutionDatabaseAdapter {
  open(filename: string, options: ExecutionDatabaseOpenOptions = {}): ExecutionDatabase {
    return new NodeSqliteExecutionDatabase(new DatabaseSync(filename, { readOnly: options.readOnly ?? false }));
  }
}

export function resolveExecutionStorePath(projectRoot: string): string {
  const trimmedRoot = projectRoot.trim();
  if (!trimmedRoot) {
    throw new Error("Execution store project root must not be empty");
  }
  return path.join(path.resolve(trimmedRoot), EXECUTION_STORE_RELATIVE_PATH);
}

export function openExecutionStore(projectRoot: string, options?: ExecutionStoreOpenOptions): ExecutionStore {
  return ExecutionStore.open(projectRoot, options);
}

const nodeExecutionStoreFileSystem: ExecutionStoreFileSystem = {
  mkdir(directory): void {
    mkdirSync(directory, { recursive: true });
  },
  exists(filename): boolean {
    return existsSync(filename);
  },
  fileSize(filename): number {
    return statSync(filename).size;
  },
  availableBytes(directory): number {
    const disk = statfsSync(directory);
    return Number(disk.bavail) * Number(disk.bsize);
  },
  copy(source, destination): void {
    copyFileSync(source, destination);
  },
  rename(source, destination): void {
    renameSync(source, destination);
  },
  remove(filename): void {
    rmSync(filename, { force: true });
  }
};

type SqlRow = Record<string, unknown>;
type MutableRecord = Record<string, unknown>;

export class ExecutionStore implements ExecutionStorePort {
  readonly projectRoot: string;
  readonly databasePath: string;
  readonly schemaVersion: number;
  readonly isReadOnly: boolean;

  private closed = false;

  private constructor(
    projectRoot: string,
    databasePath: string,
    private readonly database: ExecutionDatabase,
    schemaVersion: number,
    readOnly: boolean,
    private readonly now: () => Date
  ) {
    this.projectRoot = projectRoot;
    this.databasePath = databasePath;
    this.schemaVersion = schemaVersion;
    this.isReadOnly = readOnly;
  }

  static open(projectRoot: string, options: ExecutionStoreOpenOptions = {}): ExecutionStore {
    const resolvedProjectRoot = path.resolve(projectRoot);
    const databasePath = resolveExecutionStorePath(resolvedProjectRoot);
    const adapter = options.adapter ?? new NodeSqliteExecutionDatabaseAdapter();
    const fileSystem = options.fileSystem ?? nodeExecutionStoreFileSystem;
    const now = options.now ?? (() => new Date());

    fileSystem.mkdir(path.dirname(databasePath));
    // An existing database is inspected through a query-only connection first.
    // This keeps an unknown future schema isolated from this binary's write path.
    const existingDatabase = fileSystem.exists(databasePath);
    let database: ExecutionDatabase | undefined;
    try {
      database = adapter.open(databasePath, existingDatabase ? { readOnly: true } : undefined);
      configureConnection(database, existingDatabase);
      const foundVersion = readDatabaseSchemaVersion(database);

      if (foundVersion > CURRENT_EXECUTION_STORE_SCHEMA_VERSION) {
        return new ExecutionStore(resolvedProjectRoot, databasePath, database, foundVersion, true, now);
      }

      if (existingDatabase) {
        database.close();
        database = undefined;
        database = adapter.open(databasePath);
        configureConnection(database, false);
      }

      configureWritableConnection(database);
      applyMigrations(
        database,
        databasePath,
        adapter,
        fileSystem,
        foundVersion,
        now,
        options.backupBeforeMigration ?? true
      );
      verifyMigrationRegistry(database);
      return new ExecutionStore(
        resolvedProjectRoot,
        databasePath,
        database,
        CURRENT_EXECUTION_STORE_SCHEMA_VERSION,
        false,
        now
      );
    } catch (error) {
      try {
        database?.close();
      } catch {
        // Preserve the opening or migration failure.
      }
      throw error;
    }
  }

  close(): void {
    if (this.closed) {
      return;
    }
    if (!this.isReadOnly) {
      this.database.exec("PRAGMA wal_checkpoint(PASSIVE)");
    }
    this.database.close();
    this.closed = true;
  }

  getDatabase(): ExecutionDatabase {
    return this.database;
  }

  getAppliedMigrations(): ExecutionStoreMigrationRecord[] {
    this.assertOpen();
    if (!tableExists(this.database, "agent_schema_migrations")) {
      return [];
    }
    return rows(
      this.database
        .prepare(`SELECT version, name, checksum, applied_at, execution_ms, min_reader_version, min_writer_version,
                         rollback_notes
                    FROM agent_schema_migrations
                   ORDER BY version`)
        .all()
    ).map(mapMigrationRow);
  }

  quickCheck(): string {
    this.assertOpen();
    const result = row(this.database.prepare("PRAGMA quick_check").get());
    return result ? stringValue(result.quick_check, "") : "";
  }

  checkpoint(mode: "PASSIVE" | "FULL" | "RESTART" | "TRUNCATE" = "PASSIVE"): void {
    this.assertWritable();
    this.database.exec(`PRAGMA wal_checkpoint(${mode})`);
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new ExecutionStoreClosedError();
    }
  }

  private assertWritable(): void {
    this.assertOpen();
    if (this.isReadOnly) {
      throw new UnsupportedExecutionStoreSchemaError(
        this.schemaVersion,
        CURRENT_EXECUTION_STORE_SCHEMA_VERSION,
        this.databasePath
      );
    }
  }

  private timestamp(value?: string): string {
    return value || this.now().toISOString();
  }

  private transaction<Value>(work: () => Value): Value {
    this.assertWritable();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const value = work();
      this.database.exec("COMMIT");
      return value;
    } catch (error) {
      try {
        this.database.exec("ROLLBACK");
      } catch {
        // Preserve the original transaction error.
      }
      throw error;
    }
  }

  createRun(runState: AgentRunState, event?: ExecutionRunEventInput): AgentRunState {
    this.assertWritable();
    const source = asRecord(runState);
    const runId = requiredString(source.run_id, "run_id");
    const requestId = stringValue(source.request_id);
    const projectId = stringValue(source.project_id);

    return this.transaction(() => {
      if (requestId) {
        const replay = this.getRunByRequestId(requestId, projectId);
        if (replay) {
          return replay;
        }
      }
      const existing = this.getRun(runId);
      if (existing) {
        return existing;
      }

      const version = positiveVersion(source.version);
      const schemaVersion = positiveVersion(source.schema_version);
      const createdAt = this.timestamp(stringValue(source.created_at));
      const updatedAt = this.timestamp(stringValue(source.updated_at) || createdAt);
      const state: MutableRecord = {
        ...source,
        run_id: runId,
        schema_version: schemaVersion,
        version,
        last_event_sequence: nonNegativeInteger(source.last_event_sequence),
        created_at: createdAt,
        updated_at: updatedAt
      };
      const steps = Array.isArray(source.steps) ? (source.steps as AgentExecutionStep[]) : [];
      const artifacts = Array.isArray(source.artifacts) ? (source.artifacts as AgentArtifactRef[]) : [];

      this.database
        .prepare(`INSERT INTO agent_runs (
                    run_id, request_id, conversation_id, project_id, project_path, schema_version, version,
                    goal_json, goal_revision, plan_version, plan_status, status, current_step_id,
                    runtime_instance_id, heartbeat_at, lease_expires_at, pause_requested_at, cancel_requested_at,
                    recovery_reason, error_code, error, budget_json, last_event_sequence, state_json, created_at,
                    updated_at
                  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          runId,
          requestId,
          stringValue(source.conversation_id),
          projectId,
          stringValue(source.project_path),
          schemaVersion,
          version,
          json(source.goal ?? {}),
          positiveVersion(source.goal_revision),
          positiveVersion(source.plan_version),
          stringValue(source.plan_status, "draft"),
          requiredString(source.status, "status"),
          stringValue(source.current_step_id),
          stringValue(source.runtime_instance_id),
          stringValue(source.heartbeat_at),
          stringValue(source.lease_expires_at),
          stringValue(source.pause_requested_at),
          stringValue(source.cancel_requested_at),
          stringValue(source.recovery_reason),
          stringValue(source.error_code),
          stringValue(source.error),
          json(source.budget ?? {}),
          nonNegativeInteger(source.last_event_sequence),
          json(state),
          createdAt,
          updatedAt
        );

      const planVersion = positiveVersion(source.plan_version);
      for (const step of steps) {
        this.insertStepRow(runId, step, planVersion);
      }
      for (const artifact of artifacts) {
        this.insertArtifactRow(runId, artifact);
      }

      if (event) {
        this.appendEventToStoredRun(runId, event, false);
      }
      return this.requireRun(runId);
    });
  }

  getRun(runId: string): AgentRunState | null {
    this.assertOpen();
    const source = row(this.database.prepare("SELECT * FROM agent_runs WHERE run_id = ?").get(runId));
    return source ? this.mapRunRow(source) : null;
  }

  getRunByRequestId(requestId: string, projectId = ""): AgentRunState | null {
    this.assertOpen();
    const source = projectId
      ? row(
          this.database
            .prepare("SELECT * FROM agent_runs WHERE project_id = ? AND request_id = ? LIMIT 1")
            .get(projectId, requestId)
        )
      : row(this.database.prepare("SELECT * FROM agent_runs WHERE request_id = ? LIMIT 1").get(requestId));
    return source ? this.mapRunRow(source) : null;
  }

  listRuns(options: ExecutionRunListOptions = {}): AgentRunState[] {
    this.assertOpen();
    const clauses: string[] = [];
    const parameters: ExecutionSqlValue[] = [];
    if (options.project_id) {
      clauses.push("project_id = ?");
      parameters.push(options.project_id);
    }
    if (options.statuses && options.statuses.length > 0) {
      clauses.push(`status IN (${options.statuses.map(() => "?").join(", ")})`);
      parameters.push(...options.statuses);
    }
    if (options.before_updated_at) {
      clauses.push("updated_at < ?");
      parameters.push(options.before_updated_at);
    }
    const limit = boundedLimit(options.limit, 100, 500);
    parameters.push(limit);
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    return rows(
      this.database
        .prepare(`SELECT * FROM agent_runs ${where} ORDER BY updated_at DESC, run_id DESC LIMIT ?`)
        .all(...parameters)
    ).map((source) => this.mapRunRow(source));
  }

  exportRun(runId: string): AgentRunExport {
    const run = this.requireRun(runId);
    return {
      format_version: 1,
      exported_at: this.timestamp(),
      project_id: run.project_id,
      project_path: run.project_path,
      run,
      steps: this.listAllSteps(runId),
      attempts: this.listAttempts(runId),
      observations: this.listObservations(runId),
      artifacts: this.listArtifacts(runId),
      confirmations: this.listConfirmations(runId),
      events: this.listAllEventsForExport(runId),
      control_operations: this.listControlOperations(runId),
      commit_journal: this.listCommitJournal(runId)
    };
  }

  deleteRun(runId: string): AgentRunDeleteResponse {
    return this.transaction(() => {
      const exported = this.exportRun(runId);
      const { run } = exported;
      if (!isTerminalRunStatus(run.status)) {
        throw codedError("RUN_NOT_TERMINAL", `Agent run ${runId} must be terminal before deletion`);
      }
      if (exported.commit_journal.some((entry) => entry.stage !== "finalized")) {
        throw codedError("RUN_JOURNAL_PENDING", `Agent run ${runId} has unfinished commit journal entries`);
      }

      const deletedWriteLeases = changes(
        this.database
          .prepare("DELETE FROM agent_write_leases WHERE run_id = ? AND (released_at <> '' OR expires_at <= ?)")
          .run(runId, this.timestamp())
      );
      const deleted = changes(this.database.prepare("DELETE FROM agent_runs WHERE run_id = ?").run(runId));
      if (deleted !== 1) {
        throw codedError("RUN_NOT_FOUND", `Execution run not found: ${runId}`);
      }
      return {
        run_id: run.run_id,
        project_id: run.project_id,
        deleted_at: this.timestamp(),
        deleted_records: {
          run: 1,
          steps: exported.steps.length,
          attempts: exported.attempts.length,
          observations: exported.observations.length,
          artifacts: exported.artifacts.length,
          confirmations: exported.confirmations.length,
          events: exported.events.length,
          control_operations: exported.control_operations.length,
          commit_journal: exported.commit_journal.length,
          write_leases: deletedWriteLeases
        },
        preserved_artifacts: exported.artifacts
      };
    });
  }

  updateRunStatus(input: UpdateRunStatusInput): ExecutionCasResult<AgentRunState> {
    return this.transaction(() => {
      const current = this.getRun(input.run_id);
      if (!current) {
        return casMiss<AgentRunState>(null);
      }
      const source = asRecord(current);
      const currentVersion = positiveVersion(source.version);
      const currentStatus = stringValue(source.status) as AgentRunStatus;
      if (currentVersion !== input.expected_version || !matchesExpectedStatus(currentStatus, input.expected_status)) {
        return casMiss(current);
      }

      const next: MutableRecord = {
        ...source,
        status: input.status,
        version: currentVersion + 1,
        updated_at: this.timestamp(input.updated_at)
      };
      assignDefined(next, "conversation_id", input.conversation_id);
      assignDefined(next, "runtime_instance_id", input.runtime_instance_id);
      assignDefined(next, "heartbeat_at", input.heartbeat_at);
      assignDefined(next, "lease_expires_at", input.lease_expires_at);
      assignDefined(next, "pause_requested_at", input.pause_requested_at);
      assignDefined(next, "cancel_requested_at", input.cancel_requested_at);
      assignDefined(next, "recovery_reason", input.recovery_reason);
      assignDefined(next, "error_code", input.error_code);
      assignDefined(next, "error", input.error);

      const preparedEvent = input.event ? this.prepareEvent(input.run_id, input.event, next) : null;
      if (!this.persistRunRecord(next, currentVersion)) {
        return casMiss(this.getRun(input.run_id));
      }
      if (preparedEvent) {
        this.insertEventRow(preparedEvent);
      }
      return casApplied(this.requireRun(input.run_id));
    });
  }

  heartbeatRunLease(input: HeartbeatRunLeaseInput): boolean {
    this.assertWritable();
    const heartbeatAt = this.timestamp(input.heartbeat_at);
    assertTimestampOrder(heartbeatAt, input.lease_expires_at, "run lease");
    const result = this.database
      .prepare(`UPDATE agent_runs
                   SET heartbeat_at = ?, lease_expires_at = ?
                 WHERE run_id = ? AND runtime_instance_id = ?
                   AND status IN ('planning', 'running', 'waiting_user_input', 'waiting_confirmation', 'cancelling')`)
      .run(heartbeatAt, input.lease_expires_at, input.run_id, input.runtime_instance_id);
    return changes(result) === 1;
  }

  replaceSteps(input: ReplaceRunStepsInput): ExecutionCasResult<AgentRunState> {
    return this.transaction(() => {
      const current = this.getRun(input.run_id);
      if (!current) {
        return casMiss<AgentRunState>(null);
      }
      const source = asRecord(current);
      const currentVersion = positiveVersion(source.version);
      if (currentVersion !== input.expected_run_version) {
        return casMiss(current);
      }

      const currentPlanVersion = positiveVersion(source.plan_version);
      const planVersion = input.plan_version ?? currentPlanVersion;
      const nextStepIds = new Set(input.steps.map((step) => step.step_id));
      for (const previous of this.listStepsForPlan(input.run_id, currentPlanVersion)) {
        if (nextStepIds.has(previous.step_id)) {
          continue;
        }
        const attemptCount = this.countAttempts(input.run_id, previous.step_id);
        if (planVersion === currentPlanVersion && attemptCount > 0) {
          throw new ExecutionStoreIntegrityError(
            `Cannot remove executed step ${previous.step_id} without creating a new plan version`
          );
        }
        if (attemptCount === 0) {
          this.database
            .prepare("DELETE FROM agent_steps WHERE run_id = ? AND step_id = ?")
            .run(input.run_id, previous.step_id);
        }
      }
      for (const step of input.steps) {
        const existing = this.getStep(input.run_id, step.step_id);
        if (existing && existing.plan_version !== planVersion && this.countAttempts(input.run_id, step.step_id) > 0) {
          throw new ExecutionStoreIntegrityError(
            `Replanned step_id ${step.step_id} has execution history; use a new step_id`
          );
        }
        this.upsertStepRow(
          input.run_id,
          { ...step, version: existing ? existing.version + 1 : positiveVersion(asRecord(step).version), plan_version: planVersion },
          planVersion
        );
      }
      const next: MutableRecord = {
        ...source,
        steps: input.steps,
        plan_version: planVersion,
        version: currentVersion + 1,
        updated_at: this.timestamp(input.updated_at)
      };
      const preparedEvent = input.event ? this.prepareEvent(input.run_id, input.event, next) : null;
      if (!this.persistRunRecord(next, currentVersion)) {
        return casMiss(this.getRun(input.run_id));
      }
      if (preparedEvent) {
        this.insertEventRow(preparedEvent);
      }
      return casApplied(this.requireRun(input.run_id));
    });
  }

  upsertStep(
    runId: string,
    step: AgentExecutionStep,
    expectedVersion?: number
  ): ExecutionCasResult<StoredAgentExecutionStep> {
    return this.transaction(() => {
      const run = this.getRun(runId);
      if (!run) {
        throw new Error(`Execution run not found: ${runId}`);
      }
      const stepRecord = asRecord(step);
      const stepId = requiredString(stepRecord.step_id, "step_id");
      const current = this.getStep(runId, stepId);
      if (current) {
        if (expectedVersion !== undefined && current.version !== expectedVersion) {
          return casMiss(current);
        }
      } else if (expectedVersion !== undefined && expectedVersion !== 0) {
        return casMiss<StoredAgentExecutionStep>(null);
      }

      const nextVersion = current ? current.version + 1 : positiveVersion(stepRecord.version);
      const next = { ...stepRecord, version: nextVersion } as unknown as StoredAgentExecutionStep;
      const planVersion = stepRecord.plan_version === undefined
        ? positiveVersion(asRecord(run).plan_version)
        : positiveVersion(stepRecord.plan_version);
      this.upsertStepRow(runId, next, planVersion);
      return casApplied(this.requireStep(runId, stepId));
    });
  }

  getStep(runId: string, stepId: string): StoredAgentExecutionStep | null {
    this.assertOpen();
    const source = row(
      this.database.prepare("SELECT * FROM agent_steps WHERE run_id = ? AND step_id = ?").get(runId, stepId)
    );
    return source ? mapStepRow(source) : null;
  }

  listSteps(runId: string, planVersion?: number): StoredAgentExecutionStep[] {
    this.assertOpen();
    const selectedPlanVersion = planVersion ?? this.getRunPlanVersion(runId);
    return this.listStepsForPlan(runId, selectedPlanVersion);
  }

  listAllSteps(runId: string): StoredAgentExecutionStep[] {
    this.assertOpen();
    return rows(
      this.database
        .prepare("SELECT * FROM agent_steps WHERE run_id = ? ORDER BY step_index, step_id")
        .all(runId)
    ).map(mapStepRow);
  }

  appendEventInTransaction(runId: string, event: ExecutionRunEventInput): StoredAgentRunEvent {
    return this.transaction(() => this.appendEventToStoredRun(runId, event, true));
  }

  listEvents(runId: string, options: ExecutionEventListOptions = {}): StoredAgentRunEvent[] {
    this.assertOpen();
    const after = nonNegativeInteger(options.after);
    const limit = boundedLimit(options.limit, 200, 1_000);
    const unpublished = options.unpublished_only ? "AND published_at = ''" : "";
    return rows(
      this.database
        .prepare(`SELECT * FROM agent_run_events
                   WHERE run_id = ? AND sequence > ? ${unpublished}
                   ORDER BY sequence
                   LIMIT ?`)
        .all(runId, after, limit)
    ).map(mapEventRow);
  }

  markEventsPublished(eventIds: readonly string[], publishedAt?: string): number {
    if (eventIds.length === 0) {
      return 0;
    }
    return this.transaction(() => {
      const placeholders = eventIds.map(() => "?").join(", ");
      const result = this.database
        .prepare(`UPDATE agent_run_events SET published_at = ? WHERE event_id IN (${placeholders}) AND published_at = ''`)
        .run(this.timestamp(publishedAt), ...eventIds);
      return changes(result);
    });
  }

  private mapRunRow(source: SqlRow): AgentRunState {
    const stored = asRecord(parseJson(source.state_json, {}));
    const runId = stringValue(source.run_id);
    Object.assign(stored, {
      run_id: runId,
      request_id: stringValue(source.request_id),
      conversation_id: stringValue(source.conversation_id),
      project_id: stringValue(source.project_id),
      project_path: stringValue(source.project_path),
      schema_version: positiveVersion(source.schema_version),
      version: positiveVersion(source.version),
      goal: parseJson(source.goal_json, {}),
      goal_revision: positiveVersion(source.goal_revision),
      plan_version: positiveVersion(source.plan_version),
      plan_status: stringValue(source.plan_status, "draft"),
      status: stringValue(source.status),
      current_step_id: stringValue(source.current_step_id),
      runtime_instance_id: stringValue(source.runtime_instance_id),
      heartbeat_at: stringValue(source.heartbeat_at),
      lease_expires_at: stringValue(source.lease_expires_at),
      pause_requested_at: stringValue(source.pause_requested_at),
      cancel_requested_at: stringValue(source.cancel_requested_at),
      recovery_reason: stringValue(source.recovery_reason),
      error_code: stringValue(source.error_code),
      error: stringValue(source.error),
      budget: parseJson(source.budget_json, {}),
      last_event_sequence: nonNegativeInteger(source.last_event_sequence),
      created_at: stringValue(source.created_at),
      updated_at: stringValue(source.updated_at),
      steps: this.listStepsForPlan(runId, positiveVersion(source.plan_version)),
      artifacts: this.listArtifacts(runId)
    });
    return stored as unknown as AgentRunState;
  }

  private persistRunRecord(run: MutableRecord, expectedVersion: number): boolean {
    const result = this.database
      .prepare(`UPDATE agent_runs
                   SET request_id = ?, conversation_id = ?, project_id = ?, project_path = ?, schema_version = ?,
                       version = ?, goal_json = ?, goal_revision = ?, plan_version = ?, plan_status = ?, status = ?,
                       current_step_id = ?, runtime_instance_id = ?, heartbeat_at = ?, lease_expires_at = ?,
                       pause_requested_at = ?, cancel_requested_at = ?, recovery_reason = ?, error_code = ?, error = ?,
                       budget_json = ?, last_event_sequence = ?, state_json = ?, created_at = ?, updated_at = ?
                 WHERE run_id = ? AND version = ?`)
      .run(
        stringValue(run.request_id),
        stringValue(run.conversation_id),
        stringValue(run.project_id),
        stringValue(run.project_path),
        positiveVersion(run.schema_version),
        positiveVersion(run.version),
        json(run.goal ?? {}),
        positiveVersion(run.goal_revision),
        positiveVersion(run.plan_version),
        stringValue(run.plan_status, "draft"),
        requiredString(run.status, "status"),
        stringValue(run.current_step_id),
        stringValue(run.runtime_instance_id),
        stringValue(run.heartbeat_at),
        stringValue(run.lease_expires_at),
        stringValue(run.pause_requested_at),
        stringValue(run.cancel_requested_at),
        stringValue(run.recovery_reason),
        stringValue(run.error_code),
        stringValue(run.error),
        json(run.budget ?? {}),
        nonNegativeInteger(run.last_event_sequence),
        json(run),
        stringValue(run.created_at),
        stringValue(run.updated_at),
        requiredString(run.run_id, "run_id"),
        expectedVersion
      );
    return changes(result) === 1;
  }

  private prepareEvent(runId: string, input: ExecutionRunEventInput, run: MutableRecord): StoredAgentRunEvent {
    const eventId = input.event_id || randomUUID();
    const duplicate = this.getEvent(eventId);
    if (duplicate) {
      throw new ExecutionStoreIntegrityError(`Duplicate event_id: ${eventId}`);
    }
    const sequence = this.nextEventSequence(runId, nonNegativeInteger(run.last_event_sequence));
    run.last_event_sequence = sequence;
    return {
      event_id: eventId,
      run_id: runId,
      sequence,
      event_type: requiredString(input.event_type, "event_type"),
      step_id: input.step_id ?? "",
      payload: input.payload ?? {},
      created_at: this.timestamp(input.created_at),
      published_at: ""
    } as StoredAgentRunEvent;
  }

  private appendEventToStoredRun(
    runId: string,
    input: ExecutionRunEventInput,
    bumpRunVersion: boolean
  ): StoredAgentRunEvent {
    if (input.event_id) {
      const duplicate = this.getEvent(input.event_id);
      if (duplicate) {
        if (duplicate.run_id !== runId) {
          throw new ExecutionStoreIntegrityError(`event_id ${input.event_id} belongs to another run`);
        }
        return duplicate;
      }
    }
    const current = this.requireRun(runId);
    const run = asRecord(current);
    const currentVersion = positiveVersion(run.version);
    if (bumpRunVersion) {
      run.version = currentVersion + 1;
      run.updated_at = this.timestamp();
    }
    const event = this.prepareEvent(runId, input, run);
    if (!this.persistRunRecord(run, currentVersion)) {
      throw new ExecutionStoreIntegrityError(`Lost event sequence race for run ${runId}`);
    }
    this.insertEventRow(event);
    return event;
  }

  private insertEventRow(event: StoredAgentRunEvent): void {
    this.database
      .prepare(`INSERT INTO agent_run_events (
                  event_id, run_id, sequence, event_type, step_id, payload_json, created_at, published_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        event.event_id,
        event.run_id,
        event.sequence,
        event.event_type,
        event.step_id,
        json(event.payload),
        event.created_at,
        event.published_at ?? ""
      );
  }

  private getEvent(eventId: string): StoredAgentRunEvent | null {
    const source = row(this.database.prepare("SELECT * FROM agent_run_events WHERE event_id = ?").get(eventId));
    return source ? mapEventRow(source) : null;
  }

  private nextEventSequence(runId: string, recordedSequence: number): number {
    const source = row(
      this.database
        .prepare("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM agent_run_events WHERE run_id = ?")
        .get(runId)
    );
    return Math.max(recordedSequence, source ? nonNegativeInteger(source.sequence) : 0) + 1;
  }

  private insertStepRow(runId: string, step: AgentExecutionStep, planVersion: number): void {
    const source = asRecord(step);
    this.database
      .prepare(`INSERT INTO agent_steps (
                  run_id, step_id, plan_version, version, step_index, type, action_id, status, attempts,
                  idempotency_key, observation_id, error_code, error, started_at, ended_at, step_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(...stepRowParameters(runId, source, planVersion));
  }

  private upsertStepRow(runId: string, step: StoredAgentExecutionStep, planVersion: number): void {
    const source = asRecord(step);
    this.database
      .prepare(`INSERT INTO agent_steps (
                  run_id, step_id, plan_version, version, step_index, type, action_id, status, attempts,
                  idempotency_key, observation_id, error_code, error, started_at, ended_at, step_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(run_id, step_id) DO UPDATE SET
                  plan_version = excluded.plan_version,
                  version = excluded.version,
                  step_index = excluded.step_index,
                  type = excluded.type,
                  action_id = excluded.action_id,
                  status = excluded.status,
                  attempts = excluded.attempts,
                  idempotency_key = excluded.idempotency_key,
                  observation_id = excluded.observation_id,
                  error_code = excluded.error_code,
                  error = excluded.error,
                  started_at = excluded.started_at,
                  ended_at = excluded.ended_at,
                  step_json = excluded.step_json`)
      .run(...stepRowParameters(runId, source, planVersion));
  }

  startAttempt(input: StartAttemptInput): ExecutionStepAttempt {
    return this.transaction(() => {
      const duplicateById = this.getAttempt(input.attempt_id);
      if (duplicateById) {
        return duplicateById;
      }
      const duplicateByKey = this.getAttemptByIdempotencyKey(input.run_id, input.idempotency_key);
      if (duplicateByKey) {
        return duplicateByKey;
      }

      const step = this.requireStep(input.run_id, input.step_id);
      const stepSource = asRecord(step);
      const attemptNumber = input.attempt ?? this.nextAttemptNumber(input.run_id, input.step_id);
      if (!Number.isInteger(attemptNumber) || attemptNumber <= 0) {
        throw new Error("Step attempt number must be a positive integer");
      }
      const startedAt = this.timestamp(input.started_at);
      this.database
        .prepare(`INSERT INTO agent_step_attempts (
                    attempt_id, run_id, step_id, attempt, version, status, input_digest, observation_id,
                    idempotency_key, model_call_refs_json, error_code, error, started_at, ended_at
                  ) VALUES (?, ?, ?, ?, 1, 'running', ?, '', ?, ?, '', '', ?, '')`)
        .run(
          requiredString(input.attempt_id, "attempt_id"),
          input.run_id,
          input.step_id,
          attemptNumber,
          requiredString(input.input_digest, "input_digest"),
          requiredString(input.idempotency_key, "idempotency_key"),
          json(input.model_call_refs ?? []),
          startedAt
        );

      const currentStatus = stringValue(stepSource.status);
      if (currentStatus !== "pending" && currentStatus !== "running") {
        throw new Error(`Cannot start an attempt while step ${input.step_id} is ${currentStatus}`);
      }
      stepSource.attempts = Math.max(nonNegativeInteger(stepSource.attempts), attemptNumber);
      stepSource.status = "running";
      stepSource.observation_id = "";
      stepSource.error_code = "";
      stepSource.error = "";
      stepSource.started_at = startedAt;
      stepSource.ended_at = "";
      stepSource.version = step.version + 1;
      this.upsertStepRow(input.run_id, stepSource as unknown as StoredAgentExecutionStep, positiveVersion(stepSource.plan_version));
      return this.requireAttempt(input.attempt_id);
    });
  }

  finishAttempt(input: FinishAttemptInput): ExecutionCasResult<ExecutionStepAttempt> {
    return this.transaction(() => {
      const current = this.getAttempt(input.attempt_id);
      if (!current) {
        return casMiss<ExecutionStepAttempt>(null);
      }
      if (current.version !== input.expected_version) {
        return casMiss(current);
      }
      const endedAt = this.timestamp(input.ended_at);
      const result = this.database
        .prepare(`UPDATE agent_step_attempts
                     SET version = version + 1, status = ?, observation_id = ?, model_call_refs_json = ?,
                         error_code = ?, error = ?, ended_at = ?
                   WHERE attempt_id = ? AND version = ? AND status = 'running'`)
        .run(
          input.status,
          input.observation_id ?? current.observation_id,
          json(input.model_call_refs ?? current.model_call_refs),
          input.error_code ?? "",
          input.error ?? "",
          endedAt,
          input.attempt_id,
          input.expected_version
        );
      if (changes(result) !== 1) {
        return casMiss(this.getAttempt(input.attempt_id));
      }

      const step = this.requireStep(current.run_id, current.step_id);
      const stepSource = asRecord(step);
      stepSource.status = (input.step_status ?? input.status) as AgentStepStatus;
      stepSource.observation_id = input.observation_id ?? current.observation_id;
      stepSource.error_code = input.error_code ?? "";
      stepSource.error = input.error ?? "";
      stepSource.ended_at = endedAt;
      stepSource.version = step.version + 1;
      this.upsertStepRow(current.run_id, stepSource as unknown as StoredAgentExecutionStep, positiveVersion(stepSource.plan_version));
      return casApplied(this.requireAttempt(input.attempt_id));
    });
  }

  getAttempt(attemptId: string): ExecutionStepAttempt | null {
    this.assertOpen();
    const source = row(this.database.prepare("SELECT * FROM agent_step_attempts WHERE attempt_id = ?").get(attemptId));
    return source ? mapAttemptRow(source) : null;
  }

  listAttempts(runId: string, stepId?: string): ExecutionStepAttempt[] {
    this.assertOpen();
    const result = stepId
      ? this.database
          .prepare("SELECT * FROM agent_step_attempts WHERE run_id = ? AND step_id = ? ORDER BY attempt")
          .all(runId, stepId)
      : this.database
          .prepare("SELECT * FROM agent_step_attempts WHERE run_id = ? ORDER BY step_id, attempt")
          .all(runId);
    return rows(result).map(mapAttemptRow);
  }

  appendObservation(observation: StoredAgentObservation): StoredAgentObservation {
    return this.transaction(() => {
      const source = asRecord(observation);
      const observationId = requiredString(source.observation_id, "observation_id");
      const duplicate = this.getObservation(observationId);
      if (duplicate) {
        return duplicate;
      }
      const attemptId = requiredString(source.attempt_id, "attempt_id");
      const attempt = this.requireAttempt(attemptId);
      const runId = requiredString(source.run_id, "run_id");
      const stepId = requiredString(source.step_id, "step_id");
      if (attempt.run_id !== runId || attempt.step_id !== stepId) {
        throw new ExecutionStoreIntegrityError(`Observation ${observationId} does not match attempt ${attemptId}`);
      }
      const createdAt = this.timestamp(stringValue(source.created_at));
      this.database
        .prepare(`INSERT INTO agent_observations (
                    observation_id, run_id, step_id, attempt_id, ok, summary, observation_json, created_at
                  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          observationId,
          runId,
          stepId,
          attemptId,
          source.ok === true ? 1 : 0,
          stringValue(source.summary),
          json({ ...source, created_at: createdAt }),
          createdAt
        );

      this.database
        .prepare("UPDATE agent_step_attempts SET observation_id = ? WHERE attempt_id = ?")
        .run(observationId, attemptId);
      const step = this.requireStep(runId, stepId);
      const stepSource = asRecord(step);
      stepSource.observation_id = observationId;
      stepSource.version = step.version + 1;
      this.upsertStepRow(runId, stepSource as unknown as StoredAgentExecutionStep, positiveVersion(stepSource.plan_version));
      return this.requireObservation(observationId);
    });
  }

  getObservation(observationId: string): StoredAgentObservation | null {
    this.assertOpen();
    const source = row(
      this.database.prepare("SELECT * FROM agent_observations WHERE observation_id = ?").get(observationId)
    );
    return source ? mapObservationRow(source) : null;
  }

  listObservations(runId: string, stepId?: string): StoredAgentObservation[] {
    this.assertOpen();
    const result = stepId
      ? this.database
          .prepare("SELECT * FROM agent_observations WHERE run_id = ? AND step_id = ? ORDER BY created_at")
          .all(runId, stepId)
      : this.database
          .prepare("SELECT * FROM agent_observations WHERE run_id = ? ORDER BY created_at")
          .all(runId);
    return rows(result).map(mapObservationRow);
  }

  upsertArtifact(runId: string, artifact: AgentArtifactRef): StoredAgentArtifact {
    return this.transaction(() => {
      this.requireRun(runId);
      const artifactId = requiredString(asRecord(artifact).artifact_id, "artifact_id");
      const existing = this.getArtifact(artifactId);
      if (existing && existing.run_id !== runId) {
        throw new ExecutionStoreIntegrityError(`Artifact ${artifactId} belongs to another run`);
      }
      this.upsertArtifactRow(runId, artifact);
      return this.requireArtifact(artifactId);
    });
  }

  getArtifact(artifactId: string): StoredAgentArtifact | null {
    this.assertOpen();
    const source = row(this.database.prepare("SELECT * FROM agent_artifacts WHERE artifact_id = ?").get(artifactId));
    return source ? mapArtifactRow(source) : null;
  }

  listArtifacts(runId: string): StoredAgentArtifact[] {
    this.assertOpen();
    return rows(
      this.database.prepare("SELECT * FROM agent_artifacts WHERE run_id = ? ORDER BY artifact_id").all(runId)
    ).map(mapArtifactRow);
  }

  upsertConfirmation(
    confirmation: AgentConfirmation,
    expectedVersion?: number
  ): ExecutionCasResult<StoredAgentConfirmation> {
    return this.transaction(() => {
      const source = asRecord(confirmation);
      const confirmationId = requiredString(source.confirmation_id, "confirmation_id");
      const current = this.getConfirmation(confirmationId);
      if (current) {
        if (current.run_id !== stringValue(source.run_id)) {
          throw new ExecutionStoreIntegrityError(`Confirmation ${confirmationId} belongs to another run`);
        }
        if (expectedVersion !== undefined && current.version !== expectedVersion) {
          return casMiss(current);
        }
      } else if (expectedVersion !== undefined && expectedVersion !== 0) {
        return casMiss<StoredAgentConfirmation>(null);
      }
      this.requireRun(requiredString(source.run_id, "run_id"));
      const nextVersion = current ? current.version + 1 : positiveVersion(source.version);
      this.upsertConfirmationRow({ ...source, version: nextVersion });
      return casApplied(this.requireConfirmation(confirmationId));
    });
  }

  getConfirmation(confirmationId: string): StoredAgentConfirmation | null {
    this.assertOpen();
    const source = row(
      this.database.prepare("SELECT * FROM agent_confirmations WHERE confirmation_id = ?").get(confirmationId)
    );
    return source ? mapConfirmationRow(source) : null;
  }

  listConfirmations(runId: string, status?: string): StoredAgentConfirmation[] {
    this.assertOpen();
    const result = status
      ? this.database
          .prepare("SELECT * FROM agent_confirmations WHERE run_id = ? AND status = ? ORDER BY created_at")
          .all(runId, status)
      : this.database
          .prepare("SELECT * FROM agent_confirmations WHERE run_id = ? ORDER BY created_at")
          .all(runId);
    return rows(result).map(mapConfirmationRow);
  }

  resolveConfirmation(input: ResolveConfirmationInput): ExecutionCasResult<StoredAgentConfirmation> {
    return this.transaction(() => {
      const current = this.getConfirmation(input.confirmation_id);
      if (!current) {
        return casMiss<StoredAgentConfirmation>(null);
      }
      if (current.version !== input.expected_version || current.status !== "pending") {
        return casMiss(current);
      }
      const source = asRecord(current);
      source.version = current.version + 1;
      source.status = input.status;
      source.resolved_at = this.timestamp(input.resolved_at);
      source.resolved_by = input.resolved_by ?? "user";
      source.updated_at = this.timestamp();
      this.upsertConfirmationRow(source);
      return casApplied(this.requireConfirmation(input.confirmation_id));
    });
  }

  private nextAttemptNumber(runId: string, stepId: string): number {
    const source = row(
      this.database
        .prepare("SELECT COALESCE(MAX(attempt), 0) AS attempt FROM agent_step_attempts WHERE run_id = ? AND step_id = ?")
        .get(runId, stepId)
    );
    return (source ? nonNegativeInteger(source.attempt) : 0) + 1;
  }

  private countAttempts(runId: string, stepId: string): number {
    const source = row(
      this.database
        .prepare("SELECT COUNT(*) AS count FROM agent_step_attempts WHERE run_id = ? AND step_id = ?")
        .get(runId, stepId)
    );
    return source ? nonNegativeInteger(source.count) : 0;
  }

  private getRunPlanVersion(runId: string): number {
    const source = row(this.database.prepare("SELECT plan_version FROM agent_runs WHERE run_id = ?").get(runId));
    if (!source) {
      throw new Error(`Execution run not found: ${runId}`);
    }
    return positiveVersion(source.plan_version);
  }

  private listStepsForPlan(runId: string, planVersion: number): StoredAgentExecutionStep[] {
    return rows(
      this.database
        .prepare("SELECT * FROM agent_steps WHERE run_id = ? AND plan_version = ? ORDER BY step_index, step_id")
        .all(runId, planVersion)
    ).map(mapStepRow);
  }

  private getAttemptByIdempotencyKey(runId: string, idempotencyKey: string): ExecutionStepAttempt | null {
    const source = row(
      this.database
        .prepare("SELECT * FROM agent_step_attempts WHERE run_id = ? AND idempotency_key = ?")
        .get(runId, idempotencyKey)
    );
    return source ? mapAttemptRow(source) : null;
  }

  private insertArtifactRow(runId: string, artifact: AgentArtifactRef): void {
    const source = asRecord(artifact);
    const artifactId = requiredString(source.artifact_id, "artifact_id");
    this.database
      .prepare(`INSERT INTO agent_artifacts (
                  artifact_id, run_id, kind, path, cache_id, content_hash, document_version, chars,
                  created_by_step_id, created_by_attempt_id, artifact_json, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(...artifactRowParameters(runId, artifactId, source, this.timestamp(stringValue(source.created_at))));
  }

  private upsertArtifactRow(runId: string, artifact: AgentArtifactRef): void {
    const source = asRecord(artifact);
    const artifactId = requiredString(source.artifact_id, "artifact_id");
    const createdAt = this.timestamp(stringValue(source.created_at));
    this.database
      .prepare(`INSERT INTO agent_artifacts (
                  artifact_id, run_id, kind, path, cache_id, content_hash, document_version, chars,
                  created_by_step_id, created_by_attempt_id, artifact_json, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(artifact_id) DO UPDATE SET
                  run_id = excluded.run_id,
                  kind = excluded.kind,
                  path = excluded.path,
                  cache_id = excluded.cache_id,
                  content_hash = excluded.content_hash,
                  document_version = excluded.document_version,
                  chars = excluded.chars,
                  created_by_step_id = excluded.created_by_step_id,
                  created_by_attempt_id = excluded.created_by_attempt_id,
                  artifact_json = excluded.artifact_json`)
      .run(...artifactRowParameters(runId, artifactId, source, createdAt));
  }

  private upsertConfirmationRow(source: MutableRecord): void {
    const now = this.timestamp();
    const createdAt = stringValue(source.created_at) || now;
    const updatedAt = stringValue(source.updated_at) || now;
    this.database
      .prepare(`INSERT INTO agent_confirmations (
                  confirmation_id, run_id, step_id, version, action, risk_level, status, expires_at,
                  resolved_at, resolved_by, confirmation_json, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(confirmation_id) DO UPDATE SET
                  run_id = excluded.run_id,
                  step_id = excluded.step_id,
                  version = excluded.version,
                  action = excluded.action,
                  risk_level = excluded.risk_level,
                  status = excluded.status,
                  expires_at = excluded.expires_at,
                  resolved_at = excluded.resolved_at,
                  resolved_by = excluded.resolved_by,
                  confirmation_json = excluded.confirmation_json,
                  updated_at = excluded.updated_at`)
      .run(
        requiredString(source.confirmation_id, "confirmation_id"),
        requiredString(source.run_id, "run_id"),
        requiredString(source.step_id, "step_id"),
        positiveVersion(source.version),
        requiredString(source.action, "action"),
        requiredString(source.risk_level, "risk_level"),
        requiredString(source.status, "status"),
        stringValue(source.expires_at),
        stringValue(source.resolved_at),
        stringValue(source.resolved_by),
        json({ ...source, created_at: createdAt, updated_at: updatedAt }),
        createdAt,
        updatedAt
      );
  }

  private requireAttempt(attemptId: string): ExecutionStepAttempt {
    const attempt = this.getAttempt(attemptId);
    if (!attempt) {
      throw new Error(`Execution attempt not found: ${attemptId}`);
    }
    return attempt;
  }

  private requireObservation(observationId: string): StoredAgentObservation {
    const observation = this.getObservation(observationId);
    if (!observation) {
      throw new Error(`Execution observation not found: ${observationId}`);
    }
    return observation;
  }

  private requireArtifact(artifactId: string): StoredAgentArtifact {
    const artifact = this.getArtifact(artifactId);
    if (!artifact) {
      throw new Error(`Execution artifact not found: ${artifactId}`);
    }
    return artifact;
  }

  private requireConfirmation(confirmationId: string): StoredAgentConfirmation {
    const confirmation = this.getConfirmation(confirmationId);
    if (!confirmation) {
      throw new Error(`Execution confirmation not found: ${confirmationId}`);
    }
    return confirmation;
  }

  createControlOperation(operation: ExecutionControlOperation): ExecutionControlOperation {
    return this.transaction(() => {
      const duplicate = this.getControlOperation(operation.operation_id);
      if (duplicate) {
        return duplicate;
      }
      this.requireRun(operation.run_id);
      const createdAt = this.timestamp(operation.created_at);
      this.database
        .prepare(`INSERT INTO agent_control_operations (
                    operation_id, run_id, step_id, confirmation_id, operation_type, expected_version, version,
                    status, result_json, error_code, error, created_at, completed_at
                  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          requiredString(operation.operation_id, "operation_id"),
          operation.run_id,
          operation.step_id,
          operation.confirmation_id,
          requiredString(operation.operation_type, "operation_type"),
          operation.expected_version,
          positiveVersion(operation.version),
          operation.status || "pending",
          json(operation.result ?? {}),
          operation.error_code,
          operation.error,
          createdAt,
          operation.completed_at
        );
      return this.requireControlOperation(operation.operation_id);
    });
  }

  getControlOperation(operationId: string): ExecutionControlOperation | null {
    this.assertOpen();
    const source = row(
      this.database.prepare("SELECT * FROM agent_control_operations WHERE operation_id = ?").get(operationId)
    );
    return source ? mapControlOperationRow(source) : null;
  }

  listControlOperations(runId: string): ExecutionControlOperation[] {
    this.assertOpen();
    return rows(
      this.database
        .prepare("SELECT * FROM agent_control_operations WHERE run_id = ? ORDER BY created_at, operation_id")
        .all(runId)
    ).map(mapControlOperationRow);
  }

  completeControlOperation(
    input: CompleteControlOperationInput
  ): ExecutionCasResult<ExecutionControlOperation> {
    return this.transaction(() => {
      const current = this.getControlOperation(input.operation_id);
      if (!current) {
        return casMiss<ExecutionControlOperation>(null);
      }
      if (current.version !== input.expected_version || current.status !== "pending") {
        return casMiss(current);
      }
      const result = this.database
        .prepare(`UPDATE agent_control_operations
                     SET version = version + 1, status = ?, result_json = ?, error_code = ?, error = ?, completed_at = ?
                   WHERE operation_id = ? AND version = ? AND status = 'pending'`)
        .run(
          input.status,
          json(input.result ?? {}),
          input.error_code ?? "",
          input.error ?? "",
          this.timestamp(input.completed_at),
          input.operation_id,
          input.expected_version
        );
      return changes(result) === 1
        ? casApplied(this.requireControlOperation(input.operation_id))
        : casMiss(this.getControlOperation(input.operation_id));
    });
  }

  acquireWriteLease(input: AcquireWriteLeaseInput): ExecutionCasResult<ExecutionWriteLease> {
    return this.transaction(() => {
      const targetPath = normalizeTargetPath(input.target_path);
      const owner = requiredString(input.owner, "lease owner");
      const acquiredAt = this.timestamp(input.acquired_at);
      assertTimestampOrder(acquiredAt, input.expires_at, "write lease");
      const current = this.getWriteLease(targetPath);
      if (!current) {
        this.database
          .prepare(`INSERT INTO agent_write_leases (
                      target_path, owner, run_id, step_id, attempt_id, fencing_token, version, acquired_at,
                      expires_at, released_at
                    ) VALUES (?, ?, ?, ?, ?, 1, 1, ?, ?, '')`)
          .run(
            targetPath,
            owner,
            input.run_id ?? "",
            input.step_id ?? "",
            input.attempt_id ?? "",
            acquiredAt,
            input.expires_at
          );
        return casApplied(this.requireWriteLease(targetPath));
      }

      const expired = Boolean(current.released_at) || Date.parse(current.expires_at) <= Date.parse(acquiredAt);
      if (!expired && current.owner !== owner) {
        return casMiss(current);
      }
      const fencingToken = expired ? current.fencing_token + 1 : current.fencing_token;
      const result = this.database
        .prepare(`UPDATE agent_write_leases
                     SET owner = ?, run_id = ?, step_id = ?, attempt_id = ?, fencing_token = ?, version = version + 1,
                         acquired_at = ?, expires_at = ?, released_at = ''
                   WHERE target_path = ? AND version = ?`)
        .run(
          owner,
          input.run_id ?? "",
          input.step_id ?? "",
          input.attempt_id ?? "",
          fencingToken,
          acquiredAt,
          input.expires_at,
          targetPath,
          current.version
        );
      return changes(result) === 1
        ? casApplied(this.requireWriteLease(targetPath))
        : casMiss(this.getWriteLease(targetPath));
    });
  }

  getWriteLease(targetPath: string): ExecutionWriteLease | null {
    this.assertOpen();
    const normalized = normalizeTargetPath(targetPath);
    const source = row(
      this.database.prepare("SELECT * FROM agent_write_leases WHERE target_path = ?").get(normalized)
    );
    return source ? mapWriteLeaseRow(source) : null;
  }

  renewWriteLease(input: RenewWriteLeaseInput): ExecutionCasResult<ExecutionWriteLease> {
    return this.transaction(() => {
      const targetPath = normalizeTargetPath(input.target_path);
      const current = this.getWriteLease(targetPath);
      if (!current) {
        return casMiss<ExecutionWriteLease>(null);
      }
      if (
        current.version !== input.expected_version ||
        current.owner !== input.owner ||
        current.fencing_token !== input.fencing_token ||
        Boolean(current.released_at)
      ) {
        return casMiss(current);
      }
      if (Date.parse(input.expires_at) <= Date.parse(current.acquired_at)) {
        throw new Error("Write lease expiry must be after acquisition");
      }
      const result = this.database
        .prepare(`UPDATE agent_write_leases
                     SET version = version + 1, expires_at = ?
                   WHERE target_path = ? AND owner = ? AND fencing_token = ? AND version = ? AND released_at = ''`)
        .run(input.expires_at, targetPath, input.owner, input.fencing_token, input.expected_version);
      return changes(result) === 1
        ? casApplied(this.requireWriteLease(targetPath))
        : casMiss(this.getWriteLease(targetPath));
    });
  }

  releaseWriteLease(input: ReleaseWriteLeaseInput): ExecutionCasResult<ExecutionWriteLease> {
    return this.transaction(() => {
      const targetPath = normalizeTargetPath(input.target_path);
      const current = this.getWriteLease(targetPath);
      if (!current) {
        return casMiss<ExecutionWriteLease>(null);
      }
      if (
        current.version !== input.expected_version ||
        current.owner !== input.owner ||
        current.fencing_token !== input.fencing_token ||
        Boolean(current.released_at)
      ) {
        return casMiss(current);
      }
      const releasedAt = this.timestamp(input.released_at);
      const result = this.database
        .prepare(`UPDATE agent_write_leases
                     SET version = version + 1, expires_at = ?, released_at = ?
                   WHERE target_path = ? AND owner = ? AND fencing_token = ? AND version = ? AND released_at = ''`)
        .run(releasedAt, releasedAt, targetPath, input.owner, input.fencing_token, input.expected_version);
      return changes(result) === 1
        ? casApplied(this.requireWriteLease(targetPath))
        : casMiss(this.getWriteLease(targetPath));
    });
  }

  registerRuntimeInstance(input: RegisterRuntimeInstanceInput): ExecutionRuntimeInstance {
    return this.transaction(() => {
      const runtimeId = requiredString(input.runtime_instance_id, "runtime_instance_id");
      const existing = this.getRuntimeInstance(runtimeId);
      if (existing) {
        return existing;
      }
      const startedAt = this.timestamp(input.started_at);
      const heartbeatAt = this.timestamp(input.heartbeat_at || startedAt);
      assertTimestampOrder(heartbeatAt, input.lease_expires_at, "runtime instance lease");
      this.database
        .prepare(`INSERT INTO agent_runtime_instances (
                    runtime_instance_id, version, status, started_at, heartbeat_at, lease_expires_at, released_at,
                    metadata_json
                  ) VALUES (?, 1, 'active', ?, ?, ?, '', ?)`)
        .run(runtimeId, startedAt, heartbeatAt, input.lease_expires_at, json(input.metadata ?? {}));
      return this.requireRuntimeInstance(runtimeId);
    });
  }

  getRuntimeInstance(runtimeInstanceId: string): ExecutionRuntimeInstance | null {
    this.assertOpen();
    const source = row(
      this.database
        .prepare("SELECT * FROM agent_runtime_instances WHERE runtime_instance_id = ?")
        .get(runtimeInstanceId)
    );
    return source ? mapRuntimeInstanceRow(source) : null;
  }

  heartbeatRuntimeInstance(
    input: HeartbeatRuntimeInstanceInput
  ): ExecutionCasResult<ExecutionRuntimeInstance> {
    return this.transaction(() => {
      const current = this.getRuntimeInstance(input.runtime_instance_id);
      if (!current) {
        return casMiss<ExecutionRuntimeInstance>(null);
      }
      if (current.version !== input.expected_version || current.status !== "active") {
        return casMiss(current);
      }
      const heartbeatAt = this.timestamp(input.heartbeat_at);
      assertTimestampOrder(heartbeatAt, input.lease_expires_at, "runtime instance lease");
      const result = this.database
        .prepare(`UPDATE agent_runtime_instances
                     SET version = version + 1, heartbeat_at = ?, lease_expires_at = ?
                   WHERE runtime_instance_id = ? AND version = ? AND status = 'active'`)
        .run(heartbeatAt, input.lease_expires_at, input.runtime_instance_id, input.expected_version);
      return changes(result) === 1
        ? casApplied(this.requireRuntimeInstance(input.runtime_instance_id))
        : casMiss(this.getRuntimeInstance(input.runtime_instance_id));
    });
  }

  releaseRuntimeInstance(input: ReleaseRuntimeInstanceInput): ExecutionCasResult<ExecutionRuntimeInstance> {
    return this.transaction(() => {
      const current = this.getRuntimeInstance(input.runtime_instance_id);
      if (!current) {
        return casMiss<ExecutionRuntimeInstance>(null);
      }
      if (current.version !== input.expected_version || current.status !== "active") {
        return casMiss(current);
      }
      const releasedAt = this.timestamp(input.released_at);
      const result = this.database
        .prepare(`UPDATE agent_runtime_instances
                     SET version = version + 1, status = 'released', lease_expires_at = ?, released_at = ?
                   WHERE runtime_instance_id = ? AND version = ? AND status = 'active'`)
        .run(releasedAt, releasedAt, input.runtime_instance_id, input.expected_version);
      return changes(result) === 1
        ? casApplied(this.requireRuntimeInstance(input.runtime_instance_id))
        : casMiss(this.getRuntimeInstance(input.runtime_instance_id));
    });
  }

  claimStaleRun(input: ClaimStaleRunInput): ExecutionCasResult<AgentRunState> {
    return this.transaction(() => {
      const runtime = this.getRuntimeInstance(input.runtime_instance_id);
      if (!runtime || runtime.status !== "active") {
        throw new Error(`Active runtime instance not found: ${input.runtime_instance_id}`);
      }
      const current = this.getRun(input.run_id);
      if (!current) {
        return casMiss<AgentRunState>(null);
      }
      const source = asRecord(current);
      const currentVersion = positiveVersion(source.version);
      const allowedStatuses = input.statuses ?? ["running", "cancelling"];
      const leaseExpiresAt = stringValue(source.lease_expires_at);
      const isStale = !leaseExpiresAt || Date.parse(leaseExpiresAt) <= Date.parse(input.stale_before);
      if (
        (input.expected_version !== undefined && input.expected_version !== currentVersion) ||
        !allowedStatuses.includes(stringValue(source.status)) ||
        !isStale
      ) {
        return casMiss(current);
      }

      const heartbeatAt = this.timestamp(input.heartbeat_at);
      assertTimestampOrder(heartbeatAt, input.lease_expires_at, "run lease");
      const next: MutableRecord = {
        ...source,
        version: currentVersion + 1,
        status: "paused",
        runtime_instance_id: input.runtime_instance_id,
        heartbeat_at: heartbeatAt,
        lease_expires_at: input.lease_expires_at,
        recovery_reason: requiredString(input.recovery_reason, "recovery_reason"),
        updated_at: heartbeatAt
      };
      this.interruptOrphanedAttempts(input.run_id, heartbeatAt, stringValue(next.recovery_reason));
      next.steps = this.listSteps(input.run_id);
      const preparedEvent = input.event ? this.prepareEvent(input.run_id, input.event, next) : null;
      if (!this.persistRunRecord(next, currentVersion)) {
        return casMiss(this.getRun(input.run_id));
      }
      if (preparedEvent) {
        this.insertEventRow(preparedEvent);
      }
      return casApplied(this.requireRun(input.run_id));
    });
  }

  private interruptOrphanedAttempts(runId: string, endedAt: string, reason: string): void {
    const orphaned = rows(
      this.database
        .prepare("SELECT attempt_id, step_id FROM agent_step_attempts WHERE run_id = ? AND status = 'running' ORDER BY step_id, attempt")
        .all(runId)
    );

    for (const orphan of orphaned) {
      const attemptId = stringValue(orphan.attempt_id);
      const stepId = stringValue(orphan.step_id);
      const interrupted = this.database
        .prepare(`UPDATE agent_step_attempts
                    SET version = version + 1, status = 'interrupted', error_code = 'RUNTIME_LEASE_EXPIRED', error = ?, ended_at = ?
                  WHERE attempt_id = ? AND status = 'running'`)
        .run(reason, endedAt, attemptId);
      if (changes(interrupted) !== 1) {
        throw new ExecutionStoreIntegrityError(`Orphan attempt ${attemptId} changed during stale-run recovery`);
      }

      const step = this.requireStep(runId, stepId);
      if (step.status !== "running") {
        continue;
      }
      this.upsertStepRow(
        runId,
        {
          ...step,
          status: "pending",
          observation_id: "",
          error_code: "",
          error: "",
          started_at: "",
          ended_at: "",
          version: step.version + 1
        },
        positiveVersion(step.plan_version)
      );
    }
  }

  createCommitJournal(entry: ExecutionCommitJournalEntry): ExecutionCommitJournalEntry {
    return this.transaction(() => {
      const duplicate = this.getCommitJournalByIdempotencyKey(entry.idempotency_key);
      if (duplicate) {
        return duplicate;
      }
      this.requireRun(entry.run_id);
      const createdAt = this.timestamp(entry.created_at);
      const updatedAt = this.timestamp(entry.updated_at || createdAt);
      this.database
        .prepare(`INSERT INTO agent_commit_journal (
                    journal_id, run_id, step_id, attempt_id, action, target_path, base_hash, new_hash, temp_path,
                    backup_path, document_version, timeline_ref, idempotency_key, fencing_token, stage, version,
                    manifest_json, error_code, error, created_at, updated_at, finalized_at
                  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          requiredString(entry.journal_id, "journal_id"),
          entry.run_id,
          entry.step_id,
          entry.attempt_id,
          requiredString(entry.action, "action"),
          requiredString(entry.target_path, "target_path"),
          entry.base_hash,
          requiredString(entry.new_hash, "new_hash"),
          requiredString(entry.temp_path, "temp_path"),
          entry.backup_path,
          entry.document_version,
          entry.timeline_ref,
          requiredString(entry.idempotency_key, "idempotency_key"),
          entry.fencing_token,
          entry.stage,
          positiveVersion(entry.version),
          json(entry.manifest ?? {}),
          entry.error_code,
          entry.error,
          createdAt,
          updatedAt,
          entry.finalized_at
        );
      return this.requireCommitJournal(entry.journal_id);
    });
  }

  getCommitJournal(journalId: string): ExecutionCommitJournalEntry | null {
    this.assertOpen();
    const source = row(
      this.database.prepare("SELECT * FROM agent_commit_journal WHERE journal_id = ?").get(journalId)
    );
    return source ? mapCommitJournalRow(source) : null;
  }

  listCommitJournal(runId?: string): ExecutionCommitJournalEntry[] {
    this.assertOpen();
    const result = runId
      ? this.database
          .prepare("SELECT * FROM agent_commit_journal WHERE run_id = ? ORDER BY created_at, journal_id")
          .all(runId)
      : this.database.prepare("SELECT * FROM agent_commit_journal ORDER BY created_at, journal_id").all();
    return rows(result).map(mapCommitJournalRow);
  }

  listPendingCommitJournal(runId?: string): ExecutionCommitJournalEntry[] {
    this.assertOpen();
    const result = runId
      ? this.database
          .prepare("SELECT * FROM agent_commit_journal WHERE run_id = ? AND stage <> 'finalized' ORDER BY created_at")
          .all(runId)
      : this.database
          .prepare("SELECT * FROM agent_commit_journal WHERE stage <> 'finalized' ORDER BY created_at")
          .all();
    return rows(result).map(mapCommitJournalRow);
  }

  updateCommitJournal(input: UpdateCommitJournalInput): ExecutionCasResult<ExecutionCommitJournalEntry> {
    return this.transaction(() => {
      const current = this.getCommitJournal(input.journal_id);
      if (!current) {
        return casMiss<ExecutionCommitJournalEntry>(null);
      }
      if (
        current.version !== input.expected_version ||
        (input.expected_stage !== undefined && current.stage !== input.expected_stage)
      ) {
        return casMiss(current);
      }
      const result = this.database
        .prepare(`UPDATE agent_commit_journal
                     SET version = version + 1, stage = ?, manifest_json = ?, error_code = ?, error = ?,
                         updated_at = ?, finalized_at = ?
                   WHERE journal_id = ? AND version = ? AND stage = ?`)
        .run(
          input.stage,
          json(input.manifest ?? current.manifest),
          input.error_code ?? current.error_code,
          input.error ?? current.error,
          this.timestamp(input.updated_at),
          input.finalized_at ?? (input.stage === "finalized" ? this.timestamp() : current.finalized_at),
          input.journal_id,
          input.expected_version,
          current.stage
        );
      return changes(result) === 1
        ? casApplied(this.requireCommitJournal(input.journal_id))
        : casMiss(this.getCommitJournal(input.journal_id));
    });
  }

  private getCommitJournalByIdempotencyKey(idempotencyKey: string): ExecutionCommitJournalEntry | null {
    const source = row(
      this.database
        .prepare("SELECT * FROM agent_commit_journal WHERE idempotency_key = ?")
        .get(idempotencyKey)
    );
    return source ? mapCommitJournalRow(source) : null;
  }

  private requireControlOperation(operationId: string): ExecutionControlOperation {
    const operation = this.getControlOperation(operationId);
    if (!operation) {
      throw new Error(`Execution control operation not found: ${operationId}`);
    }
    return operation;
  }

  private requireWriteLease(targetPath: string): ExecutionWriteLease {
    const lease = this.getWriteLease(targetPath);
    if (!lease) {
      throw new Error(`Execution write lease not found: ${targetPath}`);
    }
    return lease;
  }

  private requireRuntimeInstance(runtimeInstanceId: string): ExecutionRuntimeInstance {
    const instance = this.getRuntimeInstance(runtimeInstanceId);
    if (!instance) {
      throw new Error(`Execution runtime instance not found: ${runtimeInstanceId}`);
    }
    return instance;
  }

  private requireCommitJournal(journalId: string): ExecutionCommitJournalEntry {
    const entry = this.getCommitJournal(journalId);
    if (!entry) {
      throw new Error(`Execution commit journal entry not found: ${journalId}`);
    }
    return entry;
  }

  private requireRun(runId: string): AgentRunState {
    const run = this.getRun(runId);
    if (!run) {
      throw new Error(`Execution run not found: ${runId}`);
    }
    return run;
  }

  private listAllEventsForExport(runId: string): StoredAgentRunEvent[] {
    const events: StoredAgentRunEvent[] = [];
    let after = 0;
    for (;;) {
      const page = this.listEvents(runId, { after, limit: 1_000 });
      events.push(...page);
      if (page.length < 1_000) {
        return events;
      }
      const next = page.at(-1)?.sequence ?? after;
      if (next <= after) {
        throw new ExecutionStoreIntegrityError(`Execution event sequence stalled while exporting run ${runId}`);
      }
      after = next;
    }
  }

  private requireStep(runId: string, stepId: string): StoredAgentExecutionStep {
    const step = this.getStep(runId, stepId);
    if (!step) {
      throw new Error(`Execution step not found: ${runId}/${stepId}`);
    }
    return step;
  }

  createOutboundDisclosure(disclosure: AgentOutboundDisclosure): AgentOutboundDisclosure {
    return this.transaction(() => {
      this.requireRun(disclosure.run_id);
      this.database
        .prepare(`INSERT INTO agent_outbound_disclosures (
                    disclosure_id, run_id, step_id, attempt_id, provider_id, purpose,
                    data_classes, content_digest, redacted_summary, policy_version,
                    consent_receipt_id, created_at
                  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          disclosure.disclosure_id,
          disclosure.run_id,
          disclosure.step_id,
          disclosure.attempt_id,
          disclosure.provider_id,
          disclosure.purpose,
          disclosure.data_classes,
          disclosure.content_digest,
          disclosure.redacted_summary,
          disclosure.policy_version,
          disclosure.consent_receipt_id,
          disclosure.created_at
        );
      return disclosure;
    });
  }

  listOutboundDisclosures(runId?: string): AgentOutboundDisclosure[] {
    const query = runId
      ? `SELECT * FROM agent_outbound_disclosures WHERE run_id = ? ORDER BY created_at ASC`
      : `SELECT * FROM agent_outbound_disclosures ORDER BY created_at ASC`;
    const rows = runId
      ? this.database.prepare(query).all(runId)
      : this.database.prepare(query).all();
    return rows.map((row: any) => ({
      disclosure_id: row.disclosure_id,
      run_id: row.run_id,
      step_id: row.step_id,
      attempt_id: row.attempt_id,
      provider_id: row.provider_id,
      purpose: row.purpose,
      data_classes: row.data_classes,
      content_digest: row.content_digest,
      redacted_summary: row.redacted_summary,
      policy_version: row.policy_version,
      consent_receipt_id: row.consent_receipt_id,
      created_at: row.created_at
    }));
  }
}

function configureConnection(database: ExecutionDatabase, readOnly: boolean): void {
  database.exec(`PRAGMA busy_timeout = ${EXECUTION_STORE_BUSY_TIMEOUT_MS}`);
  database.exec("PRAGMA foreign_keys = ON");
  if (readOnly) {
    database.exec("PRAGMA query_only = ON");
  }
}

function configureWritableConnection(database: ExecutionDatabase): void {
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA synchronous = NORMAL");
}

function readDatabaseSchemaVersion(database: ExecutionDatabase): number {
  const pragmaRow = row(database.prepare("PRAGMA user_version").get());
  const pragmaVersion = pragmaRow ? numberValue(pragmaRow.user_version, 0) : 0;
  if (!tableExists(database, "agent_schema_migrations")) {
    return pragmaVersion;
  }
  const migrationRow = row(database.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM agent_schema_migrations").get());
  return Math.max(pragmaVersion, migrationRow ? numberValue(migrationRow.version, 0) : 0);
}

function tableExists(database: ExecutionDatabase, tableName: string): boolean {
  return Boolean(
    database
      .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(tableName)
  );
}

function applyMigrations(
  database: ExecutionDatabase,
  databasePath: string,
  adapter: ExecutionDatabaseAdapter,
  fileSystem: ExecutionStoreFileSystem,
  foundVersion: number,
  now: () => Date,
  backupBeforeMigration: boolean
): void {
  const pending = EXECUTION_STORE_MIGRATIONS.filter((migration) => migration.version > foundVersion);
  if (pending.length === 0) {
    return;
  }

  if (backupBeforeMigration && shouldBackUpDatabase(databasePath, foundVersion, fileSystem)) {
    createValidatedMigrationBackup(database, databasePath, adapter, fileSystem, foundVersion, now());
  }

  for (const migration of pending) {
    const startedAt = Date.now();
    database.exec("BEGIN EXCLUSIVE");
    try {
      database.exec(migration.sql);
      const appliedAt = now().toISOString();
      database
        .prepare(`INSERT INTO agent_schema_migrations (
                    version, name, checksum, applied_at, execution_ms, min_reader_version, min_writer_version,
                    rollback_notes
                  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          migration.version,
          migration.name,
          migration.checksum,
          appliedAt,
          Math.max(0, Date.now() - startedAt),
          migration.minReaderVersion,
          migration.minWriterVersion,
          migration.rollbackNotes
        );
      database.exec(`PRAGMA user_version = ${migration.version}`);
      database.exec("COMMIT");
    } catch (error) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // Preserve the migration failure.
      }
      throw error;
    }
  }
}

function verifyMigrationRegistry(database: ExecutionDatabase): void {
  const applied = rows(
    database.prepare("SELECT version, checksum FROM agent_schema_migrations ORDER BY version").all()
  );
  for (const migration of EXECUTION_STORE_MIGRATIONS) {
    const record = applied.find((candidate) => numberValue(candidate.version, 0) === migration.version);
    if (!record) {
      throw new ExecutionStoreIntegrityError(`Missing execution store migration ${migration.version}`);
    }
    if (stringValue(record.checksum, "") !== migration.checksum) {
      throw new ExecutionStoreIntegrityError(`Checksum mismatch for execution store migration ${migration.version}`);
    }
  }
}

function shouldBackUpDatabase(
  databasePath: string,
  foundVersion: number,
  fileSystem: ExecutionStoreFileSystem
): boolean {
  return foundVersion > 0 || (fileSystem.exists(databasePath) && fileSystem.fileSize(databasePath) > 0);
}

function createValidatedMigrationBackup(
  database: ExecutionDatabase,
  databasePath: string,
  adapter: ExecutionDatabaseAdapter,
  fileSystem: ExecutionStoreFileSystem,
  foundVersion: number,
  now: Date
): string {
  database.exec("PRAGMA wal_checkpoint(FULL)");
  const databaseBytes = fileSystem.fileSize(databasePath);
  const walPath = `${databasePath}-wal`;
  const walBytes = fileSystem.exists(walPath) ? fileSystem.fileSize(walPath) : 0;
  const requiredBytes = 2 * (databaseBytes + walBytes) + 64 * 1024 * 1024;
  const availableBytes = fileSystem.availableBytes(path.dirname(databasePath));
  if (Number.isFinite(availableBytes) && availableBytes < requiredBytes) {
    throw new Error(`Insufficient free space for execution store migration backup: need ${requiredBytes} bytes`);
  }

  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const backupPath = `${databasePath}.backup-v${foundVersion}-${stamp}`;
  const temporaryBackupPath = `${backupPath}.partial-${randomUUID()}`;
  try {
    fileSystem.copy(databasePath, temporaryBackupPath);
    const backup = adapter.open(temporaryBackupPath, { readOnly: true });
    try {
      configureConnection(backup, true);
      const result = row(backup.prepare("PRAGMA quick_check").get());
      if (!result || stringValue(result.quick_check, "") !== "ok") {
        throw new ExecutionStoreIntegrityError(`Execution store migration backup failed quick_check: ${backupPath}`);
      }
      if (readDatabaseSchemaVersion(backup) !== foundVersion) {
        throw new ExecutionStoreIntegrityError(`Execution store migration backup schema mismatch: ${backupPath}`);
      }
    } finally {
      backup.close();
    }
    fileSystem.rename(temporaryBackupPath, backupPath);
    discardTemporaryBackupArtifacts(fileSystem, temporaryBackupPath);
  } catch (error) {
    discardTemporaryBackupArtifacts(fileSystem, temporaryBackupPath);
    throw error;
  }
  return backupPath;
}

function discardTemporaryBackupArtifacts(fileSystem: ExecutionStoreFileSystem, temporaryBackupPath: string): void {
  for (const filename of [
    temporaryBackupPath,
    `${temporaryBackupPath}-journal`,
    `${temporaryBackupPath}-shm`,
    `${temporaryBackupPath}-wal`
  ]) {
    try {
      fileSystem.remove(filename);
    } catch {
      // A failed cleanup must not mask the original migration outcome.
    }
  }
}

function mapMigrationRow(source: SqlRow): ExecutionStoreMigrationRecord {
  return {
    version: numberValue(source.version),
    name: stringValue(source.name),
    checksum: stringValue(source.checksum),
    applied_at: stringValue(source.applied_at),
    execution_ms: numberValue(source.execution_ms),
    min_reader_version: numberValue(source.min_reader_version),
    min_writer_version: numberValue(source.min_writer_version),
    rollback_notes: stringValue(source.rollback_notes)
  };
}

function row(value: unknown): SqlRow | null {
  return value && typeof value === "object" ? (value as SqlRow) : null;
}

function rows(values: unknown[]): SqlRow[] {
  return values.map(row).filter((value): value is SqlRow => value !== null);
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function numberValue(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  return fallback;
}

function changes(result: { changes: number | bigint }): number {
  return typeof result.changes === "bigint" ? Number(result.changes) : result.changes;
}

function parseJson<Value>(value: unknown, fallback: Value): Value {
  if (typeof value !== "string" || value.length === 0) {
    return fallback;
  }
  try {
    return JSON.parse(value) as Value;
  } catch {
    return fallback;
  }
}

function json(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function asRecord(value: unknown): MutableRecord {
  return value && typeof value === "object" ? { ...(value as MutableRecord) } : {};
}

function positiveVersion(value: unknown, fallback = 1): number {
  const parsed = numberValue(value, fallback);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeInteger(value: unknown, fallback = 0): number {
  const parsed = numberValue(value, fallback);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function normalizeTargetPath(targetPath: string): string {
  const trimmed = targetPath.trim();
  if (!trimmed) {
    throw new Error("Write lease target_path must not be empty");
  }
  return path.win32.normalize(trimmed).replace(/\\/g, "/").toLowerCase();
}

function casApplied<Value>(value: Value): ExecutionCasResult<Value> {
  return { applied: true, value };
}

function casMiss<Value>(current: Value | null): ExecutionCasResult<Value> {
  return { applied: false, current };
}

function requiredString(value: unknown, field: string): string {
  const parsed = stringValue(value).trim();
  if (!parsed) {
    throw new Error(`Execution store ${field} must not be empty`);
  }
  return parsed;
}

function boundedLimit(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error("Execution store list limit must be a positive integer");
  }
  return Math.min(value, maximum);
}

function assignDefined(target: MutableRecord, key: string, value: unknown): void {
  if (value !== undefined) {
    target[key] = value;
  }
}

function matchesExpectedStatus(
  current: AgentRunStatus,
  expected: AgentRunStatus | readonly AgentRunStatus[] | undefined
): boolean {
  if (expected === undefined) {
    return true;
  }
  return Array.isArray(expected) ? expected.includes(current) : current === expected;
}

function stepRowParameters(runId: string, source: MutableRecord, planVersion: number): ExecutionSqlValue[] {
  const version = positiveVersion(source.version);
  const payload = { ...source, version, plan_version: planVersion };
  return [
    runId,
    requiredString(source.step_id, "step_id"),
    planVersion,
    version,
    nonNegativeInteger(source.index),
    requiredString(source.type, "step type"),
    requiredString(source.action_id, "action_id"),
    requiredString(source.status, "step status"),
    nonNegativeInteger(source.attempts),
    stringValue(source.idempotency_key),
    stringValue(source.observation_id),
    stringValue(source.error_code),
    stringValue(source.error),
    stringValue(source.started_at),
    stringValue(source.ended_at),
    json(payload)
  ];
}

function mapStepRow(source: SqlRow): StoredAgentExecutionStep {
  const stored = asRecord(parseJson(source.step_json, {}));
  Object.assign(stored, {
    step_id: stringValue(source.step_id),
    plan_version: positiveVersion(source.plan_version),
    version: positiveVersion(source.version),
    index: nonNegativeInteger(source.step_index),
    type: stringValue(source.type),
    action_id: stringValue(source.action_id),
    status: stringValue(source.status),
    attempts: nonNegativeInteger(source.attempts),
    idempotency_key: stringValue(source.idempotency_key),
    observation_id: stringValue(source.observation_id),
    error_code: stringValue(source.error_code),
    error: stringValue(source.error),
    started_at: stringValue(source.started_at),
    ended_at: stringValue(source.ended_at)
  });
  return stored as unknown as StoredAgentExecutionStep;
}

function mapEventRow(source: SqlRow): StoredAgentRunEvent {
  return {
    event_id: stringValue(source.event_id),
    run_id: stringValue(source.run_id),
    sequence: positiveVersion(source.sequence),
    event_type: stringValue(source.event_type),
    step_id: stringValue(source.step_id),
    payload: parseJson<Record<string, unknown>>(source.payload_json, {}),
    created_at: stringValue(source.created_at),
    published_at: stringValue(source.published_at)
  } as StoredAgentRunEvent;
}

function mapAttemptRow(source: SqlRow): ExecutionStepAttempt {
  return {
    attempt_id: stringValue(source.attempt_id),
    run_id: stringValue(source.run_id),
    step_id: stringValue(source.step_id),
    attempt: positiveVersion(source.attempt),
    version: positiveVersion(source.version),
    status: stringValue(source.status) as ExecutionStepAttempt["status"],
    input_digest: stringValue(source.input_digest),
    observation_id: stringValue(source.observation_id),
    idempotency_key: stringValue(source.idempotency_key),
    model_call_refs: parseJson<string[]>(source.model_call_refs_json, []),
    error_code: stringValue(source.error_code),
    error: stringValue(source.error),
    started_at: stringValue(source.started_at),
    ended_at: stringValue(source.ended_at)
  };
}

function mapObservationRow(source: SqlRow): StoredAgentObservation {
  const stored = asRecord(parseJson(source.observation_json, {}));
  Object.assign(stored, {
    observation_id: stringValue(source.observation_id),
    run_id: stringValue(source.run_id),
    step_id: stringValue(source.step_id),
    attempt_id: stringValue(source.attempt_id),
    ok: numberValue(source.ok) === 1,
    summary: stringValue(source.summary),
    created_at: stringValue(source.created_at)
  });
  return stored as unknown as StoredAgentObservation;
}

function artifactRowParameters(
  runId: string,
  artifactId: string,
  source: MutableRecord,
  createdAt: string
): ExecutionSqlValue[] {
  const payload = { ...source, artifact_id: artifactId, run_id: runId, created_at: createdAt };
  return [
    artifactId,
    runId,
    requiredString(source.kind, "artifact kind"),
    stringValue(source.path),
    stringValue(source.cache_id),
    stringValue(source.content_hash),
    nonNegativeInteger(source.document_version),
    nonNegativeInteger(source.chars),
    stringValue(source.created_by_step_id),
    stringValue(source.created_by_attempt_id),
    json(payload),
    createdAt
  ];
}

function mapArtifactRow(source: SqlRow): StoredAgentArtifact {
  const stored = asRecord(parseJson(source.artifact_json, {}));
  Object.assign(stored, {
    artifact_id: stringValue(source.artifact_id),
    run_id: stringValue(source.run_id),
    kind: stringValue(source.kind),
    path: stringValue(source.path),
    cache_id: stringValue(source.cache_id),
    content_hash: stringValue(source.content_hash),
    document_version: nonNegativeInteger(source.document_version),
    chars: nonNegativeInteger(source.chars),
    created_by_step_id: stringValue(source.created_by_step_id),
    created_by_attempt_id: stringValue(source.created_by_attempt_id),
    created_at: stringValue(source.created_at)
  });
  return stored as unknown as StoredAgentArtifact;
}

function mapConfirmationRow(source: SqlRow): StoredAgentConfirmation {
  const stored = asRecord(parseJson(source.confirmation_json, {}));
  const resolvedAt = stringValue(source.resolved_at);
  const resolvedBy = stringValue(source.resolved_by);
  Object.assign(stored, {
    confirmation_id: stringValue(source.confirmation_id),
    run_id: stringValue(source.run_id),
    step_id: stringValue(source.step_id),
    version: positiveVersion(source.version),
    action: stringValue(source.action),
    risk_level: stringValue(source.risk_level),
    status: stringValue(source.status),
    expires_at: stringValue(source.expires_at),
    created_at: stringValue(source.created_at),
    updated_at: stringValue(source.updated_at)
  });
  // The durable schema models unresolved fields as absent. SQLite stores them
  // as empty strings, which must not leak through the API contract.
  if (resolvedAt) {
    stored.resolved_at = resolvedAt;
  } else {
    delete stored.resolved_at;
  }
  if (resolvedBy) {
    stored.resolved_by = resolvedBy;
  } else {
    delete stored.resolved_by;
  }
  return stored as unknown as StoredAgentConfirmation;
}

function mapControlOperationRow(source: SqlRow): ExecutionControlOperation {
  return {
    operation_id: stringValue(source.operation_id),
    run_id: stringValue(source.run_id),
    step_id: stringValue(source.step_id),
    confirmation_id: stringValue(source.confirmation_id),
    operation_type: stringValue(source.operation_type),
    expected_version: nonNegativeInteger(source.expected_version),
    version: positiveVersion(source.version),
    status: stringValue(source.status) as ExecutionControlOperation["status"],
    result: parseJson<Record<string, unknown>>(source.result_json, {}),
    error_code: stringValue(source.error_code),
    error: stringValue(source.error),
    created_at: stringValue(source.created_at),
    completed_at: stringValue(source.completed_at)
  };
}

function mapWriteLeaseRow(source: SqlRow): ExecutionWriteLease {
  return {
    target_path: stringValue(source.target_path),
    owner: stringValue(source.owner),
    run_id: stringValue(source.run_id),
    step_id: stringValue(source.step_id),
    attempt_id: stringValue(source.attempt_id),
    fencing_token: positiveVersion(source.fencing_token),
    version: positiveVersion(source.version),
    acquired_at: stringValue(source.acquired_at),
    expires_at: stringValue(source.expires_at),
    released_at: stringValue(source.released_at)
  };
}

function mapRuntimeInstanceRow(source: SqlRow): ExecutionRuntimeInstance {
  return {
    runtime_instance_id: stringValue(source.runtime_instance_id),
    version: positiveVersion(source.version),
    status: stringValue(source.status) as ExecutionRuntimeInstance["status"],
    started_at: stringValue(source.started_at),
    heartbeat_at: stringValue(source.heartbeat_at),
    lease_expires_at: stringValue(source.lease_expires_at),
    released_at: stringValue(source.released_at),
    metadata: parseJson<Record<string, unknown>>(source.metadata_json, {})
  };
}

function mapCommitJournalRow(source: SqlRow): ExecutionCommitJournalEntry {
  return {
    journal_id: stringValue(source.journal_id),
    run_id: stringValue(source.run_id),
    step_id: stringValue(source.step_id),
    attempt_id: stringValue(source.attempt_id),
    action: stringValue(source.action),
    target_path: stringValue(source.target_path),
    base_hash: stringValue(source.base_hash),
    new_hash: stringValue(source.new_hash),
    temp_path: stringValue(source.temp_path),
    backup_path: stringValue(source.backup_path),
    document_version: nonNegativeInteger(source.document_version),
    timeline_ref: stringValue(source.timeline_ref),
    idempotency_key: stringValue(source.idempotency_key),
    fencing_token: positiveVersion(source.fencing_token),
    stage: stringValue(source.stage) as ExecutionCommitJournalEntry["stage"],
    version: positiveVersion(source.version),
    manifest: parseJson<Record<string, unknown>>(source.manifest_json, {}),
    error_code: stringValue(source.error_code),
    error: stringValue(source.error),
    created_at: stringValue(source.created_at),
    updated_at: stringValue(source.updated_at),
    finalized_at: stringValue(source.finalized_at)
  };
}

function assertTimestampOrder(start: string, end: string, subject: string): void {
  const startTime = Date.parse(start);
  const endTime = Date.parse(end);
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime <= startTime) {
    throw new Error(`${subject} expiry must be a valid timestamp after its start`);
  }
}

function isTerminalRunStatus(status: AgentRunStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function codedError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
