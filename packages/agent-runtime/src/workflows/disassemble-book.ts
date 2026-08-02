import type { AgentRunRequest, AgentRunResponse, ConversationDetail } from "@xiaoshuo/shared";
import { randomUUID } from "node:crypto";
import {
  createDisassembleBook,
  DISASSEMBLE_SOURCE_IMPORT_CHARS,
  type DisassembleBookManifest,
  inferDisassembleBookTitle,
  LEGACY_DISASSEMBLE_LORE_PATH,
  LEGACY_REVERSE_OUTLINE_PATH,
  listDisassembleBooks,
  readDisassembleBookText,
  resolveDisassembleBookForRequest,
  resolveWorkflowSourceText,
  writeDisassembleBookDocument,
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
    try {
      return await runFullDisassemble(request, context);
    } catch (error) {
      const book = await resolveDisassembleBookForRequest(request, context).catch(() => null);
      if (book && !book.legacy && book.dir) {
        await writeDisassembleBookManifest({
          ...book,
          status: "failed",
          error: error instanceof Error ? error.message : String(error)
        }, context, { writeKey: "book.manifest.failed" }).catch(() => null);
      }
      throw error;
    }
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
  const completed = new Map(
    (context.checkpoint?.listCompletedUnits("disassemble_book") || []).map((checkpoint) => [checkpoint.unit_id, checkpoint.payload])
  );
  let book = restoreCheckpointBook(completed.get("book"));
  let source = "";

  if (!book) {
    const existingBook = await resolveDisassembleBookForRequest(request, context);
    const directSource = await resolveWorkflowSourceText(request, context);
    source = directSource.trim() || (existingBook ? await readDisassembleBookText(existingBook, "source", context) : "");
    if (!source.trim()) {
      throw new Error("拆书需要上传文件、来源文件或直接输入文本");
    }
    book = existingBook && !existingBook.legacy
      ? await writeDisassembleBookManifest({ ...existingBook, status: "analyzing", error: "" }, context, { writeKey: "book.manifest.analyzing" })
      : await createDisassembleBook(
        {
          title: String((request as any).book_title || existingBook?.title || "").trim() || (await inferDisassembleBookTitle(request, source)),
          sourceText: source,
          sourcePath: existingBook?.source_path || request.current_path || "",
          origin: request.attachment_ids?.length ? "upload" : request.current_path ? "document" : existingBook?.origin || "input"
        },
        context
      );
    if (book.status !== "analyzing") {
      book = await writeDisassembleBookManifest({ ...book, status: "analyzing", error: "" }, context, { writeKey: "book.manifest.analyzing" });
    }
    context.checkpoint?.completeUnit({
      workflow_id: "disassemble_book",
      unit_id: "book",
      payload: { book }
    });
  }
  throwIfAborted(context.signal);

  let lore = restoreDisassembleOutput(completed.get("lore"));
  if (lore) {
    book = lore.book;
  } else {
    source = source || await readDisassembleBookText(book, "source", context);
    if (!source.trim()) {
      throw new Error("拆书需要上传文件、来源文件或直接输入文本");
    }
    const lorePath = `${book.dir}/拆书设定提取.txt`;
    const loreResult = await context.skillRunner.runSkill("lore_extract", {
      text: source,
      chapter: 0,
      end_chapter: 0,
      target_words: 2500,
      instruction: buildLoreInstruction(book.title || "当前拆书书籍", request),
      target_path: "",
      conversation_id: request.conversation_id || "",
      source_path: "",
      write_result: false,
      attachment_ids: []
    }, { signal: context.signal });
    throwIfAborted(context.signal);
    const text = normalizeDisassembleOutput("lore", book.title || "当前拆书书籍", loreResult.result || "");
    await writeDisassembleBookDocument(lorePath, text, "拆书写入设定", context, {
      writeKey: "lore.output"
    });
    book = await writeDisassembleBookManifest({
      ...book,
      paths: { ...book.paths, lore: lorePath }
    }, context, { writeKey: "book.manifest.lore" });
    lore = { book, path: lorePath, legacy_path: LEGACY_DISASSEMBLE_LORE_PATH };
    context.checkpoint?.completeUnit({
      workflow_id: "disassemble_book",
      unit_id: "lore",
      payload: lore
    });
  }

  let reverseOutline = restoreDisassembleOutput(completed.get("reverse_outline"));
  if (reverseOutline) {
    book = reverseOutline.book;
  } else {
    source = source || await readDisassembleBookText(book, "source", context);
    if (!source.trim()) {
      throw new Error("拆书需要上传文件、来源文件或直接输入文本");
    }
    const reversePath = `${book.dir}/反向细纲.txt`;
    const reverseResult = await context.skillRunner.runSkill("reverse_outline_extract", {
      text: source,
      chapter: 0,
      end_chapter: 0,
      target_words: 2500,
      instruction: buildReverseOutlineInstruction(book.title || "当前拆书书籍", request),
      target_path: "",
      conversation_id: request.conversation_id || "",
      source_path: "",
      write_result: false,
      attachment_ids: []
    }, { signal: context.signal });
    throwIfAborted(context.signal);
    const text = normalizeDisassembleOutput("reverse", book.title || "当前拆书书籍", reverseResult.result || "");
    await writeDisassembleBookDocument(reversePath, text, "拆书写入反向细纲", context, {
      writeKey: "reverse_outline.output"
    });
    book = await writeDisassembleBookManifest({
      ...book,
      paths: { ...book.paths, reverse_outline: reversePath }
    }, context, { writeKey: "book.manifest.reverse_outline" });
    reverseOutline = { book, path: reversePath, legacy_path: LEGACY_REVERSE_OUTLINE_PATH };
    context.checkpoint?.completeUnit({
      workflow_id: "disassemble_book",
      unit_id: "reverse_outline",
      payload: reverseOutline
    });
  }

  const lorePath = lore.path;
  const reversePath = reverseOutline.path;
  const reportPath = `${reverseOutline.book.dir}/拆书报告.md`;
  const loreText = await readDisassembleBookText(reverseOutline.book, "lore", context, 80_000);
  const reverseText = await readDisassembleBookText(reverseOutline.book, "reverse_outline", context, 120_000);
  await writeDisassembleBookDocument(
    reportPath,
    buildDisassemblyReport(reverseOutline.book, loreText, reverseText),
    "生成正式拆书报告",
    context,
    { writeKey: "report.output" }
  );
  const updatedBook = await writeDisassembleBookManifest({
    ...reverseOutline.book,
    status: "ready",
    error: "",
    paths: { ...reverseOutline.book.paths, report: reportPath }
  }, context, { writeKey: "book.manifest.ready" });

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
        report_path: reportPath,
        book: updatedBook,
        legacy_saved_paths: []
      }
    },
    saved_paths: savedPaths,
    requires_confirmation: false
  };
}

