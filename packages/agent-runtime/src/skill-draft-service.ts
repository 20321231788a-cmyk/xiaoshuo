import { loadModelConfig, type ConfigServiceOptions } from "@xiaoshuo/config-service";
import { ConversationService } from "@xiaoshuo/conversation-service";
import { DocumentService } from "@xiaoshuo/document-service";
import { OpenAICompatibleClient, type ChatCompletionMessage } from "@xiaoshuo/model-client";
import { SkillService } from "@xiaoshuo/skill-service";
import { skillDraftResponseSchema, skillSavePolicySchema, type SkillDraftRequest, type SkillDraftResponse } from "@xiaoshuo/shared";
import path from "node:path";
import { throwIfAborted, type AgentRunOptions } from "./cancellation.js";
import { PromptSkillRunner } from "./skill-runner.js";

const MAX_DRAFT_SOURCE_CHARS = 40_000;

type SkillDraftModelClient = Pick<OpenAICompatibleClient, "requestCompletion">;

export type SkillDraftServiceOptions = {
  projectRoot: string;
  config?: ConfigServiceOptions;
  modelClient?: SkillDraftModelClient;
};

export class SkillDraftService {
  private readonly projectRoot: string;
  private readonly config: ConfigServiceOptions;
  private readonly documents: DocumentService;
  private readonly conversations: ConversationService;
  private readonly skills: SkillService;
  private readonly modelClient: SkillDraftModelClient;

  constructor(options: SkillDraftServiceOptions) {
    this.projectRoot = path.resolve(options.projectRoot);
    this.config = options.config ?? {};
    this.documents = new DocumentService({ projectRoot: this.projectRoot });
    this.conversations = new ConversationService({ projectRoot: this.projectRoot });
    this.skills = new SkillService({ projectRoot: this.projectRoot });
    this.modelClient = options.modelClient ?? new OpenAICompatibleClient();
  }

  async draftSkill(payload: SkillDraftRequest, options: AgentRunOptions = {}): Promise<SkillDraftResponse> {
    throwIfAborted(options.signal);
    if (payload.kind === "url") {
      const runner = new PromptSkillRunner({
        projectRoot: this.projectRoot,
        config: this.config,
        modelClient: this.modelClient
      });
      return runner.draftSkillFromUrl({ url: payload.url, instruction: payload.instruction }, options);
    }

    const source = await this.resolveSource(payload);
    throwIfAborted(options.signal);
    return skillDraftResponseSchema.parse(await this.generateDraft(payload, source, options));
  }

  private async resolveSource(payload: SkillDraftRequest): Promise<{ text: string; name: string; warnings: string[] }> {
    const warnings: string[] = [];
    if (payload.kind === "current_document") {
      const currentPath = payload.current_path.trim();
      if (!currentPath) {
        warnings.push("缺少 current_path，已仅根据 instruction 生成草稿。");
        return { text: payload.text || payload.instruction, name: "current-document.md", warnings };
      }
      const text = await this.documents.readRawText(currentPath, MAX_DRAFT_SOURCE_CHARS);
      return { text, name: currentPath, warnings };
    }
    if (payload.kind === "selection") {
      const text = payload.selection || payload.text;
      if (!text.trim()) {
        warnings.push("当前选区为空，已仅根据 instruction 生成草稿。");
      }
      return { text: text || payload.instruction, name: "selection.md", warnings };
    }
    if (payload.kind === "markdown") {
      return { text: payload.text, name: "markdown.md", warnings };
    }
    if (payload.kind === "existing_skill") {
      const sourceSkill = await this.skills.getSkill(payload.source_skill_id);
      if (!sourceSkill) {
        throw new Error("source_skill_id 对应的 skill 不存在");
      }
      return {
        text: [`# ${sourceSkill.name}`, sourceSkill.description, "", sourceSkill.prompt].join("\n").slice(0, MAX_DRAFT_SOURCE_CHARS),
        name: `${sourceSkill.id}.skill.md`,
        warnings
      };
    }
    if (payload.kind === "attachment") {
      const conversationId = String((payload as unknown as Record<string, unknown>).conversation_id || "").trim();
      if (!conversationId || !payload.attachment_ids.length) {
        warnings.push("缺少 conversation_id 或 attachment_ids，已仅根据 instruction 生成草稿。");
        return { text: payload.text || payload.instruction, name: "attachment.md", warnings };
      }
      const attachments = await this.conversations.getAttachmentTexts(conversationId, payload.attachment_ids);
      const text = attachments.map(([attachment, text]) => `【${attachment.name}】\n${text}`).join("\n\n");
      return { text: text.slice(0, MAX_DRAFT_SOURCE_CHARS), name: "attachments.md", warnings };
    }
    return { text: payload.text || payload.instruction, name: "instruction.md", warnings };
  }

