import { loadModelConfig, type ConfigServiceOptions } from "@xiaoshuo/config-service";
import { DocumentService } from "@xiaoshuo/document-service";
import { OpenAICompatibleClient, type ChatCompletionMessage } from "@xiaoshuo/model-client";
import { ProjectManifestService } from "@xiaoshuo/project-manifest";
import { generatedSavePlanSchema, type DocumentInfo, type GeneratedSavePlan } from "@xiaoshuo/shared";
import fs from "node:fs/promises";

const FIXED_TEXT_TARGETS: Record<string, string> = {
  大纲: "01_大纲/大纲.txt",
  细纲: "01_大纲/细纲.txt",
  章纲: "01_大纲/章纲.txt",
  正文: "02_正文/正文.txt"
};

const LORE_TARGETS: Record<string, string> = {
  人物设定: "00_设定集/设定集/人物设定.txt",
  体系设定: "00_设定集/设定集/体系设定.txt",
  地图设定: "00_设定集/设定集/地图设定.txt",
  道具设定: "00_设定集/设定集/道具设定.txt"
};

const GENRE_TARGETS: Record<string, string> = {
  题材规则: "00_设定集/题材库/题材规则.txt",
  题材素材: "00_设定集/题材库/题材素材.txt",
  战斗模板: "00_设定集/题材库/战斗模板.txt",
  违禁词: "00_设定集/题材库/违禁词.txt"
};

const SKILL_DEFAULT_TARGETS: Record<string, string> = {
  outline_generate: "01_大纲/大纲.txt",
  detail_outline_generate: "01_大纲/细纲.txt",
  chapter_outline_generate: "01_大纲/章纲.txt",
  reverse_outline_extract: "01_大纲/反向细纲.txt",
  style_extract: "00_设定集/风格库/写作风格.txt",
  body_generate: "02_正文/正文.txt",
  polish_text: "02_正文/润色结果.txt",
  continue_text: "02_正文/续写结果.txt",
  story_deslop: "02_正文/去AI味结果.txt",
  humanizer_zh: "02_正文/去AI味结果.txt"
};

export type GeneratedSavePlannerOptions = {
  projectRoot: string;
  config?: ConfigServiceOptions;
  modelClient?: Pick<OpenAICompatibleClient, "requestCompletion">;
};

export type GeneratedSavePlanInput = {
  instruction: string;
  content: string;
  source: "chat" | "skill" | "workflow";
  skillId?: string;
  targetPaths?: string[];
  targetPath?: string;
  defaultMode?: "replace" | "append";
  currentPath?: string;
  chapter?: number;
  writeRequested?: boolean;
};

export class GeneratedSavePlanner {
  private readonly config: ConfigServiceOptions;
  private readonly documents: DocumentService;
  private readonly manifest: ProjectManifestService;
  private readonly modelClient: Pick<OpenAICompatibleClient, "requestCompletion">;

  constructor(options: GeneratedSavePlannerOptions) {
    this.config = options.config ?? {};
    this.documents = new DocumentService({ projectRoot: options.projectRoot });
    this.manifest = new ProjectManifestService(options.projectRoot);
    this.modelClient = options.modelClient ?? new OpenAICompatibleClient();
  }

  async planGeneratedSave(input: GeneratedSavePlanInput): Promise<GeneratedSavePlan> {
    const fallback = await this.buildFallbackPlan(input);
    if (!String(input.content || "").trim()) {
      return fallback;
    }
    const shouldAskModel = input.source === "chat" || !fallback.target_paths.length || fallback.confidence < 0.65;
    if (!shouldAskModel) {
      return fallback;
    }

    const config = await loadModelConfig(this.config, "primary").catch(() => null);
    if (!config?.configured) {
      return fallback;
    }

    try {
      const docs = await this.manifest.listDocuments({ limit: 260, force: false }).catch(() => []);
      const raw = await this.modelClient.requestCompletion(config, this.buildMessages(input, fallback, docs), 0.1);
      const parsed = this.parseJson(raw);
      const plan = await this.normalizePlan(parsed, input, fallback);
      if (!plan.target_paths.length && fallback.target_paths.length) {
        plan.target_paths = fallback.target_paths;
      }
      return this.applyConfirmationPolicy(plan, input);
    } catch {
      return fallback;
    }
  }

