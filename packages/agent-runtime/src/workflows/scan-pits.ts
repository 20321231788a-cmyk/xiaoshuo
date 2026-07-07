import type { AgentRunRequest, AgentRunResponse, ConversationDetail } from "@xiaoshuo/shared";
import { randomUUID } from "node:crypto";
import type { WorkflowHandler, WorkflowRunContext } from "./types.js";

const SOURCE_IMPORT_CHARS = 60_000;

export class ScanPitsWorkflow implements WorkflowHandler {
  id = "scan_pits";

  async runAgent(request: AgentRunRequest, context: WorkflowRunContext): Promise<AgentRunResponse> {
    const source = await resolveWorkflowSourceText(request, context);
    if (!source.trim()) {
      throw new Error("缺少可扫描的正文内容");
    }

    const raw = await context.skillRunner.runSkill("outline_generate", {
      text: source,
      chapter: 0,
      end_chapter: 0,
      target_words: 2500,
      instruction: request.content || "请只输出待追踪伏笔，一行一条，避免空话。",
      target_path: "",
      conversation_id: request.conversation_id || "",
      source_path: "",
      write_result: false,
      attachment_ids: []
    });

    const created = [];
    for (const item of String(raw.result || "")
      .split(/\r?\n/)
      .map((line) => line.replace(/^[-*]\s*/, "").trim())
      .filter(Boolean)
      .slice(0, 12)) {
      created.push(await context.documents.addLedgerItem(item));
    }

    const reply = "伏笔账本已更新";
    const conversation = await recordSkillExchange(request, reply, context);
    return {
      intent: "skill",
      reply,
      conversation,
      results: [],
      skill_result: {
        status: "done",
        result: "",
        saved_path: "",
        data: {
          skill_id: this.id,
          items: created
        }
      },
      saved_paths: [],
      requires_confirmation: false
    };
  }
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
