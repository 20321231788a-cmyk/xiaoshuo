import { randomUUID } from "node:crypto";
import { AGENT_DIR, OUTLINE_DIR, SETTINGS_DIR } from "@xiaoshuo/project-session";
import {
  documentContentSchema,
  executePlanResponseSchema,
  ledgerItemSchema,
  operationResultSchema,
  revisionLogEntrySchema,
  timelineDeleteResultSchema,
  timelineEntrySchema,
  timelineRollbackResultSchema,
  type DocumentContent,
  type ExecutePlanResponse,
  type FileOperation,
  type LedgerItem,
  type OperationResult,
  type RevisionLogEntry,
  type TimelineDeleteResult,
  type TimelineEntry,
  type TimelineFileChange,
  type TimelineRollbackResult
} from "@xiaoshuo/shared";
import fs from "node:fs/promises";
import path from "node:path";
import { CanonicalProjectPathGuard } from "./canonical-project-path-guard.js";

const ALLOWED_EXTENSIONS = new Set([".txt", ".md", ".jsonl"]);
const BLOCKED_SUFFIXES = new Set([".py", ".exe", ".json", ".db", ".sqlite", ".dat", ".dll", ".pyd"]);
const BLOCKED_SEGMENTS = new Set([".git", "__pycache__"]);
const TRASH_DIR = "99_回收站";
const TIMELINE_PATH = `${SETTINGS_DIR}/.agent/timeline.jsonl`;
const LEDGER_PATH = `${AGENT_DIR}/ledger.json`;
const REVISION_LOG_PATH = `${SETTINGS_DIR}/修正日志/正文二次修正日志.txt`;
const OPERATION_LOG_PATH = `${SETTINGS_DIR}/文件管家操作日志.jsonl`;

export type DocumentTimelineSession = {
  id: string;
  startedAt: string;
};

export type DocumentServiceOptions = {
  projectRoot: string;
  now?: () => string;
  idFactory?: () => string;
  pathGuard?: CanonicalProjectPathGuard;
};

export type SaveDocumentOptions = {
  source?: string;
  summary?: string;
  session?: DocumentTimelineSession;
  baseUpdatedAt?: string;
  baseUpdatedAtMs?: number;
  force?: boolean;
  /**
   * Reserved for durable callers that record a filesystem commit journal.
   * The paths must be siblings of the document so rename stays on one volume.
   */
  atomicWrite?: DocumentAtomicWriteOptions;
};

export type DocumentAtomicWriteStage = "temp_written" | "before_replace" | "file_replaced";

export type DocumentAtomicWriteOptions = {
  tempPath: string;
  backupPath: string;
  onStage?: (stage: DocumentAtomicWriteStage) => void | Promise<void>;
};

export class DocumentSaveConflictError extends Error {
  readonly code = "DOCUMENT_SAVE_CONFLICT";
  readonly currentUpdatedAt: string;
  readonly currentUpdatedAtMs: number;

  constructor(currentUpdatedAt: string, currentUpdatedAtMs: number) {
    super("磁盘已有新版内容，普通保存已暂停。请先读取最新版，或确认覆盖磁盘内容。");
    this.currentUpdatedAt = currentUpdatedAt;
    this.currentUpdatedAtMs = currentUpdatedAtMs;
  }
}

export class DocumentService {
  readonly projectRoot: string;
  private readonly now: () => string;
  private readonly idFactory: () => string;
  private readonly pathGuard: CanonicalProjectPathGuard;

  constructor(options: DocumentServiceOptions) {
    this.projectRoot = path.resolve(options.projectRoot);
    this.now = options.now || (() => formatTimestamp(new Date()));
    this.idFactory = options.idFactory || (() => randomUUID().replace(/-/g, ""));
    this.pathGuard = options.pathGuard || new CanonicalProjectPathGuard(this.projectRoot);
  }

