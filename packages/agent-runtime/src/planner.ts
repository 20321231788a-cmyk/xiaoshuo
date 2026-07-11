import { loadModelConfig, type ConfigServiceOptions } from "@xiaoshuo/config-service";
import { DocumentService } from "@xiaoshuo/document-service";
import { ModelGateway, OpenAICompatibleClient, type ChatCompletionMessage } from "@xiaoshuo/model-client";
import { ProjectManifestService } from "@xiaoshuo/project-manifest";
import { agentPlanResponseSchema, type AgentPlanRequest, type AgentPlanResponse, type DocumentInfo, type FileOperation } from "@xiaoshuo/shared";
import { isCancellationError, type AgentRunOptions } from "./cancellation.js";

const LORE_TARGETS: Record<string, string> = {
  人物设定: "00_设定集/设定集/人物设定.txt",
  体系设定: "00_设定集/设定集/体系设定.txt",
  地图设定: "00_设定集/设定集/地图设定.txt",
  道具设定: "00_设定集/设定集/道具设定.txt"
};

const FIXED_TEXT_TARGETS: Record<string, string> = {
  大纲: "01_大纲/大纲.txt",
  细纲: "01_大纲/细纲.txt",
  章纲: "01_大纲/章纲.txt",
  正文: "02_正文/正文.txt"
};

export type AgentPlannerOptions = {
  projectRoot: string;
  config?: ConfigServiceOptions;
  modelClient?: Pick<OpenAICompatibleClient, "requestCompletion"> & Partial<Pick<OpenAICompatibleClient, "streamCompletion">>;
  webSearchClient?: import("./web-search.js").WebSearchClient;
};

type PlannerModelClient = NonNullable<AgentPlannerOptions["modelClient"]>;

export class AgentPlanner {
  private readonly projectRoot: string;
  private readonly config: ConfigServiceOptions;
  private readonly documents: DocumentService;
  private readonly manifest: ProjectManifestService;
  private readonly gateway: ModelGateway;

  constructor(options: AgentPlannerOptions) {
    this.projectRoot = options.projectRoot;
    this.config = options.config ?? {};
    this.documents = new DocumentService({ projectRoot: options.projectRoot });
    this.manifest = new ProjectManifestService(options.projectRoot);
    const rawClient = options.modelClient ?? new OpenAICompatibleClient();
    this.gateway = rawClient instanceof ModelGateway ? rawClient : new ModelGateway(rawClient as any);
  }

  async buildPlan(request: AgentPlanRequest, options: AgentRunOptions = {}): Promise<AgentPlanResponse> {
    const text = String(request.instruction || "").trim();
    if (!text) {
      return agentPlanResponseSchema.parse({
        operations: [],
        summary: "请输入文件操作或写作目标。",
        warnings: [],
        can_execute: false
      });
    }

    const localRename = await this.buildLocalRenamePlan(text, request.current_path || "");
    if (localRename) {
      return localRename;
    }

    return this.buildAiPlan({
      instruction: this.augmentInstruction(text, request.current_path || "", request.selection || "", request.project_context_hint || "")
    }, options);
  }

  private async buildAiPlan(input: { instruction: string }, options: AgentRunOptions = {}): Promise<AgentPlanResponse> {
    const warnings: string[] = [];
    const docs = await this.manifest.listDocuments({ limit: 500, force: false });
    const config = await loadModelConfig(this.config, "primary");
    if (!config.configured) {
      return agentPlanResponseSchema.parse({
        operations: [],
        summary: "需要先配置主线路模型，Agent 才能规划文件操作。",
        warnings: ["未配置主线路 API Key 或模型名。"],
        can_execute: false
      });
    }

    try {
      const parsed = await this.gateway.completeStructured(
        config,
        this.buildPlannerMessages(input.instruction, docs),
        agentPlanResponseSchema,
        { purpose: "planning", signal: options.signal }
      );
      const rawOperations = Array.isArray(parsed.operations) ? parsed.operations : [];
      if (!rawOperations.length) {
        warnings.push("AI 未返回有效 operations。");
      }
      const operations = rawOperations
        .map((item) => this.coerceOperation(item))
        .filter((item): item is FileOperation => item !== null);
      this.normalizeCreatePaths(operations);
      await this.normalizeLorePaths(operations);
      await this.resolveSimplePathAliases(operations, docs, warnings);
      warnings.push(...(await this.validateOperations(operations)));
      const canExecute = operations.length > 0 && !warnings.some((warning) => warning.startsWith("阻止："));
      return agentPlanResponseSchema.parse({
        operations,
        summary: String(parsed.summary || `生成 ${operations.length} 个文件操作。`),
        warnings,
        can_execute: canExecute
      });
    } catch (error) {
      if (isCancellationError(error, options.signal)) {
        throw error;
      }
      return agentPlanResponseSchema.parse({
        operations: [],
        summary: "模型规划失败，未执行任何文件操作。",
        warnings: [`AI 规划失败：${error instanceof Error ? error.message : String(error)}`],
        can_execute: false
      });
    }
  }