type DisassembleOutputCheckpoint = {
  book: DisassembleBookManifest;
  path: string;
  legacy_path: string;
};

function restoreCheckpointBook(value: unknown): DisassembleBookManifest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return restoreDisassembleBook((value as Record<string, unknown>).book);
}

function restoreDisassembleOutput(value: unknown): DisassembleOutputCheckpoint | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const source = value as Record<string, unknown>;
  const book = restoreDisassembleBook(source.book);
  const outputPath = String(source.path || "").trim();
  const legacyPath = String(source.legacy_path || "").trim();
  if (!book || !outputPath || !legacyPath) {
    return null;
  }
  return { book, path: outputPath, legacy_path: legacyPath };
}

function restoreDisassembleBook(value: unknown): DisassembleBookManifest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const source = value as Record<string, unknown>;
  const id = String(source.id || "").trim();
  const title = String(source.title || "").trim();
  const dir = String(source.dir || "").trim();
  if (!id || !title || !dir) {
    return null;
  }
  const paths = source.paths && typeof source.paths === "object" && !Array.isArray(source.paths)
    ? source.paths as Record<string, unknown>
    : {};
  return {
    schema_version: Number(source.schema_version || 1),
    template_version: String(source.template_version || "1"),
    id,
    title,
    dir,
    created_at: String(source.created_at || "").trim(),
    updated_at: String(source.updated_at || "").trim(),
    origin: String(source.origin || "").trim(),
    source_path: String(source.source_path || "").trim(),
    source_summary: String(source.source_summary || "").trim(),
    source_hash: String(source.source_hash || "").trim(),
    chars: Number.isFinite(Number(source.chars)) ? Math.max(0, Math.trunc(Number(source.chars))) : 0,
    status: ["imported", "analyzing", "ready", "failed", "stale"].includes(String(source.status || ""))
      ? source.status as DisassembleBookManifest["status"]
      : "imported",
    analysis_version: Number.isFinite(Number(source.analysis_version)) ? Math.max(1, Math.trunc(Number(source.analysis_version))) : 1,
    error: String(source.error || "").trim(),
    analyzed_at: String(source.analyzed_at || "").trim(),
    source: source.source && typeof source.source === "object" && !Array.isArray(source.source)
      ? source.source as DisassembleBookManifest["source"]
      : { path: String(source.source_path || ""), hash: String(source.source_hash || ""), chars: Number(source.chars || 0), chapter_count: 0, import_complete: Boolean(paths.source) },
    progress: source.progress && typeof source.progress === "object" && !Array.isArray(source.progress)
      ? source.progress as DisassembleBookManifest["progress"]
      : { stage: String(source.status || "imported"), completed_chapters: 0, total_chapters: 0, last_error: String(source.error || "") },
    coverage: source.coverage && typeof source.coverage === "object" && !Array.isArray(source.coverage)
      ? source.coverage as DisassembleBookManifest["coverage"]
      : { first_chapter: 0, last_chapter: 0, analyzed_chapters: [], missing_chapters: [] },
    paths: {
      source: String(paths.source || "").trim(),
      lore: String(paths.lore || "").trim(),
      reverse_outline: String(paths.reverse_outline || "").trim(),
      detail_outline: String(paths.detail_outline || "").trim(),
      report: String(paths.report || "").trim(),
      chapter_index: String(paths.chapter_index || "").trim(),
      evidence_index: String(paths.evidence_index || "").trim()
    }
  };
}

