import type {
  AgentRunRequest,
  AgentRunResponse,
  AgentPlanRequest,
  AgentPlanResponse,
  AgentStreamEvent,
  SkillPlan,
  SkillPlanStep,
  SkillRunRequest,
  SkillRunResponse,
  ConversationMessageRequest,
  ConversationDetail,
  CardDrawRequest,
  CardDrawResult,
  CardDrawSelectRequest,
  CardDrawCandidate,
  SkillDraftFromUrlRequest,
  SkillDraftResponse,
  StyleDistillationProfile
} from "@xiaoshuo/shared";
import { AgentChatRunner } from "./chat-runner.js";
import { classifyAgentIntent, hasSkillAction, isReadContextIntent, rankSkillRoutes } from "./intent-router.js";
import { AgentPlanner, type AgentPlannerOptions } from "./planner.js";
import { PromptSkillRunner } from "./skill-runner.js";
import { SkillService } from "@xiaoshuo/skill-service";
import { AgentFileOperationRunner } from "./file-operation-runner.js";
import { ConversationService } from "@xiaoshuo/conversation-service";
import { DocumentService } from "@xiaoshuo/document-service";
import { createHash, randomUUID } from "node:crypto";
import { loadModelConfig, loadWebSearchConfig, type ConfigServiceOptions } from "@xiaoshuo/config-service";
import { OpenAICompatibleClient, type ChatCompletionMessage } from "@xiaoshuo/model-client";
import {
  buildProjectContinuityContext,
  deleteProjectStyleDistillation,
  readProjectStyleDistillation,
  writeProjectStyleDistillation
} from "@xiaoshuo/project-session";
import { GeneratedCacheService } from "@xiaoshuo/generated-cache";
import { DefaultWebSearchClient, formatWebSearchContext, shouldUseWebSearch, summarizeWebSearchSources, type WebSearchClient, type WebSearchSource } from "./web-search.js";
import fs from "node:fs/promises";
import path from "node:path";
import { applyHumanizerIfEnabled } from "./humanizer.js";
import { GeneratedSavePlanner, hasExplicitWriteIntent } from "./generated-save-planner.js";
import { SmartSkillOrchestrator } from "./smart-skill-orchestrator.js";
import { buildStyleGenreConstraintBlock } from "./style-genre-context.js";
import type { StreamingModelClient } from "./stream.js";
import { createAgentTraceRecorder, type AgentTraceRecorder } from "./agent-trace.js";
import { getWorkflowHandler, isWorkflowSkillId } from "./workflows/registry.js";
import type { WorkflowRunContext } from "./workflows/types.js";

const DISASSEMBLE_LIBRARY_DIR = "00_设定集/拆书库";
const FUSION_LIBRARY_DIR = "00_设定集/融梗方案";
const LEGACY_DISASSEMBLE_LORE_PATH = "00_设定集/设定集/拆书设定提取.txt";
const LEGACY_REVERSE_OUTLINE_PATH = "01_大纲/反向细纲.txt";
const LEGACY_DISASSEMBLE_DETAIL_PATH = "01_大纲/拆书细纲.txt";
const BOOK_MANIFEST_PATH = "manifest.jsonl";
const DISASSEMBLE_SOURCE_IMPORT_CHARS = 60_000;
const TARGET_WORD_SKILL_IDS = new Set([
  "body_generate",
  "batch_generate",
  "outline_generate",
  "detail_outline_generate",
  "chapter_outline_generate"
]);

type DisassembleBookManifest = {
  id: string;
  title: string;
  dir: string;
  created_at: string;
  updated_at: string;
  origin: string;
  source_path: string;
  source_summary: string;
  chars: number;
  paths: {
    source?: string;
    lore?: string;
    reverse_outline?: string;
    detail_outline?: string;
  };
};

export class AgentRuntimeService {
  private readonly planner: AgentPlanner;
  private readonly skillRunner: PromptSkillRunner;
  private readonly chatRunner: AgentChatRunner;
  private readonly fileOperationRunner: AgentFileOperationRunner;
  private readonly skills: SkillService;
  private readonly conversations: ConversationService;
  private readonly documents: DocumentService;
  private readonly config: ConfigServiceOptions;
  private readonly modelClient: StreamingModelClient;
  private readonly webSearchClient: WebSearchClient;
  private readonly cache: GeneratedCacheService;
  private readonly savePlanner: GeneratedSavePlanner;
  private readonly skillOrchestrator: SmartSkillOrchestrator;

  constructor(options: AgentPlannerOptions) {
    this.config = options.config ?? {};
    this.modelClient = options.modelClient ?? new OpenAICompatibleClient();
    this.webSearchClient = options.webSearchClient ?? new DefaultWebSearchClient();
    this.planner = new AgentPlanner(options);
    this.skillRunner = new PromptSkillRunner(options);
    this.chatRunner = new AgentChatRunner(options);
    this.fileOperationRunner = new AgentFileOperationRunner({ planner: this.planner, projectRoot: options.projectRoot });
    this.skills = new SkillService({ projectRoot: options.projectRoot });
    this.conversations = new ConversationService({ projectRoot: options.projectRoot });
    this.documents = new DocumentService({ projectRoot: options.projectRoot });
    this.cache = new GeneratedCacheService({ projectRoot: options.projectRoot, documentService: this.documents });
    this.savePlanner = new GeneratedSavePlanner({
      projectRoot: options.projectRoot,
      config: this.config,
      modelClient: this.modelClient
    });
    this.skillOrchestrator = new SmartSkillOrchestrator({
      projectRoot: options.projectRoot,
      config: this.config,
      modelClient: this.modelClient
    });
  }

  async plan(request: AgentPlanRequest): Promise<AgentPlanResponse> {
    return this.planner.buildPlan(request);
  }

  async canRunSkillLocally(skillId: string): Promise<boolean> {
    const skill = await this.skills.getSkill(skillId).catch(() => null);
    if (skill?.disabled) {
      return false;
    }
    if (isWorkflowSkillId(skillId)) {
      return true;
    }
    return this.skillRunner.canRunSkillLocally(skillId);
  }

  async runSkill(skillId: string, request: SkillRunRequest): Promise<SkillRunResponse> {
    const trace = this.createTraceRecorder({
      conversationId: request.conversation_id || "",
      skillId,
      content: request.instruction || request.text || ""
    });
    const startedAt = Date.now();
    this.addSkillRequestContextToTrace(trace, request);
    try {
      trace.mark("workflow_started", { selected_skill_id: skillId });
      const result = await this.runSkillInternal(skillId, request);
      this.addSkillResultToTrace(trace, result);
      await this.addModelCallSummaryToTrace(trace, {
        inputChars: skillRequestInputChars(request),
        outputChars: String(result.result || "").length,
        durationMs: Date.now() - startedAt,
        streaming: false
      });
      await trace.finish();
      return result;
    } catch (error) {
      await this.addModelCallSummaryToTrace(trace, {
        inputChars: skillRequestInputChars(request),
        outputChars: 0,
        durationMs: Date.now() - startedAt,
        streaming: false,
        error
      });
      trace.fail(error);
      await trace.finish();
      throw error;
    }
  }

  private async runSkillInternal(skillId: string, request: SkillRunRequest): Promise<SkillRunResponse> {
    const skill = await this.skills.getSkill(skillId).catch(() => null);
    if (skill?.disabled) {
      throw new Error(`默认技能已禁用：${skill.name || skillId}。请先恢复后再执行。`);
    }
    if (skillId === "nuwa_style_distill") {
      return this.runNuwaStyleDistillSkill(request);
    }
    if (isWorkflowSkillId(skillId)) {
      let content = request.instruction || request.text || "";
      if (skillId === "batch_generate" && request.chapter && request.end_chapter) {
        content = `第${request.chapter}章到第${request.end_chapter}章 ${content}`.trim();
      } else if (request.chapter && !/第\s*\d+\s*章/.test(content)) {
        content = `第${request.chapter}章 ${content}`.trim();
      }
      if (request.target_words && TARGET_WORD_SKILL_IDS.has(skillId) && !/字|词|words?/.test(content)) {
        content = `${content} 约${request.target_words}字`.trim();
      }

      const agentRequest: AgentRunRequest = {
        conversation_id: request.conversation_id || "",
        content,
        current_path: request.source_path || "",
        selection: request.text || "",
        project_context_hint: "",
        skill_id: skillId,
        attachment_ids: request.attachment_ids || [],
        ...((request as any).auto_revision !== undefined ? { auto_revision: (request as any).auto_revision } : {}),
        ...((request as any).score_threshold !== undefined ? { score_threshold: (request as any).score_threshold } : {}),
        ...((request as any).book_title !== undefined ? { book_title: (request as any).book_title } : {}),
        ...((request as any).source_book_id !== undefined ? { source_book_id: (request as any).source_book_id } : {}),
        ...((request as any).source_book_ids !== undefined ? { source_book_ids: (request as any).source_book_ids } : {}),
        ...((request as any).custom_prompt !== undefined ? { custom_prompt: (request as any).custom_prompt } : {}),
        ...((request as any).genre_hint !== undefined ? { genre_hint: (request as any).genre_hint } : {}),
        ...((request as any).output_mode !== undefined ? { output_mode: (request as any).output_mode } : {}),
        ...((request as any).action !== undefined ? { action: (request as any).action } : {}),
        ...((request as any).suppress_conversation_record !== undefined
          ? { suppress_conversation_record: (request as any).suppress_conversation_record }
          : {})
      } as any;

      if (skillId === "body_generate" || skillId === "batch_generate") {
        const hasWriteWord = /(同步|写入|保存|更新|替换|覆盖|落到|写回|补充|补全|完善|补齐|填充|配置|设置|设定|建立|创建)/.test(agentRequest.content || "");
        if (request.write_result && !hasWriteWord) {
          agentRequest.content = (agentRequest.content + " 写入文件").trim();
        }
      }

      const agentResponse = await this.runLocalWorkflowSkill(skillId, agentRequest);
      if (agentResponse.skill_result) {
        return agentResponse.skill_result;
      }
      return {
        status: "done",
        result: agentResponse.reply || "",
        saved_path: agentResponse.saved_paths?.[0] || "",
        data: {}
      };
    }
    return this.skillRunner.runSkill(skillId, request);
  }

  async canRunAgentLocally(request: AgentRunRequest): Promise<boolean> {
    if (this.shouldUseSmartSkillOrchestration(request)) {
      const skillPlan = await this.planSkillExecution(request).catch(() => null);
      if (skillPlan?.should_call_skill && skillPlan.steps.length) {
        return true;
      }
    }
    const intent = await this.classifyIntent(request);
    if (intent === "skill") {
      const skillId = await this.resolveSkillId(request);
      if (isWorkflowSkillId(skillId)) {
        return true;
      }
      return Boolean(skillId) && (await this.skillRunner.canRunSkillLocally(skillId));
    }
    return intent === "chat" || intent === "read_context" || intent === "file_operation";
  }

  async runAgent(request: AgentRunRequest): Promise<AgentRunResponse> {
    const trace = this.createTraceRecorder({
      conversationId: request.conversation_id || "",
      skillId: request.skill_id || "",
      content: request.content || ""
    });
    const startedAt = Date.now();
    this.addAgentRequestContextToTrace(trace, request);
    try {
      await this.addRoutingTrace(request, trace);
      const response = await this.runAgentInternal(request, trace);
      this.addAgentResponseToTrace(trace, response);
      await this.addModelCallSummaryToTrace(trace, {
        inputChars: agentRequestInputChars(request),
        outputChars: String(response.reply || response.skill_result?.result || "").length,
        durationMs: Date.now() - startedAt,
        streaming: false
      });
      await trace.finish({ saved_paths: response.saved_paths || [] });
      return response;
    } catch (error) {
      await this.addModelCallSummaryToTrace(trace, {
        inputChars: agentRequestInputChars(request),
        outputChars: 0,
        durationMs: Date.now() - startedAt,
        streaming: false,
        error
      });
      trace.fail(error);
      await trace.finish();
      throw error;
    }
  }

