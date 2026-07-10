import {
  agentExecutionStepSchema,
  agentObservationSchema,
  agentRunRequestSchema,
  agentRunStateSchema,
  type AgentExecutionStep,
  type AgentExecutionStepType,
  type AgentRunRequest,
  type AgentRunResponse,
  type AgentRunState,
  type AgentRunStatus
} from "@xiaoshuo/shared";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { isCancellationError } from "../cancellation.js";
import { openExecutionStore } from "./execution-store.js";
import type {
  ExecutionControlOperation,
  ExecutionRuntimeInstance,
  ExecutionStorePort,
  StoredAgentRunEvent
} from "./execution-store-port.js";
import {
  assertRunStatusTransition,
  assertStepStatusTransition,
  requestCooperativeRunControl
} from "./execution-state-machine.js";

const DEFAULT_HEARTBEAT_INTERVAL_MS = 10_000;
const DEFAULT_LEASE_TTL_MS = 30_000;

export type RunCoordinatorOptions = {
  projectRoot: string;
  store?: ExecutionStorePort;
  runtimeInstanceId?: string;
  idFactory?: () => string;
  now?: () => Date;
  heartbeatIntervalMs?: number;
  leaseTtlMs?: number;
  autoHeartbeat?: boolean;
};

export type BeginRunOptions = {
  projectId?: string;
  stepType?: AgentExecutionStepType;
  actionId?: string;
  skillId?: string;
  retryable?: boolean;
  requiresConfirmation?: boolean;
  signal?: AbortSignal;
};

export type DurableRunExecution = {
  run_id: string;
  request_id: string;
  step_id: string;
  attempt_id: string;
  signal: AbortSignal;
};

type ActiveExecution = DurableRunExecution & {
  controller: AbortController;
  cleanupExternalSignal: () => void;
  control: "" | "pause" | "cancel";
};

export class RunRequestReplayError extends Error {
  readonly run: AgentRunState;

  constructor(run: AgentRunState) {
    super(`Agent request ${run.request_id || run.run_id} already belongs to run ${run.run_id}`);
    this.name = "RunRequestReplayError";
    this.run = run;
  }
}

export class RunCoordinatorConflictError extends Error {
  readonly runId: string;

  constructor(runId: string, message: string) {
    super(message);
    this.name = "RunCoordinatorConflictError";
    this.runId = runId;
  }
}

export class RunCoordinator {
  readonly projectRoot: string;
  readonly runtimeInstanceId: string;
  readonly store: ExecutionStorePort;

  private readonly now: () => Date;
  private readonly idFactory: () => string;
  private readonly heartbeatIntervalMs: number;
  private readonly leaseTtlMs: number;
  private readonly ownsStore: boolean;
  private readonly active = new Map<string, ActiveExecution>();
  private runtimeInstance: ExecutionRuntimeInstance;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private closed = false;

  constructor(options: RunCoordinatorOptions) {
    this.projectRoot = path.resolve(options.projectRoot);
    this.runtimeInstanceId = options.runtimeInstanceId || `runtime_${compactUuid()}`;
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? compactUuid;
    this.heartbeatIntervalMs = positiveInterval(options.heartbeatIntervalMs, DEFAULT_HEARTBEAT_INTERVAL_MS);
    this.leaseTtlMs = positiveInterval(options.leaseTtlMs, DEFAULT_LEASE_TTL_MS);
    this.store = options.store ?? openExecutionStore(this.projectRoot);
    this.ownsStore = !options.store;

    const timestamp = this.timestamp();
    this.runtimeInstance = this.store.registerRuntimeInstance({
      runtime_instance_id: this.runtimeInstanceId,
      started_at: timestamp,
      heartbeat_at: timestamp,
      lease_expires_at: this.leaseExpiry(timestamp),
      metadata: { pid: typeof process !== "undefined" ? process.pid : 0 }
    });

    if (options.autoHeartbeat !== false) {
      this.heartbeatTimer = setInterval(() => this.heartbeat(), this.heartbeatIntervalMs);
      this.heartbeatTimer.unref?.();
    }
  }

