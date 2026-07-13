import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { RunCoordinator, sha256StableJson } from "@xiaoshuo/agent-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleAgentRoutes } from "./agent-routes.js";
import type { RuntimeContext } from "./types.js";

const runtime = vi.hoisted(() => ({
  listDurableRuns: vi.fn(),
  getDurableRun: vi.fn(),
  listDurableRunConfirmations: vi.fn(),
  listDurableRunEvents: vi.fn(),
  isAgentEventStreamEnabled: vi.fn(),
  exportDurableRun: vi.fn(),
  deleteDurableRun: vi.fn(),
  pauseDurableRun: vi.fn(),
  cancelDurableRun: vi.fn(),
  resumeDurableRun: vi.fn(),
  retryDurableRunStep: vi.fn(),
  resolveDurableConfirmation: vi.fn(),
  createDurableRun: vi.fn(),
  runAgent: vi.fn(),
  streamAgentRun: vi.fn()
}));
const mockGetProjectAgentRuntime = vi.hoisted(() => vi.fn(() => runtime));

vi.mock("./agent-runtime-registry.js", () => ({
  getProjectAgentRuntime: mockGetProjectAgentRuntime
}));

vi.mock("./license-guard.js", () => ({
  writeAiLicenseRequiredIfNeeded: vi.fn(async () => false)
}));

afterEach(() => {
  vi.clearAllMocks();
  mockGetProjectAgentRuntime.mockImplementation(() => runtime);
});

