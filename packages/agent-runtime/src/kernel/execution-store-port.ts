import type {
  AgentArtifactRef,
  AgentConfirmation,
  AgentExecutionStep,
  AgentObservation,
  AgentRunEvent,
  AgentRunState,
  AgentRunStatus,
  AgentStepAttempt,
  AgentStepStatus
} from "@xiaoshuo/shared";

export type ExecutionSqlValue = string | number | bigint | Uint8Array | null;

export type ExecutionDatabaseRunResult = {
  changes: number | bigint;
  lastInsertRowid: number | bigint;
};

export interface ExecutionDatabaseStatement {
  run(...parameters: ExecutionSqlValue[]): ExecutionDatabaseRunResult;
  get(...parameters: ExecutionSqlValue[]): unknown;
  all(...parameters: ExecutionSqlValue[]): unknown[];
}

export interface ExecutionDatabase {
  exec(source: string): void;
  prepare(source: string): ExecutionDatabaseStatement;
  close(): void;
}

export type ExecutionDatabaseOpenOptions = {
  readOnly?: boolean;
};

export interface ExecutionDatabaseAdapter {
  open(filename: string, options?: ExecutionDatabaseOpenOptions): ExecutionDatabase;
}

/**
 * Filesystem operations used while opening and migrating an execution store.
 * Keeping this narrow makes storage-failure handling deterministic in tests.
 */
export interface ExecutionStoreFileSystem {
  mkdir(directory: string): void;
  exists(filename: string): boolean;
  fileSize(filename: string): number;
  availableBytes(directory: string): number;
  copy(source: string, destination: string): void;
  rename(source: string, destination: string): void;
  remove(filename: string): void;
}

export type ExecutionStoreMigrationRecord = {
  version: number;
  name: string;
  checksum: string;
  applied_at: string;
  execution_ms: number;
  min_reader_version: number;
  min_writer_version: number;
  rollback_notes: string;
};

export type ExecutionCasResult<Value> =
  | { applied: true; value: Value }
  | { applied: false; current: Value | null };

export type ExecutionRunEventInput = {
  event_id?: string;
  event_type: string;
  step_id?: string;
  payload?: Record<string, unknown>;
  created_at?: string;
};

export type ExecutionRunListOptions = {
  statuses?: readonly AgentRunStatus[];
  project_id?: string;
  before_updated_at?: string;
  limit?: number;
};

export type UpdateRunStatusInput = {
  run_id: string;
  expected_version: number;
  expected_status?: AgentRunStatus | readonly AgentRunStatus[];
  status: AgentRunStatus;
  conversation_id?: string;
  updated_at?: string;
  runtime_instance_id?: string;
  heartbeat_at?: string;
  lease_expires_at?: string;
  pause_requested_at?: string;
  cancel_requested_at?: string;
  recovery_reason?: string;
  error_code?: string;
  error?: string;
  event?: ExecutionRunEventInput;
};

export type HeartbeatRunLeaseInput = {
  run_id: string;
  runtime_instance_id: string;
  heartbeat_at: string;
  lease_expires_at: string;
};

export type ReplaceRunStepsInput = {
  run_id: string;
  expected_run_version: number;
  steps: AgentExecutionStep[];
  plan_version?: number;
  updated_at?: string;
  event?: ExecutionRunEventInput;
};

export type StoredAgentExecutionStep = AgentExecutionStep & {
  version: number;
  plan_version?: number;
};

export type ExecutionStepAttempt = AgentStepAttempt & {
  version: number;
};

export type StartAttemptInput = {
  attempt_id: string;
  run_id: string;
  step_id: string;
  attempt?: number;
  input_digest: string;
  idempotency_key: string;
  model_call_refs?: string[];
  started_at?: string;
};

export type FinishAttemptInput = {
  attempt_id: string;
  expected_version: number;
  status: "interrupted" | "done" | "failed" | "cancelled";
  observation_id?: string;
  model_call_refs?: string[];
  error_code?: string;
  error?: string;
  ended_at?: string;
  step_status?: AgentStepStatus;
};

export type StoredAgentObservation = AgentObservation & {
  attempt_id: string;
};

export type StoredAgentArtifact = AgentArtifactRef & {
  run_id: string;
  created_by_attempt_id?: string;
};

export type StoredAgentConfirmation = AgentConfirmation & {
  version: number;
};

