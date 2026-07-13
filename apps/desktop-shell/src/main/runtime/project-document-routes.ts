import { DocumentSaveConflictError, DocumentService, type DocumentTimelineSession } from "@xiaoshuo/document-service";
import { ProjectManifestService } from "@xiaoshuo/project-manifest";
import {
  projectOpenRequestSchema,
  projectRenameRequestSchema,
  saveDocumentRequestSchema,
  type CurrentProject
} from "@xiaoshuo/shared";
import { VectorIndex } from "@xiaoshuo/vector-service";
import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { getProjectAgentRuntime } from "./agent-runtime-registry.js";
import type { RuntimeContext } from "./types.js";

type JsonRecord = Record<string, unknown>;

type TimelineRouteMatch =
  | {
      id: string;
      action?: string;
    }
  | null;

type RuntimeProjectDocumentRouteDeps = {
  ensureProjectSessionCurrent: (context: RuntimeContext) => Promise<CurrentProject>;
  ensureDocumentSession: (sessions: Map<string, DocumentTimelineSession>, projectPath: string) => DocumentTimelineSession;
  startDocumentSession: (sessions: Map<string, DocumentTimelineSession>, projectPath: string) => DocumentTimelineSession;
  moveDocumentSession: (sessions: Map<string, DocumentTimelineSession>, fromProjectPath: string, toProjectPath: string) => DocumentTimelineSession;
  readJsonBody: (request: IncomingMessage) => Promise<JsonRecord>;
  readRequestFields: (request: IncomingMessage) => Promise<JsonRecord>;
  rebuildProjectManifest: (projectPath: string) => Promise<void>;
  booleanValue: (value: unknown) => boolean;
  stringValue: (value: unknown) => string;
  readBooleanQuery: (value: string | null | undefined) => boolean;
  readIntQuery: (value: string | null | undefined, fallback: number, min: number, max: number) => number;
  writeJson: (response: ServerResponse, status: number, payload: unknown) => void;
  matchDocumentRoute: (pathname: string) => string;
  matchTimelineRoute: (pathname: string) => TimelineRouteMatch;
};

