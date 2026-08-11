import { ConversationService } from "@xiaoshuo/conversation-service";
import { DocumentService } from "@xiaoshuo/document-service";
import { GeneratedCacheService } from "@xiaoshuo/generated-cache";
import { GraphMemory, VectorDb } from "@xiaoshuo/vector-service";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GeneratedSavePlanner } from "../generated-save-planner.js";
import { PromptSkillRunner } from "../skill-runner.js";
import { BodyGenerateWorkflow } from "./body-generate.js";
import type { WorkflowRunContext } from "./types.js";

let tempDir = "";
let configPath = "";

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "xiaoshuo-body-workflow-"));
  configPath = path.join(tempDir, "studio_config.json");
  await fs.mkdir(path.join(tempDir, "01_大纲"), { recursive: true });
  await fs.mkdir(path.join(tempDir, "02_正文"), { recursive: true });
  await fs.mkdir(path.join(tempDir, "00_设定集", "风格库"), { recursive: true });
  await fs.mkdir(path.join(tempDir, "00_设定集", "题材库"), { recursive: true });
  await fs.writeFile(path.join(tempDir, "studio_config.json"), JSON.stringify({ api_key: "demo-key", model: "demo-model" }), "utf8");
  await fs.writeFile(path.join(tempDir, "01_大纲", "章纲.txt"), "第001章：林默进入宗门，发现外门试炼即将开启。", "utf8");
  await fs.writeFile(path.join(tempDir, "00_设定集", "风格库", "写作风格.txt"), "克制冷静", "utf8");
  await fs.writeFile(path.join(tempDir, "00_设定集", "题材库", "题材规则.txt"), "升级流", "utf8");
});

afterEach(async () => {
  if (tempDir) {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

function createWorkflowContext(responses: string[]): WorkflowRunContext {
  const documents = new DocumentService({ projectRoot: tempDir });
  const conversations = new ConversationService({ projectRoot: tempDir });
  const config = { configPath };
  const modelClient = {
    requestCompletion: async () => responses.shift() || ""
  };
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

function seedLoreGraph(pathName: string, text: string): void {
  const db = new VectorDb(tempDir);
  db.init();
  try {
    db.db.prepare(`
      INSERT INTO chunks(path, source_type, title, chunk_index, start_char, end_char, text, text_hash, mtime)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(pathName, "lore", "角色设定", 0, 0, text.length, text, `${pathName}:${text.length}`, Date.now());
  } finally {
    db.close();
  }
  const memory = new GraphMemory(tempDir);
  try {
    memory.rebuild();
  } finally {
    memory.close();
  }
}

describe("BodyGenerateWorkflow", () => {
  it("returns pending-save metadata when write intent is absent", async () => {
    const workflow = new BodyGenerateWorkflow();
    const context = createWorkflowContext([
      "林默推开山门，晨雾顺着石阶往下淌。",
      JSON.stringify({ score: 90, risks: [], reason: "通过" }),
      "林默推开山门，晨雾顺着石阶往下淌，肩上的旧包裹被山风掀起一角。"
    ]);

    const result = await workflow.runAgent(
      {
        conversation_id: "",
        content: "生成第1章正文，约2500字",
        current_path: "",
        selection: "",
        project_context_hint: "",
        skill_id: "body_generate",
        attachment_ids: []
      },
      context
    );

    expect(result.saved_paths).toEqual([]);
    expect(result.skill_result?.data).toMatchObject({
      skill_id: "body_generate",
      chapter: 1,
      target_path: "02_正文/第001章.txt",
      pending_save: true,
      score: 90,
      risks: [],
      deslopped: true
    });
  });

  it("commits the generated chapter when write intent is explicit", async () => {
    const workflow = new BodyGenerateWorkflow();
    const context = createWorkflowContext([
      "林默沿着石阶一步步向上，听见晨钟在群山间回荡。",
      JSON.stringify({ score: 88, risks: [], reason: "通过" }),
      "林默沿着石阶一步步向上，听见晨钟在群山间回荡，指尖不自觉攥紧了衣角。"
    ]);

    const result = await workflow.runAgent(
      {
        conversation_id: "",
        content: "生成第1章正文并写入文件",
        current_path: "",
        selection: "",
        project_context_hint: "",
        skill_id: "body_generate",
        attachment_ids: []
      },
      context
    );

    expect(result.saved_paths).toEqual(["02_正文/第001章.txt"]);
    expect(result.skill_result?.data).toMatchObject({
      score: 88,
      saved_paths: ["02_正文/第001章.txt"],
      deslopped: true
    });
    expect(await fs.readFile(path.join(tempDir, "02_正文", "第001章.txt"), "utf8")).toContain("林默沿着石阶一步步向上");
  });

  it("revises when GraphMemory reports blocking claims", async () => {
    seedLoreGraph("00_设定集/设定库/角色设定.md", "### 林默\n青云宗弟子，沉默寡言。");

    const workflow = new BodyGenerateWorkflow();
    const context = createWorkflowContext([
      "林默不是青云宗弟子，只是路过山门的散修。",
      JSON.stringify({ score: 95, risks: [], reason: "模型审稿通过" }),
      "【修正后正文】\n林默作为青云宗弟子推开山门。\n【修正原因日志】\n保留已确认图谱事实。",
      "林默作为青云宗弟子推开山门。"
    ]);

    const result = await workflow.runAgent(
      {
        conversation_id: "",
        content: "生成第1章正文，约2500字",
        current_path: "",
        selection: "",
        project_context_hint: "",
        skill_id: "body_generate",
        attachment_ids: []
      },
      context
    );

    expect(result.skill_result?.data).toMatchObject({
      revised: true,
      graph_score: 75
    });
    expect(result.skill_result?.data?.risks).toEqual(expect.arrayContaining([expect.stringContaining("Graph blocking claim")]));
    expect(result.skill_result?.data?.graph_blocking_claims).toEqual([
      expect.objectContaining({
        source_path: "00_设定集/设定库/角色设定.md"
      })
    ]);
    expect(result.reply).toContain("林默作为青云宗弟子");
  });
});
