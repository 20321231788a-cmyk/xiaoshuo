import { loadModelConfig, loadWebSearchConfig, readRawConfig, type ModelConfig } from "@xiaoshuo/config-service";
import { buildProjectContinuityContext } from "@xiaoshuo/project-session";
import type { ChatCompletionMessage } from "@xiaoshuo/model-client";
import type { AgentRunRequest, AgentRunResponse } from "@xiaoshuo/shared";
import { GraphMemory, type CheckGraphDraftConsistencyResult } from "@xiaoshuo/vector-service";
import { randomUUID } from "node:crypto";
import { applyHumanizerIfEnabled } from "../humanizer.js";
import {
  buildBodyChapterSystemPrompt,
  buildBodyChapterUserPrompt,
  buildBodyDeslopUserPrompt,
  buildBodyRevisionSystemPrompt,
  buildBodyRevisionUserPrompt
} from "../prompts/body.js";
import { clipForConsistency } from "../prompts/consistency.js";
import { buildStyleGenreConstraintBlock } from "../style-genre-context.js";
import { formatWebSearchContext, shouldUseWebSearch, summarizeWebSearchSources, type WebSearchSource } from "../web-search.js";
import type { WorkflowHandler, WorkflowRunContext } from "./types.js";
import { isCancellationError, throwIfAborted } from "../cancellation.js";

type BodyConsistencyCheck = {
  score: number;
  risks: string[];
  reason: string;
  graph_score?: number;
  graph_risks?: string[];
  graph_blocking_claims?: CheckGraphDraftConsistencyResult["blocking_claims"];
  graph_suggested_fix?: string;
  graph_error?: string;
};

export class BodyGenerateWorkflow implements WorkflowHandler {
  id = "body_generate";

