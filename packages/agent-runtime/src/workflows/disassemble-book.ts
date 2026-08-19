import type { AgentRunRequest, AgentRunResponse, ConversationDetail } from "@xiaoshuo/shared";
import { createHash, randomUUID } from "node:crypto";
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
import { isCancellationError, throwIfAborted } from "../cancellation.js";

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

const DISASSEMBLY_STAGE_TOTAL = 3;

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
      return await runFastDisassemble(request, context);
    } catch (error) {
      const book = await resolveDisassembleBookForRequest(request, context).catch(() => null);
      if (book && !book.legacy && book.dir) {
        const message = error instanceof Error ? error.message : String(error);
        // A provider timeout may surface as AbortError. Only the workflow's
        // own aborted signal represents a user/durable cancel request.
        const cancelled = Boolean(context.signal?.aborted) && isCancellationError(error, context.signal);
        await writeDisassembleBookManifest({
          ...book,
          status: cancelled ? "cancelled" : "failed",
          error: cancelled ? "" : message,
          progress: {
            ...book.progress,
            stage: cancelled ? "cancelled" : book.progress?.stage || "failed",
            last_error: cancelled ? "" : message
          }
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
      origin: request.attachment_ids?.length ? "upload" : request.current_path ? "document" : "input",
      conversationId: request.conversation_id || ""
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

const DISASSEMBLY_PREFIX_CHARS = 200_000;
// Keep every physical model request comfortably below the prompt runner's
// context budget.  The former 20k batches regularly exhausted slower model
// gateways before a first token was returned.
const DISASSEMBLY_BATCH_CHARS = 10_000;
const DISASSEMBLY_DIGEST_CHARS = 15_000;
const DISASSEMBLY_ANALYSIS_VERSION = 2;
// Batch analysis used to call lore_extract with its four-section Markdown
// system prompt. That instruction conflicted with the workflow's JSON
// contract, so the model could return a useful answer in the wrong shape.
const DISASSEMBLY_BATCH_SYSTEM_PROMPT = [
  "你是长篇小说拆书的结构化批次分析器。",
  "只分析给定原文或上游 JSON 中明确出现的事实；不得把它改写成设定集 Markdown，也不得补写后续剧情。",
  "只输出一个 JSON 对象，不要 Markdown、代码块、标题、解释或额外文字。",
  "JSON 必须包含以下键：chapter_range、plot_events、characters、world_rules、items_and_factions、foreshadowing、pacing_style。",
  "chapter_range 是字符串；其余六项必须是数组。没有明确事实时输出空数组，不得输出 null。",
  "plot_events 写因果、冲突和结果；characters 写人物事实与关系变化；world_rules 写世界或体系规则；items_and_factions 写道具、势力与组织；foreshadowing 写伏笔；pacing_style 写节奏与叙事风格。"
].join("\n");

// Version 3 is intentionally a separate, small workflow from the legacy
// 20 万字 pipeline below.  It never invokes a digest, lore, or reverse-outline
// pass: the model only extracts each input batch and the application merges
// those facts deterministically into one report.
const FAST_DISASSEMBLY_PREFIX_CHAPTERS = 100;
const FAST_DISASSEMBLY_BATCH_CHARS = 16_000;
const FAST_DISASSEMBLY_CONCURRENCY = 4;
const FAST_DISASSEMBLY_ANALYSIS_VERSION = 3;
const FAST_DISASSEMBLY_SYSTEM_PROMPT = [
  "你是小说前100章极速拆书的结构化分析器。",
  "只根据给定原文中明确出现的事实分析，不得推测后续剧情，不得把原文改写为原创大纲。",
  "只输出一个 JSON 对象，不要 Markdown、代码块、标题、解释或额外文字。",
  "JSON 必须包含 chapter_summaries、stage_summary、protagonist_arc、major_characters、major_settings。",
  "chapter_summaries 必须覆盖本批指定的每一个章节或段落键；每项使用 {chapter, summary}，summary 为一句中文剧情。",
  "stage_summary 为本批目标、冲突、转折与结果的简要字符串。其余三项必须是数组；没有明确事实时使用空数组，绝不能返回 null。",
  "protagonist_arc 写主角的身份、目标、能力、关系或心理变化；major_characters 写身份、动机、与主角关系和剧情作用；major_settings 写世界规则、能力体系、势力、地点、道具及限制。"
].join("\n");

type DisassemblyBatch = {
  id: string;
  index: number;
  start: number;
  end: number;
  chapterStart: number;
  chapterEnd: number;
  text: string;
};

type DisassemblyBatchCheckpoint = {
  fingerprint: string;
  batch: Pick<DisassemblyBatch, "id" | "index" | "start" | "end" | "chapterStart" | "chapterEnd">;
  result: string;
};

type FastDisassemblyEntry = {
  key: string;
  number: number;
  label: string;
  start: number;
  end: number;
  synthetic: boolean;
};

type FastDisassemblyBatch = {
  id: string;
  index: number;
  start: number;
  end: number;
  firstLabel: string;
  lastLabel: string;
  entryKeys: string[];
  text: string;
};

type FastDisassemblyBatchResult = {
  chapter_summaries: Array<{ chapter: string; summary: string }>;
  stage_summary: string;
  protagonist_arc: string[];
  major_characters: string[];
  major_settings: string[];
};

type FastDisassemblyBatchCheckpoint = {
  fingerprint: string;
  batch: Pick<FastDisassemblyBatch, "id" | "index" | "start" | "end" | "firstLabel" | "lastLabel" | "entryKeys">;
  result: FastDisassemblyBatchResult;
};

async function runFastDisassemble(request: AgentRunRequest, context: WorkflowRunContext): Promise<AgentRunResponse> {
  throwIfAborted(context.signal);
  const completed = new Map(
    (context.checkpoint?.listCompletedUnits("disassemble_book") || []).map((checkpoint) => [checkpoint.unit_id, checkpoint.payload])
  );
  let book = restoreCheckpointBook(completed.get("book"));
  let source = "";

  reportDisassemblyProgress(context, "preparing", "正在读取拆书原文并确定前100章范围…", 0, 1);
  if (!book) {
    const existingBook = await resolveDisassembleBookForRequest(request, context);
    const directSource = await resolveWorkflowSourceText(request, context);
    source = directSource.trim() || (existingBook ? await readDisassembleBookText(existingBook, "source", context) : "");
    if (!source.trim()) throw new Error("拆书需要上传文件、来源文件或直接输入文本");
    book = existingBook && !existingBook.legacy
      ? await writeDisassembleBookManifest({
        ...existingBook,
        conversation_id: existingBook.conversation_id || request.conversation_id || "",
        status: "analyzing",
        error: "",
        progress: disassemblyProgress("preparing", 0)
      }, context, { writeKey: "book.manifest.fast.analyzing" })
      : await createDisassembleBook({
        title: String((request as any).book_title || existingBook?.title || "").trim() || (await inferDisassembleBookTitle(request, source)),
        sourceText: source,
        sourcePath: existingBook?.source_path || request.current_path || "",
        origin: request.attachment_ids?.length ? "upload" : request.current_path ? "document" : existingBook?.origin || "input",
        conversationId: request.conversation_id || ""
      }, context);
    context.checkpoint?.completeUnit({ workflow_id: "disassemble_book", unit_id: "book", payload: { book } });
  }

  if (!book) throw new Error("未能恢复拆书书籍记录");
  source = source || await readDisassembleBookText(book, "source", context);
  if (!source.trim()) throw new Error("拆书原文为空，无法继续分析");
  const sourceHash = createHash("sha256").update(source, "utf8").digest("hex");
  if (book.source_hash && book.source_hash !== sourceHash) {
    book = await writeDisassembleBookManifest({
      ...book,
      status: "stale",
      error: "拆书原文已变化，旧批次检查点不能继续使用，请重新拆解。",
      progress: { ...book.progress, stage: "stale", message: "原文已变化，需要重新拆解", last_error: "拆书原文已变化，旧批次检查点不能继续使用。" }
    }, context, { writeKey: "book.manifest.fast.stale" });
    throw new Error("拆书原文已变化，旧批次检查点不能继续使用，请重新拆解。");
  }

  let activeBook: DisassembleBookManifest = book;
  const plan = await buildFastDisassemblyPlan(activeBook, source, context);
  const fingerprint = buildFastDisassemblyPlanFingerprint(sourceHash, plan);
  const restored = new Map<string, FastDisassemblyBatchResult>();
  for (const batch of plan.batches) {
    const checkpoint = restoreFastBatchCheckpoint(completed.get(`fast-batch:${batch.id}`), fingerprint, batch);
    if (checkpoint) restored.set(batch.id, checkpoint.result);
  }
  const batchTotal = plan.batches.length;
  let completedBatches = restored.size;
  let completedEntries = countCompletedFastEntries(plan, restored);
  activeBook = await writeDisassembleBookManifest({
    ...activeBook,
    analysis_version: FAST_DISASSEMBLY_ANALYSIS_VERSION,
    analysis_fingerprint: fingerprint,
    analysis_batch_chars: FAST_DISASSEMBLY_BATCH_CHARS,
    status: "analyzing",
    error: "",
    analysis_scope: plan.scope,
    coverage: {
      first_chapter: plan.scope.first_chapter,
      last_chapter: plan.scope.last_chapter,
      analyzed_chapters: plan.entries.filter((entry) => !entry.synthetic).map((entry) => entry.number),
      missing_chapters: []
    },
    progress: {
      stage: "batching",
      completed_chapters: completedEntries,
      total_chapters: plan.entries.length,
      completed_batches: completedBatches,
      total_batches: batchTotal,
      message: `已确定拆解前${FAST_DISASSEMBLY_PREFIX_CHAPTERS}章（实际 ${plan.entries.length} ${plan.synthetic ? "段" : "章"}）`,
      last_error: ""
    }
  }, context, { writeKey: "book.manifest.fast.scope" });

  const missing = plan.batches.filter((batch) => !restored.has(batch.id));
  if (restored.size) {
    reportDisassemblyProgress(context, "batch", `已恢复 ${restored.size}/${batchTotal} 批检查点，正在继续缺失批次…`, restored.size, batchTotal);
  }

  // Manifest writes are serialized while model requests stay parallel.  This
  // prevents concurrent completions from overwriting a newer progress count.
  let manifestQueue = Promise.resolve();
  const onCompleted = async (batch: FastDisassemblyBatch, result: FastDisassemblyBatchResult) => {
    restored.set(batch.id, result);
    context.checkpoint?.completeUnit({
      workflow_id: "disassemble_book",
      unit_id: `fast-batch:${batch.id}`,
      payload: { fingerprint, batch: fastBatchCheckpointShape(batch), result }
    });
    completedBatches += 1;
    completedEntries = countCompletedFastEntries(plan, restored);
    const message = `已完成 ${completedBatches}/${batchTotal} 批，覆盖 ${batch.firstLabel}-${batch.lastLabel}`;
    reportDisassemblyProgress(context, "batch", message, completedBatches, batchTotal);
    manifestQueue = manifestQueue.then(async () => {
      activeBook = await writeDisassembleBookManifest({
        ...activeBook,
        progress: {
          ...activeBook.progress,
          stage: "batching",
          completed_chapters: completedEntries,
          total_chapters: plan.entries.length,
          completed_batches: completedBatches,
          total_batches: batchTotal,
          message,
          last_error: ""
        }
      }, context, { writeKey: `book.manifest.fast.batch.${batch.id}` });
    });
    await manifestQueue;
  };

  try {
    await runFastBatchesWithConcurrency(missing, FAST_DISASSEMBLY_CONCURRENCY, async (batch) => {
      throwIfAborted(context.signal);
      reportDisassemblyProgress(context, "batch", `正在拆解第 ${batch.index}/${batchTotal} 批（${batch.firstLabel}-${batch.lastLabel}）`, completedBatches, batchTotal);
      const result = await generateFastBatchWithRetry(activeBook.title, batch, request, context, batchTotal);
      throwIfAborted(context.signal);
      await onCompleted(batch, result);
    });
    await manifestQueue;
  } catch (error) {
    await manifestQueue.catch(() => undefined);
    const cancelled = Boolean(context.signal?.aborted) && isCancellationError(error, context.signal);
    await writeDisassembleBookManifest({
      ...activeBook,
      status: cancelled ? "cancelled" : "failed",
      error: cancelled ? "" : (error instanceof Error ? error.message : String(error)),
      progress: {
        ...activeBook.progress,
        stage: cancelled ? "cancelled" : "failed",
        completed_chapters: completedEntries,
        total_chapters: plan.entries.length,
        completed_batches: completedBatches,
        total_batches: batchTotal,
        message: cancelled ? "拆书已取消，可从检查点继续" : "拆书批次失败，可从失败批次重试",
        last_error: cancelled ? "" : (error instanceof Error ? error.message : String(error))
      }
    }, context, { writeKey: "book.manifest.fast.failed" }).catch(() => undefined);
    throw error;
  }

  if (restored.size !== batchTotal) throw new Error("拆书批次尚未全部完成，请从失败批次重试。");
  const report = buildFastDisassemblyReport(activeBook, plan, [...restored.entries()].map(([id, result]) => ({ batch: plan.batches.find((item) => item.id === id)!, result })));
  const reportPath = `${activeBook.dir}/拆书报告.md`;
  reportDisassemblyProgress(context, "report", "正在整理四板块拆书报告…", batchTotal, batchTotal + 1);
  await writeDisassembleBookDocument(reportPath, report, "生成前100章拆书报告", context, { writeKey: "fast.report.output" });
  const updatedBook = await writeDisassembleBookManifest({
    ...activeBook,
    status: "ready",
    error: "",
    analyzed_at: new Date().toISOString(),
    // Historical artefacts stay on disk, but a new fast run exposes only the
    // report as its active analysis result.
    paths: { ...activeBook.paths, lore: "", reverse_outline: "", detail_outline: "", report: reportPath },
    progress: {
      ...activeBook.progress,
      stage: "completed",
      completed_chapters: plan.entries.length,
      total_chapters: plan.entries.length,
      completed_batches: batchTotal,
      total_batches: batchTotal,
      message: `已完成前${FAST_DISASSEMBLY_PREFIX_CHAPTERS}章拆解（实际 ${plan.entries.length}${plan.synthetic ? "段" : "章"}）`,
      last_error: ""
    }
  }, context, { writeKey: "book.manifest.fast.ready" });
  reportDisassemblyProgress(context, "completed", updatedBook.progress.message || "拆书完成", batchTotal + 1, batchTotal + 1);
  const reply = `已完成前${FAST_DISASSEMBLY_PREFIX_CHAPTERS}章极速拆书，已自动保存：\n${reportPath}`;
  return {
    intent: "skill",
    reply,
    conversation: await recordSkillExchange(request, reply, context),
    results: [],
    skill_result: {
      status: "done",
      result: "",
      saved_path: reportPath,
      data: { skill_id: "disassemble_book", saved_paths: [reportPath], report_path: reportPath, book: updatedBook, legacy_saved_paths: [] }
    },
    saved_paths: [reportPath],
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

  reportDisassemblyProgress(context, "preparing", "正在读取拆书原文并确定前20万字范围…", 0, 1);
  if (!book) {
    const existingBook = await resolveDisassembleBookForRequest(request, context);
    const directSource = await resolveWorkflowSourceText(request, context);
    source = directSource.trim() || (existingBook ? await readDisassembleBookText(existingBook, "source", context) : "");
    if (!source.trim()) throw new Error("拆书需要上传文件、来源文件或直接输入文本");
    book = existingBook && !existingBook.legacy
      ? await writeDisassembleBookManifest({
        ...existingBook,
        conversation_id: existingBook.conversation_id || request.conversation_id || "",
        status: "analyzing",
        error: "",
        progress: disassemblyProgress("preparing", 0)
      }, context, { writeKey: "book.manifest.analyzing" })
      : await createDisassembleBook({
        title: String((request as any).book_title || existingBook?.title || "").trim() || (await inferDisassembleBookTitle(request, source)),
        sourceText: source,
        sourcePath: existingBook?.source_path || request.current_path || "",
        origin: request.attachment_ids?.length ? "upload" : request.current_path ? "document" : existingBook?.origin || "input",
        conversationId: request.conversation_id || ""
      }, context);
    context.checkpoint?.completeUnit({ workflow_id: "disassemble_book", unit_id: "book", payload: { book } });
  }

  source = source || await readDisassembleBookText(book, "source", context);
  if (!source.trim()) throw new Error("拆书原文为空，无法继续分析");
  const sourceHash = createHash("sha256").update(source, "utf8").digest("hex");
  if (book.source_hash && book.source_hash !== sourceHash) {
    book = await writeDisassembleBookManifest({
      ...book,
      status: "stale",
      error: "拆书原文已变化，旧批次检查点不能继续使用，请重新拆解。",
      progress: {
        ...book.progress,
        stage: "stale",
        message: "原文已变化，需要重新拆解",
        last_error: "拆书原文已变化，旧批次检查点不能继续使用。"
      }
    }, context, { writeKey: "book.manifest.stale" });
    throw new Error("拆书原文已变化，旧批次检查点不能继续使用，请重新拆解。");
  }
  const plan = await buildDisassemblyBatchPlan(book, source, context);
  const planFingerprint = buildDisassemblyPlanFingerprint(sourceHash, plan);
  const totalStages = plan.batches.length + 3;
  book = await writeDisassembleBookManifest({
    ...book,
    analysis_version: DISASSEMBLY_ANALYSIS_VERSION,
    analysis_fingerprint: planFingerprint,
    analysis_batch_chars: DISASSEMBLY_BATCH_CHARS,
    status: "analyzing",
    error: "",
    analysis_scope: plan.scope,
    coverage: {
      first_chapter: plan.scope.first_chapter,
      last_chapter: plan.scope.last_chapter,
      analyzed_chapters: plan.chapterNumbers,
      missing_chapters: []
    },
    progress: {
      stage: "batching",
      completed_chapters: 0,
      total_chapters: plan.chapterNumbers.length,
      completed_batches: 0,
      total_batches: plan.batches.length,
      message: "已确定仅分析前20万字（含跨界完整章）",
      last_error: ""
    }
  }, context, { writeKey: "book.manifest.scope" });

  const batchResults: string[] = [];
  for (const batch of plan.batches) {
    throwIfAborted(context.signal);
    const checkpoint = restoreBatchCheckpoint(completed.get(`batch:${batch.id}`), planFingerprint);
    if (checkpoint) {
      batchResults.push(checkpoint.result);
      reportDisassemblyProgress(context, "batch", `已恢复第 ${batch.index}/${plan.batches.length} 批（第${batch.chapterStart || "段"}-${batch.chapterEnd || "段"}）`, batch.index, totalStages);
      continue;
    }
    reportDisassemblyProgress(context, "batch", `正在拆解第 ${batch.index}/${plan.batches.length} 批（第${batch.chapterStart || "段"}-${batch.chapterEnd || "段"}，仅前20万字范围）`, batch.index, totalStages);
    const result = await generateBatchWithRetry(book.title, batch, request, context, plan.batches.length);
    throwIfAborted(context.signal);
    const batchPath = `${book.dir}/批次分析/第${String(batch.index).padStart(3, "0")}批.md`;
    await writeDisassembleBookDocument(batchPath, result, `拆书第${batch.index}批分析`, context, { writeKey: `batch.${batch.id}.output` });
    context.checkpoint?.completeUnit({
      workflow_id: "disassemble_book",
      unit_id: `batch:${batch.id}`,
      payload: { fingerprint: planFingerprint, batch: batchCheckpointShape(batch), result }
    });
    batchResults.push(result);
    book = await writeDisassembleBookManifest({
      ...book,
      progress: {
        ...book.progress,
        stage: "batching",
        completed_batches: batch.index,
        total_batches: plan.batches.length,
        message: `已完成第 ${batch.index}/${plan.batches.length} 批`,
        last_error: ""
      }
    }, context, { writeKey: `book.manifest.batch.${batch.id}` });
  }

  const digest = await buildHierarchicalDigest({
    book,
    batchResults,
    request,
    context,
    planFingerprint,
    completed
  });
  const lorePath = `${book.dir}/拆书设定提取.txt`;
  const reversePath = `${book.dir}/反向细纲.txt`;
  let lore = restoreDisassembleOutput(completed.get("lore"), planFingerprint);
  if (!lore) {
    reportDisassemblyProgress(context, "lore", `正在汇总设定提取（${plan.batches.length + 1}/${totalStages}）`, plan.batches.length + 1, totalStages);
    const generated = await context.skillRunner.generateRawSkill("lore_extract", {
      text: digest,
      chapter: 0,
      end_chapter: 0,
      target_words: 2500,
      instruction: buildLoreSynthesisInstruction(book.title, request, plan.scope),
      target_path: "",
      conversation_id: request.conversation_id || "",
      source_path: "",
      write_result: false,
      attachment_ids: []
    }, { signal: context.signal });
    const text = normalizeDisassembleOutput("lore", book.title, generated);
    await writeDisassembleBookDocument(lorePath, text, "拆书汇总设定提取", context, { writeKey: "lore.output" });
    book = await writeDisassembleBookManifest({ ...book, paths: { ...book.paths, lore: lorePath } }, context, { writeKey: "book.manifest.lore" });
    lore = { book, path: lorePath, legacy_path: LEGACY_DISASSEMBLE_LORE_PATH };
    context.checkpoint?.completeUnit({ workflow_id: "disassemble_book", unit_id: "lore", payload: { ...lore, fingerprint: planFingerprint } });
  }

  let reverseOutline = restoreDisassembleOutput(completed.get("reverse_outline"), planFingerprint);
  if (!reverseOutline) {
    reportDisassemblyProgress(context, "reverse_outline", `正在汇总反向细纲（${plan.batches.length + 2}/${totalStages}）`, plan.batches.length + 2, totalStages);
    const generated = await context.skillRunner.generateRawSkill("reverse_outline_extract", {
      text: digest,
      chapter: 0,
      end_chapter: 0,
      target_words: 3000,
      instruction: buildReverseSynthesisInstruction(book.title, request, plan.scope),
      target_path: "",
      conversation_id: request.conversation_id || "",
      source_path: "",
      write_result: false,
      attachment_ids: []
    }, { signal: context.signal });
    const text = normalizeDisassembleOutput("reverse", book.title, generated);
    await writeDisassembleBookDocument(reversePath, text, "拆书汇总反向细纲", context, { writeKey: "reverse_outline.output" });
    book = await writeDisassembleBookManifest({ ...book, paths: { ...book.paths, reverse_outline: reversePath } }, context, { writeKey: "book.manifest.reverse_outline" });
    reverseOutline = { book, path: reversePath, legacy_path: LEGACY_REVERSE_OUTLINE_PATH };
    context.checkpoint?.completeUnit({ workflow_id: "disassemble_book", unit_id: "reverse_outline", payload: { ...reverseOutline, fingerprint: planFingerprint } });
  }

  const reportPath = `${book.dir}/拆书报告.md`;
  reportDisassemblyProgress(context, "report", `正在生成拆书报告（${totalStages}/${totalStages}）`, totalStages, totalStages);
  const loreText = await readDisassembleBookText(book, "lore", context, 80_000);
  const reverseText = await readDisassembleBookText(book, "reverse_outline", context, 120_000);
  await writeDisassembleBookDocument(reportPath, buildDisassemblyReport(book, loreText, reverseText), "生成正式拆书报告", context, { writeKey: "report.output" });
  const updatedBook = await writeDisassembleBookManifest({
    ...book,
    status: "ready",
    error: "",
    analyzed_at: new Date().toISOString(),
    paths: { ...book.paths, lore: lore.path, reverse_outline: reverseOutline.path, report: reportPath },
    progress: {
      ...book.progress,
      stage: "completed",
      completed_batches: plan.batches.length,
      total_batches: plan.batches.length,
      message: "已完成前20万字拆解（含跨界完整章）",
      last_error: ""
    }
  }, context, { writeKey: "book.manifest.ready" });
  reportDisassemblyProgress(context, "completed", "已完成前20万字拆解（含跨界完整章）", totalStages, totalStages);
  const savedPaths = [lore.path, reverseOutline.path, reportPath];
  const reply = `已完成前20万字拆解（含跨界完整章），已写入：\n${savedPaths.join("\n")}`;
  return {
    intent: "skill",
    reply,
    conversation: await recordSkillExchange(request, reply, context),
    results: [],
    skill_result: {
      status: "done",
      result: "",
      saved_path: savedPaths[0] || "",
      data: { skill_id: "disassemble_book", saved_paths: savedPaths, lore_path: lore.path, outline_path: reverseOutline.path, report_path: reportPath, book: updatedBook, legacy_saved_paths: [] }
    },
    saved_paths: savedPaths,
    requires_confirmation: false
  };
}

async function runLegacyDisassemble(request: AgentRunRequest, context: WorkflowRunContext): Promise<AgentRunResponse> {
  throwIfAborted(context.signal);
  reportDisassemblyProgress(context, "preparing", "正在读取并校验拆书原文（0/3）", 0);
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
      ? await writeDisassembleBookManifest({
        ...existingBook,
        conversation_id: existingBook.conversation_id || request.conversation_id || "",
        status: "analyzing",
        error: "",
        progress: disassemblyProgress("preparing", 0)
      }, context, { writeKey: "book.manifest.analyzing" })
      : await createDisassembleBook(
        {
          title: String((request as any).book_title || existingBook?.title || "").trim() || (await inferDisassembleBookTitle(request, source)),
          sourceText: source,
          sourcePath: existingBook?.source_path || request.current_path || "",
          origin: request.attachment_ids?.length ? "upload" : request.current_path ? "document" : existingBook?.origin || "input",
          conversationId: request.conversation_id || ""
        },
        context
      );
    if (book.status !== "analyzing") {
      book = await writeDisassembleBookManifest({ ...book, status: "analyzing", error: "", progress: disassemblyProgress("preparing", 0) }, context, { writeKey: "book.manifest.analyzing" });
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
    reportDisassemblyProgress(context, "lore", "已恢复设定提取结果（1/3）", 1);
  } else {
    reportDisassemblyProgress(context, "lore", "正在提取人物、设定与伏笔（0/3）", 0);
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
      paths: { ...book.paths, lore: lorePath },
      progress: disassemblyProgress("lore", 1)
    }, context, { writeKey: "book.manifest.lore" });
    lore = { book, path: lorePath, legacy_path: LEGACY_DISASSEMBLE_LORE_PATH };
    context.checkpoint?.completeUnit({
      workflow_id: "disassemble_book",
      unit_id: "lore",
      payload: lore
    });
    reportDisassemblyProgress(context, "lore", "已完成设定提取（1/3）", 1);
  }

  let reverseOutline = restoreDisassembleOutput(completed.get("reverse_outline"));
  if (reverseOutline) {
    book = reverseOutline.book;
    reportDisassemblyProgress(context, "reverse_outline", "已恢复反向细纲结果（2/3）", 2);
  } else {
    reportDisassemblyProgress(context, "reverse_outline", "正在生成反向细纲与结构节奏（1/3）", 1);
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
      paths: { ...book.paths, reverse_outline: reversePath },
      progress: disassemblyProgress("reverse_outline", 2)
    }, context, { writeKey: "book.manifest.reverse_outline" });
    reverseOutline = { book, path: reversePath, legacy_path: LEGACY_REVERSE_OUTLINE_PATH };
    context.checkpoint?.completeUnit({
      workflow_id: "disassemble_book",
      unit_id: "reverse_outline",
      payload: reverseOutline
    });
    reportDisassemblyProgress(context, "reverse_outline", "已完成反向细纲（2/3）", 2);
  }

  const lorePath = lore.path;
  const reversePath = reverseOutline.path;
  const reportPath = `${reverseOutline.book.dir}/拆书报告.md`;
  reportDisassemblyProgress(context, "report", "正在整理拆书报告（2/3）", 2);
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
    paths: { ...reverseOutline.book.paths, report: reportPath },
    progress: disassemblyProgress("completed", DISASSEMBLY_STAGE_TOTAL)
  }, context, { writeKey: "book.manifest.ready" });
  reportDisassemblyProgress(context, "completed", "拆书报告已完成（3/3）", DISASSEMBLY_STAGE_TOTAL);

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

