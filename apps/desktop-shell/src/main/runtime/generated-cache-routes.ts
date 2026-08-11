import {
  isSectionedGeneratedSkillId,
  type GeneratedCacheCommitInput,
  type GeneratedCacheCommitResult
} from "@xiaoshuo/agent-runtime";
import { GeneratedCacheService } from "@xiaoshuo/generated-cache";
import { DocumentService } from "@xiaoshuo/document-service";
import { generatedSaveRequestSchema, type CurrentProject } from "@xiaoshuo/shared";
import { VectorIndex } from "@xiaoshuo/vector-service";
import { createHash } from "node:crypto";
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
  const documents = new DocumentService({ projectRoot: currentProject.path });
  const commitThroughRuntime = async (
    input: GeneratedCacheCommitInput
  ): Promise<GeneratedCacheCommitResult | null> => {
    try {
      return await (await getProjectAgentRuntime(context, currentProject.path)).commitGeneratedCache(input);
    } catch (error) {
      if (runtimeErrorCode(error) === "GENERATED_CACHE_SKILL_MISMATCH") {
        deps.writeJson(response, 409, {
          detail: error instanceof Error ? error.message : "生成缓存技能身份不匹配",
          code: "GENERATED_CACHE_SKILL_MISMATCH"
        });
        return null;
      }
      if (runtimeErrorCode(error) === "QUALITY_GATE_REJECTED") {
        deps.writeJson(response, 422, {
          detail: error instanceof Error ? error.message : "生成内容未通过质量门，未写入文件。",
          code: "QUALITY_GATE_REJECTED",
          report: error && typeof error === "object" && "report" in error ? (error as { report?: unknown }).report : undefined
        });
        return null;
      }
      throw error;
    }
  };

  if (request.method === "POST" && segments.length === 4 && segments[3] === "save") {
    const payload = generatedSaveRequestSchema.parse(await deps.readJsonBody(request));
    const skillId = (payload.skill_id || "").trim();

    const expectedTargetHashes = readTargetHashes(payload.expected_target_hashes);
    if (payload.cache_id && Object.keys(expectedTargetHashes).length) {
      const preview = await previewGeneratedCache(cacheService, documents, payload.cache_id, payload);
      const conflict = await targetHashConflict(documents, preview.targets, expectedTargetHashes);
      if (conflict) {
        deps.writeJson(response, 409, { detail: `目标文件已变化：${conflict}。请刷新预览后再确认写入。`, code: "GENERATED_PREVIEW_STALE" });
        return true;
      }
    }

    let savedPaths: string[] = [];
    let postprocess: Pick<GeneratedCacheCommitResult, "story_planning" | "library_draft" | "postprocess_warning"> = {};
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
      postprocess = postprocessFromCommit(committed);
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
      postprocess = postprocessFromCommit(committed);
    }

    if (savedPaths.length) {
      await deps.rebuildProjectManifest(currentProject.path);
      const index = new VectorIndex(currentProject.path);
      index.markChanged(savedPaths, "upsert");
      index.close();
    }
    deps.writeJson(response, 200, { saved_paths: savedPaths, save_plan: payload.save_plan, ...postprocess });
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
    const expectedTargetHashes = readTargetHashes(payload.expected_target_hashes);
    if (Object.keys(expectedTargetHashes).length) {
      const preview = await previewGeneratedCache(cacheService, documents, cacheId, { mode, target_paths: targetPaths || [], save_plan: savePlan });
      const conflict = await targetHashConflict(documents, preview.targets, expectedTargetHashes);
      if (conflict) {
        deps.writeJson(response, 409, { detail: `目标文件已变化：${conflict}。请刷新预览后再确认写入。`, code: "GENERATED_PREVIEW_STALE" });
        return true;
      }
    }
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
    deps.writeJson(response, 200, {
      saved_paths: savedPaths,
      story_planning: committed.story_planning,
      library_draft: committed.library_draft,
      postprocess_warning: committed.postprocess_warning
    });
    return true;
  }

  if (request.method === "POST" && segments.length === 6 && segments[3] === "cache" && segments[5] === "preview") {
    const cacheId = decodeURIComponent(segments[4] || "");
    try {
      const payload = await deps.readJsonBody(request);
      deps.writeJson(response, 200, await previewGeneratedCache(cacheService, documents, cacheId, {
        mode: payload.mode === "append" ? "append" : "replace",
        target_paths: Array.isArray(payload.target_paths) ? payload.target_paths.map(String) : [],
        save_plan: payload.save_plan && typeof payload.save_plan === "object" ? payload.save_plan as any : undefined
      }));
    } catch (error) {
      deps.writeJson(response, 400, { detail: error instanceof Error ? error.message : "无法生成写入预览" });
    }
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

type PreviewTarget = {
  target_path: string;
  mode: "replace" | "append";
  before_content: string;
  after_content: string;
  before_hash: string;
  before_chars: number;
  after_chars: number;
  change: "create" | "append" | "replace";
};

async function previewGeneratedCache(
  cache: GeneratedCacheService,
  documents: DocumentService,
  cacheId: string,
  input: { mode?: "replace" | "append"; target_paths?: string[]; save_plan?: any }
): Promise<{ cache_id: string; targets: PreviewTarget[] }> {
  const meta = await cache.get(cacheId);
  if (meta.status !== "pending") throw new Error("生成缓存已处理，不能再次预览");
  const commits = input.save_plan || meta.save_plan
    ? await cache.prepareSavePlanCommit(cacheId, input.save_plan || meta.save_plan, { mode: input.mode })
    : await cache.prepareTargetCommit(cacheId, input.target_paths?.length ? input.target_paths : meta.target_paths, { mode: input.mode });
  const targets = await Promise.all(commits.map(async (commit) => {
    const before = await documents.readRawText(commit.target_path, 5_000_000).catch(() => "");
    const after = commit.content;
    return {
      target_path: commit.target_path,
      mode: commit.mode,
      before_content: before,
      after_content: after,
      before_hash: hashText(before),
      before_chars: before.length,
      after_chars: after.length,
      change: !before ? "create" : commit.mode === "append" ? "append" : "replace"
    } satisfies PreviewTarget;
  }));
  return { cache_id: cacheId, targets };
}

function readTargetHashes(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).flatMap(([path, hash]) => {
    const normalized = String(hash || "").trim();
    return path && normalized ? [[path, normalized]] : [];
  }));
}

async function targetHashConflict(documents: DocumentService, targets: PreviewTarget[], expected: Record<string, string>): Promise<string> {
  for (const target of targets) {
    const expectedHash = expected[target.target_path];
    if (!expectedHash) continue;
    const actual = hashText(await documents.readRawText(target.target_path, 5_000_000).catch(() => ""));
    if (actual !== expectedHash) return target.target_path;
  }
  return "";
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function postprocessFromCommit(commit: GeneratedCacheCommitResult): Pick<GeneratedCacheCommitResult, "story_planning" | "library_draft" | "postprocess_warning"> {
  const result: Pick<GeneratedCacheCommitResult, "story_planning" | "library_draft" | "postprocess_warning"> = {};
  if (commit.story_planning !== undefined) result.story_planning = commit.story_planning;
  if (commit.library_draft !== undefined) result.library_draft = commit.library_draft;
  if (commit.postprocess_warning !== undefined) result.postprocess_warning = commit.postprocess_warning;
  return result;
}

function runtimeErrorCode(error: unknown): string {
  if (!error || typeof error !== "object") {
    return "";
  }
  return String((error as { code?: unknown }).code || "");
}