  async runAgent(request: AgentRunRequest, context: WorkflowRunContext): Promise<AgentRunResponse> {
    throwIfAborted(context.signal);
    const skillId = this.id;
    const chapter = resolveSkillChapter(request) || 1;
    const chapterOutline = await resolveBodyChapterOutline(request, chapter, context);
    const outputPath = `02_正文/第${String(chapter).padStart(3, "0")}章.txt`;
    throwIfAborted(context.signal);
    const generated = await generateBodyChapter(request, chapter, chapterOutline, context);
    throwIfAborted(context.signal);
    const webSearchSources = generated.sources;

    const autoRevision = (request as any).auto_revision !== false;
    const scoreThreshold = Number((request as any).score_threshold || 80);

    let check: BodyConsistencyCheck = { score: 0, risks: [], reason: "未进行一致性检查" };
    let revised = false;
    let finalRawText = generated.text;

    if (autoRevision) {
      check = await runConsistencyCheckForText(generated.text, chapterOutline, context);
      throwIfAborted(context.signal);
      check = mergeGraphCheck(check, await runGraphDraftConsistency(generated.text, chapter, chapterOutline, context));
      throwIfAborted(context.signal);
      if (check.score < scoreThreshold || check.risks.length > 0) {
        const continuity = await buildProjectContinuityContext(context.projectRoot);
        throwIfAborted(context.signal);
        const revision = await runBodyChapterRevision(
          chapter,
          generated.text,
          chapterOutline,
          resolveTargetWords(request.content || ""),
          check,
          continuity.state_summary,
          context
        );
        throwIfAborted(context.signal);
        finalRawText = revision.text;
        revised = finalRawText.trim() !== generated.text.trim();

        if (shouldWriteSkillResult(request.content || "")) {
          await appendRevisionLog(chapter, outputPath, check, revision.log, context);
        }
      }
    }

    const deslopped = await applyBodyDeslop(finalRawText, chapter, context);
    throwIfAborted(context.signal);
    const humanized = await applyHumanizerIfEnabled({
      text: deslopped.text,
      config: context.config,
      modelClient: context.modelClient,
      mode: "正文生成结果",
      skip: false,
      signal: context.signal
    });
    throwIfAborted(context.signal);
    const text = humanized.text;
    const writeRequested = shouldWriteSkillResult(request.content || "");
    const savePlan = await context.savePlanner.planGeneratedSave({
      instruction: request.content || "",
      content: text,
      source: "workflow",
      skillId,
      targetPaths: [outputPath],
      targetPath: outputPath,
      currentPath: request.current_path || "",
      chapter,
      writeRequested,
      defaultMode: "replace"
    }, { signal: context.signal });
    throwIfAborted(context.signal);

    const entry = await context.cache.create({
      source: "body_generate",
      target_paths: savePlan.target_paths.length ? savePlan.target_paths : [outputPath],
      skill_id: skillId,
      mode: savePlan.mode,
      summary: `正文生成缓存：第 ${chapter} 章`,
      save_plan: savePlan
    });
    const meta = await context.cache.replace(entry.cache_id, text);
    throwIfAborted(context.signal);

    const baseData = {
      skill_id: skillId,
      chapter,
      chars: text.length,
      revised,
      deslopped: deslopped.changed,
      humanized: humanized.applied,
      humanizer_skill_id: humanized.applied ? "humanizer_zh" : "",
      ...(humanized.error ? { humanizer_error: humanized.error } : {}),
      score: check.score,
      risks: check.risks,
      ...graphCheckData(check),
      ...(generated.graph_error ? { graph_context_error: generated.graph_error } : {}),
      target_paths: savePlan.target_paths.length ? savePlan.target_paths : [outputPath],
      target_path: savePlan.target_paths[0] || outputPath,
      result: text,
      default_mode: savePlan.mode,
      cache_id: entry.cache_id,
      cache_path: meta.cache_path || "",
      cache_chars: meta.chars || text.length,
      save_plan: savePlan,
      web_search_sources: webSearchSources
    };

    if (!(await context.savePlanner.shouldAutoCommit(savePlan))) {
      return {
        intent: "skill",
        reply: text,
        conversation: await recordSkillExchange(request, text, context, webSearchSources.length ? { web_search_sources: webSearchSources } : {}),
        results: [],
        skill_result: {
          status: "done",
          result: text,
          saved_path: "",
          data: {
            ...baseData,
            pending_save: true,
            web_search_sources: webSearchSources
          }
        },
        saved_paths: [],
        requires_confirmation: false,
        web_search_sources: webSearchSources
      };
    }

    throwIfAborted(context.signal);
    const savedPaths = await context.cache.commitSavePlan(entry.cache_id, savePlan, { cleanupContent: true });
    throwIfAborted(context.signal);
    const graphUpdateError = await updateGraphMemoryForSavedPaths(savedPaths, context);
    if (savedPaths.includes(outputPath)) {
      await appendHandoff(chapter, outputPath, text, chapterOutline, check, context);
    }

    const reply = `已写入 ${savedPaths.length} 个文件：\n${savedPaths.join("\n")}`;
    const conversation = await recordSkillExchange(request, reply, context, webSearchSources.length ? { web_search_sources: webSearchSources } : {});
    return {
      intent: "skill",
      reply,
      conversation,
      results: [],
      skill_result: {
        status: "done",
        result: text,
        saved_path: savedPaths[0] || outputPath,
        data: {
          skill_id: skillId,
          chapter,
          path: outputPath,
          chars: text.length,
          revised,
          deslopped: deslopped.changed,
          humanized: humanized.applied,
          humanizer_skill_id: humanized.applied ? "humanizer_zh" : "",
          ...(humanized.error ? { humanizer_error: humanized.error } : {}),
          score: check.score,
          risks: check.risks,
          ...graphCheckData(check),
          ...(generated.graph_error ? { graph_context_error: generated.graph_error } : {}),
          ...(graphUpdateError ? { graph_update_error: graphUpdateError } : { graph_updated_paths: savedPaths }),
          target_paths: savePlan.target_paths,
          saved_paths: savedPaths,
          save_plan: savePlan,
          web_search_sources: webSearchSources
        }
      },
      saved_paths: savedPaths,
      requires_confirmation: false,
      web_search_sources: webSearchSources
    };
  }
}