async function buildFastDisassemblyPlan(
  book: DisassembleBookManifest,
  source: string,
  context: WorkflowRunContext
): Promise<{
  entries: FastDisassemblyEntry[];
  batches: FastDisassemblyBatch[];
  scope: NonNullable<DisassembleBookManifest["analysis_scope"]>;
  synthetic: boolean;
}> {
  const segments = await readAnalysisSegments(book, source, context);
  if (!segments.length) throw new Error("未找到可分析的拆书内容");
  const hasChapterTitles = segments.some((segment) => segment.recognized || segment.chapter > 0);
  const selected = segments.slice(0, FAST_DISASSEMBLY_PREFIX_CHAPTERS);
  const entries = selected.map((segment, index): FastDisassemblyEntry => {
    const number = hasChapterTitles ? Math.max(1, segment.chapter || index + 1) : index + 1;
    return {
      key: `${hasChapterTitles ? "chapter" : "segment"}:${index + 1}`,
      number,
      label: hasChapterTitles ? (segment.title || `第${number}章`) : `第${number}段`,
      start: segment.start,
      end: segment.end,
      synthetic: !hasChapterTitles
    };
  });
  const batches = batchFastEntries(source, entries);
  if (!batches.length) throw new Error("前100章范围内没有可分析的文本");
  const first = entries[0]!;
  const last = entries.at(-1)!;
  return {
    entries,
    batches,
    synthetic: !hasChapterTitles,
    scope: {
      mode: "prefix_chapters",
      requested_chapters: FAST_DISASSEMBLY_PREFIX_CHAPTERS,
      actual_chapters: entries.length,
      actual_chars: entries.reduce((total, entry) => total + visibleLength(source.slice(entry.start, entry.end)), 0),
      source_chars: visibleLength(source),
      source_chapters: hasChapterTitles ? segments.length : 0,
      first_chapter: first.number,
      last_chapter: last.number,
      truncated: selected.length < segments.length
    }
  };
}

