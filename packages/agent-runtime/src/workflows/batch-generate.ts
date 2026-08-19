import type { AgentRunRequest, AgentRunResponse, ConversationDetail } from "@xiaoshuo/shared";
import { randomUUID } from "node:crypto";
import { throwIfAborted } from "../cancellation.js";
import type { WebSearchSource } from "../web-search.js";
import type { WorkflowHandler, WorkflowRunContext } from "./types.js";

export class BatchGenerateWorkflow implements WorkflowHandler {
  id = "batch_generate";
  private readonly bodyHandler: WorkflowHandler;

  constructor(bodyHandler: WorkflowHandler) {
    this.bodyHandler = bodyHandler;
  }

  async runAgent(request: AgentRunRequest, context: WorkflowRunContext): Promise<AgentRunResponse> {
    const [startChapter, endChapter] = resolveBatchChapterRange(request);
    if (startChapter > endChapter) {
      throw new Error("起始章节不能大于结束章节");
    }
    const totalChapters = endChapter - startChapter + 1;
    const results: Array<Record<string, unknown>> = [];
    const savedPaths: string[] = [];
    const webSearchSources: WebSearchSource[] = [];
    const completed = new Map(
      (context.checkpoint?.listCompletedUnits(this.id) || []).map((checkpoint) => [checkpoint.unit_id, checkpoint.payload])
    );

    throwIfAborted(context.signal);
    let completedChapters = 0;
    context.reportProgress?.({
      stage: "batch_prepare",
      message: `正在准备 ${totalChapters} 章的生成任务（${completedChapters}/${totalChapters}）`,
      completed: completedChapters,
      total: totalChapters
    });
    for (let chapter = startChapter; chapter <= endChapter; chapter += 1) {
      throwIfAborted(context.signal);
      const unitId = `chapter:${chapter}`;
      const checkpoint = completed.get(unitId);
      if (checkpoint) {
        const restored = restoreChapterResult(chapter, checkpoint);
        savedPaths.push(...restored.saved_paths);
        webSearchSources.push(...restored.web_search_sources);
        results.push(restored.result);
        completedChapters += 1;
        context.reportProgress?.({
          stage: "batch_resume",
          message: `已恢复第${chapter}章，继续后续章节（${completedChapters}/${totalChapters}）`,
          completed: completedChapters,
          total: totalChapters
        });
        continue;
      }
      context.reportProgress?.({
        stage: "batch_generating",
        message: `正在生成第${chapter}章（${completedChapters}/${totalChapters}）`,
        completed: completedChapters,
        total: totalChapters
      });
      const originalInstruction = (request.content || "").trim();
      // Generation is always cache-first. Wording this as a direct write made
      // body_generate bypass the preview group in older runs.
      const chapterInstruction = `生成第${chapter}章正文`;
      const chapterRequest: AgentRunRequest = {
        ...request,
        content: originalInstruction ? `${chapterInstruction}。原始批量指令：${originalInstruction}` : chapterInstruction,
        skill_id: "body_generate",
        selection: ""
      };
      const result = await runChapterWithRetries(this.bodyHandler, chapterRequest, context, chapter);
      throwIfAborted(context.signal);
      savedPaths.push(...result.saved_paths);
      webSearchSources.push(...(result.web_search_sources || []));
      const chapterResult = {
        ...(result.skill_result?.data || {}),
        saved_paths: result.saved_paths
      };
      results.push(chapterResult);
      context.checkpoint?.completeUnit({
        workflow_id: this.id,
        unit_id: unitId,
        payload: {
          chapter,
          saved_paths: result.saved_paths,
          web_search_sources: result.web_search_sources || [],
          result: chapterResult
        }
      });
      completedChapters += 1;
      context.reportProgress?.({
        stage: "batch_completed_chapter",
        message: `已完成第${chapter}章（${completedChapters}/${totalChapters}）`,
        completed: completedChapters,
        total: totalChapters
      });
      if (Boolean((request as any).pause_each) && chapter < endChapter && context.requestPause) {
        const message = `第${chapter}章已生成缓存，已暂停等待预览确认。`;
        context.reportProgress?.({
          stage: "batch_paused_for_review",
          message,
          completed: completedChapters,
          total: totalChapters
        });
        context.requestPause(message);
        throw new Error(message);
      }
    }

    const reply = `已生成 ${results.length} 章正文缓存，等待整组保存确认。`;
    const batchWebSearchSources = uniqueWebSearchSources(webSearchSources);
    const conversation = await recordSkillExchange(
      request,
      reply,
      context,
      batchWebSearchSources.length ? { web_search_sources: batchWebSearchSources } : {}
    );
    return {
      intent: "skill",
      reply,
      conversation,
      results: [],
      skill_result: {
        status: "done",
        result: "",
        saved_path: savedPaths[0] || "",
        data: {
          skill_id: this.id,
          chapters: Array.from({ length: endChapter - startChapter + 1 }, (_, index) => startChapter + index),
          results,
          batch_group_id: String((request as any).batch_group_id || context.durableExecution?.runId || ""),
          pending_review: true,
          web_search_sources: batchWebSearchSources
        }
      },
      saved_paths: [],
      requires_confirmation: false,
      web_search_sources: batchWebSearchSources
    };
  }
}

