import type { AgentRunRequest } from "@xiaoshuo/shared";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { WorkflowRunContext } from "./types.js";

export const DISASSEMBLE_LIBRARY_DIR = "00_设定集/拆书库";
export const LEGACY_DISASSEMBLE_LORE_PATH = "00_设定集/设定集/拆书设定提取.txt";
export const LEGACY_REVERSE_OUTLINE_PATH = "01_大纲/反向细纲.txt";
export const LEGACY_DISASSEMBLE_DETAIL_PATH = "01_大纲/拆书细纲.txt";
export const BOOK_MANIFEST_PATH = "manifest.jsonl";
export const DISASSEMBLE_SOURCE_IMPORT_CHARS = 50_000_000;

export type DisassembleBookStatus = "imported" | "analyzing" | "ready" | "failed" | "stale";

export type DisassembleBookManifest = {
  schema_version: number;
  template_version: string;
  id: string;
  title: string;
  dir: string;
  created_at: string;
  updated_at: string;
  origin: string;
  source_path: string;
  source_summary: string;
  source_hash: string;
  chars: number;
  status: DisassembleBookStatus;
  analysis_version: number;
  error: string;
  analyzed_at: string;
  source: { path: string; hash: string; chars: number; chapter_count: number; import_complete: boolean };
  progress: { stage: string; completed_chapters: number; total_chapters: number; last_error: string };
  coverage: { first_chapter: number; last_chapter: number; analyzed_chapters: number[]; missing_chapters: number[] };
  paths: {
    source?: string;
    lore?: string;
    reverse_outline?: string;
    detail_outline?: string;
    report?: string;
    chapter_index?: string;
    evidence_index?: string;
  };
};

export type DisassembleBookWithLegacy = DisassembleBookManifest & { legacy?: boolean };

export async function createDisassembleBook(
  input: { title: string; sourceText: string; sourcePath: string; origin: string; workflowId?: string },
  context: WorkflowRunContext
): Promise<DisassembleBookManifest> {
  const createdAt = new Date().toISOString();
  const bookId = `${sanitizeBookId(input.title)}-${formatBookTimestamp(new Date())}-${randomUUID().replace(/-/g, "").slice(0, 8)}`;
  const dir = `${DISASSEMBLE_LIBRARY_DIR}/${bookId}`;
  const manifest: DisassembleBookManifest = {
    schema_version: 1,
    template_version: "1",
    id: bookId,
    title: input.title || "当前拆书书籍",
    dir,
    created_at: createdAt,
    updated_at: createdAt,
    origin: input.origin,
    source_path: input.sourcePath || "",
    source_summary: summarizeSource(input.sourceText),
    source_hash: createHash("sha256").update(input.sourceText, "utf8").digest("hex"),
    chars: input.sourceText.length,
    status: "imported",
    analysis_version: 1,
    error: "",
    analyzed_at: "",
    source: { path: input.sourcePath || `${dir}/原文.txt`, hash: createHash("sha256").update(input.sourceText, "utf8").digest("hex"), chars: input.sourceText.length, chapter_count: countChapters(input.sourceText), import_complete: true },
    progress: { stage: "imported", completed_chapters: 0, total_chapters: countChapters(input.sourceText), last_error: "" },
    coverage: { first_chapter: 0, last_chapter: 0, analyzed_chapters: [], missing_chapters: [] },
    paths: {
      source: input.sourceText.trim() ? `${dir}/原文.txt` : "",
      chapter_index: input.sourceText.trim() ? `${dir}/章节索引.jsonl` : ""
    }
  };
  if (input.sourceText.trim()) {
    await writeDisassembleBookDocument(`${dir}/原文.txt`, input.sourceText, `拆书原文：${manifest.title}`, context, {
      workflowId: input.workflowId || "disassemble_book",
      writeKey: "book.source"
    });
    await writeDisassembleBookDocument(`${dir}/章节索引.jsonl`, buildChapterIndex(input.sourceText), `拆书章节索引：${manifest.title}`, context, {
      workflowId: input.workflowId || "disassemble_book",
      writeKey: "book.chapter_index"
    });
  }
  await writeDisassembleBookManifest(manifest, context, {
    workflowId: input.workflowId || "disassemble_book",
    writeKey: "book.manifest.initial"
  });
  return manifest;
}