function batchFastEntries(source: string, entries: FastDisassemblyEntry[]): FastDisassemblyBatch[] {
  type Piece = { entry: FastDisassemblyEntry; start: number; end: number };
  const pieces = entries.flatMap((entry): Piece[] => splitFastEntry(source, entry).map((range) => ({ entry, ...range })));
  const batches: FastDisassemblyBatch[] = [];
  let group: Piece[] = [];
  let length = 0;
  const flush = () => {
    if (!group.length) return;
    const first = group[0]!;
    const last = group.at(-1)!;
    const index = batches.length + 1;
    const entryKeys = [...new Set(group.map((piece) => piece.entry.key))];
    batches.push({
      id: `${String(index).padStart(3, "0")}-${first.start}-${last.end}`,
      index,
      start: first.start,
      end: last.end,
      firstLabel: first.entry.label,
      lastLabel: last.entry.label,
      entryKeys,
      text: source.slice(first.start, last.end)
    });
    group = [];
    length = 0;
  };
  for (const piece of pieces) {
    const pieceLength = visibleLength(source.slice(piece.start, piece.end));
    if (group.length && length + pieceLength > FAST_DISASSEMBLY_BATCH_CHARS) flush();
    group.push(piece);
    length += pieceLength;
  }
  flush();
  return batches;
}

