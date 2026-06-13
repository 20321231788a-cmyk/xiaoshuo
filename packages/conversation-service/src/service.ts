import {
  conversationDetailSchema,
  type ConversationDetail,
  type ConversationMessage,
  type ConversationSummary,
  type PinnedContextItem,
  type ConversationAttachment
} from "@xiaoshuo/shared";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import AdmZip from "adm-zip";
import { PDFParse } from "pdf-parse";

export const AGENT_DIR = path.join("00_设定集", ".agent");

export type ConversationServiceOptions = {
  projectRoot: string;
  idFactory?: () => string;
  now?: () => string;
  readDocument?: (relativePath: string, limit?: number) => Promise<string> | string;
};

export type ConversationCreatePayload = {
  title?: string;
  skill_id?: string;
  agent_name?: string;
};

export type AppendMessagePayload = {
  role: ConversationMessage["role"];
  content: string;
  metadata?: Record<string, unknown>;
};

export type PinContextPayload = {
  kind?: PinnedContextItem["kind"];
  label?: string;
  path?: string;
  content?: string;
};

export class ConversationService {
  private readonly projectRoot: string;
  private readonly idFactory: () => string;
  private readonly now: () => string;
  private readonly readDocument?: ConversationServiceOptions["readDocument"];

  constructor(options: ConversationServiceOptions) {
    this.projectRoot = path.resolve(options.projectRoot);
    this.idFactory = options.idFactory || (() => randomUUID().replaceAll("-", ""));
    this.now = options.now || (() => formatNow(new Date()));
    this.readDocument = options.readDocument;
  }

  async listConversations(): Promise<ConversationSummary[]> {
    const dir = await this.conversationsDir();
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    const jsonEntries = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json") && !entry.name.endsWith(".json.bak"))
        .map(async (entry) => {
          const fullPath = path.join(dir, entry.name);
          const stats = await fs.stat(fullPath);
          return { id: entry.name.slice(0, -".json".length), mtimeMs: stats.mtimeMs };
        })
    );