  async shouldAutoCommit(plan: GeneratedSavePlan): Promise<boolean> {
    return Boolean(plan.should_auto_commit && plan.action !== "no_save" && plan.target_paths.length && !plan.requires_confirmation);
  }

  private buildMessages(input: GeneratedSavePlanInput, fallback: GeneratedSavePlan, docs: DocumentInfo[]): ChatCompletionMessage[] {
    const docList = docs.slice(0, 220).map((item) => `- ${item.path}`).join("\n");
    return [
      {
        role: "system",
        content: [
          "你是 ArcWriter 的生成结果保存规划器。只输出 JSON，不要解释。",
          "你需要判断一段 AI 生成内容应该不保存、保存到哪个项目文件、追加还是覆盖，必要时拆分成多个目标。",
          "允许 action: no_save, save_generated, split_and_save, append_to_existing, replace_existing, create_file。",
          "路径必须是项目内相对路径，必须遵守旧项目目录规则。",
          "固定目标：大纲=01_大纲/大纲.txt，细纲=01_大纲/细纲.txt，章纲=01_大纲/章纲.txt，正文=02_正文/正文.txt。",
          "章节正文使用 02_正文/第XXX章.txt；人物/体系/地图/道具设定写入 00_设定集/设定集/；风格写入 00_设定集/风格库/；题材写入 00_设定集/题材库/。",
          "只有用户明确要求保存、写入、同步、追加、覆盖，或系统 writeRequested=true 时，才 should_auto_commit=true。",
          "覆盖已有内容、目标不清晰、拆分多文件或置信度低时 requires_confirmation=true。",
          '输出格式：{"action":"...","mode":"replace|append","target_paths":["..."],"segments":[{"target_path":"...","content":"...","mode":"replace|append","reason":"..."}],"reason":"...","confidence":0-1,"requires_confirmation":true|false,"should_auto_commit":true|false}'
        ].join("\n")
      },
      {
        role: "user",
        content: [
          `来源：${input.source}`,
          `技能：${input.skillId || "无"}`,
          `用户指令：${input.instruction || "无"}`,
          `当前文档：${input.currentPath || "无"}`,
          `章节：${input.chapter || 0}`,
          `writeRequested：${input.writeRequested ? "true" : "false"}`,
          `候选目标：${fallback.target_paths.join(", ") || "无"}`,
          "",
          `已有文档：\n${docList || "无"}`,
          "",
          `生成内容：\n${clip(String(input.content || ""), 12000)}`
        ].join("\n")
      }
    ];
  }

  private async buildFallbackPlan(input: GeneratedSavePlanInput): Promise<GeneratedSavePlan> {
    const normalizedTargets = this.normalizeTargetPaths([
      ...(input.targetPaths || []),
      input.targetPath || "",
      ...this.inferTargets(input)
    ]);
    const mode = this.resolveMode(input);
    const hasWriteIntent = Boolean(input.writeRequested || hasExplicitWriteIntent(input.instruction));
    const action = !hasWriteIntent && !normalizedTargets.length
      ? "no_save"
      : mode === "append"
        ? "append_to_existing"
        : "replace_existing";
    const plan = generatedSavePlanSchema.parse({
      action,
      mode,
      target_paths: normalizedTargets,
      segments: [],
      reason: hasWriteIntent ? "根据用户指令和旧项目目录规则推断保存目标。" : "未检测到明确保存意图，生成结果仅进入待确认缓存。",
      confidence: normalizedTargets.length ? 0.72 : 0.25,
      requires_confirmation: false,
      should_auto_commit: false,
      source: input.source,
      skill_id: input.skillId || ""
    });
    return this.applyConfirmationPolicy(plan, input);
  }