function splitFastEntry(source: string, entry: FastDisassemblyEntry): Array<{ start: number; end: number }> {
  const text = source.slice(entry.start, entry.end);
  if (visibleLength(text) <= FAST_DISASSEMBLY_BATCH_CHARS) return [{ start: entry.start, end: entry.end }];
  const paragraphs = [...text.matchAll(/[^\n]+(?:\n|$)/g)];
  if (!paragraphs.length) {
    const pieces: Array<{ start: number; end: number }> = [];
    for (let offset = entry.start; offset < entry.end; offset += FAST_DISASSEMBLY_BATCH_CHARS) {
      pieces.push({ start: offset, end: Math.min(entry.end, offset + FAST_DISASSEMBLY_BATCH_CHARS) });
    }
    return pieces;
  }
  const pieces: Array<{ start: number; end: number }> = [];
  let start = entry.start + (paragraphs[0]?.index || 0);
  let end = start;
  let length = 0;
  for (const paragraph of paragraphs) {
    const paragraphStart = entry.start + (paragraph.index || 0);
    const paragraphEnd = paragraphStart + paragraph[0].length;
    const paragraphLength = visibleLength(paragraph[0]);
    if (length && length + paragraphLength > FAST_DISASSEMBLY_BATCH_CHARS) {
      pieces.push({ start, end });
      start = paragraphStart;
      length = 0;
    }
    if (paragraphLength > FAST_DISASSEMBLY_BATCH_CHARS) {
      for (let offset = paragraphStart; offset < paragraphEnd; offset += FAST_DISASSEMBLY_BATCH_CHARS) {
        pieces.push({ start: offset, end: Math.min(paragraphEnd, offset + FAST_DISASSEMBLY_BATCH_CHARS) });
      }
      start = paragraphEnd;
      end = paragraphEnd;
      length = 0;
      continue;
    }
    end = paragraphEnd;
    length += paragraphLength;
  }
  if (end > start) pieces.push({ start, end });
  return pieces;
}

async function runFastBatchesWithConcurrency<T>(
  items: T[],
  maxConcurrency: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  let cursor = 0;
  let failure: unknown = null;
  const runWorker = async () => {
    while (!failure) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      try {
        await worker(items[index]!);
      } catch (error) {
        failure = error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(maxConcurrency, items.length) }, () => runWorker()));
  if (failure) throw failure;
}

async function generateFastBatchWithRetry(
  bookTitle: string,
  batch: FastDisassemblyBatch,
  request: AgentRunRequest,
  context: WorkflowRunContext,
  batchTotal: number
): Promise<FastDisassemblyBatchResult> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      throwIfAborted(context.signal);
      const raw = await context.skillRunner.generateRawSkill("lore_extract", {
        text: batch.text,
        chapter: 0,
        end_chapter: 0,
        target_words: 1_000,
        instruction: buildFastBatchInstruction(bookTitle, batch, request, batchTotal),
        target_path: "",
        conversation_id: request.conversation_id || "",
        source_path: "",
        write_result: false,
        attachment_ids: []
      }, { signal: context.signal, systemPromptOverride: FAST_DISASSEMBLY_SYSTEM_PROMPT });
      return normalizeFastBatchResult(raw, batch);
    } catch (error) {
      if (context.signal?.aborted || isCancellationError(error, context.signal)) throw error;
      lastError = error;
      if (attempt >= 2) break;
      const waitMs = isTransientDisassemblyError(error) ? 750 : 0;
      context.reportProgress?.({
        stage: "retrying",
        message: `第 ${batch.index}/${batchTotal} 批结果无效或暂时失败，正在快速重试（第2次）…`,
        completed: Math.max(0, batch.index - 1),
        total: batchTotal
      });
      if (waitMs) await waitForRetry(waitMs, context.signal);
    }
  }
  const message = lastError instanceof Error ? lastError.message : String(lastError || "未知错误");
  throw new Error(`拆书第 ${batch.index}/${batchTotal} 批失败：${message}`);
}

