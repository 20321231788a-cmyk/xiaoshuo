import { ConversationService } from "@xiaoshuo/conversation-service";
import { DocumentService } from "@xiaoshuo/document-service";
import { GeneratedCacheService } from "@xiaoshuo/generated-cache";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GeneratedSavePlanner } from "../generated-save-planner.js";
import { DisassembleBookWorkflow } from "./disassemble-book.js";
import { readDisassembleBookManifest } from "./disassemble-library.js";
import { PromptSkillRunner } from "../skill-runner.js";
import type { WorkflowRunContext } from "./types.js";

let tempDir = "";
let configPath = "";

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "xiaoshuo-disassemble-book-workflow-"));
  configPath = path.join(tempDir, "studio_config.json");
  await fs.writeFile(configPath, JSON.stringify({ api_key: "demo-key", model: "demo-model" }), "utf8");
});

afterEach(async () => {
  if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
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
    webSearchClient: { search: async () => [] },
    documents,
    conversations,
    cache,
    savePlanner: new GeneratedSavePlanner({ projectRoot: tempDir, config, modelClient }),
    skillRunner: new PromptSkillRunner({ projectRoot: tempDir, config, modelClient })
  };
}

function fastBatchJson(prompt: string): string {
  const keyText = /chapter_summaries 必须且只能使用这些 chapter 键：([^\n]+)。/.exec(prompt)?.[1] || "chapter:1";
  const keys = keyText.split("、").map((key) => key.trim()).filter(Boolean);
  return JSON.stringify({
    chapter_summaries: keys.map((chapter) => ({ chapter, summary: `${chapter} 中主角面对冲突并推进阶段目标。` })),
    stage_summary: "阶段目标建立，冲突升级后取得阶段性进展。",
    protagonist_arc: ["身份：主角；目标：解决当前困境；能力：获得或运用已有能力；关系：与关键人物形成合作或对立；变化：从被动转向主动。"],
    major_characters: ["主角：身份为核心行动者；动机是解决当前困境；与主角关系：本人；剧情作用：推动主线。"],
    major_settings: ["世界规则：当前冲突受既有规则限制；首次作用：本批章节。"]
  });
}

function disassembleRequest(selection: string, extra: Record<string, unknown> = {}) {
  return {
    conversation_id: "disassemble-conversation",
    content: "请拆书",
    current_path: "",
    selection,
    project_context_hint: "",
    skill_id: "disassemble_book",
    attachment_ids: [],
    ...extra
  } as any;
}

