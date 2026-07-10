import type { AgentRunRequest, AgentRunResponse } from "@xiaoshuo/shared";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openExecutionStore } from "./execution-store.js";
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
        custom_prompt: "保留这个扩展字段"
      })
    );

    const run = coordinator.getRun(execution.run_id)!;
    const storedRequest = run.goal.request_snapshot.settings_snapshot.agent_request as Record<string, unknown>;
    expect(storedRequest.api_key).toBeUndefined();
    expect(storedRequest.custom_prompt).toBe("保留这个扩展字段");
    expect(run.goal.request_snapshot.selected_file_refs).toEqual(["02_正文/第001章.txt"]);
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