  private async normalizePlan(raw: Record<string, unknown>, input: GeneratedSavePlanInput, fallback: GeneratedSavePlan): Promise<GeneratedSavePlan> {
    const plan = generatedSavePlanSchema.parse({
      ...raw,
      mode: raw.mode === "append" ? "append" : raw.mode === "replace" ? "replace" : fallback.mode,
      target_paths: this.normalizeTargetPaths(Array.isArray(raw.target_paths) ? raw.target_paths.map(String) : fallback.target_paths),
      segments: Array.isArray(raw.segments)
        ? raw.segments.map((segment) => this.normalizeSegment(segment)).filter(Boolean)
        : [],
      source: input.source,
      skill_id: input.skillId || ""
    });
    if (plan.action !== "no_save" && !plan.target_paths.length && fallback.target_paths.length) {
      plan.target_paths = fallback.target_paths;
    }
    if (!plan.reason) {
      plan.reason = fallback.reason;
    }
    if (!Number.isFinite(plan.confidence) || plan.confidence <= 0) {
      plan.confidence = fallback.confidence;
    }
    return plan;
  }

  private normalizeSegment(value: unknown) {
    if (!value || typeof value !== "object") {
      return null;
    }
    const record = value as Record<string, unknown>;
    const targetPath = this.normalizeTargetPaths([String(record.target_path || "")])[0] || "";
    if (!targetPath) {
      return null;
    }
    return {
      target_path: targetPath,
      content: String(record.content || ""),
      mode: record.mode === "append" ? "append" : "replace",
      reason: String(record.reason || "")
    };
  }

  private async applyConfirmationPolicy(plan: GeneratedSavePlan, input: GeneratedSavePlanInput): Promise<GeneratedSavePlan> {
    const targetPaths = this.normalizeTargetPaths(plan.target_paths);
    const confidence = Math.max(0, Math.min(1, Number(plan.confidence || 0)));
    const hasWriteIntent = Boolean(input.writeRequested || hasExplicitWriteIntent(input.instruction));
    const lowConfidence = confidence < 0.58;
    const manyTargets = targetPaths.length > 1 && input.skillId !== "lore_extract" && input.skillId !== "genre_generate";
    const unclear = plan.action !== "no_save" && !targetPaths.length;
    const requestedReplace = plan.mode === "replace" || plan.action === "replace_existing";

    let requiresConfirmation = Boolean(plan.requires_confirmation || lowConfidence || manyTargets || unclear);
    if (requestedReplace) {
      const existingFlags = await Promise.all(targetPaths.map((targetPath) => this.hasExistingContent(targetPath)));
      if (existingFlags.some(Boolean)) {
        requiresConfirmation = input.skillId === "lore_extract" ? requiresConfirmation : true;
      }
    }
    if (!hasWriteIntent) {
      requiresConfirmation = true;
    }

    return generatedSavePlanSchema.parse({
      ...plan,
      target_paths: targetPaths,
      confidence,
      requires_confirmation: requiresConfirmation,
      should_auto_commit: Boolean(hasWriteIntent && !requiresConfirmation && plan.action !== "no_save" && targetPaths.length)
    });
  }

  private resolveMode(input: GeneratedSavePlanInput): "replace" | "append" {
    const instruction = input.instruction || "";
    if (/(追加|补充|续写|接着|附加|append)/i.test(instruction)) {
      return "append";
    }
    if (/(覆盖|替换|重写|改写|replace)/i.test(instruction)) {
      return "replace";
    }
    return input.defaultMode || "replace";
  }