export async function writeDisassembleBookManifest(
  book: DisassembleBookManifest,
  context: WorkflowRunContext,
  options: DisassembleBookWriteOptions = {}
): Promise<DisassembleBookManifest> {
  const next: DisassembleBookManifest = {
    ...book,
    updated_at: new Date().toISOString()
  };
  await writeDisassembleBookDocument(`${next.dir}/${BOOK_MANIFEST_PATH}`, `${JSON.stringify(next)}\n`, `拆书书籍 manifest：${next.title}`, context, {
    workflowId: options.workflowId || "disassemble_book",
    writeKey: options.writeKey || "book.manifest"
  });
  return next;
}

export type DisassembleBookWriteOptions = {
  workflowId?: string;
  /** Stable per-run operation key: recovery replays the same write, later writes remain distinct. */
  writeKey?: string;
};

export async function writeDisassembleBookDocument(
  targetPath: string,
  content: string,
  summary: string,
  context: WorkflowRunContext,
  options: DisassembleBookWriteOptions = {}
): Promise<void> {
  const workflowId = String(options.workflowId || "disassemble_book").trim() || "disassemble_book";
  const writeKey = String(options.writeKey || targetPath).trim() || targetPath;
  const durable = context.durableExecution;
  if (!durable || !context.commitJournal) {
    await context.documents.saveDocument(targetPath, content, { source: "skill", summary });
    return;
  }

  await context.commitJournal.write({
    runId: durable.runId,
    stepId: durable.stepId,
    attemptId: durable.attemptId,
    action: `workflow.${workflowId}.${writeKey}`,
    targetPath,
    content,
    idempotencyKey: createHash("sha256")
      .update(JSON.stringify({
        kind: "workflow_document_write",
        workflow_id: workflowId,
        write_key: writeKey,
        run_id: durable.runId,
        step_id: durable.stepId,
        target_path: targetPath
      }), "utf8")
      .digest("hex"),
    source: "skill",
    summary
  });
}

export async function listDisassembleBooks(
  context: WorkflowRunContext,
  options: { includeLegacy?: boolean } = {}
): Promise<DisassembleBookWithLegacy[]> {
  const root = path.join(context.projectRoot, DISASSEMBLE_LIBRARY_DIR);
  const books: DisassembleBookWithLegacy[] = [];
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const dir = `${DISASSEMBLE_LIBRARY_DIR}/${entry.name}`;
    const manifest = await readDisassembleBookManifest(dir, context).catch(() => null);
    if (manifest) {
      books.push(manifest);
    }
  }

  if (options.includeLegacy) {
    const legacy = await readLegacyDisassembleBookManifest(context);
    if (legacy) {
      books.push({ ...legacy, legacy: true });
    }
  }

  return books.sort((left, right) => {
    const leftAt = Date.parse(left.updated_at || left.created_at || "");
    const rightAt = Date.parse(right.updated_at || right.created_at || "");
    return rightAt - leftAt;
  });
}

