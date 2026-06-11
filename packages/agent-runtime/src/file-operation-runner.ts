import { ConversationService } from "@xiaoshuo/conversation-service";
import { DocumentService } from "@xiaoshuo/document-service";
import { ProjectManifestService } from "@xiaoshuo/project-manifest";
import type {
  AgentPlanResponse,
  FileOperation,
  AgentRunRequest,
  AgentRunResponse,
  AgentStreamEvent,
  ConversationDetail,
  ConversationMessage,
  OperationResult
} from "@xiaoshuo/shared";
import { randomUUID } from "node:crypto";
import type { AgentPlanner } from "./planner.js";

type FileOperationRunnerOptions = {
  planner: AgentPlanner;
  projectRoot: string;
};

export class AgentFileOperationRunner {
  private readonly planner: AgentPlanner;
  private readonly documents: DocumentService;
  private readonly conversations: ConversationService;
  private readonly manifest: ProjectManifestService;

  constructor(options: FileOperationRunnerOptions) {
    this.planner = options.planner;
    this.documents = new DocumentService({ projectRoot: options.projectRoot });
    this.conversations = new ConversationService({ projectRoot: options.projectRoot });
    this.manifest = new ProjectManifestService(options.projectRoot);
  }

  async runAgent(request: AgentRunRequest): Promise<AgentRunResponse> {
    const batchReplace = await this.runBatchReplaceOperation(request);
    if (batchReplace) {
      return batchReplace;
    }

    const directSave = await this.runDirectSaveOperation(request);
    if (directSave) {
      return directSave;
    }

    const plan = await this.planner.buildPlan({
      instruction: request.content || "",
      current_path: request.current_path || "",
      selection: request.selection || "",
      project_context_hint: request.project_context_hint || ""
    });
    if (!plan.can_execute || !plan.operations.length) {
      return {
        intent: "file_operation",
        reply: this.planFailureReply(plan),
        conversation: undefined,
        plan,
        results: [],
        skill_result: undefined,
        saved_paths: [],
        requires_confirmation: false
      };
    }
    if (this.documents.operationsRequireDeleteConfirmation(plan.operations)) {
      return {
        intent: "file_operation",
        reply: "已生成删除/归档类文件操作预览，请确认后执行。",
        conversation: undefined,
        plan,
        results: [],
        skill_result: undefined,
        saved_paths: [],
        requires_confirmation: true
      };
    }

    const results = await this.documents.executeOperations(plan.operations, {
      source: "agent",
      summary: plan.summary
    });
    const reply = this.summarizeOperationResults(results);
    const conversation = await this.recordAgentExchange(request, reply);
    return {
      intent: "file_operation",
      reply,
      conversation,
      plan,
      results,
      skill_result: undefined,
      saved_paths: [],
      requires_confirmation: false
    };
  }

  async *streamAgentRun(request: AgentRunRequest): AsyncGenerator<AgentStreamEvent> {
    try {
      const response = await this.runAgent(request);
      yield {
        type: "start",
        intent: "file_operation",
        conversation_id: response.conversation?.id || request.conversation_id || "",
        skill_id: ""
      };
      yield {
        type: "final",
        payload: response
      };
    } catch (error) {
      yield {
        type: "error",
        message: error instanceof Error ? error.message : String(error)
      };
    }
  }

  private summarizeOperationResults(results: AgentRunResponse["results"]): string {
    if (!results.length) {
      return "没有执行文件改动。";
    }
    return results
      .map((item) => `${item.ok ? "完成" : "失败"}：${item.action} ${item.path}${item.message ? `，${item.message}` : ""}`)
      .join("\n");
  }

  private planFailureReply(plan: AgentPlanResponse): string {
    const warnings = plan.warnings.join("\n");
    return plan.summary + (warnings ? `\n${warnings}` : "");
  }

  private async recordAgentExchange(request: AgentRunRequest, reply: string): Promise<ConversationDetail | undefined> {
    const userText = String(request.content || "").trim();
    if (!userText || !request.conversation_id) {
      return undefined;
    }
    const detail = await this.conversations.getConversation(request.conversation_id).catch(() => null);
    if (!detail) {
      return undefined;
    }

    const createdAt = this.formatNow();
    const metadata = { intent: "file_operation" as const };
    const nextMessages: ConversationMessage[] = [
      ...detail.messages,
      {
        id: randomUUID().replace(/-/g, ""),
        role: "user",
        content: userText,
        created_at: createdAt,
        metadata
      },
      {
        id: randomUUID().replace(/-/g, ""),
        role: "assistant",
        content: reply,
        created_at: createdAt,
        metadata
      }
    ];
    const nextDetail: ConversationDetail = {
      ...detail,
      title: detail.title === "新对话" ? userText.slice(0, 24) || detail.title : detail.title,
      updated_at: createdAt,
      messages: nextMessages,
      message_count: nextMessages.length
    };
    await this.conversations.saveConversation(nextDetail);
    return nextDetail;
  }

