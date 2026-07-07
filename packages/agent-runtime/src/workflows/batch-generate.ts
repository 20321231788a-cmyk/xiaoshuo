import type { AgentRunRequest, AgentRunResponse, ConversationDetail } from "@xiaoshuo/shared";
import { randomUUID } from "node:crypto";
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
    const results: Array<Record<string, unknown>> = [];
    const savedPaths: string[] = [];
    const webSearchSources: WebSearchSource[] = [];

    for (let chapter = startChapter; chapter <= endChapter; chapter += 1) {
      const originalInstruction = (request.content || "").trim();
      const chapterInstruction = shouldWriteSkillResult(originalInstruction)
        ? `生成第${chapter}章正文并写入文件`
        : `生成第${chapter}章正文`;
      const chapterRequest: AgentRunRequest = {
        ...request,
        content: originalInstruction ? `${chapterInstruction}。原始批量指令：${originalInstruction}` : chapterInstruction,
        skill_id: "body_generate",
        selection: ""
      };
      const result = await this.bodyHandler.runAgent(chapterRequest, context);
      savedPaths.push(...result.saved_paths);
      webSearchSources.push(...(result.web_search_sources || []));
      results.push({
        ...(result.skill_result?.data || {}),
        saved_paths: result.saved_paths
      });
    }

    const reply = savedPaths.length
      ? `已写入 ${savedPaths.length} 个文件：\n${savedPaths.join("\n")}`
      : `已生成 ${results.length} 章正文，等待保存确认。`;
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
          web_search_sources: batchWebSearchSources
        }
      },
      saved_paths: savedPaths,
      requires_confirmation: false,
      web_search_sources: batchWebSearchSources
    };
  }
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

function shouldWriteSkillResult(text: string): boolean {
  return /(同步|写入|保存|更新|替换|覆盖|落到|写回|补充|补全|完善|补齐|填充|配置|设置|设定|建立|创建)/.test(text);
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