    const details: ConversationDetail[] = [];
    for (const entry of jsonEntries.sort((left, right) => right.mtimeMs - left.mtimeMs || right.id.localeCompare(left.id))) {
      try {
        details.push(await this.getConversation(entry.id));
      } catch (error) {
        // Python skips corrupted entries in list_conversations.
      }
    }
    return details.map((detail) => this.toSummary(detail));
  }

  async createConversation(payload: ConversationCreatePayload = {}): Promise<ConversationDetail> {
    const timestamp = this.now();
    const detail: ConversationDetail = {
      id: this.idFactory(),
      title: (payload.title || "").trim() || "新对话",
      created_at: timestamp,
      updated_at: timestamp,
      current_skill: payload.skill_id || "",
      current_agent: payload.agent_name || "",
      summary: "",
      pinned_context: [],
      attachments: [],
      messages: [],
      message_count: 0,
      attachment_count: 0
    };
    await this.saveDetail(detail);
    return detail;
  }

  async getConversation(conversationId: string): Promise<ConversationDetail> {
    return this.loadDetail(conversationId);
  }

  async renameConversation(conversationId: string, title: string): Promise<ConversationDetail> {
    const detail = await this.loadDetail(conversationId);
    const nextTitle = (title || "").trim();
    if (!nextTitle) {
      throw new Error("对话标题不能为空");
    }
    detail.title = nextTitle.slice(0, 80);
    detail.updated_at = this.now();
    return this.saveDetail(detail);
  }

  async appendMessage(conversationId: string, payload: AppendMessagePayload): Promise<ConversationDetail> {
    const detail = await this.loadDetail(conversationId);
    const content = (payload.content || "").trim();
    if (!content) {
      throw new Error("消息内容不能为空");
    }
    if (!["user", "assistant", "system"].includes(payload.role)) {
      throw new Error("消息角色无效");
    }
    detail.messages.push({
      id: this.idFactory(),
      role: payload.role,
      content,
      created_at: this.now(),
      metadata: payload.metadata || {}
    });
    detail.updated_at = this.now();
    return this.saveDetail(detail);
  }

  async pinContext(conversationId: string, payload: PinContextPayload): Promise<ConversationDetail> {
    const detail = await this.loadDetail(conversationId);
    const kind = payload.kind || "document";
    let label = (payload.label || "").trim();
    let content = (payload.content || "").trim();
    const targetPath = (payload.path || "").trim();

    if (kind === "document") {
      if (!targetPath) {
        throw new Error("缺少要固定的项目文件");
      }
      content = await this.readProjectDocument(targetPath, 12000);
      label = label || path.basename(targetPath);
    } else if (!content) {
      throw new Error("缺少要固定的上下文内容");
    }

    detail.pinned_context.push({
      id: this.idFactory(),
      kind,
      label: label || "固定上下文",
      path: targetPath,
      content_excerpt: excerpt(content, 8000),
      created_at: this.now()
    });
    detail.updated_at = this.now();
    return this.saveDetail(detail);
  }

  async clearPinnedContext(conversationId: string): Promise<ConversationDetail> {
    const detail = await this.loadDetail(conversationId);
    detail.pinned_context = [];
    detail.updated_at = this.now();
    return this.saveDetail(detail);
  }

  async removePinnedContext(conversationId: string, itemId: string): Promise<ConversationDetail> {
    const detail = await this.loadDetail(conversationId);
    const nextItems = detail.pinned_context.filter((item) => item.id !== itemId);
    if (nextItems.length === detail.pinned_context.length) {
      throw new Error("未找到固定上下文");
    }
    detail.pinned_context = nextItems;
    detail.updated_at = this.now();
    return this.saveDetail(detail);
  }

  async summarizeConversation(conversationId: string): Promise<ConversationDetail> {
    const detail = await this.loadDetail(conversationId);
    detail.summary = summarizeDeterministic(detail);
    detail.updated_at = this.now();
    return this.saveDetail(detail);
  }

  async updateConversationSummary(conversationId: string, summary: string): Promise<ConversationDetail> {
    const detail = await this.loadDetail(conversationId);
    detail.summary = (summary || "").trim();
    detail.updated_at = this.now();
    return this.saveDetail(detail);
  }


  async addAttachment(conversationId: string, filename: string, mediaType: string, content: Buffer): Promise<ConversationAttachment> {
    const detail = await this.loadDetail(conversationId);
    if (!filename) {
      throw new Error("缺少上传文件名");
    }
    if (!content || !content.length) {
      throw new Error("上传文件为空");
    }

    const attachmentId = this.idFactory();
    const safeName = filename.replace(/[^\w.\-\u4e00-\u9fff]+/g, "_").replace(/^[._]+|[._]+$/g, "") || "attachment.txt";
    const attachmentDir = await this.attachmentsDir(conversationId);
    
    const originalFullPath = path.join(attachmentDir, `${attachmentId}__${safeName}`);
    const textFullPath = path.join(attachmentDir, `${attachmentId}.txt`);

    await fs.mkdir(attachmentDir, { recursive: true });
    await fs.writeFile(originalFullPath, content);

    const extracted = await this.extractAttachmentText(originalFullPath, mediaType, content);
    await fs.writeFile(textFullPath, extracted, "utf8");

    const agentRootPath = await this.agentRoot();
    const relativePath = path.relative(agentRootPath, originalFullPath).replace(/\\/g, "/");
    const textRelativePath = path.relative(agentRootPath, textFullPath).replace(/\\/g, "/");

    const attachment: ConversationAttachment = {
      id: attachmentId,
      name: filename,
      media_type: mediaType || this.guessMediaType(filename),
      relative_path: relativePath,
      text_relative_path: textRelativePath,
      size: content.length,
      excerpt: excerpt(extracted, 220),
      created_at: this.now()
    };

    detail.attachments.push(attachment);
    detail.updated_at = this.now();
    await this.saveDetail(detail);

    return attachment;
  }

  async deleteAttachment(conversationId: string, attachmentId: string): Promise<ConversationDetail> {
    const detail = await this.loadDetail(conversationId);
    const attachment = detail.attachments.find((item) => item.id === attachmentId);
    if (!attachment) {
      throw new Error("附件不存在");
    }

    const pathsToDelete = [attachment.relative_path, attachment.text_relative_path];
    for (const relPath of pathsToDelete) {
      await this.deleteAgentRelativeFile(relPath);
    }

    detail.attachments = detail.attachments.filter((item) => item.id !== attachmentId);
    detail.updated_at = this.now();
    return this.saveDetail(detail);
  }

  async getAttachmentTexts(
    conversationId: string,
    attachmentIds?: string[],
    options: { limit?: number; preserveWhitespace?: boolean } = {}
  ): Promise<[ConversationAttachment, string][]> {
    const detail = await this.loadDetail(conversationId);
    const selected = new Set(attachmentIds || []);
    const outputs: [ConversationAttachment, string][] = [];

    for (const attachment of detail.attachments) {
      if (selected.size && !selected.has(attachment.id)) {
        continue;
      }
      const text = await this.readAttachmentText(attachment, options);
      outputs.push([attachment, text]);
    }
    return outputs;
  }

  private async readAttachmentText(
    attachment: ConversationAttachment,
    options: { limit?: number; preserveWhitespace?: boolean } = {}
  ): Promise<string> {
    const root = await this.agentRoot();
    const fullPath = path.join(root, attachment.text_relative_path);
    const limit = options.limit ?? 2400;
    try {
      const text = await fs.readFile(fullPath, "utf8");
      return options.preserveWhitespace ? clipText(text, limit) : excerpt(text, limit);
    } catch {
      return attachment.excerpt;
    }
  }

  private async extractAttachmentText(filePath: string, mediaType: string, content: Buffer): Promise<string> {
    const suffix = path.extname(filePath).toLowerCase();

    if ([".txt", ".md", ".markdown"].includes(suffix)) {
      const encodings = ["utf-8", "gb18030", "utf-16le", "utf-16be"];
      for (const encoding of encodings) {
        try {
          const decoder = new TextDecoder(encoding, { fatal: true });
          return decoder.decode(content);
        } catch {
          // skip
        }
      }
      return content.toString("utf8");
    }

    if (suffix === ".docx") {
      try {
        const zip = new AdmZip(content);
        const xml = zip.readAsText("word/document.xml", "utf8");
        const matches = xml.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g);
        const texts = Array.from(matches).map((m) => (m as RegExpExecArray)[1] || "");
        const result = texts.join("").trim();
        if (!result) {
          throw new Error("文档中没有可提取文字");
        }
        return result;
      } catch (err) {
        throw new Error(`DOCX 解析失败：${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (suffix === ".pdf") {
      try {
        const parser = new PDFParse({ data: content });
        try {
          const data = await parser.getText();
          const text = (data.text || "").trim();
          if (!text) {
            throw new Error("PDF 中没有可提取文字");
          }
          return text;
        } finally {
          await parser.destroy();
        }
      } catch (err) {
        throw new Error(`PDF 解析失败：${err instanceof Error ? err.message : String(err)}`);
      }
    }

    throw new Error(`暂不支持该文件类型：${suffix}`);
  }

  private guessMediaType(filename: string): string {
    const suffix = path.extname(filename).toLowerCase();
    if (suffix === ".pdf") {
      return "application/pdf";
    }
    if (suffix === ".docx") {
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    }
    if ([".md", ".markdown"].includes(suffix)) {
      return "text/markdown";
    }
    return "text/plain";
  }

  private async deleteAgentRelativeFile(relativePath: string): Promise<void> {
    if (!relativePath) {
      return;
    }
    const root = path.resolve(await this.agentRoot());
    const target = path.resolve(root, relativePath);
    if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
      throw new Error("附件路径越界");
    }
    await fs.rm(target, { force: true });
  }

  private async loadDetail(conversationId: string): Promise<ConversationDetail> {
    const filePath = await this.conversationPath(conversationId);
    if (!(await exists(filePath))) {
      throw new Error(conversationId);
    }
    try {
      return normalizeDetail(JSON.parse(await fs.readFile(filePath, "utf8")));
    } catch (error) {
      const backupPath = await this.conversationBackupPath(conversationId);
      if (!(await exists(backupPath))) {
        throw new Error(`对话文件损坏，且未找到备份：${conversationId}`);
      }
      try {
        const detail = normalizeDetail(JSON.parse(await fs.readFile(backupPath, "utf8")));
        await this.restoreDetailFromBackup(detail);
        return detail;
      } catch (backupError) {
        throw new Error(`对话文件和备份均损坏：${conversationId}`);
      }
    }
  }

  private async saveDetail(detail: ConversationDetail): Promise<ConversationDetail> {
    const normalized = normalizeDetail(detail);
    const filePath = await this.conversationPath(normalized.id);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    if (await exists(filePath)) {
      try {
        const current = await fs.readFile(filePath, "utf8");
        JSON.parse(current);
        await fs.writeFile(await this.conversationBackupPath(normalized.id), current, "utf8");
      } catch {
        // Match Python: skip backup if current file is already unreadable.
      }
    }
    const payload = `${JSON.stringify(normalized, null, 2)}\n`;
    const tmpPath = `${filePath}.tmp`;
    await fs.writeFile(tmpPath, payload, "utf8");
    await fs.rename(tmpPath, filePath);
    const backupPath = await this.conversationBackupPath(normalized.id);
    const backupTmpPath = `${backupPath}.tmp`;
    await fs.writeFile(backupTmpPath, payload, "utf8");
    await fs.rename(backupTmpPath, backupPath);
    return normalized;
  }

  private async restoreDetailFromBackup(detail: ConversationDetail): Promise<void> {
    const filePath = await this.conversationPath(detail.id);
    const tmpPath = `${filePath}.restore.tmp`;
    await fs.writeFile(tmpPath, `${JSON.stringify(normalizeDetail(detail), null, 2)}\n`, "utf8");
    await fs.rename(tmpPath, filePath);
  }

  private toSummary(detail: ConversationDetail): ConversationSummary {
    return {
      id: detail.id,
      title: detail.title,
      created_at: detail.created_at,
      updated_at: detail.updated_at,
      current_skill: detail.current_skill,
      current_agent: detail.current_agent,
      message_count: detail.messages.length,
      attachment_count: detail.attachments.length
    };
  }

  private async readProjectDocument(relativePath: string, limit: number): Promise<string> {
    if (this.readDocument) {
      return this.readDocument(relativePath, limit);
    }
    const root = this.projectRoot;
    const target = path.resolve(root, relativePath);
    if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
      throw new Error("项目文件路径越界");
    }
    return (await fs.readFile(target, "utf8")).slice(0, limit);
  }

  private async agentRoot(): Promise<string> {
    const dir = path.join(this.projectRoot, AGENT_DIR);
    await fs.mkdir(dir, { recursive: true });
    return dir;
  }

  private async conversationsDir(): Promise<string> {
    const dir = path.join(await this.agentRoot(), "conversations");
    await fs.mkdir(dir, { recursive: true });
    return dir;
  }

  private async attachmentsDir(conversationId: string): Promise<string> {
    const dir = path.join(await this.agentRoot(), "attachments", conversationId);
    await fs.mkdir(dir, { recursive: true });
    return dir;
  }

  private async conversationPath(conversationId: string): Promise<string> {
    return path.join(await this.conversationsDir(), `${conversationId}.json`);
  }

  private async conversationBackupPath(conversationId: string): Promise<string> {
    return path.join(await this.conversationsDir(), `${conversationId}.json.bak`);
  }

  async saveConversation(detail: ConversationDetail): Promise<ConversationDetail> {
    return this.saveDetail(detail);
  }
}

function normalizeDetail(value: unknown): ConversationDetail {
  const parsed = conversationDetailSchema.parse(value);
  return {
    ...parsed,
    message_count: parsed.messages.length,
    attachment_count: parsed.attachments.length
  };
}

function summarizeDeterministic(detail: ConversationDetail): string {
  const lines = detail.messages.slice(-12).map((message) => `${message.role}: ${excerpt(message.content, 180)}`);
  return lines.join("\n").trim();
}

function excerpt(text: string, limit: number): string {
  const normalized = (text || "").trim().replace(/\s+/g, " ");
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit)}...`;
}

function clipText(text: string, limit: number): string {
  const normalized = text || "";
  if (typeof limit !== "number" || limit < 0 || normalized.length <= limit) {
    return normalized;
  }
  return normalized.slice(0, limit);
}

function formatNow(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
