import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DocumentService } from "@xiaoshuo/document-service";
import { generatedCacheMetaSchema, generatedSavePlanSchema, type GeneratedCacheMeta, type GeneratedSavePlan } from "@xiaoshuo/shared";

const CACHE_ROOT_REL = "00_设定集/.agent/generated_cache";
const CONTENT_NAME = "content.txt";
const METADATA_NAME = "metadata.json";

const DEFAULT_SETTLED_CACHE_RETENTION_SECONDS = 7 * 24 * 60 * 60;
const DEFAULT_FAILED_CACHE_RETENTION_SECONDS = 7 * 24 * 60 * 60;
const DEFAULT_ORPHANED_CACHE_RETENTION_SECONDS = 30 * 24 * 60 * 60;
const AUTO_CLEANUP_INTERVAL_SECONDS = 6 * 60 * 60;

export type GeneratedCacheServiceOptions = {
  projectRoot: string;
  documentService?: DocumentService;
  now?: () => string;
  idFactory?: () => string;
};

export type CreateCacheOptions = {
  source: string;
  target_paths?: string[];
  skill_id?: string;
  mode?: "replace" | "append";
  conversation_id?: string;
  summary?: string;
  transient?: boolean;
  save_plan?: GeneratedSavePlan;
};

export type CommitOptions = {
  mode?: "replace" | "append";
  stripContent?: boolean;
  requireContent?: boolean;
  cleanupContent?: boolean;
};

/** A validated, fully composed document replacement that has not been written. */
export type PreparedGeneratedCacheCommit = {
  cache_id: string;
  target_path: string;
  content: string;
  mode: "replace" | "append";
  action_key: string;
};

export type CleanupResult = {
  ok: boolean;
  skipped: boolean;
  deleted: number;
  kept: number;
  errors: string[];
};

export class GeneratedCacheService {
  readonly projectRoot: string;
  private readonly documentService: DocumentService;
  private readonly now: () => string;
  private readonly idFactory: () => string;

  // Track the last cleanup time by project path to avoid frequent runs
  private static readonly lastCleanupByProject = new Map<string, number>();

  constructor(options: GeneratedCacheServiceOptions) {
    this.projectRoot = path.resolve(options.projectRoot);
    this.documentService = options.documentService || new DocumentService({ projectRoot: this.projectRoot });
    this.now = options.now || (() => formatTimestamp(new Date()));
    this.idFactory = options.idFactory || (() => randomUUID().replace(/-/g, ""));
  }

  async create(options: CreateCacheOptions): Promise<GeneratedCacheMeta> {
    await this.cleanupExpiredIfDue().catch(() => {});
    return this.createAtId(this.idFactory(), options);
  }

  async createWithId(cacheId: string, options: CreateCacheOptions): Promise<GeneratedCacheMeta> {
    await this.cleanupExpiredIfDue().catch(() => {});
    const metaPath = this.getMetaPath(cacheId);
    const exists = await fs.stat(metaPath).then((s) => s.isFile()).catch(() => false);
    if (exists) {
      return this.get(cacheId);
    }
    return this.createAtId(cacheId, options);
  }

  private async createAtId(cacheId: string, options: CreateCacheOptions): Promise<GeneratedCacheMeta> {
    const cacheDir = this.getCacheDir(cacheId);
    await fs.mkdir(cacheDir, { recursive: true });

    const contentPath = path.join(cacheDir, CONTENT_NAME);
    await fs.writeFile(contentPath, "", "utf8");

    const normalizedTargets = this.normalizePaths(options.target_paths || []);
    const relativeCachePath = path.posix.relative(this.projectRoot, contentPath);

    const meta: GeneratedCacheMeta = {
      cache_id: cacheId,
      status: "pending",
      source: options.source || "",
      skill_id: options.skill_id || "",
      mode: options.mode || "replace",
      conversation_id: options.conversation_id || "",
      summary: options.summary || "",
      target_paths: normalizedTargets,
      cache_path: relativeCachePath,
      chars: 0,
      created_at: this.now(),
      updated_at: this.now(),
      committed_at: "",
      discarded_at: "",
      failed_at: "",
      saved_paths: [],
      commit_run_id: "",
      commit_request_id: "",
      commit_journal_ids: [],
      error: "",
      transient: options.transient ?? false,
      save_plan: options.save_plan ? generatedSavePlanSchema.parse(options.save_plan) : undefined
    };

    await this.writeMeta(cacheId, meta);
    return meta;
  }

