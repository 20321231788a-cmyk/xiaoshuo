import type { AgentRunRequest, AgentRunResponse, ConversationDetail } from "@xiaoshuo/shared";
import { randomUUID } from "node:crypto";
import {
  createDisassembleBook,
  inferDisassembleBookTitle,
  LEGACY_DISASSEMBLE_LORE_PATH,
  LEGACY_REVERSE_OUTLINE_PATH,
  listDisassembleBooks,
  readDisassembleBookText,
  resolveDisassembleBookForRequest,
  resolveWorkflowSourceText,
  writeDisassembleBookManifest
} from "./disassemble-library.js";
import type { WorkflowHandler, WorkflowRunContext } from "./types.js";
import { throwIfAborted } from "../cancellation.js";

export class DisassembleBookWorkflow implements WorkflowHandler {
  id = "disassemble_book";

  async runAgent(request: AgentRunRequest, context: WorkflowRunContext): Promise<AgentRunResponse> {
    throwIfAborted(context.signal);
    const action = String((request as any).action || "").trim();
    if (action === "list_library") {
      return listDisassembleLibrary(context);
    }
    if (action === "archive_source") {
      return archiveDisassembleSource(request, context);
    }
    return runFullDisassemble(request, context);
  }
}

async function listDisassembleLibrary(context: WorkflowRunContext): Promise<AgentRunResponse> {
  const books = await listDisassembleBooks(context, { includeLegacy: true });
  return {
    intent: "skill",
    reply: `拆书库共有 ${books.length} 本书。`,
    conversation: null,
    results: [],
    skill_result: {
      status: "done",
      result: "",
      saved_path: "",
      data: {
        skill_id: "disassemble_book",
        books
      }
    },
    saved_paths: [],
    requires_confirmation: false
  };
}

async function archiveDisassembleSource(request: AgentRunRequest, context: WorkflowRunContext): Promise<AgentRunResponse> {
  throwIfAborted(context.signal);
  const source = await resolveWorkflowSourceText(request, context);
  if (!source.trim()) {
    throw new Error("缺少可归档的拆书原文");
  }
  const book = await createDisassembleBook(
    {
      title: await inferDisassembleBookTitle(request, source),
      sourceText: source,
      sourcePath: request.current_path || "",
      origin: request.attachment_ids?.length ? "upload" : request.current_path ? "document" : "input"
    },
    context
  );
  throwIfAborted(context.signal);
  const books = await listDisassembleBooks(context, { includeLegacy: true });
  const reply = `已归档拆书原文：${book.title}`;
  return {
    intent: "skill",
    reply,
    conversation: await recordSkillExchange(request, reply, context),
    results: [],
    skill_result: {
      status: "done",
      result: reply,
      saved_path: book.paths.source || "",
      data: {
        skill_id: "disassemble_book",
        book,
        books,
        saved_paths: book.paths.source ? [book.paths.source] : []
      }
    },
    saved_paths: book.paths.source ? [book.paths.source] : [],
    requires_confirmation: false
  };
}

async function runFullDisassemble(request: AgentRunRequest, context: WorkflowRunContext): Promise<AgentRunResponse> {
  throwIfAborted(context.signal);
  const existingBook = await resolveDisassembleBookForRequest(request, context);
  const directSource = await resolveWorkflowSourceText(request, context);
  const source = directSource.trim() || (existingBook ? await readDisassembleBookText(existingBook, "source", context, 80_000) : "");
  if (!source.trim()) {
    throw new Error("拆书需要上传文件、来源文件或直接输入文本");
  }
  const book = await createDisassembleBook(
    {
      title: String((request as any).book_title || existingBook?.title || "").trim() || (await inferDisassembleBookTitle(request, source)),
      sourceText: source,
      sourcePath: existingBook?.source_path || request.current_path || "",
      origin: request.attachment_ids?.length ? "upload" : request.current_path ? "document" : existingBook?.origin || "input"
    },
    context
  );
  throwIfAborted(context.signal);

  const lore = await context.skillRunner.runSkill("lore_extract", {
    text: source,
    chapter: 0,
    end_chapter: 0,
    target_words: 2500,
    instruction: "提取拆书设定",
    target_path: "",
    conversation_id: request.conversation_id || "",
    source_path: "",
    write_result: false,
    attachment_ids: []
  }, { signal: context.signal });
  throwIfAborted(context.signal);
  const reverseOutline = await context.skillRunner.runSkill("reverse_outline_extract", {
    text: source,
    chapter: 0,
    end_chapter: 0,
    target_words: 2500,
    instruction: "按章节或关键段落提取真实剧情推进",
    target_path: "",
    conversation_id: request.conversation_id || "",
    source_path: "",
    write_result: false,
    attachment_ids: []
  }, { signal: context.signal });
  throwIfAborted(context.signal);

  const lorePath = `${book.dir}/拆书设定提取.txt`;
  const reversePath = `${book.dir}/反向细纲.txt`;
  await context.documents.saveDocument(lorePath, lore.result || "", {
    source: "skill",
    summary: "拆书写入设定"
  });
  await context.documents.saveDocument(reversePath, reverseOutline.result || "", {
    source: "skill",
    summary: "拆书写入反向细纲"
  });
  await context.documents.saveDocument(LEGACY_DISASSEMBLE_LORE_PATH, lore.result || "", {
    source: "skill",
    summary: "拆书写入设定 legacy 同步"
  });
  await context.documents.saveDocument(LEGACY_REVERSE_OUTLINE_PATH, reverseOutline.result || "", {
    source: "skill",
    summary: "拆书写入反向细纲 legacy 同步"
  });
  const updatedBook = await writeDisassembleBookManifest(
    {
      ...book,
      updated_at: new Date().toISOString(),
      paths: {
        ...book.paths,
        lore: lorePath,
        reverse_outline: reversePath
      }
    },
    context
  );

  const savedPaths = [lorePath, reversePath];
  const reply = `已写入 ${savedPaths.length} 个文件：\n${savedPaths.join("\n")}`;
  const conversation = await recordSkillExchange(request, reply, context);

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
        skill_id: "disassemble_book",
        saved_paths: savedPaths,
        lore_path: savedPaths[0],
        outline_path: savedPaths[1],
        book: updatedBook,
        legacy_saved_paths: [LEGACY_DISASSEMBLE_LORE_PATH, LEGACY_REVERSE_OUTLINE_PATH]
      }
    },
    saved_paths: savedPaths,
    requires_confirmation: false
  };
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