  beginRun(request: AgentRunRequest, options: BeginRunOptions = {}): DurableRunExecution {
    this.assertOpen();
    if (options.signal?.aborted) {
      throw options.signal.reason instanceof Error ? options.signal.reason : new Error("操作已取消");
    }

    const runId = `run_${this.idFactory()}`;
    const requestId = String(request.request_id || "").trim() || `req_${this.idFactory()}`;
    const stepId = `step_${this.idFactory()}`;
    const attemptId = `attempt_${this.idFactory()}`;
    const createdAt = this.timestamp();
    const requestSnapshot = sanitizeRequestSnapshot(request);
    const step = this.createRootStep(runId, stepId, request, options);
    const state = agentRunStateSchema.parse({
      schema_version: this.store.schemaVersion,
      version: 1,
      run_id: runId,
      request_id: requestId,
      conversation_id: request.conversation_id || "",
      project_id: options.projectId || projectId(this.projectRoot),
      project_path: this.projectRoot,
      goal: {
        instruction: request.content || "",
        autonomy_mode: request.autonomy_mode || "plan",
        requested_outputs: [step.expected_output],
        success_criteria: [],
        assumptions: [],
        blocking_questions: [],
        request_snapshot: {
          content: request.content || "",
          attachment_refs: request.attachment_ids || [],
          selected_file_refs: uniqueStrings([
            request.current_path || "",
            ...(request.reference_paths || []),
            ...(request.confirmed_reference_paths || [])
          ]),
          settings_snapshot: { agent_request: requestSnapshot },
          feature_flag_snapshot: {}
        }
      },
      goal_revision: 1,
      plan_version: 1,
      plan_status: "approved",
      status: "queued",
      current_step_id: stepId,
      runtime_instance_id: this.runtimeInstanceId,
      heartbeat_at: createdAt,
      lease_expires_at: this.leaseExpiry(createdAt),
      pause_requested_at: "",
      cancel_requested_at: "",
      recovery_reason: "",
      error_code: "",
      error: "",
      steps: [step],
      artifacts: [],
      budget: {},
      last_event_sequence: 0,
      created_at: createdAt,
      updated_at: createdAt
    });

    const created = this.store.createRun(state, {
      event_type: "run.created",
      step_id: stepId,
      payload: { request_id: requestId }
    });
    if (created.run_id !== runId) {
      throw new RunRequestReplayError(created);
    }

    this.transitionRun(runId, "planning", "run.planning");
    this.transitionRun(runId, "running", "run.started");
    const attempt = this.store.startAttempt({
      attempt_id: attemptId,
      run_id: runId,
      step_id: stepId,
      attempt: 1,
      input_digest: digestJson(requestSnapshot),
      idempotency_key: digestJson({ run_id: runId, step_id: stepId, attempt: 1, action: step.action_id }),
      started_at: createdAt
    });

    const controller = new AbortController();
    const execution: ActiveExecution = {
      run_id: runId,
      request_id: requestId,
      step_id: stepId,
      attempt_id: attempt.attempt_id,
      signal: controller.signal,
      controller,
      cleanupExternalSignal: () => undefined,
      control: ""
    };
    execution.cleanupExternalSignal = this.bindExternalSignal(execution, options.signal);
    this.active.set(runId, execution);
    return publicExecution(execution);
  }