  private async runDirectSaveOperation(request: AgentRunRequest): Promise<AgentRunResponse | null> {
    const targetPath = this.resolveDirectSaveTarget(request.content || "");
    if (!targetPath) {
      return null;
    }
    const sourceText = await this.resolveDirectSaveSource(request);
    if (!sourceText.trim()) {
      const plan: AgentPlanResponse = {
        operations: [],
        summary: "没有找到可保存的上文内容。",
        warnings: ["请先生成或输入一段内容，或选中文本后再说“保存到大纲/细纲/章纲/正文”。"],
        can_execute: false
      };
      return {
        intent: "file_operation",
        reply: this.planFailureReply(plan),
        conversation: undefined,
        plan,
        results: [],
        skill_result: undefined,
        saved_paths: [],
        requires_confirmation: false
      };
    }

    const operation = await this.buildDirectSaveOperation(targetPath, sourceText, /(覆盖|替换|改写)/.test(request.content || ""));
    const plan: AgentPlanResponse = {
      operations: [operation],
      summary: `保存上文内容到 ${targetPath}`,
      warnings: [],
      can_execute: true
    };
    const results = await this.documents.executeOperations(plan.operations, {
      source: "agent",
      summary: plan.summary
    });
    const reply = this.summarizeOperationResults(results);
    const conversation = await this.recordAgentExchange(request, reply);
    return {
      intent: "file_operation",
      reply,
      conversation,
      plan,
      results,
      skill_result: undefined,
      saved_paths: [],
      requires_confirmation: false
    };
  }

  private resolveDirectSaveTarget(text: string): string {
    if (!/(保存|存到|写入|写进|写到|追加|同步到|落到|写回|覆盖|替换|改写)/.test(text)) {
      return "";
    }
    const targets: Array<[RegExp, string]> = [
      [/细纲/, "01_大纲/细纲.txt"],
      [/章纲/, "01_大纲/章纲.txt"],
      [/正文/, "02_正文/正文.txt"],
      [/大纲/, "01_大纲/大纲.txt"]
    ];
    for (const [pattern, target] of targets) {
      if (pattern.test(text)) {
        return target;
      }
    }
    return "";
  }

  private async resolveDirectSaveSource(request: AgentRunRequest): Promise<string> {
    const inline = this.extractInlineSaveContent(request.content || "");
    if (inline) {
      return inline;
    }
    if ((request.selection || "").trim()) {
      return request.selection.trim();
    }
    if (!request.conversation_id) {
      return "";
    }
    const detail = await this.conversations.getConversation(request.conversation_id).catch(() => null);
    if (!detail) {
      return "";
    }
    for (const message of [...detail.messages].reverse()) {
      if (!["assistant", "user"].includes(message.role)) {
        continue;
      }
      const candidate = message.content.trim();
      if (this.isSaveSourceCandidate(candidate)) {
        return candidate;
      }
    }
    return "";
  }

  private extractInlineSaveContent(text: string): string {
    const stripped = String(text || "").trim();
    const patterns = [
      /(?:保存|存到|写入|写进|写到|追加|同步到|落到|写回|覆盖|替换|改写).{0,12}(?:大纲|细纲|章纲|正文)\s*[:：]\s*(.+)/s,
      /(?:大纲|细纲|章纲|正文).{0,8}(?:保存|写入|追加|覆盖|替换)\s*[:：]\s*(.+)/s
    ];
    for (const pattern of patterns) {
      const match = stripped.match(pattern);
      if (match?.[1]?.trim()) {
        return match[1].trim();
      }
    }
    const lines = stripped.split(/\r?\n/);
    if (lines.length > 1 && this.resolveDirectSaveTarget(lines[0] || "")) {
      return lines.slice(1).join("\n").trim();
    }
    return "";
  }

  private isSaveSourceCandidate(text: string): boolean {
    const trimmed = text.trim();
    if (trimmed.length < 60) {
      return false;
    }
    if (this.resolveDirectSaveTarget(trimmed) && trimmed.length < 240) {
      return false;
    }
    return !/^(完成|失败|已写入|已保存|没有找到|需要先配置|请提供|请先)/.test(trimmed);
  }