export type ResolveConfirmationInput = {
  confirmation_id: string;
  expected_version: number;
  status: "approved" | "rejected" | "expired" | "superseded";
  resolved_at?: string;
  resolved_by?: "user" | "policy";
};

export type ExecutionEventListOptions = {
  after?: number;
  limit?: number;
  unpublished_only?: boolean;
};

export type StoredAgentRunEvent = AgentRunEvent & {
  published_at?: string;
};

export type ExecutionControlOperation = {
  operation_id: string;
  run_id: string;
  step_id: string;
  confirmation_id: string;
  operation_type: string;
  expected_version: number;
  version: number;
  status: "pending" | "applied" | "rejected" | "failed";
  result: Record<string, unknown>;
  error_code: string;
  error: string;
  created_at: string;
  completed_at: string;
};

export type CompleteControlOperationInput = {
  operation_id: string;
  expected_version: number;
  status: "applied" | "rejected" | "failed";
  result?: Record<string, unknown>;
  error_code?: string;
  error?: string;
  completed_at?: string;
};

export type ExecutionWriteLease = {
  target_path: string;
  owner: string;
  run_id: string;
  step_id: string;
  attempt_id: string;
  fencing_token: number;
  version: number;
  acquired_at: string;
  expires_at: string;
  released_at: string;
};

export type AcquireWriteLeaseInput = {
  target_path: string;
  owner: string;
  run_id?: string;
  step_id?: string;
  attempt_id?: string;
  acquired_at?: string;
  expires_at: string;
};

export type RenewWriteLeaseInput = {
  target_path: string;
  owner: string;
  fencing_token: number;
  expected_version: number;
  expires_at: string;
};

export type ReleaseWriteLeaseInput = {
  target_path: string;
  owner: string;
  fencing_token: number;
  expected_version: number;
  released_at?: string;
};

export type ExecutionRuntimeInstance = {
  runtime_instance_id: string;
  version: number;
  status: "active" | "released";
  started_at: string;
  heartbeat_at: string;
  lease_expires_at: string;
  released_at: string;
  metadata: Record<string, unknown>;
};

export type RegisterRuntimeInstanceInput = {
  runtime_instance_id: string;
  started_at?: string;
  heartbeat_at?: string;
  lease_expires_at: string;
  metadata?: Record<string, unknown>;
};

export type HeartbeatRuntimeInstanceInput = {
  runtime_instance_id: string;
  expected_version: number;
  heartbeat_at?: string;
  lease_expires_at: string;
};

export type ReleaseRuntimeInstanceInput = {
  runtime_instance_id: string;
  expected_version: number;
  released_at?: string;
};

export type ClaimStaleRunInput = {
  run_id: string;
  runtime_instance_id: string;
  expected_version?: number;
  stale_before: string;
  heartbeat_at?: string;
  lease_expires_at: string;
  recovery_reason: string;
  statuses?: readonly string[];
  event?: ExecutionRunEventInput;
};

export type ExecutionCommitJournalStage =
  | "prepared"
  | "temp_written"
  | "file_replaced"
  | "db_committed"
  | "finalized"
  | "recovery_required";

export type ExecutionCommitJournalEntry = {
  journal_id: string;
  run_id: string;
  step_id: string;
  attempt_id: string;
  action: string;
  target_path: string;
  base_hash: string;
  new_hash: string;
  temp_path: string;
  backup_path: string;
  document_version: number;
  timeline_ref: string;
  idempotency_key: string;
  fencing_token: number;
  stage: ExecutionCommitJournalStage;
  version: number;
  manifest: Record<string, unknown>;
  error_code: string;
  error: string;
  created_at: string;
  updated_at: string;
  finalized_at: string;
};

export type UpdateCommitJournalInput = {
  journal_id: string;
  expected_version: number;
  expected_stage?: ExecutionCommitJournalStage;
  stage: ExecutionCommitJournalStage;
  manifest?: Record<string, unknown>;
  error_code?: string;
  error?: string;
  updated_at?: string;
  finalized_at?: string;
};

export interface ExecutionStorePort {
  readonly projectRoot: string;
  readonly databasePath: string;
  readonly schemaVersion: number;
  readonly isReadOnly: boolean;

