import { describe, expect, it } from "vitest";
import {
  EXECUTION_STATE_ERROR_CODES,
  ExecutionStateMachineError,
  ExecutionVersionConflictError,
  InvalidExecutionStateTransitionError,
  assertCanStartExecutionStep,
  assertRunStatusTransition,
  assertStepStatusTransition,
  canStartExecutionStep,
  canTransitionPlanStatus,
  canTransitionRunStatus,
  canTransitionStepStatus,
  isRunTerminalStatus,
  isStepTerminalStatus,
  nextExecutionVersion,
  requestCooperativeRunControl,
  settleCancellationAtCheckpoint,
  settlePauseAtCheckpoint,
  transitionPlanStatus,
  transitionPlanStatusCas,
  transitionRunStatus,
  transitionRunStatusCas,
  transitionStepStatus,
  transitionStepStatusCas,
  type AgentPlanStatus,
  type ExecutionRunStatus,
  type ExecutionStepStatus
} from "./execution-state-machine.js";

const RUN_STATUSES: ExecutionRunStatus[] = [
  "queued",
  "planning",
  "running",
  "waiting_user_input",
  "waiting_confirmation",
  "paused",
  "failed",
  "cancelling",
  "cancelled",
  "completed"
];

const STEP_STATUSES: ExecutionStepStatus[] = [
  "pending",
  "running",
  "waiting_confirmation",
  "done",
  "failed",
  "skipped",
  "cancelled"
];

