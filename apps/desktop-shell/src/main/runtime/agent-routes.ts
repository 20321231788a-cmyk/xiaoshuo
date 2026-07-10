import { AgentRuntimeService, encodeNdjsonEvent } from "@xiaoshuo/agent-runtime";
import {
  agentConfirmationResolveRequestSchema,
  agentPlanRequestSchema,
  agentRunControlRequestSchema,
  agentRunRequestSchema,
  agentRunStatusSchema,
  agentStepRetryRequestSchema,
  type CurrentProject
} from "@xiaoshuo/shared";
import { VectorIndex } from "@xiaoshuo/vector-service";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createRequestAbortSignal } from "./http-utils.js";
import { getProjectAgentRuntime } from "./agent-runtime-registry.js";
import { writeAiLicenseRequiredIfNeeded } from "./license-guard.js";
import type { RuntimeContext } from "./types.js";

type JsonRecord = Record<string, unknown>;
type RuntimeAbortOptions = { signal?: AbortSignal };
type AbortableAgentRuntimeService = Omit<AgentRuntimeService, "plan" | "runAgent" | "streamAgentRun"> & {
  plan: (payload: Parameters<AgentRuntimeService["plan"]>[0], options: RuntimeAbortOptions) => ReturnType<AgentRuntimeService["plan"]>;
  runAgent: (payload: Parameters<AgentRuntimeService["runAgent"]>[0], options: RuntimeAbortOptions) => ReturnType<AgentRuntimeService["runAgent"]>;
  streamAgentRun: (
    payload: Parameters<AgentRuntimeService["streamAgentRun"]>[0],
    options: RuntimeAbortOptions
  ) => ReturnType<AgentRuntimeService["streamAgentRun"]>;
};

type RuntimeAgentRouteDeps = {
  ensureProjectSessionCurrent: (context: RuntimeContext) => Promise<CurrentProject>;
  readJsonBody: (request: IncomingMessage) => Promise<JsonRecord>;
  readRawBody: (request: IncomingMessage) => Promise<Buffer>;
  parseJsonRecord: (rawBody: Buffer) => JsonRecord;
  rebuildProjectManifest: (projectPath: string) => Promise<void>;
  writeJson: (response: ServerResponse, status: number, payload: unknown) => void;
  writeNdjsonEvent: (response: ServerResponse, payload: Parameters<typeof encodeNdjsonEvent>[0]) => void;
  addCorsHeaders: (response: ServerResponse) => void;
};

