import type {
  AgentPlanStatus as SharedAgentPlanStatus,
  AgentRunStatus,
  AgentStepStatus
} from "@xiaoshuo/shared";

export type ExecutionRunStatus = AgentRunStatus;
export type ExecutionStepStatus = AgentStepStatus;
export type AgentPlanStatus = SharedAgentPlanStatus;
export type ExecutionStateKind = "run" | "step" | "plan";

export const EXECUTION_STATE_ERROR_CODES = Object.freeze({
  INVALID_STATE_TRANSITION: "INVALID_STATE_TRANSITION",
  INVALID_VERSION: "INVALID_VERSION",
  VERSION_CONFLICT: "VERSION_CONFLICT",
  VERSION_EXHAUSTED: "VERSION_EXHAUSTED",
  PLAN_NOT_APPROVED: "PLAN_NOT_APPROVED",
  STEP_NOT_PENDING: "STEP_NOT_PENDING",
  CONTROL_REQUEST_NOT_ALLOWED: "CONTROL_REQUEST_NOT_ALLOWED",
  CONTROL_CHECKPOINT_NOT_REACHED: "CONTROL_CHECKPOINT_NOT_REACHED"
} as const);

export type ExecutionStateErrorCode =
  (typeof EXECUTION_STATE_ERROR_CODES)[keyof typeof EXECUTION_STATE_ERROR_CODES];

export class ExecutionStateMachineError extends Error {
  readonly code: ExecutionStateErrorCode;
  readonly retryable: boolean;
  readonly detail: Readonly<Record<string, unknown>>;

  constructor(
    code: ExecutionStateErrorCode,
    message: string,
    detail: Record<string, unknown> = {},
    retryable = false
  ) {
    super(message);
    this.name = "ExecutionStateMachineError";
    this.code = code;
    this.retryable = retryable;
    this.detail = Object.freeze({ ...detail });
  }
}

export class InvalidExecutionStateTransitionError extends ExecutionStateMachineError {
  readonly stateKind: ExecutionStateKind;
  readonly currentStatus: string;
  readonly targetStatus: string;

  constructor(stateKind: ExecutionStateKind, currentStatus: string, targetStatus: string) {
    super(
      EXECUTION_STATE_ERROR_CODES.INVALID_STATE_TRANSITION,
      `Invalid ${stateKind} status transition: "${currentStatus}" -> "${targetStatus}"`,
      { state_kind: stateKind, current_status: currentStatus, target_status: targetStatus }
    );
    this.name = "InvalidExecutionStateTransitionError";
    this.stateKind = stateKind;
    this.currentStatus = currentStatus;
    this.targetStatus = targetStatus;
  }
}

export class ExecutionVersionConflictError extends ExecutionStateMachineError {
  readonly expectedVersion: number;
  readonly actualVersion: number;

  constructor(expectedVersion: number, actualVersion: number) {
    super(
      EXECUTION_STATE_ERROR_CODES.VERSION_CONFLICT,
      `Execution version conflict: expected ${expectedVersion}, actual ${actualVersion}`,
      { expected_version: expectedVersion, actual_version: actualVersion },
      true
    );
    this.name = "ExecutionVersionConflictError";
    this.expectedVersion = expectedVersion;
    this.actualVersion = actualVersion;
  }
}

export const RUN_STATUS_TRANSITIONS = defineTransitions<ExecutionRunStatus>({
  queued: ["planning", "paused", "cancelling"],
  planning: ["waiting_user_input", "running", "paused", "cancelling", "failed"],
  running: ["waiting_user_input", "waiting_confirmation", "paused", "cancelling", "failed", "completed"],
  waiting_user_input: ["planning", "running", "paused", "cancelling", "failed"],
  waiting_confirmation: ["running", "paused", "cancelling", "failed"],
  paused: ["running", "cancelling"],
  failed: ["running", "paused", "cancelling"],
  cancelling: ["cancelled"],
  cancelled: [],
  completed: []
});

export const STEP_STATUS_TRANSITIONS = defineTransitions<ExecutionStepStatus>({
  pending: ["running", "skipped", "cancelled"],
  running: ["pending", "waiting_confirmation", "done", "failed", "cancelled"],
  // An approved confirmation resumes from a durable pending checkpoint.  The
  // executor must explicitly claim a fresh attempt instead of completing the
  // attempt that produced the preview.
  waiting_confirmation: ["pending", "running", "failed", "skipped", "cancelled"],
  failed: ["pending", "skipped"],
  done: [],
  skipped: [],
  cancelled: []
});