  completeRun(execution: DurableRunExecution, response: AgentRunResponse): AgentRunState {
    const active = this.requireActive(execution.run_id, execution.attempt_id);
    const current = this.requireRun(execution.run_id);
    if (current.status === "cancelling" || active.control === "cancel") {
      return this.settleCancelled(active, "RUN_CANCELLED", "任务已取消");
    }
    if (active.control === "pause" || current.pause_requested_at) {
      return this.settlePaused(active, new Error("Pause checkpoint reached"));
    }

    const observationId = `observation_${this.idFactory()}`;
    const attempt = this.store.finishAttempt({
      attempt_id: execution.attempt_id,
      expected_version: 1,
      status: "done",
      step_status: "done",
      observation_id: observationId,
      ended_at: this.timestamp()
    });
    if (!attempt.applied) {
      throw new RunCoordinatorConflictError(execution.run_id, "Step attempt changed before completion");
    }
    this.store.appendObservation(
      agentObservationSchema.parse({
        observation_id: observationId,
        run_id: execution.run_id,
        step_id: execution.step_id,
        attempt_id: execution.attempt_id,
        ok: true,
        summary: truncate(response.reply || response.skill_result?.result || "任务已完成", 2_000),
        output_refs: [],
        saved_paths: response.saved_paths || [],
        warnings: [],
        verification: { passed: true, severity: "none", checks: [] },
        created_at: this.timestamp()
      })
    );
    const completed = this.transitionRun(execution.run_id, "completed", "run.completed", {
      saved_paths: response.saved_paths || []
    }, { conversation_id: response.conversation?.id || undefined });
    this.releaseActive(active);
    return completed;
  }

  failRun(execution: DurableRunExecution, error: unknown): AgentRunState {
    const active = this.requireActive(execution.run_id, execution.attempt_id);
    if (active.control === "pause") {
      return this.settlePaused(active, error);
    }
    if (active.control === "cancel" || isCancellationError(error, execution.signal)) {
      return this.settleCancelled(active, "RUN_CANCELLED", errorMessage(error));
    }

    const message = errorMessage(error);
    const code = errorCode(error, "RUN_FAILED");
    const attempt = this.store.finishAttempt({
      attempt_id: execution.attempt_id,
      expected_version: 1,
      status: "failed",
      step_status: "failed",
      error_code: code,
      error: message,
      ended_at: this.timestamp()
    });
    if (!attempt.applied) {
      throw new RunCoordinatorConflictError(execution.run_id, "Step attempt changed before failure was recorded");
    }
    const failed = this.transitionRun(execution.run_id, "failed", "run.failed", { error_code: code }, {
      error_code: code,
      error: message
    });
    this.releaseActive(active);
    return failed;
  }

  requestPause(runId: string, operationId = `op_${this.idFactory()}`, expectedVersion?: number): AgentRunState {
    const replay = this.replayControlOperation(runId, operationId, "pause");
    if (replay) {
      return replay;
    }
    const run = this.requireRun(runId);
    const operation = this.createControlOperation(run, operationId, "pause", expectedVersion);
    const active = this.active.get(runId);
    try {
      const requestedAt = this.timestamp();
      const decision = requestCooperativeRunControl(run.status, "pause", requestedAt, Boolean(active));
      if (active) {
        active.control = "pause";
      }
      const paused = this.updateRun(run, decision.status, "run.pause_requested", {
        operation_id: operationId,
        checkpoint_required: decision.checkpoint_required
      }, { pause_requested_at: requestedAt });
      this.completeControlOperation(operation, "applied", paused);
      return paused;
    } catch (error) {
      this.completeControlOperation(operation, "failed", run, error);
      throw error;
    }
  }

  requestCancel(runId: string, operationId = `op_${this.idFactory()}`, expectedVersion?: number): AgentRunState {
    const replay = this.replayControlOperation(runId, operationId, "cancel");
    if (replay) {
      return replay;
    }
    const run = this.requireRun(runId);
    const operation = this.createControlOperation(run, operationId, "cancel", expectedVersion);
    const active = this.active.get(runId);
    try {
      const requestedAt = this.timestamp();
      const decision = requestCooperativeRunControl(run.status, "cancel", requestedAt, Boolean(active));
      const cancelling = this.updateRun(run, decision.status, "run.cancel_requested", {
        operation_id: operationId,
        checkpoint_required: decision.checkpoint_required
      }, { cancel_requested_at: requestedAt });
      if (active) {
        active.control = "cancel";
        active.controller.abort(new Error("操作已取消"));
        this.completeControlOperation(operation, "applied", cancelling);
        return cancelling;
      }
      const cancelled = this.cancelInactiveRun(cancelling);
      this.completeControlOperation(operation, "applied", cancelled);
      return cancelled;
    } catch (error) {
      this.completeControlOperation(operation, "failed", run, error);
      throw error;
    }
  }