describe("agent lifecycle routes", () => {
  it("maps project scope rejection to a stable non-500 response", async () => {
    const writeJson = vi.fn();
    mockGetProjectAgentRuntime.mockRejectedValueOnce(Object.assign(new Error("scope changed"), {
      code: "PROJECT_SCOPE_ROOT_CHANGED"
    }));

    const handled = await handleAgentRoutes(
      request("GET"),
      response(),
      "/api/agent/runs",
      context(),
      deps(writeJson)
    );

    expect(handled).toBe(true);
    expect(writeJson).toHaveBeenCalledWith(expect.anything(), 409, {
      detail: "scope changed",
      code: "PROJECT_SCOPE_ROOT_CHANGED"
    });
  });

  it("lists durable runs with status and cursor pagination", async () => {
    const writeJson = vi.fn();
    const first = runState("run-1", 3, "completed", "2026-07-10T04:00:00.000Z");
    const second = runState("run-2", 2, "completed", "2026-07-10T03:00:00.000Z");
    runtime.listDurableRuns.mockReturnValue([first, second]);

    const handled = await handleAgentRoutes(
      request("GET"),
      response(),
      "/api/agent/runs",
      context(),
      deps(writeJson),
      new URLSearchParams({ status: "completed", limit: "1" })
    );

    expect(handled).toBe(true);
    expect(runtime.listDurableRuns).toHaveBeenCalledWith(["completed"], 2, undefined);
    expect(writeJson).toHaveBeenCalledWith(
      expect.anything(),
      200,
      expect.objectContaining({ runs: [first], next_cursor: expect.any(String) })
    );
  });

  it("creates a durable run once and replays the same request id", async () => {
    const writeJson = vi.fn();
    const run = runState("run-created", 1, "running");
    runtime.createDurableRun.mockResolvedValueOnce({ run, created: true }).mockResolvedValueOnce({ run, created: false });
    const payload = { request_id: "request-created", content: "继续写作" };

    await handleAgentRoutes(request("POST"), response(), "/api/agent/runs", context(), deps(writeJson, payload));
    await handleAgentRoutes(request("POST"), response(), "/api/agent/runs", context(), deps(writeJson, payload));

    expect(runtime.createDurableRun).toHaveBeenCalledWith(expect.objectContaining({ request_id: "request-created", content: "继续写作" }));
    expect(writeJson).toHaveBeenNthCalledWith(1, expect.anything(), 201, run);
    expect(writeJson).toHaveBeenNthCalledWith(2, expect.anything(), 200, run);
  });

  it("retires the legacy raw file-operation endpoint without reading a request body", async () => {
    const writeJson = vi.fn();
    const routeDeps = deps(writeJson, {
      operations: [{ action: "create_file", path: "02_正文/第一章.txt", text: "must not write" }]
    });

    const handled = await handleAgentRoutes(request("POST"), response(), "/api/agent/execute", context(), routeDeps);

    expect(handled).toBe(true);
    expect(routeDeps.readJsonBody).not.toHaveBeenCalled();
    expect(routeDeps.ensureProjectSessionCurrent).not.toHaveBeenCalled();
    expect(writeJson).toHaveBeenCalledWith(expect.anything(), 410, {
      detail: "旧 Agent 文件执行接口已退役，请改用 POST /api/agent/runs。",
      code: "AGENT_EXECUTE_RETIRED"
    });
  });

  it("returns a stable conflict for a request id bound to different content", async () => {
    const writeJson = vi.fn();
    runtime.createDurableRun.mockRejectedValue(Object.assign(new Error("request id already used"), { code: "REQUEST_ID_REUSED" }));

    await handleAgentRoutes(
      request("POST"),
      response(),
      "/api/agent/runs",
      context(),
      deps(writeJson, { request_id: "request-created", content: "different content" })
    );

    expect(writeJson).toHaveBeenCalledWith(expect.anything(), 409, {
      detail: "request id already used",
      code: "REQUEST_ID_REUSED"
    });
  });

  it("returns a stable 503 when durable execution is disabled while retaining read routes", async () => {
    const writeJson = vi.fn();
    runtime.createDurableRun.mockRejectedValue(Object.assign(new Error("Agent v2 execution is disabled"), {
      code: "AGENT_EXECUTION_V2_DISABLED"
    }));

    await handleAgentRoutes(request("POST"), response(), "/api/agent/runs", context(), deps(writeJson, { content: "继续写作" }));

    expect(writeJson).toHaveBeenCalledWith(expect.anything(), 503, {
      detail: "Agent v2 execution is disabled",
      code: "AGENT_EXECUTION_V2_DISABLED"
    });
  });

  it("returns run detail and replays events after a sequence", async () => {
    const writeJson = vi.fn();
    const run = runState("run-detail", 4, "running");
    const events = [{ event_id: "event-1", run_id: run.run_id, sequence: 5, event_type: "run.started", step_id: "", payload: {}, created_at: run.updated_at }];
    runtime.getDurableRun.mockReturnValue(run);
    runtime.listDurableRunEvents.mockReturnValue(events);

    await handleAgentRoutes(
      request("GET"),
      response(),
      "/api/agent/runs/run-detail/events",
      context(),
      deps(writeJson),
      new URLSearchParams({ after: "4" })
    );

    expect(runtime.listDurableRunEvents).toHaveBeenNthCalledWith(1, "run-detail", 4, 201);
    expect(runtime.listDurableRunEvents).toHaveBeenNthCalledWith(2, "run-detail", 0, 1);
    expect(writeJson).toHaveBeenCalledWith(expect.anything(), 200, {
      events,
      next_after: 5,
      next_sequence: 5,
      has_more: false,
      earliest_available_sequence: 5,
      gap_detected: false
    });
  });

  it("exports and deletes a project-local terminal durable run", async () => {
    const writeJson = vi.fn();
    const exported = {
      format_version: 1,
      exported_at: "2026-07-10T04:00:00.000Z",
      project_id: "project",
      project_path: "D:\\projects\\demo",
      run: runState("run-export", 2, "completed"),
      steps: [], attempts: [], observations: [], artifacts: [], confirmations: [], events: [], control_operations: [], commit_journal: []
    };
    const deleted = {
      run_id: "run-export",
      project_id: "project",
      deleted_at: "2026-07-10T04:01:00.000Z",
      deleted_records: { run: 1, steps: 0, attempts: 0, observations: 0, artifacts: 0, confirmations: 0, events: 0, control_operations: 0, commit_journal: 0, write_leases: 0 },
      preserved_artifacts: []
    };
    runtime.exportDurableRun.mockReturnValue(exported);
    runtime.deleteDurableRun.mockReturnValue(deleted);

    await handleAgentRoutes(request("GET"), response(), "/api/agent/runs/run-export/export", context(), deps(writeJson));
    await handleAgentRoutes(request("DELETE"), response(), "/api/agent/runs/run-export", context(), deps(writeJson));

    expect(runtime.exportDurableRun).toHaveBeenCalledWith("run-export");
    expect(runtime.deleteDurableRun).toHaveBeenCalledWith("run-export");
    expect(writeJson).toHaveBeenNthCalledWith(1, expect.anything(), 200, exported);
    expect(writeJson).toHaveBeenNthCalledWith(2, expect.anything(), 200, deleted);
  });

  it("maps an unsafe durable run deletion to a conflict", async () => {
    const writeJson = vi.fn();
    runtime.deleteDurableRun.mockImplementation(() => {
      throw Object.assign(new Error("Agent run run-active must be terminal before deletion"), { code: "RUN_NOT_TERMINAL" });
    });

    await handleAgentRoutes(request("DELETE"), response(), "/api/agent/runs/run-active", context(), deps(writeJson));

    expect(writeJson).toHaveBeenCalledWith(expect.anything(), 409, {
      detail: "Agent run run-active must be terminal before deletion",
      code: "RUN_NOT_TERMINAL"
    });
  });

  it("reports paginated event replay gaps before the earliest retained sequence", async () => {
    const writeJson = vi.fn();
    const run = runState("run-gap", 4, "paused");
    const first = { event_id: "event-3", run_id: run.run_id, sequence: 3, event_type: "run.paused", step_id: "", payload: {}, created_at: run.updated_at };
    const second = { event_id: "event-4", run_id: run.run_id, sequence: 4, event_type: "run.resumed", step_id: "", payload: {}, created_at: run.updated_at };
    runtime.getDurableRun.mockReturnValue(run);
    runtime.listDurableRunEvents.mockReturnValueOnce([first, second]).mockReturnValueOnce([first]);

    await handleAgentRoutes(
      request("GET"),
      response(),
      "/api/agent/runs/run-gap/events",
      context(),
      deps(writeJson),
      new URLSearchParams({ after: "1", limit: "1" })
    );

    expect(writeJson).toHaveBeenCalledWith(expect.anything(), 200, {
      events: [first],
      next_after: 3,
      next_sequence: 3,
      has_more: true,
      earliest_available_sequence: 3,
      gap_detected: true
    });
  });

  it("passes operation id and expected version to pause and retry", async () => {
    const writeJson = vi.fn();
    const run = runState("run-control", 8, "paused");
    runtime.pauseDurableRun.mockReturnValue(run);
    runtime.retryDurableRunStep.mockReturnValue(run);

    await handleAgentRoutes(
      request("POST"),
      response(),
      "/api/agent/runs/run-control/pause",
      context(),
      deps(writeJson, { operation_id: "op-pause", expected_version: 7 })
    );
    await handleAgentRoutes(
      request("POST"),
      response(),
      "/api/agent/runs/run-control/steps/step-1/retry",
      context(),
      deps(writeJson, { operation_id: "op-retry", expected_version: 8 })
    );

    expect(runtime.pauseDurableRun).toHaveBeenCalledWith("run-control", "op-pause", 7);
    expect(runtime.retryDurableRunStep).toHaveBeenCalledWith("run-control", "step-1", "op-retry", 8);
  });

  it("resolves confirmations and maps version conflicts to 409", async () => {
    const writeJson = vi.fn();
    runtime.resolveDurableConfirmation.mockImplementation(() => {
      throw Object.assign(new Error("Confirmation version changed"), { code: "VERSION_CONFLICT" });
    });

    await handleAgentRoutes(
      request("POST"),
      response(),
      "/api/agent/confirmations/confirmation-1/approve",
      context(),
      deps(writeJson, { operation_id: "op-confirm", expected_version: 2 })
    );

    expect(runtime.resolveDurableConfirmation).toHaveBeenCalledWith("confirmation-1", "approved", "op-confirm", 2, "");
    expect(writeJson).toHaveBeenCalledWith(expect.anything(), 409, {
      detail: "Confirmation version changed",
      code: "VERSION_CONFLICT"
    });
  });

  it("keeps confirmation-required work incomplete until an approved checkpoint is explicitly resumed", async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "xiaoshuo-confirmation-api-"));
    const coordinator = new RunCoordinator({ projectRoot, runtimeInstanceId: "runtime-confirmation-api", autoHeartbeat: false });
    try {
      const execution = coordinator.beginRun({
        request_id: "confirmation-api-request",
        conversation_id: "",
        content: "替换正文文件",
        current_path: "",
        selection: "",
        project_context_hint: "",
        skill_id: "",
        attachment_ids: []
      }, { stepType: "file_operation", requiresConfirmation: true });
      const waiting = coordinator.completeRun(execution, sealedFileConfirmationResponse(coordinator, execution));
      const confirmation = coordinator.store.listConfirmations(execution.run_id, "pending")[0]!;
      expect(waiting.status).toBe("waiting_confirmation");

      runtime.getDurableRun.mockImplementation((runId: string) => coordinator.getRun(runId));
      runtime.listDurableRunConfirmations.mockImplementation((runId: string) => coordinator.store.listConfirmations(runId));
      runtime.resolveDurableConfirmation.mockImplementation((confirmationId: string, status: "approved" | "rejected", operationId: string, version: number, fingerprint = "") =>
        coordinator.resolveConfirmation(confirmationId, status, operationId, version, fingerprint)
      );
      runtime.resumeDurableRun.mockImplementation((runId: string, operationId: string, version: number) => {
        coordinator.resumeRun(runId, operationId, version);
        return coordinator.getRun(runId)!;
      });
      const writeJson = vi.fn();

      await handleAgentRoutes(request("GET"), response(), `/api/agent/runs/${execution.run_id}/confirmations`, context(), deps(writeJson));
      expect(writeJson).toHaveBeenLastCalledWith(expect.anything(), 200, [expect.objectContaining({ confirmation_id: confirmation.confirmation_id, status: "pending" })]);

      const approval = {
        operation_id: "operation-approve",
        expected_version: confirmation.version,
        expected_scope_fingerprint: confirmation.scope_fingerprint
      };
      await handleAgentRoutes(request("POST"), response(), `/api/agent/confirmations/${confirmation.confirmation_id}/approve`, context(), deps(writeJson, approval));
      await handleAgentRoutes(request("POST"), response(), `/api/agent/confirmations/${confirmation.confirmation_id}/approve`, context(), deps(writeJson, approval));
      expect(writeJson).toHaveBeenLastCalledWith(expect.anything(), 200, expect.objectContaining({ status: "approved" }));
      const paused = coordinator.getRun(execution.run_id)!;
      expect(paused.status).toBe("paused");

      await handleAgentRoutes(
        request("POST"),
        response(),
        `/api/agent/runs/${execution.run_id}/resume`,
        context(),
        deps(writeJson, { operation_id: "operation-resume", expected_version: paused.version })
      );
      expect(writeJson).toHaveBeenLastCalledWith(expect.anything(), 200, expect.objectContaining({ status: "running" }));
    } finally {
      coordinator.close();
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("rejects and expires confirmation checkpoints without allowing completion", async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "xiaoshuo-confirmation-expiry-api-"));
    let nowMs = Date.parse("2026-07-10T04:00:00.000Z");
    const coordinator = new RunCoordinator({ projectRoot, runtimeInstanceId: "runtime-confirmation-expiry-api", autoHeartbeat: false, now: () => new Date(nowMs) });
    try {
      const createWaitingRun = () => {
        const execution = coordinator.beginRun({ request_id: `confirmation-${nowMs}`, conversation_id: "", content: "删除文件", current_path: "", selection: "", project_context_hint: "", skill_id: "", attachment_ids: [] }, { stepType: "file_operation", requiresConfirmation: true });
        coordinator.completeRun(execution, sealedFileConfirmationResponse(coordinator, execution));
        return { execution, confirmation: coordinator.store.listConfirmations(execution.run_id, "pending")[0]! };
      };
      const rejected = createWaitingRun();
      runtime.resolveDurableConfirmation.mockImplementation((confirmationId: string, status: "approved" | "rejected", operationId: string, version: number, fingerprint = "") =>
        coordinator.resolveConfirmation(confirmationId, status, operationId, version, fingerprint)
      );
      const writeJson = vi.fn();
      await handleAgentRoutes(request("POST"), response(), `/api/agent/confirmations/${rejected.confirmation.confirmation_id}/reject`, context(), deps(writeJson, { operation_id: "operation-reject", expected_version: rejected.confirmation.version }));
      expect(coordinator.getRun(rejected.execution.run_id)).toMatchObject({ status: "failed", error_code: "CONFIRMATION_REJECTED" });

      nowMs += 1;
      const expired = createWaitingRun();
      nowMs += 16 * 60_000;
      expect(coordinator.expirePendingConfirmations()).toBe(1);
      expect(coordinator.getRun(expired.execution.run_id)).toMatchObject({ status: "failed", error_code: "CONFIRMATION_EXPIRED" });
    } finally {
      coordinator.close();
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("returns 404 for an unknown run", async () => {
    const writeJson = vi.fn();
    runtime.getDurableRun.mockReturnValue(null);

    await handleAgentRoutes(request("GET"), response(), "/api/agent/runs/missing", context(), deps(writeJson));

    expect(writeJson).toHaveBeenCalledWith(expect.anything(), 404, {
      detail: "Agent 运行记录不存在",
      code: "RUN_NOT_FOUND"
    });
  });

  it("streams durable events after the requested sequence and ends after a terminal run", async () => {
    const writeJson = vi.fn();
    const responseValue = response();
    const event = { event_id: "event-2", run_id: "run-stream", sequence: 2, event_type: "run.completed", step_id: "", payload: {}, created_at: "2026-07-10T04:00:02.000Z" };
    runtime.getDurableRun.mockReturnValue(runState("run-stream", 2, "completed"));
    runtime.listDurableRunEvents.mockReturnValueOnce([event]).mockReturnValueOnce([event]).mockReturnValueOnce([]);

    await handleAgentRoutes(
      request("GET"),
      responseValue,
      "/api/agent/runs/run-stream/events/stream",
      context(),
      deps(writeJson),
      new URLSearchParams({ after: "1" })
    );

    expect(responseValue.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({ "Content-Type": "application/x-ndjson; charset=utf-8" }));
    expect(responseValue.write).toHaveBeenCalledWith(`${JSON.stringify({ type: "event", event })}\n`);
    expect(responseValue.write).toHaveBeenCalledWith(expect.stringContaining('"type":"end"'));
    expect(responseValue.end).toHaveBeenCalledOnce();
    expect(runtime.listDurableRunEvents).toHaveBeenNthCalledWith(1, "run-stream", 0, 1);
    expect(runtime.listDurableRunEvents).toHaveBeenNthCalledWith(2, "run-stream", 1, 200);
    expect(runtime.listDurableRunEvents).toHaveBeenNthCalledWith(3, "run-stream", 2, 200);
  });

  it("requires event polling when agent_event_stream_v2 is disabled", async () => {
    const writeJson = vi.fn();
    runtime.isAgentEventStreamEnabled.mockReturnValue(false);

    await handleAgentRoutes(
      request("GET"),
      response(),
      "/api/agent/runs/run-stream/events/stream",
      context(),
      deps(writeJson)
    );

    expect(writeJson).toHaveBeenCalledWith(expect.anything(), 409, {
      detail: "Agent 事件流已关闭，请使用事件轮询接口。",
      code: "AGENT_EVENT_STREAM_V2_DISABLED"
    });
    expect(runtime.getDurableRun).not.toHaveBeenCalled();
  });

  it("does not bind durable execution to an HTTP response lifecycle", async () => {
    const writeJson = vi.fn();
    const responseValue = response();
    runtime.runAgent.mockResolvedValue({ reply: "done", intent: "chat", saved_paths: [] });
    runtime.streamAgentRun.mockImplementation(async function* () {
      yield { type: "start", intent: "chat", conversation_id: "", skill_id: "", run_id: "run-detached" };
      yield { type: "final", payload: { reply: "done", intent: "chat", saved_paths: [], run_id: "run-detached" } };
    });

    await handleAgentRoutes(request("POST"), responseValue, "/api/agent/run", context(), deps(writeJson));
    await handleAgentRoutes(request("POST"), responseValue, "/api/agent/run-stream", context(), deps(writeJson));

    expect(runtime.runAgent).toHaveBeenCalledWith(expect.anything(), {});
    expect(runtime.streamAgentRun).toHaveBeenCalledWith(expect.anything(), {});
  });

  it("reports execution-gate failures through JSON and NDJSON with stable codes", async () => {
    const writeJson = vi.fn();
    const responseValue = response();
    runtime.runAgent.mockRejectedValue(Object.assign(new Error("shadow unavailable"), { code: "AGENT_V2_SHADOW_UNAVAILABLE" }));
    runtime.streamAgentRun.mockImplementation(async function* () {
      throw Object.assign(new Error("shadow unavailable"), { code: "AGENT_V2_SHADOW_UNAVAILABLE" });
    });
    const routeDeps = deps(writeJson);

    await handleAgentRoutes(request("POST"), responseValue, "/api/agent/run", context(), routeDeps);
    await handleAgentRoutes(request("POST"), responseValue, "/api/agent/run-stream", context(), routeDeps);

    expect(writeJson).toHaveBeenCalledWith(expect.anything(), 503, {
      detail: "shadow unavailable",
      code: "AGENT_V2_SHADOW_UNAVAILABLE"
    });
    expect(routeDeps.writeNdjsonEvent).toHaveBeenCalledWith(responseValue, {
      type: "error",
      message: "shadow unavailable",
      error_code: "AGENT_V2_SHADOW_UNAVAILABLE"
    });
  });
});