export const PLAN_STATUS_TRANSITIONS = defineTransitions<AgentPlanStatus>({
  draft: ["approved", "superseded"],
  approved: ["superseded"],
  superseded: []
});

export function canTransitionRunStatus(current: ExecutionRunStatus, target: ExecutionRunStatus): boolean {
  return RUN_STATUS_TRANSITIONS[current].includes(target);
}

export function assertRunStatusTransition(current: ExecutionRunStatus, target: ExecutionRunStatus): void {
  if (!canTransitionRunStatus(current, target)) {
    throw new InvalidExecutionStateTransitionError("run", current, target);
  }
}

export function transitionRunStatus(current: ExecutionRunStatus, target: ExecutionRunStatus): ExecutionRunStatus {
  assertRunStatusTransition(current, target);
  return target;
}

export function canTransitionStepStatus(current: ExecutionStepStatus, target: ExecutionStepStatus): boolean {
  return STEP_STATUS_TRANSITIONS[current].includes(target);
}

export function assertStepStatusTransition(current: ExecutionStepStatus, target: ExecutionStepStatus): void {
  if (!canTransitionStepStatus(current, target)) {
    throw new InvalidExecutionStateTransitionError("step", current, target);
  }
}

export function transitionStepStatus(current: ExecutionStepStatus, target: ExecutionStepStatus): ExecutionStepStatus {
  assertStepStatusTransition(current, target);
  return target;
}

export function canTransitionPlanStatus(current: AgentPlanStatus, target: AgentPlanStatus): boolean {
  return PLAN_STATUS_TRANSITIONS[current].includes(target);
}

export function assertPlanStatusTransition(current: AgentPlanStatus, target: AgentPlanStatus): void {
  if (!canTransitionPlanStatus(current, target)) {
    throw new InvalidExecutionStateTransitionError("plan", current, target);
  }
}

export function transitionPlanStatus(current: AgentPlanStatus, target: AgentPlanStatus): AgentPlanStatus {
  assertPlanStatusTransition(current, target);
  return target;
}

export function canStartExecutionStep(planStatus: AgentPlanStatus, stepStatus: ExecutionStepStatus): boolean {
  return planStatus === "approved" && stepStatus === "pending";
}

export function assertCanStartExecutionStep(planStatus: AgentPlanStatus, stepStatus: ExecutionStepStatus): void {
  if (planStatus !== "approved") {
    throw new ExecutionStateMachineError(
      EXECUTION_STATE_ERROR_CODES.PLAN_NOT_APPROVED,
      `Plan must be approved before a step starts; received "${planStatus}"`,
      { plan_status: planStatus }
    );
  }
  if (stepStatus !== "pending") {
    throw new ExecutionStateMachineError(
      EXECUTION_STATE_ERROR_CODES.STEP_NOT_PENDING,
      `Only a pending step can start; received "${stepStatus}"`,
      { step_status: stepStatus }
    );
  }
}

export function isRunTerminalStatus(status: ExecutionRunStatus): boolean {
  return status === "cancelled" || status === "completed";
}

export function isStepTerminalStatus(status: ExecutionStepStatus): boolean {
  return status === "done" || status === "skipped" || status === "cancelled";
}

export function isStepSettledForCancellation(status: ExecutionStepStatus): boolean {
  return status === "done" || status === "failed" || status === "skipped" || status === "cancelled";
}

export type RunControlRequest = "pause" | "cancel";

export type CooperativeRunControlDecision = Readonly<{
  request: RunControlRequest;
  status: ExecutionRunStatus;
  pause_requested_at: string;
  cancel_requested_at: string;
  checkpoint_required: boolean;
  abort_active_step: boolean;
}>;

export function requestCooperativeRunControl(
  current: ExecutionRunStatus,
  request: RunControlRequest,
  requestedAt: string,
  hasInFlightWork: boolean
): CooperativeRunControlDecision {
  const timestamp = requestedAt.trim();
  if (
    !timestamp ||
    isRunTerminalStatus(current) ||
    current === "cancelling" ||
    (request === "pause" && (current === "paused" || current === "failed"))
  ) {
    throw new ExecutionStateMachineError(
      EXECUTION_STATE_ERROR_CODES.CONTROL_REQUEST_NOT_ALLOWED,
      `Cannot request ${request} while run is "${current}"`,
      { request, current_status: current }
    );
  }

  if (request === "cancel") {
    return Object.freeze({
      request,
      status: transitionRunStatus(current, "cancelling"),
      pause_requested_at: "",
      cancel_requested_at: timestamp,
      checkpoint_required: true,
      abort_active_step: hasInFlightWork
    });
  }

  assertRunStatusTransition(current, "paused");
  return Object.freeze({
    request,
    status: hasInFlightWork ? current : "paused",
    pause_requested_at: timestamp,
    cancel_requested_at: "",
    checkpoint_required: hasInFlightWork,
    abort_active_step: false
  });
}