  resumeRun(
    runId: string,
    operationId: string,
    expectedVersion: number,
    options: { stepId?: string; signal?: AbortSignal; operationType?: "resume" | "retry" } = {}
  ): DurableRunExecution {
    this.assertOpen();
    const operationType = options.operationType ?? "resume";
    const replay = this.replayControlOperation(runId, operationId, operationType);
    if (replay) {
      throw new RunRequestReplayError(replay);
    }
    if (this.active.has(runId)) {
      throw new RunCoordinatorConflictError(runId, "Run is already active in this runtime instance");
    }

    const run = this.requireRun(runId);
    const operation = this.createControlOperation(run, operationId, operationType, expectedVersion);
    try {
      if (run.status !== "paused" && run.status !== "failed") {
        throw Object.assign(new Error(`Run ${runId} cannot resume from ${run.status}`), { code: "RUN_NOT_RESUMABLE" });
      }
      const stepId = options.stepId || run.current_step_id;
      const step = this.store.getStep(runId, stepId);
      if (!step) {
        throw Object.assign(new Error(`Step ${stepId} does not exist in run ${runId}`), { code: "STEP_NOT_FOUND" });
      }
      if (run.status === "failed" && !step.retryable) {
        throw Object.assign(new Error(`Step ${stepId} cannot be replayed safely`), { code: "STEP_NOT_RETRYABLE" });
      }
      const attemptHistory = this.store.listAttempts(runId, stepId);
      const failedAttempts = attemptHistory.filter((attempt) => attempt.status === "failed").length;
      if (failedAttempts >= step.max_attempts) {
        throw Object.assign(new Error(`Step ${stepId} reached its attempt limit`), { code: "ATTEMPT_LIMIT_REACHED" });
      }
      if (step.status !== "failed" && step.status !== "pending") {
        throw Object.assign(new Error(`Step ${stepId} cannot retry from ${step.status}`), { code: "STEP_NOT_RETRYABLE" });
      }
      if (step.status === "failed" || step.status === "pending") {
        if (step.status === "failed") {
          assertStepStatusTransition(step.status, "pending");
        }
        const reset = this.store.upsertStep(runId, {
          ...step,
          status: "pending",
          observation_id: "",
          error_code: "",
          error: "",
          started_at: "",
          ended_at: ""
        }, step.version);
        if (!reset.applied) {
          throw new RunCoordinatorConflictError(runId, `Step ${stepId} changed before retry`);
        }
      }

      const running = this.updateRun(run, "running", `run.${operationType}_started`, {
        operation_id: operationId,
        step_id: stepId
      }, {
        pause_requested_at: "",
        cancel_requested_at: "",
        error_code: "",
        error: ""
      });
      const attemptNumber = attemptHistory.reduce((highest, attempt) => Math.max(highest, attempt.attempt), 0) + 1;
      const attemptId = `attempt_${this.idFactory()}`;
      const request = this.getRecoveryRequest(runId);
      const attempt = this.store.startAttempt({
        attempt_id: attemptId,
        run_id: runId,
        step_id: stepId,
        attempt: attemptNumber,
        input_digest: digestJson(request),
        idempotency_key: digestJson({ run_id: runId, step_id: stepId, attempt: attemptNumber, action: step.action_id }),
        started_at: this.timestamp()
      });
      const controller = new AbortController();
      const active: ActiveExecution = {
        run_id: runId,
        request_id: run.request_id,
        step_id: stepId,
        attempt_id: attempt.attempt_id,
        signal: controller.signal,
        controller,
        cleanupExternalSignal: () => undefined,
        control: ""
      };
      active.cleanupExternalSignal = this.bindExternalSignal(active, options.signal);
      this.active.set(runId, active);
      this.completeControlOperation(operation, "applied", running);
      return publicExecution(active);
    } catch (error) {
      this.completeControlOperation(operation, "failed", this.requireRun(runId), error);
      throw error;
    }
  }