export async function readDisassembleBookManifest(bookDir: string, context: WorkflowRunContext): Promise<DisassembleBookManifest> {
  const manifestPath = `${bookDir}/${BOOK_MANIFEST_PATH}`;
  const raw = String(await context.documents.readRawText(manifestPath, 50_000)).trim();
  if (!raw) {
    throw new Error("缺少拆书 manifest");
  }
  const parsed = JSON.parse(raw.split(/\r?\n/)[0] || "{}") as Partial<DisassembleBookManifest>;
  if (!parsed.id || !parsed.title) {
    throw new Error("拆书 manifest 不完整");
  }
  return {
    schema_version: Number(parsed.schema_version || 1),
    template_version: String(parsed.template_version || "1"),
    id: parsed.id,
    title: parsed.title,
    dir: parsed.dir || bookDir,
    created_at: parsed.created_at || new Date().toISOString(),
    updated_at: parsed.updated_at || parsed.created_at || new Date().toISOString(),
    origin: parsed.origin || "unknown",
    source_path: parsed.source_path || "",
    source_summary: parsed.source_summary || "",
    source_hash: parsed.source_hash || "",
    chars: Number(parsed.chars || 0),
    status: normalizeBookStatus(parsed),
    analysis_version: Number(parsed.analysis_version || 1),
    error: parsed.error || "",
    analyzed_at: parsed.analyzed_at || "",
    source: parsed.source || { path: parsed.source_path || "", hash: parsed.source_hash || "", chars: Number(parsed.chars || 0), chapter_count: 0, import_complete: Boolean(parsed.paths?.source) },
    progress: parsed.progress || { stage: parsed.status || "imported", completed_chapters: 0, total_chapters: 0, last_error: parsed.error || "" },
    coverage: parsed.coverage || { first_chapter: 0, last_chapter: 0, analyzed_chapters: [], missing_chapters: [] },
    paths: parsed.paths || {}
  };
}

export async function readLegacyDisassembleBookManifest(context: WorkflowRunContext): Promise<DisassembleBookManifest | null> {
  const lore = await readLegacyText(LEGACY_DISASSEMBLE_LORE_PATH, context);
  const reverseOutline = await readLegacyText(LEGACY_REVERSE_OUTLINE_PATH, context);
  const detailOutline = await readLegacyText(LEGACY_DISASSEMBLE_DETAIL_PATH, context);
  if (!lore && !reverseOutline && !detailOutline) {
    return null;
  }
  const title = "历史拆书产物";
  return {
    schema_version: 1,
    template_version: "legacy",
    id: "legacy",
    title,
    dir: "",
    created_at: new Date(0).toISOString(),
    updated_at: new Date().toISOString(),
    origin: "legacy",
    source_path: "",
    source_summary: summarizeSource([lore, reverseOutline, detailOutline].filter(Boolean).join("\n")),
    source_hash: "",
    chars: [lore, reverseOutline, detailOutline].join("\n").length,
    status: lore && reverseOutline ? "ready" : "stale",
    analysis_version: 0,
    error: "",
    analyzed_at: new Date().toISOString(),
    source: { path: "", hash: "", chars: [lore, reverseOutline, detailOutline].join("\n").length, chapter_count: 0, import_complete: false },
    progress: { stage: "legacy", completed_chapters: 0, total_chapters: 0, last_error: "" },
    coverage: { first_chapter: 0, last_chapter: 0, analyzed_chapters: [], missing_chapters: [] },
    paths: {
      lore: lore ? LEGACY_DISASSEMBLE_LORE_PATH : "",
      reverse_outline: reverseOutline ? LEGACY_REVERSE_OUTLINE_PATH : "",
      detail_outline: detailOutline ? LEGACY_DISASSEMBLE_DETAIL_PATH : ""
    }
  };
}

export async function resolveDisassembleBookForRequest(request: AgentRunRequest, context: WorkflowRunContext): Promise<DisassembleBookWithLegacy | null> {
  const explicitId = String((request as any).source_book_id || "").trim();
  if (explicitId) {
    if (explicitId === "legacy") {
      return readLegacyDisassembleBookManifest(context);
    }
    return (await listDisassembleBooks(context, { includeLegacy: false })).find((book) => book.id === explicitId) || null;
  }

  const currentPath = String(request.current_path || "").replace(/\\/g, "/").trim();
  const matched = currentPath.match(new RegExp(`^${DISASSEMBLE_LIBRARY_DIR.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/([^/]+)/`));
  if (matched?.[1]) {
    const books = await listDisassembleBooks(context, { includeLegacy: false });
    const found = books.find((book) => book.id === matched[1]);
    if (found) {
      return found;
    }
  }

  return null;
}

