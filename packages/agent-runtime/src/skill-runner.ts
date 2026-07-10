import { loadModelConfig, type ConfigServiceOptions } from "@xiaoshuo/config-service";
import { ConversationService } from "@xiaoshuo/conversation-service";
import { DocumentService } from "@xiaoshuo/document-service";
import { GeneratedCacheService } from "@xiaoshuo/generated-cache";
import { OpenAICompatibleClient, type ChatCompletionMessage } from "@xiaoshuo/model-client";
import { buildProjectContinuityContext } from "@xiaoshuo/project-session";
import { SkillService } from "@xiaoshuo/skill-service";
import { skillRunResponseSchema, skillDraftFromUrlRequestSchema, skillDraftResponseSchema, type AgentStreamEvent, type GeneratedSavePlan, type SkillDefinition, type SkillRunRequest, type SkillRunResponse, type SkillDraftFromUrlRequest, type SkillDraftResponse } from "@xiaoshuo/shared";
import path from "node:path";
import { HUMANIZER_SYSTEM_PROMPT, applyHumanizerIfEnabled } from "./humanizer.js";
import { GeneratedSavePlanner } from "./generated-save-planner.js";
import { assembleContext } from "./kernel/context-assembler.js";
import type { ContextBlock } from "./kernel/context-block.js";
import { ProjectFileResolver } from "./kernel/project-file-resolver.js";
import {
  mergeLoreSectionText,
  prepareSectionedGeneratedSave,
  sectionedGeneratedTargetPaths
} from "./sectioned-generated-save.js";
import { buildStyleGenreConstraintBlock } from "./style-genre-context.js";
import { streamModelText, StreamingGenerationSession, type StreamingModelClient } from "./stream.js";
import { isCancellationError, throwIfAborted, type AgentRunOptions } from "./cancellation.js";

const DEFAULT_TARGETS: Record<string, string> = {
  outline_generate: "01_大纲/大纲.txt",
  detail_outline_generate: "01_大纲/细纲.txt",
  chapter_outline_generate: "01_大纲/章纲.txt",
  reverse_outline_extract: "01_大纲/反向细纲.txt",
  style_extract: "00_设定集/风格库/写作风格.txt",
  polish_text: "02_正文/润色结果.txt",
  continue_text: "02_正文/续写结果.txt",
  story_deslop: "02_正文/去AI味结果.txt",
  humanizer_zh: "02_正文/去AI味结果.txt"
};

const LORE_EXTRACT_SOURCE_FALLBACKS = ["01_大纲/章纲.txt", "01_大纲/细纲.txt", "01_大纲/大纲.txt"];

const LOCAL_BLOCKED_SKILLS = new Set<string>();

const PROMPT_SKILL_SOURCE_FALLBACKS: Record<string, string[]> = {
  detail_outline_generate: ["01_大纲/大纲.txt"],
  chapter_outline_generate: ["01_大纲/细纲.txt", "01_大纲/大纲.txt"]
};

const MAX_SOURCE_CHARS = 24_000;
const MAX_COMPACT_PROMPT_CHARS = 12_000;

const STORY_DESLOP_SYSTEM_PROMPT = `
你是 story-deslop 去AI味编辑。任务：检测并清除网文文本里的 AI 写作痕迹，让文字回到自然、有人味的状态。

核心原则：
1. 只改“怎么说”，不改“说什么”。不得改变剧情事实、人设、世界观、章节目标、伏笔和因果链。
2. 改最少，效果最大。能改一个词就不改一句，能删一句废话就不重写一段。
3. 不做整段删除，不压缩故事信息。删除或改写前必须保留情节推进、伏笔、钩子、角色特征。
4. 自动后处理模式下只输出处理后的正文/细纲/章纲本体，不输出检测报告、解释、标题、免责声明或修改说明。

重点清除的 AI 痕迹：
- 空泛拔高、总结升华、广告腔、模板化结尾。
- 过于书面化、过于圆滑、过于对仗工整、三段式罗列和连续排比。
- 高频 AI 词和句式：仿佛、犹如、宛若、一丝、一抹、深吸一口气、缓缓、不禁、微微、眼中闪过、嘴角勾起、心中一动、不容置疑、显而易见、突然、瞬间、这一刻、他知道、她明白、由此可见、与此同时。
- “……，带着……”万能状语、“像刀子一样”陈词滥调比喻、“他说道/问道”机械标签、“他感到/意识到”直接告知。
- 情绪用动作、对话、场景和感官细节外化；少解释，多呈现。

输出要求：
- 保留原有格式、章节编号、段落层级和文件用途。
- 细纲/章纲：保持事件链、目标、冲突、转折和伏笔位置，只让表达更具体、更像人工策划。
- 正文：保留剧情动作和对白，不新增主线冲突，不改结尾走向；句子长短要有变化，允许口语、停顿、留白和毛边。
`.trim();

export type PromptSkillRunnerOptions = {
  projectRoot: string;
  config?: ConfigServiceOptions;
  modelClient?: StreamingModelClient;
};

/**
 * Keeps generation and its pending cache intact while leaving a durable caller
 * responsible for committing document side effects through its journal.
 */