  normalizeRelativePath(relativePath: string): string {
    const requestedPath = String(relativePath || "").trim();
    if (path.isAbsolute(requestedPath) || /^[/\\]/.test(requestedPath) || /^[a-zA-Z]:[/\\]/.test(requestedPath)) {
      throw new Error("非法项目路径");
    }
    let normalized = requestedPath
      .replace(/\\/g, "/")
      .trim();
    normalized = path.posix.normalize(normalized);
    if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../")) {
      throw new Error("非法项目路径");
    }
    if (normalized.split("/").some((segment) => BLOCKED_SEGMENTS.has(segment))) {
      throw new Error("禁止操作系统目录");
    }
    if (normalized === `${SETTINGS_DIR}/大纲.txt`) {
      return `${OUTLINE_DIR}/大纲.txt`;
    }
    return normalized;
  }

  async resolveSafePath(relativePath: string, options: { allowMissing?: boolean } = {}): Promise<string> {
    const normalized = this.normalizeRelativePath(relativePath);
    const target = path.resolve(this.projectRoot, normalized);
    if (target !== this.projectRoot && !target.startsWith(`${this.projectRoot}${path.sep}`)) {
      throw new Error("路径越过项目目录");
    }

    const extension = path.extname(target).toLowerCase();
    if (BLOCKED_SUFFIXES.has(extension)) {
      throw new Error(`禁止操作该类型文件: ${extension}`);
    }
    if (!ALLOWED_EXTENSIONS.has(extension)) {
      throw new Error("Agent 文件管家只允许操作 .txt / .md 文档和 .jsonl 记录");
    }

    await this.pathGuard.assertPath(target, { allowMissing: true });
    if (!options.allowMissing) {
      const stats = await fs.stat(target).catch(() => null);
      if (!stats?.isFile()) {
        throw new Error(`文件不存在: ${normalized}`);
      }
    }
    return target;
  }

  async revalidateWritePath(relativePath: string): Promise<string> {
    const normalized = this.normalizeRelativePath(relativePath);
    const target = path.resolve(this.projectRoot, normalized);
    return this.pathGuard.assertPath(target, { allowMissing: true });
  }

  async revalidateAbsoluteProjectPath(targetPath: string, allowMissing = true): Promise<string> {
    return this.pathGuard.assertPath(targetPath, { allowMissing });
  }

  async canonicalProjectRoot(): Promise<string> {
    return this.pathGuard.canonicalRoot();
  }

  async readDocument(relativePath: string): Promise<DocumentContent> {
    const normalized = this.normalizeRelativePath(relativePath);
    const target = await this.resolveSafePath(normalized);
    const stats = await fs.stat(target);
    const content = await fs.readFile(target, "utf8");
    return documentContentSchema.parse({
      path: normalized,
      content,
      updated_at: formatTimestamp(stats.mtime),
      updated_at_ms: stats.mtimeMs
    });
  }

  async readRawText(relativePath: string, limit?: number): Promise<string> {
    const target = await this.resolveSafePath(relativePath);
    const content = await fs.readFile(target, "utf8");
    if (typeof limit === "number" && limit >= 0 && content.length > limit) {
      return content.slice(0, limit);
    }
    return content;
  }

  async saveDocument(relativePath: string, content: string, options: SaveDocumentOptions = {}): Promise<DocumentContent> {
    const normalized = this.normalizeRelativePath(relativePath);
    const target = await this.resolveSafePath(normalized, { allowMissing: true });
    const nextContent = content || "";
    const currentStats = await fs.stat(target).catch(() => null);
    if (currentStats?.isFile()) {
      const currentContent = await fs.readFile(target, "utf8").catch(() => null);
      if (currentContent === nextContent) {
        return documentContentSchema.parse({
          path: normalized,
          content: currentContent,
          updated_at: formatTimestamp(currentStats.mtime),
          updated_at_ms: currentStats.mtimeMs,
          changed: false
        });
      }
    }
    await this.assertSaveBaseIsCurrent(target, options);
    const beforeChange = await this.snapshotChange(normalized, "save_document");

    await fs.mkdir(path.dirname(target), { recursive: true });
    await this.revalidateAbsoluteProjectPath(target);
    if (options.atomicWrite) {
      await this.writeTextAtomically(target, nextContent, options.atomicWrite);
    } else {
      await fs.writeFile(target, nextContent, "utf8");
    }

    const afterChange = await this.completeChange(beforeChange);
    await this.appendTimelineEvent({
      source: options.source || "editor",
      summary: options.summary || `保存 ${normalized}`,
      files: [afterChange],
      operations: [],
      session: options.session
    });

    const stats = await fs.stat(target);
    return documentContentSchema.parse({
      path: normalized,
      content: nextContent,
      updated_at: formatTimestamp(stats.mtime),
      updated_at_ms: stats.mtimeMs,
      changed: true
    });
  }

  async appendDocument(relativePath: string, content: string, options: SaveDocumentOptions = {}): Promise<DocumentContent> {
    let existing = "";
    try {
      existing = await this.readRawText(relativePath);
    } catch {
      existing = "";
    }
    const normalized = this.normalizeRelativePath(relativePath);
    return this.saveDocument(normalized, existing + (content || ""), {
      ...options,
      summary: options.summary || `追加 ${normalized}`
    });
  }

  async archiveDocument(relativePath: string, options: SaveDocumentOptions = {}): Promise<{ path: string; archived_path: string }> {
    const normalized = this.normalizeRelativePath(relativePath);
    const beforeChange = await this.snapshotChange(normalized, "archive_file");
    const archived = await this.archiveFile(normalized);
    const completed = await this.completeChange(beforeChange);
    await this.appendTimelineEvent({
      source: options.source || "agent",
      summary: options.summary || `归档 ${normalized}`,
      files: [completed],
      operations: [],
      session: options.session
    });
    return {
      path: normalized,
      archived_path: archived
    };
  }

  async archiveDocuments(relativePaths: string[], options: SaveDocumentOptions = {}): Promise<string[]> {
    const normalized = uniqueNormalizedPaths(this, relativePaths);
    if (!normalized.length) {
      return [];
    }

    const beforeChanges = await Promise.all(normalized.map((relativePath) => this.snapshotChange(relativePath, "archive_file")));
    const archived = await Promise.all(normalized.map((relativePath) => this.archiveFile(relativePath)));
    const completed = await Promise.all(beforeChanges.map((change) => this.completeChange(change)));
    await this.appendTimelineEvent({
      source: options.source || "agent",
      summary: options.summary || `归档 ${archived.length} 个文件`,
      files: completed,
      operations: [],
      session: options.session
    });
    return archived;
  }

  async executeOperations(
    operations: FileOperation[],
    options: SaveDocumentOptions & { confirmDelete?: boolean } = {}
  ): Promise<ExecutePlanResponse> {
    if (this.operationsRequireDeleteConfirmation(operations) && !options.confirmDelete) {
      throw new Error("删除/归档文件需要用户确认");
    }

    const beforeChanges = await this.snapshotOperations(operations);
    const results: OperationResult[] = [];
    const changedPaths = new Set<string>();

    for (const operation of operations) {
      try {
        await this.executeOperation(operation);
        results.push(
          operationResultSchema.parse({
            action: operation.action,
            path: operation.path,
            ok: true,
            message: "完成"
          })
        );
        changedPaths.add(this.normalizeRelativePath(operation.path));
        if (operation.action === "move_file" && operation.target_path) {
          changedPaths.add(this.normalizeRelativePath(operation.target_path));
        }
      } catch (error) {
        results.push(
          operationResultSchema.parse({
            action: operation.action,
            path: operation.path,
            ok: false,
            message: error instanceof Error ? error.message : String(error)
          })
        );
      }
    }

    await this.appendOperationLog(operations, results);

    const changed = await Promise.all(
      beforeChanges
        .filter((change) => changedPaths.has(change.path))
        .map((change) => this.completeChange(change))
    );
    if (changed.length) {
      await this.appendTimelineEvent({
        source: options.source || "agent",
        summary: options.summary || operationSummary(operations),
        files: changed,
        operations,
        session: options.session
      });
    }

    return executePlanResponseSchema.parse(results);
  }

  operationsRequireDeleteConfirmation(operations: FileOperation[]): boolean {
    return operations.some((operation) => operation.action === "archive_file");
  }

  async listTimeline(limit = 80): Promise<TimelineEntry[]> {
    const entries = await this.readTimelineEntries();
    const clampedLimit = Math.max(1, Math.min(Math.trunc(limit || 80), 300));
    return entries.slice(-clampedLimit).reverse();
  }

  async getTimelineEntry(entryId: string): Promise<TimelineEntry> {
    const entry = (await this.readTimelineEntries()).find((item) => item.id === entryId);
    if (!entry) {
      throw new Error("未找到时间线记录");
    }
    return entry;
  }

  async deleteTimelineEntry(entryId: string): Promise<TimelineDeleteResult> {
    const timelinePath = await this.resolveInternalPath(TIMELINE_PATH);
    const raw = await fs.readFile(timelinePath, "utf8").catch(() => "");
    if (!raw.trim()) {
      throw new Error("未找到时间线记录");
    }

    const kept: string[] = [];
    let deleted = false;
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>;
        if (String(parsed.id || "") === entryId) {
          deleted = true;
          continue;
        }
        kept.push(JSON.stringify(parsed));
      } catch {
        kept.push(trimmed);
      }
    }

    if (!deleted) {
      throw new Error("未找到时间线记录");
    }

    await this.revalidateAbsoluteProjectPath(timelinePath);
    await fs.writeFile(timelinePath, kept.length ? `${kept.join("\n")}\n` : "", "utf8");
    return timelineDeleteResultSchema.parse({ ok: true, deleted_id: entryId });
  }

  async rollbackTimelineEntry(entryId: string, options: { confirmDelete?: boolean; session?: DocumentTimelineSession } = {}): Promise<TimelineRollbackResult> {
    const entry = await this.getTimelineEntry(entryId);
    if ((await this.rollbackWouldDeleteFiles(entry)) && !options.confirmDelete) {
      return timelineRollbackResultSchema.parse({
        ok: false,
        message: "该回滚会删除本次操作中新建的文件，请确认后再执行。",
        entry,
        requires_confirmation: true
      });
    }

    const reverseChanges: TimelineFileChange[] = [];
    for (const change of entry.files) {
      reverseChanges.push(await this.snapshotChange(change.path, "rollback"));
      const target = await this.resolveSafePath(change.path, { allowMissing: true });
      if (change.before_exists) {
        await fs.mkdir(path.dirname(target), { recursive: true });
        await this.revalidateAbsoluteProjectPath(target);
        await fs.writeFile(target, change.before_content || "", "utf8");
      } else {
        const stats = await fs.stat(target).catch(() => null);
        if (stats?.isFile()) {
          await this.revalidateAbsoluteProjectPath(target, false);
          await fs.unlink(target);
        }
      }
    }

    const completed = await Promise.all(reverseChanges.map((change) => this.completeChange(change)));
    const rollbackEntry = await this.appendTimelineEvent({
      source: "rollback",
      summary: `回滚：${entry.summary || entry.id}`,
      files: completed,
      operations: [],
      session: options.session
    });
    return timelineRollbackResultSchema.parse({
      ok: true,
      message: "已回滚",
      entry: rollbackEntry,
      requires_confirmation: false
    });
  }

  async getLedger(): Promise<LedgerItem[]> {
    const raw = await fs.readFile(await this.resolveInternalPath(LEDGER_PATH), "utf8").catch(() => "");
    if (!raw.trim()) {
      return [];
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) {
        return [];
      }
      return parsed.flatMap((item) => {
        const result = ledgerItemSchema.safeParse(item);
        return result.success ? [result.data] : [];
      });
    } catch {
      return [];
    }
  }

  async addLedgerItem(desc: string): Promise<LedgerItem> {
    const text = String(desc || "").trim();
    if (!text) {
      throw new Error("缺少伏笔内容");
    }
    const items = await this.getLedger();
    const item = ledgerItemSchema.parse({
      id: this.idFactory(),
      desc: text,
      status: "open",
      created_at: this.now(),
      updated_at: this.now()
    });
    items.push(item);
    await this.saveLedger(items);
    return item;
  }

  async toggleLedgerItem(itemId: string): Promise<LedgerItem> {
    const items = await this.getLedger();
    const index = items.findIndex((item) => item.id === itemId);
    if (index < 0) {
      throw new Error("未找到伏笔项");
    }
    const current = items[index]!;
    const updated = ledgerItemSchema.parse({
      ...current,
      status: current.status === "open" ? "closed" : "open",
      updated_at: this.now()
    });
    items[index] = updated;
    await this.saveLedger(items);
    return updated;
  }

  async listRevisionLogs(): Promise<RevisionLogEntry[]> {
    const text = await readText(await this.resolveInternalPath(REVISION_LOG_PATH));
    if (!text.trim()) {
      return [];
    }
    const chunks = text
      .split(/\n[ \t]*\n(?===== )/)
      .map((chunk) => chunk.trim())
      .filter(Boolean);

    const entries = chunks.flatMap((chunk) => {
      const lines = chunk.split(/\r?\n/);
      const header = lines[0] || "";
      const timestampMatch = /\|\s*(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/.exec(header);
      const pathMatch = /文件:\s*(.+)/.exec(chunk);
      const scoreMatch = /评分[:：]\s*(\d+)/.exec(chunk);
      const risks = [...chunk.matchAll(/^- (.+)$/gm)].map((match) => match[1] || "").filter(Boolean);
      const parsed = revisionLogEntrySchema.safeParse({
        timestamp: timestampMatch?.[1] || "",
        path: pathMatch?.[1]?.trim() || "",
        score: scoreMatch ? Number.parseInt(scoreMatch[1] || "", 10) : null,
        risks: risks.slice(0, 12),
        excerpt: lines.slice(0, 8).join("\n").slice(0, 500),
        raw: chunk
      });
      return parsed.success ? [parsed.data] : [];
    });

    return entries.reverse();
  }

  async clearRevisionLogs(confirmDelete = false): Promise<void> {
    if (!confirmDelete) {
      throw new Error("清空修正日志需要用户确认");
    }
    const target = await this.resolveInternalPath(REVISION_LOG_PATH);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await this.revalidateAbsoluteProjectPath(target);
    await fs.writeFile(target, "", "utf8");
  }

  private async archiveFile(relativePath: string): Promise<string> {
    const normalized = this.normalizeRelativePath(relativePath);
    const target = await this.resolveSafePath(normalized);
    const archivePath = this.archiveRelativePath(normalized);
    const archiveTarget = await this.resolveSafePath(archivePath, { allowMissing: true });
    await fs.mkdir(path.dirname(archiveTarget), { recursive: true });
    await this.revalidateAbsoluteProjectPath(target, false);
    await this.revalidateAbsoluteProjectPath(archiveTarget);
    await fs.rename(target, archiveTarget);
    return archivePath;
  }

  private archiveRelativePath(relativePath: string): string {
    const stamp = this.now().replace(/[-: ]/g, "").replace(/^(\d{8})(\d{6})$/, "$1_$2");
    return path.posix.join(TRASH_DIR, stamp, relativePath);
  }

  private async executeOperation(operation: FileOperation): Promise<void> {
    const normalized = this.normalizeRelativePath(operation.path);
    if (operation.action === "create_file") {
      const target = await this.resolveSafePath(normalized, { allowMissing: true });
      const stats = await fs.stat(target).catch(() => null);
      if (stats?.isFile()) {
        throw new Error("文件已存在，拒绝覆盖");
      }
      await this.writeText(normalized, operation.text || "");
      return;
    }
    if (operation.action === "append_text") {
      const content = await this.readRawText(normalized);
      await this.writeText(normalized, content + (operation.text || ""));
      return;
    }
    if (operation.action === "replace_text") {
      const content = await this.readRawText(normalized);
      if (!operation.old_text) {
        throw new Error("replace_text 缺少 old_text");
      }
      if (!content.includes(operation.old_text)) {
        throw new Error("未找到要替换的原文");
      }
      await this.writeText(normalized, content.replace(operation.old_text, operation.new_text || ""));
      return;
    }
    if (operation.action === "move_file") {
      const sourcePath = await this.resolveSafePath(normalized);
      const targetRelativePath = this.normalizeRelativePath(operation.target_path);
      const targetPath = await this.resolveSafePath(targetRelativePath, { allowMissing: true });
      const targetStats = await fs.stat(targetPath).catch(() => null);
      if (targetStats?.isFile()) {
        throw new Error("目标文件已存在");
      }
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await this.revalidateAbsoluteProjectPath(sourcePath, false);
      await this.revalidateAbsoluteProjectPath(targetPath);
      await fs.rename(sourcePath, targetPath);
      return;
    }
    if (operation.action === "archive_file") {
      await this.archiveFile(normalized);
      return;
    }
    throw new Error(`未知操作: ${operation.action}`);
  }

  private async writeText(relativePath: string, content: string): Promise<void> {
    const target = await this.resolveSafePath(relativePath, { allowMissing: true });
    await fs.mkdir(path.dirname(target), { recursive: true });
    await this.revalidateAbsoluteProjectPath(target);
    await fs.writeFile(target, content, "utf8");
  }

  private async writeTextAtomically(
    target: string,
    content: string,
    options: DocumentAtomicWriteOptions
  ): Promise<void> {
    const targetDirectory = path.dirname(target);
    const tempPath = path.resolve(options.tempPath);
    const backupPath = path.resolve(options.backupPath);
    if (
      path.dirname(tempPath) !== targetDirectory ||
      path.dirname(backupPath) !== targetDirectory ||
      tempPath === target ||
      backupPath === target ||
      tempPath === backupPath
    ) {
      throw new Error("原子保存临时文件必须与目标文件位于同一目录");
    }

    await this.revalidateAbsoluteProjectPath(target);
    await this.revalidateAbsoluteProjectPath(tempPath);
    await this.revalidateAbsoluteProjectPath(backupPath);

    const current = await fs.stat(target).catch(() => null);
    if (current?.isFile()) {
      await fs.copyFile(target, backupPath);
    }
    await fs.writeFile(tempPath, content, "utf8");
    await options.onStage?.("temp_written");
    await options.onStage?.("before_replace");
    await this.revalidateAbsoluteProjectPath(target);
    await this.revalidateAbsoluteProjectPath(tempPath, false);
    await this.revalidateAbsoluteProjectPath(backupPath);
    await fs.rename(tempPath, target);
    await options.onStage?.("file_replaced");
  }

  private async assertSaveBaseIsCurrent(target: string, options: SaveDocumentOptions): Promise<void> {
    if (options.force) {
      return;
    }

    const hasBaseUpdatedAt = typeof options.baseUpdatedAt === "string" && options.baseUpdatedAt.trim().length > 0;
    const hasBaseUpdatedAtMs = typeof options.baseUpdatedAtMs === "number" && Number.isFinite(options.baseUpdatedAtMs);
    if (!hasBaseUpdatedAt && !hasBaseUpdatedAtMs) {
      return;
    }

    const stats = await fs.stat(target).catch(() => null);
    if (!stats?.isFile()) {
      return;
    }

    const currentUpdatedAt = formatTimestamp(stats.mtime);
    const currentUpdatedAtMs = stats.mtimeMs;
    if (hasBaseUpdatedAtMs) {
      if (Math.abs(currentUpdatedAtMs - Number(options.baseUpdatedAtMs)) > 1) {
        throw new DocumentSaveConflictError(currentUpdatedAt, currentUpdatedAtMs);
      }
      return;
    }

    if (currentUpdatedAt !== options.baseUpdatedAt) {
      throw new DocumentSaveConflictError(currentUpdatedAt, currentUpdatedAtMs);
    }
  }

  private async snapshotChange(relativePath: string, action: string): Promise<TimelineFileChange> {
    const normalized = this.normalizeRelativePath(relativePath);
    const target = await this.resolveSafePath(normalized, { allowMissing: true });
    const stats = await fs.stat(target).catch(() => null);
    return {
      path: normalized,
      action,
      before_exists: Boolean(stats?.isFile()),
      before_content: stats?.isFile() ? await fs.readFile(target, "utf8").catch(() => "") : "",
      after_exists: false,
      after_excerpt: ""
    };
  }

  private async completeChange(change: TimelineFileChange): Promise<TimelineFileChange> {
    const target = await this.resolveSafePath(change.path, { allowMissing: true });
    const stats = await fs.stat(target).catch(() => null);
    return {
      ...change,
      after_exists: Boolean(stats?.isFile()),
      after_excerpt: stats?.isFile() ? await readText(target, 1600) : ""
    };
  }

  private async appendTimelineEvent(input: {
    source: string;
    summary: string;
    files: TimelineFileChange[];
    operations: FileOperation[];
    session?: DocumentTimelineSession;
  }): Promise<TimelineEntry> {
    const timelinePath = await this.resolveInternalPath(TIMELINE_PATH);
    await fs.mkdir(path.dirname(timelinePath), { recursive: true });
    await this.revalidateAbsoluteProjectPath(timelinePath);
    const session = input.session || {
      id: this.idFactory(),
      startedAt: this.now()
    };
    const entry = timelineEntrySchema.parse({
      id: this.idFactory(),
      time: this.now(),
      source: input.source,
      summary: input.summary,
      session_id: session.id,
      session_label: session.startedAt ? `打开于 ${session.startedAt}` : "",
      session_started_at: session.startedAt,
      files: input.files,
      operations: input.operations
    });
    await fs.appendFile(timelinePath, `${JSON.stringify(entry, null, 0)}\n`, "utf8");
    return entry;
  }

  private async appendOperationLog(operations: FileOperation[], results: OperationResult[]): Promise<void> {
    const target = await this.resolveInternalPath(OPERATION_LOG_PATH);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await this.revalidateAbsoluteProjectPath(target);
    const record = {
      time: this.now(),
      operations,
      results
    };
    await fs.appendFile(target, `${JSON.stringify(record)}\n`, "utf8");
  }

  private async snapshotOperations(operations: FileOperation[]): Promise<TimelineFileChange[]> {
    const changes: TimelineFileChange[] = [];
    const seen = new Set<string>();

    const add = async (relativePath: string, action: string): Promise<void> => {
      if (!relativePath) {
        return;
      }
      const normalized = this.normalizeRelativePath(relativePath);
      const key = `${action}:${normalized}`;
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      changes.push(await this.snapshotChange(normalized, action));
    };

    for (const operation of operations) {
      await add(operation.path, operation.action);
      if (operation.action === "move_file" && operation.target_path) {
        await add(operation.target_path, operation.action);
      }
    }
    return changes;
  }

  private async readTimelineEntries(): Promise<TimelineEntry[]> {
    const raw = await fs.readFile(await this.resolveInternalPath(TIMELINE_PATH), "utf8").catch(() => "");
    if (!raw.trim()) {
      return [];
    }
    return raw
      .split(/\r?\n/)
      .flatMap((line) => {
        const trimmed = line.trim();
        if (!trimmed) {
          return [];
        }
        try {
          const parsed = timelineEntrySchema.safeParse(JSON.parse(trimmed) as unknown);
          return parsed.success ? [parsed.data] : [];
        } catch {
          return [];
        }
      });
  }

  private async rollbackWouldDeleteFiles(entry: TimelineEntry): Promise<boolean> {
    for (const change of entry.files) {
      if (change.before_exists) {
        continue;
      }
      const target = await this.resolveSafePath(change.path, { allowMissing: true }).catch(() => "");
      if (!target) {
        continue;
      }
      const stats = await fs.stat(target).catch(() => null);
      if (stats?.isFile()) {
        return true;
      }
    }
    return false;
  }

  private async saveLedger(items: LedgerItem[]): Promise<void> {
    const target = await this.resolveInternalPath(LEDGER_PATH);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await this.revalidateAbsoluteProjectPath(target);
    await fs.writeFile(target, `${JSON.stringify(items, null, 2)}\n`, "utf8");
  }

  private async resolveInternalPath(relativePath: string): Promise<string> {
    const target = path.resolve(this.projectRoot, relativePath);
    return this.pathGuard.assertPath(target, { allowMissing: true });
  }
}

function formatTimestamp(value: Date): string {
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())} ${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`;
}

async function readText(targetPath: string, limit?: number): Promise<string> {
  const content = await fs.readFile(targetPath, "utf8").catch(() => "");
  if (typeof limit === "number" && limit >= 0 && content.length > limit) {
    return content.slice(0, limit);
  }
  return content;
}

function uniqueNormalizedPaths(service: DocumentService, relativePaths: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const relativePath of relativePaths) {
    if (!String(relativePath || "").trim()) {
      continue;
    }
    const next = service.normalizeRelativePath(relativePath);
    if (seen.has(next)) {
      continue;
    }
    seen.add(next);
    normalized.push(next);
  }
  return normalized;
}

function operationSummary(operations: FileOperation[]): string {
  if (!operations.length) {
    return "文件操作";
  }
  const labels: Record<string, string> = {
    create_file: "创建",
    append_text: "追加",
    replace_text: "替换",
    move_file: "移动",
    archive_file: "删除"
  };
  const first = operations[0]!;
  return `${labels[first.action] || first.action} ${first.path}${operations.length > 1 ? ` 等 ${operations.length} 项` : ""}`;
}
