import { loadModelConfig } from "@xiaoshuo/config-service";
import { buildProjectContinuityContext } from "@xiaoshuo/project-session";
import type { ChatCompletionMessage } from "@xiaoshuo/model-client";
import type { AgentRunRequest, AgentRunResponse, ConversationDetail, SkillRunResponse } from "@xiaoshuo/shared";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { clipForConsistency } from "../prompts/consistency.js";
import {
  BOOK_MANIFEST_PATH,
  formatBookTimestamp,
  listDisassembleBooks,
  readDisassembleBookText,
  type DisassembleBookManifest
} from "./disassemble-library.js";
import type { WorkflowHandler, WorkflowRunContext } from "./types.js";
import { throwIfAborted } from "../cancellation.js";

const FUSION_LIBRARY_DIR = "00_设定集/融梗方案";

type FusionSourceBook = DisassembleBookManifest & {
  legacy?: boolean;
  lore?: string;
  reverseOutline?: string;
  detailOutline?: string;
  report?: string;
};

export class BookFusionWorkflow implements WorkflowHandler {
  id = "book_fusion";

  async runAgent(request: AgentRunRequest, context: WorkflowRunContext): Promise<AgentRunResponse> {
    throwIfAborted(context.signal);
    if (String((request as any).action || "").trim() === "mark_applied") {
      return markFusionApplied(request, context);
    }
    const result = await runBookFusion(request, context);
    const savedPaths = resolveSavedPaths(result);
    const reply = savedPaths.length ? `融梗方案已生成：\n${savedPaths.join("\n")}` : result.result || "融梗方案已生成。";
    return {
      intent: "skill",
      reply,
      conversation: await recordSkillExchange(request, reply, context),
      results: [],
      skill_result: result,
      saved_paths: savedPaths,
      requires_confirmation: false
    };
  }
}

