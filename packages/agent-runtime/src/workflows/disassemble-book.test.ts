import { ConversationService } from "@xiaoshuo/conversation-service";
import { DocumentService } from "@xiaoshuo/document-service";
import { GeneratedCacheService } from "@xiaoshuo/generated-cache";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GeneratedSavePlanner } from "../generated-save-planner.js";
import { AgentRuntimeService, closeAllAgentRuntimeServices } from "../runtime.js";
import { PromptSkillRunner } from "../skill-runner.js";
import { DisassembleBookWorkflow } from "./disassemble-book.js";
import type { WorkflowRunContext } from "./types.js";

let tempDir = "";
let configPath = "";

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "xiaoshuo-disassemble-book-workflow-"));
  configPath = path.join(tempDir, "studio_config.json");
  await fs.writeFile(configPath, JSON.stringify({ api_key: "demo-key", model: "demo-model" }), "utf8");
});

afterEach(async () => {
  closeAllAgentRuntimeServices();
  if (tempDir) {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

function createWorkflowContext(modelClient: WorkflowRunContext["modelClient"]): WorkflowRunContext {
  const documents = new DocumentService({ projectRoot: tempDir });
  const conversations = new ConversationService({ projectRoot: tempDir });
  const config = { configPath };
  const cache = new GeneratedCacheService({ projectRoot: tempDir, documentService: documents });
  return {
    projectRoot: tempDir,
    config,
    modelClient,
    webSearchClient: {
      search: async () => []
    },
    documents,
    conversations,
    cache,
    savePlanner: new GeneratedSavePlanner({ projectRoot: tempDir, config, modelClient }),
    skillRunner: new PromptSkillRunner({ projectRoot: tempDir, config, modelClient })
  };
}

describe("DisassembleBookWorkflow", () => {
  it("writes lore and reverse outline files into a new book directory", async () => {
    const responses = ["【人物设定】\n林默：主角，出身寒门。", "第一章：林默入宗门。"];
    const prompts: string[] = [];
    const workflow = new DisassembleBookWorkflow();
    const result = await workflow.runAgent(
      {
        conversation_id: "",
        content: "请拆书",
        current_path: "",
        selection: "林默从寒门少年一路成长为宗门天骄。",
        project_context_hint: "",
        skill_id: "disassemble_book",
        attachment_ids: []
      },
      createWorkflowContext({
        requestCompletion: async (_config, messages) => {
          prompts.push(messages.map((message) => message.content).join("\n"));
          return responses.shift() || "";
        }
      })
    );
    const book = result.skill_result?.data?.book as { dir?: string; title?: string; paths?: { lore?: string; reverse_outline?: string } } | undefined;
    const title = book?.title || "当前拆书书籍";
    const loreText = await fs.readFile(path.join(tempDir, book?.dir || "", "拆书设定提取.txt"), "utf8");
    const reverseText = await fs.readFile(path.join(tempDir, book?.dir || "", "反向细纲.txt"), "utf8");

    expect(result.intent).toBe("skill");
    expect(book?.dir).toContain("00_设定集/拆书库/");
    expect(result.saved_paths).toEqual([`${book?.dir}/拆书设定提取.txt`, `${book?.dir}/反向细纲.txt`]);
    expect(book?.paths?.lore).toBe(`${book?.dir}/拆书设定提取.txt`);
    expect(book?.paths?.reverse_outline).toBe(`${book?.dir}/反向细纲.txt`);
    expect(await fs.readFile(path.join(tempDir, "00_设定集", "设定集", "拆书设定提取.txt"), "utf8")).toContain("林默");
    expect(await fs.readFile(path.join(tempDir, "01_大纲", "反向细纲.txt"), "utf8")).toContain("第一章");
    expect(loreText).toContain(`# 《${title}》拆书设定提取`);
    expect(loreText).toContain("## 人物设定");
    expect(loreText).toContain("## 伏笔与可复用素材");
    expect(reverseText).toContain(`# 《${title}》详细剧情发展`);
    expect(reverseText).toContain("## 逐章速览");
    expect(reverseText).toContain("## 大事件拆解");
    expect(prompts[0]).toContain(`文件首行必须是：# 《${title}》拆书设定提取`);
    expect(prompts[1]).toContain(`文件首行必须是：# 《${title}》详细剧情发展`);
  });

  it("imports long disassemble source text beyond the previous 60000 character cap", async () => {
    const longSource = `${"甲".repeat(90_000)}超过旧上限标记${"乙".repeat(30_000)}`;
    const sourcePath = path.join(tempDir, "02_正文", "长原文.txt");
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.writeFile(sourcePath, longSource, "utf8");

    const workflow = new DisassembleBookWorkflow();
    const result = await workflow.runAgent(
      {
        conversation_id: "",
        content: "请拆书",
        current_path: "02_正文/长原文.txt",
        selection: "",
        project_context_hint: "",
        skill_id: "disassemble_book",
        attachment_ids: []
      },
      createWorkflowContext({
        requestCompletion: async () => "原文未明确。"
      })
    );
    const book = result.skill_result?.data?.book as { dir?: string } | undefined;
    const archived = await fs.readFile(path.join(tempDir, book?.dir || "", "原文.txt"), "utf8");

    expect(archived).toContain("超过旧上限标记");
    expect(archived.length).toBeGreaterThan(100_000);
  });

  it("lists existing disassemble books", async () => {
    const bookDir = path.join(tempDir, "00_设定集", "拆书库", "书A-20260609120000-abcd1234");
    await fs.mkdir(bookDir, { recursive: true });
    await fs.writeFile(
      path.join(bookDir, "manifest.jsonl"),
      JSON.stringify({
        id: "书A-20260609120000-abcd1234",
        title: "书A",
        dir: "00_设定集/拆书库/书A-20260609120000-abcd1234",
        created_at: "2026-06-09T12:00:00.000Z",
        updated_at: "2026-06-09T12:00:00.000Z",
        origin: "document",
        source_path: "01_大纲/大纲.txt",
        source_summary: "测试书A",
        chars: 12,
        paths: { source: "00_设定集/拆书库/书A-20260609120000-abcd1234/原文.txt" }
      }) + "\n",
      "utf8"
    );

    const workflow = new DisassembleBookWorkflow();
    const result = await workflow.runAgent(
      {
        conversation_id: "",
        content: "",
        current_path: "",
        selection: "",
        project_context_hint: "",
        skill_id: "disassemble_book",
        attachment_ids: [],
        action: "list_library"
      } as any,
      createWorkflowContext({ requestCompletion: async () => "unused" })
    );

    expect(result.skill_result?.data?.books).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "书A-20260609120000-abcd1234",
          title: "书A"
        })
      ])
    );
  });

  it("archives source text and is used by AgentRuntimeService.runAgent", async () => {
    const runtime = new AgentRuntimeService({
      projectRoot: tempDir,
      config: { configPath },
      modelClient: { requestCompletion: async () => "unused" }
    });

    const result = await runtime.runAgent({
      conversation_id: "",
      content: "归档原文",
      current_path: "",
      selection: "归档的拆书原文",
      project_context_hint: "",
      skill_id: "disassemble_book",
      attachment_ids: [],
      action: "archive_source",
      book_title: "归档书籍"
    } as any);

    const book = result.skill_result?.data?.book as { dir?: string; title?: string } | undefined;
    expect(book?.title).toBe("归档书籍");
    expect(result.saved_paths).toEqual([`${book?.dir}/原文.txt`]);
    expect(await fs.readFile(path.join(tempDir, book?.dir || "", "原文.txt"), "utf8")).toContain("归档的拆书原文");
  });
});