async function generateBodyChapter(
  request: AgentRunRequest,
  chapter: number,
  chapterOutline: string,
  context: WorkflowRunContext
): Promise<{ text: string; sources: WebSearchSource[]; graph_error?: string }> {
  throwIfAborted(context.signal);
  const config = await loadModelConfig(context.config, "primary");
  if (!config.configured) {
    throw new Error("未配置主线路 API Key 或模型名。");
  }
  const continuity = await buildProjectContinuityContext(context.projectRoot);
  throwIfAborted(context.signal);
  const ledger = await context.documents.getLedger().catch(() => []);
  const openLedger = ledger
    .filter((item) => item.status === "open")
    .slice(0, 20)
    .map((item, index) => `${index + 1}. ${item.desc}`)
    .join("\n");
  const lower = Math.trunc((resolveTargetWords(request.content || "") || 2500) * 0.92);
  const upper = Math.trunc((resolveTargetWords(request.content || "") || 2500) * 1.12);
  const webSearch = await buildWorkflowWebSearchContext(
    request.content || "",
    [chapterOutline, continuity.state_summary, JSON.stringify(continuity.genre)].join("\n"),
    false,
    context
  );
  throwIfAborted(context.signal);

  const graph = await buildGraphWritingContext([chapterOutline, request.content || ""].join("\n"), context, { topK: 6, chapter });
  throwIfAborted(context.signal);

  const text = String(
    await context.modelClient.requestCompletion(
      config,
      [
        { role: "system", content: buildBodyChapterSystemPrompt({ lowerWords: lower, upperWords: upper }) },
        {
          role: "user",
          content: buildBodyChapterUserPrompt({
            chapter,
            instruction: request.content || "",
            chapterOutline,
            graphContext: graph.context,
            loreContext: JSON.stringify(continuity.lore),
            styleGenreBlock: buildStyleGenreConstraintBlock(continuity.style, continuity.genre, { bodyPhase: true }),
            webSearchContext: webSearch.context,
            openLedger,
            stateSummary: continuity.state_summary,
            recentChapters: continuity.previous_chapters.map((item) => item.content).join("\n")
          })
        }
      ] satisfies ChatCompletionMessage[],
      config.temperature,
      { signal: context.signal }
    )
  ).trim();
  throwIfAborted(context.signal);
  return { text, sources: webSearch.sources, graph_error: graph.error };
}

async function buildWorkflowWebSearchContext(
  instruction: string,
  contextHint: string,
  compact: boolean,
  context: WorkflowRunContext
): Promise<{ context: string; sources: WebSearchSource[] }> {
  const config = await loadWebSearchConfig(context.config);
  const triggerText = `${instruction || ""}\n${contextHint || ""}`;
  if (!config.enabled || !shouldUseWebSearch(triggerText)) {
    return { context: "None", sources: [] };
  }

  try {
    const query = buildWorkflowWebSearchQuery(instruction, contextHint);
    if (!query) {
      return { context: "None", sources: [] };
    }
    const results = await context.webSearchClient.search(query, config);
    return {
      context: formatWebSearchContext(results, compact ? Math.min(config.context_chars, 1600) : config.context_chars),
      sources: summarizeWebSearchSources(results)
    };
  } catch {
    return { context: "None", sources: [] };
  }
}

async function runConsistencyCheckForText(
  text: string,
  chapterOutline: string,
  context: WorkflowRunContext
): Promise<BodyConsistencyCheck> {
  throwIfAborted(context.signal);
  const continuity = await buildProjectContinuityContext(context.projectRoot);
  const assistantConfig = await loadAssistantModelConfig(context).catch(() => null);
  if (!assistantConfig) {
    return { score: 0, risks: [], reason: "未配置可用模型，跳过一致性评分" };
  }
  const recent = continuity.previous_chapters.map((item) => item.content).join("\n");

  const graph = await buildGraphWritingContext(text, context, { topK: 5 });
  throwIfAborted(context.signal);

  const prompt = [
    "请检查正文是否违背章纲、人物设定、体系设定、地图设定、道具设定、风格库、题材库和上一章承接。",
    '输出 JSON：{"score": 0-100, "risks": ["问题"], "reason": "简短说明"}。',
    "低于 80 分代表必须回炉。",
    "",
    `【图谱设定与计划事实】\n${graph.context}`,
    "",
    `【章纲】\n${clipForConsistency(chapterOutline, 5000)}`,
    "",
    `【连续性上下文】\n${clipForConsistency(JSON.stringify({ state_summary: continuity.state_summary, lore: continuity.lore, style: continuity.style, genre: continuity.genre }), 14000)}`,
    "",
    `【最近正文】\n${clipForConsistency(recent, 8000)}`,
    "",
    `【待审查正文】\n${clipForConsistency(text, 18000)}`
  ].join("\n");
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
  const parsed = safeJsonObject(raw);
  return {
    score: clampScore(Number(parsed.score || 0)),
    risks: Array.isArray(parsed.risks) ? parsed.risks.map((item) => String(item)).slice(0, 12) : [],
    reason:
      assistantConfig.line === "primary-fallback"
        ? `副线路未配置，已由主线路辅助代理完成评分。${String(parsed.reason || String(raw || "").slice(0, 1000))}`
        : String(parsed.reason || String(raw || "").slice(0, 1000)),
    ...(graph.error ? { graph_error: graph.error } : {})
  };
}