async function runBookFusion(request: AgentRunRequest, context: WorkflowRunContext): Promise<SkillRunResponse> {
  throwIfAborted(context.signal);
  const sourceBookIds = uniquePaths(stringListFromUnknown((request as any).source_book_ids));
  if (sourceBookIds.length < 3) {
    throw new Error("融梗至少需要选择三本已拆书籍");
  }
  const customPrompt = String((request as any).custom_prompt || request.content || "").trim();
  const genreHint = String((request as any).genre_hint || "").trim();
  const outputMode = String((request as any).output_mode || "candidate").trim();
  const books = await loadBooksForFusion(sourceBookIds, context);
  throwIfAborted(context.signal);
  if (books.length < 3) {
    throw new Error("融梗只能选择已经完成拆书的文件夹，且至少需要三本");
  }

  const continuity = await buildProjectContinuityContext(context.projectRoot);
  const config = await loadModelConfig(context.config, "primary");
  throwIfAborted(context.signal);
  if (!config.configured) {
    throw new Error("未配置主线路 API Key 或模型名，无法执行融梗。");
  }

  const fusionId = `${formatBookTimestamp(new Date())}-${createHash("sha1").update(sourceBookIds.join("|") + customPrompt + genreHint).digest("hex").slice(0, 8)}`;
  const fusionDir = `${FUSION_LIBRARY_DIR}/${fusionId}`;
  const sourceBooksText = books
    .map((book, index) =>
      [
        `【书籍 ${index + 1}】${book.title}`,
        `【来源】${book.source_path || book.dir || "已拆书籍"}`,
        `【拆书设定】\n${book.lore || "无"}`,
        `【反向细纲】\n${book.reverseOutline || "无"}`,
        `【拆书细纲】\n${book.detailOutline || "无"}`,
        `【拆书报告】\n${book.report || "无"}`
      ].join("\n")
    )
    .join("\n\n");

  const systemPrompt = [
    "你是小说融梗编辑器。任务是参考多本书的核心设定和剧情结构，抽象融合出一个新的原创方案。",
    "必须避免原文句式、专有名词、可识别桥段和人物关系的直接复写，只能提炼共性结构、冲突机制、人物驱动力与题材骨架。",
    "融合时要优先保留高层逻辑、冲突张力、题材魅力和可持续展开性，不能做简单拼接。",
    "输出必须可直接用于后续大纲或设定生成，且只输出中文正文，不要免责声明。"
  ].join("\n");
  const userPrompt = [
    `【输出模式】${outputMode}`,
    `【用户提示词】${customPrompt || "无"}`,
    `【题材提示】${genreHint || "无"}`,
    "",
    `【当前题材库】\n${clipForConsistency(JSON.stringify(continuity.genre), 12000) || "暂无题材库"}`,
    "",
    "请按以下结构输出融合候选方案：",
    "1. 融合后核心设定：世界基调、能力/规则、人物群像、冲突底层逻辑。",
    "2. 融合后剧情骨架：开局、升级/推进路径、关键反转、阶段性目标、收束方向。",
    "3. 可复用题材匹配点：哪些题材元素被吸收，哪些被主动舍弃。",
    "4. 原创化约束：明确列出哪些东西不能直接照抄，哪些必须重写。",
    "5. 后续可展开方向：适合继续拆成大纲/细纲/章纲的切入点。",
    "",
    "要求：至少综合三本书的优点，但不能出现“把 A+B+C 拼起来”的痕迹；必须像一个全新项目的起点。",
    "",
    "【待融合书籍资料】",
    sourceBooksText
  ].join("\n");

  const raw = String(
    await context.modelClient.requestCompletion(
      config,
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ] satisfies ChatCompletionMessage[],
      Math.max(0.2, Math.min(0.55, config.temperature)),
      { signal: context.signal }
    )
  ).trim();
  throwIfAborted(context.signal);

  if (!raw) {
    throw new Error("模型未返回融梗候选方案");
  }

  await fs.mkdir(path.join(context.projectRoot, FUSION_LIBRARY_DIR, fusionId), { recursive: true });
  throwIfAborted(context.signal);
  const fusionManifest: Record<string, unknown> = {
    id: fusionId,
    dir: fusionDir,
    source_book_ids: sourceBookIds,
    source_books: books.map((book) => ({
      id: book.id,
      title: book.title,
      dir: book.dir,
      source_path: book.source_path,
      source_summary: book.source_summary
    })),
    custom_prompt: customPrompt,
    genre_hint: genreHint,
    output_mode: outputMode,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    result_path: `${fusionDir}/融梗候选.md`,
    legacy_result_path: `${fusionDir}/融梗候选.txt`
  };

  await context.documents.saveDocument(`${fusionDir}/融梗候选.md`, raw, {
    source: "skill",
    summary: "融梗候选方案 Markdown"
  });
  await context.documents.saveDocument(`${fusionDir}/融梗候选.txt`, raw, {
    source: "skill",
    summary: "融梗候选方案"
  });
  await context.documents.saveDocument(`${fusionDir}/融梗提示词.txt`, customPrompt || "无", {
    source: "skill",
    summary: "融梗提示词"
  });
  await context.documents.saveDocument(`${fusionDir}/来源书籍.jsonl`, `${JSON.stringify(fusionManifest.source_books || [])}\n`, {
    source: "skill",
    summary: "融梗来源书籍"
  });
  await context.documents.saveDocument(`${fusionDir}/${BOOK_MANIFEST_PATH}`, `${JSON.stringify(fusionManifest)}\n`, {
    source: "skill",
    summary: "融梗 manifest"
  });

  return {
    status: "done",
    result: raw,
    saved_path: `${fusionDir}/融梗候选.txt`,
    data: {
      skill_id: "book_fusion",
      fusion_id: fusionId,
      fusion_dir: fusionDir,
      source_book_ids: sourceBookIds,
      source_books: fusionManifest.source_books,
      custom_prompt: customPrompt,
      genre_hint: genreHint,
      output_mode: outputMode,
      candidate_markdown_path: `${fusionDir}/融梗候选.md`,
      saved_paths: [
        `${fusionDir}/融梗候选.txt`,
        `${fusionDir}/融梗提示词.txt`,
        `${fusionDir}/来源书籍.jsonl`,
        `${fusionDir}/${BOOK_MANIFEST_PATH}`,
        `${fusionDir}/融梗候选.md`
      ]
    }
  };
}

async function markFusionApplied(request: AgentRunRequest, context: WorkflowRunContext): Promise<AgentRunResponse> {
  const fusionId = String((request as any).fusion_id || "").trim();
  if (!fusionId) throw new Error("缺少融梗候选 ID");
  const manifestPath = `${FUSION_LIBRARY_DIR}/${fusionId}/${BOOK_MANIFEST_PATH}`;
  const raw = await context.documents.readRawText(manifestPath, 200_000).catch(() => "");
  if (!raw.trim()) throw new Error("未找到融梗候选 manifest");
  const manifest = JSON.parse(raw.split(/\r?\n/)[0] || "{}") as Record<string, unknown>;
  manifest.applied_target = String((request as any).applied_target || "").trim();
  manifest.applied_revision = Number((request as any).target_revision || 0);
  manifest.applied_at = new Date().toISOString();
  await context.documents.saveDocument(manifestPath, `${JSON.stringify(manifest)}\n`, { source: "skill", summary: "记录融梗应用回执" });
  const reply = `融梗候选已应用到${manifest.applied_target || "当前项目"}。`;
  return {
    intent: "skill",
    reply,
    conversation: null,
    results: [],
    skill_result: { status: "done", result: reply, saved_path: manifestPath, data: { skill_id: "book_fusion", fusion_id: fusionId, applied_target: manifest.applied_target, applied_revision: manifest.applied_revision } },
    saved_paths: [manifestPath],
    requires_confirmation: false
  };
}