  private async runAgentInternal(request: AgentRunRequest, trace?: AgentTraceRecorder): Promise<AgentRunResponse> {
    if (this.shouldUseSmartSkillOrchestration(request)) {
      const skillPlan = await this.planSkillExecution(request);
      if (skillPlan.should_call_skill && skillPlan.steps.length) {
        trace?.mark("planned", {
          selected_skill_id: skillPlan.steps[0]?.skill_id || "",
          selected_reason: skillPlan.selected_reason
        });
        return this.runSkillPlan(skillPlan, request);
      }
    }

    const intent = await this.classifyIntent(request);
    trace?.mark("classified", { intent });
    if (intent === "file_operation") {
      return this.fileOperationRunner.runAgent(request);
    }
    if (intent === "skill") {
      const skillId = await this.resolveSkillId(request);
      if (!skillId) {
        throw new Error(`TS runtime 尚未接管该意图：${intent}`);
      }
      if (isWorkflowSkillId(skillId)) {
        trace?.mark("workflow_started", { selected_skill_id: skillId });
        return this.runLocalWorkflowSkill(skillId, request, trace);
      }
      if (!(await this.skillRunner.canRunSkillLocally(skillId))) {
        throw new Error(`TS runtime 尚未接管该意图：${intent}`);
      }
      trace?.mark("workflow_started", { selected_skill_id: skillId });
      return this.runLocalSkillIntent(skillId, request);
    }
    if (intent !== "chat" && intent !== "read_context") {
      throw new Error(`TS runtime 尚未接管该意图：${intent}`);
    }
    return this.attachGeneratedSaveDecision(request, await this.chatRunner.runAgent(request, intent));
  }

  async *streamAgentRun(request: AgentRunRequest): AsyncGenerator<AgentStreamEvent> {
    const trace = this.createTraceRecorder({
      conversationId: request.conversation_id || "",
      skillId: request.skill_id || "",
      content: request.content || ""
    });
    const startedAt = Date.now();
    this.addAgentRequestContextToTrace(trace, request);
    try {
      await this.addRoutingTrace(request, trace);
      let finalPayload: AgentRunResponse | null = null;
      for await (const event of this.streamAgentRunInternal(request, trace)) {
        if (event.type === "final") {
          finalPayload = event.payload;
          this.addAgentResponseToTrace(trace, event.payload);
        }
        yield event;
      }
      await this.addModelCallSummaryToTrace(trace, {
        inputChars: agentRequestInputChars(request),
        outputChars: String(finalPayload?.reply || finalPayload?.skill_result?.result || "").length,
        durationMs: Date.now() - startedAt,
        streaming: true
      });
      await trace.finish({ saved_paths: finalPayload?.saved_paths || [] });
    } catch (error) {
      await this.addModelCallSummaryToTrace(trace, {
        inputChars: agentRequestInputChars(request),
        outputChars: 0,
        durationMs: Date.now() - startedAt,
        streaming: true,
        error
      });
      trace.fail(error);
      await trace.finish();
      throw error;
    }
  }

  private async *streamAgentRunInternal(request: AgentRunRequest, trace?: AgentTraceRecorder): AsyncGenerator<AgentStreamEvent> {
    if (this.shouldUseSmartSkillOrchestration(request)) {
      const skillPlan = await this.planSkillExecution(request);
      if (skillPlan.should_call_skill && skillPlan.steps.length) {
        trace?.mark("planned", {
          selected_skill_id: skillPlan.steps[0]?.skill_id || "",
          selected_reason: skillPlan.selected_reason
        });
        yield* this.streamSkillPlan(skillPlan, request);
        return;
      }
    }

    const intent = await this.classifyIntent(request);
    trace?.mark("classified", { intent });
    if (intent === "file_operation") {
      yield* this.fileOperationRunner.streamAgentRun(request);
      return;
    }
    if (intent === "skill") {
      const skillId = await this.resolveSkillId(request);
      if (!skillId) {
        throw new Error(`TS runtime 尚未接管该意图：${intent}`);
      }
      if (isWorkflowSkillId(skillId)) {
        trace?.mark("workflow_started", { selected_skill_id: skillId });
        yield* this.streamLocalWorkflowSkill(skillId, request, trace);
        return;
      }
      if (!(await this.skillRunner.canRunSkillLocally(skillId))) {
        throw new Error(`TS runtime 尚未接管该意图：${intent}`);
      }
      trace?.mark("workflow_started", { selected_skill_id: skillId });
      yield* this.streamLocalSkillIntent(skillId, request);
      return;
    }
    if (intent !== "chat" && intent !== "read_context") {
      throw new Error(`TS runtime 尚未接管该意图：${intent}`);
    }
    for await (const event of this.chatRunner.streamAgentRun(request, intent)) {
      if (event.type === "final") {
        yield {
          ...event,
          payload: await this.attachGeneratedSaveDecision(request, event.payload)
        };
        continue;
      }
      yield event;
    }
  }

  private createTraceRecorder(input: { conversationId?: string; skillId?: string; content?: string }): AgentTraceRecorder {
    return createAgentTraceRecorder({
      projectRoot: this.documents.projectRoot,
      conversationId: input.conversationId || "",
      skillId: input.skillId || "",
      content: input.content || ""
    });
  }

  private buildWorkflowContext(trace?: AgentTraceRecorder): WorkflowRunContext {
    return {
      projectRoot: this.documents.projectRoot,
      config: this.config,
      modelClient: this.modelClient,
      webSearchClient: this.webSearchClient,
      documents: this.documents,
      conversations: this.conversations,
      cache: this.cache,
      savePlanner: this.savePlanner,
      skillRunner: this.skillRunner,
      trace
    };
  }

  private addAgentRequestContextToTrace(trace: AgentTraceRecorder, request: AgentRunRequest): void {
    const content = String(request.content || "");
    if (content.trim()) {
      trace.addContextBlock({
        name: "user_input",
        source: "conversation",
        chars: content.length,
        included: true,
        reason: "agent request content excerpt only"
      });
    }
    const selection = String(request.selection || "");
    if (selection.trim()) {
      trace.addContextBlock({
        name: "selection",
        source: "selection",
        chars: selection.length,
        included: true,
        reason: "current selection supplied to agent"
      });
    }
    const hint = String(request.project_context_hint || "");
    if (hint.trim()) {
      trace.addContextBlock({
        name: "project_context_hint",
        source: "runtime",
        chars: hint.length,
        included: true,
        reason: "runtime supplied context hint"
      });
    }
    if (String(request.current_path || "").trim()) {
      trace.addContextBlock({
        name: request.current_path,
        source: "document",
        chars: 0,
        included: true,
        reason: "current document path reference"
      });
    }
    if (request.attachment_ids?.length) {
      trace.addContextBlock({
        name: "attachments",
        source: "attachment",
        chars: 0,
        included: true,
        reason: `${request.attachment_ids.length} attachment id(s) referenced`
      });
    }
  }

  private addSkillRequestContextToTrace(trace: AgentTraceRecorder, request: SkillRunRequest): void {
    const instruction = String(request.instruction || "");
    if (instruction.trim()) {
      trace.addContextBlock({
        name: "skill_instruction",
        source: "runtime",
        chars: instruction.length,
        included: true,
        reason: "skill instruction excerpt only"
      });
    }
    const text = String(request.text || "");
    if (text.trim()) {
      trace.addContextBlock({
        name: "skill_text",
        source: "selection",
        chars: text.length,
        included: true,
        reason: "skill source text length only"
      });
    }
    if (String(request.source_path || "").trim()) {
      trace.addContextBlock({
        name: request.source_path,
        source: "document",
        chars: 0,
        included: true,
        reason: "skill source path reference"
      });
    }
    if (request.attachment_ids?.length) {
      trace.addContextBlock({
        name: "attachments",
        source: "attachment",
        chars: 0,
        included: true,
        reason: `${request.attachment_ids.length} attachment id(s) referenced`
      });
    }
  }

  private async addModelCallSummaryToTrace(
    trace: AgentTraceRecorder,
    input: { inputChars: number; outputChars: number; durationMs: number; streaming: boolean; error?: unknown }
  ): Promise<void> {
    try {
      const config = await loadModelConfig(this.config, "primary").catch(() => null);
      trace.addModelCall({
        line: "primary",
        model: config?.model || "",
        streaming: input.streaming,
        temperature: config?.temperature,
        input_chars: Math.max(0, Math.trunc(input.inputChars || 0)),
        output_chars: Math.max(0, Math.trunc(input.outputChars || 0)),
        duration_ms: Math.max(0, Math.trunc(input.durationMs || 0)),
        fallback_used: false,
        error: input.error ? (input.error instanceof Error ? input.error.message : String(input.error)) : ""
      });
    } catch {
      // Trace must not affect agent execution.
    }
  }

  private async addRoutingTrace(request: AgentRunRequest, trace: AgentTraceRecorder): Promise<void> {
    try {
      const skills = await this.skills.listSkills().catch(() => []);
      const candidates = rankSkillRoutes(request.content || "", skills, {
        manualSkillId: request.skill_id || "",
        currentSkillId: String((request as any).current_skill || ""),
        limit: 8
      });
      trace.addRouteCandidates(
        candidates.map((candidate) => ({
          skill_id: candidate.skillId,
          score: candidate.score,
          reasons: candidate.reasons,
          signals: candidate.signals
        }))
      );
      const intent = classifyAgentIntent(request.content || "", request.skill_id || "", skills);
      const top = candidates[0];
      trace.mark("classified", {
        intent,
        selected_skill_id: top?.skillId || request.skill_id || "",
        selected_reason: top?.reasons.join("；") || ""
      });
    } catch {
      // Trace must not affect routing.
    }
  }

  private addAgentResponseToTrace(trace: AgentTraceRecorder, response: AgentRunResponse): void {
    const data = isRecord(response.skill_result?.data) ? response.skill_result!.data : {};
    const savedPaths = uniquePaths([...(response.saved_paths || []), ...stringListFromUnknown(data.saved_paths), response.skill_result?.saved_path || ""]);
    const webSearchSources = [
      ...(response.web_search_sources || []),
      ...webSearchSourcesFromUnknown(data.web_search_sources)
    ];
    trace.addWebSearchSources(webSearchSources);
    this.addSaveDecisionToTrace(trace, data, savedPaths);
    trace.mark(savedPaths.length ? "save_committed" : response.intent === "skill" ? "workflow_completed" : "conversation_recorded", {
      ...(response.conversation?.id ? { conversation_id: response.conversation.id } : {}),
      intent: response.intent,
      selected_skill_id: response.current_skill || String(data.skill_id || ""),
      saved_paths: savedPaths,
      web_search_sources: webSearchSources
    });
  }

  private addSkillResultToTrace(trace: AgentTraceRecorder, result: SkillRunResponse): void {
    const data = isRecord(result.data) ? result.data : {};
    const savedPaths = uniquePaths([...stringListFromUnknown(data.saved_paths), result.saved_path || ""]);
    const webSearchSources = webSearchSourcesFromUnknown(data.web_search_sources);
    trace.addWebSearchSources(webSearchSources);
    this.addSaveDecisionToTrace(trace, data, savedPaths);
    trace.mark(savedPaths.length ? "save_committed" : "workflow_completed", {
      selected_skill_id: String(data.skill_id || ""),
      saved_paths: savedPaths,
      web_search_sources: webSearchSources
    });
  }

  private addSaveDecisionToTrace(trace: AgentTraceRecorder, data: Record<string, unknown>, savedPaths: string[]): void {
    const savePlan = isRecord(data.save_plan) ? data.save_plan : {};
    const targetPaths = uniquePaths([
      ...stringListFromUnknown(savePlan.target_paths),
      ...stringListFromUnknown(data.target_paths),
      String(data.target_path || ""),
      ...savedPaths
    ]);
    const cacheId = String(data.cache_id || "");
    if (!targetPaths.length && !cacheId && !Object.keys(savePlan).length) {
      return;
    }
    trace.addSaveDecision({
      action: String(savePlan.action || (savedPaths.length ? "save_committed" : data.pending_save ? "pending_save" : "save_planned")),
      mode: readTraceMode(savePlan.mode || data.default_mode),
      target_paths: targetPaths,
      cache_id: cacheId,
      auto_committed: savedPaths.length > 0,
      reason: String(savePlan.reason || "")
    });
  }

  private async classifyIntent(request: AgentRunRequest) {
    const skills = await this.skills.listSkills().catch(() => []);
    return classifyAgentIntent(request.content || "", request.skill_id || "", skills);
  }

  private async resolveSkillId(request: AgentRunRequest): Promise<string> {
    const skills = await this.skills.listSkills().catch(() => []);
    return rankSkillRoutes(request.content || "", skills, {
      manualSkillId: request.skill_id || "",
      currentSkillId: String((request as any).current_skill || ""),
      limit: 1
    })[0]?.skillId || "";
  }