  private async buildLocalRenamePlan(instruction: string, currentPath: string): Promise<AgentPlanResponse | null> {
    if (!this.isRenameInstruction(instruction)) {
      return null;
    }
    const sourcePath = await this.resolveRenameSource(instruction, currentPath);
    if (!sourcePath) {
      return agentPlanResponseSchema.parse({
        operations: [],
        summary: "未找到要重命名的文件。",
        warnings: ["请在指令里带上文件名，或先打开要重命名的文件。"],
        can_execute: false
      });
    }
    const targetName = this.resolveRenameTargetName(instruction, sourcePath);
    if (!targetName) {
      return agentPlanResponseSchema.parse({
        operations: [],
        summary: "未识别新文件名。",
        warnings: ["请使用“文件名修改为XXX”或“重命名为XXX”的说法。"],
        can_execute: false
      });
    }
    const normalizedSource = this.documents.normalizeRelativePath(sourcePath);
    const targetPath = this.joinRenameTarget(normalizedSource, targetName);
    if (normalizedSource === targetPath) {
      return agentPlanResponseSchema.parse({
        operations: [],
        summary: "新文件名与当前文件名相同。",
        warnings: [`当前文件已经是 ${targetPath}。`],
        can_execute: false
      });
    }
    const operation = this.coerceOperation({
      action: "move_file",
      path: normalizedSource,
      target_path: targetPath,
      reason: "用户明确要求修改文件名，执行重命名而不改写内容。"
    });
    const warnings = operation ? await this.validateOperations([operation]) : ["阻止：无法生成重命名操作"];
    return agentPlanResponseSchema.parse({
      operations: warnings.length ? [] : [operation],
      summary: `重命名 ${normalizedSource} -> ${targetPath}`,
      warnings,
      can_execute: warnings.length === 0
    });
  }

  private buildPlannerMessages(instruction: string, docs: DocumentInfo[]): ChatCompletionMessage[] {
    const docList = docs.slice(0, 300).map((item) => `- ${item.path}`).join("\n");
    return [
      {
        role: "system",
        content: [
          "你是小说项目的 AI 文件管家。只输出 JSON，不要解释。",
          "你负责把用户的文档目标转成可执行的项目内文件操作；路径必须是项目内相对路径，具体安全校验由系统执行。",
          "允许的 action: create_file, append_text, replace_text, move_file, archive_file。",
          "用户说“文件名”“改名”“重命名”时，必须使用 move_file。",
          "固定写入目标：大纲=01_大纲/大纲.txt，细纲=01_大纲/细纲.txt，章纲=01_大纲/章纲.txt，正文=02_正文/正文.txt。",
          "设定集卡片固定路径：00_设定集/设定集/人物设定.txt、体系设定.txt、地图设定.txt、道具设定.txt。",
          "如果用户要生成新内容并落到项目文档，operations 不能为空，text 必须包含要写入的正文。",
          '输出格式：{"summary":"...","operations":[{"action":"...","path":"...","target_path":"...","text":"...","old_text":"...","new_text":"...","reason":"..."}]}'
        ].join("\n")
      },
      {
        role: "user",
        content: `已有文档：\n${docList}\n\n用户指令：\n${instruction}`
      }
    ];
  }

  private parseJson(content: string): Record<string, unknown> {
    const raw = String(content || "").trim();
    const match = raw.match(/\{[\s\S]*\}/);
    return JSON.parse(match?.[0] || raw) as Record<string, unknown>;
  }

  private coerceOperation(item: unknown): FileOperation | null {
    if (!item || typeof item !== "object") {
      return null;
    }
    const record = item as Record<string, unknown>;
    const action = String(record.action || "").trim();
    if (!["create_file", "append_text", "replace_text", "move_file", "archive_file"].includes(action)) {
      return null;
    }
    return {
      action: action as FileOperation["action"],
      path: String(record.path || "").trim(),
      text: String(record.text || ""),
      old_text: String(record.old_text || ""),
      new_text: String(record.new_text || ""),
      target_path: String(record.target_path || "").trim(),
      reason: String(record.reason || ""),
      requires_confirmation: action === "archive_file"
    };
  }