export async function readDisassembleBookText(
  book: DisassembleBookWithLegacy,
  kind: "source" | "lore" | "reverse_outline" | "detail_outline" | "report",
  context: WorkflowRunContext,
  limit = kind === "source" ? undefined : 24_000
): Promise<string> {
  const legacyPath =
    kind === "lore"
      ? LEGACY_DISASSEMBLE_LORE_PATH
      : kind === "reverse_outline"
        ? LEGACY_REVERSE_OUTLINE_PATH
      : kind === "detail_outline"
          ? LEGACY_DISASSEMBLE_DETAIL_PATH
          : kind === "report"
            ? ""
          : "";
  if (book.legacy || book.id === "legacy") {
    return readLegacyText(legacyPath, context, limit);
  }
  const relPath =
    kind === "source"
      ? book.paths.source || `${book.dir}/原文.txt`
      : kind === "lore"
        ? book.paths.lore || `${book.dir}/拆书设定提取.txt`
        : kind === "reverse_outline"
        ? book.paths.reverse_outline || `${book.dir}/反向细纲.txt`
          : kind === "detail_outline"
            ? book.paths.detail_outline || `${book.dir}/拆书细纲.txt`
            : book.paths.report || `${book.dir}/拆书报告.md`;
  return readLegacyText(relPath, context, limit);
}

export function sampleWholeBookSource(text: string, maxChars = 60_000): string {
  const source = String(text || "").trim();
  if (source.length <= maxChars) return source;
  const labels = ["开篇样本", "前段样本", "中段样本", "后段样本", "结尾样本"];
  const chunkSize = Math.max(2_000, Math.floor((maxChars - 600) / labels.length));
  return labels.map((label, index) => {
    const ratio = index / (labels.length - 1);
    const start = Math.max(0, Math.min(source.length - chunkSize, Math.floor((source.length - chunkSize) * ratio)));
    return `【${label} · 原文位置 ${start + 1}-${Math.min(source.length, start + chunkSize)} / ${source.length}】\n${source.slice(start, start + chunkSize)}`;
  }).join("\n\n");
}

export async function readLegacyText(relativePath: string, context: WorkflowRunContext, limit?: number): Promise<string> {
  if (!relativePath) {
    return "";
  }
  try {
    return (await context.documents.readRawText(relativePath, limit)).trim();
  } catch {
    return "";
  }
}

export async function inferDisassembleBookTitle(request: AgentRunRequest, source: string): Promise<string> {
  const explicit = String((request as any).book_title || "").trim();
  if (explicit) {
    return explicit;
  }
  const sourcePath = String(request.current_path || (request as any).source_path || "").trim();
  if (sourcePath) {
    return inferBookTitle(sourcePath, "当前拆书书籍");
  }
  const content = String(source || request.content || "").trim();
  const firstLine = content.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || "";
  return inferBookTitle(firstLine, "当前拆书书籍");
}

export async function resolveContinueDisassembleSource(request: AgentRunRequest, context: WorkflowRunContext): Promise<string> {
  const direct = String(request.selection || "").trim();
  if (direct) {
    return direct;
  }
  return readLegacyText(LEGACY_REVERSE_OUTLINE_PATH, context, 20_000);
}

export async function resolveWorkflowSourceText(request: AgentRunRequest, context: WorkflowRunContext): Promise<string> {
  const direct = String(request.selection || "").trim();
  if (direct) {
    return direct;
  }
  if (request.conversation_id && (request.attachment_ids || []).length) {
    const attachments = await context.conversations.getAttachmentTexts(request.conversation_id, request.attachment_ids, {
      limit: DISASSEMBLE_SOURCE_IMPORT_CHARS,
      preserveWhitespace: true
    });
    const text = attachments
      .map(([attachment, body]) => {
        const content = String(body || "").trim();
        if (attachment.size > content.length && attachment.size > DISASSEMBLE_SOURCE_IMPORT_CHARS) {
          throw new Error(`附件《${attachment.name}》超过拆书支持上限，未导入完整原文`);
        }
        return content ? `【${attachment.name}】\n${content}` : "";
      })
      .filter(Boolean)
      .join("\n\n")
      .trim();
    if (text) {
      return text;
    }
  }
  const sourcePath = resolveDisassembleSourcePath(request);
  if (sourcePath) {
    return readLegacyText(sourcePath, context);
  }
  return "";
}

