import type {
  AgentRunRequest,
  AgentRunDeleteResponse,
  AgentRunExport,
  AgentRunResponse,
  AgentRunState,
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
  SkillDraftRequest,
  SkillDraftResponse,
  SkillDefinition,
  SkillPatchResponse,
  GeneratedSavePlan,
  GeneratedCacheMeta
} from "@xiaoshuo/shared";
import { generatedSavePlanSchema, skillRunRequestSchema, skillRunResponseSchema } from "@xiaoshuo/shared";
import { AgentChatRunner, type ChatContextAssemblyObserver } from "./chat-runner.js";
import { classifyAgentIntent, classifySkillManagementIntent, hasSkillAction, isReadContextIntent, rankSkillRoutes, type SkillManagementIntent } from "./intent-router.js";
import { AgentPlanner, type AgentPlannerOptions } from "./planner.js";
import { PromptSkillRunner } from "./skill-runner.js";
import { SkillDraftService } from "./skill-draft-service.js";
import { SkillService } from "@xiaoshuo/skill-service";
import { AgentFileOperationRunner } from "./file-operation-runner.js";
import { ConversationService } from "@xiaoshuo/conversation-service";
import { DocumentService } from "@xiaoshuo/document-service";
import { createHash, randomUUID } from "node:crypto";
import { loadModelConfig, loadWebSearchConfig, type ConfigServiceOptions } from "@xiaoshuo/config-service";
import { OpenAICompatibleClient, type ChatCompletionMessage } from "@xiaoshuo/model-client";
import { buildProjectContinuityContext } from "@xiaoshuo/project-session";
import { ProjectManifestService } from "@xiaoshuo/project-manifest";
import { GeneratedCacheService, type PreparedGeneratedCacheCommit } from "@xiaoshuo/generated-cache";
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
import { isCancellationError, throwIfAborted, type AgentRunOptions } from "./cancellation.js";
import {
  RunCoordinator,
  RunRequestReplayError,
  type DurableRunExecution
} from "./kernel/run-coordinator.js";
import type { AgentFeatureFlagRegistry } from "./kernel/feature-flag-registry.js";
import { CommitJournalService } from "./kernel/commit-journal-service.js";
import { DurableWorkflowCheckpointStore } from "./kernel/workflow-checkpoint.js";
import {
  buildSectionedGeneratedSavePlan,
  isSectionedGeneratedSkillId,
  mergeLoreSectionText,
  LORE_SECTION_TARGETS,
  type SectionedGeneratedSkillId
} from "./sectioned-generated-save.js";

const TARGET_WORD_SKILL_IDS = new Set([
  "body_generate",
  "batch_generate",
  "outline_generate",
  "detail_outline_generate",
  "chapter_outline_generate"
]);
const activeAgentRuntimeServices = new Set<AgentRuntimeService>();

export function closeAllAgentRuntimeServices(): void {
  for (const runtime of [...activeAgentRuntimeServices]) {
    runtime.close();
  }
}

export type GeneratedCacheCommitInput = {
  cache_id?: string;
  content?: string;
  source?: string;
  skill_id?: string;
  mode?: "replace" | "append";
  target_paths?: string[];
  save_plan?: GeneratedSavePlan;
  summary?: string;
  cleanup_content?: boolean;
};

export type GeneratedCacheCommitResult = {
  run_id: string;
  cache_id: string;
  saved_paths: string[];
  journal_ids: string[];
  replayed: boolean;
  cache: GeneratedCacheMeta;
};

export type GeneratedCacheCommitOptions = AgentRunOptions & {
  execution?: DurableRunExecution;
  sectioned?: {
    loreMergeExisting?: boolean;
  };
};

type DeferredPromptSkillCommit = {
  kind: "prompt_skill_generated_cache";
  cache_id: string;
  skill_id: string;
  mode: "replace" | "append";
  target_paths: string[];
  save_plan: GeneratedSavePlan;
  source: string;
  summary: string;
  requires_confirmation: boolean;
  lore_merge_existing: boolean;
};

const DIRECT_SKILL_REQUEST_ORIGIN = "skill_api";

export class AgentRuntimeService {
  private readonly planner: AgentPlanner;
  private readonly skillRunner: PromptSkillRunner;
  private readonly skillDrafts: SkillDraftService;
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
  private readonly runCoordinator: RunCoordinator;
  private readonly commitJournal: CommitJournalService;
  private readonly projectManifest: ProjectManifestService;

  constructor(options: AgentRuntimeOptions) {
    this.config = options.config ?? {};
    this.modelClient = options.modelClient ?? new OpenAICompatibleClient();
    this.webSearchClient = options.webSearchClient ?? new DefaultWebSearchClient();
    this.planner = new AgentPlanner(options);
    this.skillRunner = new PromptSkillRunner(options);
    this.skillDrafts = new SkillDraftService(options);
    this.chatRunner = new AgentChatRunner(options);
    this.runCoordinator = new RunCoordinator({ projectRoot: options.projectRoot, featureFlags: options.featureFlags });
    this.commitJournal = new CommitJournalService({ store: this.runCoordinator.store, projectRoot: options.projectRoot });
    this.fileOperationRunner = new AgentFileOperationRunner({
      planner: this.planner,
      projectRoot: options.projectRoot,
      commitJournal: this.commitJournal
    });
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
    this.projectManifest = new ProjectManifestService(options.projectRoot);
    void this.reconcileCompletedDurableGeneratedCaches().catch(() => undefined);
    if (options.autoRecoverStaleRuns !== false) {
      this.recoverStaleDurableRuns();
    }
    activeAgentRuntimeServices.add(this);
  }

  close(): void {
    this.runCoordinator.close();
    activeAgentRuntimeServices.delete(this);
  }