export type PromptSkillRunOptions = AgentRunOptions & {
  deferAutoCommit?: boolean;
  deterministicCacheId?: string;
};

export class PromptSkillRunner {
  private readonly projectRoot: string;
  private readonly config: ConfigServiceOptions;
  private readonly documents: DocumentService;
  private readonly skills: SkillService;
  private readonly cache: GeneratedCacheService;
  private readonly conversations: ConversationService;
  private readonly modelClient: StreamingModelClient;
  private readonly savePlanner: GeneratedSavePlanner;
  private readonly fileResolver: ProjectFileResolver;

  constructor(options: PromptSkillRunnerOptions) {
    this.projectRoot = path.resolve(options.projectRoot);
    this.config = options.config ?? {};
    this.documents = new DocumentService({ projectRoot: this.projectRoot });
    this.skills = new SkillService({ projectRoot: this.projectRoot });
    this.cache = new GeneratedCacheService({ projectRoot: this.projectRoot });
    this.conversations = new ConversationService({ projectRoot: this.projectRoot });
    this.modelClient = options.modelClient ?? new OpenAICompatibleClient();
    this.fileResolver = new ProjectFileResolver({ projectRoot: this.projectRoot, documents: this.documents });
    this.savePlanner = new GeneratedSavePlanner({
      projectRoot: this.projectRoot,
      config: this.config,
      modelClient: this.modelClient
    });
  }

  async canRunSkillLocally(skillId: string): Promise<boolean> {
    const skill = await this.skills.getSkill(skillId);
    return Boolean(skill && skill.handler_type === "prompt" && !LOCAL_BLOCKED_SKILLS.has(skill.id));
  }

  async runSkill(skillId: string, payload: SkillRunRequest, options: PromptSkillRunOptions = {}): Promise<SkillRunResponse> {
    throwIfAborted(options.signal);
    const skill = await this.skills.getSkill(skillId);
    if (!skill) {
      throw new Error(`未知 skill: ${skillId}`);
    }
    if (skill.handler_type !== "prompt" || LOCAL_BLOCKED_SKILLS.has(skill.id)) {
      throw new Error(`TS runtime 尚未接管该 skill: ${skillId}`);
    }

    const restored = await this.restoreDeferredSkillResult(skill, payload, options);
    if (restored) {
      return restored;
    }

    const result = await this.runPromptSkill(skill, payload, options);
    return this.finalizePromptSkill(skill, payload, result, undefined, options);
  }

  async *streamSkill(skillId: string, payload: SkillRunRequest, options: PromptSkillRunOptions = {}): AsyncGenerator<AgentStreamEvent> {
    throwIfAborted(options.signal);
    const skill = await this.skills.getSkill(skillId);
    if (!skill) {
      throw new Error(`未知 skill: ${skillId}`);
    }
    if (skill.handler_type !== "prompt" || LOCAL_BLOCKED_SKILLS.has(skill.id)) {
      throw new Error(`TS runtime 尚未接管该 skill: ${skillId}`);
    }

    const restored = await this.restoreDeferredSkillResult(skill, payload, options);
    if (restored) {
      yield {
        type: "final",
        payload: await this.skillResponseToAgentResponse(skill, payload, restored)
      };
      return;
    }

    const config = await loadModelConfig(this.config, "primary");
    if (!config.configured) {
      throw new Error("未配置主线路 API Key 或模型名。");
    }

    const context = await buildProjectContinuityContext(this.projectRoot);
    const sourceText = await this.resolvePromptSourceText(skill, payload);
    const systemPrompt = this.resolveSystemPrompt(skill);
    const messages = this.buildMessages(skill, systemPrompt, context, sourceText || payload.text, payload.instruction, false);
    const compactMessages = this.buildMessages(skill, systemPrompt, context, sourceText || payload.text, payload.instruction, true);
    const session = new StreamingGenerationSession(this.cache);
    const initialTargets = this.pendingSaveTargets(skill, payload);
    const deterministicCacheId = String(options.deterministicCacheId || "").trim();
    let deterministicText = "";
    const initial = deterministicCacheId
      ? await this.startDeterministicStreamCache(deterministicCacheId, skill, payload, initialTargets)
      : await session.start({
        source: "skill_stream",
        target_paths: initialTargets,
        skill_id: skill.id,
        mode: "replace",
        conversation_id: payload.conversation_id,
        summary: `Skill 流式缓存：${skill.name}`
      });

    try {
      for await (const chunk of streamModelText({
        modelClient: this.modelClient,
        config,
        messages,
        fallbackMessages: compactMessages,
        temperature: config.temperature,
        signal: options.signal
      })) {
        throwIfAborted(options.signal);
        if (deterministicCacheId) {
          deterministicText += chunk;
          await this.cache.append(deterministicCacheId, chunk);
        } else {
          await session.append(chunk);
        }
        yield {
          type: "delta",
          text: chunk,
          stage: "skill_stream",
          skill_id: skill.id,
          cache_id: initial.cache_id,
          target_paths: initialTargets,
          append_mode: "replace"
        };
      }
      const raw = deterministicCacheId
        ? await this.cache.get(deterministicCacheId)
        : await session.finalize();
      throwIfAborted(options.signal);
      const streamedText = deterministicCacheId ? deterministicText : session.text || "";
      const finalText = await this.applyDefaultDeslop(skill.id, streamedText, options);
      throwIfAborted(options.signal);
      if (finalText.trim() !== streamedText.trim()) {
        await this.cache.replace(initial.cache_id, finalText);
      }
      yield {
        type: "final",
        payload: await this.skillResponseToAgentResponse(
          skill,
          payload,
          await this.finalizePromptSkill(skill, payload, finalText, {
            cacheId: initial.cache_id,
            cachePath: raw.cache_path,
            cacheChars: finalText.length
          }, options)
        )
      };
    } catch (error) {
      if (deterministicCacheId) {
        await this.cache.markFailed(deterministicCacheId, error instanceof Error ? error.message : String(error));
      } else {
        await session.fail(error);
      }
      if (isCancellationError(error, options.signal)) {
        throw error;
      }
      yield {
        type: "error",
        message: error instanceof Error ? error.message : String(error)
      };
    }
  }