function request(method: string): IncomingMessage {
  const value = new EventEmitter() as IncomingMessage;
  Object.assign(value, { method, headers: {} });
  return value;
}

function sealedFileConfirmationResponse(
  coordinator: RunCoordinator,
  execution: { run_id: string; step_id: string }
) {
  const run = coordinator.getRun(execution.run_id)!;
  const actionPayload = { preview: "sealed-file-operation" };
  const actionInputHash = sha256StableJson(actionPayload);
  const targetBindings: [] = [];
  const scopeFingerprint = sha256StableJson({
    run_id: execution.run_id,
    step_id: execution.step_id,
    project_id: run.project_id,
    plan_version: run.plan_version,
    action_id: "execute_file_plan",
    target_bindings: targetBindings,
    action_input_hash: actionInputHash,
    action_payload: actionPayload
  });
  return {
    intent: "file_operation" as const,
    reply: "待写入预览",
    conversation: null,
    results: [],
    skill_result: null,
    saved_paths: [],
    requires_confirmation: true,
    confirmation_scope: {
      project_id: run.project_id,
      plan_version: run.plan_version,
      action_id: "execute_file_plan",
      target_bindings: targetBindings,
      action_input_hash: actionInputHash,
      scope_fingerprint: scopeFingerprint,
      action_payload: actionPayload
    }
  };
}