function buildFastBatchInstruction(bookTitle: string, batch: FastDisassemblyBatch, request: AgentRunRequest, total: number): string {
  const userInstruction = String((request as any).instruction || request.content || "").trim();
  return [
    `你正在极速拆解《${bookTitle}》前100章中的第 ${batch.index}/${total} 批。`,
    `本批范围：${batch.firstLabel}-${batch.lastLabel}；字符 ${batch.start + 1}-${batch.end}。`,
    `chapter_summaries 必须且只能使用这些 chapter 键：${batch.entryKeys.join("、")}。`,
    "只根据本批原文输出 JSON，不要寒暄、不要 Markdown、不要杜撰。",
    "每个 chapter 键都要有一句剧情 summary；若同一章被分段输入，只概括本段明确发生的内容。",
    "其余字段仅提取本批已出现的事实；没有明确事实用空数组或“原文未明确”。",
    userInstruction ? `用户补充要求：${userInstruction}` : "用户补充要求：无"
  ].join("\n");
}

function normalizeFastBatchResult(value: unknown, batch: FastDisassemblyBatch): FastDisassemblyBatchResult {
  let parsed: unknown = value;
  if (typeof value === "string") {
    const source = value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
    if (!source) throw new Error("模型未返回本批拆解结果");
    try {
      parsed = JSON.parse(extractJsonObject(source));
    } catch {
      throw new Error("模型返回的拆书批次不是有效 JSON");
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("模型返回的拆书批次不是 JSON 对象");
  const record = nestedAnalysisRecord(parsed as Record<string, unknown>);
  const summariesRaw = record.chapter_summaries;
  if (!Array.isArray(summariesRaw)) throw new Error("模型未返回 chapter_summaries");
  const summaries = new Map<string, string>();
  for (const item of summariesRaw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const entry = item as Record<string, unknown>;
    const key = matchFastChapterKey(String(entry.chapter || entry.key || "").trim(), batch.entryKeys);
    const summary = String(entry.summary || entry.plot || entry.text || "").trim().replace(/\s+/g, " ");
    if (key && summary) summaries.set(key, summary);
  }
  const missing = batch.entryKeys.filter((key) => !summaries.has(key));
  if (missing.length) throw new Error(`模型缺少章节摘要：${missing.join("、")}`);
  return {
    chapter_summaries: batch.entryKeys.map((key) => ({ chapter: key, summary: summaries.get(key)! })),
    stage_summary: firstText(record, ["stage_summary", "stageSummary", "阶段总结", "阶段"] ) || "原文未明确",
    protagonist_arc: fastAnalysisItems(record.protagonist_arc ?? record.protagonistArc ?? record["主角成长"]),
    major_characters: fastAnalysisItems(record.major_characters ?? record.majorCharacters ?? record["主要人物"]),
    major_settings: fastAnalysisItems(record.major_settings ?? record.majorSettings ?? record["主要设定"])
  };
}

function matchFastChapterKey(value: string, expected: string[]): string {
  if (expected.includes(value)) return value;
  const match = /(?:chapter|segment|第)?\s*(\d+)/i.exec(value);
  const number = Number(match?.[1] || 0);
  if (!number) return "";
  const kind = /segment|段/.test(value) ? "segment" : "chapter";
  return expected.find((key) => key === `${kind}:${number}`) || expected.find((key) => key.endsWith(`:${number}`)) || "";
}

function fastAnalysisItems(value: unknown): string[] {
  const items = Array.isArray(value) ? value : value == null ? [] : [value];
  return items.map((item) => fastFactText(item)).filter(Boolean);
}

function fastFactText(value: unknown): string {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value).trim();
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const record = value as Record<string, unknown>;
  const parts = Object.entries(record).flatMap(([key, item]) => {
    if (item == null || item === "") return [];
    if (typeof item === "object") return [];
    return [`${key}：${String(item).trim()}`];
  });
  return parts.join("；").trim() || JSON.stringify(record);
}

function restoreFastBatchCheckpoint(value: unknown, fingerprint: string, batch: FastDisassemblyBatch): FastDisassemblyBatchCheckpoint | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  if (String(source.fingerprint || "") !== fingerprint) return null;
  const rawBatch = source.batch && typeof source.batch === "object" && !Array.isArray(source.batch) ? source.batch as Record<string, unknown> : null;
  if (!rawBatch || String(rawBatch.id || "") !== batch.id) return null;
  try {
    const result = normalizeFastBatchResult(source.result, batch);
    return { fingerprint, batch: fastBatchCheckpointShape(batch), result };
  } catch {
    return null;
  }
}

function fastBatchCheckpointShape(batch: FastDisassemblyBatch): FastDisassemblyBatchCheckpoint["batch"] {
  return {
    id: batch.id,
    index: batch.index,
    start: batch.start,
    end: batch.end,
    firstLabel: batch.firstLabel,
    lastLabel: batch.lastLabel,
    entryKeys: batch.entryKeys
  };
}

function countCompletedFastEntries(
  plan: { entries: FastDisassemblyEntry[]; batches: FastDisassemblyBatch[] },
  results: Map<string, FastDisassemblyBatchResult>
): number {
  const keys = new Set<string>();
  for (const result of results.values()) result.chapter_summaries.forEach((item) => keys.add(item.chapter));
  return plan.entries.filter((entry) => keys.has(entry.key)).length;
}

function buildFastDisassemblyPlanFingerprint(
  sourceHash: string,
  plan: { entries: FastDisassemblyEntry[]; batches: FastDisassemblyBatch[]; scope: NonNullable<DisassembleBookManifest["analysis_scope"]> }
): string {
  return createHash("sha256").update(JSON.stringify({
    analysis_version: FAST_DISASSEMBLY_ANALYSIS_VERSION,
    source_hash: sourceHash,
    scope: plan.scope,
    batch_chars: FAST_DISASSEMBLY_BATCH_CHARS,
    batches: plan.batches.map((batch) => [batch.id, batch.start, batch.end, batch.entryKeys])
  }), "utf8").digest("hex");
}

function buildFastDisassemblyReport(
  book: DisassembleBookManifest,
  plan: { entries: FastDisassemblyEntry[]; batches: FastDisassemblyBatch[]; scope: NonNullable<DisassembleBookManifest["analysis_scope"]>; synthetic: boolean },
  batchResults: Array<{ batch: FastDisassemblyBatch; result: FastDisassemblyBatchResult }>
): string {
  const ordered = [...batchResults].sort((left, right) => left.batch.index - right.batch.index);
  const summaries = new Map<string, string[]>();
  for (const { result } of ordered) {
    for (const item of result.chapter_summaries) {
      const current = summaries.get(item.chapter) || [];
      if (!current.includes(item.summary)) current.push(item.summary);
      summaries.set(item.chapter, current);
    }
  }
  const chapterLines = plan.entries.map((entry) => `- ${entry.label}：${(summaries.get(entry.key) || ["原文未明确"]).join("；")}`);
  const stageLines: string[] = [];
  for (let start = 0; start < plan.entries.length; start += 10) {
    const group = plan.entries.slice(start, start + 10);
    const keys = new Set(group.map((entry) => entry.key));
    const stages = uniqueFastFacts(ordered.filter(({ batch }) => batch.entryKeys.some((key) => keys.has(key))).map(({ result }) => result.stage_summary));
    stageLines.push(`### ${group[0]!.label}-${group.at(-1)!.label}阶段总结`);
    stageLines.push(stages.join("；") || "原文未明确。");
    stageLines.push("");
  }
  const protagonist = uniqueFastFacts(ordered.flatMap(({ result }) => result.protagonist_arc));
  const characters = uniqueFastFacts(ordered.flatMap(({ result }) => result.major_characters)).slice(0, 15);
  const settings = uniqueFastFacts(ordered.flatMap(({ result }) => result.major_settings));
  const settingGroups = {
    "世界规则": settings.filter((item) => /世界|规则|社会|背景|限制/.test(item)),
    "能力体系": settings.filter((item) => /能力|体系|修炼|等级|技能|异能/.test(item)),
    "势力": settings.filter((item) => /势力|组织|宗门|家族|公司|军方|学院/.test(item)),
    "地点": settings.filter((item) => /地点|城市|区域|山|域|基地|学校/.test(item)),
    "关键道具": settings.filter((item) => !/世界|规则|社会|背景|限制|能力|体系|修炼|等级|技能|异能|势力|组织|宗门|家族|公司|军方|学院|地点|城市|区域|山|域|基地|学校/.test(item))
  };
  return [
    `# 《${book.title}》拆书报告`,
    "",
    `> 分析范围：${plan.synthetic ? "无章节标题，按顺序段落" : "前100个识别章节"}；实际分析 ${plan.entries.length}${plan.synthetic ? "段" : "章"}（${plan.entries[0]!.label}-${plan.entries.at(-1)!.label}）。`,
    `> 原文字数：${plan.scope.source_chars}；原文哈希：${book.source_hash || "未记录"}；生成时间：${new Date().toISOString()}；分析版本：${FAST_DISASSEMBLY_ANALYSIS_VERSION}。`,
    "",
    "## 前100章剧情",
    ...chapterLines,
    "",
    ...stageLines,
    "## 主角成长弧光",
    ...(protagonist.length ? protagonist.map((item) => `- ${item}`) : ["- 原文未明确。"]),
    "",
    "## 主要角色配置",
    ...(characters.length ? characters.map((item) => `- ${item}`) : ["- 原文未明确。"]),
    "",
    "## 主要设定",
    ...Object.entries(settingGroups).flatMap(([title, items]) => [
      `### ${title}`,
      ...(items.length ? items.map((item) => `- ${item}`) : ["- 原文未明确。"]),
      ""
    ]),
    ""
  ].join("\n");
}