async function buildGraphWritingContext(
  query: string,
  context: WorkflowRunContext,
  options: { topK?: number; chapter?: number } = {}
): Promise<{ context: string; error?: string }> {
  let graph: GraphMemory | null = null;
  try {
    graph = new GraphMemory(context.projectRoot);
    const graphContext = await graph.buildWritingContext(query, {
      topK: options.topK,
      chapter: options.chapter,
      maxChars: 12_000
    });
    return { context: graphContext || "无" };
  } catch (err) {
    return { context: "无", error: err instanceof Error ? err.message : String(err) };
  } finally {
    graph?.close();
  }
}

async function runGraphDraftConsistency(
  text: string,
  chapter: number,
  chapterOutline: string,
  context: WorkflowRunContext
): Promise<Partial<BodyConsistencyCheck>> {
  let graph: GraphMemory | null = null;
  try {
    graph = new GraphMemory(context.projectRoot);
    const result = await graph.checkDraftConsistency(text, { chapter, chapterOutline });
    const blockingRisks = result.blocking_claims.map((claim) => `Graph blocking claim: ${claim.reason} (${claim.source_path})`);
    return {
      graph_score: result.score,
      graph_risks: result.risks,
      graph_blocking_claims: result.blocking_claims,
      graph_suggested_fix: result.suggested_fix,
      score: result.score,
      risks: [...result.risks, ...blockingRisks]
    };
  } catch (err) {
    return { graph_error: err instanceof Error ? err.message : String(err) };
  } finally {
    graph?.close();
  }
}

function mergeGraphCheck(check: BodyConsistencyCheck, graph: Partial<BodyConsistencyCheck>): BodyConsistencyCheck {
  if (graph.graph_error) {
    return { ...check, graph_error: graph.graph_error };
  }
  const graphRisks = graph.risks || [];
  return {
    ...check,
    score: graph.score !== undefined ? Math.min(check.score, graph.score) : check.score,
    risks: uniqueStrings([...check.risks, ...graphRisks]),
    ...(graph.graph_score !== undefined ? { graph_score: graph.graph_score } : {}),
    ...(graph.graph_risks ? { graph_risks: graph.graph_risks } : {}),
    ...(graph.graph_blocking_claims ? { graph_blocking_claims: graph.graph_blocking_claims } : {}),
    ...(graph.graph_suggested_fix ? { graph_suggested_fix: graph.graph_suggested_fix } : {})
  };
}

async function updateGraphMemoryForSavedPaths(savedPaths: string[], context: WorkflowRunContext): Promise<string> {
  if (!savedPaths.length) {
    return "";
  }
  let graph: GraphMemory | null = null;
  try {
    graph = new GraphMemory(context.projectRoot);
    graph.updatePaths(savedPaths);
    return "";
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  } finally {
    graph?.close();
  }
}

function graphCheckData(check: BodyConsistencyCheck): Record<string, unknown> {
  return {
    ...(check.graph_score !== undefined ? { graph_score: check.graph_score } : {}),
    ...(check.graph_risks ? { graph_risks: check.graph_risks } : {}),
    ...(check.graph_blocking_claims ? { graph_blocking_claims: check.graph_blocking_claims } : {}),
    ...(check.graph_suggested_fix ? { graph_suggested_fix: check.graph_suggested_fix } : {}),
    ...(check.graph_error ? { graph_error: check.graph_error } : {})
  };
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((item) => String(item || "").trim()).filter(Boolean))];
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