function buildDisassemblyReport(book: DisassembleBookManifest, lore: string, reverseOutline: string): string {
  const sourceMeta = [
    `> 拆解范围：已归档原文，原文字数 ${book.chars}；生成时间：${new Date().toISOString()}；模板版本：1；覆盖率：以原文可识别章节为准。`,
    "> 报告由设定提取、反向细纲和原文元数据合成；未识别内容标记为“原文未明确”。"
  ].join("\n");
  return [
    `# 《${book.title}》剧情拆解与大事件`,
    "",
    sourceMeta,
    "",
    "## 核心设定速览",
    "### 主角与初始身份",
    extractReportSection(lore, "人物设定"),
    "",
    "### 核心前提 / 金手指",
    extractReportSection(lore, "体系设定"),
    "",
    "### 世界与规则",
    extractReportSection(lore, "地图设定"),
    "",
    "### 核心爽点循环",
    extractReportSection(reverseOutline, "全书结构总览"),
    "",
    "## 逐章速览",
    extractReportSection(reverseOutline, "逐章速览"),
    "",
    "## 黄金三章与前十章",
    "### 黄金三章拆解",
    "依据逐章速览和大事件拆解提取开局承诺、首次冲突与第一轮反馈；原文未明确。",
    "",
    "### 前十章阶段推进",
    "依据逐章速览提取前十章的目标、升级、兑现和章末钩子；原文未明确。",
    "",
    "### 开篇钩子、兑现与章末悬念",
    "请结合上方逐章速览复核；原文未明确。",
    "",
    "## 大事件起承转合",
    "## 大事件拆解",
    extractReportSection(reverseOutline, "大事件拆解"),
    "",
    "## 可复用创作模板",
    "### 金手指公式\n原文未明确。\n\n### 主角公式\n原文未明确。\n\n### 单元事件节奏\n依据大事件拆解迁移，禁止复写原文。\n\n### 升级阶梯\n原文未明确。\n\n### 角色配置\n原文未明确。\n\n### 爽点公式\n原文未明确。\n\n### 避坑清单\n不得照抄专有名词、句式、固定关系或可识别桥段。",
    "",
    "## 主角成长弧",
    "### 一句话成长弧\n原文未明确。\n\n### 明线 / 暗线推进\n" + extractReportSection(reverseOutline, "全书结构总览"),
    "",
    "### 核心张力\n原文未明确。\n\n### 未完成弧线\n原文未明确。",
    "",
    "## 证据与缺口",
    `- 已覆盖章节：按原文可识别章节生成；原文长度 ${book.chars}。`,
    "- 未识别或未分析章节：原文未明确。",
    "- 关键结论证据位置：见设定提取与逐章速览的章节标注。",
    "",
    "## 来源信息",
    `- 原文文件：${book.source_path || book.paths.source || "拆书库/原文.txt"}`,
    `- 原文哈希：${book.source_hash || "旧数据未记录"}`,
    "- 拆解模板版本：1",
    "",
    "<!-- 机器分析原料：全书结构总览 -->",
    extractReportSection(reverseOutline, "全书结构总览"),
    ""
  ].join("\n");
}

function extractReportSection(markdown: string, title: string): string {
  const escaped = escapeRegExp(title);
  const match = new RegExp(`^##\\s+${escaped}\\s*$([\\s\\S]*?)(?=^##\\s+|$)`, "m").exec(markdown);
  return String(match?.[1] || "原文未明确。").trim();
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