export async function handleAgentRoutes(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  context: RuntimeContext,
  deps: RuntimeAgentRouteDeps,
  searchParams = new URLSearchParams()
): Promise<boolean> {
  const runRoute = matchAgentRunLifecycleRoute(pathname);
  const confirmationRoute = matchAgentConfirmationRoute(pathname);
  if (pathname === "/api/agent/runs" || runRoute || confirmationRoute) {
    const currentProject = await deps.ensureProjectSessionCurrent(context);
    if (!currentProject.path) {
      deps.writeJson(response, 400, { detail: "尚未打开项目", code: "PROJECT_NOT_OPEN" });
      return true;
    }
    const runtime = getProjectAgentRuntime(context, currentProject.path);
    try {
      if (pathname === "/api/agent/runs" && request.method === "GET") {
        const rawStatus = String(searchParams.get("status") || "").trim();
        const status = rawStatus ? agentRunStatusSchema.parse(rawStatus) : undefined;
        const limit = clampInteger(searchParams.get("limit"), 50, 1, 200);
        const cursor = decodeRunCursor(searchParams.get("cursor") || "");
        const rows = runtime.listDurableRuns(status ? [status] : undefined, limit + 1, cursor?.updated_at);
        const runs = rows.slice(0, limit);
        deps.writeJson(response, 200, {
          runs,
          next_cursor: rows.length > limit && runs.length ? encodeRunCursor(runs.at(-1)!.updated_at) : null
        });
        return true;
      }

      if (pathname === "/api/agent/runs" && request.method === "POST") {
        if (await writeAiLicenseRequiredIfNeeded(context, response, deps.writeJson)) {
          return true;
        }
        const created = await runtime.createDurableRun(agentRunRequestSchema.parse(await deps.readJsonBody(request)));
        deps.writeJson(response, created.created ? 201 : 200, created.run);
        return true;
      }

      if (runRoute && !runRoute.action && request.method === "GET") {
        const run = runtime.getDurableRun(runRoute.runId);
        if (!run) {
          deps.writeJson(response, 404, { detail: "Agent 运行记录不存在", code: "RUN_NOT_FOUND" });
          return true;
        }
        deps.writeJson(response, 200, run);
        return true;
      }

      if (runRoute?.action === "export" && request.method === "GET") {
        deps.writeJson(response, 200, runtime.exportDurableRun(runRoute.runId));
        return true;
      }

      if (runRoute && !runRoute.action && request.method === "DELETE") {
        deps.writeJson(response, 200, runtime.deleteDurableRun(runRoute.runId));
        return true;
      }

      if (runRoute?.action === "confirmations" && request.method === "GET") {
        if (!runtime.getDurableRun(runRoute.runId)) {
          deps.writeJson(response, 404, { detail: "Agent 运行记录不存在", code: "RUN_NOT_FOUND" });
          return true;
        }
        deps.writeJson(response, 200, runtime.listDurableRunConfirmations(runRoute.runId));
        return true;
      }

      if (runRoute?.action === "events" && request.method === "GET") {
        if (!runtime.getDurableRun(runRoute.runId)) {
          deps.writeJson(response, 404, { detail: "Agent 运行记录不存在", code: "RUN_NOT_FOUND" });
          return true;
        }
        const after = clampInteger(searchParams.get("after"), 0, 0, Number.MAX_SAFE_INTEGER);
        const limit = clampInteger(searchParams.get("limit"), 200, 1, 1_000);
        const rows = runtime.listDurableRunEvents(runRoute.runId, after, limit + 1);
        const events = rows.slice(0, limit);
        const earliestAvailableSequence = runtime.listDurableRunEvents(runRoute.runId, 0, 1)[0]?.sequence ?? 0;
        const nextSequence = events.at(-1)?.sequence ?? after;
        deps.writeJson(response, 200, {
          events,
          next_after: nextSequence,
          next_sequence: nextSequence,
          has_more: rows.length > limit,
          earliest_available_sequence: earliestAvailableSequence,
          gap_detected: earliestAvailableSequence > 0 && after < earliestAvailableSequence - 1
        });
        return true;
      }

      if (runRoute?.action === "event-stream" && request.method === "GET") {
        const initialRun = runtime.getDurableRun(runRoute.runId);
        if (!initialRun) {
          deps.writeJson(response, 404, { detail: "Agent 运行记录不存在", code: "RUN_NOT_FOUND" });
          return true;
        }

        const after = clampInteger(searchParams.get("after"), 0, 0, Number.MAX_SAFE_INTEGER);
        await streamDurableRunEvents(request, response, runtime, runRoute.runId, after);
        return true;
      }

      if (runRoute && request.method === "POST" && (runRoute.action === "pause" || runRoute.action === "cancel")) {
        const payload = agentRunControlRequestSchema.parse(await deps.readJsonBody(request));
        const run = runRoute.action === "pause"
          ? runtime.pauseDurableRun(runRoute.runId, payload.operation_id, payload.expected_version)
          : runtime.cancelDurableRun(runRoute.runId, payload.operation_id, payload.expected_version);
        deps.writeJson(response, 200, run);
        return true;
      }

      if (runRoute?.action === "resume" && request.method === "POST") {
        if (await writeAiLicenseRequiredIfNeeded(context, response, deps.writeJson)) {
          return true;
        }
        const payload = agentRunControlRequestSchema.parse(await deps.readJsonBody(request));
        deps.writeJson(response, 200, runtime.resumeDurableRun(runRoute.runId, payload.operation_id, payload.expected_version));
        return true;
      }

      if (runRoute?.action === "retry" && runRoute.stepId && request.method === "POST") {
        if (await writeAiLicenseRequiredIfNeeded(context, response, deps.writeJson)) {
          return true;
        }
        const payload = agentStepRetryRequestSchema.parse(await deps.readJsonBody(request));
        deps.writeJson(
          response,
          200,
          runtime.retryDurableRunStep(runRoute.runId, runRoute.stepId, payload.operation_id, payload.expected_version)
        );
        return true;
      }

      if (confirmationRoute && request.method === "POST") {
        const payload = agentConfirmationResolveRequestSchema.parse(await deps.readJsonBody(request));
        const confirmation = runtime.resolveDurableConfirmation(
          confirmationRoute.confirmationId,
          confirmationRoute.action,
          payload.operation_id,
          payload.expected_version
        );
        deps.writeJson(response, 200, confirmation);
        return true;
      }
    } catch (error) {
      const code = lifecycleErrorCode(error);
      const status = code === "RUN_NOT_FOUND" || code === "CONFIRMATION_NOT_FOUND" || code === "RUN_PROJECT_SCOPE_MISMATCH"
        ? 404
        : code === "REQUEST_ID_REUSED" || code.includes("CONFLICT") || code.includes("VERSION") || code.includes("CONFIRMATION_") || code === "RUN_ACTIVE" || code === "RUN_NOT_TERMINAL" || code === "RUN_JOURNAL_PENDING"
          ? 409
          : 400;
      deps.writeJson(response, status, { detail: error instanceof Error ? error.message : String(error), code });
      return true;
    }
  }

  if (pathname === "/api/agent/execute" && request.method === "POST") {
    // This endpoint wrote raw operations outside the durable run, confirmation,
    // and commit-journal protocols. Keep the route explicit so old clients fail
    // safely rather than silently performing an unaudited write.
    deps.writeJson(response, 410, {
      detail: "旧 Agent 文件执行接口已退役，请改用 POST /api/agent/runs。",
      code: "AGENT_EXECUTE_RETIRED"
    });
    return true;
  }

  if (pathname === "/api/agent/plan" && request.method === "POST") {
    if (await writeAiLicenseRequiredIfNeeded(context, response, deps.writeJson)) {
      return true;
    }
    const currentProject = await deps.ensureProjectSessionCurrent(context);
    if (!currentProject.path) {
      deps.writeJson(response, 400, { detail: "尚未打开项目" });
      return true;
    }
    const runtime = getProjectAgentRuntime(context, currentProject.path) as AbortableAgentRuntimeService;
    const signal = createRequestAbortSignal(request, response);
    const result = await runtime.plan(agentPlanRequestSchema.parse(await deps.readJsonBody(request)), { signal });
    if (!signal.aborted) {
      deps.writeJson(response, 200, result);
    }
    return true;
  }

  if (pathname === "/api/agent/run" && request.method === "POST") {
    if (await writeAiLicenseRequiredIfNeeded(context, response, deps.writeJson)) {
      return true;
    }
    const currentProject = await deps.ensureProjectSessionCurrent(context);
    if (!currentProject.path) {
      deps.writeJson(response, 400, { detail: "尚未打开项目" });
      return true;
    }

    const rawBody = await deps.readRawBody(request);
    const payload = agentRunRequestSchema.parse(deps.parseJsonRecord(rawBody));
    const runtime = getProjectAgentRuntime(context, currentProject.path) as AbortableAgentRuntimeService;

    try {
      // A transport disconnect ends only this HTTP response. Durable run controls
      // are explicit pause/cancel operations and must survive a renderer reload.
      const result = await runtime.runAgent(payload, {});
      if (canWriteResponse(response)) {
        deps.writeJson(response, 200, result);
      }
    } catch (error) {
      if (canWriteResponse(response)) {
        deps.writeJson(response, 400, { detail: error instanceof Error ? error.message : String(error) });
      }
    }
    return true;
  }

  if (pathname === "/api/agent/run-stream" && request.method === "POST") {
    if (await writeAiLicenseRequiredIfNeeded(context, response, deps.writeJson)) {
      return true;
    }
    const currentProject = await deps.ensureProjectSessionCurrent(context);
    if (!currentProject.path) {
      deps.writeJson(response, 400, { detail: "尚未打开项目" });
      return true;
    }

    const rawBody = await deps.readRawBody(request);
    const payload = agentRunRequestSchema.parse(deps.parseJsonRecord(rawBody));
    const runtime = getProjectAgentRuntime(context, currentProject.path) as AbortableAgentRuntimeService;

    if (canWriteResponse(response)) {
      deps.addCorsHeaders(response);
      response.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8" });
    }
    try {
      for await (const event of runtime.streamAgentRun(payload, {})) {
        if (event.type === "final" && event.payload.saved_paths.length) {
          await deps.rebuildProjectManifest(currentProject.path);
          const index = new VectorIndex(currentProject.path);
          index.markChanged(event.payload.saved_paths, "upsert");
          index.close();
        }
        if (canWriteResponse(response)) {
          deps.writeNdjsonEvent(response, event);
        }
      }
    } catch (error) {
      if (canWriteResponse(response)) {
        deps.writeNdjsonEvent(response, {
          type: "error",
          message: error instanceof Error ? error.message : String(error)
        });
      }
    } finally {
      if (canWriteResponse(response)) {
        response.end();
      }
    }
    return true;
  }

  return false;
}