function response(): ServerResponse {
  const value = new EventEmitter() as ServerResponse;
  Object.assign(value, {
    writableEnded: false,
    destroyed: false,
    writeHead: vi.fn(),
    write: vi.fn(() => true),
    end: vi.fn()
  });
  return value;
}

function context(): RuntimeContext {
  return {
    projectRoot: "D:\\xiaoshuo\\ts-migration",
    jobManager: {} as RuntimeContext["jobManager"],
    projectSession: {} as RuntimeContext["projectSession"],
    documentSessions: new Map()
  };
}

function deps(writeJson: ReturnType<typeof vi.fn>, body: Record<string, unknown> = {}) {
  return {
    ensureProjectSessionCurrent: vi.fn(async () => ({ path: "D:\\projects\\demo", name: "demo", root: "D:\\projects\\demo" })),
    ensureDocumentSession: vi.fn(),
    readJsonBody: vi.fn(async () => body),
    readRawBody: vi.fn(async () => Buffer.from("{}")),
    parseJsonRecord: vi.fn(() => ({})),
    booleanValue: vi.fn(() => false),
    rebuildProjectManifest: vi.fn(async () => undefined),
    writeJson,
    writeNdjsonEvent: vi.fn(),
    addCorsHeaders: vi.fn()
  } as Parameters<typeof handleAgentRoutes>[4];
}

function runState(runId: string, version: number, status: string, updatedAt = "2026-07-10T04:00:00.000Z") {
  return {
    schema_version: 1,
    version,
    run_id: runId,
    request_id: `request-${runId}`,
    conversation_id: "",
    project_id: "project",
    project_path: "D:\\projects\\demo",
    goal: {
      instruction: "test",
      autonomy_mode: "plan",
      requested_outputs: [],
      success_criteria: [],
      assumptions: [],
      blocking_questions: [],
      request_snapshot: { content: "test", attachment_refs: [], selected_file_refs: [], settings_snapshot: {}, feature_flag_snapshot: {} }
    },
    goal_revision: 1,
    plan_version: 1,
    plan_status: "approved",
    status,
    current_step_id: "step-1",
    runtime_instance_id: "runtime",
    heartbeat_at: updatedAt,
    lease_expires_at: updatedAt,
    pause_requested_at: "",
    cancel_requested_at: "",
    recovery_reason: "",
    error_code: "",
    error: "",
    steps: [],
    artifacts: [],
    budget: {},
    last_event_sequence: 0,
    created_at: updatedAt,
    updated_at: updatedAt
  };
}
