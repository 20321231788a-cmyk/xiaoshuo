import type { AgentRunRequest, AgentRunResponse, ConversationDetail } from "@xiaoshuo/shared";
import { randomUUID } from "node:crypto";
import {
  createDisassembleBook,
  DISASSEMBLE_SOURCE_IMPORT_CHARS,
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

const LORE_OUTPUT_SECTIONS = [
  "## 人物设定",
  "## 体系设定",
  "## 地图设定",
  "## 道具设定",
  "## 势力与关系",
  "## 伏笔与可复用素材"
];

const REVERSE_OUTLINE_SECTIONS = [
  "## 逐章速览",
  "## 大事件拆解",
  "## 全书结构总览"
];

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
  const source = directSource.trim() || (existingBook ? await readDisassembleBookText(existingBook, "source", context, DISASSEMBLE_SOURCE_IMPORT_CHARS) : "");
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

  const bookTitle = book.title || "当前拆书书籍";
  const lore = await context.skillRunner.runSkill("lore_extract", {
    text: source,
    chapter: 0,
    end_chapter: 0,
    target_words: 2500,
    instruction: buildLoreInstruction(bookTitle, request),
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
    instruction: buildReverseOutlineInstruction(bookTitle, request),
    target_path: "",
    conversation_id: request.conversation_id || "",
    source_path: "",
    write_result: false,
    attachment_ids: []
  }, { signal: context.signal });
  throwIfAborted(context.signal);

  const lorePath = `${book.dir}/拆书设定提取.txt`;
  const reversePath = `${book.dir}/反向细纲.txt`;
  const loreText = normalizeDisassembleOutput("lore", bookTitle, lore.result || "");
  const reverseOutlineText = normalizeDisassembleOutput("reverse", bookTitle, reverseOutline.result || "");
  await context.documents.saveDocument(lorePath, loreText, {
    source: "skill",
    summary: "拆书写入设定"
  });
  await context.documents.saveDocument(reversePath, reverseOutlineText, {
    source: "skill",
    summary: "拆书写入反向细纲"
  });
  await context.documents.saveDocument(LEGACY_DISASSEMBLE_LORE_PATH, loreText, {
    source: "skill",
    summary: "拆书写入设定 legacy 同步"
  });
  await context.documents.saveDocument(LEGACY_REVERSE_OUTLINE_PATH, reverseOutlineText, {
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

function buildLoreInstruction(bookTitle: string, request: AgentRunRequest): string {
  const userInstruction = String((request as any).instruction || request.content || "").trim();
  return [
    "你正在执行一键拆书的「拆书设定提取.txt」生成步骤。",
    "必须严格输出 Markdown 文件正文，不要寒暄、不要解释、不要代码块。",
    `文件首行必须是：# 《${bookTitle}》拆书设定提取`,
    "必须保留且按顺序输出以下二级标题：",
    ...LORE_OUTPUT_SECTIONS.map((section) => `- ${section}`),
    "每个条目必须写清：名称、出现位置或章节范围、事实依据、作用、后续可复用方式。原文没有明确的信息写「原文未明确」，禁止脑补硬事实。",
    "人物要合并别名；势力、能力、金手指、道具、地点、伏笔都要分区归档。",
    userInstruction ? `用户补充要求：${userInstruction}` : "用户补充要求：无"
  ].join("\n");
}

function buildReverseOutlineInstruction(bookTitle: string, request: AgentRunRequest): string {
  const userInstruction = String((request as any).instruction || request.content || "").trim();
  return [
    "你正在执行一键拆书的「反向细纲.txt」生成步骤。",
    "必须严格输出 Markdown 文件正文，不要寒暄、不要解释、不要代码块。",
    `文件首行必须是：# 《${bookTitle}》详细剧情发展`,
    "必须保留且按顺序输出以下二级标题：",
    ...REVERSE_OUTLINE_SECTIONS.map((section) => `- ${section}`),
    "【逐章速览】格式：按章节顺序写「第 N 章：一句话概括」，能识别章节就逐章写；章节不足或无章节边界时按关键段落编号写。",
    "【大事件拆解】格式：每个大事件使用「【大事件 N】标题（第 X-Y 章）」；下一行写「⭐ 高潮：第 X 章 - ...」；再拆 2-6 个小事件，每个小事件必须包含「起：」「承：」「转：」「合：」。",
    "【全书结构总览】必须总结主线、核心爽点循环、人物驱动力、伏笔回收、节奏模型和可复用写法。",
    "只提取原文真实发生的剧情推进，不改写为原创大纲，不补不存在的结局。",
    userInstruction ? `用户补充要求：${userInstruction}` : "用户补充要求：无"
  ].join("\n");
}

function normalizeDisassembleOutput(kind: "lore" | "reverse", bookTitle: string, value: string): string {
  const title = kind === "lore" ? `# 《${bookTitle}》拆书设定提取` : `# 《${bookTitle}》详细剧情发展`;
  const requiredSections = kind === "lore" ? LORE_OUTPUT_SECTIONS : REVERSE_OUTLINE_SECTIONS;
  let text = cleanModelMarkdown(value);
  text = upgradeLegacySectionHeadings(text, requiredSections);
  if (!text.trim()) {
    text = "原文未明确。";
  }

  const lines: string[] = [];
  const bodyWithoutTitle = removeLeadingTitle(text, title);
  lines.push(title);
  lines.push("");

  const missingSections = requiredSections.filter((section) => !hasMarkdownHeading(bodyWithoutTitle, section));
  if (!missingSections.length) {
    lines.push(bodyWithoutTitle.trim());
    return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
  }

  if (requiredSections.some((section) => hasMarkdownHeading(bodyWithoutTitle, section))) {
    lines.push(bodyWithoutTitle.trim());
    for (const section of missingSections) {
      lines.push("");
      lines.push(section);
      lines.push("原文未明确。");
    }
    return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
  }

  for (const section of requiredSections) {
    lines.push(section);
    if (section === requiredSections[0]) {
      lines.push(bodyWithoutTitle.trim());
    } else {
      lines.push("原文未明确。");
    }
    lines.push("");
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

function cleanModelMarkdown(value: string): string {
  let text = String(value || "").trim();
  text = text.replace(/^```(?:markdown|md|text)?\s*/i, "");
  text = text.replace(/\s*```$/i, "");
  return text.trim();
}

function upgradeLegacySectionHeadings(text: string, requiredSections: string[]): string {
  let next = text;
  for (const section of requiredSections) {
    const label = section.replace(/^##\s*/, "");
    next = next.replace(new RegExp(`^【${escapeRegExp(label)}】\\s*$`, "gm"), section);
  }
  return next;
}

function removeLeadingTitle(text: string, title: string): string {
  const lines = text.split(/\r?\n/);
  const first = lines[0]?.trim() || "";
  if (first === title || /^#\s+《.+》(?:拆书设定提取|详细剧情发展)$/.test(first)) {
    return lines.slice(1).join("\n").trim();
  }
  return text.trim();
}

function hasMarkdownHeading(text: string, heading: string): boolean {
  const label = escapeRegExp(heading.trim());
  return new RegExp(`^${label}\\s*$`, "m").test(text);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