  close(): void;
  getAppliedMigrations(): ExecutionStoreMigrationRecord[];
  quickCheck(): string;
  checkpoint(mode?: "PASSIVE" | "FULL" | "RESTART" | "TRUNCATE"): void;
  createRun(run: AgentRunState, event?: ExecutionRunEventInput): AgentRunState;
  getRun(runId: string): AgentRunState | null;
  getRunByRequestId(requestId: string, projectId?: string): AgentRunState | null;
  listRuns(options?: ExecutionRunListOptions): AgentRunState[];
  updateRunStatus(input: UpdateRunStatusInput): ExecutionCasResult<AgentRunState>;
  heartbeatRunLease(input: HeartbeatRunLeaseInput): boolean;
  replaceSteps(input: ReplaceRunStepsInput): ExecutionCasResult<AgentRunState>;
  upsertStep(runId: string, step: AgentExecutionStep, expectedVersion?: number): ExecutionCasResult<StoredAgentExecutionStep>;
  getStep(runId: string, stepId: string): StoredAgentExecutionStep | null;
  listSteps(runId: string, planVersion?: number): StoredAgentExecutionStep[];
  listAllSteps(runId: string): StoredAgentExecutionStep[];
  startAttempt(input: StartAttemptInput): ExecutionStepAttempt;
  finishAttempt(input: FinishAttemptInput): ExecutionCasResult<ExecutionStepAttempt>;
  getAttempt(attemptId: string): ExecutionStepAttempt | null;
  listAttempts(runId: string, stepId?: string): ExecutionStepAttempt[];
  appendObservation(observation: StoredAgentObservation): StoredAgentObservation;
  getObservation(observationId: string): StoredAgentObservation | null;
  listObservations(runId: string, stepId?: string): StoredAgentObservation[];
  upsertArtifact(runId: string, artifact: AgentArtifactRef): StoredAgentArtifact;
  getArtifact(artifactId: string): StoredAgentArtifact | null;
  listArtifacts(runId: string): StoredAgentArtifact[];
  upsertConfirmation(
    confirmation: AgentConfirmation,
    expectedVersion?: number
  ): ExecutionCasResult<StoredAgentConfirmation>;
  getConfirmation(confirmationId: string): StoredAgentConfirmation | null;
  listConfirmations(runId: string, status?: string): StoredAgentConfirmation[];
  resolveConfirmation(input: ResolveConfirmationInput): ExecutionCasResult<StoredAgentConfirmation>;
  appendEventInTransaction(runId: string, event: ExecutionRunEventInput): StoredAgentRunEvent;
  listEvents(runId: string, options?: ExecutionEventListOptions): StoredAgentRunEvent[];
  markEventsPublished(eventIds: readonly string[], publishedAt?: string): number;
  createControlOperation(operation: ExecutionControlOperation): ExecutionControlOperation;
  getControlOperation(operationId: string): ExecutionControlOperation | null;
  listControlOperations(runId: string): ExecutionControlOperation[];
  completeControlOperation(input: CompleteControlOperationInput): ExecutionCasResult<ExecutionControlOperation>;
  acquireWriteLease(input: AcquireWriteLeaseInput): ExecutionCasResult<ExecutionWriteLease>;
  getWriteLease(targetPath: string): ExecutionWriteLease | null;
  renewWriteLease(input: RenewWriteLeaseInput): ExecutionCasResult<ExecutionWriteLease>;
  releaseWriteLease(input: ReleaseWriteLeaseInput): ExecutionCasResult<ExecutionWriteLease>;
  registerRuntimeInstance(input: RegisterRuntimeInstanceInput): ExecutionRuntimeInstance;
  getRuntimeInstance(runtimeInstanceId: string): ExecutionRuntimeInstance | null;
  heartbeatRuntimeInstance(input: HeartbeatRuntimeInstanceInput): ExecutionCasResult<ExecutionRuntimeInstance>;
  releaseRuntimeInstance(input: ReleaseRuntimeInstanceInput): ExecutionCasResult<ExecutionRuntimeInstance>;
  claimStaleRun(input: ClaimStaleRunInput): ExecutionCasResult<AgentRunState>;
  createCommitJournal(entry: ExecutionCommitJournalEntry): ExecutionCommitJournalEntry;
  getCommitJournal(journalId: string): ExecutionCommitJournalEntry | null;
  listPendingCommitJournal(runId?: string): ExecutionCommitJournalEntry[];
  updateCommitJournal(input: UpdateCommitJournalInput): ExecutionCasResult<ExecutionCommitJournalEntry>;
}