  private async buildDirectSaveOperation(targetPath: string, sourceText: string, overwrite: boolean): Promise<FileOperation> {
    const normalized = `${sourceText.replace(/\s+$/g, "")}\n`;
    if (!normalized.trim()) {
      throw new Error("保存内容为空，已阻止创建空文件。");
    }
    const target = await this.documents.resolveSafePath(targetPath, { allowMissing: true });
    const exists = await import("node:fs/promises").then((fs) => fs.stat(target).then((stats) => stats.isFile()).catch(() => false));
    if (!exists) {
      return {
        action: "create_file",
        path: targetPath,
        text: normalized,
        old_text: "",
        new_text: "",
        target_path: "",
        reason: "根据用户保存指令创建目标文件",
        requires_confirmation: false
      };
    }
    const existing = await this.documents.readRawText(targetPath).catch(() => "");
    if (overwrite && existing) {
      return {
        action: "replace_text",
        path: targetPath,
        text: "",
        old_text: existing,
        new_text: normalized,
        target_path: "",
        reason: "用户明确要求覆盖/替换目标内容",
        requires_confirmation: false
      };
    }
    return {
      action: "append_text",
      path: targetPath,
      text: existing.trim() ? `\n\n${normalized}` : normalized,
      old_text: "",
      new_text: "",
      target_path: "",
      reason: "根据用户保存指令追加上文内容",
      requires_confirmation: false
    };
  }

  private async runBatchReplaceOperation(request: AgentRunRequest): Promise<AgentRunResponse | null> {
    const parsed = this.parseBatchReplaceRequest(request.content || "");
    if (!parsed) {
      return null;
    }

    let { oldText, newText, needsMainCharacter } = parsed;
    if (needsMainCharacter && !oldText) {
      oldText = await this.inferMainCharacterName();
      if (!oldText) {
        const plan: AgentPlanResponse = {
          operations: [],
          summary: "没有找到当前主角名，未执行批量替换。",
          warnings: ["请直接说明旧名字，例如：把“旧名”改为“杨瑞”。"],
          can_execute: false
        };
        return {
          intent: "file_operation",
          reply: this.planFailureReply(plan),
          conversation: undefined,
          plan,
          results: [],
          skill_result: undefined,
          saved_paths: [],
          requires_confirmation: false
        };
      }
    }

    const scopePath = /(当前文档|当前文件|这篇|这章|打开的文档|正在编辑)/.test(request.content || "") ? (request.current_path || "").trim() : "";
    const results = await this.executeBatchReplace(oldText, newText, scopePath);
    const changed = results.filter((item) => item.ok && /替换\s*\d+\s*处/.test(item.message));
    const total = changed.reduce((sum, item) => {
      const match = item.message.match(/替换\s*(\d+)\s*处/);
      return sum + Number.parseInt(match?.[1] || "0", 10);
    }, 0);
    const reply = changed.length ? `完成：批量替换 ${changed.length} 个文件，共 ${total} 处。` : results[0]?.message || "没有找到可替换的内容。";
    const conversation = await this.recordAgentExchange(request, reply);
    return {
      intent: "file_operation",
      reply,
      conversation,
      plan: undefined,
      results,
      skill_result: undefined,
      saved_paths: [],
      requires_confirmation: false
    };
  }