  private async startDeterministicStreamCache(
    cacheId: string,
    skill: SkillDefinition,
    payload: SkillRunRequest,
    targetPaths: string[]
  ): Promise<{ cache_id: string; cache_path: string; chars: number }> {
    const existing = await this.cache.get(cacheId).catch(() => null);
    if (existing && existing.status !== "pending") {
      throw new Error(`确定性 Skill 流式缓存状态为 ${existing.status}，不能重新开始`);
    }
    const meta = existing || await this.cache.createWithId(cacheId, {
      source: "skill_stream",
      target_paths: targetPaths,
      skill_id: skill.id,
      mode: "replace",
      conversation_id: payload.conversation_id,
      summary: `Skill 流式缓存：${skill.name}`
    });
    if (meta.skill_id && meta.skill_id !== skill.id) {
      throw new Error(`确定性 Skill 缓存已绑定到 ${meta.skill_id}`);
    }
    await this.cache.replace(cacheId, "");
    return { cache_id: cacheId, cache_path: meta.cache_path, chars: 0 };
  }

  private async runPromptSkill(skill: SkillDefinition, payload: SkillRunRequest, options: AgentRunOptions = {}): Promise<string> {
    throwIfAborted(options.signal);
    const config = await loadModelConfig(this.config, "primary");
    if (!config.configured) {
      throw new Error("未配置主线路 API Key 或模型名。");
    }

    const context = await buildProjectContinuityContext(this.projectRoot);
    const sourceText = await this.resolvePromptSourceText(skill, payload);
    const systemPrompt = this.resolveSystemPrompt(skill);

    try {
      const result = await this.modelClient.requestCompletion(
        config,
        this.buildMessages(skill, systemPrompt, context, sourceText || payload.text, payload.instruction, false),
        config.temperature,
        { signal: options.signal }
      );
      throwIfAborted(options.signal);
      return this.applyDefaultDeslop(skill.id, result, options);
    } catch (error) {
      if (isCancellationError(error, options.signal)) {
        throw error;
      }
      if (!looksGatewayTimeout(error)) {
        throw error;
      }
    }

    const compactResult = await this.modelClient.requestCompletion(
      config,
      this.buildMessages(skill, systemPrompt, context, sourceText || payload.text, payload.instruction, true),
      config.temperature,
      { signal: options.signal }
    );
    throwIfAborted(options.signal);
    return this.applyDefaultDeslop(skill.id, compactResult, options);
  }