type AgentRunLifecycleRoute = {
  runId: string;
  action?: "confirmations" | "events" | "event-stream" | "export" | "pause" | "resume" | "cancel" | "retry";
  stepId?: string;
};

function matchAgentRunLifecycleRoute(pathname: string): AgentRunLifecycleRoute | null {
  const retry = pathname.match(/^\/api\/agent\/runs\/([^/]+)\/steps\/([^/]+)\/retry$/);
  if (retry) {
    return { runId: decodeRoutePart(retry[1]!), stepId: decodeRoutePart(retry[2]!), action: "retry" };
  }
  const eventStream = pathname.match(/^\/api\/agent\/runs\/([^/]+)\/events\/stream$/);
  if (eventStream) {
    return { runId: decodeRoutePart(eventStream[1]!), action: "event-stream" };
  }
  const action = pathname.match(/^\/api\/agent\/runs\/([^/]+)\/(confirmations|events|export|pause|resume|cancel)$/);
  if (action) {
    return { runId: decodeRoutePart(action[1]!), action: action[2] as AgentRunLifecycleRoute["action"] };
  }
  const detail = pathname.match(/^\/api\/agent\/runs\/([^/]+)$/);
  return detail ? { runId: decodeRoutePart(detail[1]!) } : null;
}

function matchAgentConfirmationRoute(pathname: string): { confirmationId: string; action: "approved" | "rejected" } | null {
  const match = pathname.match(/^\/api\/agent\/confirmations\/([^/]+)\/(approve|reject)$/);
  if (!match) {
    return null;
  }
  return {
    confirmationId: decodeRoutePart(match[1]!),
    action: match[2] === "approve" ? "approved" : "rejected"
  };
}