  async get(cacheId: string): Promise<GeneratedCacheMeta> {
    const metaPath = this.getMetaPath(cacheId);
    const exists = await fs.stat(metaPath).then((s) => s.isFile()).catch(() => false);
    if (!exists) {
      throw new Error("生成缓存不存在或已被清理");
    }

    try {
      const raw = await fs.readFile(metaPath, "utf8");
      const data = JSON.parse(raw);
      return generatedCacheMetaSchema.parse(data);
    } catch (error) {
      throw new Error("生成缓存元数据损坏或无效");
    }
  }

  async append(cacheId: string, text: string): Promise<GeneratedCacheMeta> {
    if (!text) {
      return this.get(cacheId);
    }

    const meta = await this.ensurePending(cacheId);
    const contentPath = this.getContentPath(cacheId);

    await fs.mkdir(path.dirname(contentPath), { recursive: true });
    await fs.appendFile(contentPath, text, "utf8");

    meta.chars = (meta.chars || 0) + text.length;
    meta.updated_at = this.now();

    await this.writeMeta(cacheId, meta);
    return meta;
  }

  async replace(cacheId: string, text: string): Promise<GeneratedCacheMeta> {
    const meta = await this.ensurePending(cacheId);
    const contentPath = this.getContentPath(cacheId);

    await atomicWrite(contentPath, text || "");

    meta.chars = (text || "").length;
    meta.updated_at = this.now();

    await this.writeMeta(cacheId, meta);
    return meta;
  }

  async readContent(cacheId: string): Promise<string> {
    await this.get(cacheId);
    const contentPath = this.getContentPath(cacheId);
    const exists = await fs.stat(contentPath).then((s) => s.isFile()).catch(() => false);
    if (!exists) {
      throw new Error("生成缓存正文不存在或已被清理");
    }
    return fs.readFile(contentPath, "utf8");
  }

  async commitToTargets(cacheId: string, targetPaths?: string[], options: CommitOptions = {}): Promise<string[]> {
    const commits = await this.prepareTargetCommit(cacheId, targetPaths, options);
    await this.writePreparedCommits(commits);
    const savedPaths = commits.map((commit) => commit.target_path);
    await this.markCommitted(cacheId, savedPaths, { cleanupContent: options.cleanupContent });
    return savedPaths;
  }

  /**
   * Validates and composes target document content without touching target files.
   * Durable callers submit these records through their CommitJournalService.
   */
  async prepareTargetCommit(
    cacheId: string,
    targetPaths?: string[],
    options: CommitOptions = {}
  ): Promise<PreparedGeneratedCacheCommit[]> {
    const meta = await this.ensurePending(cacheId);
    const paths = this.normalizePaths(targetPaths || meta.target_paths || []).sort();
    if (!paths.length) {
      throw new Error("没有可写入的目标文件");
    }

    let content = await this.readContent(cacheId);
    const strip = options.stripContent ?? true;
    if (strip) {
      content = content.trim();
    }

    const requireContent = options.requireContent ?? true;
    if (requireContent && !content) {
      throw new Error("生成内容为空，已阻止写入文件");
    }

    const mode = options.mode || meta.mode || "replace";
    return Promise.all(paths.map(async (targetPath) => ({
      cache_id: cacheId,
      target_path: targetPath,
      content: await this.composeTargetText(targetPath, content, mode, strip),
      mode,
      action_key: `target:${targetPath}`
    })));
  }

  async updateSavePlan(cacheId: string, savePlan: GeneratedSavePlan): Promise<GeneratedCacheMeta> {
    const meta = await this.ensurePending(cacheId);
    const normalizedPlan = generatedSavePlanSchema.parse({
      ...savePlan,
      target_paths: this.normalizePaths(savePlan.target_paths || []),
      segments: (savePlan.segments || []).map((segment) => ({
        ...segment,
        target_path: this.normalizePaths([segment.target_path])[0] || ""
      })).filter((segment) => segment.target_path)
    });
    meta.save_plan = normalizedPlan;
    meta.target_paths = normalizedPlan.target_paths;
    meta.mode = normalizedPlan.mode;
    meta.updated_at = this.now();
    await this.writeMeta(cacheId, meta);
    return meta;
  }