  private buildMessages(
    skill: SkillDefinition,
    systemPrompt: string,
    context: Awaited<ReturnType<typeof buildProjectContinuityContext>>,
    sourceText: string,
    instruction: string,
    compact: boolean
  ): ChatCompletionMessage[] {
    const prompt = buildSkillPrompt(skill, context, sourceText, instruction, compact);
    const assembled = assembleContext(prompt, {
      mode: compact ? "compact_retry" : "prompt_skill",
      budget: compact ? MAX_COMPACT_PROMPT_CHARS : undefined,
      separator: "\n\n"
    });
    return [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: assembled.text
      }
    ];
  }

  private async resolvePromptSourceText(skill: SkillDefinition, payload: SkillRunRequest): Promise<string> {
    const directText = String(payload.text || "").trim();
    if (directText) {
      return directText;
    }

    const attachmentText = await this.resolveAttachmentText(payload);
    if (attachmentText) {
      return attachmentText;
    }

    const explicitReferenceText = await this.resolveReferenceText(payload, false);
    if (explicitReferenceText) {
      return explicitReferenceText;
    }

    if (skill.id === "lore_extract") {
      for (const relPath of LORE_EXTRACT_SOURCE_FALLBACKS) {
        const fallbackText = await this.readProjectText(relPath);
        if (fallbackText) {
          return fallbackText;
        }
      }
    }

    const sourcePath = normalizeOptionalPath(this.documents, payload.source_path);
    const outputPath = normalizeOptionalPath(this.documents, DEFAULT_TARGETS[skill.id] || "");
    if (sourcePath && sourcePath !== outputPath) {
      const fileText = await this.readProjectText(sourcePath);
      if (fileText) {
        return fileText;
      }
    }

    const autoReferenceText = await this.resolveReferenceText(payload, true);
    if (autoReferenceText) {
      return autoReferenceText;
    }

    for (const relPath of PROMPT_SKILL_SOURCE_FALLBACKS[skill.id] || []) {
      const fallbackText = await this.readProjectText(relPath);
      if (fallbackText) {
        return fallbackText;
      }
    }

    return "";
  }

  private async resolveReferenceText(payload: SkillRunRequest, includeAuto: boolean): Promise<string> {
    try {
      const resolution = await this.fileResolver.resolve({
        text: [payload.instruction || "", payload.text || ""].filter(Boolean).join("\n"),
        currentPath: payload.source_path || "",
        attachmentIds: payload.attachment_ids || [],
        explicitPaths: payload.reference_paths || [],
        confirmedPaths: payload.confirmed_reference_paths || [],
        disableAutoReferences: includeAuto ? payload.disable_auto_references : true,
        maxCandidates: 4
      });
      const references = includeAuto
        ? resolution.references
        : resolution.references.filter((reference) => reference.kind === "explicit_path" || reference.kind === "at_path");
      const chunks: string[] = [];
      for (const reference of references.slice(0, includeAuto ? 4 : 6)) {
        const text = await this.readProjectText(reference.path);
        if (text) {
          chunks.push(`【参考文件：${reference.path}】\n【引用原因：${reference.reason || "用户引用"}】\n\n${text}`);
        }
      }
      return chunks.join("\n\n").trim();
    } catch {
      return "";
    }
  }

  private async resolveAttachmentText(payload: SkillRunRequest): Promise<string> {
    if (!payload.conversation_id || !(payload.attachment_ids || []).length) {
      return "";
    }
    const attachments = await this.conversations.getAttachmentTexts(payload.conversation_id, payload.attachment_ids);
    return attachments
      .map(([attachment, text]) => {
        const body = String(text || "").trim();
        return body ? `【${attachment.name}】\n${body}` : "";
      })
      .filter(Boolean)
      .join("\n\n")
      .trim();
  }

  private async readProjectText(relativePath: string): Promise<string> {
    try {
      return (await this.documents.readRawText(relativePath, MAX_SOURCE_CHARS)).trim();
    } catch {
      return "";
    }
  }

  private async restoreDeferredSkillResult(
    skill: SkillDefinition,
    payload: SkillRunRequest,
    options: PromptSkillRunOptions
  ): Promise<SkillRunResponse | null> {
    const cacheId = String(options.deterministicCacheId || "").trim();
    if (!cacheId || !options.deferAutoCommit) {
      return null;
    }
    const meta = await this.cache.get(cacheId).catch(() => null);
    if (!meta || meta.status !== "pending" || meta.skill_id !== skill.id || !meta.save_plan) {
      return null;
    }
    const result = await this.cache.readContent(cacheId).catch(() => "");
    if (!result.trim()) {
      return null;
    }
    const savePlan = meta.save_plan;
    const targetPaths = savePlan.target_paths.length ? savePlan.target_paths : this.pendingSaveTargets(skill, payload);
    return skillRunResponseSchema.parse({
      result,
      saved_path: "",
      data: {
        skill_id: skill.id,
        saved_paths: [],
        pending_save: true,
        target_paths: targetPaths,
        target_path: targetPaths[0] || "",
        result,
        default_mode: savePlan.mode,
        cache_id: cacheId,
        cache_path: meta.cache_path,
        cache_chars: meta.chars,
        save_plan: savePlan,
        deferred_commit: this.deferredCommitDescription(skill, payload, cacheId, savePlan, targetPaths)
      }
    });
  }

  private deferredCommitDescription(
    skill: SkillDefinition,
    payload: SkillRunRequest,
    cacheId: string,
    savePlan: GeneratedSavePlan,
    targetPaths: string[]
  ): Record<string, unknown> {
    return {
      kind: "prompt_skill_generated_cache",
      cache_id: cacheId,
      skill_id: skill.id,
      mode: savePlan.mode,
      target_paths: targetPaths,
      save_plan: savePlan,
      source: "prompt_skill",
      summary: `Prompt Skill auto-commit: ${skill.name || skill.id}`,
      requires_confirmation: Boolean(savePlan.requires_confirmation),
      ...(skill.id === "lore_extract"
        ? { lore_merge_existing: !shouldOverwriteLore(payload.instruction) }
        : {})
    };
  }

  private async finalizePromptSkill(
    skill: SkillDefinition,
    payload: SkillRunRequest,
    result: string,
    existingCache?: { cacheId: string; cachePath?: string; cacheChars?: number },
    options: PromptSkillRunOptions = {}
  ): Promise<SkillRunResponse> {
    throwIfAborted(options.signal);
    const humanized = await applyHumanizerIfEnabled({
      text: String(result || "").trim(),
      config: this.config,
      modelClient: this.modelClient,
      mode: `${skill.name || skill.id} 生成结果`,
      skip: skill.id === "humanizer_zh",
      signal: options.signal
    });
    throwIfAborted(options.signal);
    const finalResult = humanized.text;
    let savedPaths: string[] = [];
    let savedPath = "";
    const savePlan = await this.savePlanner.planGeneratedSave({
      instruction: payload.instruction || "",
      content: finalResult,
      source: "skill",
      skillId: skill.id,
      targetPaths: this.pendingSaveTargets(skill, payload),
      targetPath: payload.target_path || "",
      currentPath: payload.source_path || "",
      chapter: payload.chapter || 0,
      writeRequested: payload.write_result,
      defaultMode: "replace"
    }, options);
    throwIfAborted(options.signal);
    const targetPaths = savePlan.target_paths;
    const data: Record<string, unknown> = {
      skill_id: skill.id,
      saved_paths: [],
      save_plan: savePlan,
      ...(humanized.applied ? { humanized: true, humanizer_skill_id: "humanizer_zh" } : {}),
      ...(humanized.error ? { humanizer_error: humanized.error } : {})
    };

    if (finalResult && existingCache?.cacheId) {
      throwIfAborted(options.signal);
      const updated = await this.cache.replace(existingCache.cacheId, finalResult);
      data.result = finalResult;
      data.cache_id = existingCache.cacheId;
      data.cache_path = updated.cache_path || existingCache.cachePath || "";
      data.cache_chars = updated.chars || existingCache.cacheChars || finalResult.length;
      if (targetPaths.length) {
        await this.cache.updateSavePlan(existingCache.cacheId, savePlan);
      }
    }

    if (targetPaths.length && finalResult) {
      throwIfAborted(options.signal);
      const entry = existingCache?.cacheId
        ? await this.cache.get(existingCache.cacheId)
          : options.deterministicCacheId
            ? await this.cache.createWithId(options.deterministicCacheId, {
                source: "skill_result",
                target_paths: targetPaths,
                skill_id: skill.id,
                mode: savePlan.mode,
                conversation_id: payload.conversation_id,
                summary: `Skill 结果缓存：${skill.name}`,
                save_plan: savePlan
              })
            : await this.cache.create({
            source: "skill_result",
            target_paths: targetPaths,
            skill_id: skill.id,
            mode: savePlan.mode,
            conversation_id: payload.conversation_id,
            summary: `Skill 结果缓存：${skill.name}`,
            save_plan: savePlan
              });
      if (!existingCache?.cacheId) {
        await this.cache.replace(entry.cache_id, finalResult);
      }

      const shouldAutoCommit = await this.savePlanner.shouldAutoCommit(savePlan);
      if (shouldAutoCommit && !options.deferAutoCommit) {
        throwIfAborted(options.signal);
        savedPaths =
          skill.id === "style_extract"
            ? await this.saveStyleSections(finalResult, savePlan.mode, {
                summaryPrefix: "风格库确认保存"
              })
            : skill.id === "genre_generate"
            ? await this.saveGenreSections(finalResult, savePlan.mode, {
                summaryPrefix: "题材库确认保存"
              })
            : skill.id === "lore_extract"
              ? await this.saveLoreSections(finalResult, savePlan.mode, {
                  summaryPrefix: "设定提取确认保存",
                  mergeExisting: !shouldOverwriteLore(payload.instruction)
                })
              : await this.cache.commitSavePlan(entry.cache_id, savePlan, {
                cleanupContent: true
              });
        savedPath = savedPaths[0] || "";
        data.saved_paths = savedPaths;
        await this.cache.markCommitted(entry.cache_id, savedPaths, { cleanupContent: true });
      } else {
        const meta = await this.cache.get(entry.cache_id);
        data.pending_save = true;
        data.target_paths = targetPaths;
        data.target_path = targetPaths[0] || "";
        data.result = finalResult;
        data.default_mode = savePlan.mode;
        data.cache_id = entry.cache_id;
        data.cache_path = meta.cache_path;
        data.cache_chars = meta.chars;
        data.save_plan = meta.save_plan || savePlan;
        if (shouldAutoCommit && options.deferAutoCommit) {
          data.deferred_commit = this.deferredCommitDescription(skill, payload, entry.cache_id, meta.save_plan || savePlan, targetPaths);
        }
      }
    }

    return skillRunResponseSchema.parse({
      result: finalResult,
      saved_path: savedPath,
      data
    });
  }

  private async skillResponseToAgentResponse(skill: SkillDefinition, payload: SkillRunRequest, result: SkillRunResponse) {
    const savedPaths = Array.isArray(result.data?.saved_paths)
      ? result.data.saved_paths.filter((item): item is string => typeof item === "string")
      : result.saved_path
        ? [result.saved_path]
        : [];
    return {
      intent: "skill" as const,
      reply: savedPaths.length ? `已写入 ${savedPaths.length} 个文件：\n${savedPaths.join("\n")}` : result.result || "技能已完成。",
      conversation: undefined,
      results: [],
      skill_result: result,
      saved_paths: savedPaths,
      requires_confirmation: false,
      current_skill: skill.name || skill.id
    };
  }

  private pendingSaveTargets(skill: SkillDefinition, payload: SkillRunRequest): string[] {
    if (skill.id === "style_extract") {
      return sectionedGeneratedTargetPaths("style_extract");
    }
    if (skill.id === "genre_generate") {
      return sectionedGeneratedTargetPaths("genre_generate");
    }
    if (skill.id === "lore_extract") {
      return sectionedGeneratedTargetPaths("lore_extract");
    }
    const explicit = normalizeOptionalPath(this.documents, payload.target_path);
    if (explicit) {
      return [explicit];
    }
    const linked = this.normalizeTargetPaths(skill.linked_targets);
    if (linked.length) {
      return linked;
    }
    const fallback = normalizeOptionalPath(this.documents, DEFAULT_TARGETS[skill.id] || "");
    return fallback ? [fallback] : [];
  }

  private normalizeTargetPaths(paths: string[]): string[] {
    const normalized: string[] = [];
    const seen = new Set<string>();
    for (const candidate of paths || []) {
      const relPath = normalizeOptionalPath(this.documents, candidate);
      if (!relPath || seen.has(relPath)) {
        continue;
      }
      seen.add(relPath);
      normalized.push(relPath);
    }
    return normalized;
  }

  private async applyDefaultDeslop(skillId: string, value: string, options: AgentRunOptions = {}): Promise<string> {
    throwIfAborted(options.signal);
    const result = String(value || "").trim();
    if (!result) {
      return result;
    }
    const mode = skillId === "detail_outline_generate" ? "detail_outline" : skillId === "chapter_outline_generate" ? "chapter_outline" : "";
    if (!mode) {
      return result;
    }

    const config = await loadModelConfig(this.config, "primary");
    throwIfAborted(options.signal);
    const systemPrompt = STORY_DESLOP_SYSTEM_PROMPT;
    const userPrompt = [
      `【处理模式】${mode === "detail_outline" ? "细纲去AI味" : "章纲去AI味"}`,
      "【上下文提示】Skill 自动后处理",
      "",
      "请对下面文本执行 story-deslop 去AI味。只输出处理后的文本本体。",
      "",
      `【待处理文本】\n${result.slice(0, 30000)}`
    ].join("\n");

    try {
      const polished = String(
        await this.modelClient.requestCompletion(
          config,
          [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt }
          ],
          Math.max(0.2, Math.min(0.7, config.temperature)),
          { signal: options.signal }
        )
      ).trim();
      throwIfAborted(options.signal);
      const cleaned = cleanDeslopOutput(polished);
      return guardAgainstOverdelete(result, cleaned);
    } catch (error) {
      if (isCancellationError(error, options.signal)) {
        throw error;
      }
      return result;
    }
  }

  private resolveSystemPrompt(skill: SkillDefinition): string {
    if (skill.id === "humanizer_zh") {
      return `${HUMANIZER_SYSTEM_PROMPT}\n\n用户手动调用时，仍然只返回去AI味后的文本。若用户明确要求检测报告，再单独输出简短报告。`;
    }
    if (skill.id === "story_deslop") {
      return `${STORY_DESLOP_SYSTEM_PROMPT}\n\n用户手动调用时，仍然只返回去AI味后的文本。若用户明确要求检测报告，再单独输出简短报告。`;
    }
    return (skill.prompt || "").trim() || `你是小说创作技能：${skill.name}。${skill.description}`;
  }

  public async saveStyleSections(
    result: string,
    mode: "replace" | "append",
    options: { summaryPrefix: string }
  ): Promise<string[]> {
    const prepared = prepareSectionedGeneratedSave({
      skillId: "style_extract",
      result,
      mode,
      summaryPrefix: options.summaryPrefix
    });
    const savedPaths: string[] = [];
    for (const item of prepared) {
      await this.saveGeneratedText(item.target_path, item.content, item.mode, item.summary);
      savedPaths.push(item.target_path);
    }
    return savedPaths;
  }

  public async saveGenreSections(
    result: string,
    mode: "replace" | "append",
    options: { summaryPrefix: string }
  ): Promise<string[]> {
    const prepared = prepareSectionedGeneratedSave({
      skillId: "genre_generate",
      result,
      mode,
      summaryPrefix: options.summaryPrefix
    });
    const savedPaths: string[] = [];
    for (const item of prepared) {
      await this.saveGeneratedText(item.target_path, item.content, item.mode, item.summary);
      savedPaths.push(item.target_path);
    }
    return savedPaths;
  }

  public async saveLoreSections(
    result: string,
    mode: "replace" | "append",
    options: { summaryPrefix: string; mergeExisting: boolean }
  ): Promise<string[]> {
    const prepared = prepareSectionedGeneratedSave({
      skillId: "lore_extract",
      result,
      mode,
      summaryPrefix: options.summaryPrefix
    });
    const savedPaths: string[] = [];
    for (const item of prepared) {
      if (mode === "append") {
        await this.saveGeneratedText(item.target_path, item.content, "append", item.summary);
        savedPaths.push(item.target_path);
        continue;
      }

      let nextText = item.content;
      if (options.mergeExisting) {
        let existing = "";
        try {
          existing = await this.documents.readRawText(item.target_path);
        } catch {
          existing = "";
        }
        nextText = mergeLoreSectionText(item.title, existing, item.content);
      }
      if (!String(nextText || "").trim()) {
        continue;
      }
      await this.documents.saveDocument(item.target_path, String(nextText).trim(), {
        source: "skill",
        summary: item.summary
      });
      savedPaths.push(item.target_path);
    }
    return savedPaths;
  }

  private async saveGeneratedText(relPath: string, content: string, mode: "replace" | "append", summary: string): Promise<void> {
    const targetPath = normalizeOptionalPath(this.documents, relPath);
    if (!targetPath) {
      throw new Error("保存目标不能为空");
    }
    const text = String(content || "").trim();
    if (!text) {
      throw new Error("生成内容为空，已阻止写入文件");
    }
    if (mode === "append") {
      let existing = "";
      try {
        existing = await this.documents.readRawText(targetPath);
      } catch {
        existing = "";
      }
      const nextText = existing.trim() ? `${existing.trimEnd()}\n\n---\n${text}\n` : `${text}\n`;
      await this.documents.saveDocument(targetPath, nextText, { source: "agent_generated_save", summary });
      return;
    }
    await this.documents.saveDocument(targetPath, text, { source: "agent_generated_save", summary });
  }

  async draftSkillFromUrl(payload: SkillDraftFromUrlRequest, options: AgentRunOptions = {}): Promise<SkillDraftResponse> {
    throwIfAborted(options.signal);
    const urlStr = (payload.url || "").trim();
    let parsed: URL;
    try {
      parsed = new URL(urlStr);
    } catch {
      throw new Error("只支持 http/https 链接");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("只支持 http/https 链接");
    }

    const fetchedUrl = await normalizeSkillUrl(urlStr, this.skills);
    throwIfAborted(options.signal);
    const { text: sourceText, sourceName } = await this.skills.fetchUrlText(fetchedUrl);
    throwIfAborted(options.signal);
    const clippedText = sourceText.slice(0, MAX_SKILL_TEXT_CHARS);

    const config = await loadModelConfig(this.config, "primary");
    throwIfAborted(options.signal);
    if (!config.configured) {
      if (looksLikeSkillMarkdown(clippedText)) {
        const skill = this.skills.parseExternalSkill(sourceName, clippedText);
        skill.imported_from = urlStr;
        return {
          skill,
          source_url: urlStr,
          source_name: sourceName,
          source_excerpt: clippedText.slice(0, 1200),
          source_text: clippedText,
          warnings: ["未配置主线路模型，已按已有 SKILL.md 内容解析。"]
        };
      }
      throw new Error("未配置主线路模型，无法从普通链接自动配置 skill");
    }

    const systemPrompt = "你是桌面小说工作台的 skill 配置助手。只输出 JSON，不要解释。请把用户提供的网页或 Markdown 内容整理成一个 prompt 型 SkillDefinition。不要生成 any 需要执行脚本、命令或外部程序的能力。";
    const userPrompt = [
      "输出 JSON 字段：id, name, description, context_requirements, linked_targets, prompt, writable。",
      "handler_type 固定为 prompt，input_mode 固定为 text。",
      "prompt 要能直接作为系统提示使用，保留关键步骤、适用场景 and 输出要求。",
      "",
      `来源名称：${sourceName}`,
      `来源链接：${urlStr}`,
      `用户补充：${payload.instruction || "无"}`,
      "",
      `来源内容：\n${clippedText.slice(0, 24000)}`
    ].join("\n");

    const content = await this.modelClient.requestCompletion(
      config,
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ],
      0.2,
      { signal: options.signal }
    );
    throwIfAborted(options.signal);

    const raw = parseJsonObject(content);
    const defaultId = path.parse(sourceName).name || "imported_skill";
    const defaultName = path.parse(sourceName).name || "导入技能";

    const skill = this.skills.normalizeSkill({
      id: String(raw.id || defaultId),
      name: String(raw.name || defaultName),
      description: String(raw.description || "由链接配置的外部 skill"),
      input_mode: "text",
      context_requirements: Array.isArray(raw.context_requirements) 
        ? raw.context_requirements.map(String).filter((s: string) => s.trim()) 
        : ["project_state", "conversation"],
      handler_type: "prompt",
      linked_targets: Array.isArray(raw.linked_targets)
        ? raw.linked_targets.map(String).filter((s: string) => s.trim())
        : [],
      prompt: String(raw.prompt || ""),
      imported_from: urlStr,
      writable: Boolean(raw.writable)
    }, urlStr);

    return {
      skill,
      source_url: urlStr,
      source_name: sourceName,
      source_excerpt: clippedText.slice(0, 1200),
      source_text: clippedText,
      warnings: []
    };
  }
}

