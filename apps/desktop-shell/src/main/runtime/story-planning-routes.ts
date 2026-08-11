import { saveStoryPlanningRequestSchema } from "@xiaoshuo/shared";
import { StoryPlanningConflictError, StoryPlanningService, type DocumentTimelineSession } from "@xiaoshuo/document-service";
import { ProjectManifestService } from "@xiaoshuo/project-manifest";
import { VectorIndex } from "@xiaoshuo/vector-service";
import { getProjectAgentRuntime } from "./agent-runtime-registry.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { RuntimeContext } from "./types.js";

type JsonRecord = Record<string, unknown>;
type RouteDeps = {
  ensureProjectSessionCurrent: (context: RuntimeContext) => Promise<{ path: string; name: string }>;
  ensureDocumentSession: (sessions: Map<string, DocumentTimelineSession>, projectPath: string) => DocumentTimelineSession;
  readJsonBody: (request: IncomingMessage) => Promise<JsonRecord>;
  writeJson: (response: ServerResponse, status: number, payload: unknown) => void;
};

export async function handleStoryPlanningRoutes(request: IncomingMessage, response: ServerResponse, pathname: string, context: RuntimeContext, deps: RouteDeps): Promise<boolean> {
  if (pathname !== "/api/story-planning" && pathname !== "/api/story-planning/migrate" && pathname !== "/api/story-planning/rebuild-from-source") return false;
  const current = await deps.ensureProjectSessionCurrent(context);
  if (!current.path) return false;
  const service = new StoryPlanningService({ projectRoot: current.path });
  try {
    if (request.method === "GET" && pathname === "/api/story-planning") {
      deps.writeJson(response, 200, await service.get());
      return true;
    }
    if (request.method === "POST" && pathname === "/api/story-planning/migrate") {
      const bundle = await service.migrate(deps.ensureDocumentSession(context.documentSessions, current.path));
      await refreshProjectArtifacts(current.path, bundle.projection_paths);
      deps.writeJson(response, 200, bundle);
      return true;
    }
    if (request.method === "POST" && pathname === "/api/story-planning/rebuild-from-source") {
      const rebuilt = await (await getProjectAgentRuntime(context, current.path)).rebuildStoryPlanningFromSavedSources();
      await refreshProjectArtifacts(current.path, rebuilt.story_planning?.projection_paths || []);
      deps.writeJson(response, 200, rebuilt);
      return true;
    }
    if (request.method === "PUT" && pathname === "/api/story-planning") {
      const payload = saveStoryPlanningRequestSchema.parse(await deps.readJsonBody(request));
      const bundle = await service.save({ baseRevision: payload.base_revision, outline: payload.outline, timeline: payload.timeline, session: deps.ensureDocumentSession(context.documentSessions, current.path) });
      await refreshProjectArtifacts(current.path, bundle.projection_paths);
      deps.writeJson(response, 200, bundle);
      return true;
    }
  } catch (error) {
    deps.writeJson(response, error instanceof StoryPlanningConflictError ? 409 : 400, { detail: error instanceof Error ? error.message : String(error), code: error instanceof StoryPlanningConflictError ? error.code : undefined });
    return true;
  }
  return false;
}

async function refreshProjectArtifacts(projectPath: string, paths: string[]): Promise<void> {
  await new ProjectManifestService(projectPath).rebuild();
  const index = new VectorIndex(projectPath);
  index.markChanged(paths, "upsert");
  index.close();
}