  getRecoveryRequest(runId: string): AgentRunRequest {
    const run = this.requireRun(runId);
    const snapshot = run.goal.request_snapshot.settings_snapshot["agent_request"];
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
      throw Object.assign(new Error(`Run ${runId} has no recoverable request snapshot`), { code: "REQUEST_SNAPSHOT_MISSING" });
    }
    return agentRunRequestSchema.parse(snapshot) as AgentRunRequest;
  }

  resolveConfirmation(
    confirmationId: string,
    status: "approved" | "rejected",
    operationId: string,
    expectedVersion: number
  ) {
    const existingOperation = this.store.getControlOperation(operationId);
    if (existingOperation) {
      if (existingOperation.confirmation_id !== confirmationId || existingOperation.operation_type !== `confirmation.${status}`) {
        throw new RunCoordinatorConflictError(existingOperation.run_id, `Operation ${operationId} belongs to another confirmation`);
      }
      const replay = this.store.getConfirmation(confirmationId);
      if (!replay) {
        throw Object.assign(new Error(`Confirmation ${confirmationId} not found`), { code: "CONFIRMATION_NOT_FOUND" });
      }
      return replay;
    }

    const confirmation = this.store.getConfirmation(confirmationId);
    if (!confirmation) {
      throw Object.assign(new Error(`Confirmation ${confirmationId} not found`), { code: "CONFIRMATION_NOT_FOUND" });
    }
    const run = this.requireRun(confirmation.run_id);
    const operation = this.store.createControlOperation({
      operation_id: operationId,
      run_id: confirmation.run_id,
      step_id: confirmation.step_id,
      confirmation_id: confirmationId,
      operation_type: `confirmation.${status}`,
      expected_version: expectedVersion,
      version: 1,
      status: "pending",
      result: {},
      error_code: "",
      error: "",
      created_at: this.timestamp(),
      completed_at: ""
    });
    if (confirmation.version !== expectedVersion) {
      this.completeControlOperation(
        operation,
        "rejected",
        run,
        Object.assign(new Error(`Expected confirmation version ${expectedVersion}, received ${confirmation.version}`), { code: "VERSION_CONFLICT" })
      );
      throw new RunCoordinatorConflictError(run.run_id, "Confirmation version changed");
    }
    const resolved = this.store.resolveConfirmation({
      confirmation_id: confirmationId,
      expected_version: expectedVersion,
      status,
      resolved_at: this.timestamp(),
      resolved_by: "user"
    });
    if (!resolved.applied) {
      this.completeControlOperation(operation, "failed", run, new Error("Confirmation changed before resolution"));
      throw new RunCoordinatorConflictError(run.run_id, "Confirmation changed before resolution");
    }
    this.store.appendEventInTransaction(run.run_id, {
      event_type: `confirmation.${status}`,
      step_id: confirmation.step_id,
      payload: { confirmation_id: confirmationId, operation_id: operationId }
    });
    this.completeControlOperation(operation, "applied", this.requireRun(run.run_id));
    return resolved.value;
  }

  heartbeat(): void {
    if (this.closed) {
      return;
    }
    const heartbeatAt = this.timestamp();
    const runtimeResult = this.store.heartbeatRuntimeInstance({
      runtime_instance_id: this.runtimeInstanceId,
      expected_version: this.runtimeInstance.version,
      heartbeat_at: heartbeatAt,
      lease_expires_at: this.leaseExpiry(heartbeatAt)
    });
    if (runtimeResult.applied) {
      this.runtimeInstance = runtimeResult.value;
    }

    for (const runId of this.active.keys()) {
      const run = this.store.getRun(runId);
      if (!run || run.runtime_instance_id !== this.runtimeInstanceId) {
        continue;
      }
      this.store.heartbeatRunLease({
        run_id: runId,
        runtime_instance_id: this.runtimeInstanceId,
        heartbeat_at: heartbeatAt,
        lease_expires_at: this.leaseExpiry(heartbeatAt)
      });
    }
  }

  recoverStaleRuns(): AgentRunState[] {
    const now = this.timestamp();
    const recovered: AgentRunState[] = [];
    for (const run of this.store.listRuns({ statuses: ["running"], limit: 500 })) {
      if (run.runtime_instance_id === this.runtimeInstanceId || (run.lease_expires_at && Date.parse(run.lease_expires_at) > Date.parse(now))) {
        continue;
      }
      const claim = this.store.claimStaleRun({
        run_id: run.run_id,
        runtime_instance_id: this.runtimeInstanceId,
        expected_version: run.version,
        stale_before: now,
        heartbeat_at: now,
        lease_expires_at: this.leaseExpiry(now),
        recovery_reason: "RUNTIME_LEASE_EXPIRED",
        statuses: ["running"],
        event: { event_type: "run.recovered", payload: { previous_runtime_instance_id: run.runtime_instance_id } }
      });
      if (!claim.applied) {
        continue;
      }
      recovered.push(claim.value);
    }
    return recovered;
  }

  getRun(runId: string): AgentRunState | null {
    return this.store.getRun(runId);
  }

  listRuns(statuses?: readonly AgentRunStatus[], limit = 100, beforeUpdatedAt?: string): AgentRunState[] {
    return this.store.listRuns({ statuses, limit, before_updated_at: beforeUpdatedAt });
  }

  listEvents(runId: string, after = 0, limit = 200): StoredAgentRunEvent[] {
    return this.store.listEvents(runId, { after, limit });
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    for (const execution of [...this.active.values()]) {
      try {
        execution.control = "pause";
        this.settlePaused(execution, new Error("Runtime stopped"));
      } catch {
        this.releaseActive(execution);
      }
    }
    const released = this.store.releaseRuntimeInstance({
      runtime_instance_id: this.runtimeInstanceId,
      expected_version: this.runtimeInstance.version,
      released_at: this.timestamp()
    });
    if (released.applied) {
      this.runtimeInstance = released.value;
    }
    if (this.ownsStore) {
      this.store.close();
    }
  }

  private createRootStep(
    runId: string,
    stepId: string,
    request: AgentRunRequest,
    options: BeginRunOptions
  ): AgentExecutionStep {
    const stepType = options.stepType || (request.skill_id ? "skill" : "chat");
    return agentExecutionStepSchema.parse({
      step_id: stepId,
      version: 1,
      index: 0,
      type: stepType,
      action_id: options.actionId || `agent.${stepType}`,
      skill_id: options.skillId || request.skill_id || "",
      instruction: request.content || "",
      necessity: "required",
      input_refs: uniqueStrings([
        request.current_path || "",
        ...(request.reference_paths || []),
        ...(request.confirmed_reference_paths || [])
      ]),
      required_permissions: stepType === "file_operation" ? ["project.write"] : ["project.read", "model.invoke"],
      base_document_versions: {},
      base_content_hashes: {},
      idempotency_key: digestJson({ run_id: runId, step_id: stepId, action: options.actionId || `agent.${stepType}` }),
      expected_output: {
        artifact_kind: stepType === "chat" ? "chat_answer" : "generated_cache",
        allow_empty: false,
        format_schema: {},
        target_path_pattern: "",
        minimum_checks: []
      },
      status: "pending",
      attempts: 0,
      max_attempts: 2,
      retryable: options.retryable ?? stepType === "chat",
      requires_confirmation: options.requiresConfirmation ?? stepType === "file_operation",
      observation_id: "",
      error_code: "",
      error: "",
      started_at: "",
      ended_at: ""
    });
  }

  private transitionRun(
    runId: string,
    status: AgentRunStatus,
    eventType: string,
    payload: Record<string, unknown> = {},
    patch: { conversation_id?: string; error_code?: string; error?: string } = {}
  ): AgentRunState {
    const run = this.requireRun(runId);
    return this.updateRun(run, status, eventType, payload, patch);
  }

  private updateRun(
    run: AgentRunState,
    status: AgentRunStatus,
    eventType: string,
    payload: Record<string, unknown>,
    patch: {
      conversation_id?: string;
      pause_requested_at?: string;
      cancel_requested_at?: string;
      error_code?: string;
      error?: string;
    }
  ): AgentRunState {
    if (run.status !== status) {
      assertRunStatusTransition(run.status, status);
    }
    const result = this.store.updateRunStatus({
      run_id: run.run_id,
      expected_version: run.version,
      expected_status: run.status,
      status,
      updated_at: this.timestamp(),
      runtime_instance_id: this.runtimeInstanceId,
      heartbeat_at: this.timestamp(),
      lease_expires_at: this.leaseExpiry(),
      conversation_id: patch.conversation_id,
      ...patch,
      event: { event_type: eventType, step_id: run.current_step_id, payload }
    });
    if (!result.applied) {
      throw new RunCoordinatorConflictError(run.run_id, `Run changed while applying ${eventType}`);
    }
    return result.value;
  }

  private settlePaused(active: ActiveExecution, error: unknown): AgentRunState {
    const message = errorMessage(error);
    const attempt = this.store.finishAttempt({
      attempt_id: active.attempt_id,
      expected_version: 1,
      status: "interrupted",
      step_status: "pending",
      error_code: "RUN_PAUSED",
      error: message,
      ended_at: this.timestamp()
    });
    if (!attempt.applied) {
      throw new RunCoordinatorConflictError(active.run_id, "Step attempt changed before pause checkpoint");
    }
    const paused = this.transitionRun(active.run_id, "paused", "run.paused", { reason: message });
    this.releaseActive(active);
    return paused;
  }

  private settleCancelled(active: ActiveExecution, code: string, message: string): AgentRunState {
    let run = this.requireRun(active.run_id);
    if (run.status !== "cancelling") {
      run = this.updateRun(run, "cancelling", "run.cancel_requested", {}, { cancel_requested_at: this.timestamp() });
    }
    const attempt = this.store.finishAttempt({
      attempt_id: active.attempt_id,
      expected_version: 1,
      status: "cancelled",
      step_status: "cancelled",
      error_code: code,
      error: message,
      ended_at: this.timestamp()
    });
    if (!attempt.applied) {
      throw new RunCoordinatorConflictError(active.run_id, "Step attempt changed before cancellation");
    }
    const cancelled = this.transitionRun(active.run_id, "cancelled", "run.cancelled", { error_code: code }, {
      error_code: code,
      error: message
    });
    this.releaseActive(active);
    return cancelled;
  }

  private cancelInactiveRun(run: AgentRunState): AgentRunState {
    for (const step of run.steps) {
      if (step.status === "pending" || step.status === "running" || step.status === "failed" || step.status === "waiting_confirmation") {
        this.store.upsertStep(run.run_id, { ...step, status: "cancelled", ended_at: this.timestamp() }, step.version);
      }
    }
    return this.transitionRun(run.run_id, "cancelled", "run.cancelled");
  }

  private replayControlOperation(runId: string, operationId: string, operationType: string): AgentRunState | null {
    const existing = this.store.getControlOperation(operationId);
    if (!existing) {
      return null;
    }
    if (existing.run_id !== runId || existing.operation_type !== operationType) {
      throw new RunCoordinatorConflictError(runId, `Operation ${operationId} belongs to another command`);
    }
    if (existing.status === "failed" || existing.status === "rejected") {
      throw new RunCoordinatorConflictError(runId, existing.error || `Operation ${operationId} was rejected`);
    }
    return this.requireRun(runId);
  }

  private createControlOperation(
    run: AgentRunState,
    operationId: string,
    operationType: string,
    expectedVersion?: number
  ): ExecutionControlOperation {
    const expected = expectedVersion ?? run.version;
    const operation = this.store.createControlOperation({
      operation_id: operationId,
      run_id: run.run_id,
      step_id: run.current_step_id,
      confirmation_id: "",
      operation_type: operationType,
      expected_version: expected,
      version: 1,
      status: "pending",
      result: {},
      error_code: "",
      error: "",
      created_at: this.timestamp(),
      completed_at: ""
    });
    if (run.version !== expected) {
      this.completeControlOperation(operation, "rejected", run, Object.assign(new Error("Run version changed"), { code: "VERSION_CONFLICT" }));
      throw new RunCoordinatorConflictError(run.run_id, `Expected run version ${expected}, received ${run.version}`);
    }
    return operation;
  }

  private completeControlOperation(
    operation: ExecutionControlOperation,
    status: "applied" | "rejected" | "failed",
    run: AgentRunState,
    error?: unknown
  ): void {
    this.store.completeControlOperation({
      operation_id: operation.operation_id,
      expected_version: operation.version,
      status,
      result: { run_id: run.run_id, status: run.status, version: run.version },
      error_code: error ? errorCode(error, status === "rejected" ? "CONTROL_REJECTED" : "CONTROL_FAILED") : "",
      error: error ? errorMessage(error) : "",
      completed_at: this.timestamp()
    });
  }

  private bindExternalSignal(active: ActiveExecution, signal?: AbortSignal): () => void {
    void active;
    void signal;
    // HTTP and renderer lifetimes own subscriptions, not the durable execution.
    return () => undefined;
  }

  private releaseActive(active: ActiveExecution): void {
    active.cleanupExternalSignal();
    this.active.delete(active.run_id);
  }

  private requireActive(runId: string, attemptId: string): ActiveExecution {
    const active = this.active.get(runId);
    if (!active || active.attempt_id !== attemptId) {
      throw new RunCoordinatorConflictError(runId, "Run is not active in this runtime instance");
    }
    return active;
  }

  private requireRun(runId: string): AgentRunState {
    const run = this.store.getRun(runId);
    if (!run) {
      throw new Error(`Agent run not found: ${runId}`);
    }
    return run;
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error("Run coordinator is closed");
    }
  }

  private timestamp(): string {
    return this.now().toISOString();
  }

  private leaseExpiry(from = this.timestamp()): string {
    return new Date(Date.parse(from) + this.leaseTtlMs).toISOString();
  }
}