describe("DisassembleBookWorkflow fast prefix chapters", () => {
  it("only creates one four-section report for a new fast disassembly", async () => {
    const workflow = new DisassembleBookWorkflow();
    const result = await workflow.runAgent(
      disassembleRequest("第1章 起点\n林默踏入宗门。\n第2章 冲突\n林默接受考验。"),
      createWorkflowContext({ requestCompletion: async (_config, messages) => fastBatchJson(messages.map((message) => message.content).join("\n")) })
    );
    const book = result.skill_result?.data?.book as { dir: string; paths: { report?: string; lore?: string; reverse_outline?: string } };
    const report = await fs.readFile(path.join(tempDir, book.paths.report || ""), "utf8");

    expect(result.saved_paths).toEqual([`${book.dir}/拆书报告.md`]);
    expect(book.paths.lore).toBe("");
    expect(book.paths.reverse_outline).toBe("");
    expect(report).toContain("## 前100章剧情");
    expect(report).toContain("## 主角成长弧光");
    expect(report).toContain("## 主要角色配置");
    expect(report).toContain("## 主要设定");
    expect(report).toContain("阶段总结");
    await expect(fs.readFile(path.join(tempDir, book.dir, "拆书设定提取.txt"), "utf8")).rejects.toThrow();
    await expect(fs.readFile(path.join(tempDir, book.dir, "反向细纲.txt"), "utf8")).rejects.toThrow();
  });

  it("submits only the first 100 recognised chapters and records the prefix-chapters scope", async () => {
    const source = Array.from({ length: 101 }, (_, index) => `第${index + 1}章 标题${index + 1}\n本章剧情标记${index + 1}`).join("\n");
    const prompts: string[] = [];
    const workflow = new DisassembleBookWorkflow();
    const result = await workflow.runAgent(disassembleRequest(source), createWorkflowContext({
      requestCompletion: async (_config, messages) => {
        const prompt = messages.map((message) => message.content).join("\n");
        prompts.push(prompt);
        return fastBatchJson(prompt);
      }
    }));
    const book = result.skill_result?.data?.book as { dir: string };
    const manifest = await readDisassembleBookManifest(book.dir, createWorkflowContext({ requestCompletion: async () => "unused" }));

    expect(manifest.analysis_scope).toMatchObject({
      mode: "prefix_chapters",
      requested_chapters: 100,
      actual_chapters: 100,
      first_chapter: 1,
      last_chapter: 100,
      source_chapters: 101,
      truncated: true
    });
    expect(manifest.coverage.analyzed_chapters).toHaveLength(100);
    expect(prompts.join("\n")).not.toContain("第101章");
  });

  it("uses clearly labelled sequential segments when the source has no chapter headings", async () => {
    const source = Array.from({ length: 120 }, (_, index) => `第${index + 1}段实际文本，没有任何章节标题。`).join("\n\n");
    const workflow = new DisassembleBookWorkflow();
    const result = await workflow.runAgent(disassembleRequest(source), createWorkflowContext({
      requestCompletion: async (_config, messages) => fastBatchJson(messages.map((message) => message.content).join("\n"))
    }));
    const book = result.skill_result?.data?.book as { dir: string; paths: { report?: string } };
    const report = await fs.readFile(path.join(tempDir, book.paths.report || ""), "utf8");
    const manifest = await readDisassembleBookManifest(book.dir, createWorkflowContext({ requestCompletion: async () => "unused" }));

    expect(manifest.analysis_scope).toMatchObject({ mode: "prefix_chapters", actual_chapters: 100, source_chapters: 0, truncated: true });
    expect(report).toContain("无章节标题，按顺序段落");
    expect(report).toContain("第1段：");
    expect(report).not.toContain("第101段：");
  });

  it("counts titled prologues and extras as chapter units", async () => {
    const workflow = new DisassembleBookWorkflow();
    const result = await workflow.runAgent(disassembleRequest("序章 雨夜\n主角离开故乡。\n第1章 入门\n主角进入宗门。\n番外 同行者\n同伴补充经历。"), createWorkflowContext({
      requestCompletion: async (_config, messages) => fastBatchJson(messages.map((message) => message.content).join("\n"))
    }));
    const book = result.skill_result?.data?.book as { dir: string; paths: { report?: string } };
    const report = await fs.readFile(path.join(tempDir, book.paths.report || ""), "utf8");
    const manifest = await readDisassembleBookManifest(book.dir, createWorkflowContext({ requestCompletion: async () => "unused" }));

    expect(manifest.analysis_scope).toMatchObject({ actual_chapters: 3, source_chapters: 3 });
    expect(report).toContain("序章 雨夜：");
    expect(report).toContain("番外 同行者：");
  });

  it("retries a transient batch once and saves the completed checkpoint", async () => {
    let attempts = 0;
    const workflow = new DisassembleBookWorkflow();
    const result = await workflow.runAgent(disassembleRequest("第1章 起点\n林默踏入宗门。"), createWorkflowContext({
      requestCompletion: async (_config, messages) => {
        attempts += 1;
        if (attempts === 1) throw new Error("ECONNRESET");
        return fastBatchJson(messages.map((message) => message.content).join("\n"));
      }
    }));
    expect(attempts).toBe(2);
    expect(result.saved_paths).toHaveLength(1);
  });

  it("uses at most four simultaneous model batches", async () => {
    const source = Array.from({ length: 24 }, (_, index) => `第${index + 1}章 标题\n${"剧情".repeat(4_000)}`).join("\n");
    let inFlight = 0;
    let maxInFlight = 0;
    const workflow = new DisassembleBookWorkflow();
    await workflow.runAgent(disassembleRequest(source), createWorkflowContext({
      requestCompletion: async (_config, messages) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 8));
        inFlight -= 1;
        return fastBatchJson(messages.map((message) => message.content).join("\n"));
      }
    }));
    expect(maxInFlight).toBeGreaterThan(1);
    expect(maxInFlight).toBeLessThanOrEqual(4);
  });

  it("marks a permanently invalid batch as failed without creating a report", async () => {
    const workflow = new DisassembleBookWorkflow();
    const context = createWorkflowContext({ requestCompletion: async () => "not json" });
    await expect(workflow.runAgent(disassembleRequest("第1章 起点\n林默踏入宗门。"), context)).rejects.toThrow("拆书第 1/1 批失败");
    const books = await fs.readdir(path.join(tempDir, "00_设定集", "拆书库"));
    expect(books).toHaveLength(1);
    const manifest = await readDisassembleBookManifest(`00_设定集/拆书库/${books[0]}`, context);
    expect(manifest.status).toBe("failed");
    expect(manifest.paths.report || "").toBe("");
  });
});
