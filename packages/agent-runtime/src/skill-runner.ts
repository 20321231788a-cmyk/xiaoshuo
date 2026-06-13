import { loadModelConfig, type ConfigServiceOptions } from "@xiaoshuo/config-service";
import { ConversationService } from "@xiaoshuo/conversation-service";
import { DocumentService } from "@xiaoshuo/document-service";
import { GeneratedCacheService } from "@xiaoshuo/generated-cache";
import { OpenAICompatibleClient, type ChatCompletionMessage } from "@xiaoshuo/model-client";
import { buildProjectContinuityContext } from "@xiaoshuo/project-session";
import { SkillService } from "@xiaoshuo/skill-service";
import { skillRunResponseSchema, skillDraftFromUrlRequestSchema, skillDraftResponseSchema, type AgentStreamEvent, type SkillDefinition, type SkillRunRequest, type SkillRunResponse, type SkillDraftFromUrlRequest, type SkillDraftResponse } from "@xiaoshuo/shared";
import path from "node:path";
import { HUMANIZER_SYSTEM_PROMPT, applyHumanizerIfEnabled } from "./humanizer.js";
import { GeneratedSavePlanner } from "./generated-save-planner.js";
import { buildStyleGenreConstraintBlock } from "./style-genre-context.js";
import { streamModelText, StreamingGenerationSession, type StreamingModelClient } from "./stream.js";

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

const STYLE_SECTION_TARGETS: Record<string, string> = {
  写作风格: "00_设定集/风格库/写作风格.txt",
  风格示例: "00_设定集/风格库/风格示例.txt",
  参考素材: "00_设定集/风格库/参考素材.txt"
};

const GENRE_SECTION_TARGETS: Record<string, string> = {
  题材规则: "00_设定集/题材库/题材规则.txt",
  题材素材: "00_设定集/题材库/题材素材.txt",
  战斗模板: "00_设定集/题材库/战斗模板.txt",
  违禁词: "00_设定集/题材库/违禁词.txt"
};

const LORE_SECTION_TARGETS: Record<string, string> = {
  人物设定: "00_设定集/设定集/人物设定.txt",
  体系设定: "00_设定集/设定集/体系设定.txt",
  地图设定: "00_设定集/设定集/地图设定.txt",
  道具设定: "00_设定集/设定集/道具设定.txt"
};

const LORE_EXTRACT_SOURCE_FALLBACKS = ["01_大纲/章纲.txt", "01_大纲/细纲.txt", "01_大纲/大纲.txt"];

const LOCAL_BLOCKED_SKILLS = new Set<string>();

const PROMPT_SKILL_SOURCE_FALLBACKS: Record<string, string[]> = {
  detail_outline_generate: ["01_大纲/大纲.txt"],
  chapter_outline_generate: ["01_大纲/细纲.txt", "01_大纲/大纲.txt"]
};

const MAX_SOURCE_CHARS = 24_000;
const MAX_FULL_PROMPT_CHARS = 26_000;
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

export class PromptSkillRunner {
  private readonly projectRoot: string;
  private readonly config: ConfigServiceOptions;
  private readonly documents: DocumentService;
  private readonly skills: SkillService;
  private readonly cache: GeneratedCacheService;
  private readonly conversations: ConversationService;
  private readonly modelClient: StreamingModelClient;
  private readonly savePlanner: GeneratedSavePlanner;