function publicExecution(active: ActiveExecution): DurableRunExecution {
  return {
    run_id: active.run_id,
    request_id: active.request_id,
    step_id: active.step_id,
    attempt_id: active.attempt_id,
    signal: active.signal
  };
}

function sanitizeRequestSnapshot(request: AgentRunRequest): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(request)) {
    if (/(api[_-]?key|token|authorization|password|secret|credential)/i.test(key)) {
      continue;
    }
    if (isSnapshotValue(value)) {
      safe[key] = value;
    }
  }
  return safe;
}

function isSnapshotValue(value: unknown, depth = 0): boolean {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return true;
  }
  if (depth >= 4) {
    return false;
  }
  if (Array.isArray(value)) {
    return value.length <= 1_000 && value.every((item) => isSnapshotValue(item, depth + 1));
  }
  if (value && typeof value === "object") {
    return Object.entries(value).every(([key, item]) =>
      !/(api[_-]?key|token|authorization|password|secret|credential)/i.test(key) && isSnapshotValue(item, depth + 1)
    );
  }
  return false;
}

function projectId(projectRoot: string): string {
  return createHash("sha256").update(path.resolve(projectRoot).toLowerCase(), "utf8").digest("hex").slice(0, 24);
}

function digestJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

function errorMessage(error: unknown): string {
  return truncate(error instanceof Error ? error.message : String(error || "Unknown error"), 4_000);
}

function errorCode(error: unknown, fallback: string): string {
  if (error && typeof error === "object" && "code" in error) {
    const value = String((error as { code?: unknown }).code || "").trim();
    if (value) {
      return value.slice(0, 120);
    }
  }
  return fallback;
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 3)}...`;
}

function positiveInterval(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

function compactUuid(): string {
  return randomUUID().replaceAll("-", "");
}
