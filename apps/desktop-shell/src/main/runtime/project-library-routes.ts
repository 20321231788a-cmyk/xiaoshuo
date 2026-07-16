import {
  libraryMigrationRequestSchema,
  libraryReconcileRequestSchema,
  projectLibraryDomainSchema,
  saveProjectLibraryRequestSchema
} from "@xiaoshuo/shared";
import { DocumentService, ProjectLibraryConflictError, ProjectLibraryService, type DocumentTimelineSession } from "@xiaoshuo/document-service";
import { ProjectManifestService } from "@xiaoshuo/project-manifest";
import { VectorIndex } from "@xiaoshuo/vector-service";
import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { getProjectAgentRuntime } from "./agent-runtime-registry.js";
import type { RuntimeContext } from "./types.js";

type JsonRecord = Record<string, unknown>;

type RouteDeps = {
  ensureProjectSessionCurrent: (context: RuntimeContext) => Promise<{ path: string; name: string }>;
  ensureDocumentSession: (sessions: Map<string, DocumentTimelineSession>, projectPath: string) => DocumentTimelineSession;
  readJsonBody: (request: IncomingMessage) => Promise<JsonRecord>;
  writeJson: (response: ServerResponse, status: number, payload: unknown) => void;
};

export async function handleProjectLibraryRoutes(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  context: RuntimeContext,
  deps: RouteDeps
): Promise<boolean> {
  if (!pathname.startsWith("/api/project-libraries") && !pathname.startsWith("/api/project-library-drafts")) {
    return false;
  }
  const current = await deps.ensureProjectSessionCurrent(context);
  if (!current.path) return false;
  const service = new ProjectLibraryService({ projectRoot: current.path });

  if (request.method === "GET" && pathname === "/api/project-library-drafts") {
    deps.writeJson(response, 200, { drafts: await service.listDrafts() });
    return true;
  }

  const draftMatch = /^\/api\/project-library-drafts\/([^/]+)\/(commit)$/.exec(pathname);
  if (draftMatch && request.method === "POST") {
    try {
      const bundle = await service.commitDraft(decodeURIComponent(draftMatch[1] || ""), deps.ensureDocumentSession(context.documentSessions, current.path));
      await afterLibraryCommit(context, current.path, bundle.projection_paths);
      deps.writeJson(response, 200, bundle);
    } catch (error) {
      writeLibraryError(response, error, deps.writeJson);
    }
    return true;
  }

  const draftDelete = /^\/api\/project-library-drafts\/([^/]+)$/.exec(pathname);
  if (draftDelete && request.method === "DELETE") {
    await service.discardDraft(decodeURIComponent(draftDelete[1] || ""), deps.ensureDocumentSession(context.documentSessions, current.path));
    deps.writeJson(response, 200, { ok: true });
    return true;
  }

  if (request.method === "POST" && pathname === "/api/project-libraries/migrate") {
    try {
      const payload = libraryMigrationRequestSchema.parse(await deps.readJsonBody(request));
      const bundles = await service.migrate(payload.domains, deps.ensureDocumentSession(context.documentSessions, current.path));
      await afterLibraryCommit(context, current.path, bundles.flatMap((bundle) => bundle.projection_paths));
      deps.writeJson(response, 200, { bundles });
    } catch (error) {
      writeLibraryError(response, error, deps.writeJson);
    }
    return true;
  }

  const reconcileMatch = /^\/api\/project-libraries\/(lore|style|genre)\/reconcile$/.exec(pathname);
  if (reconcileMatch && request.method === "POST") {
    try {
      const domain = projectLibraryDomainSchema.parse(reconcileMatch[1]);
      const payload = libraryReconcileRequestSchema.parse(await deps.readJsonBody(request));
      const bundle = await service.reconcile(domain, payload.action, deps.ensureDocumentSession(context.documentSessions, current.path));
      await afterLibraryCommit(context, current.path, bundle.projection_paths);
      deps.writeJson(response, 200, bundle);
    } catch (error) {
      writeLibraryError(response, error, deps.writeJson);
    }
    return true;
  }

  const libraryMatch = /^\/api\/project-libraries\/(lore|style|genre)$/.exec(pathname);
  if (!libraryMatch) return false;
  const domain = projectLibraryDomainSchema.parse(libraryMatch[1]);
  if (request.method === "GET") {
    try {
      deps.writeJson(response, 200, await service.get(domain));
    } catch (error) {
      writeLibraryError(response, error, deps.writeJson);
    }
    return true;
  }
  if (request.method === "PUT") {
    try {
      const payload = saveProjectLibraryRequestSchema.parse(await deps.readJsonBody(request));
      const bundle = await service.save(domain, {
        baseRevision: payload.base_revision,
        records: payload.records,
        session: deps.ensureDocumentSession(context.documentSessions, current.path)
      });
      await afterLibraryCommit(context, current.path, bundle.projection_paths);
      deps.writeJson(response, 200, bundle);
    } catch (error) {
      writeLibraryError(response, error, deps.writeJson);
    }
    return true;
  }
  return false;
}

async function afterLibraryCommit(context: RuntimeContext, projectPath: string, paths: string[]): Promise<void> {
  await new ProjectManifestService(projectPath).rebuild();
  const index = new VectorIndex(projectPath);
  index.markChanged([...new Set(paths)], "upsert");
  index.close();
  const documents = new DocumentService({ projectRoot: projectPath });
  const runtime = await getProjectAgentRuntime(context, projectPath);
  for (const entryPath of [...new Set(paths)]) {
    const content = await documents.readRawText(entryPath, 500_000).catch(() => "");
    try {
      await runtime.invalidateGovernedMemorySource({
        sourceRef: entryPath,
        currentSourceRevision: `sha256:${createHash("sha256").update(content).digest("hex")}`
      });
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code || "") : "";
      if (code !== "MEMORY_V2_DISABLED") throw error;
    }
  }
}

function writeLibraryError(
  response: ServerResponse,
  error: unknown,
  writeJson: (response: ServerResponse, status: number, payload: unknown) => void
): void {
  const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code || "") : "";
  const status = error instanceof ProjectLibraryConflictError ? 409 : code === "LIBRARY_CORRUPTED" ? 422 : 400;
  writeJson(response, status, { detail: error instanceof Error ? error.message : String(error), code: code || undefined });
}