async function loadBooksForFusion(sourceBookIds: string[], context: WorkflowRunContext): Promise<FusionSourceBook[]> {
  const books = await listDisassembleBooks(context, { includeLegacy: true });
  const selected: FusionSourceBook[] = [];
  for (const id of sourceBookIds) {
    const book = books.find((item) => item.id === id);
    if (!book) {
      continue;
    }
    if (!isDisassembleBookReadyForFusion(book)) {
      continue;
    }
    const fastReportOnly = book.analysis_scope?.mode === "prefix_chapters";
    selected.push({
      ...book,
      // A new fast run deliberately leaves legacy artefacts on disk but does
      // not use them as inputs.  This avoids mixing stale 20 万字 results into
      // the four-section report after the source has been re-analysed.
      lore: fastReportOnly ? "" : await readDisassembleBookText(book, "lore", context, 24_000),
      reverseOutline: fastReportOnly ? "" : await readDisassembleBookText(book, "reverse_outline", context, 24_000),
      detailOutline: fastReportOnly ? "" : await readDisassembleBookText(book, "detail_outline", context, 24_000),
      report: await readDisassembleBookText(book, "report", context, 80_000)
    });
  }
  return selected;
}

function isDisassembleBookReadyForFusion(book: DisassembleBookManifest & { legacy?: boolean }): boolean {
  // 旧项目可能只有设定与反向细纲，没有新版本的报告字段；允许其继续融梗，
  // 新导入流程仍只有生成报告后才会把 status 标记为 ready。
  return book.status === "ready" && Boolean(
    book.paths.report || (book.paths.lore && book.paths.reverse_outline)
  );
}

async function recordSkillExchange(
  request: AgentRunRequest,
  reply: string,
  context: WorkflowRunContext,
  assistantMetadata: Record<string, unknown> = {}
): Promise<ConversationDetail | undefined> {
  if ((request as any).suppress_conversation_record === true) {
    return request.conversation_id ? await context.conversations.getConversation(request.conversation_id).catch(() => undefined) : undefined;
  }
  const userText = String(request.content || "").trim();
  if (!userText) {
    return undefined;
  }

  let detail = request.conversation_id ? await context.conversations.getConversation(request.conversation_id).catch(() => null) : null;

  if (!detail) {
    detail = await context.conversations.createConversation({
      title: userText.slice(0, 24) || "新对话",
      skill_id: request.skill_id || "",
      agent_name: ""
    });
  }

  const createdAt = new Date().toISOString();
  const userMetadata = { intent: "skill" as const };
  const replyMetadata = { intent: "skill" as const, ...assistantMetadata };
  const recentMessages = detail.messages.slice(-3);
  const shouldAppendUser = !recentMessages.some((item) => item.role === "user" && item.content === userText);

  const nextMessages = [...detail.messages];
  if (shouldAppendUser) {
    nextMessages.push({
      id: randomUUID().replace(/-/g, ""),
      role: "user",
      content: userText,
      created_at: createdAt,
      metadata: userMetadata
    });
  }
  if (String(reply || "").trim()) {
    nextMessages.push({
      id: randomUUID().replace(/-/g, ""),
      role: "assistant",
      content: String(reply || "").trim(),
      created_at: createdAt,
      metadata: replyMetadata
    });
  }

  let nextDetail: ConversationDetail = {
    ...detail,
    title: detail.title === "新对话" ? userText.slice(0, 24) || detail.title : detail.title,
    current_skill: request.skill_id || detail.current_skill || "",
    updated_at: createdAt,
    messages: nextMessages,
    message_count: nextMessages.length
  };

  await context.conversations.saveConversation(nextDetail);
  if ((nextDetail.messages.length >= 10 && !nextDetail.summary) || nextDetail.messages.length % 6 === 0) {
    nextDetail = await context.conversations.summarizeConversation(nextDetail.id);
  }
  return nextDetail;
}

function resolveSavedPaths(result: { saved_path?: string; data?: Record<string, unknown> }): string[] {
  const fromData = Array.isArray(result.data?.saved_paths)
    ? result.data.saved_paths.filter((item): item is string => typeof item === "string" && item.length > 0)
    : [];
  if (fromData.length) {
    return fromData;
  }
  return result.saved_path ? [result.saved_path] : [];
}

function stringListFromUnknown(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item) => String(item || "").trim()).filter(Boolean);
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths.map((item) => item.trim()).filter(Boolean))];
}