  private async generateDraft(
    payload: SkillDraftRequest,
    source: { text: string; name: string; warnings: string[] },
    options: AgentRunOptions
  ): Promise<SkillDraftResponse> {
    const config = await loadModelConfig(this.config, "primary");
    const baseName = payload.target_name || deriveName(payload.instruction, source.name);
    const baseId = payload.target_id || deriveId(baseName);
    const sourceText = source.text.slice(0, MAX_DRAFT_SOURCE_CHARS);

    if (config.configured) {
      const content = await this.modelClient.requestCompletion(config, buildDraftMessages(payload, sourceText, source.name), 0.2, { signal: options.signal });
      throwIfAborted(options.signal);
      const parsed = parseJsonObject(content);
      const skill = this.skills.normalizeSkill({
        id: String(parsed.id || baseId),
        name: String(parsed.name || baseName),
        description: String(parsed.description || `根据 ${source.name} 生成的 prompt skill 草稿`),
        input_mode: "text",
        context_requirements: Array.isArray(parsed.context_requirements) ? parsed.context_requirements.map(String).filter(Boolean) : ["project_state", "conversation"],
        handler_type: "prompt",
        linked_targets: Array.isArray(parsed.linked_targets) ? parsed.linked_targets.map(String).filter(Boolean) : [],
        prompt: String(parsed.prompt || buildPromptTemplate(payload.instruction, sourceText)),
        imported_from: `draft:${payload.kind}`,
        writable: Boolean(parsed.writable) && Boolean(parsed.save_policy),
        save_policy: parsed.save_policy && typeof parsed.save_policy === "object" ? skillSavePolicySchema.parse(parsed.save_policy) : undefined
      }, `draft:${payload.kind}`);
      return toDraftResponse(skill, payload, source, sourceText);
    }

    const skill = this.skills.normalizeSkill({
      id: baseId,
      name: baseName,
      description: `根据${source.name === "instruction.md" ? "用户说明" : source.name}生成的 prompt skill 草稿`,
      input_mode: "text",
      context_requirements: ["project_state", "conversation"],
      handler_type: "prompt",
      linked_targets: [],
      prompt: buildPromptTemplate(payload.instruction, sourceText),
      imported_from: `draft:${payload.kind}`,
      writable: false
    }, `draft:${payload.kind}`);
    return {
      ...toDraftResponse(skill, payload, source, sourceText),
      warnings: [...source.warnings, "未配置主线路模型，已生成安全的 prompt 型草稿模板。"]
    };
  }
}

function toDraftResponse(
  skill: ReturnType<SkillService["normalizeSkill"]>,
  payload: SkillDraftRequest,
  source: { text: string; name: string; warnings: string[] },
  sourceText: string
): SkillDraftResponse {
  return {
    skill,
    source_url: payload.url || "",
    source_name: source.name,
    source_excerpt: sourceText.slice(0, 1200),
    source_text: sourceText,
    warnings: source.warnings
  };
}

function buildDraftMessages(payload: SkillDraftRequest, sourceText: string, sourceName: string): ChatCompletionMessage[] {
  return [
    {
      role: "system",
      content: [
        "你是桌面小说工作台的 skill 配置助手。只输出 JSON，不要解释。",
        "只生成 prompt 型 SkillDefinition；handler_type 固定为 prompt；input_mode 固定为 text。",
        "不得生成执行命令、脚本、外部程序、联网抓取等能力。",
        "prompt 必须包含适用场景、输入要求、处理步骤、输出格式、质量标准。"
      ].join("\n")
    },
    {
      role: "user",
      content: [
        "输出 JSON 字段：id, name, description, context_requirements, linked_targets, prompt, writable, save_policy。",
        `来源类型：${payload.kind}`,
        `来源名称：${sourceName}`,
        `目标名称：${payload.target_name || "未指定"}`,
        `目标 ID：${payload.target_id || "未指定"}`,
        `用户说明：${payload.instruction || "无"}`,
        "",
        `来源内容：\n${sourceText.slice(0, 24000)}`
      ].join("\n")
    }
  ];
}

function buildPromptTemplate(instruction: string, sourceText: string): string {
  const goal = instruction.trim() || sourceText.trim().slice(0, 500) || "处理用户提供的小说创作材料";
  return [
    "## 适用场景",
    goal,
    "",
    "## 输入要求",
    "- 用户会提供需要处理的文本、当前文档、选区或项目上下文。",
    "- 若信息不足，先指出缺口，再给出可执行的最小建议。",
    "",
    "## 处理步骤",
    "1. 识别文本用途、目标读者和当前创作阶段。",
    "2. 保留用户原始意图，不擅自改变关键事实、人设、世界观和剧情因果。",
    "3. 按任务目标逐项分析、改写或生成结果。",
    "4. 检查输出是否具体、可执行、没有空泛套话。",
    "",
    "## 输出格式",
    "- 直接输出结果正文或审稿意见。",
    "- 必要时使用短标题分区。",
    "- 不输出与任务无关的解释。",
    "",
    "## 质量标准",
    "- 具体、可执行、贴合输入材料。",
    "- 逻辑清楚，避免模板化空话。",
    "- 不生成脚本、命令、外部程序或联网执行能力。"
  ].join("\n");
}

function deriveName(instruction: string, sourceName: string): string {
  const trimmed = instruction.trim().slice(0, 24);
  if (trimmed) {
    return trimmed.replace(/[。！？\n\r]+/g, "");
  }
  return path.parse(sourceName).name || "自定义技能";
}

function deriveId(name: string): string {
  const ascii = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return ascii || "custom_skill";
}

function parseJsonObject(value: string): Record<string, unknown> {
  const raw = String(value || "").trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  const jsonText = fenced || raw;
  try {
    const parsed = JSON.parse(jsonText) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}
