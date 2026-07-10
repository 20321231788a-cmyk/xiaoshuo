import {
  isSectionedGeneratedSkillId,
  type GeneratedCacheCommitInput,
  type GeneratedCacheCommitResult
} from "@xiaoshuo/agent-runtime";
import { GeneratedCacheService } from "@xiaoshuo/generated-cache";
import { generatedSaveRequestSchema, type CurrentProject } from "@xiaoshuo/shared";
import { VectorIndex } from "@xiaoshuo/vector-service";
import type { IncomingMessage, ServerResponse } from "node:http";
import { getProjectAgentRuntime } from "./agent-runtime-registry.js";
import type { RuntimeContext } from "./types.js";

type JsonRecord = Record<string, unknown>;

type RuntimeGeneratedCacheRouteDeps = {
  ensureProjectSessionCurrent: (context: RuntimeContext) => Promise<CurrentProject>;
  readJsonBody: (request: IncomingMessage) => Promise<JsonRecord>;
  readRawBody: (request: IncomingMessage) => Promise<Buffer>;
  parseJsonRecord: (rawBody: Buffer) => JsonRecord;
  rebuildProjectManifest: (projectPath: string) => Promise<void>;
  stringValue: (value: unknown) => string;
  writeJson: (response: ServerResponse, status: number, payload: unknown) => void;
};

export async function handleGeneratedCacheRoutes(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  context: RuntimeContext,
  deps: RuntimeGeneratedCacheRouteDeps
): Promise<boolean> {
  if (!pathname.startsWith("/api/agent/generated") || !request.method) {
    return false;
  }

  const currentProject = await deps.ensureProjectSessionCurrent(context);
  if (!currentProject.path) {
    deps.writeJson(response, 400, { detail: "尚未打开项目" });
    return true;
  }

  const segments = pathname.split("/").filter(Boolean);
  const cacheService = new GeneratedCacheService({ projectRoot: currentProject.path });
  const commitThroughRuntime = async (
    input: GeneratedCacheCommitInput
  ): Promise<GeneratedCacheCommitResult | null> => {
    try {
      return await getProjectAgentRuntime(context, currentProject.path).commitGeneratedCache(input);
    } catch (error) {
      if (runtimeErrorCode(error) === "GENERATED_CACHE_SKILL_MISMATCH") {
        deps.writeJson(response, 409, {
          detail: error instanceof Error ? error.message : "生成缓存技能身份不匹配",
          code: "GENERATED_CACHE_SKILL_MISMATCH"
        });
        return null;
      }
      throw error;
    }
  };

  if (request.method === "POST" && segments.length === 4 && segments[3] === "save") {
    const payload = generatedSaveRequestSchema.parse(await deps.readJsonBody(request));
    const skillId = (payload.skill_id || "").trim();

    let savedPaths: string[] = [];
    if (payload.cache_id) {
      const committed = await commitThroughRuntime({
        cache_id: payload.cache_id,
        source: "generated_save_route",
        skill_id: skillId,
        mode: payload.mode,
        target_paths: payload.target_paths,
        save_plan: payload.save_plan,
        summary: "Generated result confirmed by user",
        cleanup_content: true
      });
      if (!committed) {
        return true;
      }
      savedPaths = committed.saved_paths;
    } else {
      const paths = payload.target_paths.length ? payload.target_paths : (payload.target_path ? [payload.target_path] : []);
      if (!paths.length && !isSectionedGeneratedSkillId(skillId)) {
        deps.writeJson(response, 400, { detail: "没有可写入的目标文件" });
        return true;
      }
      const committed = await commitThroughRuntime({
        content: payload.content,
        source: "generated_save_route",
        skill_id: skillId,
        mode: payload.mode,
        target_paths: paths,
        summary: "Generated draft saved by user",
        cleanup_content: true
      });
      if (!committed) {
        return true;
      }
      savedPaths = committed.saved_paths;
    }

    if (savedPaths.length) {
      await deps.rebuildProjectManifest(currentProject.path);
      const index = new VectorIndex(currentProject.path);
      index.markChanged(savedPaths, "upsert");
      index.close();
    }
    deps.writeJson(response, 200, { saved_paths: savedPaths, save_plan: payload.save_plan });
    return true;
  }

  if (request.method === "POST" && segments.length === 6 && segments[3] === "cache" && segments[5] === "commit") {
    const cacheId = decodeURIComponent(segments[4] || "");
    const rawBody = await deps.readRawBody(request);
    const payload = deps.parseJsonRecord(rawBody) || {};

    const skillId = deps.stringValue(payload.skill_id).trim();

    const mode = (payload.mode === "append" || payload.mode === "replace") ? payload.mode : undefined;
    const targetPaths = Array.isArray(payload.target_paths)
      ? payload.target_paths.map(String)
      : (payload.target_path ? [String(payload.target_path)] : undefined);

    const savePlan = payload.save_plan && typeof payload.save_plan === "object" ? payload.save_plan as any : undefined;
    const committed = await commitThroughRuntime({
      cache_id: cacheId,
      source: "generated_cache_commit_route",
      skill_id: skillId,
      mode,
      target_paths: targetPaths,
      save_plan: savePlan,
      summary: "Generated cache committed by user",
      cleanup_content: true
    });
    if (!committed) {
      return true;
    }
    const savedPaths = committed.saved_paths;
    if (savedPaths.length) {
      await deps.rebuildProjectManifest(currentProject.path);
      const index = new VectorIndex(currentProject.path);
      index.markChanged(savedPaths, "upsert");
      index.close();
    }
    deps.writeJson(response, 200, { saved_paths: savedPaths });
    return true;
  }

  if (request.method === "GET" && segments.length === 5 && segments[3] === "cache") {
    const cacheId = decodeURIComponent(segments[4] || "");
    try {
      const meta = await cacheService.get(cacheId);
      const content = meta.status === "pending" ? await cacheService.readContent(cacheId) : "";
      deps.writeJson(response, 200, { meta, content });
    } catch (error) {
      deps.writeJson(response, 404, { detail: error instanceof Error ? error.message : "生成缓存不存在或已被清理" });
    }
    return true;
  }

  if (request.method === "DELETE" && segments.length === 5 && segments[3] === "cache") {
    const cacheId = decodeURIComponent(segments[4] || "");
    deps.writeJson(response, 200, await cacheService.discard(cacheId));
    return true;
  }

  if (request.method === "POST" && segments.length === 5 && segments[3] === "cache" && segments[4] === "cleanup") {
    deps.writeJson(response, 200, await cacheService.cleanupExpired());
    return true;
  }

  return false;
}

function runtimeErrorCode(error: unknown): string {
  if (!error || typeof error !== "object") {
    return "";
  }
  return String((error as { code?: unknown }).code || "");
}