function normalizeOptionalPath(documents: DocumentService, value: string): string {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }
  try {
    return documents.normalizeRelativePath(raw);
  } catch {
    return "";
  }
}

function buildSkillPrompt(
  skill: SkillDefinition,
  context: Awaited<ReturnType<typeof buildProjectContinuityContext>>,
  sourceText: string,
  instruction: string,
  compact: boolean
): ContextBlock[] {
  if (compact) {
    return [
      {
        id: "skill-compact-notice",
        title: "自动压缩",
        source: "runtime",
        priority: "critical",
        content: "【自动压缩】\n上一次请求触发网关超时，已保留最关键的创作信息重试。请直接完成任务，不要解释压缩过程。"
      },
      buildPromptBlock("skill", "Skill", "runtime", "critical", `【Skill】${skill.name}\n${skill.description}`),
      buildPromptBlock("project-state", "项目状态", "project", "high", `【项目状态】\n${clipText(context.state_summary || "无", 1800)}`),
      buildPromptBlock("outline", "大纲", "project", "high", `【大纲】\n${clipText(context.outline, 1800)}`),
      buildPromptBlock("detailed-outline", "细纲", "project", "high", `【细纲】\n${clipText(context.detailed_outline, 1800)}`),
      buildPromptBlock("chapter-outline", "章纲", "project", "high", `【章纲】\n${clipText(context.chapter_outline, 1800)}`),
      buildPromptBlock("style-genre", "风格题材约束", "project", "high", buildStyleGenreConstraintBlock(context.style, context.genre, { compact: true })),
      buildPromptBlock("source-text", "输入文本", "document", "medium", `【输入文本】\n${clipText(sourceText || "无", 3200)}`),
      buildPromptBlock("instruction", "额外要求", "runtime", "critical", `【额外要求】\n${instruction || "无"}`)
    ];
  }

  return [
    buildPromptBlock("skill", "Skill", "runtime", "critical", `【Skill】${skill.name}\n${skill.description}`),
    buildPromptBlock("project-state", "项目状态", "project", "high", `【项目状态】\n${context.state_summary || "无"}`),
    buildPromptBlock("outline", "大纲", "project", "high", `【大纲】\n${context.outline}`),
    buildPromptBlock("detailed-outline", "细纲", "project", "high", `【细纲】\n${context.detailed_outline}`),
    buildPromptBlock("chapter-outline", "章纲", "project", "high", `【章纲】\n${context.chapter_outline}`),
    buildPromptBlock("style-genre", "风格题材约束", "project", "high", buildStyleGenreConstraintBlock(context.style, context.genre)),
    buildPromptBlock("source-text", "输入文本", "document", "medium", `【输入文本】\n${sourceText || "无"}`),
    buildPromptBlock("instruction", "额外要求", "runtime", "critical", `【额外要求】\n${instruction || "无"}`)
  ];
}