function uniqueFastFacts<T extends string | { result: FastDisassemblyBatchResult }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const value = typeof item === "string" ? item : item.result.stage_summary;
    const key = value.replace(/\s+/g, "").toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function buildDisassemblyBatchPlan(
  book: DisassembleBookManifest,
  source: string,
  context: WorkflowRunContext
): Promise<{ batches: DisassemblyBatch[]; scope: NonNullable<DisassembleBookManifest["analysis_scope"]>; chapterNumbers: number[] }> {
  const chapters = await readAnalysisSegments(book, source, context);
  const selected: Array<{ start: number; end: number; chapter: number }> = [];
  let visibleChars = 0;
  for (const chapter of chapters) {
    selected.push(chapter);
    visibleChars += visibleLength(source.slice(chapter.start, chapter.end));
    if (visibleChars >= DISASSEMBLY_PREFIX_CHARS) break;
  }
  if (!selected.length) throw new Error("未找到可分析的拆书内容");
  const first = selected[0]!;
  const last = selected.at(-1)!;
  const batches = batchSelectedSegments(source, selected);
  if (!batches.length) throw new Error("前20万字范围内没有可分析的文本");
  const chapterNumbers = [...new Set(selected.map((item) => item.chapter).filter((chapter) => chapter > 0))];
  return {
    batches,
    chapterNumbers,
    scope: {
      mode: "prefix_chars",
      requested_chars: DISASSEMBLY_PREFIX_CHARS,
      actual_chars: visibleChars,
      source_chars: visibleLength(source),
      first_chapter: first.chapter,
      last_chapter: last.chapter,
      truncated: last.end < source.length
    }
  };
}

async function readAnalysisSegments(
  book: DisassembleBookManifest,
  source: string,
  context: WorkflowRunContext
): Promise<Array<{ start: number; end: number; chapter: number; title?: string; recognized?: boolean }>> {
  const indexPath = book.paths.chapter_index || `${book.dir}/章节索引.jsonl`;
  const raw = await context.documents.readRawText(indexPath, 2_000_000).catch(() => "");
  const chapters = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).flatMap((line) => {
    try {
      const value = JSON.parse(line) as { index_type?: string; start?: unknown; end?: unknown; chapter?: unknown; title?: unknown };
      const start = Math.max(0, Math.trunc(Number(value.start || 0)));
      const end = Math.min(source.length, Math.max(start, Math.trunc(Number(value.end || 0))));
      if (value.index_type !== "chapter" || end <= start) return [];
      return [{
        start,
        end,
        chapter: Math.max(0, Math.trunc(Number(value.chapter || 0))),
        title: String(value.title || "").trim(),
        recognized: true
      }];
    } catch {
      return [];
    }
  });
  if (chapters.length) return chapters;
  return paragraphSegments(source);
}

function paragraphSegments(source: string): Array<{ start: number; end: number; chapter: number }> {
  const paragraphs = [...source.matchAll(/[^\n]+(?:\n|$)/g)];
  if (!paragraphs.length) return source.trim() ? [{ start: 0, end: source.length, chapter: 0 }] : [];
  const result: Array<{ start: number; end: number; chapter: number }> = [];
  for (const paragraph of paragraphs) {
    const itemStart = paragraph.index || 0;
    const itemEnd = itemStart + paragraph[0].length;
    if (visibleLength(paragraph[0]) <= FAST_DISASSEMBLY_BATCH_CHARS) {
      result.push({ start: itemStart, end: itemEnd, chapter: 0 });
      continue;
    }
    for (let offset = itemStart; offset < itemEnd; offset += FAST_DISASSEMBLY_BATCH_CHARS) {
      result.push({ start: offset, end: Math.min(itemEnd, offset + FAST_DISASSEMBLY_BATCH_CHARS), chapter: 0 });
    }
  }
  return result;
}

function batchSelectedSegments(source: string, selected: Array<{ start: number; end: number; chapter: number }>): DisassemblyBatch[] {
  const pieces: Array<{ start: number; end: number; chapter: number }> = [];
  for (const item of selected) {
    const text = source.slice(item.start, item.end);
    if (visibleLength(text) <= DISASSEMBLY_BATCH_CHARS) {
      pieces.push(item);
      continue;
    }
    pieces.push(...splitLongSegment(source, item));
  }
  const batches: DisassemblyBatch[] = [];
  let group: Array<{ start: number; end: number; chapter: number }> = [];
  let groupLength = 0;
  const flush = () => {
    if (!group.length) return;
    const first = group[0]!;
    const last = group.at(-1)!;
    const index = batches.length + 1;
    batches.push({
      id: `${String(index).padStart(3, "0")}-${first.start}-${last.end}`,
      index,
      start: first.start,
      end: last.end,
      chapterStart: first.chapter,
      chapterEnd: last.chapter,
      text: source.slice(first.start, last.end)
    });
    group = [];
    groupLength = 0;
  };
  for (const piece of pieces) {
    const length = visibleLength(source.slice(piece.start, piece.end));
    if (group.length && groupLength + length > DISASSEMBLY_BATCH_CHARS) flush();
    group.push(piece);
    groupLength += length;
  }
  flush();
  return batches;
}

function splitLongSegment(source: string, item: { start: number; end: number; chapter: number }): Array<{ start: number; end: number; chapter: number }> {
  const text = source.slice(item.start, item.end);
  const paragraphs = [...text.matchAll(/[^\n]+(?:\n|$)/g)];
  if (!paragraphs.length) {
    const pieces: Array<{ start: number; end: number; chapter: number }> = [];
    for (let offset = item.start; offset < item.end; offset += DISASSEMBLY_BATCH_CHARS) {
      pieces.push({ start: offset, end: Math.min(item.end, offset + DISASSEMBLY_BATCH_CHARS), chapter: item.chapter });
    }
    return pieces;
  }
  const pieces: Array<{ start: number; end: number; chapter: number }> = [];
  let start = item.start + (paragraphs[0]?.index || 0);
  let end = start;
  let length = 0;
  for (const paragraph of paragraphs) {
    const paragraphStart = item.start + (paragraph.index || 0);
    const paragraphEnd = paragraphStart + paragraph[0].length;
    const paragraphLength = visibleLength(paragraph[0]);
    if (length && length + paragraphLength > DISASSEMBLY_BATCH_CHARS) {
      pieces.push({ start, end, chapter: item.chapter });
      start = paragraphStart;
      length = 0;
    }
    if (paragraphLength > DISASSEMBLY_BATCH_CHARS && start === paragraphStart) {
      for (let offset = paragraphStart; offset < paragraphEnd; offset += DISASSEMBLY_BATCH_CHARS) {
        pieces.push({ start: offset, end: Math.min(paragraphEnd, offset + DISASSEMBLY_BATCH_CHARS), chapter: item.chapter });
      }
      start = paragraphEnd;
      end = paragraphEnd;
      length = 0;
      continue;
    }
    end = paragraphEnd;
    length += paragraphLength;
  }
  if (end > start) pieces.push({ start, end, chapter: item.chapter });
  return pieces;
}

