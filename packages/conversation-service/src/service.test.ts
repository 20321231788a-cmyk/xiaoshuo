import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import AdmZip from "adm-zip";
import { AGENT_DIR, ConversationService } from "./service.js";

let tempDir = "";
let idCounter = 0;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "xiaoshuo-conversation-service-"));
  idCounter = 0;
});

afterEach(async () => {
  if (tempDir) {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

function service(now = "2026-05-30 16:00:00") {
  return new ConversationService({
    projectRoot: tempDir,
    idFactory: () => `id_${++idCounter}`,
    now: () => now
  });
}

function conversationFile(id: string) {
  return path.join(tempDir, AGENT_DIR, "conversations", `${id}.json`);
}

describe("conversation-service", () => {
  it("creates conversations with Python-compatible defaults and backup files", async () => {
    const conversations = service();

    const detail = await conversations.createConversation({ skill_id: "draft", agent_name: "agent" });
    const raw = JSON.parse(await fs.readFile(conversationFile(detail.id), "utf8"));
    const backup = JSON.parse(await fs.readFile(`${conversationFile(detail.id)}.bak`, "utf8"));

    expect(detail).toMatchObject({
      id: "id_1",
      title: "新对话",
      current_skill: "draft",
      current_agent: "agent",
      summary: "",
      message_count: 0,
      attachment_count: 0
    });
    expect(raw.id).toBe("id_1");
    expect(backup.id).toBe("id_1");
  });

  it("lists summaries by file mtime and skips broken entries", async () => {
    const conversations = service();
    const first = await conversations.createConversation({ title: "first" });
    const second = await conversations.createConversation({ title: "second" });
    await fs.writeFile(conversationFile("broken"), "{not-json", "utf8");

    const list = await conversations.listConversations();

    expect(list.map((item) => item.id)).toEqual([second.id, first.id]);
    expect(list[0]).toMatchObject({ title: "second", message_count: 0, attachment_count: 0 });
  });

  it("renames conversations and truncates titles to 80 characters", async () => {
    const conversations = service();
    const detail = await conversations.createConversation();

    const renamed = await conversations.renameConversation(detail.id, " 标题 ".repeat(40));

    expect(renamed.title).toHaveLength(80);
    await expect(conversations.renameConversation(detail.id, "  ")).rejects.toThrow("对话标题不能为空");
  });

  it("appends valid messages and rejects empty content or invalid roles", async () => {
    const conversations = service();
    const detail = await conversations.createConversation();

    const updated = await conversations.appendMessage(detail.id, {
      role: "user",
      content: "  你好  ",
      metadata: { source: "test" }
    });

    expect(updated.messages).toHaveLength(1);
    expect(updated.messages[0]).toMatchObject({ id: "id_2", role: "user", content: "你好", metadata: { source: "test" } });
    expect(updated.message_count).toBe(1);
    await expect(conversations.appendMessage(detail.id, { role: "assistant", content: "   " })).rejects.toThrow("消息内容不能为空");
    await expect(conversations.appendMessage(detail.id, { role: "tool" as any, content: "x" })).rejects.toThrow("消息角色无效");
  });

  it("pins text and document context, then removes it", async () => {
    await fs.mkdir(path.join(tempDir, "01_大纲"), { recursive: true });
    await fs.writeFile(path.join(tempDir, "01_大纲", "大纲.txt"), "这是 文档\n\n内容", "utf8");
    const conversations = service();
    const detail = await conversations.createConversation();

    const withText = await conversations.pinContext(detail.id, { kind: "text", content: " 固定 文本 ", label: "" });
    const withDocument = await conversations.pinContext(detail.id, { kind: "document", path: "01_大纲/大纲.txt" });

    expect(withText.pinned_context[0]).toMatchObject({ kind: "text", label: "固定上下文", content_excerpt: "固定 文本" });
    expect(withDocument.pinned_context[1]).toMatchObject({ kind: "document", label: "大纲.txt", content_excerpt: "这是 文档 内容" });

    const removed = await conversations.removePinnedContext(detail.id, withDocument.pinned_context[0]!.id);
    expect(removed.pinned_context).toHaveLength(1);
    const cleared = await conversations.clearPinnedContext(detail.id);
    expect(cleared.pinned_context).toHaveLength(0);
  });

  it("summarizes deterministically from the latest messages", async () => {
    const conversations = service();
    const detail = await conversations.createConversation();
    for (let index = 0; index < 14; index += 1) {
      await conversations.appendMessage(detail.id, { role: index % 2 ? "assistant" : "user", content: `message ${index}` });
    }

    const summarized = await conversations.summarizeConversation(detail.id);

    expect(summarized.summary).toContain("user: message 2");
    expect(summarized.summary.split("\n")).not.toContain("assistant: message 1");
    expect(summarized.summary).toContain("assistant: message 13");
  });

  it("restores from backup when the main conversation file is corrupted", async () => {
    const conversations = service();
    const detail = await conversations.createConversation({ title: "backup me" });
    await conversations.appendMessage(detail.id, { role: "user", content: "before corruption" });
    await fs.writeFile(conversationFile(detail.id), "{broken", "utf8");

    const restored = await conversations.getConversation(detail.id);
    const restoredText = await fs.readFile(conversationFile(detail.id), "utf8");

    expect(restored.title).toBe("backup me");
    expect(restored.messages[0]?.content).toBe("before corruption");
    expect(JSON.parse(restoredText).id).toBe(detail.id);
  });

  it("adds text and mocked docx attachments, extracts contents, and deletes them safely", async () => {
    const conversations = service();
    const detail = await conversations.createConversation();

    // 1. Text attachment
    const txtAttachment = await conversations.addAttachment(
      detail.id,
      "test.txt",
      "text/plain",
      Buffer.from("测试文本内容", "utf8")
    );
    expect(txtAttachment).toMatchObject({
      name: "test.txt",
      media_type: "text/plain",
      size: 18,
      excerpt: "测试文本内容"
    });

    const originalTxtPath = path.join(tempDir, AGENT_DIR, txtAttachment.relative_path);
    const textTxtPath = path.join(tempDir, AGENT_DIR, txtAttachment.text_relative_path);
    expect(await fs.readFile(originalTxtPath, "utf8")).toBe("测试文本内容");
    expect(await fs.readFile(textTxtPath, "utf8")).toBe("测试文本内容");

    const longText = `第一章\n${"甲".repeat(70000)}`;
    const longAttachment = await conversations.addAttachment(
      detail.id,
      "long.txt",
      "text/plain",
      Buffer.from(longText, "utf8")
    );
    const defaultText = await conversations.getAttachmentTexts(detail.id, [longAttachment.id]);
    expect(defaultText[0]?.[1].length).toBeLessThan(3000);
    const importedText = await conversations.getAttachmentTexts(detail.id, [longAttachment.id], {
      limit: 60000,
      preserveWhitespace: true
    });
    expect(importedText[0]?.[1]).toHaveLength(60000);
    expect(importedText[0]?.[1]).toContain("第一章\n");

    // 2. Docx attachment (mocked in-memory zip)
    const mockZip = new AdmZip();
    mockZip.addFile(
      "word/document.xml",
      Buffer.from('<?xml version="1.0"?><w:document xmlns:w="main"><w:t>伪造的DOCX正文</w:t></w:document>', "utf8")
    );
    const docxBuffer = mockZip.toBuffer();

    const docxAttachment = await conversations.addAttachment(
      detail.id,
      "test.docx",
      "",
      docxBuffer
    );
    expect(docxAttachment.media_type).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    expect(docxAttachment.excerpt).toBe("伪造的DOCX正文");

    const textDocxPath = path.join(tempDir, AGENT_DIR, docxAttachment.text_relative_path);
    expect(await fs.readFile(textDocxPath, "utf8")).toBe("伪造的DOCX正文");

    // 3. Delete attachment
    const updated = await conversations.deleteAttachment(detail.id, txtAttachment.id);
    expect(updated.attachments).toHaveLength(2);
    expect(updated.attachment_count).toBe(2);

    // Verify physical files are unlinked
    await expect(fs.access(originalTxtPath)).rejects.toThrow();
    await expect(fs.access(textTxtPath)).rejects.toThrow();
  });

  it("prevents path traversal directory escapes on attachment deletion", async () => {
    const conversations = service();
    const detail = await conversations.createConversation();

    // Create a fake attachment with path traversal relative paths
    const attachment = await conversations.addAttachment(
      detail.id,
      "test.txt",
      "text/plain",
      Buffer.from("safe", "utf8")
    );

    // Inject traversal path into metadata
    attachment.relative_path = "../../../sensitive_file.txt";
    // We reload and modify to make sure it exists
    const loaded = await conversations.getConversation(detail.id);
    loaded.attachments[0]!.relative_path = "../../../sensitive_file.txt";
    // Directly save modified
    await fs.writeFile(
      path.join(tempDir, AGENT_DIR, "conversations", `${detail.id}.json`),
      JSON.stringify(loaded),
      "utf8"
    );

    await expect(conversations.deleteAttachment(detail.id, attachment.id)).rejects.toThrow("附件路径越界");
  });

  it("updates conversation summary explicitly", async () => {
    const conversations = service();
    const detail = await conversations.createConversation();
    expect(detail.summary).toBe("");

    const updated = await conversations.updateConversationSummary(detail.id, " 这是一条 AI 摘要 ");
    expect(updated.summary).toBe("这是一条 AI 摘要");

    const reloaded = await conversations.getConversation(detail.id);
    expect(reloaded.summary).toBe("这是一条 AI 摘要");
  });
});