  constructor(options: PromptSkillRunnerOptions) {
    this.projectRoot = path.resolve(options.projectRoot);
    this.config = options.config ?? {};
    this.documents = new DocumentService({ projectRoot: this.projectRoot });
    this.skills = new SkillService({ projectRoot: this.projectRoot });
    this.cache = new GeneratedCacheService({ projectRoot: this.projectRoot });
    this.conversations = new ConversationService({ projectRoot: this.projectRoot });
    this.modelClient = options.modelClient ?? new OpenAICompatibleClient();
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

  async runSkill(skillId: string, payload: SkillRunRequest): Promise<SkillRunResponse> {
    const skill = await this.skills.getSkill(skillId);
    if (!skill) {
      throw new Error(`未知 skill: ${skillId}`);
    }
    if (skill.handler_type !== "prompt" || LOCAL_BLOCKED_SKILLS.has(skill.id)) {
      throw new Error(`TS runtime 尚未接管该 skill: ${skillId}`);
    }

    const result = await this.runPromptSkill(skill, payload);
    return this.finalizePromptSkill(skill, payload, result);
  }

  async *streamSkill(skillId: string, payload: SkillRunRequest): AsyncGenerator<AgentStreamEvent> {
    const skill = await this.skills.getSkill(skillId);
    if (!skill) {
      throw new Error(`未知 skill: ${skillId}`);
    }
    if (skill.handler_type !== "prompt" || LOCAL_BLOCKED_SKILLS.has(skill.id)) {
      throw new Error(`TS runtime 尚未接管该 skill: ${skillId}`);
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
    const initial = await session.start({
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
        temperature: config.temperature
      })) {
        await session.append(chunk);
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
      const raw = await session.finalize();
      const finalText = await this.applyDefaultDeslop(skill.id, session.text || "");
      if (finalText.trim() !== (session.text || "").trim()) {
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
          })
        )
      };
    } catch (error) {
      await session.fail(error);
      yield {
        type: "error",
        message: error instanceof Error ? error.message : String(error)
      };
    }
  }

  private async runPromptSkill(skill: SkillDefinition, payload: SkillRunRequest): Promise<string> {
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
        config.temperature
      );
      return this.applyDefaultDeslop(skill.id, result);
    } catch (error) {
      if (!looksGatewayTimeout(error)) {
        throw error;
      }
    }

    const compactResult = await this.modelClient.requestCompletion(
      config,
      this.buildMessages(skill, systemPrompt, context, sourceText || payload.text, payload.instruction, true),
      config.temperature
    );
    return this.applyDefaultDeslop(skill.id, compactResult);
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
    return [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: prompt.slice(0, compact ? MAX_COMPACT_PROMPT_CHARS : MAX_FULL_PROMPT_CHARS)
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

    for (const relPath of PROMPT_SKILL_SOURCE_FALLBACKS[skill.id] || []) {
      const fallbackText = await this.readProjectText(relPath);
      if (fallbackText) {
        return fallbackText;
      }
    }

    return "";
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

  private async finalizePromptSkill(
    skill: SkillDefinition,
    payload: SkillRunRequest,
    result: string,
    existingCache?: { cacheId: string; cachePath?: string; cacheChars?: number }
  ): Promise<SkillRunResponse> {
    const humanized = await applyHumanizerIfEnabled({
      text: String(result || "").trim(),
      config: this.config,
      modelClient: this.modelClient,
      mode: `${skill.name || skill.id} 生成结果`,
      skip: skill.id === "humanizer_zh"
    });
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
    });
    const targetPaths = savePlan.target_paths;
    const data: Record<string, unknown> = {
      skill_id: skill.id,
      saved_paths: [],
      save_plan: savePlan,
      ...(humanized.applied ? { humanized: true, humanizer_skill_id: "humanizer_zh" } : {}),
      ...(humanized.error ? { humanizer_error: humanized.error } : {})
    };

    if (finalResult && existingCache?.cacheId) {
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
      const entry = existingCache?.cacheId
        ? await this.cache.get(existingCache.cacheId)
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

      if (await this.savePlanner.shouldAutoCommit(savePlan)) {
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
      return Object.values(STYLE_SECTION_TARGETS);
    }
    if (skill.id === "genre_generate") {
      return Object.values(GENRE_SECTION_TARGETS);
    }
    if (skill.id === "lore_extract") {
      return Object.values(LORE_SECTION_TARGETS);
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

  private async applyDefaultDeslop(skillId: string, value: string): Promise<string> {
    const result = String(value || "").trim();
    if (!result) {
      return result;
    }
    const mode = skillId === "detail_outline_generate" ? "detail_outline" : skillId === "chapter_outline_generate" ? "chapter_outline" : "";
    if (!mode) {
      return result;
    }

    const config = await loadModelConfig(this.config, "primary");
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
          Math.max(0.2, Math.min(0.7, config.temperature))
        )
      ).trim();
      const cleaned = cleanDeslopOutput(polished);
      return guardAgainstOverdelete(result, cleaned);
    } catch {
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
    let sections = splitStyleSections(result);
    if (!Object.keys(sections).length) {
      const fallback = String(result || "").trim();
      if (!fallback) {
        return [];
      }
      sections = { 写作风格: fallback };
    }

    const savedPaths: string[] = [];
    for (const [title, relPath] of Object.entries(STYLE_SECTION_TARGETS)) {
      const body = String(sections[title] || "").trim();
      if (!body) {
        continue;
      }
      await this.saveGeneratedText(relPath, body, mode, `${options.summaryPrefix}：${title}`);
      savedPaths.push(relPath);
    }
    return savedPaths;
  }

  public async saveGenreSections(
    result: string,
    mode: "replace" | "append",
    options: { summaryPrefix: string }
  ): Promise<string[]> {
    let sections = splitGenreSections(result);
    if (!Object.keys(sections).length) {
      const fallback = String(result || "").trim();
      if (!fallback) {
        return [];
      }
      sections = { 题材规则: fallback };
    }

    const savedPaths: string[] = [];
    for (const [title, relPath] of Object.entries(GENRE_SECTION_TARGETS)) {
      const body = String(sections[title] || "").trim();
      if (!body) {
        continue;
      }
      await this.saveGeneratedText(relPath, body, mode, `${options.summaryPrefix}：${title}`);
      savedPaths.push(relPath);
    }
    return savedPaths;
  }

  public async saveLoreSections(
    result: string,
    mode: "replace" | "append",
    options: { summaryPrefix: string; mergeExisting: boolean }
  ): Promise<string[]> {
    const sections = splitLoreSections(result);
    if (!Object.keys(sections).length) {
      return [];
    }

    const savedPaths: string[] = [];
    for (const [title, relPath] of Object.entries(LORE_SECTION_TARGETS)) {
      const body = String(sections[title] || "").trim();
      if (isEmptyLoreBody(body)) {
        continue;
      }
      if (mode === "append") {
        await this.saveGeneratedText(relPath, body, "append", `${options.summaryPrefix}：${title}`);
        savedPaths.push(relPath);
        continue;
      }

      let nextText = body;
      if (options.mergeExisting) {
        let existing = "";
        try {
          existing = await this.documents.readRawText(relPath);
        } catch {
          existing = "";
        }
        nextText = mergeLoreSectionText(title, existing, body);
      }
      if (!String(nextText || "").trim()) {
        continue;
      }
      await this.documents.saveDocument(relPath, String(nextText).trim(), {
        source: "skill",
        summary: `${options.summaryPrefix}：${title}`
      });
      savedPaths.push(relPath);
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

  async draftSkillFromUrl(payload: SkillDraftFromUrlRequest): Promise<SkillDraftResponse> {
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
    const { text: sourceText, sourceName } = await this.skills.fetchUrlText(fetchedUrl);
    const clippedText = sourceText.slice(0, MAX_SKILL_TEXT_CHARS);

    const config = await loadModelConfig(this.config, "primary");
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
      0.2
    );

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
): string {
  if (compact) {
    return [
      "【自动压缩】",
      "上一次请求触发网关超时，已保留最关键的创作信息重试。请直接完成任务，不要解释压缩过程。",
      "",
      `【Skill】${skill.name}`,
      skill.description,
      "",
      `【项目状态】\n${clipText(context.state_summary || "无", 1800)}`,
      "",
      `【大纲】\n${clipText(context.outline, 1800)}`,
      "",
      `【细纲】\n${clipText(context.detailed_outline, 1800)}`,
      "",
      `【章纲】\n${clipText(context.chapter_outline, 1800)}`,
      "",
      buildStyleGenreConstraintBlock(context.style, context.genre, { compact: true }),
      "",
      `【输入文本】\n${clipText(sourceText || "无", 3200)}`,
      "",
      `【额外要求】\n${instruction || "无"}`
    ].join("\n");
  }

  return [
    `【Skill】${skill.name}`,
    skill.description,
    "",
    `【项目状态】\n${context.state_summary || "无"}`,
    "",
    `【大纲】\n${context.outline}`,
    "",
    `【细纲】\n${context.detailed_outline}`,
    "",
    `【章纲】\n${context.chapter_outline}`,
    "",
    buildStyleGenreConstraintBlock(context.style, context.genre),
    "",
    `【输入文本】\n${sourceText || "无"}`,
    "",
    `【额外要求】\n${instruction || "无"}`
  ].join("\n");
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

function splitStyleSections(result: string): Record<string, string> {
  const text = String(result || "").trim();
  if (!text) {
    return {};
  }

  const sections: Record<string, string[]> = {
    写作风格: [],
    风格示例: [],
    参考素材: []
  };
  const aliases: Record<string, keyof typeof sections> = {
    写作风格: "写作风格",
    写作风格规则: "写作风格",
    文风规则: "写作风格",
    文风: "写作风格",
    风格示例: "风格示例",
    风格示例特征: "风格示例",
    参考素材: "参考素材",
    参考素材摘要: "参考素材"
  };

  const heading =
    /^[ \t]*(?:#{1,6}[ \t]*)?(?:[【\[])?[ \t]*(写作风格规则|写作风格|文风规则|文风|风格示例特征|风格示例|参考素材摘要|参考素材)[ \t]*(?:[】\]])?[ \t]*[:：]?[ \t]*$/gmu;
  const matches = [...text.matchAll(heading)];
  if (matches.length) {
    for (let index = 0; index < matches.length; index += 1) {
      const alias = (matches[index]?.[1] || "").trim();
      const title = aliases[alias];
      if (!title) {
        continue;
      }
      const start = matches[index]?.index !== undefined ? matches[index]!.index! + matches[index]![0].length : 0;
      const end = index + 1 < matches.length && matches[index + 1]?.index !== undefined ? matches[index + 1]!.index! : text.length;
      const body = text.slice(start, end).trim();
      if (body) {
        sections[title]!.push(body);
      }
    }
    return compactSections(sections);
  }

  const fenced = /\*\*(00_设定集\/风格库\/([^*\n]+?\.txt))\*\*\s*```(?:\w+)?\s*(.*?)```/gs;
  for (const match of text.matchAll(fenced)) {
    const filename = match[2] || "";
    const body = String(match[3] || "").trim();
    for (const [title, relPath] of Object.entries(STYLE_SECTION_TARGETS)) {
      if (path.posix.basename(relPath) === filename && body) {
        sections[title]!.push(body);
      }
    }
  }

  return compactSections(sections);
}

function splitGenreSections(result: string): Record<string, string> {
  const text = String(result || "").trim();
  if (!text) {
    return {};
  }

  const sections: Record<string, string[]> = {
    题材规则: [],
    题材素材: [],
    战斗模板: [],
    违禁词: []
  };
  const aliases: Record<string, keyof typeof sections> = {
    题材规则: "题材规则",
    规则: "题材规则",
    世界规则: "题材规则",
    题材素材: "题材素材",
    素材: "题材素材",
    灵感素材: "题材素材",
    脑洞素材: "题材素材",
    战斗模板: "战斗模板",
    冲突模板: "战斗模板",
    冲突场景模板: "战斗模板",
    场景模板: "战斗模板",
    违禁词: "违禁词",
    禁忌词: "违禁词",
    禁用词: "违禁词"
  };

  const heading = /^[ \t]*(?:#{1,6}[ \t]*)?(?:[【\[])?[ \t]*(题材规则|规则|世界规则|题材素材|素材|灵感素材|脑洞素材|战斗模板|冲突模板|冲突场景模板|场景模板|违禁词|禁忌词|禁用词)[ \t]*(?:[】\]])?[ \t]*[:：]?[ \t]*$/gmu;
  const matches = [...text.matchAll(heading)];
  if (matches.length) {
    for (let index = 0; index < matches.length; index += 1) {
      const alias = (matches[index]?.[1] || "").trim();
      const title = aliases[alias];
      if (!title) {
        continue;
      }
      const start = matches[index]?.index !== undefined ? matches[index]!.index! + matches[index]![0].length : 0;
      const end = index + 1 < matches.length && matches[index + 1]?.index !== undefined ? matches[index + 1]!.index! : text.length;
      const body = text.slice(start, end).trim();
      if (body) {
        sections[title]!.push(body);
      }
    }
    return Object.fromEntries(
      Object.entries(sections)
        .map(([title, parts]) => [title, parts.join("\n\n").trim()])
        .filter(([, body]) => Boolean(body))
    );
  }

  const fenced = /\*\*(00_设定集\/题材库\/([^*\n]+?\.txt))\*\*\s*```(?:\w+)?\s*(.*?)```/gs;
  for (const match of text.matchAll(fenced)) {
    const filename = match[2] || "";
    const body = String(match[3] || "").trim();
    for (const [title, relPath] of Object.entries(GENRE_SECTION_TARGETS)) {
      if (path.posix.basename(relPath) === filename && body) {
        sections[title]!.push(body);
      }
    }
  }

  return Object.fromEntries(
    Object.entries(sections)
      .map(([title, parts]) => [title, parts.join("\n\n").trim()])
      .filter(([, body]) => Boolean(body))
  );
}

function compactSections(sections: Record<string, string[]>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(sections)
      .map(([title, parts]) => [title, parts.join("\n\n").trim()])
      .filter(([, body]) => Boolean(body))
  );
}

function splitLoreSections(result: string): Record<string, string> {
  const text = String(result || "").trim();
  if (!text) {
    return {};
  }

  const sections: Record<string, string[]> = {
    人物设定: [],
    体系设定: [],
    地图设定: [],
    道具设定: []
  };
  const aliases: Record<string, keyof typeof sections> = {
    人物: "人物设定",
    人物设定: "人物设定",
    角色: "人物设定",
    角色设定: "人物设定",
    体系: "体系设定",
    体系设定: "体系设定",
    世界观: "体系设定",
    世界设定: "体系设定",
    规则设定: "体系设定",
    能力体系: "体系设定",
    势力组织: "体系设定",
    地图: "地图设定",
    地图设定: "地图设定",
    地点: "地图设定",
    地点设定: "地图设定",
    地理设定: "地图设定",
    道具: "道具设定",
    道具设定: "道具设定",
    物品: "道具设定",
    物品设定: "道具设定",
    法宝设定: "道具设定",
    装备设定: "道具设定"
  };

  const heading =
    /^[ \t]*(?:#{1,6}[ \t]*)?(?:[【\[])?[ \t]*(人物设定|人物|角色设定|角色|体系设定|体系|世界观|世界设定|规则设定|能力体系|势力组织|地图设定|地图|地点设定|地点|地理设定|道具设定|道具|物品设定|物品|法宝设定|装备设定)[ \t]*(?:[】\]])?[ \t]*[:：]?[ \t]*$/gmu;
  const matches = [...text.matchAll(heading)];
  if (matches.length) {
    for (let index = 0; index < matches.length; index += 1) {
      const alias = (matches[index]?.[1] || "").trim();
      const title = aliases[alias];
      if (!title) {
        continue;
      }
      const start = matches[index]?.index !== undefined ? matches[index]!.index! + matches[index]![0].length : 0;
      const end = index + 1 < matches.length && matches[index + 1]?.index !== undefined ? matches[index + 1]!.index! : text.length;
      const body = text.slice(start, end).trim();
      if (body) {
        sections[title]!.push(body);
      }
    }
    return Object.fromEntries(
      Object.entries(sections)
        .map(([title, parts]) => [title, parts.join("\n\n").trim()])
        .filter(([, body]) => Boolean(body))
    );
  }

  for (const block of text.split(/\n{2,}/)) {
    const clean = block.trim();
    if (!clean) {
      continue;
    }
    sections[classifyLoreBlock(clean)]!.push(clean);
  }
  return Object.fromEntries(
    Object.entries(sections)
      .map(([title, parts]) => [title, parts.join("\n\n").trim()])
      .filter(([, body]) => Boolean(body))
  );
}

function classifyLoreBlock(text: string): keyof typeof LORE_SECTION_TARGETS {
  if (/道具|物品|法宝|武器|装备|丹药|符箓|灵器|宝物|剑|刀|枪|弓/.test(text)) {
    return "道具设定";
  }
  if (/地图|地点|地名|地理|地域|城|镇|村|山|海|河|谷|洞府|秘境|遗迹|宫|殿/.test(text)) {
    return "地图设定";
  }
  if (/人物|角色|主角|配角|姓名|身份|性格|动机|关系|师父|弟子|父|母|兄|姐|妹|男|女/.test(text)) {
    return "人物设定";
  }
  if (/世界|规则|体系|组织|势力|宗门|家族|能力|功法|境界|修为|血脉|种族|法则|等级/.test(text)) {
    return "体系设定";
  }
  return "体系设定";
}

function isEmptyLoreBody(text: string): boolean {
  const cleaned = String(text || "").trim().replace(/^[\s\-*]+/, "").replace(/[ 。.；;]+$/g, "");
  return !cleaned || ["无", "暂无", "未提取", "未发现", "没有内容"].includes(cleaned);
}

function shouldOverwriteLore(instruction: string): boolean {
  return /(覆盖|替换|清空.*重写|重写|改写).{0,12}(当前内容|原内容|设定集|设定卡|人物设定|体系设定|地图设定|道具设定)?/.test(
    instruction || ""
  );
}

function mergeLoreSectionText(title: string, existing: string, incoming: string): string {
  const existingBlocks = loreMergeBlocks(existing, title);
  const incomingBlocks = loreMergeBlocks(incoming, title);
  const merged: string[] = [];
  const keyToIndex = new Map<string, number>();

  for (const block of existingBlocks) {
    const key = loreMergeKey(block);
    if (key) {
      keyToIndex.set(key, merged.length);
    }
    merged.push(block);
  }

  for (const block of incomingBlocks) {
    const key = loreMergeKey(block);
    if (key && keyToIndex.has(key)) {
      const index = keyToIndex.get(key)!;
      merged[index] = mergeLoreDuplicate(merged[index] || "", block);
      continue;
    }
    if (merged.some((item) => sameLoreDetail(item, block))) {
      continue;
    }
    if (key) {
      keyToIndex.set(key, merged.length);
    }
    merged.push(block);
  }

  return merged
    .map((block) => block.trim())
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

function loreMergeBlocks(text: string, sectionTitle: string): string[] {
  const blocks: string[] = [];
  const current: string[] = [];
  const headingPattern = new RegExp(`^\\s*(?:[【\\[])?${escapeRegExp(sectionTitle)}(?:[】\\]])?\\s*[:：]?\\s*$`);

  const flush = () => {
    const block = current.join("\n").trim();
    current.length = 0;
    if (block && !isEmptyLoreBody(block)) {
      blocks.push(block);
    }
  };

  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, "");
    const stripped = line.trim();
    if (!stripped || stripped === "---" || /^【自动提取[^】]*】$/.test(stripped) || headingPattern.test(stripped)) {
      flush();
      continue;
    }
    if (startsNewLoreItem(stripped) && current.length) {
      flush();
    }
    current.push(stripped);
  }
  flush();
  return blocks;
}

function startsNewLoreItem(line: string): boolean {
  return /^[-*•]\s*\S{1,32}[：:]/.test(line) || /^\d+[.、]\s*\S{1,32}[：:]/.test(line) || /^\S{1,32}[：:]/.test(line);
}

function loreMergeKey(block: string): string {
  const first = String(block || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) || "";
  const cleaned = first.replace(/^[-*•\d.、\s]+/, "");
  const match = /^([^：:\n]{1,32})[：:]/.exec(cleaned);
  if (match) {
    return match[1]!.replace(/\s+/g, "").toLowerCase();
  }
  return cleaned.replace(/\W+/gu, "").slice(0, 40).toLowerCase();
}

function mergeLoreDuplicate(existing: string, incoming: string): string {
  const [oldKey, oldDetail] = splitLoreItem(existing);
  const [newKey, newDetail] = splitLoreItem(incoming);
  if (oldKey && newKey && oldKey === newKey) {
    const details: string[] = [];
    for (const detail of [oldDetail, newDetail]) {
      for (const part of splitLoreDetailParts(detail)) {
        if (!details.some((item) => sameLoreDetail(part, item))) {
          details.push(part);
        }
      }
    }
    return details.length ? `${newKey}：${details.join("；")}` : incoming.trim();
  }
  if (sameLoreDetail(existing, incoming)) {
    return existing.trim().length >= incoming.trim().length ? existing.trim() : incoming.trim();
  }
  return `${existing.trim()}\n${incoming.trim()}`.trim();
}

function splitLoreItem(block: string): [string, string] {
  const text = String(block || "").trim().replace(/^[-*•\d.、\s]+/, "");
  const match = /^([^：:\n]{1,32})[：:]\s*(.*)$/s.exec(text);
  if (!match) {
    return ["", text];
  }
  return [match[1]!.replace(/\s+/g, "").trim(), match[2]!.trim()];
}

function splitLoreDetailParts(detail: string): string[] {
  const parts = String(detail || "")
    .split(/[；;]\s*|\n+/)
    .map((part) => part.trim().replace(/[。；;]+$/g, ""))
    .filter(Boolean);
  return parts.length ? parts : String(detail || "").trim() ? [String(detail).trim()] : [];
}

function sameLoreDetail(left: string, right: string): boolean {
  const leftNorm = String(left || "").replace(/\s+/g, "");
  const rightNorm = String(right || "").replace(/\s+/g, "");
  return Boolean(leftNorm && rightNorm && (leftNorm.includes(rightNorm) || rightNorm.includes(leftNorm)));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