  async plan(request: AgentPlanRequest, options: AgentRunOptions = {}): Promise<AgentPlanResponse> {
    throwIfAborted(options.signal);
    return this.planner.buildPlan(request, options);
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

  async runSkill(skillId: string, request: SkillRunRequest, options: AgentRunOptions = {}): Promise<SkillRunResponse> {
    throwIfAborted(options.signal);
    const trace = this.createTraceRecorder({
      conversationId: request.conversation_id || "",
      skillId,
      content: request.instruction || request.text || ""
    });
    const startedAt = Date.now();
      this.addSkillRequestContextToTrace(trace, request);
    try {
      trace.mark("workflow_started", { selected_skill_id: skillId });
      const result = await this.runSkillInternal(skillId, request, options);
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
      if (isCancellationError(error, options.signal)) {
        trace.mark("workflow_completed", { selected_skill_id: skillId, cancelled: true });
        await trace.finish({ cancelled: true });
      } else {
        trace.fail(error);
        await trace.finish();
      }
      throw error;
    }
  }

  async runDurableSkill(
    skillId: string,
    request: SkillRunRequest,
    options: AgentRunOptions = {}
  ): Promise<SkillRunResponse> {
    throwIfAborted(options.signal);
    const skill = await this.skills.getSkill(skillId).catch(() => null);
    if (!skill) {
      throw new Error(`未知 skill: ${skillId}`);
    }
    if (skill.disabled) {
      throw new Error(`默认技能已禁用：${skill.name || skillId}。请先恢复后再执行。`);
    }
    if (skill.handler_type !== "prompt" || !(await this.skillRunner.canRunSkillLocally(skillId))) {
      throw codedRuntimeError("DURABLE_SKILL_UNSUPPORTED", `该 skill 不支持 durable Prompt Skill 执行：${skillId}`);
    }

    const durableRequest = buildDurableSkillAgentRequest(skillId, request);
    let execution: DurableRunExecution;
    let effectiveRequest = request;
    try {
      execution = await this.beginDurableSkillRun(skillId, durableRequest, options);
    } catch (error) {
      if (!(error instanceof RunRequestReplayError)) {
        throw error;
      }
      if (error.run.status === "completed") {
        return this.replayDurableSkillResponse(error.run);
      }
      if (error.run.status !== "failed" && error.run.status !== "paused") {
        throw codedRuntimeError(
          "DURABLE_SKILL_IN_PROGRESS",
          `Prompt Skill run ${error.run.run_id} 当前状态为 ${error.run.status}`
        );
      }
      execution = this.runCoordinator.resumeRun(
        error.run.run_id,
        `op_skill_api_${sha256Text(`${error.run.request_id}:${error.run.version}`).slice(0, 24)}`,
        error.run.version,
        { operationType: "retry", signal: options.signal }
      );
      effectiveRequest = durableAgentRequestToSkillRequest(
        this.runCoordinator.getRecoveryRequest(error.run.run_id)
      );
    }

    return this.executeDurableSkillRun(skillId, effectiveRequest, execution, options);
  }

  private async beginDurableSkillRun(
    skillId: string,
    request: AgentRunRequest,
    options: AgentRunOptions
  ): Promise<DurableRunExecution> {
    return this.runCoordinator.beginRun(request, {
      projectId: await this.projectManifest.getProjectId(),
      stepType: "skill",
      actionId: `skill.${skillId}.run`,
      skillId,
      retryable: true,
      requiresConfirmation: false,
      signal: options.signal
    });
  }

  private async executeDurableSkillRun(
    skillId: string,
    request: SkillRunRequest,
    execution: DurableRunExecution,
    options: AgentRunOptions = {}
  ): Promise<SkillRunResponse> {
    const runOptions = { ...options, signal: execution.signal };
    const trace = this.createTraceRecorder({
      conversationId: request.conversation_id || "",
      skillId,
      content: request.instruction || request.text || "",
      runId: execution.run_id,
      requestId: execution.request_id
    });
    const startedAt = Date.now();
    this.addSkillRequestContextToTrace(trace, request);
    try {
      trace.mark("workflow_started", { selected_skill_id: skillId });
      const prepared = await this.skillRunner.runSkill(skillId, request, {
        ...runOptions,
        deferAutoCommit: true,
        deterministicCacheId: deterministicGeneratedCacheId(execution, skillId)
      });
      const result = await this.commitDeferredPromptSkillResult(
        skillId,
        prepared,
        execution,
        runOptions
      );
      this.addSkillResultToTrace(trace, result);
      await this.addModelCallSummaryToTrace(trace, {
        inputChars: skillRequestInputChars(request),
        outputChars: String(result.result || "").length,
        durationMs: Date.now() - startedAt,
        streaming: false
      });
      this.runCoordinator.completeRun(execution, durableSkillAgentResponse(skillId, result));
      await this.finalizeDeferredGeneratedCache(result, execution.run_id, execution.request_id);
      await trace.finish({ saved_paths: this.resolveSavedPaths(result) });
      return result;
    } catch (error) {
      const durableState = this.failDurableRun(execution, error);
      await this.addModelCallSummaryToTrace(trace, {
        inputChars: skillRequestInputChars(request),
        outputChars: 0,
        durationMs: Date.now() - startedAt,
        streaming: false,
        error
      });
      if (durableState === "paused") {
        trace.mark("workflow_completed", { cancelled: false, durable_status: "paused" });
        await trace.finish({ cancelled: false });
      } else if (durableState === "cancelled" || isCancellationError(error, runOptions.signal)) {
        trace.mark("workflow_completed", { cancelled: true, durable_status: durableState });
        await trace.finish({ cancelled: true });
      } else {
        trace.fail(error);
        await trace.finish();
      }
      throw error;
    }
  }

  private async replayDurableSkillResponse(run: AgentRunState): Promise<SkillRunResponse> {
    const step = this.runCoordinator.store.getStep(run.run_id, run.current_step_id);
    const observation = step?.observation_id
      ? this.runCoordinator.store.getObservation(step.observation_id)
      : null;
    const stored = isRecord(observation) ? observation.skill_response : undefined;
    if (!stored) {
      throw codedRuntimeError(
        "DURABLE_SKILL_RESULT_MISSING",
        `Prompt Skill run ${run.run_id} 已完成，但缺少可重放结果`
      );
    }
    const result = skillRunResponseSchema.parse(stored);
    await this.finalizeDeferredGeneratedCache(result, run.run_id, run.request_id);
    return withDurableSkillIdentity(
      result,
      run.run_id,
      run.request_id,
      true
    );
  }

  private getCompletedRunObservation(run: AgentRunState) {
    const step = this.runCoordinator.store.getStep(run.run_id, run.current_step_id);
    return step?.observation_id
      ? this.runCoordinator.store.getObservation(step.observation_id)
      : null;
  }

  private completedRunSkillResponse(run: AgentRunState): SkillRunResponse | null {
    const observation = this.getCompletedRunObservation(run);
    const stored = isRecord(observation) ? observation.skill_response : undefined;
    return stored ? skillRunResponseSchema.parse(stored) : null;
  }

  private async reconcileCompletedAgentRunGeneratedCache(run: AgentRunState): Promise<void> {
    const result = this.completedRunSkillResponse(run);
    if (!result) {
      return;
    }
    await this.finalizeDeferredGeneratedCache(result, run.run_id, run.request_id);
  }

  private async replayCompletedAgentResponse(run: AgentRunState): Promise<AgentRunResponse> {
    const observation = this.getCompletedRunObservation(run);
    if (!observation) {
      throw codedRuntimeError(
        "DURABLE_AGENT_RESULT_MISSING",
        `Agent run ${run.run_id} 已完成，但缺少可重放结果`
      );
    }
    const request = this.runCoordinator.getRecoveryRequest(run.run_id);
    const rawSkillResult = this.completedRunSkillResponse(run);
    if (rawSkillResult) {
      await this.finalizeDeferredGeneratedCache(rawSkillResult, run.run_id, run.request_id);
    }
    const skillResult = rawSkillResult
      ? withDurableSkillIdentity(rawSkillResult, run.run_id, run.request_id, true)
      : undefined;
    const savedPaths = canonicalGeneratedPaths([
      ...stringListFromUnknown(observation.saved_paths),
      ...(skillResult
        ? [
            ...stringListFromUnknown(skillResult.data?.saved_paths),
            skillResult.saved_path || ""
          ]
        : [])
    ]);
    return {
      run_id: run.run_id,
      intent: classifyAgentIntent(request.content || "", request.skill_id || "", []),
      reply: skillResult?.result || observation.summary || "任务已完成。",
      results: [],
      skill_result: skillResult,
      saved_paths: savedPaths,
      requires_confirmation: false,
      current_skill: request.skill_id || undefined
    };
  }

  private async runSkillInternal(skillId: string, request: SkillRunRequest, options: AgentRunOptions = {}): Promise<SkillRunResponse> {
    throwIfAborted(options.signal);
    const skill = await this.skills.getSkill(skillId).catch(() => null);
    if (skill?.disabled) {
      throw new Error(`默认技能已禁用：${skill.name || skillId}。请先恢复后再执行。`);
    }
    const workflowHandler = getWorkflowHandler(skillId);
    if (workflowHandler?.runSkill) {
      return workflowHandler.runSkill(request, this.buildWorkflowContext(undefined, options));
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

      const agentResponse = await this.runLocalWorkflowSkill(skillId, agentRequest, undefined, options);
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
    return this.skillRunner.runSkill(skillId, request, options);
  }

  async canRunAgentLocally(request: AgentRunRequest): Promise<boolean> {
    if (classifySkillManagementIntent(request.content || "")) {
      return true;
    }
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

  async commitGeneratedCache(
    input: GeneratedCacheCommitInput,
    options: GeneratedCacheCommitOptions = {}
  ): Promise<GeneratedCacheCommitResult> {
    throwIfAborted(options.signal);
    const source = String(input.source || "generated_cache").trim() || "generated_cache";
    const requestedSkillId = String(input.skill_id || "").trim();
    const requestedMode = input.mode === "append" || input.mode === "replace" ? input.mode : undefined;
    const rawMode = requestedMode || "replace";
    const requestedTargets = canonicalGeneratedPaths(input.target_paths || []);
    const requestedSavePlan = input.save_plan ? canonicalGeneratedSavePlan(input.save_plan) : undefined;
    let cacheId = String(input.cache_id || "").trim();

    if (!cacheId) {
      const content = String(input.content || "");
      const sectionedSavePlan = isSectionedGeneratedSkillId(requestedSkillId)
        ? canonicalGeneratedSavePlan(buildSectionedGeneratedSavePlan({
            skillId: requestedSkillId,
            result: content,
            mode: rawMode,
            summaryPrefix: sectionedGeneratedSummaryPrefix(requestedSkillId)
          }))
        : undefined;
      const rawTargets = sectionedSavePlan?.target_paths || requestedTargets;
      const rawSavePlan = sectionedSavePlan || requestedSavePlan;
      const rawIntent = {
        schema_version: 1,
        kind: "generated_cache_raw",
        source,
        skill_id: requestedSkillId,
        mode: rawMode,
        target_paths: rawTargets,
        save_plan: rawSavePlan || null,
        content_hash: sha256Text(content)
      };
      cacheId = sha256Text(stableJson(rawIntent)).slice(0, 32);
      const rawCache = await this.cache.createWithId(cacheId, {
        source,
        skill_id: requestedSkillId,
        mode: rawMode,
        target_paths: rawTargets,
        summary: input.summary || "Generated content pending durable commit",
        transient: true,
        save_plan: rawSavePlan
      });
      if (rawCache.status === "pending") {
        const cachedContent = await this.cache.readContent(cacheId);
        if (cachedContent && cachedContent !== content) {
          throw codedRuntimeError("GENERATED_CACHE_CONTENT_CONFLICT", "确定性生成缓存已绑定到不同内容");
        }
        if (cachedContent !== content) {
          await this.cache.replace(cacheId, content);
        }
      }
      if (sectionedSavePlan && !sectionedSavePlan.target_paths.length) {
        const noSaveMeta = rawCache.status === "pending"
          ? await this.cache.discard(cacheId)
          : rawCache;
        return {
          run_id: "",
          cache_id: cacheId,
          saved_paths: [],
          journal_ids: [],
          replayed: rawCache.status !== "pending",
          cache: noSaveMeta
        };
      }
    }

    let meta = await this.cache.get(cacheId);
    const cachedSkillId = String(meta.skill_id || "").trim();
    if (
      requestedSkillId
      && requestedSkillId !== cachedSkillId
      && (Boolean(cachedSkillId) || isSectionedGeneratedSkillId(requestedSkillId))
    ) {
      throw codedRuntimeError(
        "GENERATED_CACHE_SKILL_MISMATCH",
        `生成缓存技能身份不匹配：缓存为 ${cachedSkillId || "(empty)"}，请求为 ${requestedSkillId}`
      );
    }
    const effectiveSkillId = cachedSkillId || requestedSkillId;
    if (meta.status === "committed") {
      return {
        run_id: meta.commit_run_id,
        cache_id: cacheId,
        saved_paths: meta.saved_paths,
        journal_ids: meta.commit_journal_ids,
        replayed: true,
        cache: meta
      };
    }
    if (meta.status !== "pending") {
      throw codedRuntimeError("GENERATED_CACHE_NOT_PENDING", `生成缓存状态为 ${meta.status}，不能提交`);
    }

    const cachedContent = await this.cache.readContent(cacheId);
    const sectionedMode = requestedMode || meta.save_plan?.mode || meta.mode || "replace";
    const sectionedSavePlan = isSectionedGeneratedSkillId(effectiveSkillId)
      ? canonicalGeneratedSavePlan(buildSectionedGeneratedSavePlan({
          skillId: effectiveSkillId,
          result: cachedContent,
          mode: sectionedMode,
          summaryPrefix: sectionedGeneratedSummaryPrefix(effectiveSkillId)
        }))
      : undefined;
    if (sectionedSavePlan) {
      meta = await this.cache.updateSavePlan(cacheId, sectionedSavePlan);
      if (!sectionedSavePlan.target_paths.length) {
        return {
          run_id: "",
          cache_id: cacheId,
          saved_paths: [],
          journal_ids: [],
          replayed: false,
          cache: meta
        };
      }
    }
    const effectiveSavePlan = sectionedSavePlan
      || requestedSavePlan
      || (meta.save_plan ? canonicalGeneratedSavePlan(meta.save_plan) : undefined);
    const commitMode = requestedMode || effectiveSavePlan?.mode || meta.mode || "replace";
    const effectiveTargets = sectionedSavePlan
      ? canonicalGeneratedPaths(sectionedSavePlan.target_paths)
      : requestedTargets.length
        ? requestedTargets
        : canonicalGeneratedPaths(effectiveSavePlan?.target_paths?.length ? effectiveSavePlan.target_paths : meta.target_paths);
    const commitIntent = {
      schema_version: 1,
      kind: "generated_cache_commit",
      cache_id: cacheId,
      mode: commitMode,
      target_paths: effectiveTargets,
      save_plan: effectiveSavePlan || null,
      content_hash: sha256Text(cachedContent)
    };
    const intentHash = sha256Text(stableJson(commitIntent));
    let preparedCommits = effectiveSavePlan
      ? await this.cache.prepareSavePlanCommit(cacheId, effectiveSavePlan, { mode: input.mode })
      : await this.cache.prepareTargetCommit(cacheId, effectiveTargets, { mode: input.mode });
    if (
      effectiveSkillId === "lore_extract"
      && sectionedMode === "replace"
      && options.sectioned?.loreMergeExisting
    ) {
      preparedCommits = await Promise.all(preparedCommits.map(async (commit) => {
        const title = loreSectionTitleForPath(commit.target_path);
        if (!title) {
          return commit;
        }
        const existing = await this.documents.readRawText(commit.target_path).catch(() => "");
        return {
          ...commit,
          content: mergeLoreSectionText(title, existing, commit.content)
        };
      }));
    }
    const sectionedCommitMetadata = sectionedSavePlan && isSectionedGeneratedSkillId(effectiveSkillId)
      ? new Map(sectionedSavePlan.segments.map((segment) => [
          segment.target_path,
          {
            actionKey: `section:${effectiveSkillId}:${segment.target_path}`,
            source: effectiveSkillId === "lore_extract" && sectionedMode === "replace"
              ? "skill"
              : "agent_generated_save",
            summary: segment.reason
          }
        ]))
      : new Map<string, { actionKey: string; source: string; summary: string }>();
    const commits = preparedCommits.map((commit) => {
      const sectioned = sectionedCommitMetadata.get(commit.target_path);
      return sectioned ? { ...commit, action_key: sectioned.actionKey } : commit;
    });
    throwIfAborted(options.signal);

    let execution = options.execution;
    let ownsExecution = false;
    let commitRequestId = execution?.request_id || "";
    if (!execution) {
      const requestId = `req_generated_cache_${intentHash.slice(0, 32)}`;
      commitRequestId = requestId;
      const request: AgentRunRequest = {
        request_id: requestId,
        autonomy_mode: "execute",
        conversation_id: meta.conversation_id || "",
        content: stableJson(commitIntent),
        current_path: commits[0]?.target_path || "",
        selection: "",
        project_context_hint: "",
        skill_id: "generated_cache_commit",
        attachment_ids: [],
        reference_paths: commits.map((commit) => commit.target_path),
        confirmed_reference_paths: commits.map((commit) => commit.target_path),
        disable_auto_references: true
      };
      try {
        execution = this.runCoordinator.beginRun(request, {
          projectId: await this.projectManifest.getProjectId(),
          stepType: "file_operation",
          actionId: "agent.generated_cache_commit",
          skillId: "generated_cache_commit",
          retryable: true,
          requiresConfirmation: false,
          signal: options.signal
        });
      } catch (error) {
        if (!(error instanceof RunRequestReplayError)) {
          throw error;
        }
        const replay = error.run;
        if (replay.status === "completed") {
          const savedPaths = this.runCoordinator.store
            .listObservations(replay.run_id)
            .flatMap((observation) => observation.saved_paths);
          const committed = await this.cache.markCommitted(cacheId, savedPaths, {
            cleanupContent: input.cleanup_content ?? true,
            commitRunId: replay.run_id,
            commitRequestId: requestId,
            commitJournalIds: this.runCoordinator.listCommitJournal(replay.run_id).map((journal) => journal.journal_id)
          });
          return {
            run_id: replay.run_id,
            cache_id: cacheId,
            saved_paths: committed.saved_paths,
            journal_ids: this.runCoordinator.listCommitJournal(replay.run_id).map((journal) => journal.journal_id),
            replayed: true,
            cache: committed
          };
        }
        if (replay.status !== "failed" && replay.status !== "paused") {
          throw codedRuntimeError(
            "GENERATED_CACHE_COMMIT_IN_PROGRESS",
            `生成缓存提交任务 ${replay.run_id} 当前状态为 ${replay.status}`
          );
        }
        execution = this.runCoordinator.resumeRun(
          replay.run_id,
          `op_generated_cache_${sha256Text(`${requestId}:${replay.version}`).slice(0, 24)}`,
          replay.version,
          { operationType: "retry", signal: options.signal }
        );
      }
      ownsExecution = true;
    }

    const journalIds: string[] = [];
    let replayed = commits.length > 0;
    let syntheticRunCompleted = false;
    try {
      for (const commit of commits) {
        throwIfAborted(execution.signal);
        const sectioned = sectionedCommitMetadata.get(commit.target_path);
        const result = await this.writePreparedGeneratedCacheCommit(
          commit,
          execution,
          intentHash,
          sectioned?.source || source,
          sectioned?.summary || input.summary
        );
        journalIds.push(result.journal.journal_id);
        replayed = replayed && result.replayed;
      }
      const savedPaths = commits.map((commit) => commit.target_path);
      if (ownsExecution) {
        this.runCoordinator.completeRun(execution, generatedCacheCommitResponse(cacheId, savedPaths));
        syntheticRunCompleted = true;
      }
      const committed = ownsExecution
        ? await this.cache.markCommitted(cacheId, savedPaths, {
            cleanupContent: input.cleanup_content ?? true,
            commitRunId: execution.run_id,
            commitRequestId,
            commitJournalIds: journalIds
          })
        : await this.cache.get(cacheId);
      return {
        run_id: execution.run_id,
        cache_id: cacheId,
        saved_paths: savedPaths,
        journal_ids: journalIds,
        replayed,
        cache: committed
      };
    } catch (error) {
      if (ownsExecution && !syntheticRunCompleted) {
        this.failDurableRun(execution, error);
      }
      throw error;
    }
  }

  async runAgent(request: AgentRunRequest, options: AgentRunOptions = {}): Promise<AgentRunResponse> {
    throwIfAborted(options.signal);
    let execution: DurableRunExecution;
    try {
      execution = await this.beginDurableRun(request, options);
    } catch (error) {
      if (error instanceof RunRequestReplayError && error.run.status === "completed") {
        return this.replayCompletedAgentResponse(error.run);
      }
      throw error;
    }
    return this.executeDurableAgentRun(request, execution, options);
  }

  async createDurableRun(request: AgentRunRequest): Promise<{ run: AgentRunState; created: boolean }> {
    let execution: DurableRunExecution;
    try {
      execution = await this.beginDurableRun(request, {});
    } catch (error) {
      if (error instanceof RunRequestReplayError) {
        if (error.run.status === "completed") {
          await this.reconcileCompletedAgentRunGeneratedCache(error.run);
        }
        return { run: error.run, created: false };
      }
      throw error;
    }
    const run = this.runCoordinator.getRun(execution.run_id)!;
    void this.executeDurableAgentRun(request, execution).catch(() => undefined);
    return { run, created: true };
  }

  private async executeDurableAgentRun(
    request: AgentRunRequest,
    execution: DurableRunExecution,
    options: AgentRunOptions = {}
  ): Promise<AgentRunResponse> {
    const runOptions = { ...options, signal: execution.signal };
    const trace = this.createTraceRecorder({
      conversationId: request.conversation_id || "",
      skillId: request.skill_id || "",
      content: request.content || "",
      runId: execution.run_id,
      requestId: execution.request_id
    });
    const startedAt = Date.now();
    this.addAgentRequestContextToTrace(trace, request);
    try {
      await this.addRoutingTrace(request, trace);
      let response: AgentRunResponse = {
        ...(await this.runAgentInternal(request, trace, runOptions, execution)),
        run_id: execution.run_id
      };
      response = {
        ...(await this.attachConversationWriteBack(request, response, runOptions, execution)),
        run_id: execution.run_id
      };
      this.addAgentResponseToTrace(trace, response);
      await this.addModelCallSummaryToTrace(trace, {
        inputChars: agentRequestInputChars(request),
        outputChars: String(response.reply || response.skill_result?.result || "").length,
        durationMs: Date.now() - startedAt,
        streaming: false
      });
      this.runCoordinator.completeRun(execution, response);
      await this.finalizeDeferredGeneratedCache(
        response.skill_result,
        execution.run_id,
        execution.request_id
      );
      await trace.finish({ saved_paths: response.saved_paths || [] });
      return response;
    } catch (error) {
      const durableState = this.failDurableRun(execution, error);
      await this.addModelCallSummaryToTrace(trace, {
        inputChars: agentRequestInputChars(request),
        outputChars: 0,
        durationMs: Date.now() - startedAt,
        streaming: false,
        error
      });
      if (durableState === "paused") {
        trace.mark("workflow_completed", { cancelled: false, durable_status: "paused" });
        await trace.finish({ cancelled: false });
      } else if (durableState === "cancelled" || isCancellationError(error, runOptions.signal)) {
        trace.mark("workflow_completed", { cancelled: true, durable_status: durableState });
        await trace.finish({ cancelled: true });
      } else {
        trace.fail(error);
        await trace.finish();
      }
      throw error;
    }
  }

  private async runAgentInternal(
    request: AgentRunRequest,
    trace?: AgentTraceRecorder,
    options: AgentRunOptions = {},
    execution?: DurableRunExecution
  ): Promise<AgentRunResponse> {
    throwIfAborted(options.signal);
    const skillManagementIntent = classifySkillManagementIntent(request.content || "");
    if (skillManagementIntent) {
      trace?.mark("planned", {
        intent: "skill",
        selected_reason: `skill_management:${skillManagementIntent.action} - ${skillManagementIntent.reason}`
      });
      return this.runSkillManagementPreview(skillManagementIntent, request, trace, options);
    }
    if (this.shouldUseSmartSkillOrchestration(request)) {
      const skillPlan = await this.planSkillExecution(request, options);
      if (skillPlan.should_call_skill && skillPlan.steps.length) {
        trace?.mark("planned", {
          selected_skill_id: skillPlan.steps[0]?.skill_id || "",
          selected_reason: skillPlan.selected_reason
        });
        return this.runSkillPlan(skillPlan, request, options);
      }
    }

    throwIfAborted(options.signal);
    const intent = await this.classifyIntent(request);
    trace?.mark("classified", { intent });
    if (intent === "file_operation") {
      return this.fileOperationRunner.runAgent(request, execution && {
        runId: execution.run_id,
        stepId: execution.step_id,
        attemptId: execution.attempt_id
      });
    }
    if (intent === "skill") {
      const skillId = await this.resolveSkillId(request);
      if (!skillId) {
        throw new Error(`TS runtime 尚未接管该意图：${intent}`);
      }
      if (isWorkflowSkillId(skillId)) {
        trace?.mark("workflow_started", { selected_skill_id: skillId });
        return this.runLocalWorkflowSkill(skillId, request, trace, options, execution);
      }
      if (!(await this.skillRunner.canRunSkillLocally(skillId))) {
        throw new Error(`TS runtime 尚未接管该意图：${intent}`);
      }
      trace?.mark("workflow_started", { selected_skill_id: skillId });
      return this.runLocalSkillIntent(skillId, request, options, execution);
    }
    if (intent !== "chat" && intent !== "read_context") {
      throw new Error(`TS runtime 尚未接管该意图：${intent}`);
    }
    const restored = execution
      ? await this.restoreDeferredChatGeneratedResponse(request, intent, execution)
      : null;
    return this.attachGeneratedSaveDecision(
      request,
      restored || await this.chatRunner.runAgent(request, intent, this.buildChatContextObserver(trace), options),
      options,
      execution
    );
  }

  async *streamAgentRun(request: AgentRunRequest, options: AgentRunOptions = {}): AsyncGenerator<AgentStreamEvent> {
    throwIfAborted(options.signal);
    let execution: DurableRunExecution;
    try {
      execution = await this.beginDurableRun(request, options);
    } catch (error) {
      if (error instanceof RunRequestReplayError && error.run.status === "completed") {
        const replay = await this.replayCompletedAgentResponse(error.run);
        yield {
          type: "start",
          intent: replay.intent,
          conversation_id: replay.conversation?.id || request.conversation_id || "",
          skill_id: replay.current_skill || request.skill_id || "",
          run_id: replay.run_id
        };
        yield { type: "final", payload: replay };
        return;
      }
      throw error;
    }
    const runOptions = { ...options, signal: execution.signal };
    const trace = this.createTraceRecorder({
      conversationId: request.conversation_id || "",
      skillId: request.skill_id || "",
      content: request.content || "",
      runId: execution.run_id,
      requestId: execution.request_id
    });
    const startedAt = Date.now();
    this.addAgentRequestContextToTrace(trace, request);
    try {
      await this.addRoutingTrace(request, trace);
      let finalPayload: AgentRunResponse | null = null;
      for await (const sourceEvent of this.streamAgentRunInternal(request, trace, runOptions, execution)) {
        const event: AgentStreamEvent =
          sourceEvent.type === "start"
            ? { ...sourceEvent, run_id: execution.run_id }
            : sourceEvent.type === "final"
              ? { ...sourceEvent, payload: { ...sourceEvent.payload, run_id: execution.run_id } }
              : sourceEvent;
        if (event.type === "final") {
          finalPayload = event.payload;
          continue;
        }
        yield event;
      }
      if (!finalPayload) {
        throw Object.assign(new Error("Agent stream ended without a final payload"), { code: "STREAM_FINAL_MISSING" });
      }
      finalPayload = await this.attachConversationWriteBack(request, finalPayload, runOptions, execution);
      this.addAgentResponseToTrace(trace, finalPayload);
      await this.addModelCallSummaryToTrace(trace, {
        inputChars: agentRequestInputChars(request),
        outputChars: String(finalPayload?.reply || finalPayload?.skill_result?.result || "").length,
        durationMs: Date.now() - startedAt,
        streaming: true
      });
      this.runCoordinator.completeRun(execution, finalPayload);
      await this.finalizeDeferredGeneratedCache(
        finalPayload.skill_result,
        execution.run_id,
        execution.request_id
      );
      await trace.finish({ saved_paths: finalPayload?.saved_paths || [] });
      yield { type: "final", payload: finalPayload };
    } catch (error) {
      const durableState = this.failDurableRun(execution, error);
      await this.addModelCallSummaryToTrace(trace, {
        inputChars: agentRequestInputChars(request),
        outputChars: 0,
        durationMs: Date.now() - startedAt,
        streaming: true,
        error
      });
      if (durableState === "paused") {
        trace.mark("workflow_completed", { cancelled: false, durable_status: "paused" });
        await trace.finish({ cancelled: false });
      } else if (durableState === "cancelled" || isCancellationError(error, runOptions.signal)) {
        trace.mark("workflow_completed", { cancelled: true, durable_status: durableState });
        await trace.finish({ cancelled: true });
      } else {
        trace.fail(error);
        await trace.finish();
      }
      throw error;
    }
  }

  private async *streamAgentRunInternal(
    request: AgentRunRequest,
    trace?: AgentTraceRecorder,
    options: AgentRunOptions = {},
    execution?: DurableRunExecution
  ): AsyncGenerator<AgentStreamEvent> {
    throwIfAborted(options.signal);
    const skillManagementIntent = classifySkillManagementIntent(request.content || "");
    if (skillManagementIntent) {
      trace?.mark("planned", {
        intent: "skill",
        selected_reason: `skill_management:${skillManagementIntent.action} - ${skillManagementIntent.reason}`
      });
      yield* this.streamSkillManagementPreview(skillManagementIntent, request, trace, options);
      return;
    }
    if (this.shouldUseSmartSkillOrchestration(request)) {
      const skillPlan = await this.planSkillExecution(request, options);
      if (skillPlan.should_call_skill && skillPlan.steps.length) {
        trace?.mark("planned", {
          selected_skill_id: skillPlan.steps[0]?.skill_id || "",
          selected_reason: skillPlan.selected_reason
        });
        yield* this.streamSkillPlan(skillPlan, request, options);
        return;
      }
    }

    throwIfAborted(options.signal);
    const intent = await this.classifyIntent(request);
    trace?.mark("classified", { intent });
    if (intent === "file_operation") {
      yield* this.fileOperationRunner.streamAgentRun(request, execution && {
        runId: execution.run_id,
        stepId: execution.step_id,
        attemptId: execution.attempt_id
      });
      return;
    }
    if (intent === "skill") {
      const skillId = await this.resolveSkillId(request);
      if (!skillId) {
        throw new Error(`TS runtime 尚未接管该意图：${intent}`);
      }
      if (isWorkflowSkillId(skillId)) {
        trace?.mark("workflow_started", { selected_skill_id: skillId });
        yield* this.streamLocalWorkflowSkill(skillId, request, trace, options, execution);
        return;
      }
      if (!(await this.skillRunner.canRunSkillLocally(skillId))) {
        throw new Error(`TS runtime 尚未接管该意图：${intent}`);
      }
      trace?.mark("workflow_started", { selected_skill_id: skillId });
      yield* this.streamLocalSkillIntent(skillId, request, options, execution);
      return;
    }
    if (intent !== "chat" && intent !== "read_context") {
      throw new Error(`TS runtime 尚未接管该意图：${intent}`);
    }
    const restored = execution
      ? await this.restoreDeferredChatGeneratedResponse(request, intent, execution)
      : null;
    if (restored) {
      yield {
        type: "start",
        intent,
        conversation_id: restored.conversation?.id || request.conversation_id || "",
        skill_id: ""
      };
      yield {
        type: "final",
        payload: await this.attachGeneratedSaveDecision(request, restored, options, execution)
      };
      return;
    }
    for await (const event of this.chatRunner.streamAgentRun(request, intent, this.buildChatContextObserver(trace), options)) {
      if (event.type === "final") {
        yield {
          ...event,
          payload: await this.attachGeneratedSaveDecision(request, event.payload, options, execution)
        };
        continue;
      }
      yield event;
    }
  }

  private createTraceRecorder(input: { conversationId?: string; skillId?: string; content?: string; runId?: string; requestId?: string }): AgentTraceRecorder {
    return createAgentTraceRecorder({
      projectRoot: this.documents.projectRoot,
      conversationId: input.conversationId || "",
      skillId: input.skillId || "",
      content: input.content || "",
      requestId: input.requestId || "",
      ...(input.runId ? { idFactory: () => input.runId! } : {})
    });
  }

  getDurableRun(runId: string) {
    return this.runCoordinator.getRun(runId);
  }

  listDurableRuns(statuses?: Parameters<RunCoordinator["listRuns"]>[0], limit?: number, beforeUpdatedAt?: string) {
    return this.runCoordinator.listRuns(statuses, limit, beforeUpdatedAt);
  }

  listDurableRunEvents(runId: string, after?: number, limit?: number) {
    return this.runCoordinator.listEvents(runId, after, limit);
  }

  listDurableRunConfirmations(runId: string) {
    return this.runCoordinator.store.listConfirmations(runId);
  }

  listDurableCommitJournal(runId?: string) {
    return this.runCoordinator.listCommitJournal(runId);
  }

  async reconcileCompletedDurableGeneratedCaches(limit = 500): Promise<void> {
    for (const run of this.runCoordinator.listRuns(["completed"], limit)) {
      await this.reconcileCompletedAgentRunGeneratedCache(run);
    }
  }

  exportDurableRun(runId: string): AgentRunExport {
    return this.runCoordinator.exportRun(runId);
  }

  deleteDurableRun(runId: string): AgentRunDeleteResponse {
    return this.runCoordinator.deleteRun(runId);
  }

  pauseDurableRun(runId: string, operationId?: string, expectedVersion?: number) {
    return this.runCoordinator.requestPause(runId, operationId, expectedVersion);
  }

  cancelDurableRun(runId: string, operationId?: string, expectedVersion?: number) {
    return this.runCoordinator.requestCancel(runId, operationId, expectedVersion);
  }

  resumeDurableRun(runId: string, operationId: string, expectedVersion: number) {
    return this.startDurableRetry(runId, operationId, expectedVersion, undefined, "resume");
  }

  retryDurableRunStep(runId: string, stepId: string, operationId: string, expectedVersion: number) {
    return this.startDurableRetry(runId, operationId, expectedVersion, stepId, "retry");
  }

  /**
   * Take over expired runs from a previous runtime instance and immediately
   * continue them under the same durable run identity. File-operation plans
   * stay paused until their CommitJournal path is complete.
   */
  recoverStaleDurableRuns(): AgentRunState[] {
    const claimed = this.runCoordinator.recoverStaleRuns();
    const recovered: AgentRunState[] = [];
    for (const run of claimed) {
      try {
        const request = this.runCoordinator.getRecoveryRequest(run.run_id);
        if (classifyAgentIntent(request.content || "", request.skill_id || "", []) === "file_operation") {
          this.runCoordinator.store.appendEventInTransaction(run.run_id, {
            event_type: "run.recovery_deferred",
            step_id: run.current_step_id,
            payload: { reason: "FILE_OPERATION_JOURNAL_REQUIRED" }
          });
          recovered.push(this.runCoordinator.getRun(run.run_id)!);
          continue;
        }
        const execution = this.runCoordinator.resumeRun(
          run.run_id,
          staleRecoveryOperationId(run.run_id),
          run.version,
          { operationType: "resume" }
        );
        this.scheduleDurableExecution(request, execution);
        recovered.push(this.runCoordinator.getRun(run.run_id)!);
      } catch (error) {
        this.runCoordinator.store.appendEventInTransaction(run.run_id, {
          event_type: "run.recovery_deferred",
          step_id: run.current_step_id,
          payload: {
            reason: "RECOVERY_RESUME_FAILED",
            error: error instanceof Error ? error.message : String(error)
          }
        });
        recovered.push(this.runCoordinator.getRun(run.run_id)!);
      }
    }
    return recovered;
  }

  resolveDurableConfirmation(
    confirmationId: string,
    status: "approved" | "rejected",
    operationId: string,
    expectedVersion: number
  ) {
    return this.runCoordinator.resolveConfirmation(confirmationId, status, operationId, expectedVersion);
  }

  private startDurableRetry(
    runId: string,
    operationId: string,
    expectedVersion: number,
    stepId: string | undefined,
    operationType: "resume" | "retry"
  ) {
    let execution: DurableRunExecution;
    try {
      execution = this.runCoordinator.resumeRun(runId, operationId, expectedVersion, { stepId, operationType });
    } catch (error) {
      if (error instanceof RunRequestReplayError) {
        return error.run;
      }
      throw error;
    }
    const request = this.runCoordinator.getRecoveryRequest(runId);
    this.scheduleDurableExecution(request, execution);
    return this.runCoordinator.getRun(runId)!;
  }

  private scheduleDurableExecution(request: AgentRunRequest, execution: DurableRunExecution): void {
    if (isDurableSkillAgentRequest(request)) {
      void this.executeDurableSkillRun(
        request.skill_id || "",
        durableAgentRequestToSkillRequest(request),
        execution
      ).catch(() => undefined);
      return;
    }
    void this.executeDurableAgentRun(request, execution).catch(() => undefined);
  }

  private async beginDurableRun(request: AgentRunRequest, options: AgentRunOptions): Promise<DurableRunExecution> {
    const initialIntent = classifyAgentIntent(request.content || "", request.skill_id || "", []);
    const stepType = initialIntent === "file_operation"
      ? "file_operation"
      : initialIntent === "read_context"
        ? "read"
        : initialIntent === "skill"
          ? isWorkflowSkillId(request.skill_id || "")
            ? "workflow"
            : "skill"
          : "chat";
    const writeRequested = initialIntent === "file_operation" || hasExplicitWriteIntent(request.content || "");
    const retryable = initialIntent !== "file_operation" || !writeRequested;
    return this.runCoordinator.beginRun(request, {
      projectId: await this.projectManifest.getProjectId(),
      stepType,
      actionId: `agent.${initialIntent}`,
      skillId: request.skill_id || "",
      retryable,
      requiresConfirmation: initialIntent === "file_operation",
      signal: options.signal
    });
  }

  private async writePreparedGeneratedCacheCommit(
    commit: PreparedGeneratedCacheCommit,
    execution: DurableRunExecution,
    intentHash: string,
    source: string,
    summary = ""
  ) {
    const idempotencyKey = sha256Text(stableJson({
      schema_version: 1,
      kind: "generated_cache_write",
      cache_id: commit.cache_id,
      action_key: commit.action_key,
      target_path: commit.target_path,
      intent_hash: intentHash,
      run_id: execution.run_id,
      step_id: execution.step_id
    }));
    const existing = this.runCoordinator
      .listCommitJournal(execution.run_id)
      .find((journal) => journal.idempotency_key === idempotencyKey);
    let content = commit.content;
    if (existing) {
      const current = await this.documents.readRawText(commit.target_path).catch(() => "");
      if (sha256ContentHash(current) === existing.new_hash) {
        content = current;
      }
    }
    return this.commitJournal.write({
      runId: execution.run_id,
      stepId: execution.step_id,
      attemptId: execution.attempt_id,
      action: `generated_cache.commit.${commit.action_key}`,
      targetPath: commit.target_path,
      content,
      idempotencyKey,
      source,
      summary: summary || `Generated cache commit: ${commit.target_path}`
    });
  }

  private failDurableRun(execution: DurableRunExecution, error: unknown) {
    try {
      return this.runCoordinator.failRun(execution, error).status;
    } catch (lifecycleError) {
      const current = this.runCoordinator.getRun(execution.run_id);
      if (current?.status === "failed" || current?.status === "paused" || current?.status === "cancelled") {
        return current.status;
      }
      throw lifecycleError;
    }
  }

  private buildWorkflowContext(
    trace?: AgentTraceRecorder,
    options: AgentRunOptions = {},
    execution?: DurableRunExecution
  ): WorkflowRunContext {
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
      trace,
      signal: options.signal,
      durableExecution: execution
        ? {
            runId: execution.run_id,
            stepId: execution.step_id,
            attemptId: execution.attempt_id
          }
        : undefined,
      commitJournal: execution ? this.commitJournal : undefined,
      checkpoint: execution
        ? new DurableWorkflowCheckpointStore(this.runCoordinator.store, {
            runId: execution.run_id,
            stepId: execution.step_id,
            attemptId: execution.attempt_id
          })
        : undefined
    };
  }

  private buildChatContextObserver(trace?: AgentTraceRecorder): ChatContextAssemblyObserver | undefined {
    if (!trace) {
      return undefined;
    }
    return ({ scope, context }) => {
      trace.mark("context_assembled");
      for (const block of context.blocks) {
        const metadata = pickTraceMetadata(block.metadata);
        const flattenedMetadata = flattenTraceMetadata(metadata);
        trace.addContextBlock({
          name: `${scope}:${block.id}`,
          source: block.source,
          chars: Math.max(0, Math.trunc(block.originalChars || 0)),
          included: block.included,
          reason: `${block.title}; included ${block.includedChars}/${block.originalChars}; budget ${context.totalBudget}`,
          included_chars: Math.max(0, Math.trunc(block.includedChars || 0)),
          priority: block.priority,
          budget: context.totalBudget,
          scope,
          truncated: block.includedChars < block.originalChars,
          ...(Object.keys(metadata).length ? { metadata } : {}),
          ...flattenedMetadata
        });
      }
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

  private conversationWriteBackIntent(request: AgentRunRequest): { targetPath: string; mode: "append" | "replace"; confirmWrite: boolean } | null {
    const targetPath = String((request as any).conversation_write_target || "").trim();
    if (!targetPath) {
      return null;
    }
    const mode = (request as any).conversation_write_mode === "append" ? "append" : "replace";
    return {
      targetPath,
      mode,
      confirmWrite: Boolean((request as any).conversation_confirm_write)
    };
  }

  private async restoreDeferredChatGeneratedResponse(
    request: AgentRunRequest,
    intent: "chat" | "read_context",
    execution: DurableRunExecution
  ): Promise<AgentRunResponse | null> {
    const candidates: Array<{ cacheId: string; skillId: string }> = [];
    if (hasExplicitWriteIntent(request.content || "")) {
      candidates.push({
        cacheId: deterministicGeneratedCacheId(execution, "chat_generated", "chat_auto_save"),
        skillId: "chat_generated"
      });
    }
    if (this.conversationWriteBackIntent(request)) {
      candidates.push({
        cacheId: deterministicGeneratedCacheId(execution, "conversation_write_back", "conversation_write_back"),
        skillId: "conversation_write_back"
      });
    }
    if (!candidates.length) {
      return null;
    }
    let reply = "";
    for (const candidate of candidates) {
      const meta = await this.cache.get(candidate.cacheId).catch(() => null);
      if (
        !meta
        || meta.skill_id !== candidate.skillId
        || (meta.status !== "pending" && meta.status !== "committed")
        || !meta.save_plan
      ) {
        continue;
      }
      reply = await this.cache.readContent(candidate.cacheId).catch(() => "");
      if (reply.trim()) {
        break;
      }
    }
    if (!reply.trim()) {
      return null;
    }
    const conversation = request.conversation_id
      ? await this.conversations.getConversation(request.conversation_id).catch(() => undefined)
      : undefined;
    return {
      intent,
      reply,
      conversation,
      results: [],
      saved_paths: [],
      requires_confirmation: false
    };
  }

  private async attachGeneratedSaveDecision(
    request: AgentRunRequest,
    response: AgentRunResponse,
    options: AgentRunOptions = {},
    execution?: DurableRunExecution
  ): Promise<AgentRunResponse> {
    throwIfAborted(options.signal);
    if (response.intent !== "chat" && response.intent !== "read_context") {
      return response;
    }
    if (response.saved_paths.length || response.skill_result?.data?.pending_save) {
      return response;
    }
    let content = String(response.reply || "").trim();
    if (!content || !hasExplicitWriteIntent(request.content || "")) {
      return response;
    }

    const deterministicCacheId = execution
      ? deterministicGeneratedCacheId(execution, "chat_generated", "chat_auto_save")
      : "";
    const existing = deterministicCacheId
      ? await this.cache.get(deterministicCacheId).catch(() => null)
      : null;
    const cachedContent = existing
      ? await this.cache.readContent(existing.cache_id).catch(() => "")
      : "";
    if (cachedContent.trim()) {
      if (cachedContent !== content) {
        throw codedRuntimeError(
          "CHAT_GENERATED_CACHE_CONTENT_CONFLICT",
          "同一 durable chat run 已绑定到不同生成结果"
        );
      }
      content = cachedContent;
    }

    const plan = existing?.save_plan || await this.savePlanner.planGeneratedSave({
        instruction: request.content || "",
        content,
        source: "chat",
        skillId: "chat_generated",
        currentPath: request.current_path || "",
        chapter: this.resolveSkillChapter("body_generate", request),
        writeRequested: true,
        defaultMode: "replace"
      }, options);
    throwIfAborted(options.signal);

    if (plan.action === "no_save" || !plan.target_paths.length) {
      return response;
    }

    const entry = existing || (deterministicCacheId
      ? await this.cache.createWithId(deterministicCacheId, {
          source: "chat",
          target_paths: plan.target_paths,
          skill_id: "chat_generated",
          conversation_id: response.conversation?.id || request.conversation_id || "",
          mode: plan.mode,
          summary: "AI 会话生成保存计划",
          save_plan: plan
        })
      : await this.cache.create({
          source: "chat",
          target_paths: plan.target_paths,
          skill_id: "chat_generated",
          conversation_id: response.conversation?.id || request.conversation_id || "",
          mode: plan.mode,
          summary: "AI 会话生成保存计划",
          save_plan: plan
        }));
    if (entry.status !== "pending") {
      throw codedRuntimeError(
        "CHAT_GENERATED_CACHE_NOT_PENDING",
        `Chat 生成缓存状态为 ${entry.status}，不能继续提交`
      );
    }
    const meta = cachedContent ? entry : await this.cache.replace(entry.cache_id, content);
    throwIfAborted(options.signal);

    if (await this.savePlanner.shouldAutoCommit(plan)) {
      throwIfAborted(options.signal);
      const committed = execution
        ? await this.commitGeneratedCache({
            cache_id: entry.cache_id,
            source: "chat",
            skill_id: "chat_generated",
            mode: plan.mode,
            target_paths: plan.target_paths,
            save_plan: plan,
            summary: "Chat generated auto-save",
            cleanup_content: false
          }, {
            ...options,
            execution
          })
        : null;
      const savedPaths = committed
        ? committed.saved_paths
        : await this.cache.commitSavePlan(entry.cache_id, plan, { cleanupContent: true });
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
            save_plan: plan,
            cache_id: entry.cache_id,
            ...(committed
              ? {
                  journal_ids: committed.journal_ids,
                  run_id: execution!.run_id,
                  request_id: execution!.request_id,
                  replayed: committed.replayed
                }
              : {})
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

  private async attachConversationWriteBack(
    request: AgentRunRequest,
    response: AgentRunResponse,
    options: AgentRunOptions,
    execution: DurableRunExecution
  ): Promise<AgentRunResponse> {
    const intent = this.conversationWriteBackIntent(request);
    if (!intent) {
      return response;
    }
    throwIfAborted(options.signal);
    let content = String(response.reply || "").trim();
    if (!content) {
      return response;
    }

    const cacheId = deterministicGeneratedCacheId(execution, "conversation_write_back", "conversation_write_back");
    const savePlan = generatedSavePlanSchema.parse({
      action: intent.mode === "append" ? "append_to_existing" : "replace_existing",
      mode: intent.mode,
      target_paths: [intent.targetPath],
      reason: "显式会话 write_target 写回",
      confidence: 1,
      requires_confirmation: false,
      should_auto_commit: true,
      source: "conversation",
      skill_id: "conversation_write_back"
    });
    const existing = await this.cache.get(cacheId).catch(() => null);
    const cachedContent = existing
      ? await this.cache.readContent(existing.cache_id).catch(() => "")
      : "";
    if (cachedContent.trim()) {
      if (cachedContent !== content) {
        throw codedRuntimeError(
          "CONVERSATION_WRITE_BACK_CACHE_CONTENT_CONFLICT",
          "同一 durable conversation write_back run 已绑定到不同回复内容"
        );
      }
      content = cachedContent;
    }
    if (existing && existing.status !== "pending") {
      throw codedRuntimeError(
        "CONVERSATION_WRITE_BACK_CACHE_NOT_PENDING",
        `会话写回缓存状态为 ${existing.status}，不能继续提交`
      );
    }
    const entry = existing || await this.cache.createWithId(cacheId, {
      source: "conversation",
      target_paths: [intent.targetPath],
      skill_id: "conversation_write_back",
      conversation_id: response.conversation?.id || request.conversation_id || "",
      mode: intent.mode,
      summary: "会话显式写回",
      save_plan: savePlan
    });
    if (!cachedContent) {
      await this.cache.replace(entry.cache_id, content);
    }
    throwIfAborted(options.signal);

    const committed = await this.commitGeneratedCache({
      cache_id: entry.cache_id,
      source: "conversation",
      skill_id: "conversation_write_back",
      mode: intent.mode,
      target_paths: [intent.targetPath],
      save_plan: savePlan,
      summary: "Conversation write_target write-back",
      cleanup_content: false
    }, {
      ...options,
      execution
    });
    const savedPath = committed.saved_paths[0] || intent.targetPath;
    const conversation = response.conversation
      ? await this.appendConversationWriteBackMessage(
          response.conversation.id,
          savedPath,
          intent.mode,
          execution.run_id,
          committed.journal_ids
        )
      : response.conversation;
    const writeBackDescriptor = {
      cache_id: entry.cache_id,
      saved_paths: committed.saved_paths,
      journal_ids: committed.journal_ids,
      source: "conversation_write_back",
      target_paths: [intent.targetPath],
      run_id: execution.run_id,
      request_id: execution.request_id,
      replayed: committed.replayed
    };
    const baseSkillResult = response.skill_result || {
      status: "done" as const,
      result: content,
      saved_path: "",
      data: {}
    };
    const baseData = isRecord(baseSkillResult.data) ? baseSkillResult.data : {};
    const existingDeferred = Array.isArray(baseData.deferred_generated_caches)
      ? baseData.deferred_generated_caches
      : [];
    return {
      ...response,
      conversation,
      saved_paths: uniquePaths([...(response.saved_paths || []), ...committed.saved_paths]),
      skill_result: skillRunResponseSchema.parse({
        ...baseSkillResult,
        saved_path: baseSkillResult.saved_path || savedPath,
        data: {
          ...baseData,
          conversation_write_back: writeBackDescriptor,
          deferred_generated_caches: [
            ...existingDeferred,
            writeBackDescriptor
          ]
        }
      })
    };
  }

  private async planSkillExecution(request: AgentRunRequest, options: AgentRunOptions = {}): Promise<SkillPlan> {
    const skills = await this.skills.listSkills().catch(() => []);
    return this.skillOrchestrator.plan(request, skills, options);
  }

  private async runSkillManagementPreview(
    management: SkillManagementIntent,
    request: AgentRunRequest,
    trace?: AgentTraceRecorder,
    options: AgentRunOptions = {}
  ): Promise<AgentRunResponse> {
    throwIfAborted(options.signal);
    const preview = await this.buildSkillManagementPreview(management, request, options);
    trace?.addContextBlock({
      name: `skill_management:${management.action}`,
      source: "runtime",
      chars: String(request.content || "").length,
      included: true,
      reason: preview.reply.slice(0, 500),
      metadata: {
        role: "skill_management",
        action: management.action,
        target_skill_id: preview.currentSkill,
        requires_confirmation: preview.requiresConfirmation
      }
    });
    const conversation = await this.recordSkillExchange(request, preview.reply, {
      skill_management: preview.data,
      current_skill: preview.currentSkill
    });
    return {
      intent: "skill",
      reply: preview.reply,
      conversation,
      results: [],
      skill_result: {
        status: "done",
        result: preview.reply,
        saved_path: "",
        data: {
          skill_id: preview.currentSkill,
          skill_management: preview.data,
          pending_confirmation: preview.requiresConfirmation
        }
      },
      saved_paths: [],
      requires_confirmation: preview.requiresConfirmation,
      current_skill: preview.currentSkill,
      selected_reason: `skill_management:${management.action} - ${management.reason}`
    };
  }

  private async *streamSkillManagementPreview(
    management: SkillManagementIntent,
    request: AgentRunRequest,
    trace?: AgentTraceRecorder,
    options: AgentRunOptions = {}
  ): AsyncGenerator<AgentStreamEvent> {
    throwIfAborted(options.signal);
    yield {
      type: "start",
      intent: "skill",
      conversation_id: request.conversation_id || "",
      skill_id: "",
      selected_reason: `skill_management:${management.action} - ${management.reason}`
    };
    const payload = await this.runSkillManagementPreview(management, request, trace, options);
    yield {
      type: "delta",
      text: payload.reply,
      stage: "skill_management_preview",
      skill_id: payload.current_skill || ""
    };
    yield {
      type: "final",
      payload
    };
  }

  private async buildSkillManagementPreview(
    management: SkillManagementIntent,
    request: AgentRunRequest,
    options: AgentRunOptions
  ): Promise<{ reply: string; data: Record<string, unknown>; currentSkill: string; requiresConfirmation: boolean }> {
    if (management.action === "draft") {
      const draft = await this.skillDrafts.draftSkill(this.buildSkillManagementDraftRequest(request), options);
      return {
        reply: buildSkillDraftManagementReply(draft),
        currentSkill: draft.skill.id,
        requiresConfirmation: true,
        data: {
          action: "draft",
          confirm_action: "import_skill_draft",
          draft,
          warnings: draft.warnings
        }
      };
    }

    const skills = await this.skills.listSkills();
    const target = this.resolveSkillManagementTarget(request, skills);
    if (!target) {
      return {
        reply: [
          `我识别到你想${skillManagementActionLabel(management.action)}，但还没有找到目标技能。`,
          "请在指令里写清楚 skill id 或技能名称，例如：修改 short_review 技能，让它输出更严格。"
        ].join("\n"),
        currentSkill: "",
        requiresConfirmation: false,
        data: {
          action: management.action,
          status: "missing_target"
        }
      };
    }

    if (management.action === "patch") {
      if (target.builtin) {
        return this.buildBuiltinPatchPreview(target, request);
      }
      const draft = await this.skillDrafts.draftSkill({
        kind: "existing_skill",
        instruction: request.content || "",
        text: "",
        url: "",
        current_path: request.current_path || "",
        selection: request.selection || "",
        attachment_ids: request.attachment_ids || [],
        source_skill_id: target.id,
        target_name: target.name,
        target_id: target.id
      }, options);
      const patch = await this.skills.patchSkill(target.id, {
        description: draft.skill.description,
        prompt: draft.skill.prompt,
        context_requirements: draft.skill.context_requirements,
        linked_targets: draft.skill.linked_targets,
        save_policy: draft.skill.save_policy,
        writable: draft.skill.writable,
        change_reason: clipForConsistency(request.content || "自然语言修改预览", 2000),
        expected_version: "",
        dry_run: true
      });
      const hasDiff = Boolean(patch.diff.trim());
      return {
        reply: buildSkillPatchManagementReply(target, patch),
        currentSkill: target.id,
        requiresConfirmation: hasDiff,
        data: {
          action: "patch",
          confirm_action: "patch_skill",
          target_skill_id: target.id,
          patch_preview: patch,
          draft,
          warnings: patch.warnings
        }
      };
    }

    if (management.action === "clone") {
      const suggestion = this.buildSkillCloneSuggestion(target, request);
      return {
        reply: [
          `已准备复制技能预览（未保存）：${target.name}（${target.id}）。`,
          `建议新 ID：${suggestion.target_id}`,
          `建议名称：${suggestion.target_name}`,
          "请在技能页确认复制为自定义技能后再保存；如果还要修改提示词，复制后再预览修改 diff。"
        ].join("\n"),
        currentSkill: target.id,
        requiresConfirmation: true,
        data: {
          action: "clone",
          confirm_action: "clone_skill",
          target_skill_id: target.id,
          clone_request: suggestion
        }
      };
    }

    if (management.action === "rollback") {
      const versions = await this.skills.listSkillVersions(target.id);
      const suggested = versions.versions.at(-1) || null;
      return {
        reply: versions.versions.length
          ? [
              `已找到 ${target.name}（${target.id}）的 ${versions.versions.length} 个历史版本，未执行回滚。`,
              `建议先预览版本：${suggested?.version_id || ""}`,
              "请在技能页选择版本并确认回滚。"
            ].join("\n")
          : `技能 ${target.name}（${target.id}）暂时没有可回滚的版本历史。`,
        currentSkill: target.id,
        requiresConfirmation: versions.versions.length > 0,
        data: {
          action: "rollback",
          confirm_action: "rollback_skill",
          target_skill_id: target.id,
          versions,
          suggested_version_id: suggested?.version_id || ""
        }
      };
    }

    const toggleLabel = management.action === "disable" ? "禁用" : "恢复";
    return {
      reply: [
        `已识别到${toggleLabel}技能请求：${target.name}（${target.id}）。`,
        `此处不会直接${toggleLabel}技能，请在技能页确认后执行。`
      ].join("\n"),
      currentSkill: target.id,
      requiresConfirmation: true,
      data: {
        action: management.action,
        confirm_action: management.action === "disable" ? "disable_skill" : "restore_skill",
        target_skill_id: target.id
      }
    };
  }

  private buildSkillManagementDraftRequest(request: AgentRunRequest): SkillDraftRequest {
    const text = String((request as Record<string, unknown>).text || "");
    const targetName = extractQuotedText(request.content || "");
    return {
      kind: request.selection?.trim()
        ? "selection"
        : request.current_path?.trim() && /(当前文档|当前文件|这篇|这章|当前选区|选区)/.test(request.content || "")
          ? "current_document"
          : text.trim()
            ? "markdown"
            : "instruction",
      instruction: request.content || "",
      text,
      url: "",
      current_path: request.current_path || "",
      selection: request.selection || "",
      attachment_ids: request.attachment_ids || [],
      source_skill_id: "",
      target_name: targetName,
      target_id: normalizeGeneratedSkillId(targetName)
    };
  }

  private resolveSkillManagementTarget(request: AgentRunRequest, skills: SkillDefinition[]): SkillDefinition | null {
    const explicitId = String(request.skill_id || (request as Record<string, unknown>).current_skill || "").trim();
    if (explicitId) {
      const explicit = skills.find((skill) => skill.id === explicitId);
      if (explicit) {
        return explicit;
      }
    }
    const text = request.content || "";
    const normalizedText = normalizeSkillMention(text);
    const direct = [...skills]
      .sort((left, right) => Math.max(right.id.length, right.name.length) - Math.max(left.id.length, left.name.length))
      .find((skill) => {
        const id = normalizeSkillMention(skill.id);
        const name = normalizeSkillMention(skill.name || "");
        return (id.length >= 2 && normalizedText.includes(id)) || (name.length >= 2 && normalizedText.includes(name));
      });
    if (direct) {
      return direct;
    }
    const ranked = rankSkillRoutes(text, skills, { includeNonRunnable: true, limit: 1 });
    return ranked[0]?.skill || skills.find((skill) => skill.id === ranked[0]?.skillId) || null;
  }

  private buildBuiltinPatchPreview(
    target: SkillDefinition,
    request: AgentRunRequest
  ): { reply: string; data: Record<string, unknown>; currentSkill: string; requiresConfirmation: boolean } {
    const suggestion = this.buildSkillCloneSuggestion(target, request);
    return {
      reply: [
        `默认技能 ${target.name}（${target.id}）不能直接修改。`,
        "建议先复制为自定义技能，再对自定义技能预览修改 diff。",
        `建议新 ID：${suggestion.target_id}`,
        `建议名称：${suggestion.target_name}`
      ].join("\n"),
      currentSkill: target.id,
      requiresConfirmation: true,
      data: {
        action: "clone_then_patch",
        confirm_action: "clone_skill",
        target_skill_id: target.id,
        clone_request: suggestion,
        patch_instruction: request.content || ""
      }
    };
  }

  private buildSkillCloneSuggestion(target: SkillDefinition, request: AgentRunRequest): { target_id: string; target_name: string; instruction: string } {
    const targetName = extractQuotedText(request.content || "") || `${target.name}（自定义）`;
    return {
      target_id: normalizeGeneratedSkillId(targetName) || `custom_${target.id}`,
      target_name: targetName,
      instruction: request.content || ""
    };
  }

  private async *streamLocalSkillIntent(
    skillId: string,
    request: AgentRunRequest,
    options: AgentRunOptions = {},
    execution?: DurableRunExecution
  ): AsyncGenerator<AgentStreamEvent> {
    throwIfAborted(options.signal);
    request = { ...request, skill_id: skillId };
    yield {
      type: "start",
      intent: "skill",
      conversation_id: request.conversation_id || "",
      skill_id: skillId
    };
    const skillRequest = this.buildSkillRequest(skillId, request);
    for await (const event of this.skillRunner.streamSkill(skillId, skillRequest, {
      ...options,
      deferAutoCommit: Boolean(execution),
      ...(execution
        ? { deterministicCacheId: deterministicGeneratedCacheId(execution, skillId) }
        : {})
    })) {
      throwIfAborted(options.signal);
      if (event.type !== "final") {
        yield event;
        continue;
      }
      const result = execution
        ? await this.commitDeferredPromptSkillResult(
            skillId,
            event.payload.skill_result!,
            execution,
            options
          )
        : event.payload.skill_result!;
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

  private async *streamLocalWorkflowSkill(
    skillId: string,
    request: AgentRunRequest,
    trace?: AgentTraceRecorder,
    options: AgentRunOptions = {},
    execution?: DurableRunExecution
  ): AsyncGenerator<AgentStreamEvent> {
    throwIfAborted(options.signal);
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
    const payload = await this.runLocalWorkflowSkill(skillId, request, trace, options, execution);
    throwIfAborted(options.signal);
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

  private async *streamSkillPlan(skillPlan: SkillPlan, request: AgentRunRequest, options: AgentRunOptions = {}): AsyncGenerator<AgentStreamEvent> {
    throwIfAborted(options.signal);
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
    const payload = await this.runSkillPlan(skillPlan, request, options);
    throwIfAborted(options.signal);
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

  private async runSkillPlan(skillPlan: SkillPlan, request: AgentRunRequest, options: AgentRunOptions = {}): Promise<AgentRunResponse> {
    throwIfAborted(options.signal);
    const steps = skillPlan.steps.slice(0, 4);
    const stepRecords: Array<Record<string, unknown>> = [];
    const savedPaths: string[] = [];
    const webSearchSources: WebSearchSource[] = [];
    let lastResult: SkillRunResponse | null = null;
    let lastReply = "";
    let priorOutput = String(request.selection || "").trim();

    for (const [index, step] of steps.entries()) {
      throwIfAborted(options.signal);
      const skillRequest = this.buildPlannedSkillRequest(step, request, priorOutput);
      try {
        const result = await this.runSkillInternal(step.skill_id, skillRequest, options);
        throwIfAborted(options.signal);
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
        if (isCancellationError(error, options.signal)) {
          throw error;
        }
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
      "end_chapter",
      "reference_paths",
      "confirmed_reference_paths",
      "disable_auto_references"
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

  private async commitDeferredPromptSkillResult(
    skillId: string,
    result: SkillRunResponse,
    execution: DurableRunExecution,
    options: AgentRunOptions = {}
  ): Promise<SkillRunResponse> {
    const deferred = parseDeferredPromptSkillCommit(result.data?.deferred_commit, skillId);
    if (!deferred || deferred.requires_confirmation) {
      return withDurableSkillIdentity(result, execution.run_id, execution.request_id, false);
    }

    const committed = await this.commitGeneratedCache({
      cache_id: deferred.cache_id,
      source: deferred.source,
      skill_id: deferred.skill_id,
      mode: deferred.mode,
      target_paths: deferred.target_paths,
      save_plan: deferred.save_plan,
      summary: deferred.summary,
      cleanup_content: false
    }, {
      ...options,
      execution,
      sectioned: {
        loreMergeExisting: deferred.lore_merge_existing
      }
    });
    const data = { ...(result.data || {}) };
    delete data.deferred_commit;
    delete data.pending_save;
    delete data.target_path;
    delete data.target_paths;
    delete data.default_mode;
    delete data.cache_path;
    delete data.cache_chars;
    data.cache_id = committed.cache_id;
    data.saved_paths = committed.saved_paths;
    data.journal_ids = committed.journal_ids;
    data.run_id = execution.run_id;
    data.request_id = execution.request_id;
    data.replayed = committed.replayed;
    return skillRunResponseSchema.parse({
      ...result,
      saved_path: committed.saved_paths[0] || "",
      data
    });
  }

  private async finalizeDeferredGeneratedCache(
    result: SkillRunResponse | null | undefined,
    runId: string,
    requestId: string
  ): Promise<void> {
    const data = isRecord(result?.data) ? result.data : {};
    const descriptors: Array<{ cacheId: string; savedPaths: string[]; journalIds: string[] }> = [];
    const primaryCacheId = String(data.cache_id || "").trim();
    if (primaryCacheId) {
      descriptors.push({
        cacheId: primaryCacheId,
        savedPaths: canonicalGeneratedPaths([
          ...stringListFromUnknown(data.saved_paths),
          result?.saved_path || ""
        ]),
        journalIds: stringListFromUnknown(data.journal_ids)
      });
    }
    if (Array.isArray(data.deferred_generated_caches)) {
      for (const item of data.deferred_generated_caches) {
        if (!isRecord(item)) {
          continue;
        }
        descriptors.push({
          cacheId: String(item.cache_id || "").trim(),
          savedPaths: canonicalGeneratedPaths([
            ...stringListFromUnknown(item.saved_paths),
            ...stringListFromUnknown(item.target_paths)
          ]),
          journalIds: stringListFromUnknown(item.journal_ids)
        });
      }
    }
    const validDescriptors = descriptors.filter((descriptor) =>
      descriptor.cacheId && descriptor.savedPaths.length && descriptor.journalIds.length
    );
    if (!validDescriptors.length) {
      return;
    }

    try {
      const journalById = new Map(
        this.runCoordinator
          .listCommitJournal(runId)
          .map((journal) => [journal.journal_id, journal] as const)
      );
      for (const descriptor of validDescriptors) {
        if (!descriptor.journalIds.every((journalId) => journalById.get(journalId)?.stage === "finalized")) {
          continue;
        }
        const meta = await this.cache.get(descriptor.cacheId);
        if (meta.status !== "pending" && meta.status !== "committed") {
          continue;
        }
        if (meta.commit_run_id && meta.commit_run_id !== runId) {
          continue;
        }
        await this.cache.markCommitted(descriptor.cacheId, descriptor.savedPaths, {
          cleanupContent: true,
          commitRunId: runId,
          commitRequestId: requestId,
          commitJournalIds: descriptor.journalIds
        });
      }
    } catch {
      // The outer run already owns the durable result. A completed-request
      // replay will retry this metadata/content cleanup without rerunning the model.
    }
  }

  private async runLocalSkillIntent(
    skillId: string,
    request: AgentRunRequest,
    options: AgentRunOptions = {},
    execution?: DurableRunExecution
  ): Promise<AgentRunResponse> {
    throwIfAborted(options.signal);
    request = { ...request, skill_id: skillId };
    const skillRequest = this.buildSkillRequest(skillId, request);
    const prepared = await this.skillRunner.runSkill(skillId, skillRequest, {
      ...options,
      deferAutoCommit: Boolean(execution),
      ...(execution
        ? { deterministicCacheId: deterministicGeneratedCacheId(execution, skillId) }
        : {})
    });
    const result = execution
      ? await this.commitDeferredPromptSkillResult(skillId, prepared, execution, options)
      : prepared;
    throwIfAborted(options.signal);
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

  private async runLocalWorkflowSkill(
    skillId: string,
    request: AgentRunRequest,
    trace?: AgentTraceRecorder,
    options: AgentRunOptions = {},
    execution?: DurableRunExecution
  ): Promise<AgentRunResponse> {
    throwIfAborted(options.signal);
    request = { ...request, skill_id: skillId };
    const context = this.buildWorkflowContext(trace, options, execution);
    const handler = getWorkflowHandler(skillId);
    if (handler) {
      return handler.runAgent(request, context);
    }
    if (!isWorkflowSkillId(skillId)) {
      throw new Error(`TS runtime 尚未接管该 workflow skill: ${skillId}`);
    }
    throw new Error(`TS runtime 尚未注册该 workflow handler: ${skillId}`);
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
      reference_paths: request.reference_paths || [],
      confirmed_reference_paths: request.confirmed_reference_paths || [],
      disable_auto_references: Boolean(request.disable_auto_references),
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

  private async applyBodyDeslop(text: string, chapter: number, options: AgentRunOptions = {}): Promise<{ text: string; changed: boolean }> {
    throwIfAborted(options.signal);
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
      throwIfAborted(options.signal);
      const raw = String(
        await this.modelClient.requestCompletion(
          config,
          [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt }
          ] satisfies ChatCompletionMessage[],
          Math.max(0.2, Math.min(0.7, config.temperature)),
          { signal: options.signal }
        )
      ).trim();
      throwIfAborted(options.signal);
      const cleaned = raw.replace(/^```(?:text|markdown|md)?\s*/i, "").replace(/\s*```$/, "").trim();
      if (!cleaned) {
        return { text, changed: false };
      }
      return { text: cleaned, changed: cleaned !== text.trim() };
    } catch (error) {
      if (isCancellationError(error, options.signal)) {
        throw error;
      }
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
    payload: ConversationMessageRequest,
    options: AgentRunOptions = {}
  ): Promise<{ conversation: ConversationDetail; reply: string; saved_path: string; web_search_sources?: import("./web-search.js").WebSearchSource[]; skill_result?: SkillRunResponse }> {
    throwIfAborted(options.signal);
    await this.validateConversationWriteBackRequest(payload);
    const request = this.conversationPayloadToAgentRequest(conversationId, payload);
    await this.attachCurrentSkillToRequest(request, payload.skill_id || "");
    const agentResponse = await this.runAgent(request, options);
    throwIfAborted(options.signal);
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
    payload: ConversationMessageRequest,
    options: AgentRunOptions = {}
  ): AsyncGenerator<AgentStreamEvent> {
    throwIfAborted(options.signal);
    await this.validateConversationWriteBackRequest(payload);
    const agentRequest = this.conversationPayloadToAgentRequest(conversationId, payload);
    await this.attachCurrentSkillToRequest(agentRequest, payload.skill_id || "");
    for await (const event of this.streamAgentRun(agentRequest, options)) {
      throwIfAborted(options.signal);
      if (event.type === "final") {
        yield {
          ...event,
          payload: event.payload
        };
        continue;
      }
      yield event;
    }
  }

  private conversationPayloadToAgentRequest(conversationId: string, payload: ConversationMessageRequest): AgentRunRequest {
    const extra = payload as Record<string, unknown>;
    const writeTarget = String(payload.write_target || "").trim();
    return {
      request_id: String(extra.request_id || "").trim(),
      conversation_id: conversationId,
      content: payload.content || "",
      current_path: payload.current_path || "",
      selection: "",
      project_context_hint: payload.runtime_context || "",
      skill_id: payload.skill_id || "",
      attachment_ids: payload.attachment_ids || [],
      reference_paths: stringArray(extra.reference_paths),
      confirmed_reference_paths: stringArray(extra.confirmed_reference_paths),
      disable_auto_references: Boolean(extra.disable_auto_references),
      ...(writeTarget
        ? {
            conversation_write_target: writeTarget,
            conversation_write_mode: resolveConversationWriteBackMode(payload),
            conversation_confirm_write: Boolean(payload.confirm_write)
          }
        : {})
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

  private async appendConversationWriteBackMessage(
    conversationId: string,
    savedPath: string,
    insertMode: "append" | "replace",
    runId = "",
    journalIds: string[] = []
  ): Promise<ConversationDetail> {
    let detail = await this.conversations.getConversation(conversationId);
    const messageId = runId
      ? `writeback_${sha256Text(`${runId}:${savedPath}:${insertMode}`).slice(0, 24)}`
      : randomUUID().replace(/-/g, "");
    if (detail.messages.some((message) =>
      message.id === messageId ||
      (
        runId &&
        isRecord(message.metadata) &&
        message.metadata.write_back_run_id === runId &&
        message.metadata.write_target === savedPath &&
        message.metadata.insert_mode === insertMode
      )
    )) {
      return detail;
    }
    const now = new Date().toISOString();
    detail = {
      ...detail,
      updated_at: now,
      messages: [
        ...detail.messages,
        {
          id: messageId,
          role: "system",
          content: `已写回 ${savedPath}`,
          created_at: now,
          metadata: {
            write_target: savedPath,
            insert_mode: insertMode,
            ...(runId ? { write_back_run_id: runId } : {}),
            ...(journalIds.length ? { commit_journal_ids: journalIds } : {})
          }
        }
      ],
      message_count: detail.messages.length + 1
    };
    return this.conversations.saveConversation(detail);
  }

  async draftSkillFromUrl(payload: SkillDraftFromUrlRequest, options: AgentRunOptions = {}): Promise<SkillDraftResponse> {
    return this.skillRunner.draftSkillFromUrl(payload, options);
  }

  async draftSkill(payload: SkillDraftRequest, options: AgentRunOptions = {}): Promise<SkillDraftResponse> {
    return this.skillDrafts.draftSkill(payload, options);
  }

  async generateCardDraw(payload: CardDrawRequest, progress: (v: number, m: string) => void, options: AgentRunOptions = {}): Promise<CardDrawResult> {
    throwIfAborted(options.signal);
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
      throwIfAborted(options.signal);
      const generated = await this.generateCardCandidate(request, index, request.candidate_count, targetPath, options);
      throwIfAborted(options.signal);
      doneCount += 1;
      progress(0.08 + (doneCount / request.candidate_count) * 0.72, `候选 ${doneCount}/${request.candidate_count} 已生成`);
      return { index, ...generated };
    };

    throwIfAborted(options.signal);
    const tasks = Array.from({ length: request.candidate_count }, (_, i) => generateOne(i + 1));
    const results = await Promise.all(tasks);
    throwIfAborted(options.signal);

    const candidates: CardDrawCandidate[] = [];
    const webSearchSources: WebSearchSource[] = [];
    for (const res of results.sort((a, b) => a.index - b.index)) {
      throwIfAborted(options.signal);
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
    throwIfAborted(options.signal);
    await fs.mkdir(path.dirname(manifestPath), { recursive: true });
    throwIfAborted(options.signal);
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

  private async generateCardCandidate(
    request: CardDrawRequest,
    index: number,
    total: number,
    targetPath: string,
    options: AgentRunOptions = {}
  ): Promise<{ content: string; web_search_sources: WebSearchSource[] }> {
    throwIfAborted(options.signal);
    const variantInstruction = getCardDrawVariantInstruction(request, index, total);
    if (request.mode === "body") {
      return this.generateBodyCardCandidate(request, variantInstruction, targetPath, options);
    }
    if (request.mode === "chapter_outline") {
      return { content: await this.generateChapterOutlineCardCandidate(request, variantInstruction, options), web_search_sources: [] };
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
    return { content: await this.generatePromptCardCandidate(skillId, request, variantInstruction, options), web_search_sources: [] };
  }

  private async generateBodyCardCandidate(
    request: CardDrawRequest,
    instruction: string,
    targetPath: string,
    options: AgentRunOptions = {}
  ): Promise<{ content: string; web_search_sources: WebSearchSource[] }> {
    throwIfAborted(options.signal);
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
    throwIfAborted(options.signal);
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
        drawTemp,
        { signal: options.signal }
      )
    ).trim();
    throwIfAborted(options.signal);

    if (!result) {
      throw new Error("模型未返回正文候选");
    }

    const deslopped = await this.applyBodyDeslop(result, request.chapter, options);
    return { content: deslopped.text, web_search_sources: webSearch.sources };
  }

  private async generateChapterOutlineCardCandidate(request: CardDrawRequest, instruction: string, options: AgentRunOptions = {}): Promise<string> {
    throwIfAborted(options.signal);
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
    }, options);
    throwIfAborted(options.signal);

    return result.result || "";
  }

  private async generatePromptCardCandidate(skillId: string, request: CardDrawRequest, instruction: string, options: AgentRunOptions = {}): Promise<string> {
    throwIfAborted(options.signal);
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
    }, options);
    throwIfAborted(options.signal);
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

export type AgentRuntimeOptions = AgentPlannerOptions & {
  featureFlags?: AgentFeatureFlagRegistry;
  /** Safe mode keeps stale runs untouched until an operator explicitly exits it. */
  autoRecoverStaleRuns?: boolean;
};

function generatedCacheCommitResponse(cacheId: string, savedPaths: string[]): AgentRunResponse {
  return {
    intent: "file_operation",
    reply: `Generated cache ${cacheId} committed`,
    conversation: null,
    plan: null,
    results: [],
    skill_result: null,
    saved_paths: savedPaths,
    requires_confirmation: false
  };
}

function staleRecoveryOperationId(runId: string): string {
  return `op_stale_recovery_${sha256Text(runId).slice(0, 24)}`;
}

function buildDurableSkillAgentRequest(skillId: string, request: SkillRunRequest): AgentRunRequest {
  return {
    request_id: String(request.request_id || "").trim(),
    autonomy_mode: "execute",
    conversation_id: request.conversation_id || "",
    content: request.instruction || request.text || `运行技能 ${skillId}`,
    current_path: request.source_path || "",
    selection: request.text || "",
    project_context_hint: "",
    skill_id: skillId,
    attachment_ids: request.attachment_ids || [],
    reference_paths: request.reference_paths || [],
    confirmed_reference_paths: request.confirmed_reference_paths || [],
    disable_auto_references: Boolean(request.disable_auto_references),
    skill_request_origin: DIRECT_SKILL_REQUEST_ORIGIN,
    instruction: request.instruction || "",
    text: request.text || "",
    chapter: request.chapter || undefined,
    end_chapter: request.end_chapter || undefined,
    target_words: request.target_words || undefined,
    source_path: request.source_path || "",
    target_path: request.target_path || "",
    write_result: Boolean(request.write_result)
  };
}

function durableAgentRequestToSkillRequest(request: AgentRunRequest): SkillRunRequest {
  return skillRunRequestSchema.parse({
    request_id: request.request_id || "",
    text: String(request.text ?? request.selection ?? ""),
    chapter: Number(request.chapter || 0),
    end_chapter: Number(request.end_chapter || 0),
    target_words: Number(request.target_words || 2500),
    instruction: String(request.instruction ?? request.content ?? ""),
    target_path: String(request.target_path || ""),
    conversation_id: request.conversation_id || "",
    source_path: String(request.source_path ?? request.current_path ?? ""),
    write_result: Boolean(request.write_result),
    attachment_ids: request.attachment_ids || [],
    reference_paths: request.reference_paths || [],
    confirmed_reference_paths: request.confirmed_reference_paths || [],
    disable_auto_references: Boolean(request.disable_auto_references)
  });
}

function isDurableSkillAgentRequest(request: AgentRunRequest): boolean {
  return String(request.skill_request_origin || "") === DIRECT_SKILL_REQUEST_ORIGIN
    && Boolean(String(request.skill_id || "").trim());
}

function deterministicGeneratedCacheId(
  execution: DurableRunExecution,
  skillId: string,
  scope = "direct"
): string {
  return sha256Text(stableJson({
    schema_version: 1,
    kind: "prompt_skill_generation",
    run_id: execution.run_id,
    step_id: execution.step_id,
    skill_id: skillId,
    scope
  })).slice(0, 32);
}

function parseDeferredPromptSkillCommit(
  value: unknown,
  expectedSkillId: string
): DeferredPromptSkillCommit | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (!isRecord(value) || value.kind !== "prompt_skill_generated_cache") {
    throw codedRuntimeError("PROMPT_SKILL_DEFERRED_COMMIT_INVALID", "Prompt Skill 延迟提交描述无效");
  }
  const cacheId = String(value.cache_id || "").trim();
  const skillId = String(value.skill_id || "").trim();
  const mode = value.mode === "append" ? "append" : value.mode === "replace" ? "replace" : "";
  if (!cacheId || !skillId || skillId !== expectedSkillId || !mode) {
    throw codedRuntimeError(
      "PROMPT_SKILL_DEFERRED_COMMIT_INVALID",
      "Prompt Skill 延迟提交描述与当前技能不匹配"
    );
  }
  return {
    kind: "prompt_skill_generated_cache",
    cache_id: cacheId,
    skill_id: skillId,
    mode,
    target_paths: stringListFromUnknown(value.target_paths),
    save_plan: generatedSavePlanSchema.parse(value.save_plan || {}),
    source: String(value.source || "prompt_skill").trim() || "prompt_skill",
    summary: String(value.summary || `Prompt Skill auto-commit: ${skillId}`),
    requires_confirmation: value.requires_confirmation === true,
    lore_merge_existing: value.lore_merge_existing === true
  };
}

function withDurableSkillIdentity(
  result: SkillRunResponse,
  runId: string,
  requestId: string,
  replayed: boolean
): SkillRunResponse {
  return skillRunResponseSchema.parse({
    ...result,
    data: {
      ...(result.data || {}),
      run_id: runId,
      request_id: requestId,
      replayed
    }
  });
}

function durableSkillAgentResponse(skillId: string, result: SkillRunResponse): AgentRunResponse {
  const savedPaths = Array.isArray(result.data?.saved_paths)
    ? result.data.saved_paths.map(String).filter(Boolean)
    : result.saved_path
      ? [result.saved_path]
      : [];
  return {
    intent: "skill",
    reply: savedPaths.length
      ? `已写入 ${savedPaths.length} 个文件：\n${savedPaths.join("\n")}`
      : result.result || "技能已完成。",
    results: [],
    skill_result: result,
    saved_paths: savedPaths,
    requires_confirmation: false,
    current_skill: skillId
  };
}

function loreSectionTitleForPath(targetPath: string): string {
  const normalized = String(targetPath || "").replace(/\\/g, "/");
  return Object.entries(LORE_SECTION_TARGETS)
    .find(([, candidate]) => candidate === normalized)?.[0] || "";
}

function canonicalGeneratedPaths(paths: string[]): string[] {
  return [...new Set(paths
    .map((item) => String(item || "").trim().replace(/\\/g, "/"))
    .filter(Boolean))]
    .sort();
}

function canonicalGeneratedSavePlan(savePlan: GeneratedSavePlan): GeneratedSavePlan {
  return {
    ...savePlan,
    target_paths: canonicalGeneratedPaths(savePlan.target_paths || []),
    segments: (savePlan.segments || []).map((segment) => ({
      ...segment,
      target_path: String(segment.target_path || "").trim().replace(/\\/g, "/")
    }))
  };
}

function sectionedGeneratedSummaryPrefix(skillId: SectionedGeneratedSkillId): string {
  if (skillId === "style_extract") {
    return "风格库保存";
  }
  if (skillId === "genre_generate") {
    return "题材库保存";
  }
  return "设定提取保存";
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const record = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    if (record[key] !== undefined) {
      sorted[key] = sortJsonValue(record[key]);
    }
  }
  return sorted;
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sha256ContentHash(value: string): string {
  return `sha256:${sha256Text(value)}`;
}

function codedRuntimeError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
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

function buildSkillDraftManagementReply(draft: SkillDraftResponse): string {
  const lines = [
    "已生成技能草稿（未导入）。",
    `- id: ${draft.skill.id}`,
    `- 名称：${draft.skill.name}`,
    `- 类型：${draft.skill.handler_type}`,
    `- 可写入：${draft.skill.writable ? "是" : "否"}`,
    "请在技能页预览 prompt 后确认导入。"
  ];
  if (draft.warnings.length) {
    lines.push(`提示：${draft.warnings.join("；")}`);
  }
  return lines.join("\n");
}

function buildSkillPatchManagementReply(target: SkillDefinition, patch: SkillPatchResponse): string {
  const lines = [
    `已生成技能修改预览（未保存）：${target.name}（${target.id}）。`,
    patch.diff.trim() ? "修改差异：" : "当前没有检测到可保存的差异。",
    patch.diff.trim() ? clipForConsistency(patch.diff.trim(), 1800) : "",
    patch.diff.trim() ? "请在技能页检查 diff 后确认保存。" : ""
  ].filter(Boolean);
  return lines.join("\n");
}

function skillManagementActionLabel(action: SkillManagementIntent["action"]): string {
  const labels: Record<SkillManagementIntent["action"], string> = {
    draft: "创建技能",
    patch: "修改技能",
    clone: "复制技能",
    rollback: "回滚技能",
    disable: "禁用技能",
    restore: "恢复技能"
  };
  return labels[action] || "管理技能";
}

function extractQuotedText(text: string): string {
  const match = String(text || "").match(/[“"《]([^”"》]{2,80})[”"》]/);
  return match?.[1]?.trim() || "";
}

function normalizeGeneratedSkillId(value: string): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}

function normalizeSkillMention(value: string): string {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[《》“”"'`，。！？、：:；;（）()【】\[\]{}]/g, "");
}

function pickTraceMetadata(value: unknown): Record<string, string | number | boolean> {
  if (!isRecord(value)) {
    return {};
  }
  const allowedKeys = ["role", "path", "label", "kind", "confidence", "matched_text", "reason"];
  const metadata: Record<string, string | number | boolean> = {};
  for (const key of allowedKeys) {
    const item = value[key];
    if (typeof item === "string") {
      const text = item.trim();
      if (text) {
        metadata[key] = text.slice(0, 500);
      }
    } else if (typeof item === "number" && Number.isFinite(item)) {
      metadata[key] = item;
    } else if (typeof item === "boolean") {
      metadata[key] = item;
    }
  }
  return metadata;
}

function flattenTraceMetadata(metadata: Record<string, string | number | boolean>): Record<string, string | number | boolean> {
  const flattened: Record<string, string | number | boolean> = {};
  for (const key of ["role", "path", "label", "kind", "confidence", "matched_text"]) {
    if (metadata[key] !== undefined) {
      flattened[key] = metadata[key]!;
    }
  }
  return flattened;
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

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item) => String(item || "").trim()).filter(Boolean);
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths.map((item) => item.trim()).filter(Boolean))];
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
