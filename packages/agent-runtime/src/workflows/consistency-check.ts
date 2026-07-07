import { loadModelConfig, readRawConfig, type ModelConfig } from "@xiaoshuo/config-service";
import { buildProjectContinuityContext } from "@xiaoshuo/project-session";
import type { ChatCompletionMessage } from "@xiaoshuo/model-client";
import type { AgentRunRequest, AgentRunResponse, ConversationDetail } from "@xiaoshuo/shared";
import { GraphMemory, type CheckGraphDraftConsistencyResult } from "@xiaoshuo/vector-service";
import { randomUUID } from "node:crypto";
import { buildConsistencyCheckPrompt, parseConsistencyCheckResult } from "../prompts/consistency.js";
import type { WorkflowHandler, WorkflowRunContext } from "./types.js";
import { throwIfAborted } from "../cancellation.js";

const SOURCE_IMPORT_CHARS = 60_000;

type GraphAdvisoryResult =
  | { status: "ok"; result: CheckGraphDraftConsistencyResult }
  | { status: "unavailable"; error: string };

type ConsistencyCheckResult = ReturnType<typeof parseConsistencyCheckResult> & {
  graph_score?: number;
  graph_risks?: string[];
  blocking_claims?: CheckGraphDraftConsistencyResult["blocking_claims"];
  graph_suggested_fix?: string;
  graph_status?: "ok" | "unavailable";
  graph_error?: string;
};

export class ConsistencyCheckWorkflow implements WorkflowHandler {
  id = "consistency_check";

  async runAgent(request: AgentRunRequest, context: WorkflowRunContext): Promise<AgentRunResponse> {
    throwIfAborted(context.signal);
    const text = await resolveWorkflowSourceText(request, context);
    if (!text.trim()) {
      throw new Error("缺少要审查的正文");
    }

    const continuity = await buildProjectContinuityContext(context.projectRoot);
    const assistantConfig = await loadAssistantModelConfig(context);
    const chapterOutline = await resolveConsistencyChapterOutline(request, context);
    throwIfAborted(context.signal);
    const recent = continuity.previous_chapters.map((item) => item.content).join("\n");
    const graphAdvisoryPromise = checkGraphDraftConsistency(text, chapterOutline, context);
    const prompt = buildConsistencyCheckPrompt({
      chapterOutline,
      continuityContext: JSON.stringify({
        state_summary: continuity.state_summary,
        lore: continuity.lore,
        style: continuity.style,
        genre: continuity.genre
      }),
      recentText: recent,
      draftText: text
    });

    const raw = await context.modelClient.requestCompletion(
      assistantConfig.config,
      [
        { role: "system", content: "你是严厉的长篇小说连续性审稿人。只输出 JSON。" },
        { role: "user", content: prompt }
      ] satisfies ChatCompletionMessage[],
      0.1,
      { signal: context.signal }
    );
    throwIfAborted(context.signal);
    const graphAdvisory = await graphAdvisoryPromise;
    throwIfAborted(context.signal);
    const result = attachGraphAdvisory(parseConsistencyCheckResult(raw, assistantConfig.line), graphAdvisory);
    const reply = JSON.stringify(result, null, 2);
    const conversation = await recordSkillExchange(request, reply, context);

    return {
      intent: "skill",
      reply,
      conversation,
      results: [],
      skill_result: {
        status: "done",
        result: reply,
        saved_path: "",
        data: result
      },
      saved_paths: [],
      requires_confirmation: false
    };
  }
}

async function checkGraphDraftConsistency(
  draftText: string,
  chapterOutline: string,
  context: WorkflowRunContext
): Promise<GraphAdvisoryResult> {
  let memory: GraphMemory | null = null;
  try {
    memory = new GraphMemory(context.projectRoot);
    const result = await memory.checkDraftConsistency(draftText, { chapterOutline });
    return { status: "ok", result };
  } catch (err) {
    return {
      status: "unavailable",
      error: err instanceof Error ? err.message : String(err)
    };
  } finally {
    try {
      memory?.close();
    } catch {
      // Graph advisory cleanup must not affect the consistency workflow.
    }
  }
}

function attachGraphAdvisory(
  result: ReturnType<typeof parseConsistencyCheckResult>,
  advisory: GraphAdvisoryResult
): ConsistencyCheckResult {
  if (advisory.status === "unavailable") {
    return {
      ...result,
      graph_status: "unavailable",
      graph_error: advisory.error.slice(0, 500)
    };
  }

  return {
    ...result,
    graph_status: "ok",
    graph_score: advisory.result.score,
    graph_risks: advisory.result.risks,
    blocking_claims: advisory.result.blocking_claims,
    graph_suggested_fix: advisory.result.suggested_fix
  };
}

async function loadAssistantModelConfig(context: WorkflowRunContext): Promise<{ config: ModelConfig; line: "secondary" | "primary-fallback" }> {
  const rawConfig = await readRawConfig(context.config);
  const hasExplicitSecondary = Boolean(String(rawConfig.secondary_api_key || "").trim() && String(rawConfig.secondary_model || "").trim());
  if (hasExplicitSecondary) {
    const secondary = await loadModelConfig(context.config, "secondary");
    return { config: secondary, line: "secondary" };
  }
  const primary = await loadModelConfig(context.config, "primary");
  if (primary.configured) {
    return {
      config: {
        ...primary,
        temperature: Math.min(primary.temperature, 0.2)
      },
      line: "primary-fallback"
    };
  }
  throw new Error("未配置主线路或副线路 API Key / 模型名。");
}

async function resolveConsistencyChapterOutline(request: AgentRunRequest, context: WorkflowRunContext): Promise<string> {
  const direct = String(request.project_context_hint || "").trim();
  if (direct) {
    return direct;
  }
  for (const relPath of ["01_大纲/章纲.txt", "01_大纲/细纲.txt", "01_大纲/大纲.txt"]) {
    try {
      const text = await context.documents.readRawText(relPath, 5000);
      if (text.trim()) {
        return text.trim();
      }
    } catch {
      continue;
    }
  }
  return "";
}

async function resolveWorkflowSourceText(request: AgentRunRequest, context: WorkflowRunContext): Promise<string> {
  const direct = String(request.selection || "").trim();
  if (direct) {
    return direct;
  }
  if (request.conversation_id && (request.attachment_ids || []).length) {
    const attachments = await context.conversations.getAttachmentTexts(request.conversation_id, request.attachment_ids, {
      limit: SOURCE_IMPORT_CHARS,
      preserveWhitespace: true
    });
    const text = attachments
      .map(([attachment, body]) => {
        const content = String(body || "").trim();
        return content ? `【${attachment.name}】\n${content}` : "";
      })
      .filter(Boolean)
      .join("\n\n")
      .trim();
    if (text) {
      return text;
    }
  }
  const sourcePath = resolveWorkflowSourcePath(request);
  if (sourcePath) {
    try {
      return (await context.documents.readRawText(sourcePath, SOURCE_IMPORT_CHARS)).trim();
    } catch {
      return "";
    }
  }
  return "";
}

function resolveWorkflowSourcePath(request: AgentRunRequest): string {
  const text = String(request.content || "");
  const currentPath = String((request as any).source_path || request.current_path || "")
    .replace(/\\/g, "/")
    .trim()
    .replace(/^\/+/, "");
  const named = resolveNamedSourcePath(text);
  if (named) {
    return named;
  }
  if (currentPath && mentionsCurrentSource(text)) {
    return currentPath;
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
