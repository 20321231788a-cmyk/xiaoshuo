import { AgentRuntimeService, DefaultWebSearchClient } from "@xiaoshuo/agent-runtime";
import { loadWebSearchConfig, type WebSearchConfig } from "@xiaoshuo/config-service";
import { NovelCrawlerService, normalizeNovelDirectoryUrl, type NovelSourceResolver, type NovelSourceResolverResult } from "@xiaoshuo/crawler-service";
import { DocumentService } from "@xiaoshuo/document-service";
import { KeyError } from "@xiaoshuo/job-service";
import { ProjectManifestService } from "@xiaoshuo/project-manifest";
import { cardDrawRequestSchema, novelCrawlRequestSchema, type CurrentProject, type JobInfo } from "@xiaoshuo/shared";
import { VectorIndex } from "@xiaoshuo/vector-service";
import type { IncomingMessage, ServerResponse } from "node:http";
import { writeAiLicenseRequiredIfNeeded } from "./license-guard.js";
import { mapLegacyJobToRun } from "./legacy-job-run-mapping.js";
import type { RuntimeContext, RuntimeServerState } from "./types.js";
import { randomUUID } from "node:crypto";

type JsonRecord = Record<string, unknown>;

type RuntimeJobRouteDeps = {
  ensureProjectSessionCurrent: (context: RuntimeContext) => Promise<CurrentProject>;
  readJsonBody: (request: IncomingMessage) => Promise<JsonRecord>;
  rebuildProjectManifest: (projectPath: string) => Promise<void>;
  stringValue: (value: unknown) => string;
  booleanValue: (value: unknown) => boolean;
  writeJson: (response: ServerResponse, status: number, payload: unknown) => void;
};

