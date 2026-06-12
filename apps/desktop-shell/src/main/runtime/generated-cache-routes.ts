import { PromptSkillRunner } from "@xiaoshuo/agent-runtime";
import { DocumentService } from "@xiaoshuo/document-service";
import { GeneratedCacheService } from "@xiaoshuo/generated-cache";
import { generatedSaveRequestSchema, type CurrentProject } from "@xiaoshuo/shared";
import { VectorIndex } from "@xiaoshuo/vector-service";
import type { IncomingMessage, ServerResponse } from "node:http";
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

  if (request.method === "POST" && segments.length === 4 && segments[3] === "save") {
    const payload = generatedSaveRequestSchema.parse(await deps.readJsonBody(request));
    const skillId = (payload.skill_id || "").trim();

    if (skillId === "lore_extract" || skillId === "genre_generate") {
      const content = payload.cache_id ? await cacheService.readContent(payload.cache_id) : payload.content || "";
      const runner = new PromptSkillRunner({
        projectRoot: currentProject.path,
        config: { rootDir: context.projectRoot, env: process.env }
      });
      const finalMode = payload.mode === "append" ? "append" : "replace";
      const savedPaths = skillId === "genre_generate"
        ? await runner.saveGenreSections(content, finalMode, { summaryPrefix: "题材库保存" })
        : await runner.saveLoreSections(content, finalMode, {
            summaryPrefix: "设定提取保存",
            mergeExisting: finalMode !== "replace"
          });

      if (savedPaths.length) {
        await deps.rebuildProjectManifest(currentProject.path);
        const index = new VectorIndex(currentProject.path);
        index.markChanged(savedPaths, "upsert");
        index.close();
        if (payload.cache_id) {
          await cacheService.markCommitted(payload.cache_id, savedPaths, { cleanupContent: true });
        }
      }
      deps.writeJson(response, 200, { saved_paths: savedPaths, save_plan: payload.save_plan });
      return true;
    }

    let savedPaths: string[] = [];
    if (payload.cache_id) {
      savedPaths = payload.save_plan
        ? await cacheService.commitSavePlan(payload.cache_id, payload.save_plan, {
            mode: payload.mode,
            cleanupContent: true
          })
        : await cacheService.commitToTargets(payload.cache_id, payload.target_paths, {
            mode: payload.mode,
            cleanupContent: true
          });
    } else {
      const paths = payload.target_paths.length ? payload.target_paths : (payload.target_path ? [payload.target_path] : []);
      if (!paths.length) {
        deps.writeJson(response, 400, { detail: "没有可写入的目标文件" });
        return true;
      }
      const documentService = new DocumentService({ projectRoot: currentProject.path });
      for (const relPath of paths) {
        if (payload.mode === "append") {
          await documentService.appendDocument(relPath, payload.content);
        } else {
          await documentService.saveDocument(relPath, payload.content);
        }
        savedPaths.push(relPath);
      }
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

    let skillId = "";
    try {
      const meta = await cacheService.get(cacheId);
      skillId = (deps.stringValue(payload.skill_id) || meta.skill_id || "").trim();
    } catch {
      // cache not found
    }

    if (skillId === "lore_extract" || skillId === "genre_generate") {
      const content = await cacheService.readContent(cacheId);
      const runner = new PromptSkillRunner({
        projectRoot: currentProject.path,
        config: { rootDir: context.projectRoot, env: process.env }
      });
      const finalMode = payload.mode === "append" ? "append" : "replace";
      const savedPaths = skillId === "genre_generate"
        ? await runner.saveGenreSections(content, finalMode, { summaryPrefix: "题材库保存" })
        : await runner.saveLoreSections(content, finalMode, {
            summaryPrefix: "设定提取保存",
            mergeExisting: finalMode !== "replace"
          });

      if (savedPaths.length) {
        await deps.rebuildProjectManifest(currentProject.path);
        const index = new VectorIndex(currentProject.path);
        index.markChanged(savedPaths, "upsert");
        index.close();
        await cacheService.markCommitted(cacheId, savedPaths, { cleanupContent: true });
      }
      deps.writeJson(response, 200, { saved_paths: savedPaths });
      return true;
    }

    const mode = (payload.mode === "append" || payload.mode === "replace") ? payload.mode : undefined;
    const targetPaths = Array.isArray(payload.target_paths)
      ? payload.target_paths.map(String)
      : (payload.target_path ? [String(payload.target_path)] : undefined);

    const savePlan = payload.save_plan && typeof payload.save_plan === "object" ? payload.save_plan as any : undefined;
    const savedPaths = savePlan
      ? await cacheService.commitSavePlan(cacheId, savePlan, {
          mode,
          cleanupContent: true
        })
      : await cacheService.commitToTargets(cacheId, targetPaths, {
          mode,
          cleanupContent: true
        });
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
