import { getAgentTraceDirPath } from "@xiaoshuo/agent-runtime";
import { agentRunTraceSchema, type AgentRunTrace, type CurrentProject } from "@xiaoshuo/shared";
import fs from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import type { RuntimeContext } from "./types.js";

const DEFAULT_TRACE_LIMIT = 50;
const MAX_TRACE_LIMIT = 200;

type RuntimeAgentTraceRouteDeps = {
  ensureProjectSessionCurrent: (context: RuntimeContext) => Promise<CurrentProject>;
  writeJson: (response: ServerResponse, status: number, payload: unknown) => void;
};

export async function handleAgentTraceRoutes(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  searchParams: URLSearchParams,
  context: RuntimeContext,
  deps: RuntimeAgentTraceRouteDeps
): Promise<boolean> {
  if (pathname === "/api/agent/traces" && request.method === "GET") {
    const currentProject = await deps.ensureProjectSessionCurrent(context);
    if (!currentProject.path) {
      deps.writeJson(response, 400, { detail: "尚未打开项目" });
      return true;
    }

    try {
      deps.writeJson(response, 200, await listAgentTraces(currentProject.path, parseTraceLimit(searchParams.get("limit"))));
    } catch (error) {
      deps.writeJson(response, 500, { detail: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  const detailMatch = pathname.match(/^\/api\/agent\/traces\/([^/]+)$/);
  if (detailMatch && request.method === "GET") {
    const currentProject = await deps.ensureProjectSessionCurrent(context);
    if (!currentProject.path) {
      deps.writeJson(response, 400, { detail: "尚未打开项目" });
      return true;
    }

    const runId = decodeURIComponent(detailMatch[1] || "").trim();
    if (!runId) {
      deps.writeJson(response, 400, { detail: "缺少 trace run_id" });
      return true;
    }

    try {
      const trace = await findAgentTrace(currentProject.path, runId);
      if (!trace) {
        deps.writeJson(response, 404, { detail: "未找到 Agent trace" });
        return true;
      }
      deps.writeJson(response, 200, trace);
    } catch (error) {
      deps.writeJson(response, 500, { detail: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  return false;
}

async function listAgentTraces(projectRoot: string, limit: number): Promise<AgentRunTrace[]> {
  const traces: AgentRunTrace[] = [];
  for (const filePath of await listTraceFiles(projectRoot)) {
    const fileTraces = await readTraceFile(filePath);
    for (const trace of fileTraces.reverse()) {
      traces.push(trace);
      if (traces.length >= limit) {
        return traces;
      }
    }
  }
  return traces;
}

async function findAgentTrace(projectRoot: string, runId: string): Promise<AgentRunTrace | null> {
  for (const filePath of await listTraceFiles(projectRoot)) {
    const fileTraces = await readTraceFile(filePath);
    const match = fileTraces.reverse().find((trace) => trace.run_id === runId);
    if (match) {
      return match;
    }
  }
  return null;
}

async function listTraceFiles(projectRoot: string): Promise<string[]> {
  const traceRoot = getAgentTraceDirPath(projectRoot);
  try {
    const entries = await fs.readdir(traceRoot, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
      .map((entry) => path.join(traceRoot, entry.name))
      .sort((left, right) => right.localeCompare(left));
  } catch (error) {
    if (isNotFoundError(error)) {
      return [];
    }
    throw error;
  }
}

async function readTraceFile(filePath: string): Promise<AgentRunTrace[]> {
  const raw = await fs.readFile(filePath, "utf8");
  const traces: AgentRunTrace[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const parsed = agentRunTraceSchema.safeParse(JSON.parse(trimmed) as unknown);
      if (parsed.success) {
        traces.push(parsed.data);
      }
    } catch {
      // Corrupt trace lines are ignored so one bad diagnostics record does not hide the rest.
    }
  }
  return traces;
}

function parseTraceLimit(value: string | null): number {
  const parsed = Number.parseInt(value || "", 10);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_TRACE_LIMIT;
  }
  return Math.max(1, Math.min(MAX_TRACE_LIMIT, parsed));
}

function isNotFoundError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT");
}
