import { AgentRuntimeService, encodeNdjsonEvent } from "@xiaoshuo/agent-runtime";
import type { DocumentTimelineSession } from "@xiaoshuo/document-service";
import { DocumentService } from "@xiaoshuo/document-service";
import {
  agentConfirmationResolveRequestSchema,
  agentPlanRequestSchema,
  agentRunControlRequestSchema,
  agentRunRequestSchema,
  agentRunStatusSchema,
  agentStepRetryRequestSchema,
  fileOperationSchema,
  type CurrentProject,
  type FileOperation
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
  ensureDocumentSession: (sessions: Map<string, DocumentTimelineSession>, projectPath: string) => DocumentTimelineSession;
  readJsonBody: (request: IncomingMessage) => Promise<JsonRecord>;
  readRawBody: (request: IncomingMessage) => Promise<Buffer>;
  parseJsonRecord: (rawBody: Buffer) => JsonRecord;
  booleanValue: (value: unknown) => boolean;
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

      if (runRoute && !runRoute.action && request.method === "GET") {
        const run = runtime.getDurableRun(runRoute.runId);
        if (!run) {
          deps.writeJson(response, 404, { detail: "Agent 运行记录不存在", code: "RUN_NOT_FOUND" });
          return true;
        }
        deps.writeJson(response, 200, run);
        return true;
      }

      if (runRoute?.action === "events" && request.method === "GET") {
        if (!runtime.getDurableRun(runRoute.runId)) {
          deps.writeJson(response, 404, { detail: "Agent 运行记录不存在", code: "RUN_NOT_FOUND" });
          return true;
        }
        const after = clampInteger(searchParams.get("after"), 0, 0, Number.MAX_SAFE_INTEGER);
        const events = runtime.listDurableRunEvents(runRoute.runId, after, 500);
        deps.writeJson(response, 200, {
          events,
          next_after: events.at(-1)?.sequence ?? after
        });
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
      const status = code === "RUN_NOT_FOUND" || code === "CONFIRMATION_NOT_FOUND" ? 404 : code.includes("CONFLICT") || code.includes("VERSION") ? 409 : 400;
      deps.writeJson(response, status, { detail: error instanceof Error ? error.message : String(error), code });
      return true;
    }
  }

  if (pathname === "/api/agent/execute" && request.method === "POST") {
    const currentProject = await deps.ensureProjectSessionCurrent(context);
    if (!currentProject.path) {
      deps.writeJson(response, 400, { detail: "尚未打开项目" });
      return true;
    }
    const payload = await deps.readJsonBody(request);
    const operations = Array.isArray(payload.operations)
      ? payload.operations.map((operation) => fileOperationSchema.parse(operation) as FileOperation)
      : [];
    const documents = new DocumentService({ projectRoot: currentProject.path });
    const results = await documents.executeOperations(operations, {
      confirmDelete: deps.booleanValue(payload.confirm_delete ?? payload.confirmDelete),
      source: "agent",
      session: deps.ensureDocumentSession(context.documentSessions, currentProject.path)
    });
    if (results.some((result) => result.ok)) {
      await deps.rebuildProjectManifest(currentProject.path);
      const index = new VectorIndex(currentProject.path);
      const upserts: string[] = [];
      const deletes: string[] = [];
      for (let i = 0; i < operations.length; i++) {
        if (!results[i]?.ok) continue;
        const op = operations[i]!;
        if (op.action === "archive_file") {
          deletes.push(op.path);
        } else if (op.action === "move_file") {
          deletes.push(op.path);
          if (op.target_path) {
            upserts.push(op.target_path);
          }
        } else {
          upserts.push(op.path);
        }
      }
      if (upserts.length) index.markChanged(upserts, "upsert");
      if (deletes.length) index.markChanged(deletes, "delete");
      index.close();
    }
    deps.writeJson(response, 200, results);
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
  action?: "events" | "pause" | "resume" | "cancel" | "retry";
  stepId?: string;
};

function matchAgentRunLifecycleRoute(pathname: string): AgentRunLifecycleRoute | null {
  const retry = pathname.match(/^\/api\/agent\/runs\/([^/]+)\/steps\/([^/]+)\/retry$/);
  if (retry) {
    return { runId: decodeRoutePart(retry[1]!), stepId: decodeRoutePart(retry[2]!), action: "retry" };
  }
  const action = pathname.match(/^\/api\/agent\/runs\/([^/]+)\/(events|pause|resume|cancel)$/);
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