  private async attachGeneratedSaveDecision(request: AgentRunRequest, response: AgentRunResponse): Promise<AgentRunResponse> {
    if (response.intent !== "chat" && response.intent !== "read_context") {
      return response;
    }
    if (response.saved_paths.length || response.skill_result?.data?.pending_save) {
      return response;
    }
    const content = String(response.reply || "").trim();
    if (!content || !hasExplicitWriteIntent(request.content || "")) {
      return response;
    }

    const plan = await this.savePlanner.planGeneratedSave({
      instruction: request.content || "",
      content,
      source: "chat",
      skillId: "chat_generated",
      currentPath: request.current_path || "",
      chapter: this.resolveSkillChapter("body_generate", request),
      writeRequested: true,
      defaultMode: "replace"
    });

    if (plan.action === "no_save" || !plan.target_paths.length) {
      return response;
    }

    const entry = await this.cache.create({
      source: "chat",
      target_paths: plan.target_paths,
      skill_id: "chat_generated",
      conversation_id: response.conversation?.id || request.conversation_id || "",
      mode: plan.mode,
      summary: "AI 会话生成保存计划",
      save_plan: plan
    });
    const meta = await this.cache.replace(entry.cache_id, content);

    if (await this.savePlanner.shouldAutoCommit(plan)) {
      const savedPaths = await this.cache.commitSavePlan(entry.cache_id, plan, { cleanupContent: true });
      return {
        ...response,
        saved_paths: savedPaths,
        skill_result: {
          status: "done",
          result: content,
          saved_path: savedPaths[0] || "",
          data: {
            skill_id: "chat_generated",
            result: content,
            saved_paths: savedPaths,
            target_paths: plan.target_paths,
            target_path: plan.target_paths[0] || "",
            save_plan: plan
          }
        }
      };
    }

    return {
      ...response,
      skill_result: {
        status: "done",
        result: content,
        saved_path: "",
        data: {
          skill_id: "chat_generated",
          result: content,
          pending_save: true,
          target_paths: plan.target_paths,
          target_path: plan.target_paths[0] || "",
          default_mode: plan.mode,
          cache_id: entry.cache_id,
          cache_path: meta.cache_path || "",
          cache_chars: meta.chars || content.length,
          save_plan: plan
        }
      }
    };
  }

  private async planSkillExecution(request: AgentRunRequest): Promise<SkillPlan> {
    const skills = await this.skills.listSkills().catch(() => []);
    return this.skillOrchestrator.plan(request, skills);
  }

  private async *streamLocalSkillIntent(skillId: string, request: AgentRunRequest): AsyncGenerator<AgentStreamEvent> {
    request = { ...request, skill_id: skillId };
    yield {
      type: "start",
      intent: "skill",
      conversation_id: request.conversation_id || "",
      skill_id: skillId
    };
    const skillRequest = this.buildSkillRequest(skillId, request);
    for await (const event of this.skillRunner.streamSkill(skillId, skillRequest)) {
      if (event.type !== "final") {
        yield event;
        continue;
      }
      const result = event.payload.skill_result!;
      const savedPaths = this.resolveSavedPaths(result);
      const reply = savedPaths.length ? `已写入 ${savedPaths.length} 个文件：\n${savedPaths.join("\n")}` : result.result || "技能已完成。";
      yield {
        type: "final",
        payload: {
          intent: "skill",
          reply,
          conversation: await this.recordSkillExchange(request, reply),
          results: [],
          skill_result: result,
          saved_paths: savedPaths,
          requires_confirmation: false,
          current_skill: event.payload.current_skill || skillId
        }
      };
    }
  }

  private async *streamLocalWorkflowSkill(skillId: string, request: AgentRunRequest, trace?: AgentTraceRecorder): AsyncGenerator<AgentStreamEvent> {
    request = { ...request, skill_id: skillId };
    yield {
      type: "start",
      intent: "skill",
      conversation_id: request.conversation_id || "",
      skill_id: skillId
    };
    yield {
      type: "delta",
      text: `正在执行：${skillId}\n`,
      stage: "workflow_start",
      skill_id: skillId
    };
    const payload = await this.runLocalWorkflowSkill(skillId, request, trace);
    const resultText = this.extractStreamPreviewText(payload);
    if (resultText.trim()) {
      yield {
        type: "delta",
        text: resultText,
        stage: "workflow_result",
        skill_id: skillId,
        cache_id: String(payload.skill_result?.data?.cache_id || ""),
        target_paths: this.resolveSavedPaths(payload.skill_result || { status: "done", result: "", saved_path: "", data: {} })
      };
    }
    yield {
      type: "final",
      payload
    };
  }

  private async *streamSkillPlan(skillPlan: SkillPlan, request: AgentRunRequest): AsyncGenerator<AgentStreamEvent> {
    const steps = skillPlan.steps.slice(0, 4);
    yield {
      type: "start",
      intent: "skill",
      conversation_id: request.conversation_id || "",
      skill_id: steps[0]?.skill_id || "",
      current_skill: steps[0]?.name || steps[0]?.skill_id || "",
      skill_steps: steps,
      skill_plan: skillPlan,
      selected_reason: skillPlan.selected_reason,
      confidence: skillPlan.confidence
    };
    yield {
      type: "delta",
      text: `当前技能：${steps[0]?.name || steps[0]?.skill_id || "智能编排"}\n`,
      stage: "skill_plan_start",
      skill_id: steps[0]?.skill_id || ""
    };
    const payload = await this.runSkillPlan(skillPlan, request);
    const resultText = this.extractStreamPreviewText(payload);
    if (resultText.trim()) {
      yield {
        type: "delta",
        text: resultText,
        stage: "skill_plan_result",
        skill_id: String(payload.skill_result?.data?.skill_id || steps.at(-1)?.skill_id || ""),
        target_paths: payload.saved_paths
      };
    }
    yield {
      type: "final",
      payload
    };
  }

  private extractStreamPreviewText(payload: AgentRunResponse): string {
    const data = payload.skill_result?.data || {};
    const result = String(data.result || payload.skill_result?.result || payload.reply || "").trim();
    if (result) {
      return result;
    }
    if (payload.saved_paths?.length) {
      return `已写入 ${payload.saved_paths.length} 个文件：\n${payload.saved_paths.join("\n")}`;
    }
    return "";
  }

  private shouldUseSmartSkillOrchestration(request: AgentRunRequest): boolean {
    return !String(request.skill_id || "").trim() && Boolean(String(request.content || "").trim());
  }