  async commitSavePlan(cacheId: string, savePlan?: GeneratedSavePlan, options: CommitOptions = {}): Promise<string[]> {
    const commits = await this.prepareSavePlanCommit(cacheId, savePlan, options);
    await this.writePreparedCommits(commits);
    const savedPaths = commits.map((commit) => commit.target_path);
    await this.markCommitted(cacheId, savedPaths, { cleanupContent: options.cleanupContent });
    return savedPaths;
  }

  /** Returns normalized target replacements for a save plan without writing files. */
  async prepareSavePlanCommit(
    cacheId: string,
    savePlan?: GeneratedSavePlan,
    options: CommitOptions = {}
  ): Promise<PreparedGeneratedCacheCommit[]> {
    const meta = await this.ensurePending(cacheId);
    const plan = generatedSavePlanSchema.parse(savePlan || meta.save_plan || {});
    if (plan.action === "no_save") {
      throw new Error("保存计划没有要求写入文件");
    }

    const segments = (plan.segments || [])
      .map((segment) => ({
        ...segment,
        target_path: this.normalizePaths([segment.target_path])[0] || ""
      }))
      .filter((segment) => segment.target_path);

    if (!segments.length) {
      return this.prepareTargetCommit(cacheId, plan.target_paths, {
        ...options,
        mode: options.mode || plan.mode
      });
    }

    const fallbackContent = await this.readContent(cacheId);
    const strip = options.stripContent ?? true;
    const commits: PreparedGeneratedCacheCommit[] = [];
    const stagedContent = new Map<string, string>();
    const commitIndexByTarget = new Map<string, number>();

    for (const segment of segments) {
      let content = String(segment.content || "").trim();
      if (!content) {
        content = strip ? fallbackContent.trim() : fallbackContent;
      }
      if ((options.requireContent ?? true) && !content) {
        throw new Error("生成内容为空，已阻止写入文件");
      }
      const mode = segment.mode || plan.mode || "replace";
      const nextText = await this.composeTargetText(
        segment.target_path,
        content,
        mode,
        strip,
        stagedContent.get(segment.target_path)
      );
      stagedContent.set(segment.target_path, nextText);
      const existingIndex = commitIndexByTarget.get(segment.target_path);
      if (existingIndex !== undefined) {
        commits[existingIndex] = {
          ...commits[existingIndex]!,
          content: nextText,
          mode
        };
      } else {
        commitIndexByTarget.set(segment.target_path, commits.length);
        commits.push({
          cache_id: cacheId,
          target_path: segment.target_path,
          content: nextText,
          mode,
          action_key: `save_plan_target:${segment.target_path}`
        });
      }
    }
    return commits;
  }

  async markCommitted(
    cacheId: string,
    savedPaths: string[],
    options: {
      cleanupContent?: boolean;
      commitRunId?: string;
      commitRequestId?: string;
      commitJournalIds?: string[];
    } = {}
  ): Promise<GeneratedCacheMeta> {
    const meta = await this.get(cacheId);
    meta.status = "committed";
    meta.saved_paths = this.normalizePaths(savedPaths);
    meta.commit_run_id = String(options.commitRunId || meta.commit_run_id || "");
    meta.commit_request_id = String(options.commitRequestId || meta.commit_request_id || "");
    meta.commit_journal_ids = [...new Set(options.commitJournalIds || meta.commit_journal_ids || [])];
    meta.committed_at = this.now();
    meta.updated_at = this.now();
    meta.error = "";

    await this.writeMeta(cacheId, meta);
    const cleanup = options.cleanupContent ?? true;
    if (cleanup) {
      await this.deleteContent(cacheId).catch(() => undefined);
    }
    return meta;
  }

  async discard(cacheId: string): Promise<GeneratedCacheMeta> {
    const meta = await this.get(cacheId);
    meta.status = "discarded";
    meta.discarded_at = this.now();
    meta.updated_at = this.now();

    await this.deleteContent(cacheId);
    await this.writeMeta(cacheId, meta);
    return meta;
  }