async function runBodyChapterRevision(
  chapter: number,
  text: string,
  chapterOutline: string,
  targetWords: number,
  checkResult: { score: number; risks: string[]; reason: string },
  contextSummary: string,
  context: WorkflowRunContext
): Promise<{ text: string; log: string }> {
  throwIfAborted(context.signal);
  const config = await loadModelConfig(context.config, "primary");
  if (!config.configured) {
    throw new Error("未配置主线路 API Key 或模型名。");
  }
  const raw = String(
    await context.modelClient.requestCompletion(
      config,
      [
        { role: "system", content: buildBodyRevisionSystemPrompt() },
        { role: "user", content: buildBodyRevisionUserPrompt({ chapter, text, chapterOutline, targetWords, checkResult, contextSummary }) }
      ] satisfies ChatCompletionMessage[],
      Math.max(0.3, (config.temperature ?? 0.7) - 0.15),
      { signal: context.signal }
    )
  ).trim();
  throwIfAborted(context.signal);

  const bodyMatch = /【修正后正文】\s*([\s\S]*?)(?:【修正原因日志】|$)/.exec(raw);
  const logMatch = /【修正原因日志】\s*([\s\S]*)$/.exec(raw);

  const body = (bodyMatch && bodyMatch[1] ? bodyMatch[1] : raw).trim();
  const log = (logMatch && logMatch[1] ? logMatch[1] : "模型未按格式返回修正原因日志。").trim();

  return {
    text: body || text,
    log
  };
}

async function applyBodyDeslop(text: string, chapter: number, context: WorkflowRunContext): Promise<{ text: string; changed: boolean }> {
  throwIfAborted(context.signal);
  const config = await loadModelConfig(context.config, "primary");
  if (!config.configured || !text.trim()) {
    return { text, changed: false };
  }
  const systemPrompt =
    "你是 story-deslop 去AI味编辑。任务：检测并清除网文文本里的 AI 写作痕迹，让文字回到自然、有人味的状态。" +
    "只输出处理后的正文本体，不输出报告、解释、标题或免责声明。";
  try {
    const raw = String(
      await context.modelClient.requestCompletion(
        config,
        [
          { role: "system", content: systemPrompt },
          { role: "user", content: buildBodyDeslopUserPrompt({ chapter, text }) }
        ] satisfies ChatCompletionMessage[],
        Math.max(0.2, Math.min(0.7, config.temperature)),
        { signal: context.signal }
      )
    ).trim();
    throwIfAborted(context.signal);
    const cleaned = raw.replace(/^```(?:text|markdown|md)?\s*/i, "").replace(/\s*```$/, "").trim();
    if (!cleaned) {
      return { text, changed: false };
    }
    return { text: cleaned, changed: cleaned !== text.trim() };
  } catch (error) {
    if (isCancellationError(error, context.signal)) {
      throw error;
    }
    return { text, changed: false };
  }
}

async function resolveBodyChapterOutline(request: AgentRunRequest, chapter: number, context: WorkflowRunContext): Promise<string> {
  const direct = String(request.selection || "").trim();
  if (direct && /第\s*\d+\s*章|章纲|目标|冲突/.test(direct)) {
    return direct;
  }
  for (const relPath of ["01_大纲/章纲.txt", "01_大纲/细纲.txt", "01_大纲/大纲.txt"]) {
    try {
      const text = (await context.documents.readRawText(relPath, 12_000)).trim();
      if (!text) {
        continue;
      }
      const extracted = extractChapterSection(text, chapter);
      if (extracted) {
        return extracted;
      }
      if (text) {
        return text;
      }
    } catch {
      continue;
    }
  }
  return "";
}

function extractChapterSection(text: string, chapter: number): string {
  const lines = String(text || "").split(/\r?\n/);
  const hits: string[] = [];
  let capture = false;
  for (const line of lines) {
    const current = resolveChapterNumber(line);
    if (current === chapter) {
      capture = true;
    } else if (capture && current && current !== chapter) {
      break;
    }
    if (capture) {
      hits.push(line);
    }
  }
  return hits.join("\n").trim();
}

