import type { AgentRunRequest, AgentRunResponse } from "@xiaoshuo/shared";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openExecutionStore } from "./execution-store.js";
import { InMemoryAgentFeatureFlagRegistry } from "./feature-flag-registry.js";
import { AGENT_BUDGET_ERROR_CODES } from "./budget-policy.js";
import { RunCoordinator, RunRequestReplayError } from "./run-coordinator.js";

let tempDir = "";
const coordinators: RunCoordinator[] = [];
const externalStores: Array<ReturnType<typeof openExecutionStore>> = [];

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "arcwriter-run-coordinator-"));
});

afterEach(async () => {
  for (const coordinator of coordinators.splice(0)) {
    coordinator.close();
  }
  for (const store of externalStores.splice(0)) {
    store.close();
  }
  if (tempDir) {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

describe("RunCoordinator", () => {
  it("persists one run, step and attempt through successful completion", () => {
    const coordinator = createCoordinator("runtime-a");
    const execution = coordinator.beginRun(request({ request_id: "request-success" }));

    const running = coordinator.getRun(execution.run_id)!;
    expect(running.status).toBe("running");
    expect(running.request_id).toBe("request-success");
    expect(running.steps).toHaveLength(1);
    expect(running.steps[0]).toMatchObject({ status: "running", attempts: 1, type: "chat" });

    const completed = coordinator.completeRun(execution, response("完成回复"));
    expect(completed.status).toBe("completed");
    expect(completed.steps[0]).toMatchObject({ status: "done", observation_id: expect.stringContaining("observation_") });
    expect(coordinator.listEvents(execution.run_id).map((event) => event.event_type)).toEqual([
      "run.created",
      "run.planning",
      "run.started",
      "run.completed"
    ]);
  });

  it("rejects disabled and unavailable modes before allocating a run id or writing a run", () => {
    for (const [mode, code] of [["off", "AGENT_EXECUTION_V2_DISABLED"], ["shadow", "AGENT_V2_SHADOW_UNAVAILABLE"]] as const) {
      let idCalls = 0;
      const coordinator = new RunCoordinator({
        projectRoot: tempDir,
        runtimeInstanceId: `runtime-${mode}`,
        autoHeartbeat: false,
        idFactory: () => {
          idCalls += 1;
          return `${mode}-${idCalls}`;
        },
        featureFlags: new InMemoryAgentFeatureFlagRegistry({ agent_execution_v2_mode: mode })
      });
      coordinators.push(coordinator);

      expect(() => coordinator.beginRun(request({ request_id: `request-${mode}` }))).toThrow(
        expect.objectContaining({ code })
      );
      expect(idCalls).toBe(0);
      expect(coordinator.listRuns()).toEqual([]);
    }
  });

  it("rejects an expired trusted budget before allocating durable ids or writing a run", () => {
    let idCalls = 0;
    const coordinator = new RunCoordinator({
      projectRoot: tempDir,
      runtimeInstanceId: "runtime-expired-budget",
      autoHeartbeat: false,
      now: () => new Date("2026-07-11T00:00:00.000Z"),
      idFactory: () => `id-${++idCalls}`,
      budgetProfileIssuer: ({ issuedAt }) => ({
        profileId: "expired-test",
        envelope: {
          max_steps: 1,
          max_replans: 1,
          max_model_calls: 1,
          max_input_tokens: 1,
          max_output_tokens: 1,
          max_estimated_cost: 1,
          deadline_at: issuedAt
        }
      })
    });
    coordinators.push(coordinator);

    expect(() => coordinator.beginRun(request())).toThrow(
      expect.objectContaining({ code: AGENT_BUDGET_ERROR_CODES.deadlineExceeded })
    );
    expect(idCalls).toBe(0);
    expect(coordinator.listRuns()).toHaveLength(0);
  });

  it("persists a trusted profile and rejects request-id replay under an expanded profile", () => {
    let maxSteps = 2;
    const coordinator = new RunCoordinator({
      projectRoot: tempDir,
      runtimeInstanceId: "runtime-budget-replay",
      autoHeartbeat: false,
      now: () => new Date("2026-07-11T00:00:00.000Z"),
      idFactory: sequenceFactory("budget-replay"),
      budgetProfileIssuer: ({ issuedAt }) => ({
        profileId: "mutable-test-profile",
        envelope: {
          max_steps: maxSteps,
          max_replans: 1,
          max_model_calls: 2,
          max_input_tokens: 100,
          max_output_tokens: 100,
          max_estimated_cost: 1,
          deadline_at: new Date(Date.parse(issuedAt) + 60_000).toISOString()
        }
      })
    });
    coordinators.push(coordinator);
    const runRequest = request({ request_id: "budget-replay", budget: { used_steps: 999 } });
    const execution = coordinator.beginRun(runRequest);
    expect(coordinator.getRun(execution.run_id)?.budget).toMatchObject({
      profile_id: "mutable-test-profile",
      max_steps: 2,
      used_steps: 0
    });

    maxSteps = 3;
    expect(() => coordinator.beginRun(runRequest)).toThrow(
      expect.objectContaining({ code: AGENT_BUDGET_ERROR_CODES.stateConflict })
    );
  });

  it("moves an expired failed run to paused before retry starts a new attempt", () => {
    let nowMs = Date.parse("2026-07-11T00:00:00.000Z");
    const coordinator = new RunCoordinator({
      projectRoot: tempDir,
      runtimeInstanceId: "runtime-budget-resume",
      autoHeartbeat: false,
      now: () => new Date(nowMs),
      idFactory: sequenceFactory("budget-resume"),
      budgetProfileIssuer: ({ issuedAt }) => ({
        profileId: "short-test-profile",
        envelope: {
          max_steps: 2,
          max_replans: 1,
          max_model_calls: 2,
          max_input_tokens: 100,
          max_output_tokens: 100,
          max_estimated_cost: 1,
          deadline_at: new Date(Date.parse(issuedAt) + 1_000).toISOString()
        }
      })
    });
    coordinators.push(coordinator);
    const execution = coordinator.beginRun(request());
    const failed = coordinator.failRun(execution, Object.assign(new Error("retry"), { code: "RETRY" }));
    nowMs += 2_000;

    expect(() => coordinator.resumeRun(failed.run_id, "expired-retry", failed.version)).toThrow(
      expect.objectContaining({ code: AGENT_BUDGET_ERROR_CODES.deadlineExceeded })
    );
    expect(coordinator.getRun(failed.run_id)).toMatchObject({
      status: "paused",
      recovery_reason: AGENT_BUDGET_ERROR_CODES.deadlineExceeded,
      error_code: AGENT_BUDGET_ERROR_CODES.deadlineExceeded
    });
    expect(coordinator.store.listAttempts(failed.run_id, execution.step_id)).toHaveLength(1);
  });

  it("normalizes an historical empty budget and never starts a recovery attempt", () => {
    const coordinator = createCoordinator("runtime-legacy-budget");
    const execution = coordinator.beginRun(request());
    const failed = coordinator.failRun(execution, new Error("seed legacy run"));
    const legacyStepId = "legacy-step";
    coordinator.store.createRun({
      ...failed,
      run_id: "legacy-run",
      request_id: "legacy-request",
      version: 1,
      status: "paused",
      current_step_id: legacyStepId,
      budget: {},
      steps: failed.steps.map((step) => ({
        ...step,
        step_id: legacyStepId,
        version: 1,
        status: "pending",
        attempts: 0,
        observation_id: "",
        error_code: "",
        error: ""
      }))
    } as never);

    const legacy = coordinator.getRun("legacy-run")!;
    expect(legacy.budget).toMatchObject({ legacy_unbudgeted: true, profile_id: "legacy_unbudgeted" });
    expect(() => coordinator.resumeRun(legacy.run_id, "legacy-resume", legacy.version)).toThrow(
      expect.objectContaining({ code: AGENT_BUDGET_ERROR_CODES.required })
    );
    expect(coordinator.store.listAttempts(legacy.run_id, legacyStepId)).toHaveLength(0);
    expect(coordinator.getRun(legacy.run_id)?.status).toBe("paused");
  });

  it("does not export or delete a record through a coordinator for another project", async () => {
    const store = openExecutionStore(tempDir);
    externalStores.push(store);
    const owner = new RunCoordinator({
      projectRoot: tempDir,
      store,
      runtimeInstanceId: "runtime-owner",
      autoHeartbeat: false,
      idFactory: sequenceFactory("owner")
    });
    coordinators.push(owner);
    const execution = owner.beginRun(request());
    owner.completeRun(execution, response("完成"));

    const otherProject = path.join(tempDir, "other-project");
    await fs.mkdir(otherProject);
    const foreign = new RunCoordinator({
      projectRoot: otherProject,
      store,
      runtimeInstanceId: "runtime-foreign",
      autoHeartbeat: false,
      idFactory: sequenceFactory("foreign")
    });
    coordinators.push(foreign);

    expect(() => foreign.exportRun(execution.run_id)).toThrow(/does not belong to this project/);
    expect(() => foreign.deleteRun(execution.run_id)).toThrow(/does not belong to this project/);
    expect(owner.getRun(execution.run_id)).not.toBeNull();
  });

  it("records typed failures without losing the retryable step", () => {
    const coordinator = createCoordinator("runtime-failure");
    const execution = coordinator.beginRun(request());
    const error = Object.assign(new Error("provider unavailable"), { code: "MODEL_UNAVAILABLE" });

    const failed = coordinator.failRun(execution, error);

    expect(failed).toMatchObject({ status: "failed", error_code: "MODEL_UNAVAILABLE", error: "provider unavailable" });
    expect(failed.steps[0]).toMatchObject({ status: "failed", error_code: "MODEL_UNAVAILABLE" });
  });

  it("detaches an external request disconnect without changing the durable run", () => {
    const coordinator = createCoordinator("runtime-disconnect");
    const controller = new AbortController();
    const execution = coordinator.beginRun(request(), { signal: controller.signal });

    controller.abort(new Error("客户端已断开连接"));
    expect(execution.signal.aborted).toBe(false);
    expect(coordinator.getRun(execution.run_id)).toMatchObject({ status: "running" });
  });

  it("records an explicit pause as interrupted and resumes the same run without spending retry budget", () => {
    const coordinator = createCoordinator("runtime-pause");
    const execution = coordinator.beginRun(request());

    const requested = coordinator.requestPause(execution.run_id, "operation-pause");
    expect(requested.status).toBe("running");
    const paused = coordinator.failRun(execution, new Error("checkpoint reached"));

    expect(paused.status).toBe("paused");
    expect(paused.pause_requested_at).not.toBe("");
    expect(paused.steps[0]).toMatchObject({ status: "pending", error_code: "RUN_PAUSED" });
    expect(coordinator.store.listAttempts(paused.run_id)).toMatchObject([
      { attempt: 1, status: "interrupted", error_code: "RUN_PAUSED" }
    ]);

    const resumed = coordinator.resumeRun(paused.run_id, "operation-resume", paused.version);
    expect(resumed.run_id).toBe(paused.run_id);
    expect(coordinator.getRun(paused.run_id)).toMatchObject({ status: "running", steps: [expect.objectContaining({ attempts: 2 })] });
    expect(coordinator.store.listAttempts(paused.run_id).map((attempt) => attempt.status)).toEqual(["interrupted", "running"]);
    coordinator.completeRun(resumed, response("恢复完成"));
  });

  it("holds a confirmation-required step at a durable checkpoint until approval and then resumes it", () => {
    const coordinator = createCoordinator("runtime-confirmation");
    const execution = coordinator.beginRun(request(), { stepType: "file_operation", requiresConfirmation: true });

    const waiting = coordinator.completeRun(execution, response("已生成写入预览"));
    const confirmation = coordinator.store.listConfirmations(execution.run_id, "pending")[0]!;
    expect(waiting).toMatchObject({ status: "waiting_confirmation" });
    expect(waiting.steps[0]).toMatchObject({ status: "waiting_confirmation", requires_confirmation: true });
    expect(coordinator.store.listAttempts(execution.run_id, execution.step_id)).toMatchObject([
      { status: "interrupted", error_code: "CONFIRMATION_REQUIRED" }
    ]);

    const approved = coordinator.resolveConfirmation(confirmation.confirmation_id, "approved", "operation-approve", confirmation.version);
    expect(approved).toMatchObject({ status: "approved", resolved_by: "user" });
    const paused = coordinator.getRun(execution.run_id)!;
    expect(paused).toMatchObject({ status: "paused", steps: [expect.objectContaining({ status: "pending", requires_confirmation: false })] });

    const resumed = coordinator.resumeRun(execution.run_id, "operation-resume-approved", paused.version);
    expect(coordinator.completeRun(resumed, response("确认后完成")).status).toBe("completed");
  });

  it("makes repeated matching confirmation decisions idempotent and fails a rejected step", () => {
    const coordinator = createCoordinator("runtime-confirmation-reject");
    const execution = coordinator.beginRun(request(), { stepType: "file_operation", requiresConfirmation: true });
    coordinator.completeRun(execution, response("预览"));
    const confirmation = coordinator.store.listConfirmations(execution.run_id, "pending")[0]!;

    const rejected = coordinator.resolveConfirmation(confirmation.confirmation_id, "rejected", "operation-reject", confirmation.version);
    expect(rejected.status).toBe("rejected");
    expect(coordinator.getRun(execution.run_id)).toMatchObject({
      status: "failed",
      error_code: "CONFIRMATION_REJECTED",
      steps: [expect.objectContaining({ status: "failed", error_code: "CONFIRMATION_REJECTED" })]
    });
    expect(
      coordinator.resolveConfirmation(confirmation.confirmation_id, "rejected", "operation-reject-replay", confirmation.version)
    ).toMatchObject({ status: "rejected" });
  });

  it("expires abandoned confirmation checkpoints with an explicit failure code", () => {
    let nowMs = Date.parse("2026-07-10T04:00:00.000Z");
    const coordinator = new RunCoordinator({
      projectRoot: tempDir,
      runtimeInstanceId: "runtime-confirmation-expiry",
      now: () => new Date(nowMs),
      autoHeartbeat: false,
      idFactory: sequenceFactory("expiry")
    });
    coordinators.push(coordinator);
    const execution = coordinator.beginRun(request(), { stepType: "file_operation", requiresConfirmation: true });
    coordinator.completeRun(execution, response("预览"));

    nowMs += 16 * 60_000;
    expect(coordinator.expirePendingConfirmations()).toBe(1);
    expect(coordinator.store.listConfirmations(execution.run_id)[0]).toMatchObject({
      status: "expired",
      resolved_by: "policy"
    });
    expect(coordinator.getRun(execution.run_id)).toMatchObject({
      status: "failed",
      error_code: "CONFIRMATION_EXPIRED",
      steps: [expect.objectContaining({ status: "failed", error_code: "CONFIRMATION_EXPIRED" })]
    });
  });

  it("cooperatively cancels an active run", () => {
    const coordinator = createCoordinator("runtime-cancel");
    const execution = coordinator.beginRun(request());

    const cancelling = coordinator.requestCancel(execution.run_id, "operation-cancel");
    expect(cancelling.status).toBe("cancelling");
    expect(execution.signal.aborted).toBe(true);
    const cancelled = coordinator.failRun(execution, execution.signal.reason);

    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.steps[0]?.status).toBe("cancelled");
  });

  it("rejects duplicate request ids and keeps the original run authoritative", () => {
    const coordinator = createCoordinator("runtime-replay");
    const first = coordinator.beginRun(request({ request_id: "same-request" }));

    expect(() => coordinator.beginRun(request({ request_id: "same-request" }))).toThrow(RunRequestReplayError);
    expect(coordinator.listRuns()).toHaveLength(1);
    expect(coordinator.listRuns()[0]?.run_id).toBe(first.run_id);
  });

  it("rejects a request id reused with a different recoverable request", () => {
    const coordinator = createCoordinator("runtime-request-conflict");
    coordinator.beginRun(request({ request_id: "same-request", content: "first request" }));

    expect(() => coordinator.beginRun(request({ request_id: "same-request", content: "different request" }))).toThrow(
      expect.objectContaining({ code: "REQUEST_ID_REUSED" })
    );
    expect(coordinator.listRuns()).toHaveLength(1);
  });

  it("stores a controlled recovery snapshot without credential fields", () => {
    const coordinator = createCoordinator("runtime-snapshot");
    const execution = coordinator.beginRun(
      request({
        request_id: "snapshot-request",
        content: "生成正文",
        current_path: "02_正文/第001章.txt",
        api_key: "must-not-persist",
        custom_prompt: "保留这个扩展字段",
        transient_private_payload: { token: "must-not-persist" }
      })
    );

    const run = coordinator.getRun(execution.run_id)!;
    const storedRequest = run.goal.request_snapshot.settings_snapshot.agent_request as Record<string, unknown>;
    expect(storedRequest.api_key).toBeUndefined();
    expect(storedRequest.custom_prompt).toBe("保留这个扩展字段");
    expect(storedRequest.transient_private_payload).toBeUndefined();
    expect(run.goal.request_snapshot.selected_file_refs).toEqual(["02_正文/第001章.txt"]);
  });

  it("keeps the feature flag snapshot when registry configuration changes after creation", () => {
    const flags = new InMemoryAgentFeatureFlagRegistry({
      agent_execution_v2_mode: "on",
      agent_event_stream_v2: true
    });
    const coordinator = new RunCoordinator({
      projectRoot: tempDir,
      runtimeInstanceId: "runtime-flags",
      autoHeartbeat: false,
      idFactory: sequenceFactory("flags"),
      featureFlags: flags
    });
    coordinators.push(coordinator);

    const execution = coordinator.beginRun(request());
    flags.update({ agent_execution_v2_mode: "off" });

    expect(coordinator.getRun(execution.run_id)?.goal.request_snapshot.feature_flag_snapshot).toMatchObject({
      schema_version: 1,
      agent_execution_v2_mode: "on",
      agent_event_stream_v2: true
    });
    expect(flags.snapshot().agent_execution_v2_mode).toBe("off");
  });

  it("claims an expired runtime lease and pauses the stale run", () => {
    let nowMs = Date.parse("2026-07-10T04:00:00.000Z");
    const store = openExecutionStore(tempDir);
    externalStores.push(store);
    const first = new RunCoordinator({
      projectRoot: tempDir,
      store,
      runtimeInstanceId: "runtime-old",
      now: () => new Date(nowMs),
      autoHeartbeat: false,
      idFactory: sequenceFactory("old")
    });
    coordinators.push(first);
    const execution = first.beginRun(request());

    nowMs += 31_000;
    const second = new RunCoordinator({
      projectRoot: tempDir,
      store,
      runtimeInstanceId: "runtime-new",
      now: () => new Date(nowMs),
      autoHeartbeat: false,
      idFactory: sequenceFactory("new")
    });
    coordinators.push(second);

    const recovered = second.recoverStaleRuns();
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({
      run_id: execution.run_id,
      status: "paused",
      runtime_instance_id: "runtime-new",
      recovery_reason: "RUNTIME_LEASE_EXPIRED"
    });
    expect(store.getStep(execution.run_id, execution.step_id)).toMatchObject({ status: "pending" });
    expect(store.listAttempts(execution.run_id, execution.step_id)).toMatchObject([
      { attempt_id: execution.attempt_id, status: "interrupted", error_code: "RUNTIME_LEASE_EXPIRED" }
    ]);

    const resumed = second.resumeRun(execution.run_id, "operation-recover", recovered[0]!.version);
    expect(resumed.run_id).toBe(execution.run_id);
    expect(store.listAttempts(execution.run_id, execution.step_id).map((attempt) => attempt.status)).toEqual(["interrupted", "running"]);
  });
});

function createCoordinator(runtimeInstanceId: string): RunCoordinator {
  const coordinator = new RunCoordinator({
    projectRoot: tempDir,
    runtimeInstanceId,
    autoHeartbeat: false,
    idFactory: sequenceFactory(runtimeInstanceId)
  });
  coordinators.push(coordinator);
  return coordinator;
}

function sequenceFactory(prefix: string): () => string {
  let value = 0;
  return () => `${prefix.replace(/[^a-z0-9]/gi, "")}${++value}`;
}

function request(patch: Partial<AgentRunRequest> = {}): AgentRunRequest {
  return {
    conversation_id: "conversation-1",
    content: "继续写作",
    current_path: "",
    selection: "",
    project_context_hint: "",
    skill_id: "",
    attachment_ids: [],
    ...patch
  };
}

function response(reply: string): AgentRunResponse {
  return {
    intent: "chat",
    reply,
    conversation: null,
    results: [],
    skill_result: null,
    saved_paths: [],
    requires_confirmation: false
  };
}