  private inferTargets(input: GeneratedSavePlanInput): string[] {
    const skillId = input.skillId || "";
    if (skillId === "lore_extract") {
      return Object.values(LORE_TARGETS);
    }
    if (skillId === "genre_generate") {
      return Object.values(GENRE_TARGETS);
    }
    if (skillId === "body_generate" && input.chapter && input.chapter > 0) {
      return [`02_正文/第${String(input.chapter).padStart(3, "0")}章.txt`];
    }
    const explicit = this.inferTargetFromInstruction(input.instruction || "", input.chapter || 0);
    if (explicit.length) {
      return explicit;
    }
    if (SKILL_DEFAULT_TARGETS[skillId]) {
      return [SKILL_DEFAULT_TARGETS[skillId]];
    }
    const currentPath = String(input.currentPath || "").trim();
    if (currentPath && /(当前文档|这篇|这一篇|当前文件|打开的文档)/.test(input.instruction || "")) {
      return [currentPath];
    }
    return [];
  }

  private inferTargetFromInstruction(instruction: string, chapter: number): string[] {
    const text = instruction || "";
    const targets: string[] = [];
    for (const [keyword, target] of Object.entries(FIXED_TEXT_TARGETS)) {
      if (text.includes(keyword)) {
        targets.push(target);
      }
    }
    for (const [keyword, target] of [...Object.entries(LORE_TARGETS), ...Object.entries(GENRE_TARGETS)]) {
      if (text.includes(keyword)) {
        targets.push(target);
      }
    }
    if (/风格|文风/.test(text)) {
      targets.push("00_设定集/风格库/写作风格.txt");
    }
    const chapterMatch = text.match(/第\s*(\d{1,4})\s*章/);
    if (/正文/.test(text) || chapterMatch || chapter > 0) {
      const number = chapterMatch ? Number.parseInt(chapterMatch[1] || "0", 10) : chapter;
      if (number > 0) {
        targets.push(`02_正文/第${String(number).padStart(3, "0")}章.txt`);
      }
    }
    return targets;
  }

  private normalizeTargetPaths(paths: string[]): string[] {
    const normalized: string[] = [];
    const seen = new Set<string>();
    for (const item of paths) {
      const path = this.normalizePath(item);
      if (!path || seen.has(path)) {
        continue;
      }
      seen.add(path);
      normalized.push(path);
    }
    return normalized;
  }

  private normalizePath(value: string): string {
    const raw = String(value || "").replace(/\\/g, "/").trim().replace(/^\/+/, "");
    if (!raw) {
      return "";
    }
    const filename = raw.split("/").at(-1) || raw;
    const stem = filename.replace(/\.[^.]+$/, "");
    if (FIXED_TEXT_TARGETS[raw]) {
      return FIXED_TEXT_TARGETS[raw]!;
    }
    if (FIXED_TEXT_TARGETS[stem]) {
      return FIXED_TEXT_TARGETS[stem]!;
    }
    if (LORE_TARGETS[raw]) {
      return LORE_TARGETS[raw]!;
    }
    if (LORE_TARGETS[stem]) {
      return LORE_TARGETS[stem]!;
    }
    if (GENRE_TARGETS[raw]) {
      return GENRE_TARGETS[raw]!;
    }
    if (GENRE_TARGETS[stem]) {
      return GENRE_TARGETS[stem]!;
    }
    try {
      return this.documents.normalizeRelativePath(raw);
    } catch {
      return "";
    }
  }

  private async hasExistingContent(targetPath: string): Promise<boolean> {
    // Confirmation policy is conservative only when the file is known to contain text.
    try {
      const fullPath = await this.documents.resolveSafePath(targetPath, { allowMissing: false });
      return String(await fs.readFile(fullPath, "utf8")).trim().length > 0;
    } catch {
      return false;
    }
  }

  private parseJson(content: string): Record<string, unknown> {
    const raw = String(content || "").trim();
    const match = raw.match(/\{[\s\S]*\}/);
    return JSON.parse(match?.[0] || raw) as Record<string, unknown>;
  }
}

export function hasExplicitWriteIntent(text: string): boolean {
  return /(同步|写入|保存|更新|替换|覆盖|落到|写回|补充|补全|完善|补齐|填充|配置|设置|设定|建立|创建|追加|存到|写进|写到)/.test(text || "");
}

function clip(text: string, limit: number): string {
  const normalized = String(text || "").trim();
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit).trimEnd()}\n...（已截断）`;
}