  async markFailed(cacheId: string, error: string): Promise<GeneratedCacheMeta> {
    const meta = await this.get(cacheId);
    meta.status = "failed";
    meta.failed_at = this.now();
    meta.updated_at = this.now();
    meta.error = String(error);

    await this.writeMeta(cacheId, meta);
    return meta;
  }

  async cleanupExpired(options: {
    settledRetentionSeconds?: number;
    failedRetentionSeconds?: number;
    orphanedRetentionSeconds?: number;
  } = {}): Promise<CleanupResult> {
    const root = this.getCacheRoot();
    const exists = await fs.stat(root).then((s) => s.isDirectory()).catch(() => false);
    if (!exists) {
      return { ok: true, skipped: false, deleted: 0, kept: 0, errors: [] };
    }

    let now = new Date();
    try {
      now = parseTimestamp(this.now());
    } catch {
      // fallback to system time
    }
    let deleted = 0;
    let kept = 0;
    const errors: string[] = [];

    const settledRetention = options.settledRetentionSeconds ?? DEFAULT_SETTLED_CACHE_RETENTION_SECONDS;
    const failedRetention = options.failedRetentionSeconds ?? DEFAULT_FAILED_CACHE_RETENTION_SECONDS;
    const orphanedRetention = options.orphanedRetentionSeconds ?? DEFAULT_ORPHANED_CACHE_RETENTION_SECONDS;

    const entries = await fs.readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^[a-f0-9]{32}$/.test(entry.name)) {
        continue;
      }

