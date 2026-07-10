import type { AgentRunRequest, AgentRunResponse, ConversationDetail } from "@xiaoshuo/shared";
import { randomUUID } from "node:crypto";
import {
  createDisassembleBook,
  inferDisassembleBookTitle,
  LEGACY_DISASSEMBLE_DETAIL_PATH,
  readDisassembleBookText,
  resolveContinueDisassembleSource,
  resolveDisassembleBookForRequest,
  writeDisassembleBookDocument,
  writeDisassembleBookManifest
} from "./disassemble-library.js";
import type { WorkflowHandler, WorkflowRunContext } from "./types.js";
import { throwIfAborted } from "../cancellation.js";

export class ContinueDisassembleWorkflow implements WorkflowHandler {
  id = "continue_disassemble";

  async runAgent(request: AgentRunRequest, context: WorkflowRunContext): Promise<AgentRunResponse> {
    throwIfAborted(context.signal);
    const sourceBook = await resolveDisassembleBookForRequest(request, context);
    const source = sourceBook ? await readDisassembleBookText(sourceBook, "reverse_outline", context, 30_000) : await resolveContinueDisassembleSource(request, context);
    if (!source.trim()) {
      throw new Error("缺少可继续拆解的反向细纲");
    }

    const result = await context.skillRunner.runSkill("outline_generate", {
      text: source,
      chapter: 0,
      end_chapter: 0,
      target_words: 2500,
      instruction: request.content || request.selection || "把反向细纲扩展为更完整的拆书细纲，按章节推进，保留关键冲突、转折、伏笔和人物关系变化。",
      target_path: "",
      conversation_id: request.conversation_id || "",
      source_path: "",
      write_result: false,
      attachment_ids: []
    }, { signal: context.signal });
    throwIfAborted(context.signal);

    const book = await createDisassembleBook(
      {
        title: String((request as any).book_title || sourceBook?.title || "").trim() || (await inferDisassembleBookTitle(request, source)),
        sourceText: source,
        sourcePath: sourceBook?.source_path || request.current_path || "",
        origin: sourceBook?.legacy ? "continue_disassemble:legacy" : "continue_disassemble",
        workflowId: this.id
      },
      context
    );
    throwIfAborted(context.signal);
    const detailPath = `${book.dir}/拆书细纲.txt`;
    await writeDisassembleBookDocument(detailPath, result.result || "", "继续拆细纲", context, {
      workflowId: this.id,
      writeKey: "detail_outline.output"
    });
    await writeDisassembleBookDocument(LEGACY_DISASSEMBLE_DETAIL_PATH, result.result || "", "继续拆细纲 legacy 同步", context, {
      workflowId: this.id,
      writeKey: "detail_outline.legacy_sync"
    });
    const updatedBook = await writeDisassembleBookManifest(
      {
        ...book,
        updated_at: new Date().toISOString(),
        paths: {
          ...book.paths,
          detail_outline: detailPath
        }
      },
      context,
      { workflowId: this.id, writeKey: "book.manifest.detail_outline" }
    );

    const savedPaths = [detailPath];
    const reply = `已写入 ${savedPaths.length} 个文件：\n${savedPaths.join("\n")}`;
    const conversation = await recordSkillExchange(request, reply, context);

    return {
      intent: "skill",
      reply,
      conversation,
      results: [],
      skill_result: {
        status: "done",
        result: result.result || "",
        saved_path: savedPaths[0] || "",
        data: {
          skill_id: this.id,
          saved_paths: savedPaths,
          path: savedPaths[0],
          book: updatedBook,
          legacy_saved_paths: [LEGACY_DISASSEMBLE_DETAIL_PATH]
        }
      },
      saved_paths: savedPaths,
      requires_confirmation: false
    };
  }
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