  private parseBatchReplaceRequest(text: string): { oldText: string; newText: string; needsMainCharacter: boolean } | null {
    const stripped = String(text || "").trim();
    if (!stripped) {
      return null;
    }
    if (/(文件名|文件名字|文档名|文档名字|重命名文件|文件重命名)/.test(stripped)) {
      return null;
    }
    if (!/(改为|改成|替换为|换成|统一为|改名为)/.test(stripped)) {
      return null;
    }
    if (!/(名字|名称|主角|男主|女主|主人公|所有|全部|全项目|批量|统一|替换)/.test(stripped)) {
      return null;
    }

    const newMatch = stripped.match(/(?:改为|改成|替换为|换成|统一为|改名为)\s*[“"'‘’]?([^\s，。；;、"'”’]+)/);
    const newText = this.cleanReplaceTerm(newMatch?.[1] || "");
    if (!newText) {
      return null;
    }

    const needsMainCharacter = /(主角|男主|主人公)/.test(stripped);
    if (needsMainCharacter) {
      const oldMatch = stripped.match(/(?:从|由)\s*[“"'‘’]?(.+?)[”"'‘’]?\s*(?:改为|改成|替换为|换成)/);
      return { oldText: this.cleanReplaceTerm(oldMatch?.[1] || ""), newText, needsMainCharacter: true };
    }

    const patterns = [
      /(?:从|由)\s*[“"'‘’]?(.+?)[”"'‘’]?\s*(?:改为|改成|替换为|换成|统一为|改名为)/,
      /(?:把|将)\s*(?:所有|全部|全项目|项目中|文档中|文本中)?\s*[“"'‘’]?(.+?)[”"'‘’]?\s*(?:改为|改成|替换为|换成|统一为|改名为)/
    ];
    for (const pattern of patterns) {
      const match = stripped.match(pattern);
      const oldText = this.cleanReplaceTerm(match?.[1] || "");
      if (oldText && oldText.length <= 40 && !/(文件|文档|内容|名字|名称)$/.test(oldText)) {
        return { oldText, newText, needsMainCharacter: false };
      }
    }
    return null;
  }

  private cleanReplaceTerm(value: string): string {
    let cleaned = String(value || "").trim().replace(/^["'`“”‘’]+|["'`“”‘’]+$/g, "");
    cleaned = cleaned.replace(/^(所有|全部|全项目|项目中|文档中|文本中)/, "").trim();
    cleaned = cleaned.replace(/^(当前文档|当前文件|这篇|这章|这个文档|这个文件)(里|中|内)?的?/, "").trim();
    cleaned = cleaned.replace(/(的)?(名字|名称)$/, "").trim();
    return cleaned.replace(/^["'`“”‘’]+|["'`“”‘’]+$/g, "");
  }

  private async inferMainCharacterName(): Promise<string> {
    const docs = await this.manifest.listDocuments({ limit: 500, force: false }).catch(() => []);
    const priorityDocs = [...docs].sort((left, right) => {
      const rank = (docPath: string) =>
        docPath === "01_大纲/大纲.txt" ? 0 : /人物|设定/.test(docPath) ? 1 : docPath.startsWith("01_大纲/") ? 2 : docPath.startsWith("02_正文/") ? 3 : 4;
      return rank(left.path) - rank(right.path) || left.path.localeCompare(right.path, "zh-CN");
    });
    const patterns = [
      /(?:主角|男主|主人公|男主角)[^\n。；;：:]{0,10}[：:]\s*([^\s，。；;、（）()《》【】]+)/g,
      /(?:主角|男主|主人公|男主角).{0,8}(?:名叫|叫做|叫|姓名是|名字是|名为)\s*([^\s，。；;、（）()《》【】]+)/g
    ];
    const blocked = new Set(["主角", "男主", "女主", "主人公", "作者", "读者", "世界", "文明", "系统", "灵气", "设定"]);
    for (const doc of priorityDocs) {
      const content = await this.documents.readRawText(doc.path, 30000).catch(() => "");
      for (const pattern of patterns) {
        for (const match of content.matchAll(pattern)) {
          const candidate = this.cleanReplaceTerm(String(match[1] || "")).split(/[，。；;、\s]/)[0]?.trim() || "";
          if (candidate.length > 1 && candidate.length <= 12 && !blocked.has(candidate)) {
            return candidate;
          }
        }
      }
    }
    return "";
  }

  private async executeBatchReplace(oldText: string, newText: string, scopePath: string): Promise<OperationResult[]> {
    if (!oldText || !newText || oldText === newText) {
      return [{ action: "replace_text", path: scopePath || ".", ok: false, message: "没有找到可替换的内容。" }];
    }
    const docPaths = scopePath
      ? [scopePath]
      : (await this.manifest.listDocuments({ limit: 500, force: false }).catch(() => [])).map((item) => item.path);
    const results: OperationResult[] = [];
    for (const docPath of docPaths) {
      const content = await this.documents.readRawText(docPath).catch(() => "");
      if (!content) {
        continue;
      }
      const count = content.split(oldText).length - 1;
      if (count <= 0) {
        continue;
      }
      await this.documents.saveDocument(docPath, content.split(oldText).join(newText), {
        source: "agent",
        summary: `批量替换：${oldText} -> ${newText}`
      });
      results.push({
        action: "replace_text",
        path: docPath,
        ok: true,
        message: `替换 ${count} 处`
      });
    }
    return results.length ? results : [{ action: "replace_text", path: scopePath || ".", ok: false, message: "没有找到可替换的内容。" }];
  }

  private formatNow(): string {
    const now = new Date();
    const pad = (value: number) => String(value).padStart(2, "0");
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(
      now.getSeconds()
    )}`;
  }
}