      const cacheDir = path.join(root, entry.name);
      try {
        const metaPath = path.join(cacheDir, METADATA_NAME);
        const meta = await this.readMetaFile(metaPath);
        const expired = await this.isCacheDirExpired(cacheDir, meta, now, settledRetention, failedRetention, orphanedRetention);
        if (expired) {
          await fs.rm(cacheDir, { recursive: true, force: true });
          deleted++;
        } else {
          kept++;
        }
      } catch (err) {
        kept++;
        errors.push(`${entry.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return { ok: errors.length === 0, skipped: false, deleted, kept, errors };
  }

  async cleanupExpiredIfDue(options: { intervalSeconds?: number } = {}): Promise<CleanupResult> {
    const key = this.projectRoot;
    const now = Date.now();
    const last = GeneratedCacheService.lastCleanupByProject.get(key) || 0;
    const interval = (options.intervalSeconds ?? AUTO_CLEANUP_INTERVAL_SECONDS) * 1000;

    if (now - last < interval) {
      return { ok: true, skipped: true, deleted: 0, kept: 0, errors: [] };
    }

    GeneratedCacheService.lastCleanupByProject.set(key, now);
    try {
      return await this.cleanupExpired();
    } catch (err) {
      return {
        ok: false,
        skipped: false,
        deleted: 0,
        kept: 0,
        errors: [err instanceof Error ? err.message : String(err)]
      };
    }
  }

  private async composeTargetText(
    relPath: string,
    content: string,
    mode: string,
    strip: boolean,
    stagedExisting?: string
  ): Promise<string> {
    if (mode === "append") {
      let existing = stagedExisting;
      if (existing === undefined) {
        try {
          existing = await this.documentService.readRawText(relPath);
        } catch {
          existing = "";
        }
      }

      if (strip) {
        return existing.trimEnd()
          ? existing.trimEnd() + "\n\n---\n" + content + "\n"
          : content + "\n";
      }
      return existing + content;
    }

    if (mode !== "replace") {
      throw new Error("保存模式无效");
    }

    return content;
  }

  private async writePreparedCommits(commits: PreparedGeneratedCacheCommit[]): Promise<void> {
    for (const commit of commits) {
      const targetFullPath = await this.documentService.resolveSafePath(commit.target_path, { allowMissing: true });
      await atomicWrite(targetFullPath, commit.content);
    }
  }

  private normalizePaths(paths: string[]): string[] {
    const normalized: string[] = [];
    const seen = new Set<string>();

    for (const p of paths) {
      try {
        const relPath = this.documentService.normalizeRelativePath(p);
        if (!relPath || seen.has(relPath)) {
          continue;
        }
        seen.add(relPath);
        normalized.push(relPath);
      } catch {
        // Skip invalid paths
      }
    }
    return normalized;
  }

  private async ensurePending(cacheId: string): Promise<GeneratedCacheMeta> {
    const meta = await this.get(cacheId);
    if (meta.status !== "pending") {
      throw new Error("生成缓存已处理，不能重复写入");
    }
    return meta;
  }

  private getCacheRoot(): string {
    return path.join(this.projectRoot, CACHE_ROOT_REL);
  }

  private getCacheDir(cacheId: string): string {
    if (!/^[a-f0-9]{32}$/.test(cacheId)) {
      throw new Error("生成缓存 ID 无效");
    }
    return path.join(this.getCacheRoot(), cacheId);
  }

  private getContentPath(cacheId: string): string {
    return path.join(this.getCacheDir(cacheId), CONTENT_NAME);
  }

  private getMetaPath(cacheId: string): string {
    return path.join(this.getCacheDir(cacheId), METADATA_NAME);
  }

  private async writeMeta(cacheId: string, meta: GeneratedCacheMeta): Promise<void> {
    const metaPath = this.getMetaPath(cacheId);
    await atomicWrite(metaPath, JSON.stringify(meta, null, 2));
  }

  private async readMetaFile(metaPath: string): Promise<Partial<GeneratedCacheMeta>> {
    try {
      const raw = await fs.readFile(metaPath, "utf8");
      const data = JSON.parse(raw);
      return typeof data === "object" && data !== null ? data : {};
    } catch {
      return {};
    }
  }

  private async deleteContent(cacheId: string): Promise<void> {
    const contentPath = this.getContentPath(cacheId);
    await fs.rm(contentPath, { force: true });
  }

  private async isCacheDirExpired(
    cacheDir: string,
    meta: Partial<GeneratedCacheMeta>,
    now: Date,
    settledRetention: number,
    failedRetention: number,
    orphanedRetention: number
  ): Promise<boolean> {
    const status = String(meta.status || "").trim();
    if (status === "pending") {
      return false;
    }

    if (status === "committed" || status === "discarded") {
      const age = await this.getCacheAgeSeconds(cacheDir, meta, now, ["committed_at", "discarded_at", "updated_at", "created_at"]);
      return age >= settledRetention;
    }

    if (status === "failed") {
      const age = await this.getCacheAgeSeconds(cacheDir, meta, now, ["failed_at", "updated_at", "created_at"]);
      return age >= failedRetention;
    }

    const age = await this.getCacheAgeSeconds(cacheDir, meta, now, ["updated_at", "created_at"]);
    return age >= orphanedRetention;
  }

  private async getCacheAgeSeconds(
    cacheDir: string,
    meta: Partial<GeneratedCacheMeta>,
    now: Date,
    fields: (keyof GeneratedCacheMeta)[]
  ): Promise<number> {
    for (const field of fields) {
      const timestamp = String(meta[field] || "").trim();
      if (!timestamp) {
        continue;
      }
      try {
        const date = parseTimestamp(timestamp);
        return Math.max(0, (now.getTime() - date.getTime()) / 1000);
      } catch {
        // Skip invalid date format
      }
    }

    try {
      const stats = await fs.stat(cacheDir);
      return Math.max(0, (now.getTime() - stats.mtime.getTime()) / 1000);
    } catch {
      return 0;
    }
  }
}

async function atomicWrite(targetPath: string, text: string): Promise<void> {
  const dir = path.dirname(targetPath);
  await fs.mkdir(dir, { recursive: true });
  const tmpName = `.${path.basename(targetPath)}.${randomUUID().replace(/-/g, "")}.tmp`;
  const tmpPath = path.join(dir, tmpName);
  await fs.writeFile(tmpPath, text || "", "utf8");
  await fs.rename(tmpPath, targetPath);
}

function formatTimestamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function parseTimestamp(timestamp: string): Date {
  const match = timestamp.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
  if (!match) {
    throw new Error("Invalid timestamp format");
  }
  const [, year, month, day, hour, minute, second] = match;
  return new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second)
  );
}