  private async runSkillPlan(skillPlan: SkillPlan, request: AgentRunRequest): Promise<AgentRunResponse> {
    const steps = skillPlan.steps.slice(0, 4);
    const stepRecords: Array<Record<string, unknown>> = [];
    const savedPaths: string[] = [];
    const webSearchSources: WebSearchSource[] = [];
    let lastResult: SkillRunResponse | null = null;
    let lastReply = "";
    let priorOutput = String(request.selection || "").trim();

    for (const [index, step] of steps.entries()) {
      const skillRequest = this.buildPlannedSkillRequest(step, request, priorOutput);
      try {
        const result = await this.runSkill(step.skill_id, skillRequest);
        lastResult = result;
        const resultText = String(result.data?.result || result.result || result.content || "").trim();
        const stepSavedPaths = this.resolveSavedPaths(result);
        savedPaths.push(...stepSavedPaths);
        const stepSources = Array.isArray(result.data?.web_search_sources)
          ? (result.data.web_search_sources as WebSearchSource[])
          : [];
        webSearchSources.push(...stepSources);
        stepRecords.push({
          index: index + 1,
          skill_id: step.skill_id,
          name: step.name,
          status: "done",
          reason: step.reason,
          confidence: step.confidence,
          saved_paths: stepSavedPaths,
          result_preview: resultText.slice(0, 800)
        });
        priorOutput = resultText || priorOutput;
        lastReply = resultText || (stepSavedPaths.length ? `已写入 ${stepSavedPaths.length} 个文件：\n${stepSavedPaths.join("\n")}` : `${step.name || step.skill_id} 已完成。`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        stepRecords.push({
          index: index + 1,
          skill_id: step.skill_id,
          name: step.name,
          status: "error",
          reason: step.reason,
          confidence: step.confidence,
          error: message
        });
        const reply = `技能 ${step.name || step.skill_id} 执行失败：${message}`;
        const conversation = await this.recordSkillExchange(
          { ...request, skill_id: step.skill_id },
          reply,
          {
            skill_plan: skillPlan,
            skill_steps: stepRecords,
            current_skill: step.name || step.skill_id,
            selected_reason: skillPlan.selected_reason,
            confidence: skillPlan.confidence
          }
        );
        return {
          intent: "skill",
          reply,
          conversation,
          results: [],
          skill_result: {
            status: "done",
            result: reply,
            saved_path: "",
            data: {
              skill_id: step.skill_id,
              skill_plan: skillPlan,
              skill_steps: stepRecords,
              error: message
            }
          },
          saved_paths: [],
          requires_confirmation: false,
          current_skill: step.name || step.skill_id,
          skill_steps: steps,
          skill_plan: skillPlan,
          selected_reason: skillPlan.selected_reason,
          confidence: skillPlan.confidence
        };
      }
    }

    const finalStep = steps.at(-1);
    const uniqueSavedPaths = uniquePaths(savedPaths);
    const sources = uniqueWebSearchSources(webSearchSources);
    const reply = this.buildSkillPlanReply(lastReply, stepRecords, uniqueSavedPaths);
    const conversation = await this.recordSkillExchange(
      { ...request, skill_id: finalStep?.skill_id || "" },
      reply,
      {
        skill_plan: skillPlan,
        skill_steps: stepRecords,
        current_skill: finalStep?.name || finalStep?.skill_id || "",
        selected_reason: skillPlan.selected_reason,
        confidence: skillPlan.confidence,
        ...(sources.length ? { web_search_sources: sources } : {})
      }
    );
    const skillResult = this.decorateSkillPlanResult(lastResult, skillPlan, stepRecords, reply, uniqueSavedPaths, sources);
    return {
      intent: "skill",
      reply,
      conversation,
      results: [],
      skill_result: skillResult,
      saved_paths: uniqueSavedPaths,
      requires_confirmation: false,
      web_search_sources: sources,
      current_skill: finalStep?.name || finalStep?.skill_id || "",
      skill_steps: steps,
      skill_plan: skillPlan,
      selected_reason: skillPlan.selected_reason,
      confidence: skillPlan.confidence
    };
  }

  private buildPlannedSkillRequest(step: SkillPlanStep, request: AgentRunRequest, priorOutput: string): SkillRunRequest {
    const instruction = [step.instruction || request.content || "", step.reason ? `调度理由：${step.reason}` : ""].filter(Boolean).join("\n");
    const selection = String(step.text || priorOutput || request.selection || "").trim();
    const base = this.buildSkillRequest(step.skill_id, {
      ...request,
      content: instruction || request.content || "",
      selection
    });
    return {
      ...base,
      text: selection || base.text,
      instruction: instruction || base.instruction,
      write_result: base.write_result || this.shouldWriteSkillResult(instruction),
      ...this.pickPlannedSkillPassthrough(request),
      suppress_conversation_record: true
    };
  }

  private pickPlannedSkillPassthrough(request: AgentRunRequest): Record<string, unknown> {
    const source = request as Record<string, unknown>;
    const keys = [
      "action",
      "auto_revision",
      "score_threshold",
      "book_title",
      "source_book_id",
      "source_book_ids",
      "custom_prompt",
      "genre_hint",
      "output_mode",
      "write_result",
      "target_path",
      "target_words",
      "chapter",
      "end_chapter"
    ];
    const picked: Record<string, unknown> = {};
    for (const key of keys) {
      if (source[key] !== undefined) {
        picked[key] = source[key];
      }
    }
    return picked;
  }

  private buildSkillPlanReply(lastReply: string, stepRecords: Array<Record<string, unknown>>, savedPaths: string[]): string {
    const failed = stepRecords.find((step) => step.status === "error");
    if (failed) {
      return `技能 ${String(failed.name || failed.skill_id)} 执行失败：${String(failed.error || "未知错误")}`;
    }
    if (lastReply.trim()) {
      return lastReply.trim();
    }
    if (savedPaths.length) {
      return `已写入 ${savedPaths.length} 个文件：\n${savedPaths.join("\n")}`;
    }
    const names = stepRecords.map((step) => String(step.name || step.skill_id)).filter(Boolean);
    return names.length ? `已完成：${names.join(" -> ")}` : "已完成。";
  }

  private decorateSkillPlanResult(
    result: SkillRunResponse | null,
    skillPlan: SkillPlan,
    stepRecords: Array<Record<string, unknown>>,
    reply: string,
    savedPaths: string[],
    webSearchSources: WebSearchSource[]
  ): SkillRunResponse {
    const baseData = result?.data && typeof result.data === "object" ? result.data : {};
    return {
      status: result?.status || "done",
      result: result?.result || reply,
      saved_path: result?.saved_path || savedPaths[0] || "",
      data: {
        ...baseData,
        skill_plan: skillPlan,
        skill_steps: stepRecords,
        selected_reason: skillPlan.selected_reason,
        confidence: skillPlan.confidence,
        saved_paths: savedPaths,
        ...(webSearchSources.length ? { web_search_sources: webSearchSources } : {})
      },
      ...(result?.job ? { job: result.job } : {}),
      ...(result?.ok !== undefined ? { ok: result.ok } : {}),
      ...(result?.content !== undefined ? { content: result.content } : {})
    };
  }

  private async runLocalSkillIntent(skillId: string, request: AgentRunRequest): Promise<AgentRunResponse> {
    request = { ...request, skill_id: skillId };
    const skillRequest = this.buildSkillRequest(skillId, request);
    const result = await this.skillRunner.runSkill(skillId, skillRequest);
    const savedPaths = this.resolveSavedPaths(result);

    let reply = result.result || "技能已完成。";
    if (savedPaths.length) {
      reply = `已写入 ${savedPaths.length} 个文件：\n${savedPaths.join("\n")}`;
    }
    const conversation = await this.recordSkillExchange(request, reply);

    return {
      intent: "skill",
      reply,
      conversation,
      results: [],
      skill_result: result,
      saved_paths: savedPaths,
      requires_confirmation: false
    };
  }

  private async runLocalWorkflowSkill(skillId: string, request: AgentRunRequest, trace?: AgentTraceRecorder): Promise<AgentRunResponse> {
    request = { ...request, skill_id: skillId };
    const handler = getWorkflowHandler(skillId);
    if (handler) {
      return handler.runAgent(request, this.buildWorkflowContext(trace));
    }
    if (!isWorkflowSkillId(skillId)) {
      throw new Error(`TS runtime 尚未接管该 workflow skill: ${skillId}`);
    }

    if (skillId === "nuwa_style_distill") {
      const result = await this.runNuwaStyleDistillSkill({
        text: request.selection || "",
        chapter: 0,
        end_chapter: 0,
        target_words: 2500,
        instruction: request.content || "蒸馏当前拆书文风",
        target_path: "",
        conversation_id: request.conversation_id || "",
        source_path: request.current_path || "",
        write_result: true,
        attachment_ids: request.attachment_ids || []
      });
      const reply = result.result || (result.data?.profile ? "蒸馏完成。" : "Nuwa 蒸馏档案已更新。");
      return {
        intent: "skill",
        reply,
        conversation: await this.recordSkillExchange(request, reply),
        results: [],
        skill_result: result,
        saved_paths: result.saved_path ? [result.saved_path] : [],
        requires_confirmation: false
      };
    }

    if (skillId === "book_fusion") {
      const result = await this.runBookFusionSkill(request);
      const savedPaths = this.resolveSavedPaths(result);
      const reply = savedPaths.length ? `融梗方案已生成：\n${savedPaths.join("\n")}` : result.result || "融梗方案已生成。";
      return {
        intent: "skill",
        reply,
        conversation: await this.recordSkillExchange(request, reply),
        results: [],
        skill_result: result,
        saved_paths: savedPaths,
        requires_confirmation: false
      };
    }

    if (skillId === "disassemble_book") {
      const action = String((request as any).action || "").trim();
      if (action === "list_library") {
        const books = await this.listDisassembleBooks({ includeLegacy: true });
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
              skill_id: skillId,
              books
            }
          },
          saved_paths: [],
          requires_confirmation: false
        };
      }
      if (action === "archive_source") {
        const source = await this.resolveWorkflowSourceText(request);
        if (!source.trim()) {
          throw new Error("缺少可归档的拆书原文");
        }
        const book = await this.createDisassembleBook({
          title: await this.inferDisassembleBookTitle(request, source),
          sourceText: source,
          sourcePath: request.current_path || "",
          origin: request.attachment_ids?.length ? "upload" : request.current_path ? "document" : "input"
        });
        const books = await this.listDisassembleBooks({ includeLegacy: true });
        const reply = `已归档拆书原文：${book.title}`;
        return {
          intent: "skill",
          reply,
          conversation: await this.recordSkillExchange(request, reply),
          results: [],
          skill_result: {
            status: "done",
            result: reply,
            saved_path: book.paths.source || "",
            data: {
              skill_id: skillId,
              book,
              books,
              saved_paths: book.paths.source ? [book.paths.source] : []
            }
          },
          saved_paths: book.paths.source ? [book.paths.source] : [],
          requires_confirmation: false
        };
      }
    }

    if (skillId === "continue_disassemble") {
      const sourceBook = await this.resolveDisassembleBookForRequest(request);
      const source = sourceBook ? await this.readDisassembleBookText(sourceBook, "reverse_outline", 30_000) : await this.resolveContinueDisassembleSource(request);
      if (!source.trim()) {
        throw new Error("缺少可继续拆解的反向细纲");
      }

      const result = await this.skillRunner.runSkill("outline_generate", {
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
      });

      const book = await this.createDisassembleBook({
        title: String((request as any).book_title || sourceBook?.title || "").trim() || (await this.inferDisassembleBookTitle(request, source)),
        sourceText: source,
        sourcePath: sourceBook?.source_path || request.current_path || "",
        origin: sourceBook?.legacy ? "continue_disassemble:legacy" : "continue_disassemble"
      });
      const detailPath = `${book.dir}/拆书细纲.txt`;
      await this.documents.saveDocument(detailPath, result.result || "", {
        source: "skill",
        summary: "继续拆细纲"
      });
      await this.documents.saveDocument(LEGACY_DISASSEMBLE_DETAIL_PATH, result.result || "", {
        source: "skill",
        summary: "继续拆细纲 legacy 同步"
      });
      const updatedBook = await this.writeDisassembleBookManifest({
        ...book,
        updated_at: new Date().toISOString(),
        paths: {
          ...book.paths,
          detail_outline: detailPath
        }
      });

      const savedPaths = [detailPath];
      const reply = `已写入 ${savedPaths.length} 个文件：\n${savedPaths.join("\n")}`;
      const conversation = await this.recordSkillExchange(request, reply);

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
            skill_id: skillId,
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

    const existingBook = await this.resolveDisassembleBookForRequest(request);
    const directSource = await this.resolveWorkflowSourceText(request);
    const source = directSource.trim() || (existingBook ? await this.readDisassembleBookText(existingBook, "source", 80_000) : "");
    if (!source.trim()) {
      throw new Error("拆书需要上传文件、来源文件或直接输入文本");
    }
    const book = await this.createDisassembleBook({
      title: String((request as any).book_title || existingBook?.title || "").trim() || (await this.inferDisassembleBookTitle(request, source)),
      sourceText: source,
      sourcePath: existingBook?.source_path || request.current_path || "",
      origin: request.attachment_ids?.length ? "upload" : request.current_path ? "document" : existingBook?.origin || "input"
    });

    const lore = await this.skillRunner.runSkill("lore_extract", {
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
    });
    const reverseOutline = await this.skillRunner.runSkill("reverse_outline_extract", {
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
    });

    const lorePath = `${book.dir}/拆书设定提取.txt`;
    const reversePath = `${book.dir}/反向细纲.txt`;
    await this.documents.saveDocument(lorePath, lore.result || "", {
      source: "skill",
      summary: "拆书写入设定"
    });
    await this.documents.saveDocument(reversePath, reverseOutline.result || "", {
      source: "skill",
      summary: "拆书写入反向细纲"
    });
    await this.documents.saveDocument(LEGACY_DISASSEMBLE_LORE_PATH, lore.result || "", {
      source: "skill",
      summary: "拆书写入设定 legacy 同步"
    });
    await this.documents.saveDocument(LEGACY_REVERSE_OUTLINE_PATH, reverseOutline.result || "", {
      source: "skill",
      summary: "拆书写入反向细纲 legacy 同步"
    });
    const updatedBook = await this.writeDisassembleBookManifest({
      ...book,
      updated_at: new Date().toISOString(),
      paths: {
        ...book.paths,
        lore: lorePath,
        reverse_outline: reversePath
      }
    });

    const savedPaths = [lorePath, reversePath];
    const reply = `已写入 ${savedPaths.length} 个文件：\n${savedPaths.join("\n")}`;
    const conversation = await this.recordSkillExchange(request, reply);

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
          skill_id: skillId,
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

  private async runNuwaStyleDistillSkill(payload: SkillRunRequest): Promise<SkillRunResponse> {
    const action = String((payload as any).action || "distill").trim();
    if (action === "status") {
      return {
        status: "done",
        result: "",
        saved_path: "",
        data: {
          skill_id: "nuwa_style_distill",
          profile: await readProjectStyleDistillation(this.documents.projectRoot)
        }
      };
    }

    if (action === "delete") {
      await deleteProjectStyleDistillation(this.documents.projectRoot);
      return {
        status: "done",
        result: "已删除当前蒸馏书籍，后续生成将恢复使用普通风格库。",
        saved_path: "",
        data: {
          skill_id: "nuwa_style_distill",
          profile: null,
          deleted: true
        }
      };
    }

    if (action === "toggle") {
      const current = await readProjectStyleDistillation(this.documents.projectRoot);
      if (!current) {
        throw new Error("当前项目还没有蒸馏书籍");
      }
      const enabled = Boolean((payload as any).enabled);
      const profile = await writeProjectStyleDistillation(this.documents.projectRoot, {
        ...current,
        enabled
      });
      return {
        status: "done",
        result: enabled ? "已启用蒸馏文风，生成内容将强制使用该档案。" : "已停用蒸馏文风，生成内容将恢复使用普通风格库。",
        saved_path: "",
        data: {
          skill_id: "nuwa_style_distill",
          profile
        }
      };
    }

    const source = await this.resolveNuwaDistillationSource(payload);
    if (!source.text.trim()) {
      throw new Error("蒸馏需要当前文档、附件、拆书原文或已有拆书产物");
    }

    const config = await loadModelConfig(this.config, "primary");
    if (!config.configured) {
      throw new Error("未配置主线路 API Key 或模型名，无法执行 Nuwa 蒸馏。");
    }

    const systemPrompt = [
      "你是 Nuwa 小说文风蒸馏器。任务不是模仿具体句子，而是把一本书的写作方式提炼成可复用的创作规则。",
      "你需要蒸馏表达 DNA、叙事心智模型、场景决策启发式、常用描写手法、对白习惯、节奏控制、反模式和诚实边界。",
      "输出必须服务于后续小说生成：清楚、可执行、可约束，不复述剧情，不抄写原文长句。",
      "只输出中文文风档案正文，不要免责声明。"
    ].join("\n");
    const userPrompt = [
      `【书籍名称】${source.bookTitle}`,
      `【来源】${source.sourcePath || "当前输入"}`,
      "",
      "请按以下结构输出：",
      "1. 表达DNA：句长、词性偏好、感官密度、语气温度、叙述视角。",
      "2. 叙事心智模型：如何开场、推进冲突、安排转折、处理信息差。",
      "3. 描写手法：人物、动作、环境、心理、战斗或日常场景的写法。",
      "4. 对白规则：角色说话方式、潜台词、停顿、冲突对白的处理。",
      "5. 节奏启发式：什么时候加速、什么时候留白、章节钩子如何落点。",
      "6. 反模式：后续生成时要避免哪些套话、腔调、过度解释和不属于这本文风的写法。",
      "7. 可操作规则：给后续生成模型的硬性文风指令，必须具体可执行。",
      "",
      "要求：不要输出原文大段摘录；不要泛泛而谈；每条规则都要能直接约束大纲、章纲和正文生成。",
      "",
      `【待蒸馏文本】\n${source.text.slice(0, 60_000)}`
    ].join("\n");

    const raw = String(
      await this.modelClient.requestCompletion(
        config,
        [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt }
        ] satisfies ChatCompletionMessage[],
        Math.max(0.2, Math.min(0.65, config.temperature))
      )
    ).trim();
    if (!raw) {
      throw new Error("模型未返回蒸馏档案");
    }

    const profile: StyleDistillationProfile = await writeProjectStyleDistillation(this.documents.projectRoot, {
      book_title: source.bookTitle,
      source_summary: source.summary,
      source_path: source.sourcePath,
      source_hash: createHash("sha256").update(source.text).digest("hex").slice(0, 16),
      distilled_at: new Date().toISOString(),
      enabled: true,
      profile_text: raw
    });

    return {
      status: "done",
      result: `已蒸馏：${profile.book_title}`,
      saved_path: "00_设定集/.agent/style_distillation/current.json",
      data: {
        skill_id: "nuwa_style_distill",
        profile,
        saved_paths: ["00_设定集/.agent/style_distillation/current.json"]
      }
    };
  }

  private async runBookFusionSkill(request: AgentRunRequest): Promise<SkillRunResponse> {
    const sourceBookIds = uniquePaths(stringListFromUnknown((request as any).source_book_ids));
    if (sourceBookIds.length < 3) {
      throw new Error("融梗至少需要选择三本已拆书籍");
    }
    const customPrompt = String((request as any).custom_prompt || request.content || "").trim();
    const genreHint = String((request as any).genre_hint || "").trim();
    const outputMode = String((request as any).output_mode || "candidate").trim();
    const books = await this.loadBooksForFusion(sourceBookIds);
    if (books.length < 3) {
      throw new Error("融梗只能选择已经完成拆书的文件夹，且至少需要三本");
    }

    const continuity = await buildProjectContinuityContext(this.documents.projectRoot);
    const config = await loadModelConfig(this.config, "primary");
    if (!config.configured) {
      throw new Error("未配置主线路 API Key 或模型名，无法执行融梗。");
    }

    const fusionId = `${formatBookTimestamp(new Date())}-${createHash("sha1").update(sourceBookIds.join("|") + customPrompt + genreHint).digest("hex").slice(0, 8)}`;
    const fusionDir = `${FUSION_LIBRARY_DIR}/${fusionId}`;
    const sourceBooksText = books
      .map((book, index) => [
        `【书籍 ${index + 1}】${book.title}`,
        `【来源】${book.source_path || book.dir || "已拆书籍"}`,
        `【拆书设定】\n${book.lore || "无"}`,
        `【反向细纲】\n${book.reverseOutline || "无"}`,
        `【拆书细纲】\n${book.detailOutline || "无"}`
      ].join("\n"))
      .join("\n\n");

    const systemPrompt = [
      "你是小说融梗编辑器。任务是参考多本书的核心设定和剧情结构，抽象融合出一个新的原创方案。",
      "必须避免原文句式、专有名词、可识别桥段和人物关系的直接复写，只能提炼共性结构、冲突机制、人物驱动力与题材骨架。",
      "融合时要优先保留高层逻辑、冲突张力、题材魅力和可持续展开性，不能做简单拼接。",
      "输出必须可直接用于后续大纲或设定生成，且只输出中文正文，不要免责声明。"
    ].join("\n");
    const userPrompt = [
      `【输出模式】${outputMode}`,
      `【用户提示词】${customPrompt || "无"}`,
      `【题材提示】${genreHint || "无"}`,
      "",
      `【当前题材库】\n${clipForConsistency(JSON.stringify(continuity.genre), 12000) || "暂无题材库"}`,
      "",
      "请按以下结构输出融合候选方案：",
      "1. 融合后核心设定：世界基调、能力/规则、人物群像、冲突底层逻辑。",
      "2. 融合后剧情骨架：开局、升级/推进路径、关键反转、阶段性目标、收束方向。",
      "3. 可复用题材匹配点：哪些题材元素被吸收，哪些被主动舍弃。",
      "4. 原创化约束：明确列出哪些东西不能直接照抄，哪些必须重写。",
      "5. 后续可展开方向：适合继续拆成大纲/细纲/章纲的切入点。",
      "",
      "要求：至少综合三本书的优点，但不能出现“把 A+B+C 拼起来”的痕迹；必须像一个全新项目的起点。",
      "",
      "【待融合书籍资料】",
      sourceBooksText
    ].join("\n");

    const raw = String(
      await this.modelClient.requestCompletion(
        config,
        [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt }
        ] satisfies ChatCompletionMessage[],
        Math.max(0.2, Math.min(0.55, config.temperature))
      )
    ).trim();

    if (!raw) {
      throw new Error("模型未返回融梗候选方案");
    }

    await fs.mkdir(path.join(this.documents.projectRoot, FUSION_LIBRARY_DIR, fusionId), { recursive: true });
    const fusionManifest: Record<string, unknown> = {
      id: fusionId,
      dir: fusionDir,
      source_book_ids: sourceBookIds,
      source_books: books.map((book) => ({
        id: book.id,
        title: book.title,
        dir: book.dir,
        source_path: book.source_path,
        source_summary: book.source_summary
      })),
      custom_prompt: customPrompt,
      genre_hint: genreHint,
      output_mode: outputMode,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      result_path: `${fusionDir}/融梗候选.txt`
    };

    await this.documents.saveDocument(`${fusionDir}/融梗候选.txt`, raw, {
      source: "skill",
      summary: "融梗候选方案"
    });
    await this.documents.saveDocument(`${fusionDir}/融梗提示词.txt`, customPrompt || "无", {
      source: "skill",
      summary: "融梗提示词"
    });
    await this.documents.saveDocument(`${fusionDir}/来源书籍.jsonl`, `${JSON.stringify(fusionManifest.source_books || [])}\n`, {
      source: "skill",
      summary: "融梗来源书籍"
    });
    await this.documents.saveDocument(`${fusionDir}/${BOOK_MANIFEST_PATH}`, `${JSON.stringify(fusionManifest)}\n`, {
      source: "skill",
      summary: "融梗 manifest"
    });

    return {
      status: "done",
      result: raw,
      saved_path: `${fusionDir}/融梗候选.txt`,
      data: {
        skill_id: "book_fusion",
        fusion_id: fusionId,
        fusion_dir: fusionDir,
        source_book_ids: sourceBookIds,
        source_books: fusionManifest.source_books,
        custom_prompt: customPrompt,
        genre_hint: genreHint,
        output_mode: outputMode,
        saved_paths: [
          `${fusionDir}/融梗候选.txt`,
          `${fusionDir}/融梗提示词.txt`,
          `${fusionDir}/来源书籍.jsonl`,
          `${fusionDir}/${BOOK_MANIFEST_PATH}`
        ]
      }
    };
  }

  private async createDisassembleBook(input: { title: string; sourceText: string; sourcePath: string; origin: string }): Promise<DisassembleBookManifest> {
    const createdAt = new Date().toISOString();
    const bookId = `${sanitizeBookId(input.title)}-${formatBookTimestamp(new Date())}-${randomUUID().replace(/-/g, "").slice(0, 8)}`;
    const dir = `${DISASSEMBLE_LIBRARY_DIR}/${bookId}`;
    const manifest: DisassembleBookManifest = {
      id: bookId,
      title: input.title || "当前拆书书籍",
      dir,
      created_at: createdAt,
      updated_at: createdAt,
      origin: input.origin,
      source_path: input.sourcePath || "",
      source_summary: summarizeSource(input.sourceText),
      chars: input.sourceText.length,
      paths: {
        source: input.sourceText.trim() ? `${dir}/原文.txt` : ""
      }
    };
    if (input.sourceText.trim()) {
      await this.documents.saveDocument(`${dir}/原文.txt`, input.sourceText, {
        source: "skill",
        summary: `拆书原文：${manifest.title}`
      });
    }
    await this.writeDisassembleBookManifest(manifest);
    return manifest;
  }

  private async writeDisassembleBookManifest(book: DisassembleBookManifest): Promise<DisassembleBookManifest> {
    const next: DisassembleBookManifest = {
      ...book,
      updated_at: new Date().toISOString()
    };
    await this.documents.saveDocument(`${next.dir}/${BOOK_MANIFEST_PATH}`, `${JSON.stringify(next)}\n`, {
      source: "skill",
      summary: `拆书书籍 manifest：${next.title}`
    });
    return next;
  }

  private async listDisassembleBooks(options: { includeLegacy?: boolean } = {}): Promise<Array<DisassembleBookManifest & { legacy?: boolean }>> {
    const root = path.join(this.documents.projectRoot, DISASSEMBLE_LIBRARY_DIR);
    const books: Array<DisassembleBookManifest & { legacy?: boolean }> = [];
    const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const dir = `${DISASSEMBLE_LIBRARY_DIR}/${entry.name}`;
      const manifest = await this.readDisassembleBookManifest(dir).catch(() => null);
      if (manifest) {
        books.push(manifest);
      }
    }

    if (options.includeLegacy) {
      const legacy = await this.readLegacyDisassembleBookManifest();
      if (legacy) {
        books.push({ ...legacy, legacy: true });
      }
    }

    return books.sort((left, right) => {
      const leftAt = Date.parse(left.updated_at || left.created_at || "");
      const rightAt = Date.parse(right.updated_at || right.created_at || "");
      return rightAt - leftAt;
    });
  }

  private async readDisassembleBookManifest(bookDir: string): Promise<DisassembleBookManifest> {
    const manifestPath = `${bookDir}/${BOOK_MANIFEST_PATH}`;
    const raw = String(await this.documents.readRawText(manifestPath, 50_000)).trim();
    if (!raw) {
      throw new Error("缺少拆书 manifest");
    }
    const parsed = JSON.parse(raw.split(/\r?\n/)[0] || "{}") as Partial<DisassembleBookManifest>;
    if (!parsed.id || !parsed.title) {
      throw new Error("拆书 manifest 不完整");
    }
    return {
      id: parsed.id,
      title: parsed.title,
      dir: parsed.dir || bookDir,
      created_at: parsed.created_at || new Date().toISOString(),
      updated_at: parsed.updated_at || parsed.created_at || new Date().toISOString(),
      origin: parsed.origin || "unknown",
      source_path: parsed.source_path || "",
      source_summary: parsed.source_summary || "",
      chars: Number(parsed.chars || 0),
      paths: parsed.paths || {}
    };
  }

  private async readLegacyDisassembleBookManifest(): Promise<DisassembleBookManifest | null> {
    const lore = await this.readLegacyText(LEGACY_DISASSEMBLE_LORE_PATH);
    const reverseOutline = await this.readLegacyText(LEGACY_REVERSE_OUTLINE_PATH);
    const detailOutline = await this.readLegacyText(LEGACY_DISASSEMBLE_DETAIL_PATH);
    if (!lore && !reverseOutline && !detailOutline) {
      return null;
    }
    const title = "历史拆书产物";
    return {
      id: "legacy",
      title,
      dir: "",
      created_at: new Date(0).toISOString(),
      updated_at: new Date().toISOString(),
      origin: "legacy",
      source_path: "",
      source_summary: summarizeSource([lore, reverseOutline, detailOutline].filter(Boolean).join("\n")),
      chars: [lore, reverseOutline, detailOutline].join("\n").length,
      paths: {
        lore: lore ? LEGACY_DISASSEMBLE_LORE_PATH : "",
        reverse_outline: reverseOutline ? LEGACY_REVERSE_OUTLINE_PATH : "",
        detail_outline: detailOutline ? LEGACY_DISASSEMBLE_DETAIL_PATH : ""
      }
    };
  }

  private async resolveDisassembleBookForRequest(request: AgentRunRequest): Promise<(DisassembleBookManifest & { legacy?: boolean }) | null> {
    const explicitId = String((request as any).source_book_id || "").trim();
    if (explicitId) {
      if (explicitId === "legacy") {
        return this.readLegacyDisassembleBookManifest();
      }
      return (await this.listDisassembleBooks({ includeLegacy: false })).find((book) => book.id === explicitId) || null;
    }

    const currentPath = String(request.current_path || "").replace(/\\/g, "/").trim();
    const matched = currentPath.match(new RegExp(`^${DISASSEMBLE_LIBRARY_DIR.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/([^/]+)/`));
    if (matched?.[1]) {
      const books = await this.listDisassembleBooks({ includeLegacy: false });
      const found = books.find((book) => book.id === matched[1]);
      if (found) {
        return found;
      }
    }

    const books = await this.listDisassembleBooks({ includeLegacy: true });
    return books[0] || null;
  }

  private async loadBooksForFusion(sourceBookIds: string[]): Promise<Array<DisassembleBookManifest & { legacy?: boolean; lore?: string; reverseOutline?: string; detailOutline?: string }>> {
    const books = await this.listDisassembleBooks({ includeLegacy: true });
    const selected: Array<DisassembleBookManifest & { legacy?: boolean; lore?: string; reverseOutline?: string; detailOutline?: string }> = [];
    for (const id of sourceBookIds) {
      const book = books.find((item) => item.id === id);
      if (!book) {
        continue;
      }
      if (!this.isDisassembleBookReadyForFusion(book)) {
        continue;
      }
      selected.push({
        ...book,
        lore: await this.readDisassembleBookText(book, "lore", 24_000),
        reverseOutline: await this.readDisassembleBookText(book, "reverse_outline", 24_000),
        detailOutline: await this.readDisassembleBookText(book, "detail_outline", 24_000)
      });
    }
    return selected;
  }

  private isDisassembleBookReadyForFusion(book: DisassembleBookManifest & { legacy?: boolean }): boolean {
    return Boolean(book.paths.lore || book.paths.reverse_outline || book.paths.detail_outline);
  }

  private async readDisassembleBookText(
    book: DisassembleBookManifest & { legacy?: boolean },
    kind: "source" | "lore" | "reverse_outline" | "detail_outline",
    limit = 24_000
  ): Promise<string> {
    const legacyPath =
      kind === "lore"
        ? LEGACY_DISASSEMBLE_LORE_PATH
        : kind === "reverse_outline"
          ? LEGACY_REVERSE_OUTLINE_PATH
          : kind === "detail_outline"
            ? LEGACY_DISASSEMBLE_DETAIL_PATH
            : "";
    if (book.legacy || book.id === "legacy") {
      return this.readLegacyText(legacyPath, limit);
    }
    const relPath =
      kind === "source"
        ? book.paths.source || `${book.dir}/原文.txt`
        : kind === "lore"
          ? book.paths.lore || `${book.dir}/拆书设定提取.txt`
          : kind === "reverse_outline"
            ? book.paths.reverse_outline || `${book.dir}/反向细纲.txt`
            : book.paths.detail_outline || `${book.dir}/拆书细纲.txt`;
    return this.readLegacyText(relPath, limit);
  }

  private async readLegacyText(relativePath: string, limit = 24_000): Promise<string> {
    if (!relativePath) {
      return "";
    }
    try {
      return (await this.documents.readRawText(relativePath, limit)).trim();
    } catch {
      return "";
    }
  }

  private async inferDisassembleBookTitle(request: AgentRunRequest, source: string): Promise<string> {
    const explicit = String((request as any).book_title || "").trim();
    if (explicit) {
      return explicit;
    }
    const sourcePath = String(request.current_path || request.source_path || "").trim();
    if (sourcePath) {
      return inferBookTitle(sourcePath, "当前拆书书籍");
    }
    const content = String(source || request.content || "").trim();
    const firstLine = content.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || "";
    return inferBookTitle(firstLine, "当前拆书书籍");
  }

  private async resolveNuwaDistillationSource(payload: SkillRunRequest): Promise<{ text: string; bookTitle: string; sourcePath: string; summary: string }> {
    const direct = String(payload.text || "").trim();
    const explicitTitle = String((payload as any).book_title || "").trim();
    if (direct) {
      const sourcePath = String(payload.source_path || "").trim();
      return {
        text: direct,
        bookTitle: explicitTitle || inferBookTitle(sourcePath, "当前文档"),
        sourcePath,
        summary: summarizeSource(direct)
      };
    }

    if (payload.conversation_id && (payload.attachment_ids || []).length) {
      const attachments = await this.conversations.getAttachmentTexts(payload.conversation_id, payload.attachment_ids, {
        limit: DISASSEMBLE_SOURCE_IMPORT_CHARS,
        preserveWhitespace: true
      });
      const parts = attachments
        .map(([attachment, body]) => {
          const content = String(body || "").trim();
          return content ? { name: attachment.name, content } : null;
        })
        .filter((item): item is { name: string; content: string } => Boolean(item));
      if (parts.length) {
        const text = parts.map((item) => `【${item.name}】\n${item.content}`).join("\n\n");
        return {
          text,
          bookTitle: explicitTitle || parts[0]!.name.replace(/\.[^.]+$/, ""),
          sourcePath: parts.map((item) => item.name).join(", "),
          summary: summarizeSource(text)
        };
      }
    }

    const sourcePath = String(payload.source_path || "").trim();
    if (sourcePath) {
      try {
        const text = (await this.documents.readRawText(sourcePath, DISASSEMBLE_SOURCE_IMPORT_CHARS)).trim();
        if (text) {
          return {
            text,
            bookTitle: explicitTitle || inferBookTitle(sourcePath, "当前文档"),
            sourcePath,
            summary: summarizeSource(text)
          };
        }
      } catch {}
    }

    const fallbackPaths = ["01_大纲/反向细纲.txt", "00_设定集/设定集/拆书设定提取.txt", "01_大纲/拆书细纲.txt"];
    const fallbackParts: string[] = [];
    for (const relPath of fallbackPaths) {
      try {
        const text = (await this.documents.readRawText(relPath, 30_000)).trim();
        if (text) {
          fallbackParts.push(`【${relPath}】\n${text}`);
        }
      } catch {}
    }
    const text = fallbackParts.join("\n\n").trim();
    return {
      text,
      bookTitle: explicitTitle || "当前拆书书籍",
      sourcePath: fallbackPaths.join(", "),
      summary: summarizeSource(text)
    };
  }

  private buildSkillRequest(skillId: string, request: AgentRunRequest): SkillRunRequest {
    const chapter = this.resolveSkillChapter(skillId, request);
    const endChapter = this.resolveSkillEndChapter(skillId, request, chapter);
    const sourcePath = this.resolveSkillSourcePath(skillId, request);
    return {
      text: String(request.selection || "").trim(),
      chapter,
      end_chapter: endChapter,
      target_words: this.resolveTargetWords(request.content || ""),
      source_path: sourcePath,
      instruction: request.content || "",
      conversation_id: request.conversation_id || "",
      write_result: this.shouldWriteSkillResult(request.content || ""),
      attachment_ids: request.attachment_ids || [],
      target_path: ""
    };
  }

  private shouldWriteSkillResult(text: string): boolean {
    return /(同步|写入|保存|更新|替换|覆盖|落到|写回|补充|补全|完善|补齐|填充|配置|设置|设定|建立|创建)/.test(text);
  }

  private mentionsCurrentSource(text: string): boolean {
    return /(当前文档|当前正文|这篇|这章|这段|选中|选区|光标|打开的文档|正在编辑)/.test(text);
  }

  private resolveSkillSourcePath(skillId: string, request: AgentRunRequest): string {
    const text = request.content || "";
    const sourceText = String(request.selection || "").trim();
    const hasAttachments = Boolean((request.attachment_ids || []).length);
    const currentPath = String(request.current_path || "").replace(/\\/g, "/").trim().replace(/^\/+/, "");
    const needsSource = new Set([
      "detail_outline_generate",
      "chapter_outline_generate",
      "body_generate",
      "polish_text",
      "story_deslop",
      "reverse_outline_extract",
      "style_extract",
      "lore_extract",
      "continue_text"
    ]);

    if (!needsSource.has(skillId) || sourceText || hasAttachments) {
      return "";
    }

    if (currentPath && this.mentionsCurrentSource(text)) {
      return currentPath;
    }
    if (skillId === "detail_outline_generate") {
      return this.firstReadablePath(["01_大纲/大纲.txt"]);
    }
    if (skillId === "chapter_outline_generate") {
      if (/大纲/.test(text) && !/细纲/.test(text)) {
        return this.firstReadablePath(["01_大纲/大纲.txt"]);
      }
      return this.firstReadablePath(["01_大纲/细纲.txt", "01_大纲/大纲.txt"]);
    }
    if (skillId === "body_generate") {
      if (/细纲/.test(text) && !/章纲/.test(text)) {
        return this.firstReadablePath(["01_大纲/细纲.txt", "01_大纲/大纲.txt"]);
      }
      if (/大纲/.test(text) && !/(章纲|细纲)/.test(text)) {
        return this.firstReadablePath(["01_大纲/大纲.txt"]);
      }
      return this.firstReadablePath(["01_大纲/章纲.txt", "01_大纲/细纲.txt", "01_大纲/大纲.txt"]);
    }

    const named = this.resolveNamedSourcePath(text);
    if (named) {
      return named;
    }
    return currentPath;
  }

  private firstReadablePath(paths: string[]): string {
    return paths[0] || "";
  }

  private resolveNamedSourcePath(text: string): string {
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

  private async resolveBodyChapterOutline(request: AgentRunRequest, chapter: number): Promise<string> {
    const direct = String(request.selection || "").trim();
    if (direct && /第\s*\d+\s*章|章纲|目标|冲突/.test(direct)) {
      return direct;
    }
    for (const relPath of ["01_大纲/章纲.txt", "01_大纲/细纲.txt", "01_大纲/大纲.txt"]) {
      try {
        const text = (await this.documents.readRawText(relPath, 12_000)).trim();
        if (!text) {
          continue;
        }
        const extracted = this.extractChapterSection(text, chapter);
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

  private extractChapterSection(text: string, chapter: number): string {
    const lines = String(text || "").split(/\r?\n/);
    const hits: string[] = [];
    let capture = false;
    for (const line of lines) {
      const current = this.resolveChapterNumber(line);
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

  private async buildWorkflowWebSearchContext(instruction: string, contextHint: string, compact: boolean): Promise<{ context: string; sources: WebSearchSource[] }> {
    const config = await loadWebSearchConfig(this.config);
    const triggerText = `${instruction || ""}\n${contextHint || ""}`;
    if (!config.enabled || !shouldUseWebSearch(triggerText)) {
      return { context: "None", sources: [] };
    }

    try {
      const query = buildWorkflowWebSearchQuery(instruction, contextHint);
      if (!query) {
        return { context: "None", sources: [] };
      }
      const results = await this.webSearchClient.search(query, config);
      return {
        context: formatWebSearchContext(results, compact ? Math.min(config.context_chars, 1600) : config.context_chars),
        sources: summarizeWebSearchSources(results)
      };
    } catch {
      return { context: "None", sources: [] };
    }
  }

  private async applyBodyDeslop(text: string, chapter: number): Promise<{ text: string; changed: boolean }> {
    const config = await loadModelConfig(this.config, "primary");
    if (!config.configured || !text.trim()) {
      return { text, changed: false };
    }
    const systemPrompt =
      "你是 story-deslop 去AI味编辑。任务：检测并清除网文文本里的 AI 写作痕迹，让文字回到自然、有人味的状态。" +
      "只输出处理后的正文本体，不输出报告、解释、标题或免责声明。";
    const userPrompt = [
      "【处理模式】正文去AI味",
      `【上下文提示】第 ${chapter} 章正文自动后处理`,
      "",
      "请对下面文本执行 story-deslop 去AI味。只输出处理后的文本本体。",
      "",
      `【待处理文本】\n${text.slice(0, 30000)}`
    ].join("\n");
    try {
      const raw = String(
        await this.modelClient.requestCompletion(
          config,
          [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt }
          ] satisfies ChatCompletionMessage[],
          Math.max(0.2, Math.min(0.7, config.temperature))
        )
      ).trim();
      const cleaned = raw.replace(/^```(?:text|markdown|md)?\s*/i, "").replace(/\s*```$/, "").trim();
      if (!cleaned) {
        return { text, changed: false };
      }
      return { text: cleaned, changed: cleaned !== text.trim() };
    } catch {
      return { text, changed: false };
    }
  }

  private async resolveConsistencyChapterOutline(request: AgentRunRequest): Promise<string> {
    const direct = String(request.project_context_hint || "").trim();
    if (direct) {
      return direct;
    }
    for (const relPath of ["01_大纲/章纲.txt", "01_大纲/细纲.txt", "01_大纲/大纲.txt"]) {
      try {
        const text = await this.documents.readRawText(relPath, 5000);
        if (text.trim()) {
          return text.trim();
        }
      } catch {
        continue;
      }
    }
    return "";
  }

  private async resolveContinueDisassembleSource(request: AgentRunRequest): Promise<string> {
    const direct = String(request.selection || "").trim();
    if (direct) {
      return direct;
    }
    try {
      return (await this.documents.readRawText("01_大纲/反向细纲.txt", 20_000)).trim();
    } catch {
      return "";
    }
  }

  private resolveSkillChapter(skillId: string, request: AgentRunRequest): number {
    const chapter = this.resolveChapterNumber(request.content || "") || this.resolveChapterNumber(request.current_path || "");
    if (skillId === "body_generate" && chapter <= 0) {
      return 1;
    }
    return chapter;
  }

  private resolveSkillEndChapter(skillId: string, request: AgentRunRequest, chapter: number): number {
    if (skillId !== "batch_generate") {
      return 0;
    }
    const [startChapter, endChapter] = this.resolveChapterRange(request.content || "");
    if (startChapter > 0) {
      return endChapter;
    }
    return chapter > 0 ? chapter : 0;
  }

  private resolveChapterNumber(text: string): number {
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

  private resolveChapterRange(text: string): [number, number] {
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

  private resolveTargetWords(text: string): number {
    const match = /(\d{3,5})\s*(?:字|词|words?\b)/i.exec(text || "");
    if (!match) {
      return 2500;
    }
    const value = Number.parseInt(match[1] || "2500", 10);
    return Math.max(300, Math.min(20000, value));
  }

  private resolveSavedPaths(result: SkillRunResponse): string[] {
    const fromData = Array.isArray(result.data?.saved_paths)
      ? result.data.saved_paths.filter((item): item is string => typeof item === "string" && item.length > 0)
      : [];
    if (fromData.length) {
      return fromData;
    }
    return result.saved_path ? [result.saved_path] : [];
  }

  private async resolveWorkflowSourceText(request: AgentRunRequest): Promise<string> {
    const direct = String(request.selection || "").trim();
    if (direct) {
      return direct;
    }
    if (request.conversation_id && (request.attachment_ids || []).length) {
      const attachments = await this.conversations.getAttachmentTexts(request.conversation_id, request.attachment_ids, {
        limit: DISASSEMBLE_SOURCE_IMPORT_CHARS,
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
    const sourcePath = this.resolveSkillSourcePath("lore_extract", request);
    if (sourcePath) {
      try {
        return (await this.documents.readRawText(sourcePath, DISASSEMBLE_SOURCE_IMPORT_CHARS)).trim();
      } catch {
        return "";
      }
    }
    return "";
  }

  private async recordSkillExchange(
    request: AgentRunRequest,
    reply: string,
    assistantMetadata: Record<string, unknown> = {}
  ): Promise<ConversationDetail | undefined> {
    if ((request as any).suppress_conversation_record === true) {
      return request.conversation_id ? await this.conversations.getConversation(request.conversation_id).catch(() => undefined) : undefined;
    }
    const userText = String(request.content || "").trim();
    if (!userText) {
      return undefined;
    }

    let detail = request.conversation_id
      ? await this.conversations.getConversation(request.conversation_id).catch(() => null)
      : null;

    if (!detail) {
      detail = await this.conversations.createConversation({
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

    await this.conversations.saveConversation(nextDetail);
    if ((nextDetail.messages.length >= 10 && !nextDetail.summary) || nextDetail.messages.length % 6 === 0) {
      nextDetail = await this.conversations.summarizeConversation(nextDetail.id);
    }
    return nextDetail;
  }

  async sendMessage(
    conversationId: string,
    payload: ConversationMessageRequest
  ): Promise<{ conversation: ConversationDetail; reply: string; saved_path: string; web_search_sources?: import("./web-search.js").WebSearchSource[]; skill_result?: SkillRunResponse }> {
    await this.validateConversationWriteBackRequest(payload);
    const request = this.conversationPayloadToAgentRequest(conversationId, payload);
    await this.attachCurrentSkillToRequest(request, payload.skill_id || "");
    let agentResponse = await this.runAgent(request);
    if (payload.write_target?.trim()) {
      const writeMode = resolveConversationWriteBackMode(payload);
      const savedPath = await this.writeConversationReplyBack(payload.write_target, agentResponse.reply, writeMode, Boolean(payload.confirm_write));
      const conversation = agentResponse.conversation
        ? await this.appendConversationWriteBackMessage(agentResponse.conversation.id, savedPath, writeMode)
        : agentResponse.conversation;
      agentResponse = {
        ...agentResponse,
        conversation,
        saved_paths: uniquePaths([...(agentResponse.saved_paths || []), savedPath])
      };
    }
    return {
      conversation: agentResponse.conversation!,
      reply: agentResponse.reply,
      saved_path: agentResponse.saved_paths[0] || "",
      web_search_sources: agentResponse.web_search_sources,
      skill_result: agentResponse.skill_result || undefined
    };
  }

  async *streamMessage(
    conversationId: string,
    payload: ConversationMessageRequest
  ): AsyncGenerator<AgentStreamEvent> {
    await this.validateConversationWriteBackRequest(payload);
    const agentRequest = this.conversationPayloadToAgentRequest(conversationId, payload);
    await this.attachCurrentSkillToRequest(agentRequest, payload.skill_id || "");
    for await (const event of this.streamAgentRun(agentRequest)) {
      if (event.type === "final") {
        let payloadResponse = event.payload;
        if (payload.write_target?.trim()) {
          const writeMode = resolveConversationWriteBackMode(payload);
          const savedPath = await this.writeConversationReplyBack(payload.write_target, payloadResponse.reply, writeMode, Boolean(payload.confirm_write));
          const conversation = payloadResponse.conversation
            ? await this.appendConversationWriteBackMessage(payloadResponse.conversation.id, savedPath, writeMode)
            : payloadResponse.conversation;
          payloadResponse = {
            ...payloadResponse,
            conversation,
            saved_paths: uniquePaths([...(payloadResponse.saved_paths || []), savedPath])
          };
        }
        yield {
          ...event,
          payload: payloadResponse
        };
        continue;
      }
      yield event;
    }
  }

  private conversationPayloadToAgentRequest(conversationId: string, payload: ConversationMessageRequest): AgentRunRequest {
    return {
      conversation_id: conversationId,
      content: payload.content || "",
      current_path: "",
      selection: "",
      project_context_hint: payload.runtime_context || "",
      skill_id: payload.skill_id || "",
      attachment_ids: payload.attachment_ids || []
    };
  }

  private async attachCurrentSkillToRequest(request: AgentRunRequest, explicitSkillId: string): Promise<void> {
    if (String(explicitSkillId || "").trim()) {
      (request as any).current_skill = explicitSkillId.trim();
      return;
    }
    if (!request.conversation_id) {
      return;
    }
    const detail = await this.conversations.getConversation(request.conversation_id).catch(() => null);
    (request as any).current_skill = detail?.current_skill || "";
  }

  private async validateConversationWriteBackRequest(payload: ConversationMessageRequest): Promise<void> {
    const target = String(payload.write_target || "").trim();
    if (!target) {
      return;
    }
    if (payload.insert_mode === "none") {
      throw new Error("写回目标已设置，但 insert_mode 为 none。请先选择追加或覆盖。");
    }
    const insertMode = resolveConversationWriteBackMode(payload);
    if (insertMode !== "replace" || payload.confirm_write) {
      return;
    }
    try {
      const doc = await this.documents.readDocument(target);
      if (String(doc.content || "").trim()) {
        throw new Error("覆盖写入已有文档需要 confirm_write=true。");
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes("confirm_write")) {
        throw error;
      }
    }
  }

  private async writeConversationReplyBack(targetPath: string, reply: string, insertMode: "append" | "replace", confirmWrite: boolean): Promise<string> {
    const target = String(targetPath || "").trim();
    if (!target) {
      return "";
    }
    let existing = "";
    let exists = false;
    try {
      const doc = await this.documents.readDocument(target);
      existing = doc.content || "";
      exists = true;
    } catch {
      existing = "";
    }
    if (insertMode === "replace" && exists && existing.trim() && !confirmWrite) {
      throw new Error("覆盖写入已有文档需要 confirm_write=true。");
    }
    const content = insertMode === "append" && existing.trim()
      ? `${existing.trimEnd()}\n\n${String(reply || "").trim()}`
      : String(reply || "").trim();
    await this.documents.saveDocument(target, content, { source: "agent" });
    return target;
  }

  private async appendConversationWriteBackMessage(conversationId: string, savedPath: string, insertMode: "append" | "replace"): Promise<ConversationDetail> {
    let detail = await this.conversations.getConversation(conversationId);
    const now = new Date().toISOString();
    detail = {
      ...detail,
      updated_at: now,
      messages: [
        ...detail.messages,
        {
          id: randomUUID().replace(/-/g, ""),
          role: "system",
          content: `已写回 ${savedPath}`,
          created_at: now,
          metadata: {
            write_target: savedPath,
            insert_mode: insertMode
          }
        }
      ],
      message_count: detail.messages.length + 1
    };
    return this.conversations.saveConversation(detail);
  }

  async draftSkillFromUrl(payload: SkillDraftFromUrlRequest): Promise<SkillDraftResponse> {
    return this.skillRunner.draftSkillFromUrl(payload);
  }

  async generateCardDraw(payload: CardDrawRequest, progress: (v: number, m: string) => void): Promise<CardDrawResult> {
    const request = payload;
    const drawId = randomUUID().replace(/-/g, "").slice(0, 12);
    const cardDrawTargets: Record<string, string> = {
      outline: "01_大纲/大纲.txt",
      detail_outline: "01_大纲/细纲.txt",
      chapter_outline: "01_大纲/章纲.txt"
    };
    const defaultTargetPath = request.mode === "body"
      ? `02_正文/第${String(request.chapter).padStart(3, "0")}章.txt`
      : (cardDrawTargets[request.mode] || "");
    const targetPath = (request.target_path || "").trim() || defaultTargetPath;

    progress(0.02, "准备抽卡上下文");

    let doneCount = 0;
    const generateOne = async (index: number) => {
      const generated = await this.generateCardCandidate(request, index, request.candidate_count, targetPath);
      doneCount += 1;
      progress(0.08 + (doneCount / request.candidate_count) * 0.72, `候选 ${doneCount}/${request.candidate_count} 已生成`);
      return { index, ...generated };
    };

    const tasks = Array.from({ length: request.candidate_count }, (_, i) => generateOne(i + 1));
    const results = await Promise.all(tasks);

    const candidates: CardDrawCandidate[] = [];
    const webSearchSources: WebSearchSource[] = [];
    for (const res of results.sort((a, b) => a.index - b.index)) {
      const content = res.content.trim();
      webSearchSources.push(...res.web_search_sources);
      if (!content) {
        throw new Error(`候选 ${res.index} 为空`);
      }
      const candidatePath = `00_设定集/抽卡候选/${drawId}/候选${String(res.index).padStart(2, "0")}.txt`;
      await this.documents.saveDocument(candidatePath, content, {
        source: "card_draw",
        summary: `抽卡候选 ${res.index}`
      });
      candidates.push({
        id: `candidate_${String(res.index).padStart(2, "0")}`,
        path: candidatePath,
        chars: content.length,
        excerpt: getExcerpt(content, 260)
      });
    }

    const result: CardDrawResult = {
      draw_id: drawId,
      mode: request.mode,
      target_path: targetPath,
      start_chapter: request.mode === "chapter_outline" ? request.start_chapter : 0,
      chapter_count: request.mode === "chapter_outline" ? request.chapter_count : 0,
      section_words: request.mode === "chapter_outline" ? request.section_words : 0,
      candidates
    };
    const resultWithSources = {
      ...result,
      web_search_sources: uniqueWebSearchSources(webSearchSources)
    };

    const manifestPath = getCardDrawManifestPath(this.documents.projectRoot, drawId);
    await fs.mkdir(path.dirname(manifestPath), { recursive: true });
    await fs.writeFile(manifestPath, JSON.stringify(result, null, 2), "utf8");

    progress(1.0, "抽卡候选已生成");
    return resultWithSources;
  }

  async selectCardDraw(drawId: string, payload: CardDrawSelectRequest): Promise<unknown> {
    const manifestPath = getCardDrawManifestPath(this.documents.projectRoot, drawId);
    let rawManifest: string;
    try {
      rawManifest = await fs.readFile(manifestPath, "utf8");
    } catch {
      throw new Error("抽卡记录不存在");
    }
    const manifest = JSON.parse(rawManifest);

    const candidateId = payload.candidate_id.trim();
    const selected = manifest.candidates.find((c: any) => c.id === candidateId);
    if (!selected) {
      throw new Error("候选不存在");
    }
    const targetPath = (payload.target_path || "").trim() || manifest.target_path;
    const content = await this.documents.readRawText(selected.path);

    let savedPath = "";
    if (manifest.mode === "chapter_outline" && Number(manifest.start_chapter || 0) > 0) {
      savedPath = await this.saveCardDrawChapterOutline(
        targetPath,
        content,
        Number(manifest.start_chapter || 1),
        Number(manifest.chapter_count || 1),
        candidateId
      );
    } else {
      await this.documents.saveDocument(targetPath, content, {
        source: "card_draw",
        summary: `抽卡选中：${candidateId}`
      });
      savedPath = targetPath;
    }

    const rejected = manifest.candidates
      .filter((c: any) => c.id !== candidateId)
      .map((c: any) => c.path);

    const archived = await this.documents.archiveDocuments(rejected, {
      source: "card_draw",
      summary: `抽卡未选候选归档：${drawId}`
    });

    manifest.selected_id = candidateId;
    manifest.selected_path = selected.path;
    manifest.target_path = savedPath;
    manifest.archived_paths = archived;

    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

    return {
      ok: true,
      draw_id: drawId,
      selected_id: candidateId,
      selected_path: selected.path,
      target_path: savedPath,
      archived_paths: archived
    };
  }

  private async generateCardCandidate(request: CardDrawRequest, index: number, total: number, targetPath: string): Promise<{ content: string; web_search_sources: WebSearchSource[] }> {
    const variantInstruction = getCardDrawVariantInstruction(request, index, total);
    if (request.mode === "body") {
      return this.generateBodyCardCandidate(request, variantInstruction, targetPath);
    }
    if (request.mode === "chapter_outline") {
      return { content: await this.generateChapterOutlineCardCandidate(request, variantInstruction), web_search_sources: [] };
    }
    const cardDrawSkills: Record<string, string> = {
      outline: "outline_generate",
      detail_outline: "detail_outline_generate",
      chapter_outline: "chapter_outline_generate"
    };
    const skillId = cardDrawSkills[request.mode];
    if (!skillId) {
      throw new Error(`不支持的抽卡模式: ${request.mode}`);
    }
    return { content: await this.generatePromptCardCandidate(skillId, request, variantInstruction), web_search_sources: [] };
  }

  private async generateBodyCardCandidate(request: CardDrawRequest, instruction: string, targetPath: string): Promise<{ content: string; web_search_sources: WebSearchSource[] }> {
    const config = await loadModelConfig(this.config, "primary");
    if (!config.configured) {
      throw new Error("未配置主线路 API Key 或模型名。");
    }

    let chapterOutline = (request.text || "").trim();
    if (!chapterOutline && request.source_path) {
      try {
        chapterOutline = await this.documents.readRawText(request.source_path, 30000);
      } catch {}
    }
    if (!chapterOutline) {
      chapterOutline = await this.resolveBodyChapterOutline({
        selection: "",
        content: "",
        attachment_ids: [],
        conversation_id: "",
        current_path: request.source_path || ""
      } as any, request.chapter);
    }

    const continuity = await buildProjectContinuityContext(this.documents.projectRoot);
    const ledger = await this.documents.getLedger().catch(() => []);
    const openLedger = ledger
      .filter((item) => item.status === "open")
      .slice(0, 20)
      .map((item, index) => `${index + 1}. ${item.desc}`)
      .join("\n");

    const lower = Math.trunc((request.target_words || 2500) * 0.92);
    const upper = Math.trunc((request.target_words || 2500) * 1.12);
    const webSearch = await this.buildWorkflowWebSearchContext(
      instruction,
      [chapterOutline, continuity.state_summary, JSON.stringify(continuity.genre)].join("\n"),
      false
    );
    const systemPrompt =
      "你是长篇网文正文写作智能体。文章连续性是最高优先级，必须严格服从设定、章纲和上一章结尾。\n" +
      "不得擅自新增主线、境界、科技词、人物关系或与题材不符的概念。\n" +
      "输出只能是正文，不要解释、不要分点、不要免责声明。\n" +
      `字数强约束：正文有效字数必须落在 ${lower}-${upper} 字附近，不能用水话凑字。`;

    const userPrompt = [
      `请生成第 ${request.chapter} 章正文。`,
      `用户补充指令：${instruction}`,
      "",
      `【本章章纲】\n${clipForConsistency(chapterOutline, 8000)}`,
      "",
      `【四层设定集】\n${clipForConsistency(JSON.stringify(continuity.lore), 12000)}`,
      "",
      buildStyleGenreConstraintBlock(continuity.style, continuity.genre, { bodyPhase: true }),
      "",
      `【联网搜索小说素材】\n${webSearch.context}`,
      "",
      `【伏笔账本】\n${openLedger || "无开放伏笔"}`,
      "如果用户补充指令明确要求填坑、回收伏笔或兑现线索，必须优先自然完成；否则这里只作为连续性约束，避免生硬堆入正文。",
      "",
      `【项目状态摘要】\n${clipForConsistency(continuity.state_summary, 8000)}`,
      "",
      `【最近两章正文】\n${clipForConsistency(continuity.previous_chapters.map((item) => item.content).join("\n"), 9000)}`,
      "",
      "请从上一章结尾自然承接，严格完成本章章纲。"
    ].join("\n");

    const temp = config.temperature ?? 0.7;
    const drawTemp = Math.min(1.0, Math.max(0.45, temp + 0.08));

    const result = String(
      await this.modelClient.requestCompletion(
        config,
        [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt }
        ] satisfies ChatCompletionMessage[],
        drawTemp
      )
    ).trim();

    if (!result) {
      throw new Error("模型未返回正文候选");
    }

    const deslopped = await this.applyBodyDeslop(result, request.chapter);
    return { content: deslopped.text, web_search_sources: webSearch.sources };
  }

  private async generateChapterOutlineCardCandidate(request: CardDrawRequest, instruction: string): Promise<string> {
    let text = (request.text || "").trim();
    if (!text && request.source_path) {
      try {
        text = await this.documents.readRawText(request.source_path, 30000);
      } catch {}
    }
    const rangeInstruction = [
      instruction,
      "",
      `【硬性格式】从第 ${String(request.start_chapter).padStart(3, "0")} 章开始，连续输出 ${request.chapter_count} 个章节小纲。`,
      `每章约 ${request.section_words} 字，章节标题统一使用“第XXX章：标题”。`,
      "每章都包含：本章目标、主要剧情、冲突推进、伏笔/回收、结尾钩子。"
    ].join("\n");

    const result = await this.skillRunner.runSkill("chapter_outline_generate", {
      text,
      chapter: 0,
      end_chapter: 0,
      target_words: 2500,
      instruction: rangeInstruction,
      target_path: "",
      conversation_id: "",
      source_path: text ? "" : (request.source_path || ""),
      write_result: false,
      attachment_ids: []
    });

    return result.result || "";
  }

  private async generatePromptCardCandidate(skillId: string, request: CardDrawRequest, instruction: string): Promise<string> {
    let text = (request.text || "").trim();
    if (!text && request.source_path) {
      try {
        text = await this.documents.readRawText(request.source_path, 30000);
      } catch {}
    }
    const result = await this.skillRunner.runSkill(skillId, {
      text,
      chapter: 0,
      end_chapter: 0,
      target_words: 2500,
      instruction,
      target_path: "",
      conversation_id: "",
      source_path: text ? "" : (request.source_path || ""),
      write_result: false,
      attachment_ids: []
    });
    return result.result || "";
  }

  private async saveCardDrawChapterOutline(
    targetPath: string,
    content: string,
    startChapter: number,
    chapterCount: number,
    candidateId: string
  ): Promise<string> {
    const target = (targetPath || "").trim() || "01_大纲/章纲.txt";
    const newBlock = (content || "").trim();
    if (!newBlock) {
      throw new Error("选中的章纲候选为空");
    }
    const endChapter = startChapter + Math.max(1, chapterCount) - 1;
    let existing = "";
    try {
      existing = await this.documents.readRawText(target);
    } catch {}

    let nextContent = "";
    if (existing.trim()) {
      const replaced = replaceChapterOutlineRange(existing, newBlock, startChapter, endChapter);
      nextContent = replaced !== null ? replaced : existing.trimEnd() + "\n\n" + newBlock + "\n";
    } else {
      nextContent = newBlock + "\n";
    }

    await this.documents.saveDocument(target, nextContent, {
      source: "card_draw",
      summary: `抽卡选中章纲：${candidateId}（第 ${String(startChapter).padStart(3, "0")}-${String(endChapter).padStart(3, "0")} 章）`
    });
    return target;
  }
}

function inferBookTitle(sourcePath: string, fallback: string): string {
  const normalized = String(sourcePath || "").replace(/\\/g, "/").trim();
  const filename = normalized.split("/").filter(Boolean).at(-1) || "";
  const stem = filename.replace(/\.[^.]+$/, "").trim();
  return stem || fallback;
}

function sanitizeBookId(value: string): string {
  const sanitized = String(value || "")
    .replace(/[\\/:*?"<>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[^0-9A-Za-z\u4e00-\u9fa5_-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 42);
  return sanitized || "book";
}

function formatBookTimestamp(date: Date): string {
  return date.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
}

function stringListFromUnknown(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item) => String(item || "").trim()).filter(Boolean);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function webSearchSourcesFromUnknown(value: unknown): WebSearchSource[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => (isRecord(item) ? { title: String(item.title || "").trim(), url: String(item.url || "").trim() } : null))
    .filter((item): item is WebSearchSource => Boolean(item?.title && /^https?:\/\//i.test(item.url)));
}

function readTraceMode(value: unknown): "replace" | "append" | undefined {
  return value === "replace" || value === "append" ? value : undefined;
}

function agentRequestInputChars(request: AgentRunRequest): number {
  return [
    request.content,
    request.selection,
    request.project_context_hint,
    request.current_path,
    ...(request.attachment_ids || [])
  ].reduce((total, item) => total + String(item || "").length, 0);
}

function skillRequestInputChars(request: SkillRunRequest): number {
  return [
    request.instruction,
    request.text,
    request.source_path,
    request.target_path,
    ...(request.attachment_ids || [])
  ].reduce((total, item) => total + String(item || "").length, 0);
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths.map((item) => item.trim()).filter(Boolean))];
}

function summarizeSource(text: string): string {
  const compact = String(text || "").replace(/\s+/g, " ").trim();
  if (!compact) {
    return "";
  }
  return compact.length <= 240 ? compact : `${compact.slice(0, 240).trimEnd()}...`;
}

function clipForConsistency(text: string, limit: number): string {
  const normalized = String(text || "").trim();
  if (normalized.length <= limit) {
    return normalized;
  }
  return normalized.slice(0, limit).trimEnd();
}

function safeJsonObject(value: string): Record<string, unknown> {
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

function resolveConversationWriteBackMode(payload: ConversationMessageRequest): "append" | "replace" {
  return payload.insert_mode === "append" ? "append" : "replace";
}

function getCardDrawManifestPath(projectRoot: string, drawId: string): string {
  if (!/^[a-f0-9]{8,32}$/i.test(drawId)) {
    throw new Error("非法抽卡 ID");
  }
  return path.join(projectRoot, "00_设定集", ".agent", "card_draw", `${drawId}.json`);
}

function getCardDrawVariantInstruction(request: CardDrawRequest, index: number, total: number): string {
  const base = request.instruction || "按当前项目上下文生成。";
  const modeRules: Record<string, string> = {
    outline: "本候选必须是一份完整大纲文件，可直接覆盖 01_大纲/大纲.txt；不要只输出片段、提纲说明或改写建议。",
    detail_outline: "本候选必须是一份完整细纲文件，可直接覆盖 01_大纲/细纲.txt；需要从开局到当前规划形成完整连续方案。",
    chapter_outline: `本候选只生成第 ${String(request.start_chapter).padStart(3, "0")} 章到第 ${String(request.start_chapter + request.chapter_count - 1).padStart(3, "0")} 章的章纲片段，共 ${request.chapter_count} 章。每个小章节约 ${request.section_words} 字，必须有标题、剧情目标、冲突推进、伏笔/回收、结尾钩子。只输出章纲正文，不要输出说明文字。`,
    body: `本候选必须是一整章正文，对应第 ${String(request.chapter).padStart(3, "0")} 章，可直接写入正文文件。`
  };
  return `${base}\n\n【抽卡要求】这是第 ${index}/${total} 个候选。必须和其他候选形成明显差异，但不得违背既定设定、题材规则、章纲事实和前文连续性。只输出可直接写入文件的内容。\n【模式规则】${modeRules[request.mode] || ""}`;
}

function getExcerpt(text: string, limit: number): string {
  const compact = (text || "").trim().replace(/\s+/g, " ");
  return compact.length <= limit ? compact : compact.slice(0, limit).trimEnd() + "...";
}

function replaceChapterOutlineRange(existing: string, newBlock: string, startChapter: number, endChapter: number): string | null {
  const heading = /^\s*第\s*0*(\d{1,4})\s*章[^\n]*/gm;
  const matches: Array<{ num: number; start: number; end: number }> = [];
  let match;
  heading.lastIndex = 0;
  while ((match = heading.exec(existing)) !== null) {
    matches.push({
      num: parseInt(match[1] || "", 10),
      start: match.index,
      end: heading.lastIndex
    });
  }
  if (!matches.length) {
    return null;
  }
  const inRange = matches.filter((item) => item.num >= startChapter && item.num <= endChapter);
  if (!inRange.length) {
    return null;
  }
  const blockStart = inRange[0]!.start;
  const lastMatch = inRange[inRange.length - 1]!;
  let blockEnd = existing.length;
  for (const item of matches) {
    if (item.start > lastMatch.start && item.num > endChapter) {
      blockEnd = item.start;
      break;
    }
  }
  const prefix = existing.slice(0, blockStart).trimEnd();
  const suffix = existing.slice(blockEnd).trimStart();
  const parts = [prefix, newBlock.trim(), suffix].filter(Boolean);
  return parts.join("\n\n") + "\n";
}