async function generateBatchWithRetry(
  bookTitle: string,
  batch: DisassemblyBatch,
  request: AgentRunRequest,
  context: WorkflowRunContext,
  batchTotal: number
): Promise<string> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      throwIfAborted(context.signal);
      const result = await context.skillRunner.generateRawSkill("lore_extract", {
        text: batch.text,
        chapter: batch.chapterStart,
        end_chapter: batch.chapterEnd,
        target_words: 1_000,
        instruction: buildBatchInstruction(bookTitle, batch, request, batchTotal),
        target_path: "",
        conversation_id: request.conversation_id || "",
        source_path: "",
        write_result: false,
        attachment_ids: []
      }, { signal: context.signal, systemPromptOverride: DISASSEMBLY_BATCH_SYSTEM_PROMPT });
      return normalizeBatchAnalysis(result, batchChapterRange(batch));
    } catch (error) {
      if (attempt === 3 || !isTransientDisassemblyError(error)) throw error;
      const waitMs = attempt === 1 ? 1_000 : 3_000;
      context.reportProgress?.({
        stage: "retrying",
        message: `第 ${batch.index}/${batchTotal} 批暂时失败，${Math.round(waitMs / 1_000)} 秒后自动重试（第${attempt + 1}次）…`,
        completed: batch.index - 1,
        total: batchTotal + 3
      });
      await waitForRetry(waitMs, context.signal);
    }
  }
  throw new Error("拆书批次重试后仍未完成");
}

type DigestPart = { id: string; result: string };

async function buildHierarchicalDigest(input: {
  book: DisassembleBookManifest;
  batchResults: string[];
  request: AgentRunRequest;
  context: WorkflowRunContext;
  planFingerprint: string;
  completed: Map<string, unknown>;
}): Promise<string> {
  let layer = input.batchResults.map((result, index): DigestPart => ({ id: `batch-${String(index + 1).padStart(3, "0")}`, result }));
  let layerIndex = 0;
  while (serializedDigestLength(layer) > DISASSEMBLY_DIGEST_CHARS) {
    const groups = groupDigestParts(layer);
    const next: DigestPart[] = [];
    for (let index = 0; index < groups.length; index += 1) {
      throwIfAborted(input.context.signal);
      const group = groups[index]!;
      const unitId = `digest:${layerIndex}:${String(index + 1).padStart(3, "0")}`;
      const restored = restoreDigestCheckpoint(input.completed.get(unitId), input.planFingerprint);
      if (restored) {
        next.push(restored);
        continue;
      }
      input.context.reportProgress?.({
        stage: "digest",
        message: `正在归并第 ${layerIndex + 1} 层拆书要点（${index + 1}/${groups.length}）…`,
        completed: input.batchResults.length,
        total: input.batchResults.length + 3
      });
      const raw = await generateDigestWithRetry(input.book.title, group, input.request, input.context, layerIndex, index + 1, groups.length);
      const part: DigestPart = { id: unitId, result: raw };
      input.context.checkpoint?.completeUnit({
        workflow_id: "disassemble_book",
        unit_id: unitId,
        payload: { fingerprint: input.planFingerprint, part }
      });
      next.push(part);
    }
    layer = next;
    layerIndex += 1;
  }
  return serializeDigestParts(layer);
}

function groupDigestParts(parts: DigestPart[]): DigestPart[][] {
  const groups: DigestPart[][] = [];
  let group: DigestPart[] = [];
  let length = 0;
  for (const part of parts) {
    const partLength = part.result.length + part.id.length + 16;
    if (partLength > DISASSEMBLY_DIGEST_CHARS) {
      throw new Error(`拆书批次摘要过长，无法安全汇总：${part.id}`);
    }
    if (group.length && length + partLength > DISASSEMBLY_DIGEST_CHARS) {
      groups.push(group);
      group = [];
      length = 0;
    }
    group.push(part);
    length += partLength;
  }
  if (group.length) groups.push(group);
  return groups;
}

function serializeDigestParts(parts: DigestPart[]): string {
  return parts.map((part) => `## ${part.id}\n${part.result}`).join("\n\n");
}

function serializedDigestLength(parts: DigestPart[]): number {
  return serializeDigestParts(parts).length;
}

async function generateDigestWithRetry(
  bookTitle: string,
  parts: DigestPart[],
  request: AgentRunRequest,
  context: WorkflowRunContext,
  layer: number,
  index: number,
  total: number
): Promise<string> {
  const text = serializeDigestParts(parts);
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      throwIfAborted(context.signal);
      const result = await context.skillRunner.generateRawSkill("lore_extract", {
        text,
        chapter: 0,
        end_chapter: 0,
        target_words: 1_000,
        instruction: buildDigestInstruction(bookTitle, layer, index, total, request),
        target_path: "",
        conversation_id: request.conversation_id || "",
        source_path: "",
        write_result: false,
        attachment_ids: []
      }, { signal: context.signal, systemPromptOverride: DISASSEMBLY_BATCH_SYSTEM_PROMPT });
      return normalizeBatchAnalysis(result, `归并第 ${layer + 1} 层第 ${index}/${total} 组`);
    } catch (error) {
      if (attempt === 3 || !isTransientDisassemblyError(error)) throw error;
      await waitForRetry(attempt === 1 ? 1_000 : 3_000, context.signal);
    }
  }
  throw new Error("拆书归并重试后仍未完成");
}

function buildDigestInstruction(bookTitle: string, layer: number, index: number, total: number, request: AgentRunRequest): string {
  const userInstruction = String((request as any).instruction || request.content || "").trim();
  return [
    `你正在归并《${bookTitle}》拆书第 ${layer + 1} 层、第 ${index}/${total} 组批次结果。`,
    "只根据输入 JSON 输出一个更紧凑的 JSON，不得补充未出现的事实。",
    "JSON 必须包含：chapter_range、plot_events、characters、world_rules、items_and_factions、foreshadowing、pacing_style。",
    "保留章节顺序、因果链、人物关系变化和证据范围，删除重复表述。",
    userInstruction ? `用户补充要求：${userInstruction}` : "用户补充要求：无"
  ].join("\n");
}

function normalizeBatchAnalysis(value: unknown, fallbackChapterRange = ""): string {
  const source = String(value || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  if (!source) throw new Error("模型未返回本批拆解结果");
  const objectText = extractJsonObject(source);
  let parsed: Record<string, unknown>;
  try {
    const value = JSON.parse(objectText) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("JSON 根节点不是对象");
    parsed = value as Record<string, unknown>;
  } catch {
    throw new Error("模型返回的拆书批次不是有效 JSON");
  }
  const record = nestedAnalysisRecord(parsed);
  const chapterRange = firstText(record, ["chapter_range", "chapterRange", "章节范围", "章节", "范围"]) || fallbackChapterRange;
  const plotEvents = normalizedAnalysisItems(record, ["plot_events", "plotEvents", "情节因果", "剧情", "情节", "事件", "plot"]);
  const characters = normalizedAnalysisItems(record, ["characters", "character_relations", "人物关系", "人物", "角色"]);
  const worldRules = normalizedAnalysisItems(record, ["world_rules", "worldRules", "世界设定", "世界观", "规则", "体系"]);
  const itemsAndFactions = normalizedAnalysisItems(record, ["items_and_factions", "itemsAndFactions", "道具势力", "道具", "势力", "组织"]);
  const foreshadowing = normalizedAnalysisItems(record, ["foreshadowing", "伏笔", "悬念"]);
  const pacingStyle = normalizedAnalysisItems(record, ["pacing_style", "pacingStyle", "节奏风格", "节奏", "风格"]);
  const collections = [plotEvents, characters, worldRules, itemsAndFactions, foreshadowing, pacingStyle];
  if (!chapterRange || !collections.some((items) => items.length)) {
    throw new Error("模型未返回可用的拆书分析内容");
  }
  const normalized = JSON.stringify({
    chapter_range: chapterRange,
    plot_events: plotEvents,
    characters,
    world_rules: worldRules,
    items_and_factions: itemsAndFactions,
    foreshadowing,
    pacing_style: pacingStyle
  });
  if (normalized.length > DISASSEMBLY_DIGEST_CHARS) {
    throw new Error("模型返回的拆书批次过长，无法安全汇总");
  }
  return normalized;
}

function batchChapterRange(batch: DisassemblyBatch): string {
  return batch.chapterStart || batch.chapterEnd
    ? `第${batch.chapterStart || batch.chapterEnd}-${batch.chapterEnd || batch.chapterStart}章`
    : `字符 ${batch.start + 1}-${batch.end}`;
}

function nestedAnalysisRecord(value: Record<string, unknown>): Record<string, unknown> {
  for (const key of ["data", "analysis", "result", "output"]) {
    const nested = value[key];
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      return nested as Record<string, unknown>;
    }
  }
  return value;
}

