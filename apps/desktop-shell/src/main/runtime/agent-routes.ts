import { AgentRuntimeService, encodeNdjsonEvent } from "@xiaoshuo/agent-runtime";
import type { DocumentTimelineSession } from "@xiaoshuo/document-service";
import { DocumentService } from "@xiaoshuo/document-service";
import { agentPlanRequestSchema, agentRunRequestSchema, fileOperationSchema, type CurrentProject, type FileOperation } from "@xiaoshuo/shared";
import { VectorIndex } from "@xiaoshuo/vector-service";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { RuntimeContext } from "./types.js";

type JsonRecord = Record<string, unknown>;

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
  deps: RuntimeAgentRouteDeps
): Promise<boolean> {
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
    const currentProject = await deps.ensureProjectSessionCurrent(context);
    if (!currentProject.path) {
      deps.writeJson(response, 400, { detail: "尚未打开项目" });
      return true;
    }
    const runtime = new AgentRuntimeService({
      projectRoot: currentProject.path,
      config: { rootDir: context.projectRoot, env: process.env }
    });
    deps.writeJson(response, 200, await runtime.plan(agentPlanRequestSchema.parse(await deps.readJsonBody(request))));
    return true;
  }

  if (pathname === "/api/agent/run" && request.method === "POST") {
    const currentProject = await deps.ensureProjectSessionCurrent(context);
    if (!currentProject.path) {
      deps.writeJson(response, 400, { detail: "尚未打开项目" });
      return true;
    }

    const rawBody = await deps.readRawBody(request);
    const payload = agentRunRequestSchema.parse(deps.parseJsonRecord(rawBody));
    const runtime = new AgentRuntimeService({
      projectRoot: currentProject.path,
      config: { rootDir: context.projectRoot, env: process.env }
    });

    try {
      deps.writeJson(response, 200, await runtime.runAgent(payload));
    } catch (error) {
      deps.writeJson(response, 400, { detail: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  if (pathname === "/api/agent/run-stream" && request.method === "POST") {
    const currentProject = await deps.ensureProjectSessionCurrent(context);
    if (!currentProject.path) {
      deps.writeJson(response, 400, { detail: "尚未打开项目" });
      return true;
    }

    const rawBody = await deps.readRawBody(request);
    const payload = agentRunRequestSchema.parse(deps.parseJsonRecord(rawBody));
    const runtime = new AgentRuntimeService({
      projectRoot: currentProject.path,
      config: { rootDir: context.projectRoot, env: process.env }
    });

    deps.addCorsHeaders(response);
    response.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8" });
    try {
      for await (const event of runtime.streamAgentRun(payload)) {
        if (event.type === "final" && event.payload.saved_paths.length) {
          await deps.rebuildProjectManifest(currentProject.path);
          const index = new VectorIndex(currentProject.path);
          index.markChanged(event.payload.saved_paths, "upsert");
          index.close();
        }
        deps.writeNdjsonEvent(response, event);
      }
    } catch (error) {
      deps.writeNdjsonEvent(response, {
        type: "error",
        message: error instanceof Error ? error.message : String(error)
      });
    } finally {
      response.end();
    }
    return true;
  }

  return false;
}