function decodeRoutePart(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function clampInteger(value: string | null, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

function canWriteResponse(response: ServerResponse): boolean {
  return !response.writableEnded && !response.destroyed;
}

function encodeRunCursor(updatedAt: string): string {
  return Buffer.from(JSON.stringify({ updated_at: updatedAt }), "utf8").toString("base64url");
}

function decodeRunCursor(value: string): { updated_at: string } | null {
  if (!value) {
    return null;
  }
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as { updated_at?: unknown };
    return typeof parsed.updated_at === "string" && parsed.updated_at ? { updated_at: parsed.updated_at } : null;
  } catch {
    throw Object.assign(new Error("无效的 Agent 运行列表 cursor"), { code: "INVALID_CURSOR" });
  }
}

function lifecycleErrorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    return String((error as { code?: unknown }).code || "AGENT_RUN_ERROR");
  }
  if (error && typeof error === "object" && "name" in error) {
    const name = String((error as { name?: unknown }).name || "");
    if (name.includes("Conflict")) {
      return "VERSION_CONFLICT";
    }
  }
  return "AGENT_RUN_ERROR";
}

const DURABLE_EVENT_STREAM_POLL_MS = 250;
const DURABLE_EVENT_STREAM_HEARTBEAT_MS = 15_000;
const terminalRunStatuses = new Set(["failed", "cancelled", "completed"]);