describe("execution-state-machine", () => {
  it.each([
    ["queued", "planning"],
    ["planning", "waiting_user_input"],
    ["waiting_user_input", "planning"],
    ["waiting_user_input", "running"],
    ["planning", "running"],
    ["running", "waiting_user_input"],
    ["running", "waiting_confirmation"],
    ["waiting_confirmation", "running"],
    ["planning", "paused"],
    ["running", "paused"],
    ["waiting_user_input", "paused"],
    ["waiting_confirmation", "paused"],
    ["paused", "running"],
    ["planning", "failed"],
    ["running", "failed"],
    ["failed", "running"],
    ["queued", "cancelling"],
    ["planning", "cancelling"],
    ["running", "cancelling"],
    ["waiting_user_input", "cancelling"],
    ["waiting_confirmation", "cancelling"],
    ["paused", "cancelling"],
    ["failed", "cancelling"],
    ["cancelling", "cancelled"],
    ["running", "completed"]
  ] satisfies Array<[ExecutionRunStatus, ExecutionRunStatus]>)(
    "allows run transition %s -> %s",
    (current, target) => {
      expect(canTransitionRunStatus(current, target)).toBe(true);
      expect(transitionRunStatus(current, target)).toBe(target);
    }
  );

  it.each([
    ["pending", "running"],
    ["pending", "skipped"],
    ["pending", "cancelled"],
    ["running", "pending"],
    ["running", "waiting_confirmation"],
    ["running", "done"],
    ["running", "failed"],
    ["running", "cancelled"],
    ["waiting_confirmation", "running"],
    ["waiting_confirmation", "failed"],
    ["waiting_confirmation", "skipped"],
    ["waiting_confirmation", "cancelled"],
    ["failed", "pending"],
    ["failed", "skipped"]
  ] satisfies Array<[ExecutionStepStatus, ExecutionStepStatus]>)(
    "allows step transition %s -> %s",
    (current, target) => {
      expect(canTransitionStepStatus(current, target)).toBe(true);
      expect(transitionStepStatus(current, target)).toBe(target);
    }
  );

  it.each([
    ["draft", "approved"],
    ["draft", "superseded"],
    ["approved", "superseded"]
  ] satisfies Array<[AgentPlanStatus, AgentPlanStatus]>)(
    "allows plan transition %s -> %s",
    (current, target) => {
      expect(canTransitionPlanStatus(current, target)).toBe(true);
      expect(transitionPlanStatus(current, target)).toBe(target);
    }
  );

  it("requires an approved plan and pending step before execution starts", () => {
    expect(canStartExecutionStep("approved", "pending")).toBe(true);
    expect(canStartExecutionStep("draft", "pending")).toBe(false);
    expect(canStartExecutionStep("approved", "failed")).toBe(false);

    expect(() => assertCanStartExecutionStep("draft", "pending")).toThrowError(
      expect.objectContaining({ code: EXECUTION_STATE_ERROR_CODES.PLAN_NOT_APPROVED })
    );
    expect(() => assertCanStartExecutionStep("approved", "done")).toThrowError(
      expect.objectContaining({ code: EXECUTION_STATE_ERROR_CODES.STEP_NOT_PENDING })
    );
  });

  it("rejects illegal transitions with a stable error code and status detail", () => {
    expect(() => assertRunStatusTransition("queued", "completed")).toThrow(
      'Invalid run status transition: "queued" -> "completed"'
    );

    try {
      assertStepStatusTransition("pending", "done");
      throw new Error("Expected the transition to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidExecutionStateTransitionError);
      expect(error).toMatchObject({
        code: EXECUTION_STATE_ERROR_CODES.INVALID_STATE_TRANSITION,
        stateKind: "step",
        currentStatus: "pending",
        targetStatus: "done"
      });
    }
  });

  it("routes cancellation through cancelling and requires settled steps", () => {
    expect(canTransitionRunStatus("running", "cancelled")).toBe(false);
    const decision = requestCooperativeRunControl(
      "running",
      "cancel",
      "2026-07-10T03:00:00.000Z",
      true
    );

    expect(decision).toEqual({
      request: "cancel",
      status: "cancelling",
      pause_requested_at: "",
      cancel_requested_at: "2026-07-10T03:00:00.000Z",
      checkpoint_required: true,
      abort_active_step: true
    });
    expect(() => settleCancellationAtCheckpoint("cancelling", ["running", "cancelled"])).toThrowError(
      expect.objectContaining({ code: EXECUTION_STATE_ERROR_CODES.CONTROL_CHECKPOINT_NOT_REACHED })
    );
    expect(settleCancellationAtCheckpoint("cancelling", ["cancelled", "failed", "done"])).toBe("cancelled");
  });

  it("records pause intent without aborting in-flight work and settles only at a checkpoint", () => {
    const inFlight = requestCooperativeRunControl("running", "pause", "2026-07-10T03:00:00.000Z", true);
    expect(inFlight).toMatchObject({
      status: "running",
      pause_requested_at: "2026-07-10T03:00:00.000Z",
      cancel_requested_at: "",
      checkpoint_required: true,
      abort_active_step: false
    });
    expect(settlePauseAtCheckpoint(inFlight.status)).toBe("paused");

    const idle = requestCooperativeRunControl(
      "waiting_user_input",
      "pause",
      "2026-07-10T03:00:01.000Z",
      false
    );
    expect(idle).toMatchObject({ status: "paused", checkpoint_required: false, abort_active_step: false });
  });

  it("rejects control requests from terminal, cancelling, and already failed runs", () => {
    for (const status of ["completed", "cancelled", "cancelling"] satisfies ExecutionRunStatus[]) {
      expect(() => requestCooperativeRunControl(status, "cancel", "2026-07-10T03:00:00.000Z", false)).toThrowError(
        expect.objectContaining({ code: EXECUTION_STATE_ERROR_CODES.CONTROL_REQUEST_NOT_ALLOWED })
      );
    }
    expect(() => requestCooperativeRunControl("failed", "pause", "2026-07-10T03:00:00.000Z", false)).toThrowError(
      expect.objectContaining({ code: EXECUTION_STATE_ERROR_CODES.CONTROL_REQUEST_NOT_ALLOWED })
    );
    expect(() => requestCooperativeRunControl("paused", "pause", "2026-07-10T03:00:00.000Z", false)).toThrowError(
      expect.objectContaining({ code: EXECUTION_STATE_ERROR_CODES.CONTROL_REQUEST_NOT_ALLOWED })
    );
  });

  it("protects every terminal state from repeated execution", () => {
    for (const terminal of ["cancelled", "completed"] satisfies ExecutionRunStatus[]) {
      expect(isRunTerminalStatus(terminal)).toBe(true);
      for (const target of RUN_STATUSES) {
        expect(canTransitionRunStatus(terminal, target)).toBe(false);
      }
    }

    for (const terminal of ["done", "skipped", "cancelled"] satisfies ExecutionStepStatus[]) {
      expect(isStepTerminalStatus(terminal)).toBe(true);
      for (const target of STEP_STATUSES) {
        expect(canTransitionStepStatus(terminal, target)).toBe(false);
      }
    }
  });

  it("applies status changes and version increments as one CAS decision", () => {
    expect(transitionRunStatusCas({ status: "planning", version: 4 }, "running", 4)).toEqual({
      status: "running",
      version: 5
    });
    expect(transitionStepStatusCas({ status: "pending", version: 8 }, "running", 8)).toEqual({
      status: "running",
      version: 9
    });
    expect(transitionPlanStatusCas({ status: "draft", version: 2 }, "approved", 2)).toEqual({
      status: "approved",
      version: 3
    });
  });

  it("rejects stale expected versions before a caller can persist a transition", () => {
    expect(() => transitionRunStatusCas({ status: "running", version: 7 }, "paused", 6)).toThrowError(
      expect.objectContaining({
        code: EXECUTION_STATE_ERROR_CODES.VERSION_CONFLICT,
        retryable: true,
        expectedVersion: 6,
        actualVersion: 7
      })
    );
    expect(() => nextExecutionVersion(7, 6)).toThrow(ExecutionVersionConflictError);
  });

  it("rejects repeated state and plan transitions", () => {
    expect(() => transitionRunStatus("running", "running")).toThrow(InvalidExecutionStateTransitionError);
    expect(() => transitionStepStatus("running", "running")).toThrow(InvalidExecutionStateTransitionError);
    expect(() => transitionPlanStatus("approved", "approved")).toThrow(InvalidExecutionStateTransitionError);
    expect(() => transitionPlanStatus("superseded", "draft")).toThrow(InvalidExecutionStateTransitionError);
  });

  it("exposes coded errors as the common state-machine error type", () => {
    expect(() => nextExecutionVersion(-1, -1)).toThrow(ExecutionStateMachineError);
  });

  it("checks expected version before interpreting a stale transition", () => {
    expect(() => transitionRunStatusCas({ status: "completed", version: 8 }, "running", 7)).toThrowError(
      expect.objectContaining({ code: EXECUTION_STATE_ERROR_CODES.VERSION_CONFLICT })
    );
  });
});