function resolveSkillChapter(request: AgentRunRequest): number {
  const chapter = resolveChapterNumber(request.content || "") || resolveChapterNumber(request.current_path || "");
  return chapter <= 0 ? 1 : chapter;
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

function resolveTargetWords(text: string): number {
  const match = /(\d{3,5})\s*(?:字|词|words?\b)/i.exec(text || "");
  if (!match) {
    return 2500;
  }
  const value = Number.parseInt(match[1] || "2500", 10);
  return Math.max(300, Math.min(20000, value));
}

function shouldWriteSkillResult(text: string): boolean {
  return /(同步|写入|保存|更新|替换|覆盖|落到|写回|补充|补全|完善|补齐|填充|配置|设置|设定|建立|创建)/.test(text);
}

async function appendRevisionLog(
  chapter: number,
  outputPath: string,
  checkResult: { score: number; risks: string[]; reason: string },
  revisionLog: string,
  context: WorkflowRunContext
): Promise<void> {
  const pad = (value: number) => String(value).padStart(2, "0");
  const now = new Date();
  const timeStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

  const lines = [
    `\n\n=== 第${chapter}章 | ${timeStr} ===`,
    `文件: ${outputPath}`,
    "触发原因:",
    `- 评分：${checkResult.score || 0}`
  ];
  for (const risk of checkResult.risks || []) {
    lines.push(`- ${risk}`);
  }
  lines.push("", "修正说明:", (revisionLog || "模型未返回修正说明").trim(), "");

  await context.documents.appendDocument("00_设定集/修正日志/正文二次修正日志.txt", lines.join("\n"), {
    source: "generation",
    summary: `追加第 ${chapter} 章修正日志`
  });
}

async function appendHandoff(
  chapter: number,
  outputPath: string,
  text: string,
  chapterOutline: string,
  checkResult: { score: number; risks: string[]; reason: string },
  context: WorkflowRunContext
): Promise<void> {
  const pad = (value: number) => String(value).padStart(2, "0");
  const now = new Date();
  const timeStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

  const excerpt = (val: string, limit: number) => {
    const trimmed = (val || "").trim();
    return trimmed.length <= limit ? trimmed : trimmed.slice(0, limit) + "\n...（已截断）";
  };

  const record = {
    time: timeStr,
    chapter,
    path: outputPath,
    outline_excerpt: excerpt(chapterOutline, 800),
    ending_excerpt: text.length > 900 ? text.slice(-900) : text,
    score: checkResult.score,
    risks: checkResult.risks
  };

  await context.documents.appendDocument("00_设定集/章节交接摘要.jsonl", JSON.stringify(record) + "\n", {
    source: "generation",
    summary: `追加第 ${chapter} 章交接摘要`
  });
}

async function recordSkillExchange(
  request: AgentRunRequest,
  reply: string,
  context: WorkflowRunContext,
  assistantMetadata: Record<string, unknown> = {}
): Promise<AgentRunResponse["conversation"]> {
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
      id: cryptoRandomId(),
      role: "user",
      content: userText,
      created_at: createdAt,
      metadata: userMetadata
    });
  }
  if (String(reply || "").trim()) {
    nextMessages.push({
      id: cryptoRandomId(),
      role: "assistant",
      content: String(reply || "").trim(),
      created_at: createdAt,
      metadata: replyMetadata
    });
  }

  let nextDetail = {
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

function cryptoRandomId(): string {
  return randomUUID().replace(/-/g, "");
}

function safeJsonObject(value: unknown): Record<string, unknown> {
  try {
    const parsed = JSON.parse(String(value || ""));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function clampScore(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(100, Math.trunc(value)));
}

function buildWorkflowWebSearchQuery(instruction: string, contextHint: string): string {
  const text = String(instruction || "").replace(/\s+/g, " ").trim();
  const context = String(contextHint || "").replace(/\s+/g, " ").trim();
  const base = text || context;
  if (!base) {
    return "";
  }
  if (/小说|网文|素材|设定|大纲|剧情|人物|世界观|资料/.test(base)) {
    return clipForConsistency(base, 120);
  }
  return clipForConsistency(`${base} 小说素材`, 120);
}
