import { describe, expect, it, vi } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { handleJobRoutes } from "./job-routes.js";
import type { RuntimeContext } from "./types.js";

describe("legacy JobManager compatibility routes", () => {
  it("lists read-only legacy run mappings without changing the legacy jobs list response", async () => {
    const writeJson = vi.fn();
    const context = createContext();

    await handleJobRoutes(request("GET"), response(), "/api/jobs/legacy-runs", context, deps(writeJson));
    await handleJobRoutes(request("GET"), response(), "/api/jobs", context, deps(writeJson));

    expect(writeJson).toHaveBeenNthCalledWith(1, expect.anything(), 200, {
      mappings: [expect.objectContaining({
        legacy_job_id: "job-1",
        run_id: "legacy-job:job-1",
        source: "legacy_job_manager",
        read_only: true,
        recoverable: false,
        agent_control_operations: []
      })]
    });
    expect(writeJson).toHaveBeenNthCalledWith(2, expect.anything(), 200, [context.jobManager.list()[0]]);
  });

  it("exposes an individual projection as read-only and rejects mapping controls", async () => {
    const writeJson = vi.fn();
    const context = createContext();

    await handleJobRoutes(request("GET"), response(), "/api/jobs/job-1/legacy-run", context, deps(writeJson));
    await handleJobRoutes(request("POST"), response(), "/api/jobs/legacy-runs", context, deps(writeJson));

    expect(writeJson).toHaveBeenNthCalledWith(1, expect.anything(), 200, expect.objectContaining({
      legacy_job_id: "job-1",
      recoverable: false,
      agent_control_operations: []
    }));
    expect(writeJson).toHaveBeenNthCalledWith(2, expect.anything(), 405, {
      detail: "Legacy JobManager 映射为只读，不能作为可恢复 Agent run 控制",
      code: "LEGACY_RUN_READ_ONLY"
    });
  });
});

function createContext(): RuntimeContext {
  const job = { id: "job-1", kind: "novel_crawl", status: "running" as const, progress: 0.5, message: "抓取中" };
  return {
    projectRoot: "D:\\projects\\novel",
    jobManager: {
      list: vi.fn(() => [job]),
      get: vi.fn(() => job)
    } as unknown as RuntimeContext["jobManager"],
    projectSession: {} as RuntimeContext["projectSession"],
    documentSessions: new Map()
  };
}

function request(method: string): IncomingMessage {
  return { method } as IncomingMessage;
}

function response(): ServerResponse {
  return {} as ServerResponse;
}

function deps(writeJson: ReturnType<typeof vi.fn>) {
  return {
    ensureProjectSessionCurrent: vi.fn(),
    readJsonBody: vi.fn(),
    rebuildProjectManifest: vi.fn(),
    stringValue: vi.fn(),
    booleanValue: vi.fn(),
    writeJson
  } as Parameters<typeof handleJobRoutes>[4];
}
