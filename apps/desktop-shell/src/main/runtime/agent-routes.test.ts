import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleAgentRoutes } from "./agent-routes.js";
import type { RuntimeContext } from "./types.js";

const runtime = vi.hoisted(() => ({
  listDurableRuns: vi.fn(),
  getDurableRun: vi.fn(),
  listDurableRunEvents: vi.fn(),
  pauseDurableRun: vi.fn(),
  cancelDurableRun: vi.fn(),
  resumeDurableRun: vi.fn(),
  retryDurableRunStep: vi.fn(),
  resolveDurableConfirmation: vi.fn(),
  runAgent: vi.fn(),
  streamAgentRun: vi.fn()
}));

vi.mock("./agent-runtime-registry.js", () => ({
  getProjectAgentRuntime: vi.fn(() => runtime)
}));

vi.mock("./license-guard.js", () => ({
  writeAiLicenseRequiredIfNeeded: vi.fn(async () => false)
}));

afterEach(() => {
  vi.clearAllMocks();
});

describe("agent lifecycle routes", () => {
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

    expect(runtime.listDurableRunEvents).toHaveBeenCalledWith("run-detail", 4, 500);
    expect(writeJson).toHaveBeenCalledWith(expect.anything(), 200, { events, next_after: 5 });
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

    expect(runtime.resolveDurableConfirmation).toHaveBeenCalledWith("confirmation-1", "approved", "op-confirm", 2);
    expect(writeJson).toHaveBeenCalledWith(expect.anything(), 409, {
      detail: "Confirmation version changed",
      code: "VERSION_CONFLICT"
    });
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
});

function request(method: string): IncomingMessage {
  const value = new EventEmitter() as IncomingMessage;
  Object.assign(value, { method, headers: {} });
  return value;
}

function response(): ServerResponse {
  const value = new EventEmitter() as ServerResponse;
  Object.assign(value, {
    writableEnded: false,
    destroyed: false,
    writeHead: vi.fn(),
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