function restoreChapterResult(chapter: number, checkpoint: Record<string, unknown>): {
  saved_paths: string[];
  web_search_sources: WebSearchSource[];
  result: Record<string, unknown>;
} {
  const savedPaths = Array.isArray(checkpoint.saved_paths)
    ? checkpoint.saved_paths.map((value) => String(value || "").trim()).filter(Boolean)
    : [];
  const webSearchSources = Array.isArray(checkpoint.web_search_sources)
    ? checkpoint.web_search_sources.filter(isWebSearchSource)
    : [];
  const result = checkpoint.result && typeof checkpoint.result === "object" && !Array.isArray(checkpoint.result)
    ? { ...(checkpoint.result as Record<string, unknown>) }
    : { chapter, saved_paths: savedPaths, resumed_from_checkpoint: true };
  return { saved_paths: savedPaths, web_search_sources: webSearchSources, result };
}

function isWebSearchSource(value: unknown): value is WebSearchSource {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      String((value as Record<string, unknown>).title || "").trim() &&
      String((value as Record<string, unknown>).url || "").trim()
  );
}

function resolveBatchChapterRange(request: AgentRunRequest): [number, number] {
  const [startChapter, endChapter] = resolveChapterRange(request.content || "");
  if (startChapter > 0) {
    return [startChapter, endChapter];
  }
  const chapter = resolveChapterNumber(request.content || "") || resolveChapterNumber(request.current_path || "");
  return [Math.max(1, chapter || 1), Math.max(1, chapter || 1)];
}

function resolveChapterRange(text: string): [number, number] {
  const raw = text || "";
  const patterns = [
    /第\s*(\d{1,4})\s*(?:章)?\s*(?:到|至|[-~－—])\s*(?:第\s*)?(\d{1,4})\s*章/i,
    /\b(\d{1,4})\s*[-~－—]\s*(\d{1,4})\s*章/i,
    /(?:chapter|chap)\s*(\d{1,4})\s*(?:to|through|[-~])\s*(?:(?:chapter|chap)\s*)?(\d{1,4})\b/i
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(raw);
    if (match) {
      const start = Math.max(1, Number.parseInt(match[1] || "0", 10));
      const end = Math.max(start, Number.parseInt(match[2] || "0", 10));
      return [start, end];
    }
  }
  return [0, 0];
}

function resolveChapterNumber(text: string): number {
  const raw = text || "";
  const patterns = [/第\s*(\d{1,4})\s*章/i, /(?:chapter|chap)\s*(\d{1,4})\b/i, /\b(\d{1,4})\s*章/i];
  for (const pattern of patterns) {
    const match = pattern.exec(raw);
    if (match) {
      return Math.max(0, Number.parseInt(match[1] || "0", 10));
    }
  }
  return 0;
}

async function runChapterWithRetries(
  handler: WorkflowHandler,
  request: AgentRunRequest,
  context: WorkflowRunContext,
  chapter: number
): Promise<AgentRunResponse> {
  const attempts = Math.min(3, Math.max(1, Number((request as any).max_attempts || 1)));
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    throwIfAborted(context.signal);
    try {
      return await handler.runAgent(request, context);
    } catch (error) {
      lastError = error;
      if (!isTransientError(error) || attempt >= attempts) {
        throw error;
      }
      const delayMs = attempt === 1 ? 500 : 1_500;
      context.reportProgress?.({
        stage: "batch_retrying",
        message: `第${chapter}章临时失败，正在第 ${attempt + 1}/${attempts} 次重试。`
      });
      await delay(delayMs, context.signal);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("批量章节生成失败");
}

function isTransientError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error || "");
  return /(timeout|timed out|网络|network|socket|429|rate.?limit|5\d{2}|服务端|temporary|temporar)/i.test(message);
}

async function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason instanceof Error ? signal.reason : new Error("操作已取消"));
    }, { once: true });
  });
}

function uniqueWebSearchSources(sources: WebSearchSource[]): WebSearchSource[] {
  const seen = new Set<string>();
  const unique: WebSearchSource[] = [];
  for (const source of sources) {
    const url = String(source.url || "").trim();
    const title = String(source.title || "").trim();
    if (!url || !title || seen.has(url)) {
      continue;
    }
    seen.add(url);
    unique.push({ title, url });
  }
  return unique.slice(0, 5);
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
  let parentMessageId = [...nextMessages].reverse().find((item) => item.role === "user" && item.content === userText)?.id || "";
  if (shouldAppendUser) {
    const userId = randomUUID().replace(/-/g, "");
    nextMessages.push({
      id: userId,
      role: "user",
      content: userText,
      created_at: createdAt,
      metadata: userMetadata
    });
    parentMessageId = userId;
  }
  if (String(reply || "").trim()) {
    nextMessages.push({
      id: randomUUID().replace(/-/g, ""),
      role: "assistant",
      parent_message_id: parentMessageId,
      run_id: context.durableExecution?.runId || "",
      turn_id: parentMessageId || context.durableExecution?.runId || "",
      status: "completed",
      finish_reason: "stop",
      content: String(reply || "").trim(),
      created_at: createdAt,
      metadata: { ...replyMetadata, ...(context.durableExecution ? { run_id: context.durableExecution.runId } : {}) }
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