function firstText(record: Record<string, unknown>, aliases: string[]): string {
  for (const alias of aliases) {
    const value = record[alias];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return "";
}

function normalizedAnalysisItems(record: Record<string, unknown>, aliases: string[]): string[] {
  for (const alias of aliases) {
    if (!(alias in record)) continue;
    const items = asAnalysisItems(record[alias]);
    if (items.length) return items;
  }
  return [];
}

function asAnalysisItems(value: unknown): string[] {
  if (typeof value === "string") {
    const text = value.trim();
    return text ? [text] : [];
  }
  if (typeof value === "number" || typeof value === "boolean") return [String(value)];
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item === "string") return item.trim() ? [item.trim()] : [];
    if (typeof item === "number" || typeof item === "boolean") return [String(item)];
    if (!item || typeof item !== "object") return [];
    try {
      return [JSON.stringify(item)];
    } catch {
      return [];
    }
  });
}

function extractJsonObject(value: string): string {
  const start = value.indexOf("{");
  const end = value.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("模型返回的拆书批次不是 JSON 对象");
  return value.slice(start, end + 1);
}

function waitForRetry(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("操作已取消"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("操作已取消"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function buildBatchInstruction(bookTitle: string, batch: DisassemblyBatch, request: AgentRunRequest, total: number): string {
  const userInstruction = String((request as any).instruction || request.content || "").trim();
  return [
    `你正在拆解《${bookTitle}》的第 ${batch.index}/${total} 个原文批次。`,
    `本批原文范围：字符 ${batch.start + 1}-${batch.end}；章节 ${batch.chapterStart || "无章节"}-${batch.chapterEnd || "无章节"}。`,
    "只根据本批原文输出 JSON，不要寒暄、不要 Markdown、不要杜撰。",
    "JSON 必须包含：chapter_range、plot_events、characters、world_rules、items_and_factions、foreshadowing、pacing_style。",
    "plot_events 每项写因果、冲突、结果；characters 写人物事实与关系变化；没有明确事实时用空数组。",
    userInstruction ? `用户补充要求：${userInstruction}` : "用户补充要求：无"
  ].join("\n");
}

function buildLoreSynthesisInstruction(bookTitle: string, request: AgentRunRequest, scope: NonNullable<DisassembleBookManifest["analysis_scope"]>): string {
  return `${buildLoreInstruction(bookTitle, request)}\n\n只可依据下方批次 JSON 汇总。拆解范围仅为前${scope.requested_chars}字（实际${scope.actual_chars}字，含跨界完整章），不要把它称作全书结局。`;
}

function buildReverseSynthesisInstruction(bookTitle: string, request: AgentRunRequest, scope: NonNullable<DisassembleBookManifest["analysis_scope"]>): string {
  return `${buildReverseOutlineInstruction(bookTitle, request)}\n\n只可依据下方批次 JSON 汇总。拆解范围仅为前${scope.requested_chars}字（实际${scope.actual_chars}字，含跨界完整章），不要推断后续未分析情节。`;
}

function restoreBatchCheckpoint(value: unknown, expectedFingerprint: string): DisassemblyBatchCheckpoint | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  if (String(source.fingerprint || "") !== expectedFingerprint) return null;
  const batch = source.batch && typeof source.batch === "object" && !Array.isArray(source.batch) ? source.batch as Record<string, unknown> : null;
  const result = String(source.result || "").trim();
  if (!batch || !result || !String(batch.id || "")) return null;
  return {
    fingerprint: expectedFingerprint,
    batch: {
      id: String(batch.id),
      index: Math.max(1, Number(batch.index || 1)),
      start: Math.max(0, Number(batch.start || 0)),
      end: Math.max(0, Number(batch.end || 0)),
      chapterStart: Math.max(0, Number(batch.chapterStart || 0)),
      chapterEnd: Math.max(0, Number(batch.chapterEnd || 0))
    },
    result
  };
}

function restoreDigestCheckpoint(value: unknown, expectedFingerprint: string): DigestPart | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  if (String(source.fingerprint || "") !== expectedFingerprint) return null;
  const part = source.part && typeof source.part === "object" && !Array.isArray(source.part)
    ? source.part as Record<string, unknown>
    : null;
  const id = String(part?.id || "").trim();
  const result = String(part?.result || "").trim();
  if (!id || !result) return null;
  try {
    return { id, result: normalizeBatchAnalysis(result) };
  } catch {
    return null;
  }
}

function batchCheckpointShape(batch: DisassemblyBatch): DisassemblyBatchCheckpoint["batch"] {
  return { id: batch.id, index: batch.index, start: batch.start, end: batch.end, chapterStart: batch.chapterStart, chapterEnd: batch.chapterEnd };
}

function visibleLength(text: string): number {
  return String(text || "").replace(/\s/g, "").length;
}

function isTransientDisassemblyError(error: unknown): boolean {
  const message = String(error instanceof Error ? error.message : error || "").toLowerCase();
  return /timeout|timed out|超时|gateway|429|5\d\d|网络|network|econnreset|temporar/.test(message);
}

type DisassembleOutputCheckpoint = {
  book: DisassembleBookManifest;
  path: string;
  legacy_path: string;
};

function disassemblyProgress(stage: string, completed: number): DisassembleBookManifest["progress"] {
  return {
    stage,
    completed_chapters: completed,
    total_chapters: DISASSEMBLY_STAGE_TOTAL,
    last_error: ""
  };
}

function reportDisassemblyProgress(
  context: WorkflowRunContext,
  stage: string,
  message: string,
  completed: number,
  total = DISASSEMBLY_STAGE_TOTAL
): void {
  context.reportProgress?.({
    stage,
    message,
    completed,
    total
  });
}

function restoreCheckpointBook(value: unknown): DisassembleBookManifest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return restoreDisassembleBook((value as Record<string, unknown>).book);
}

function restoreDisassembleOutput(value: unknown, expectedFingerprint = ""): DisassembleOutputCheckpoint | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const source = value as Record<string, unknown>;
  if (expectedFingerprint && String(source.fingerprint || "") !== expectedFingerprint) {
    return null;
  }
  const book = restoreDisassembleBook(source.book);
  const outputPath = String(source.path || "").trim();
  const legacyPath = String(source.legacy_path || "").trim();
  if (!book || !outputPath || !legacyPath) {
    return null;
  }
  return { book, path: outputPath, legacy_path: legacyPath };
}

function buildDisassemblyPlanFingerprint(
  sourceHash: string,
  plan: { batches: DisassemblyBatch[]; scope: NonNullable<DisassembleBookManifest["analysis_scope"]> }
): string {
  const value = JSON.stringify({
    analysis_version: DISASSEMBLY_ANALYSIS_VERSION,
    source_hash: sourceHash,
    requested_chars: plan.scope.requested_chars,
    actual_chars: plan.scope.actual_chars,
    batch_chars: DISASSEMBLY_BATCH_CHARS,
    batches: plan.batches.map((batch) => [batch.id, batch.start, batch.end, batch.chapterStart, batch.chapterEnd])
  });
  return createHash("sha256").update(value, "utf8").digest("hex");
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
    conversation_id: String(source.conversation_id || "").trim(),
    chars: Number.isFinite(Number(source.chars)) ? Math.max(0, Math.trunc(Number(source.chars))) : 0,
    status: ["imported", "analyzing", "ready", "failed", "cancelled", "stale"].includes(String(source.status || ""))
      ? source.status as DisassembleBookManifest["status"]
      : "imported",
    analysis_version: Number.isFinite(Number(source.analysis_version)) ? Math.max(1, Math.trunc(Number(source.analysis_version))) : 1,
    analysis_fingerprint: String(source.analysis_fingerprint || "").trim(),
    analysis_batch_chars: Math.max(0, Math.trunc(Number(source.analysis_batch_chars || 0))) || undefined,
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
    analysis_scope: source.analysis_scope && typeof source.analysis_scope === "object" && !Array.isArray(source.analysis_scope)
      ? source.analysis_scope as DisassembleBookManifest["analysis_scope"]
      : undefined,
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
    `> 拆解范围：${book.analysis_scope ? `前${book.analysis_scope.requested_chars}字（实际${book.analysis_scope.actual_chars}字，含跨界完整章）` : "已归档原文"}；原文字数 ${book.chars}；生成时间：${new Date().toISOString()}；模板版本：1。`,
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
    `- 已覆盖章节：${book.analysis_scope?.first_chapter || "起始"}-${book.analysis_scope?.last_chapter || "当前"}；原文长度 ${book.chars}。`,
    book.analysis_scope?.truncated ? "- 未分析后续章节：超出前20万字范围，未纳入本次拆解。" : "- 未识别或未分析章节：原文未明确。",
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