export function formatBookTimestamp(date: Date): string {
  return date.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
}

export function summarizeSource(text: string): string {
  const compact = String(text || "").replace(/\s+/g, " ").trim();
  if (!compact) {
    return "";
  }
  return compact.length <= 240 ? compact : `${compact.slice(0, 240).trimEnd()}...`;
}

function resolveDisassembleSourcePath(request: AgentRunRequest): string {
  const text = request.content || "";
  const sourceText = String(request.selection || "").trim();
  const hasAttachments = Boolean((request.attachment_ids || []).length);
  const currentPath = String(request.current_path || "").replace(/\\/g, "/").trim().replace(/^\/+/, "");

  if (sourceText || hasAttachments) {
    return "";
  }

  if (currentPath && mentionsCurrentSource(text)) {
    return currentPath;
  }
  const named = resolveNamedSourcePath(text);
  if (named) {
    return named;
  }
  return currentPath;
}

function mentionsCurrentSource(text: string): boolean {
  return /(当前文档|当前正文|这篇|这章|这段|选中|选区|光标|打开的文档|正在编辑)/.test(text);
}

function resolveNamedSourcePath(text: string): string {
  if (/章纲(?:文件|文档)?/.test(text)) {
    return "01_大纲/章纲.txt";
  }
  if (/细纲(?:文件|文档)?/.test(text)) {
    return "01_大纲/细纲.txt";
  }
  if (/大纲(?:文件|文档)?/.test(text)) {
    return "01_大纲/大纲.txt";
  }
  if (/正文(?:文件|文档)?/.test(text)) {
    return "02_正文/正文.txt";
  }
  return "";
}

function inferBookTitle(sourcePath: string, fallback: string): string {
  const normalized = String(sourcePath || "").replace(/\\/g, "/").trim();
  const filename = normalized.split("/").filter(Boolean).at(-1) || "";
  const stem = filename.replace(/\.[^.]+$/, "").trim();
  return stem || fallback;
}

function sanitizeBookId(value: string): string {
  const sanitized = String(value || "")
    .replace(/[\\/:*?"<>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[^0-9A-Za-z\u4e00-\u9fa5_-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 42);
  return sanitized || "book";
}

function countChapters(text: string): number {
  return String(text || "").match(/(?:^|\n)\s*(?:第\s*\d+\s*章|Chapter\s+\d+)/gi)?.length || 0;
}

function buildChapterIndex(text: string): string {
  const source = String(text || "");
  const matches = [...source.matchAll(/(?:^|\n)\s*(第\s*(\d+)\s*章[^\n]*)/gi)];
  if (!matches.length) {
    return `${JSON.stringify({ index_type: "paragraph_window", start: 0, end: source.length, label: "全文" })}\n`;
  }
  return matches.map((match, index) => {
    const start = match.index || 0;
    const end = index + 1 < matches.length ? (matches[index + 1]?.index || source.length) : source.length;
    return JSON.stringify({ index_type: "chapter", chapter: Number(match[2] || index + 1), title: String(match[1] || "").trim(), start, end });
  }).join("\n") + "\n";
}

function normalizeBookStatus(parsed: Partial<DisassembleBookManifest>): DisassembleBookStatus {
  if (["imported", "analyzing", "ready", "failed", "stale"].includes(String(parsed.status || ""))) {
    return parsed.status as DisassembleBookStatus;
  }
  const paths = parsed.paths || {};
  return paths.report || (paths.lore && paths.reverse_outline) ? "ready" : "imported";
}