function buildPromptBlock(
  id: string,
  title: string,
  source: ContextBlock["source"],
  priority: ContextBlock["priority"],
  content: string
): ContextBlock {
  return {
    id,
    title,
    source,
    priority,
    content
  };
}

function clipText(text: string, limit: number): string {
  const normalized = String(text || "").trim();
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit).trimEnd()}\n...（已压缩）`;
}

function looksGatewayTimeout(error: unknown): boolean {
  const text = String(error instanceof Error ? error.message : error || "").toLowerCase();
  return text.includes("504") || text.includes("gateway") || text.includes("网关超时") || text.includes("请求超时") || text.includes("timed out");
}

function cleanDeslopOutput(result: string): string {
  let text = String(result || "").trim();
  text = text.replace(/^```(?:text|markdown|md)?\s*/i, "");
  text = text.replace(/\s*```$/, "");
  for (const marker of ["【处理后文本】", "【去AI味后文本】", "【润色后正文】", "【正文】"]) {
    if (text.includes(marker)) {
      text = text.split(marker)[1]?.trim() || text;
    }
  }
  for (const marker of ["## AI味检测报告", "## 去AI味润色报告", "【修改说明】", "修改说明："]) {
    if (text.includes(marker)) {
      text = text.split(marker)[0]?.trim() || text;
    }
  }
  return text.trim();
}

function guardAgainstOverdelete(original: string, cleaned: string): string {
  if (!cleaned) {
    return original;
  }
  if (original.length < 80) {
    return cleaned;
  }
  if (cleaned.length < Math.floor(original.length * 0.85)) {
    return original;
  }
  return cleaned;
}

function shouldOverwriteLore(instruction: string): boolean {
  return /(覆盖|替换|清空.*重写|重写|改写).{0,12}(当前内容|原内容|设定集|设定卡|人物设定|体系设定|地图设定|道具设定)?/.test(
    instruction || ""
  );
}

const MAX_SKILL_TEXT_CHARS = 120000;

async function normalizeSkillUrl(urlStr: string, skills: SkillService): Promise<string> {
  let url: URL;
  try {
    url = new URL(urlStr);
  } catch {
    return urlStr;
  }
  if (url.hostname.toLowerCase() !== "github.com") {
    return urlStr;
  }
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length >= 5 && parts[2] === "blob") {
    const owner = parts[0];
    const repo = parts[1];
    const branch = parts[3];
    const rest = parts.slice(4).join("/");
    return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${rest}`;
  }
  if (parts.length >= 2) {
    const owner = parts[0];
    const repo = parts[1];
    for (const branch of ["main", "master"]) {
      const candidate = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/SKILL.md`;
      try {
        await skills.fetchUrlText(candidate);
        return candidate;
      } catch {
        continue;
      }
    }
  }
  return urlStr;
}

function looksLikeSkillMarkdown(text: string): boolean {
  const sample = (text || "").slice(0, 4000).toLowerCase();
  return sample.includes("skill.md") || (sample.includes("name:") && sample.includes("description:")) || sample.includes("# ");
}

function parseJsonObject(content: string): any {
  const raw = (content || "").trim();
  const match = raw.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      return JSON.parse(match[0]);
    } catch (error) {
      throw new Error(`AI 未返回有效 skill JSON: ${(error as Error).message}`);
    }
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`AI 未返回有效 skill JSON: ${(error as Error).message}`);
  }
}
