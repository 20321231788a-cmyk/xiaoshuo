import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { handleAgentTraceRoutes } from "./agent-trace-routes.js";
import type { RuntimeContext } from "./types.js";

let tempDir = "";

function createContext(): RuntimeContext {
  return {
    projectRoot: tempDir,
    jobManager: {} as RuntimeContext["jobManager"],
    projectSession: {} as RuntimeContext["projectSession"],
    documentSessions: new Map()
  };
}

function createResponse(): ServerResponse {
  return {} as ServerResponse;
}

function createTrace(runId: string, inputExcerpt: string, startedAt: string) {
  return {
    run_id: runId,
    started_at: startedAt,
    ended_at: startedAt,
    input_excerpt: inputExcerpt,
    selected_skill_id: runId.includes("skill") ? "body_generate" : "",
    context_blocks: [{ name: "project", source: "project", chars: 12, included: true, reason: "fixture" }],
    model_calls: [{ model: "mock-model", duration_ms: 7 }],
    saved_paths: ["02_正文/第001章.txt"]
  };
}

async function writeTraceFile(filename: string, lines: unknown[]): Promise<void> {
  const traceDir = path.join(tempDir, "00_设定集", ".agent", "runs");
  await fs.mkdir(traceDir, { recursive: true });
  await fs.writeFile(path.join(traceDir, filename), lines.map((line) => (typeof line === "string" ? line : JSON.stringify(line))).join("\n"), "utf8");
}

describe("agent-trace-routes", () => {
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "xiaoshuo-agent-traces-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it("returns 400 when no project is opened", async () => {
    const writeJson = vi.fn();
    const handled = await handleAgentTraceRoutes(
      { method: "GET" } as IncomingMessage,
      createResponse(),
      "/api/agent/traces",
      new URLSearchParams(),
      createContext(),
      {
        ensureProjectSessionCurrent: vi.fn().mockResolvedValue({ path: "" }),
        writeJson
      }
    );

    expect(handled).toBe(true);
    expect(writeJson).toHaveBeenCalledWith(expect.anything(), 400, { detail: "尚未打开项目" });
  });

  it("lists newest traces first and respects the limit", async () => {
    await writeTraceFile("20260706.jsonl", [createTrace("run-old", "旧输入", "2026-07-06T10:00:00.000Z")]);
    await writeTraceFile("20260707.jsonl", [
      createTrace("run-mid", "中间输入", "2026-07-07T08:00:00.000Z"),
      "{not json",
      createTrace("run-new-skill", "最新输入", "2026-07-07T09:00:00.000Z")
    ]);
    const writeJson = vi.fn();

    const handled = await handleAgentTraceRoutes(
      { method: "GET" } as IncomingMessage,
      createResponse(),
      "/api/agent/traces",
      new URLSearchParams("limit=2"),
      createContext(),
      {
        ensureProjectSessionCurrent: vi.fn().mockResolvedValue({ path: tempDir }),
        writeJson
      }
    );

    expect(handled).toBe(true);
    expect(writeJson).toHaveBeenCalledWith(
      expect.anything(),
      200,
      expect.arrayContaining([
        expect.objectContaining({ run_id: "run-new-skill", input_excerpt: "最新输入" }),
        expect.objectContaining({ run_id: "run-mid", input_excerpt: "中间输入" })
      ])
    );
    expect(writeJson.mock.calls[0]?.[2]).toHaveLength(2);
  });

  it("returns an individual trace by run id", async () => {
    await writeTraceFile("20260707.jsonl", [createTrace("run-detail", "详情输入", "2026-07-07T09:00:00.000Z")]);
    const writeJson = vi.fn();

    const handled = await handleAgentTraceRoutes(
      { method: "GET" } as IncomingMessage,
      createResponse(),
      "/api/agent/traces/run-detail",
      new URLSearchParams(),
      createContext(),
      {
        ensureProjectSessionCurrent: vi.fn().mockResolvedValue({ path: tempDir }),
        writeJson
      }
    );

    expect(handled).toBe(true);
    expect(writeJson).toHaveBeenCalledWith(expect.anything(), 200, expect.objectContaining({ run_id: "run-detail", input_excerpt: "详情输入" }));
  });

  it("returns 404 when a trace is missing", async () => {
    await writeTraceFile("20260707.jsonl", [createTrace("run-present", "已有输入", "2026-07-07T09:00:00.000Z")]);
    const writeJson = vi.fn();

    const handled = await handleAgentTraceRoutes(
      { method: "GET" } as IncomingMessage,
      createResponse(),
      "/api/agent/traces/run-missing",
      new URLSearchParams(),
      createContext(),
      {
        ensureProjectSessionCurrent: vi.fn().mockResolvedValue({ path: tempDir }),
        writeJson
      }
    );

    expect(handled).toBe(true);
    expect(writeJson).toHaveBeenCalledWith(expect.anything(), 404, { detail: "未找到 Agent trace" });
  });
});