/**
 * This is deliberately a read-only projection of the durable event journal.
 * Transport loss only stops the projection; it never sends a control signal to
 * the run that owns the events.
 */
async function streamDurableRunEvents(
  request: IncomingMessage,
  response: ServerResponse,
  runtime: Pick<AgentRuntimeService, "getDurableRun" | "listDurableRunEvents">,
  runId: string,
  after: number
): Promise<void> {
  let cursor = after;
  let closed = false;
  let lastHeartbeatAt = Date.now();
  const stop = () => {
    closed = true;
  };

  request.once("aborted", stop);
  response.once("close", stop);
  response.writeHead(200, {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive"
  });

  try {
    const earliestAvailableSequence = after > 0 ? runtime.listDurableRunEvents(runId, 0, 1)[0]?.sequence ?? 0 : 0;
    if (earliestAvailableSequence > 0 && after < earliestAvailableSequence - 1) {
      await writeNdjsonRecord(response, {
        type: "gap",
        run_id: runId,
        after,
        earliest_available_sequence: earliestAvailableSequence
      });
    }
    while (!closed && canWriteResponse(response)) {
      const events = runtime.listDurableRunEvents(runId, cursor, 200);
      for (const event of events) {
        if (closed || !canWriteResponse(response)) {
          break;
        }
        await writeNdjsonRecord(response, { type: "event", event });
        cursor = Math.max(cursor, event.sequence);
      }

      const current = runtime.getDurableRun(runId);
      if (!current) {
        if (!closed && canWriteResponse(response)) {
          await writeNdjsonRecord(response, { type: "end", run_id: runId, after: cursor, reason: "run_not_found" });
        }
        break;
      }
      if (terminalRunStatuses.has(current.status) && events.length === 0) {
        await writeNdjsonRecord(response, { type: "end", run_id: runId, after: cursor, status: current.status });
        break;
      }

      const now = Date.now();
      if (now - lastHeartbeatAt >= DURABLE_EVENT_STREAM_HEARTBEAT_MS) {
        await writeNdjsonRecord(response, { type: "heartbeat", run_id: runId, after: cursor, at: new Date(now).toISOString() });
        lastHeartbeatAt = now;
      }
      await delay(DURABLE_EVENT_STREAM_POLL_MS);
    }
  } finally {
    request.off("aborted", stop);
    response.off("close", stop);
    if (canWriteResponse(response)) {
      response.end();
    }
  }
}

async function writeNdjsonRecord(response: ServerResponse, payload: Record<string, unknown>): Promise<void> {
  if (response.write(`${JSON.stringify(payload)}\n`) !== false) {
    return;
  }
  await new Promise<void>((resolve) => {
    const done = () => {
      response.off("drain", done);
      response.off("close", done);
      resolve();
    };
    response.once("drain", done);
    response.once("close", done);
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