export async function handleProjectDocumentRoutes(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  searchParams: URLSearchParams,
  context: RuntimeContext,
  deps: RuntimeProjectDocumentRouteDeps
): Promise<boolean> {
  if (request.method === "GET" && pathname === "/api/projects/current") {
    deps.writeJson(response, 200, await deps.ensureProjectSessionCurrent(context));
    return true;
  }

  if (request.method === "POST" && pathname === "/api/projects/open") {
    const payload = projectOpenRequestSchema.parse(await deps.readJsonBody(request));
    const opened = await context.projectSession.openProject(payload.path);
    // Opening a project is the explicit user action that may migrate a legacy
    // v1 identity record. Routine background/request confirmation is never
    // allowed to upgrade a record that lacks an OS file identity.
    if (context.projectIdentityRegistry) {
      const projectId = await new ProjectManifestService(opened.path).getProjectId();
      await context.projectIdentityRegistry.reconfirm(opened.path, projectId);
    }
    deps.startDocumentSession(context.documentSessions, opened.path);
    deps.writeJson(response, 200, opened);
    return true;
  }

  if (request.method === "POST" && pathname === "/api/projects/create") {
    const payload = projectOpenRequestSchema.parse(await deps.readJsonBody(request));
    const created = await context.projectSession.createProject(payload.path, payload.project_name, payload.create_in_parent);
    deps.startDocumentSession(context.documentSessions, created.path);
    deps.writeJson(response, 200, created);
    return true;
  }

  if (request.method === "PUT" && pathname === "/api/projects/current") {
    const payload = projectRenameRequestSchema.parse(await deps.readJsonBody(request));
    const renamed = await context.projectSession.renameCurrentProject(payload.name);
    if (renamed.previous_path && renamed.path) {
      deps.moveDocumentSession(context.documentSessions, renamed.previous_path, renamed.path);
      await deps.rebuildProjectManifest(renamed.path);
    }
    deps.writeJson(response, 200, renamed);
    return true;
  }

  if (request.method === "GET" && pathname === "/api/documents") {
    const currentProject = await deps.ensureProjectSessionCurrent(context);
    if (!currentProject.path) {
      deps.writeJson(response, 400, { detail: "尚未打开项目" });
      return true;
    }
    const manifest = new ProjectManifestService(currentProject.path);
    deps.writeJson(response, 200, await manifest.listDocuments({ force: deps.readBooleanQuery(searchParams.get("force")) }));
    return true;
  }

  const documentPath = deps.matchDocumentRoute(pathname);
  if ((request.method === "GET" || request.method === "PUT" || request.method === "DELETE") && documentPath) {
    const currentProject = await deps.ensureProjectSessionCurrent(context);
    if (!currentProject.path) {
      deps.writeJson(response, 400, { detail: "尚未打开项目" });
      return true;
    }
    const documents = new DocumentService({ projectRoot: currentProject.path });
    if (request.method === "GET") {
      deps.writeJson(response, 200, await documents.readDocument(documentPath));
      return true;
    }
    if (request.method === "DELETE") {
      const payload = await deps.readRequestFields(request);
      if (!deps.booleanValue(payload.confirm_delete ?? payload.confirmDelete)) {
        deps.writeJson(response, 400, { detail: "删除/归档文件需要用户确认" });
        return true;
      }
      const archived = await documents.archiveDocument(documentPath, {
        source: "agent",
        session: deps.ensureDocumentSession(context.documentSessions, currentProject.path)
      });
      await deps.rebuildProjectManifest(currentProject.path);
      const index = new VectorIndex(currentProject.path);
      index.markChanged([documentPath], "delete");
      index.close();
      await invalidateGovernedMemorySource(context, currentProject.path, documentPath, "", true);
      deps.writeJson(response, 200, { ok: true, path: archived.path, archived_path: archived.archived_path });
      return true;
    }
    const payload = saveDocumentRequestSchema.parse(await deps.readJsonBody(request));
    const runtime = await getProjectAgentRuntime(context, currentProject.path);
    if ("evaluateArtifactQuality" in runtime && typeof runtime.evaluateArtifactQuality === "function") {
      const report = await runtime.evaluateArtifactQuality(payload.content, "project_document");
      if (report && !report.passed) {
        deps.writeJson(response, 422, {
          detail: "内容未通过质量门，未保存文件。",
          code: "QUALITY_GATE_REJECTED",
          report
        });
        return true;
      }
    }
    let saved;
    try {
      saved = await documents.saveDocument(documentPath, payload.content, {
        source: "editor",
        session: deps.ensureDocumentSession(context.documentSessions, currentProject.path),
        baseUpdatedAt: payload.base_updated_at,
        baseUpdatedAtMs: payload.base_updated_at_ms,
        force: payload.force
      });
    } catch (error) {
      if (error instanceof DocumentSaveConflictError) {
        deps.writeJson(response, 409, {
          detail: error.message,
          code: error.code,
          current_updated_at: error.currentUpdatedAt,
          current_updated_at_ms: error.currentUpdatedAtMs
        });
        return true;
      }
      throw error;
    }
    if (saved.changed !== false) {
      await deps.rebuildProjectManifest(currentProject.path);
      const index = new VectorIndex(currentProject.path);
      index.markChanged([documentPath], "upsert");
      index.close();
       await invalidateGovernedMemorySource(context, currentProject.path, documentPath, saved.content);
    }
    deps.writeJson(response, 200, saved);
    return true;
  }

  if (request.method === "GET" && pathname === "/api/project/tree") {
    const currentProject = await deps.ensureProjectSessionCurrent(context);
    if (!currentProject.path) {
      deps.writeJson(response, 400, { detail: "尚未打开项目" });
      return true;
    }
    const manifest = new ProjectManifestService(currentProject.path);
    deps.writeJson(response, 200, await manifest.tree({ force: deps.readBooleanQuery(searchParams.get("force")) }));
    return true;
  }

  if (request.method === "GET" && pathname === "/api/project/tree/subtree") {
    const currentProject = await deps.ensureProjectSessionCurrent(context);
    if (!currentProject.path) {
      deps.writeJson(response, 400, { detail: "尚未打开项目" });
      return true;
    }
    const manifest = new ProjectManifestService(currentProject.path);
    deps.writeJson(response, 200, await manifest.subtree(searchParams.get("path") || "", currentProject.name || "项目"));
    return true;
  }

  if (request.method === "GET" && pathname === "/api/project/manifest/status") {
    const currentProject = await deps.ensureProjectSessionCurrent(context);
    if (!currentProject.path) {
      deps.writeJson(response, 400, { detail: "尚未打开项目" });
      return true;
    }
    const manifest = new ProjectManifestService(currentProject.path);
    deps.writeJson(response, 200, await manifest.status({ force: deps.readBooleanQuery(searchParams.get("force")) }));
    return true;
  }

  if (request.method === "GET" && pathname === "/api/libraries") {
    const currentProject = await deps.ensureProjectSessionCurrent(context);
    if (!currentProject.path) {
      deps.writeJson(response, 400, { detail: "尚未打开项目" });
      return true;
    }
    const manifest = new ProjectManifestService(currentProject.path);
    deps.writeJson(response, 200, await manifest.listLibraryCards());
    return true;
  }

  if (request.method === "GET" && pathname === "/api/project/chrome") {
    const currentProject = await deps.ensureProjectSessionCurrent(context);
    if (!currentProject.path) {
      deps.writeJson(response, 400, { detail: "尚未打开项目" });
      return true;
    }
    const manifest = new ProjectManifestService(currentProject.path);
    const documents = new DocumentService({ projectRoot: currentProject.path });
    const timeline = await documents.listTimeline(deps.readIntQuery(searchParams.get("timeline_limit"), 80, 1, 300));
    deps.writeJson(
      response,
      200,
      await manifest.projectChromeSnapshot(currentProject, timeline, {
        force: deps.readBooleanQuery(searchParams.get("force")),
        includeTree: searchParams.get("include_tree") === null ? true : deps.readBooleanQuery(searchParams.get("include_tree"))
      })
    );
    return true;
  }

  if (request.method === "GET" && pathname === "/api/timeline") {
    const currentProject = await deps.ensureProjectSessionCurrent(context);
    if (!currentProject.path) {
      deps.writeJson(response, 400, { detail: "尚未打开项目" });
      return true;
    }
    const documents = new DocumentService({ projectRoot: currentProject.path });
    deps.writeJson(response, 200, await documents.listTimeline(deps.readIntQuery(searchParams.get("limit"), 80, 1, 300)));
    return true;
  }

  const timelineRoute = deps.matchTimelineRoute(pathname);
  if (timelineRoute && (request.method === "GET" || request.method === "DELETE" || request.method === "POST")) {
    const currentProject = await deps.ensureProjectSessionCurrent(context);
    if (!currentProject.path) {
      deps.writeJson(response, 400, { detail: "尚未打开项目" });
      return true;
    }
    const documents = new DocumentService({ projectRoot: currentProject.path });
    if (!timelineRoute.action && request.method === "GET") {
      deps.writeJson(response, 200, await documents.getTimelineEntry(timelineRoute.id));
      return true;
    }
    if (!timelineRoute.action && request.method === "DELETE") {
      deps.writeJson(response, 200, await documents.deleteTimelineEntry(timelineRoute.id));
      return true;
    }
    if (timelineRoute.action === "rollback" && request.method === "POST") {
      const payload = await deps.readRequestFields(request);
      const rolledBack = await documents.rollbackTimelineEntry(timelineRoute.id, {
          confirmDelete: deps.booleanValue(payload.confirm_delete ?? payload.confirmDelete),
          session: deps.ensureDocumentSession(context.documentSessions, currentProject.path)
        });
      if (rolledBack.ok && rolledBack.entry) {
        for (const file of rolledBack.entry.files) {
          const sourceContent = file.after_exists
            ? (await documents.readDocument(file.path)).content
            : "deleted";
          await invalidateGovernedMemorySource(
            context,
            currentProject.path,
            file.path,
            sourceContent,
            !file.after_exists
          );
        }
      }
      deps.writeJson(response, 200, rolledBack);
      return true;
    }
  }

  if (pathname === "/api/ledger" && (request.method === "GET" || request.method === "POST")) {
    const currentProject = await deps.ensureProjectSessionCurrent(context);
    if (!currentProject.path) {
      deps.writeJson(response, 400, { detail: "尚未打开项目" });
      return true;
    }
    const documents = new DocumentService({ projectRoot: currentProject.path });
    if (request.method === "GET") {
      deps.writeJson(response, 200, await documents.getLedger());
      return true;
    }
    const payload = await deps.readRequestFields(request);
    deps.writeJson(response, 200, await documents.addLedgerItem(deps.stringValue(payload.desc)));
    return true;
  }

  if (pathname === "/api/ledger/toggle" && request.method === "POST") {
    const currentProject = await deps.ensureProjectSessionCurrent(context);
    if (!currentProject.path) {
      deps.writeJson(response, 400, { detail: "尚未打开项目" });
      return true;
    }
    const documents = new DocumentService({ projectRoot: currentProject.path });
    const payload = await deps.readRequestFields(request);
    deps.writeJson(response, 200, await documents.toggleLedgerItem(deps.stringValue(payload.item_id ?? payload.itemId)));
    return true;
  }

  if (pathname === "/api/revision-log" && (request.method === "GET" || request.method === "DELETE")) {
    const currentProject = await deps.ensureProjectSessionCurrent(context);
    if (!currentProject.path) {
      deps.writeJson(response, 400, { detail: "尚未打开项目" });
      return true;
    }
    const documents = new DocumentService({ projectRoot: currentProject.path });
    if (request.method === "GET") {
      deps.writeJson(response, 200, await documents.listRevisionLogs());
      return true;
    }
    const payload = await deps.readRequestFields(request);
    await documents.clearRevisionLogs(deps.booleanValue(payload.confirm_delete ?? payload.confirmDelete));
    deps.writeJson(response, 200, { ok: true });
    return true;
  }

  return false;
}

async function invalidateGovernedMemorySource(
  context: RuntimeContext,
  projectPath: string,
  sourceRef: string,
  content: string,
  deleted = false
): Promise<void> {
  const runtime = await getProjectAgentRuntime(context, projectPath);
  try {
    await runtime.invalidateGovernedMemorySource({
      sourceRef: sourceRef.replace(/\\/g, "/"),
      currentSourceRevision: deleted
        ? "deleted"
        : `sha256:${createHash("sha256").update(content).digest("hex")}`
    });
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code || "")
      : "";
    // memory_v2 is optional. When disabled, document operations retain their
    // normal behavior and do not create a governed-memory store.
    if (code === "MEMORY_V2_DISABLED") {
      return;
    }
    throw error;
  }
}
