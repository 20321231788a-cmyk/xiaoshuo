import { AgentRuntimeService } from "@xiaoshuo/agent-runtime";
import { SkillService } from "@xiaoshuo/skill-service";
import {
  skillDraftFromUrlRequestSchema,
  skillImportDraftRequestSchema,
  skillImportRequestSchema,
  skillRunRequestSchema,
  type CurrentProject
} from "@xiaoshuo/shared";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { RuntimeContext } from "./types.js";

type JsonRecord = Record<string, unknown>;

type SkillRouteMatch =
  | {
      id?: string;
      action?: string;
    }
  | null;

type RuntimeSkillRouteDeps = {
  ensureProjectSessionCurrent: (context: RuntimeContext) => Promise<CurrentProject>;
  readJsonBody: (request: IncomingMessage) => Promise<JsonRecord>;
  readRawBody: (request: IncomingMessage) => Promise<Buffer>;
  parseJsonRecord: (rawBody: Buffer) => JsonRecord;
  parseMultipartFile: (body: Buffer, contentType: string) => { filename: string; mediaType: string; content: Buffer };
  rebuildProjectManifest: (projectPath: string) => Promise<void>;
  writeJson: (response: ServerResponse, status: number, payload: unknown) => void;
  matchSkillRoute: (pathname: string) => SkillRouteMatch;
  openPath: (target: string) => unknown;
};

export async function handleSkillRoutes(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  context: RuntimeContext,
  deps: RuntimeSkillRouteDeps
): Promise<boolean> {
  const skillRoute = deps.matchSkillRoute(pathname);
  if (!skillRoute || !request.method) {
    return false;
  }

  const currentProject = await deps.ensureProjectSessionCurrent(context);
  if (!currentProject.path) {
    deps.writeJson(response, 400, { detail: "尚未打开项目" });
    return true;
  }

  const skills = new SkillService({ projectRoot: currentProject.path });

  if (!skillRoute.id && request.method === "GET") {
    deps.writeJson(response, 200, await skills.listSkills());
    return true;
  }

  if (skillRoute.id && !skillRoute.action && request.method === "GET") {
    const skill = await skills.getSkill(skillRoute.id);
    if (!skill) {
      deps.writeJson(response, 400, { detail: "skill 不存在" });
      return true;
    }
    deps.writeJson(response, 200, skill);
    return true;
  }

  if (skillRoute.id && !skillRoute.action && request.method === "DELETE") {
    try {
      deps.writeJson(response, 200, await skills.deleteSkill(skillRoute.id));
    } catch (error) {
      deps.writeJson(response, 400, { detail: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  if (skillRoute.id && skillRoute.action === "toggle" && request.method === "POST") {
    try {
      const payload = await deps.readJsonBody(request);
      const hasDisabled = Object.prototype.hasOwnProperty.call(payload, "disabled");
      deps.writeJson(response, 200, await skills.toggleBuiltinSkill(skillRoute.id, hasDisabled ? Boolean(payload.disabled) : undefined));
    } catch (error) {
      deps.writeJson(response, 400, { detail: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  if (!skillRoute.id && skillRoute.action === "import" && request.method === "POST") {
    try {
      deps.writeJson(response, 200, await skills.importSkill(skillImportRequestSchema.parse(await deps.readJsonBody(request))));
    } catch (error) {
      deps.writeJson(response, 400, { detail: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  if (!skillRoute.id && skillRoute.action === "import-draft" && request.method === "POST") {
    try {
      deps.writeJson(response, 200, await skills.importSkillDraft(skillImportDraftRequestSchema.parse(await deps.readJsonBody(request))));
    } catch (error) {
      deps.writeJson(response, 400, { detail: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  if (!skillRoute.id && skillRoute.action === "open-folder" && request.method === "POST") {
    const folder = await skills.importedSkillDirectory();
    void deps.openPath(folder);
    deps.writeJson(response, 200, { ok: true, path: folder });
    return true;
  }

  if (!skillRoute.id && skillRoute.action === "upload" && request.method === "POST") {
    const contentType = request.headers["content-type"] || "";
    if (!contentType.includes("multipart/form-data")) {
      deps.writeJson(response, 400, { detail: "Request must be multipart/form-data" });
      return true;
    }
    const rawBody = await deps.readRawBody(request);
    try {
      const { filename, mediaType, content } = deps.parseMultipartFile(rawBody, contentType);
      deps.writeJson(response, 200, await skills.importUploadedSkill(filename, content, mediaType));
    } catch (error) {
      deps.writeJson(response, 400, { detail: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  if (!skillRoute.id && skillRoute.action === "draft-from-url" && request.method === "POST") {
    const rawBody = await deps.readRawBody(request);
    const payload = skillDraftFromUrlRequestSchema.parse(deps.parseJsonRecord(rawBody));
    const runtime = new AgentRuntimeService({
      projectRoot: currentProject.path,
      config: { rootDir: context.projectRoot, env: process.env }
    });
    try {
      deps.writeJson(response, 200, await runtime.draftSkillFromUrl(payload));
    } catch (error) {
      deps.writeJson(response, 400, { detail: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  if (skillRoute.id && skillRoute.action === "run" && request.method === "POST") {
    const rawBody = await deps.readRawBody(request);
    const payload = skillRunRequestSchema.parse(deps.parseJsonRecord(rawBody));
    const runtime = new AgentRuntimeService({
      projectRoot: currentProject.path,
      config: { rootDir: context.projectRoot, env: process.env }
    });

    try {
      const result = await runtime.runSkill(skillRoute.id, payload);
      const savedPaths = Array.isArray(result.data?.saved_paths)
        ? result.data.saved_paths.map(String).filter(Boolean)
        : [];
      if (savedPaths.length) {
        await deps.rebuildProjectManifest(currentProject.path);
      }
      deps.writeJson(response, 200, result);
    } catch (error) {
      deps.writeJson(response, 400, { detail: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  return false;
}
