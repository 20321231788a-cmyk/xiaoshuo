import type {
  AgentArtifactRef,
  AgentConfirmation,
  AgentExecutionStep,
  AgentRunState
} from "@xiaoshuo/shared";
import { afterEach, describe, expect, it } from "vitest";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  statfsSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  CURRENT_EXECUTION_STORE_SCHEMA_VERSION,
  EXECUTION_STORE_BUSY_TIMEOUT_MS,
  EXECUTION_STORE_RELATIVE_PATH,
  ExecutionStore,
  NodeSqliteExecutionDatabaseAdapter,
  UnsupportedExecutionStoreSchemaError,
  resolveExecutionStorePath
} from "./execution-store.js";
import type {
  ExecutionCasResult,
  ExecutionDatabase,
  ExecutionDatabaseAdapter,
  ExecutionDatabaseOpenOptions,
  ExecutionStoreFileSystem
} from "./execution-store-port.js";

const TABLES = [
  "agent_runs",
  "agent_steps",
  "agent_step_attempts",
  "agent_observations",
  "agent_artifacts",
  "agent_confirmations",
  "agent_run_events",
  "agent_write_leases",
  "agent_control_operations",
  "agent_commit_journal",
  "agent_runtime_instances",
  "agent_schema_migrations"
];

const projects: string[] = [];
const stores: ExecutionStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) {
    store.close();
  }
  for (const project of projects.splice(0)) {
    rmSync(project, { recursive: true, force: true });
  }
});