  private async validateOperations(operations: FileOperation[]): Promise<string[]> {
    const warnings: string[] = [];
    for (let index = 0; index < operations.length; index += 1) {
      const operation = operations[index]!;
      try {
        await this.documents.resolveSafePath(operation.path, { allowMissing: operation.action === "create_file" });
        if (operation.action === "move_file") {
          if (!operation.target_path) {
            warnings.push(`阻止：第 ${index + 1} 个 move_file 缺少 target_path`);
          } else {
            await this.documents.resolveSafePath(operation.target_path, { allowMissing: true });
          }
        }
        if (operation.action === "replace_text" && !operation.old_text) {
          warnings.push(`阻止：第 ${index + 1} 个 replace_text 缺少 old_text`);
        }
      } catch (error) {
        warnings.push(`阻止：第 ${index + 1} 个操作不安全：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return warnings;
  }

  private async resolveSimplePathAliases(operations: FileOperation[], docs: DocumentInfo[], warnings: string[]): Promise<void> {
    const docByName = new Map<string, DocumentInfo[]>();
    for (const doc of docs) {
      const key = doc.name.trim();
      docByName.set(key, [...(docByName.get(key) || []), doc]);
    }
    for (const operation of operations) {
      if (operation.action === "create_file") {
        continue;
      }
      const normalized = operation.path.replace(/\\/g, "/").trim();
      if (normalized.includes("/")) {
        continue;
      }
      const exact = docs.find((doc) => doc.path === normalized);
      if (exact) {
        operation.path = exact.path;
        continue;
      }
      const fixed = FIXED_TEXT_TARGETS[normalized];
      if (fixed) {
        operation.path = fixed;
        continue;
      }
      const candidates = docByName.get(normalized) || [];
      if (candidates.length === 1) {
        operation.path = candidates[0]!.path;
        warnings.push(`已将 ${normalized} 匹配为 ${candidates[0]!.path}。`);
      }
    }
  }

  private normalizeCreatePaths(operations: FileOperation[]): void {
    for (const operation of operations) {
      if (operation.action !== "create_file") {
        continue;
      }
      let nextPath = operation.path.replace(/\\/g, "/").trim();
      if (!nextPath || nextPath.includes("/")) {
        operation.path = nextPath;
        continue;
      }
      const stem = nextPath.replace(/\.[^.]+$/, "");
      if (FIXED_TEXT_TARGETS[stem]) {
        nextPath = FIXED_TEXT_TARGETS[stem]!;
      } else if (/第\s*\d+\s*章/.test(stem)) {
        const match = stem.match(/(\d+)/);
        nextPath = match ? `02_正文/第${Number.parseInt(match[1] || "0", 10).toString().padStart(3, "0")}章.txt` : `02_正文/${nextPath}`;
      } else if (/(人物|体系|地图|道具|设定)/.test(stem)) {
        nextPath = `00_设定集/设定集/${nextPath}`;
      } else if (/风格/.test(stem)) {
        nextPath = `00_设定集/风格库/${nextPath}`;
      } else if (/题材/.test(stem)) {
        nextPath = `00_设定集/题材库/${nextPath}`;
      } else {
        nextPath = `01_大纲/${nextPath}`;
      }
      operation.path = nextPath;
    }
  }

  private async normalizeLorePaths(operations: FileOperation[]): Promise<void> {
    for (const operation of operations) {
      operation.path = this.normalizeLorePath(operation.path);
      if (operation.target_path) {
        operation.target_path = this.normalizeLorePath(operation.target_path);
      }
      if (LORE_TARGETS[operation.path] || Object.values(LORE_TARGETS).includes(operation.path)) {
        const target = await this.documents.resolveSafePath(operation.path, { allowMissing: true }).catch(() => "");
        if (!target) {
          continue;
        }
        const exists = await fileExists(target);
        if (operation.action === "create_file" && exists) {
          operation.action = "append_text";
        } else if (operation.action === "append_text" && !exists) {
          operation.action = "create_file";
        }
      }
    }
  }

  private normalizeLorePath(value: string): string {
    const normalized = String(value || "").replace(/\\/g, "/").trim().replace(/^\/+/, "");
    if (!normalized) {
      return normalized;
    }
    const name = normalized.split("/").at(-1) || "";
    const stem = name.replace(/\.[^.]+$/, "");
    if (FIXED_TEXT_TARGETS[name]) {
      return FIXED_TEXT_TARGETS[name]!;
    }
    if (FIXED_TEXT_TARGETS[stem]) {
      return FIXED_TEXT_TARGETS[stem]!;
    }
    if (LORE_TARGETS[name]) {
      return LORE_TARGETS[name]!;
    }
    if (LORE_TARGETS[stem]) {
      return LORE_TARGETS[stem]!;
    }
    return normalized;
  }

  private augmentInstruction(instruction: string, currentPath: string, selection: string, projectContextHint: string): string {
    const parts = [instruction];
    if (currentPath) {
      parts.push(`当前文档=${currentPath}`);
    }
    if (selection) {
      parts.push(`当前选区=\n${selection.slice(0, 4000)}`);
    }
    if (projectContextHint) {
      parts.push(`项目上下文提示=\n${projectContextHint.slice(0, 8000)}`);
    }
    return parts.join("\n\n");
  }

  private isRenameInstruction(instruction: string): boolean {
    const hasFileNameIntent = /(文件名|文件名字|文档名|文档名字|改名|重命名|命名为)/.test(instruction) || (instruction.includes("名字") && /(文件|文档)/.test(instruction));
    return hasFileNameIntent && /(修改为|改成|改为|改叫|叫做|命名为|重命名为|改名为)/.test(instruction);
  }

  private async resolveRenameSource(instruction: string, currentPath: string): Promise<string> {
    const normalizedCurrent = currentPath.replace(/\\/g, "/").trim().replace(/^\/+/, "");
    if (normalizedCurrent && /(当前|这个|这篇|打开的|正在编辑)/.test(instruction)) {
      return normalizedCurrent;
    }
    const latestChanged = await this.latestChangedDocument(instruction);
    if (latestChanged) {
      return latestChanged;
    }
    if (normalizedCurrent) {
      return normalizedCurrent;
    }
    const docs = await this.manifest.listDocuments({ limit: 500 });
    const instructionNormalized = instruction.replace(/\\/g, "/");
    const exact = docs.find((doc) => instructionNormalized.includes(doc.path));
    if (exact) {
      return exact.path;
    }
    const named = docs.filter((doc) => doc.name && instruction.includes(doc.name));
    if (instruction.includes("正文")) {
      const body = named.find((doc) => doc.path.startsWith("02_正文/"));
      if (body) {
        return body.path;
      }
    }
    return named[0]?.path || "";
  }

  private async latestChangedDocument(instruction: string): Promise<string> {
    const entries = await this.documents.listTimeline(20).catch(() => []);
    const preferBody = instruction.includes("正文");
    for (const entry of entries) {
      for (const change of [...entry.files].reverse()) {
        const changePath = String(change.path || "").replace(/\\/g, "/").trim();
        if (!changePath || !/\.(txt|md)$/i.test(changePath)) {
          continue;
        }
        if (preferBody && !changePath.startsWith("02_正文/")) {
          continue;
        }
        if (change.after_exists) {
          return changePath;
        }
      }
    }
    return "";
  }

  private resolveRenameTargetName(instruction: string, sourcePath: string): string {
    const chapterMatch = instruction.match(/第\s*(0*\d+)\s*章/);
    if (chapterMatch) {
      return `第${chapterMatch[1]}章${this.sourceExtension(sourcePath)}`;
    }
    const match = instruction.match(/(?:修改为|改成|改为|改叫|叫做|命名为|重命名为|改名为)\s*([^\s，。,.;；]+)/);
    return match ? this.sanitizeFilename(match[1] || "", sourcePath) : "";
  }

  private sanitizeFilename(filename: string, sourcePath: string): string {
    let cleaned = filename.trim().replace(/^["'`“”‘’]+|["'`“”‘’]+$/g, "");
    cleaned = cleaned.replace(/[\\/:*?"<>|]/g, "_").replace(/[. ]+$/g, "");
    if (!cleaned) {
      return "";
    }
    if (!/\.(txt|md)$/i.test(cleaned)) {
      cleaned += this.sourceExtension(sourcePath);
    }
    return cleaned;
  }

  private sourceExtension(sourcePath: string): string {
    const match = sourcePath.match(/(\.[A-Za-z0-9]+)$/);
    return match?.[1] || ".txt";
  }

  private joinRenameTarget(sourcePath: string, targetName: string): string {
    const normalized = sourcePath.replace(/\\/g, "/").trim().replace(/^\/+/, "");
    const index = normalized.lastIndexOf("/");
    return index >= 0 ? `${normalized.slice(0, index)}/${targetName}` : targetName;
  }
}

async function fileExists(targetPath: string): Promise<boolean> {
  try {
    const fs = await import("node:fs/promises");
    const stats = await fs.stat(targetPath);
    return stats.isFile();
  } catch {
    return false;
  }
}