export async function handleJobRoutes(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  context: RuntimeContext,
  deps: RuntimeJobRouteDeps
): Promise<boolean> {
  if (pathname === "/api/jobs/_ts-runtime" && request.method === "GET") {
    const jobs = context.jobManager.list();
    deps.writeJson(response, 200, {
      active: true,
      routed: "local-ts",
      jobs,
      legacy_run_mappings: jobs.map(mapLegacyJobToRun)
    });
    return true;
  }

  if (!pathname.startsWith("/api/jobs") || !request.method) {
    return false;
  }

  const segments = pathname.split("/").filter(Boolean);
  if (request.method === "GET" && pathname === "/api/jobs/legacy-runs") {
    deps.writeJson(response, 200, { mappings: context.jobManager.list().map(mapLegacyJobToRun) });
    return true;
  }

  if (request.method === "GET" && segments.length === 4 && segments[3] === "legacy-run") {
    const jobId = segments[2] || "";
    try {
      deps.writeJson(response, 200, mapLegacyJobToRun(context.jobManager.get(jobId)));
    } catch (error) {
      deps.writeJson(response, error instanceof KeyError ? 404 : 400, { detail: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  if (segments[2] === "legacy-runs" && request.method !== "GET") {
    deps.writeJson(response, 405, {
      detail: "Legacy JobManager 映射为只读，不能作为可恢复 Agent run 控制",
      code: "LEGACY_RUN_READ_ONLY"
    });
    return true;
  }

  if (request.method === "GET" && segments.length === 2) {
    deps.writeJson(response, 200, context.jobManager.list().slice(-50));
    return true;
  }

  if (request.method === "POST" && segments.length === 2) {
    const payload = await deps.readJsonBody(request);
    const kind = deps.stringValue(payload.kind);

    if (kind === "scan_project") {
      const currentProject = await deps.ensureProjectSessionCurrent(context);
      if (!currentProject.path) {
        deps.writeJson(response, 400, { detail: "尚未打开项目" });
        return true;
      }
      const job = context.jobManager.create("scan_project", async (progress) => {
        progress(0.2, "初始化项目扫描");
        const manifest = new ProjectManifestService(currentProject.path);
        progress(0.5, "扫描清单中");
        const result = await manifest.listDocuments({ force: true });
        progress(1.0, "扫描完成");
        return result;
      });
      deps.writeJson(response, 200, job);
      return true;
    }

    if (kind === "build_continuity_context") {
      const currentProject = await deps.ensureProjectSessionCurrent(context);
      if (!currentProject.path) {
        deps.writeJson(response, 400, { detail: "尚未打开项目" });
        return true;
      }
      const job = context.jobManager.create("build_continuity_context", async (progress) => {
        progress(0.3, "搜集项目写作上下文...");
        const result = await context.projectSession.buildContinuityContext();
        progress(1.0, "上下文收集完成");
        return result;
      });
      deps.writeJson(response, 200, job);
      return true;
    }

    if (kind === "novel_crawl") {
      if (await writeAiLicenseRequiredIfNeeded(context, response, deps.writeJson)) {
        return true;
      }
      const currentProject = await deps.ensureProjectSessionCurrent(context);
      if (!currentProject.path) {
        deps.writeJson(response, 400, { detail: "尚未打开项目" });
        return true;
      }
      const rawPayload = payload.payload && typeof payload.payload === "object" ? payload.payload : payload;
      const crawlRequest = novelCrawlRequestSchema.parse(rawPayload);
      const job = context.jobManager.create("novel_crawl", async (progress) => {
        const crawler = new NovelCrawlerService({
          resolver: createNovelSourceResolver(currentProject.path || context.projectRoot, progress)
        });
        progress(0.02, "准备联网爬取拆书素材");
        const novel = await crawler.crawl(crawlRequest, progress);
        const documents = new DocumentService({ projectRoot: currentProject.path });
        const bookId = `${safeCrawlFilename(novel.title || crawlRequest.query)}-${Date.now().toString(36)}-${randomUUID().replace(/-/g, "").slice(0, 8)}`;
        const bookDir = `00_设定集/拆书库/${bookId}`;
        const sourcePath = `${bookDir}/原文.txt`;
        const manifestPath = `${bookDir}/manifest.jsonl`;
        const targetPath = `00_设定集/拆书素材/${safeCrawlFilename(novel.title || crawlRequest.query)}.txt`;
        const sourceText = novel.toText();
        const sourceChars = sourceText.replace(/\s+/g, "").length;
        await documents.saveDocument(sourcePath, sourceText, {
          source: "crawler",
          summary: "联网爬取拆书原文"
        });
        await documents.saveDocument(manifestPath, `${JSON.stringify({
          id: bookId,
          title: novel.title || crawlRequest.query,
          dir: bookDir,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          origin: "crawl",
          source_path: novel.source_url || "",
          source_summary: novel.chapters.length ? `共 ${novel.chapters.length} 章，约 ${sourceChars} 字` : "",
          chars: sourceText.length,
          paths: {
            source: sourcePath
          }
        })}\n`, {
          source: "crawler",
          summary: "联网爬取拆书 manifest"
        });
        await documents.saveDocument(targetPath, novel.toText(), {
          source: "crawler",
          summary: "联网爬取拆书素材"
        });
        await deps.rebuildProjectManifest(currentProject.path).catch(() => undefined);
        progress(1.0, "拆书素材爬取完成");
        return {
          saved_paths: [sourcePath, targetPath],
          path: sourcePath,
          title: novel.title,
          chapters: novel.chapters.length,
          chars: sourceChars,
          source_url: novel.source_url,
          book_id: bookId,
          book_dir: bookDir
        };
      });
      deps.writeJson(response, 200, job);
      return true;
    }

    deps.writeJson(response, 400, { detail: `不支持的异步任务类型: ${kind}` });
    return true;
  }

  const jobId = segments[2] || "";
  if (jobId) {
    if (jobId.startsWith("ts-")) {
      try {
        if (request.method === "GET" && segments.length === 3) {
          deps.writeJson(response, 200, context.jobManager.get(jobId));
          return true;
        }
        if (request.method === "POST" && segments.length === 4 && segments[3] === "cancel") {
          deps.writeJson(response, 200, context.jobManager.cancel(jobId));
          return true;
        }
      } catch (error) {
        deps.writeJson(response, error instanceof KeyError ? 404 : 400, { detail: error instanceof Error ? error.message : String(error) });
        return true;
      }
    } else {
      deps.writeJson(response, 404, { detail: `未找到任务: ${jobId}` });
      return true;
    }
  }

  return false;
}

function createNovelSourceResolver(
  projectRoot: string,
  progress: (value: number, message: string) => void
): NovelSourceResolver {
  return async (query, context) => {
    const config = await loadWebSearchConfig({ rootDir: projectRoot, env: process.env });
    const searchConfig = forceCrawlerSearchConfig(config);
    const searchClient = new DefaultWebSearchClient();
    const providerLabel = "Bing";
    const collected: NovelSourceResolverResult[] = [];

    const searchQueries = [
      `${query} 小说 txt 全本`,
      `${query} 小说 txt 下载`,
      `${query} 小说 目录`
    ];

    progress(0.04, `${providerLabel} 定位目录`);
    for (const searchQuery of searchQueries) {
      const results = await searchClient.search(searchQuery, searchConfig);
      for (const result of results) {
        const normalized = normalizeNovelDirectoryUrl(result.url);
        collected.push({
          title: result.title || query,
          url: normalized?.url || result.url,
          source: normalized?.source || context.source || "bing"
        });
        if (collected.length >= searchConfig.max_results) {
          break;
        }
      }
      if (collected.length >= searchConfig.max_results) {
        break;
      }
    }
    if (collected.length) {
      progress(0.06, `已定位 ${collected.length} 个候选目录`);
    }

    return dedupeResolverResults(collected);
  };
}

function forceCrawlerSearchConfig(config: WebSearchConfig): WebSearchConfig {
  return {
    ...config,
    enabled: true,
    provider: "bing",
    max_results: Math.max(3, Math.min(5, config.max_results || 3)),
    timeout: Math.max(5, Math.min(60, config.timeout || 10))
  };
}

function dedupeResolverResults(results: NovelSourceResolverResult[]): NovelSourceResolverResult[] {
  const seen = new Set<string>();
  const deduped: NovelSourceResolverResult[] = [];
  for (const item of results) {
    const key = item.url.replace(/\/+$/, "");
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(item);
  }
  return deduped;
}

function safeCrawlFilename(value: string): string {
  const cleaned = value
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1F]+/g, "-")
    .replace(/\s+/g, " ")
    .slice(0, 80);
  return cleaned || "联网拆书素材";
}

export function listRuntimeJobs(state: RuntimeServerState): JobInfo[] {
  return state.jobManager?.list() ?? [];
}