export function settlePauseAtCheckpoint(current: ExecutionRunStatus): "paused" {
  if (current === "paused") {
    return current;
  }
  return transitionRunStatus(current, "paused") as "paused";
}

export function settleCancellationAtCheckpoint(
  current: ExecutionRunStatus,
  stepStatuses: readonly ExecutionStepStatus[]
): "cancelled" {
  if (current !== "cancelling") {
    throw new ExecutionStateMachineError(
      EXECUTION_STATE_ERROR_CODES.CONTROL_REQUEST_NOT_ALLOWED,
      `Cannot settle cancellation while run is "${current}"`,
      { request: "cancel", current_status: current }
    );
  }

  const unsettled = stepStatuses.filter((status) => !isStepSettledForCancellation(status));
  if (unsettled.length > 0) {
    throw new ExecutionStateMachineError(
      EXECUTION_STATE_ERROR_CODES.CONTROL_CHECKPOINT_NOT_REACHED,
      "Cannot finish cancellation while steps are still active or pending",
      { unsettled_step_statuses: unsettled }
    );
  }

  return transitionRunStatus(current, "cancelled") as "cancelled";
}

export function assertExpectedVersion(actualVersion: number, expectedVersion: number): void {
  assertVersion(actualVersion, "actual version");
  assertVersion(expectedVersion, "expected version");
  if (actualVersion !== expectedVersion) {
    throw new ExecutionVersionConflictError(expectedVersion, actualVersion);
  }
}

export function nextExecutionVersion(actualVersion: number, expectedVersion: number): number {
  assertExpectedVersion(actualVersion, expectedVersion);
  if (actualVersion === Number.MAX_SAFE_INTEGER) {
    throw new ExecutionStateMachineError(
      EXECUTION_STATE_ERROR_CODES.VERSION_EXHAUSTED,
      "Execution version cannot be incremented beyond Number.MAX_SAFE_INTEGER",
      { actual_version: actualVersion }
    );
  }
  return actualVersion + 1;
}

export type VersionedExecutionStatus<Status extends string> = Readonly<{
  status: Status;
  version: number;
}>;

export function transitionRunStatusCas(
  current: VersionedExecutionStatus<ExecutionRunStatus>,
  target: ExecutionRunStatus,
  expectedVersion: number
): VersionedExecutionStatus<ExecutionRunStatus> {
  const version = nextExecutionVersion(current.version, expectedVersion);
  return Object.freeze({
    status: transitionRunStatus(current.status, target),
    version
  });
}

export function transitionStepStatusCas(
  current: VersionedExecutionStatus<ExecutionStepStatus>,
  target: ExecutionStepStatus,
  expectedVersion: number
): VersionedExecutionStatus<ExecutionStepStatus> {
  const version = nextExecutionVersion(current.version, expectedVersion);
  return Object.freeze({
    status: transitionStepStatus(current.status, target),
    version
  });
}

export function transitionPlanStatusCas(
  current: VersionedExecutionStatus<AgentPlanStatus>,
  target: AgentPlanStatus,
  expectedVersion: number
): VersionedExecutionStatus<AgentPlanStatus> {
  const version = nextExecutionVersion(current.version, expectedVersion);
  return Object.freeze({
    status: transitionPlanStatus(current.status, target),
    version
  });
}

function assertVersion(version: number, field: string): void {
  if (!Number.isSafeInteger(version) || version < 0) {
    throw new ExecutionStateMachineError(
      EXECUTION_STATE_ERROR_CODES.INVALID_VERSION,
      `${field} must be a non-negative safe integer`,
      { field, version }
    );
  }
}

function defineTransitions<Status extends string>(
  transitions: Record<Status, readonly Status[]>
): Readonly<Record<Status, readonly Status[]>> {
  for (const targets of Object.values(transitions)) {
    Object.freeze(targets);
  }
  return Object.freeze(transitions);
}