describe("ExecutionStore", () => {
  it("creates and migrates the fixed project-local SQLite database with the configured pragmas", () => {
    const projectRoot = temporaryProject();
    const adapter = new RecordingAdapter();
    const store = track(
      ExecutionStore.open(projectRoot, {
        adapter,
        backupBeforeMigration: false,
        now: () => new Date("2026-07-10T00:00:00.000Z")
      })
    );

    const expectedPath = path.join(projectRoot, EXECUTION_STORE_RELATIVE_PATH);
    expect(store.projectRoot).toBe(path.resolve(projectRoot));
    expect(store.databasePath).toBe(expectedPath);
    expect(resolveExecutionStorePath(projectRoot)).toBe(expectedPath);
    expect(existsSync(expectedPath)).toBe(true);
    expect(store.schemaVersion).toBe(CURRENT_EXECUTION_STORE_SCHEMA_VERSION);
    expect(store.isReadOnly).toBe(false);
    expect(store.quickCheck()).toBe("ok");
    expect(store.getAppliedMigrations()).toEqual([
      expect.objectContaining({
        version: 1,
        name: "p0_execution_store",
        min_reader_version: 1,
        min_writer_version: 1,
        applied_at: "2026-07-10T00:00:00.000Z"
      })
    ]);
    expect(adapter.opens[0]).toEqual({ filename: expectedPath, readOnly: false });
    expect(adapter.execs).toContain(`PRAGMA busy_timeout = ${EXECUTION_STORE_BUSY_TIMEOUT_MS}`);
    expect(adapter.execs).toContain("PRAGMA journal_mode = WAL");

    const inspection = new DatabaseSync(expectedPath, { readOnly: true });
    try {
      const tableRows = inspection
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'agent_%' ORDER BY name")
        .all() as Array<{ name: string }>;
      expect(tableRows.map((item) => item.name).sort()).toEqual([...TABLES].sort());
      expect((inspection.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(1);
      expect((inspection.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toBe("wal");
    } finally {
      inspection.close();
    }
  });

  it("persists run, step, attempt, observation, artifact, confirmation, operation, lease, and journal CRUD", () => {
    const projectRoot = temporaryProject();
    const store = track(ExecutionStore.open(projectRoot));
    const firstStep = makeStep("step-1", 0);
    const artifact = makeArtifact("artifact-1", "step-1");
    const created = store.createRun(makeRun(projectRoot, { steps: [firstStep], artifacts: [artifact] }));

    expect(created).toMatchObject({ run_id: "run-1", request_id: "request-1", version: 1 });
    expect(created.steps).toHaveLength(1);
    expect(created.artifacts).toHaveLength(1);
    expect(store.listRuns({ statuses: ["queued"], limit: 10 })).toHaveLength(1);

    const replay = store.createRun(
      makeRun(projectRoot, { run_id: "run-replayed", steps: [], artifacts: [] })
    );
    expect(replay.run_id).toBe("run-1");

    const secondStep = makeStep("step-2", 1);
    const replaced = applied(
      store.replaceSteps({
        run_id: "run-1",
        expected_run_version: 1,
        plan_version: 2,
        steps: [firstStep, secondStep],
        updated_at: "2026-07-10T00:00:01.000Z"
      })
    );
    expect(replaced).toMatchObject({ version: 2, plan_version: 2 });
    expect(replaced.steps.map((step) => step.step_id)).toEqual(["step-1", "step-2"]);

    const updatedStep = applied(
      store.upsertStep("run-1", { ...firstStep, instruction: "Updated instruction" }, 2)
    );
    expect(updatedStep).toMatchObject({ version: 3, instruction: "Updated instruction" });

    const attempt = store.startAttempt({
      attempt_id: "attempt-1",
      run_id: "run-1",
      step_id: "step-1",
      input_digest: "sha256:input",
      idempotency_key: "attempt-key-1",
      started_at: "2026-07-10T00:00:02.000Z"
    });
    expect(attempt).toMatchObject({ attempt: 1, version: 1, status: "running" });
    expect(
      store.startAttempt({
        attempt_id: "attempt-duplicate",
        run_id: "run-1",
        step_id: "step-1",
        input_digest: "sha256:input",
        idempotency_key: "attempt-key-1"
      })
    ).toMatchObject({ attempt_id: "attempt-1" });

    const observation = store.appendObservation({
      observation_id: "observation-1",
      run_id: "run-1",
      step_id: "step-1",
      attempt_id: "attempt-1",
      ok: true,
      summary: "done",
      output_refs: ["artifact-1"],
      saved_paths: [],
      warnings: [],
      verification: { passed: true, severity: "none", checks: [] },
      created_at: "2026-07-10T00:00:03.000Z"
    });
    expect(observation.attempt_id).toBe("attempt-1");
    expect(store.listObservations("run-1", "step-1")).toHaveLength(1);

    const finished = applied(
      store.finishAttempt({
        attempt_id: "attempt-1",
        expected_version: 1,
        status: "done",
        observation_id: "observation-1",
        ended_at: "2026-07-10T00:00:04.000Z"
      })
    );
    expect(finished).toMatchObject({ version: 2, status: "done", observation_id: "observation-1" });
    expect(store.getStep("run-1", "step-1")).toMatchObject({ status: "done", observation_id: "observation-1" });

    expect(store.upsertArtifact("run-1", { ...artifact, chars: 42 })).toMatchObject({ chars: 42, run_id: "run-1" });
    const confirmation = applied(store.upsertConfirmation(makeConfirmation(), 0));
    expect(confirmation).toMatchObject({ confirmation_id: "confirmation-1", version: 1, status: "pending" });
    expect(
      applied(
        store.resolveConfirmation({
          confirmation_id: "confirmation-1",
          expected_version: 1,
          status: "approved",
          resolved_at: "2026-07-10T00:00:05.000Z",
          resolved_by: "user"
        })
      )
    ).toMatchObject({ version: 2, status: "approved" });

    const operation = store.createControlOperation({
      operation_id: "operation-1",
      run_id: "run-1",
      step_id: "step-1",
      confirmation_id: "confirmation-1",
      operation_type: "approve",
      expected_version: 1,
      version: 1,
      status: "pending",
      result: {},
      error_code: "",
      error: "",
      created_at: "2026-07-10T00:00:05.000Z",
      completed_at: ""
    });
    expect(operation.status).toBe("pending");
    expect(
      applied(
        store.completeControlOperation({
          operation_id: "operation-1",
          expected_version: 1,
          status: "applied",
          result: { approved: true },
          completed_at: "2026-07-10T00:00:06.000Z"
        })
      )
    ).toMatchObject({ version: 2, status: "applied", result: { approved: true } });

    const lease = applied(
      store.acquireWriteLease({
        target_path: "C:\\Novel\\Chapter.md",
        owner: "run-1:step-1",
        run_id: "run-1",
        step_id: "step-1",
        attempt_id: "attempt-1",
        acquired_at: "2026-07-10T00:00:06.000Z",
        expires_at: "2026-07-10T00:00:36.000Z"
      })
    );
    expect(lease).toMatchObject({ target_path: "c:/novel/chapter.md", fencing_token: 1, version: 1 });
    expect(
      store.acquireWriteLease({
        target_path: "c:/novel/chapter.md",
        owner: "run-2",
        acquired_at: "2026-07-10T00:00:07.000Z",
        expires_at: "2026-07-10T00:00:37.000Z"
      }).applied
    ).toBe(false);
    const released = applied(
      store.releaseWriteLease({
        target_path: lease.target_path,
        owner: lease.owner,
        fencing_token: lease.fencing_token,
        expected_version: lease.version,
        released_at: "2026-07-10T00:00:08.000Z"
      })
    );
    const reclaimed = applied(
      store.acquireWriteLease({
        target_path: released.target_path,
        owner: "run-2",
        acquired_at: "2026-07-10T00:00:09.000Z",
        expires_at: "2026-07-10T00:00:39.000Z"
      })
    );
    expect(reclaimed.fencing_token).toBe(2);

    const journal = store.createCommitJournal({
      journal_id: "journal-1",
      run_id: "run-1",
      step_id: "step-1",
      attempt_id: "attempt-1",
      action: "replace_file",
      target_path: "C:\\Novel\\Chapter.md",
      base_hash: "sha256:old",
      new_hash: "sha256:new",
      temp_path: "C:\\Novel\\.chapter.tmp",
      backup_path: "C:\\Novel\\.chapter.bak",
      document_version: 7,
      timeline_ref: "timeline-1",
      idempotency_key: "journal-key-1",
      fencing_token: reclaimed.fencing_token,
      stage: "prepared",
      version: 1,
      manifest: { files: 1 },
      error_code: "",
      error: "",
      created_at: "2026-07-10T00:00:10.000Z",
      updated_at: "2026-07-10T00:00:10.000Z",
      finalized_at: ""
    });
    expect(journal.stage).toBe("prepared");
    expect(
      applied(
        store.updateCommitJournal({
          journal_id: "journal-1",
          expected_version: 1,
          expected_stage: "prepared",
          stage: "temp_written",
          updated_at: "2026-07-10T00:00:11.000Z"
        })
      )
    ).toMatchObject({ version: 2, stage: "temp_written" });
    expect(store.listPendingCommitJournal("run-1")).toHaveLength(1);
  });

  it("uses run version CAS and commits state plus strictly increasing outbox events atomically", () => {
    const projectRoot = temporaryProject();
    const store = track(ExecutionStore.open(projectRoot, { backupBeforeMigration: false }));
    store.createRun(makeRun(projectRoot));

    const planning = applied(
      store.updateRunStatus({
        run_id: "run-1",
        expected_version: 1,
        expected_status: "queued",
        status: "planning",
        updated_at: "2026-07-10T01:00:00.000Z",
        event: { event_id: "event-1", event_type: "run.status_changed", payload: { status: "planning" } }
      })
    );
    expect(planning).toMatchObject({ version: 2, status: "planning", last_event_sequence: 1 });

    const stale = store.updateRunStatus({
      run_id: "run-1",
      expected_version: 1,
      status: "running"
    });
    expect(stale.applied).toBe(false);
    if (!stale.applied) {
      expect(stale.current).toMatchObject({ version: 2, status: "planning" });
    }

    const running = applied(
      store.updateRunStatus({
        run_id: "run-1",
        expected_version: 2,
        expected_status: ["planning"],
        status: "running",
        event: { event_id: "event-2", event_type: "run.status_changed", payload: { status: "running" } }
      })
    );
    expect(running).toMatchObject({ version: 3, status: "running", last_event_sequence: 2 });

    const progress = store.appendEventInTransaction("run-1", {
      event_id: "event-3",
      event_type: "step.progress",
      step_id: "step-1",
      payload: { percent: 50 },
      created_at: "2026-07-10T01:00:01.000Z"
    });
    expect(progress.sequence).toBe(3);
    expect(store.appendEventInTransaction("run-1", { event_id: "event-3", event_type: "ignored" })).toEqual(progress);
    expect(store.getRun("run-1")).toMatchObject({ version: 4, last_event_sequence: 3 });
    expect(store.listEvents("run-1", { after: 1 }).map((event) => event.sequence)).toEqual([2, 3]);
    expect(store.listEvents("run-1", { unpublished_only: true })).toHaveLength(3);
    expect(store.markEventsPublished(["event-1", "event-2"])).toBe(2);
    expect(store.listEvents("run-1", { unpublished_only: true }).map((event) => event.event_id)).toEqual(["event-3"]);

    expect(() =>
      store.updateRunStatus({
        run_id: "run-1",
        expected_version: 4,
        status: "paused",
        event: { event_id: "event-3", event_type: "duplicate" }
      })
    ).toThrow("Duplicate event_id");
    expect(store.getRun("run-1")).toMatchObject({ version: 4, status: "running", last_event_sequence: 3 });
  });

  it("reopens durable state and supports runtime heartbeat, release, and stale-run claiming", () => {
    const projectRoot = temporaryProject();
    const first = ExecutionStore.open(projectRoot, { backupBeforeMigration: false });
    first.createRun(
      makeRun(projectRoot, {
        status: "running",
        runtime_instance_id: "runtime-old",
        heartbeat_at: "2026-07-10T02:00:00.000Z",
        lease_expires_at: "2026-07-10T02:00:30.000Z"
      })
    );
    first.startAttempt({
      attempt_id: "attempt-orphaned",
      run_id: "run-1",
      step_id: "step-1",
      input_digest: "sha256:orphaned",
      idempotency_key: "attempt-key-orphaned",
      started_at: "2026-07-10T02:00:00.000Z"
    });
    first.appendEventInTransaction("run-1", { event_id: "event-before-reopen", event_type: "checkpoint" });
    first.close();

    const store = track(ExecutionStore.open(projectRoot, { backupBeforeMigration: false }));
    expect(store.getRun("run-1")).toMatchObject({
      run_id: "run-1",
      status: "running",
      version: 2,
      last_event_sequence: 1
    });
    expect(store.listEvents("run-1")).toHaveLength(1);

    const runtime = store.registerRuntimeInstance({
      runtime_instance_id: "runtime-new",
      started_at: "2026-07-10T02:00:40.000Z",
      heartbeat_at: "2026-07-10T02:00:40.000Z",
      lease_expires_at: "2026-07-10T02:01:10.000Z",
      metadata: { pid: 42 }
    });
    expect(runtime).toMatchObject({ version: 1, status: "active", metadata: { pid: 42 } });

    const claimed = applied(
      store.claimStaleRun({
        run_id: "run-1",
        runtime_instance_id: "runtime-new",
        expected_version: 2,
        stale_before: "2026-07-10T02:00:40.000Z",
        heartbeat_at: "2026-07-10T02:00:40.000Z",
        lease_expires_at: "2026-07-10T02:01:10.000Z",
        recovery_reason: "runtime lease expired",
        event: { event_id: "event-claimed", event_type: "run.claimed" }
      })
    );
    expect(claimed).toMatchObject({
      version: 3,
      status: "paused",
      runtime_instance_id: "runtime-new",
      recovery_reason: "runtime lease expired",
      last_event_sequence: 2
    });
    expect(store.getStep("run-1", "step-1")).toMatchObject({ status: "pending", attempts: 1 });
    expect(store.getAttempt("attempt-orphaned")).toMatchObject({
      status: "interrupted",
      error_code: "RUNTIME_LEASE_EXPIRED",
      ended_at: "2026-07-10T02:00:40.000Z"
    });
    expect(
      store.claimStaleRun({
        run_id: "run-1",
        runtime_instance_id: "runtime-new",
        stale_before: "2026-07-10T02:00:50.000Z",
        lease_expires_at: "2026-07-10T02:01:20.000Z",
        recovery_reason: "should not claim"
      }).applied
    ).toBe(false);

    const heartbeat = applied(
      store.heartbeatRuntimeInstance({
        runtime_instance_id: "runtime-new",
        expected_version: 1,
        heartbeat_at: "2026-07-10T02:00:50.000Z",
        lease_expires_at: "2026-07-10T02:01:20.000Z"
      })
    );
    expect(heartbeat).toMatchObject({ version: 2, heartbeat_at: "2026-07-10T02:00:50.000Z" });
    expect(
      applied(
        store.releaseRuntimeInstance({
          runtime_instance_id: "runtime-new",
          expected_version: 2,
          released_at: "2026-07-10T02:00:55.000Z"
        })
      )
    ).toMatchObject({ version: 3, status: "released" });
  });

  it("reopens an unknown higher schema read-only and rejects every store write", () => {
    const projectRoot = temporaryProject();
    const databasePath = resolveExecutionStorePath(projectRoot);
    const first = ExecutionStore.open(projectRoot, { backupBeforeMigration: false });
    first.createRun(makeRun(projectRoot));
    first.close();

    const future = new DatabaseSync(databasePath);
    future.exec(`PRAGMA user_version = ${CURRENT_EXECUTION_STORE_SCHEMA_VERSION + 1}`);
    future.close();

    const store = track(ExecutionStore.open(projectRoot));
    expect(store.isReadOnly).toBe(true);
    expect(store.schemaVersion).toBe(CURRENT_EXECUTION_STORE_SCHEMA_VERSION + 1);
    expect(store.getRun("run-1")).toMatchObject({ run_id: "run-1" });
    expect(() =>
      store.appendEventInTransaction("run-1", { event_type: "must-not-write" })
    ).toThrow(UnsupportedExecutionStoreSchemaError);
  });

  it("isolates an unknown high schema without a compatibility view from all writable opens", () => {
    const projectRoot = temporaryProject();
    const databasePath = resolveExecutionStorePath(projectRoot);
    mkdirSync(path.dirname(databasePath), { recursive: true });
    const future = new DatabaseSync(databasePath);
    future.exec(`PRAGMA user_version = ${CURRENT_EXECUTION_STORE_SCHEMA_VERSION + 7}`);
    future.close();

    const adapter = new RecordingAdapter();
    const store = track(ExecutionStore.open(projectRoot, { adapter }));

    expect(store.isReadOnly).toBe(true);
    expect(store.schemaVersion).toBe(CURRENT_EXECUTION_STORE_SCHEMA_VERSION + 7);
    expect(store.getAppliedMigrations()).toEqual([]);
    expect(adapter.opens).toEqual([{ filename: databasePath, readOnly: true }]);
    expect(() => store.createRun(makeRun(projectRoot))).toThrow(UnsupportedExecutionStoreSchemaError);
    const inspection = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(
        inspection.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'agent_%'").all()
      ).toEqual([]);
    } finally {
      inspection.close();
    }
  });

  it("validates and atomically publishes a pre-migration backup before upgrading an existing database", () => {
    const projectRoot = temporaryProject();
    const databasePath = createPreMigrationDatabase(projectRoot);
    const store = track(
      ExecutionStore.open(projectRoot, { now: () => new Date("2026-07-10T03:00:00.000Z") })
    );

    const backupPath = findMigrationBackups(databasePath)[0];
    if (!backupPath) {
      throw new Error("Expected a validated migration backup");
    }
    expect(backupPath).toBe(`${databasePath}.backup-v0-2026-07-10T03-00-00-000Z`);
    expect(readdirSync(path.dirname(databasePath)).some((name) => name.includes(".partial-"))).toBe(false);
    expect(store.schemaVersion).toBe(CURRENT_EXECUTION_STORE_SCHEMA_VERSION);
    expect(readLegacyMarker(databasePath)).toBe("before-upgrade");
    expect(readLegacyMarker(backupPath)).toBe("before-upgrade");
    expect(readUserVersion(backupPath)).toBe(0);
    expect(readQuickCheck(backupPath)).toBe("ok");
  });

  it("leaves the original database intact when backup validation or disk capacity checks fail", () => {
    const projectRoot = temporaryProject();
    const databasePath = createPreMigrationDatabase(projectRoot);
    const brokenCopy = withFileSystem({
      copy: (_source, destination) => writeFileSync(destination, "not a sqlite database")
    });

    expect(() => ExecutionStore.open(projectRoot, { fileSystem: brokenCopy })).toThrow();
    expect(readLegacyMarker(databasePath)).toBe("before-upgrade");
    expect(readUserVersion(databasePath)).toBe(0);
    expect(readQuickCheck(databasePath)).toBe("ok");
    expect(findMigrationBackups(databasePath)).toEqual([]);
    expect(readdirSync(path.dirname(databasePath)).some((name) => name.includes(".partial-"))).toBe(false);

    expect(() =>
      ExecutionStore.open(projectRoot, {
        fileSystem: withFileSystem({ availableBytes: () => 0 })
      })
    ).toThrow("Insufficient free space for execution store migration backup");
    expect(readLegacyMarker(databasePath)).toBe("before-upgrade");
    expect(readUserVersion(databasePath)).toBe(0);
    expect(readQuickCheck(databasePath)).toBe("ok");
    expect(findMigrationBackups(databasePath)).toEqual([]);
  });

  it("rolls back a locked migration and does not alter a corrupted source database", () => {
    const projectRoot = temporaryProject();
    const databasePath = createPreMigrationDatabase(projectRoot);
    const adapter = new FaultInjectingAdapter((source) =>
      source === "BEGIN EXCLUSIVE" ? new Error("SQLITE_BUSY: injected migration lock") : null
    );

    expect(() => ExecutionStore.open(projectRoot, { adapter })).toThrow("SQLITE_BUSY: injected migration lock");
    expect(readLegacyMarker(databasePath)).toBe("before-upgrade");
    expect(readUserVersion(databasePath)).toBe(0);
    expect(readQuickCheck(databasePath)).toBe("ok");

    const corruptProject = temporaryProject();
    const corruptPath = resolveExecutionStorePath(corruptProject);
    mkdirSync(path.dirname(corruptPath), { recursive: true });
    writeFileSync(corruptPath, "this is not a SQLite database");
    const corruptBytes = readFileSync(corruptPath);
    expect(() => ExecutionStore.open(corruptProject)).toThrow();
    expect(readFileSync(corruptPath)).toEqual(corruptBytes);
  });
});

function temporaryProject(): string {
  const project = mkdtempSync(path.join(tmpdir(), "execution-store-"));
  projects.push(project);
  return project;
}

function track(store: ExecutionStore): ExecutionStore {
  stores.push(store);
  return store;
}

function applied<Value>(result: ExecutionCasResult<Value>): Value {
  if (!result.applied) {
    throw new Error(`Expected CAS to apply; current value: ${JSON.stringify(result.current)}`);
  }
  return result.value;
}

function makeRun(projectRoot: string, overrides: Record<string, unknown> = {}): AgentRunState {
  return {
    schema_version: 1,
    version: 1,
    run_id: "run-1",
    request_id: "request-1",
    conversation_id: "conversation-1",
    project_id: "project-1",
    project_path: projectRoot,
    goal: {
      instruction: "Write a chapter",
      autonomy_mode: "execute",
      requested_outputs: [],
      success_criteria: ["chapter exists"],
      assumptions: [],
      blocking_questions: [],
      request_snapshot: {
        content: "Write a chapter",
        attachment_refs: [],
        selected_file_refs: [],
        settings_snapshot: {},
        feature_flag_snapshot: {}
      }
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
    steps: [makeStep("step-1", 0)],
    artifacts: [],
    budget: {
      max_steps: 3,
      max_replans: 1,
      max_attempts_per_step: 2,
      max_duration_ms: 300_000,
      max_input_tokens: 32_000,
      max_output_tokens: 8_000,
      max_cost: 1,
      cost_currency: "USD",
      pricing_snapshot_id: "pricing-1",
      used_steps: 0,
      used_replans: 0,
      used_input_tokens: 0,
      used_output_tokens: 0,
      estimated_cost: 0
    },
    last_event_sequence: 0,
    created_at: "2026-07-10T00:00:00.000Z",
    updated_at: "2026-07-10T00:00:00.000Z",
    ...overrides
  } as unknown as AgentRunState;
}

function makeStep(stepId: string, index: number): AgentExecutionStep {
  return {
    step_id: stepId,
    version: 1,
    index,
    type: "skill",
    action_id: `action-${stepId}`,
    skill_id: "draft",
    instruction: "Draft",
    necessity: "required",
    input_refs: [],
    required_permissions: [],
    base_document_versions: {},
    base_content_hashes: {},
    idempotency_key: `step-key-${stepId}`,
    expected_output: {
      artifact_kind: "generated_cache",
      allow_empty: false,
      format_schema: {},
      target_path_pattern: "chapters/*.md",
      minimum_checks: []
    },
    status: "pending",
    attempts: 0,
    max_attempts: 2,
    retryable: true,
    requires_confirmation: false,
    observation_id: "",
    error_code: "",
    error: "",
    started_at: "",
    ended_at: ""
  } as unknown as AgentExecutionStep;
}

function makeArtifact(artifactId: string, stepId: string): AgentArtifactRef {
  return {
    artifact_id: artifactId,
    kind: "generated_cache",
    path: "",
    cache_id: "cache-1",
    content_hash: "sha256:artifact",
    document_version: 0,
    chars: 12,
    created_by_step_id: stepId,
    created_by_attempt_id: ""
  } as AgentArtifactRef;
}

function makeConfirmation(): AgentConfirmation {
  return {
    confirmation_id: "confirmation-1",
    version: 1,
    run_id: "run-1",
    step_id: "step-1",
    action: "write_file",
    risk_level: "high",
    summary: "Write chapter",
    target_paths: ["chapters/1.md"],
    expected_versions: { "chapters/1.md": 1 },
    expected_hashes: { "chapters/1.md": "sha256:old" },
    proposed_artifact_refs: ["artifact-1"],
    status: "pending",
    expires_at: "2026-07-10T01:00:00.000Z",
    resolved_at: "",
    resolved_by: "user"
  } as AgentConfirmation;
}

function createPreMigrationDatabase(projectRoot: string): string {
  const databasePath = resolveExecutionStorePath(projectRoot);
  mkdirSync(path.dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  try {
    database.exec("CREATE TABLE legacy_marker (value TEXT NOT NULL); INSERT INTO legacy_marker VALUES ('before-upgrade')");
    database.exec("PRAGMA user_version = 0");
  } finally {
    database.close();
  }
  return databasePath;
}

function findMigrationBackups(databasePath: string): string[] {
  return readdirSync(path.dirname(databasePath))
    .filter((name) => name.startsWith(`${path.basename(databasePath)}.backup-`))
    .map((name) => path.join(path.dirname(databasePath), name));
}

function readLegacyMarker(databasePath: string): string {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return (database.prepare("SELECT value FROM legacy_marker").get() as { value: string }).value;
  } finally {
    database.close();
  }
}

function readUserVersion(databasePath: string): number {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return (database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  } finally {
    database.close();
  }
}

function readQuickCheck(databasePath: string): string {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return (database.prepare("PRAGMA quick_check").get() as { quick_check: string }).quick_check;
  } finally {
    database.close();
  }
}

function withFileSystem(overrides: Partial<ExecutionStoreFileSystem>): ExecutionStoreFileSystem {
  return {
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
    },
    ...overrides
  };
}

class RecordingAdapter implements ExecutionDatabaseAdapter {
  readonly opens: Array<{ filename: string; readOnly: boolean }> = [];
  readonly execs: string[] = [];
  private readonly delegate = new NodeSqliteExecutionDatabaseAdapter();

  open(filename: string, options: ExecutionDatabaseOpenOptions = {}): ExecutionDatabase {
    this.opens.push({ filename, readOnly: options.readOnly ?? false });
    return new RecordingDatabase(this.delegate.open(filename, options), this.execs);
  }
}

class RecordingDatabase implements ExecutionDatabase {
  constructor(
    private readonly delegate: ExecutionDatabase,
    private readonly execs: string[]
  ) {}

  exec(source: string): void {
    this.execs.push(source);
    this.delegate.exec(source);
  }

  prepare(source: string) {
    return this.delegate.prepare(source);
  }

  close(): void {
    this.delegate.close();
  }
}

class FaultInjectingAdapter implements ExecutionDatabaseAdapter {
  private readonly delegate = new NodeSqliteExecutionDatabaseAdapter();

  constructor(private readonly failureFor: (source: string) => Error | null) {}

  open(filename: string, options?: ExecutionDatabaseOpenOptions): ExecutionDatabase {
    return new FaultInjectingDatabase(this.delegate.open(filename, options), this.failureFor);
  }
}

class FaultInjectingDatabase implements ExecutionDatabase {
  constructor(
    private readonly delegate: ExecutionDatabase,
    private readonly failureFor: (source: string) => Error | null
  ) {}

  exec(source: string): void {
    const error = this.failureFor(source);
    if (error) {
      throw error;
    }
    this.delegate.exec(source);
  }

  prepare(source: string) {
    return this.delegate.prepare(source);
  }

  close(): void {
    this.delegate.close();
  }
}
