import { ConversationService } from "@xiaoshuo/conversation-service";
import { DocumentService } from "@xiaoshuo/document-service";
import { GeneratedCacheService } from "@xiaoshuo/generated-cache";
import type { ChatCompletionMessage } from "@xiaoshuo/model-client";
import { VectorDb } from "@xiaoshuo/vector-service";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GeneratedSavePlanner } from "../generated-save-planner.js";
import { parseConsistencyCheckResult } from "../prompts/consistency.js";
import { PromptSkillRunner } from "../skill-runner.js";
import { ConsistencyCheckWorkflow } from "./consistency-check.js";
import type { WorkflowRunContext } from "./types.js";

let tempDir = "";
let configPath = "";

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "xiaoshuo-consistency-workflow-"));
  configPath = path.join(tempDir, "studio_config.json");
  await fs.mkdir(path.join(tempDir, "01_大纲"), { recursive: true });
  await fs.mkdir(path.join(tempDir, "00_设定集", "风格库"), { recursive: true });
  await fs.mkdir(path.join(tempDir, "00_设定集", "题材库"), { recursive: true });
  await fs.mkdir(path.join(tempDir, "02_正文"), { recursive: true });
  await fs.writeFile(configPath, JSON.stringify({ api_key: "demo-key", model: "demo-model" }), "utf8");
  await fs.writeFile(path.join(tempDir, "01_大纲", "章纲.txt"), "第1章：宗门大比前夜，林默必须隐藏底牌。", "utf8");
  await fs.writeFile(path.join(tempDir, "00_设定集", "风格库", "写作风格.txt"), "克制冷静", "utf8");
  await fs.writeFile(path.join(tempDir, "00_设定集", "题材库", "题材规则.txt"), "升级流", "utf8");
});

afterEach(async () => {
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

function seedConfirmedGraphClaim(input: { entityName: string; objectText: string; sourcePath: string }): void {
  const db = new VectorDb(tempDir);
  try {
    db.init();
    const now = Date.now();
    const entityId = `character:${input.entityName}`;
    db.db.prepare(`
      INSERT INTO graph_entities(entity_id, name, type, description, source_path, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(entityId, input.entityName, "character", input.objectText, input.sourcePath, "confirmed", now, now);
    db.db.prepare(`
      INSERT INTO graph_claims(subject_entity_id, predicate, object_text, source_path, source_type, chapter_number, status, confidence, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(entityId, "profile", input.objectText, input.sourcePath, "lore", null, "confirmed", 1, now, now);
  } finally {
    db.close();
  }
}

describe("ConsistencyCheckWorkflow", () => {
  it("checks draft consistency and records a skill exchange", async () => {
    let capturedMessages: ChatCompletionMessage[] = [];
    const workflow = new ConsistencyCheckWorkflow();
    const context = createWorkflowContext({
      requestCompletion: async (_config, messages) => {
        capturedMessages = messages;
        return JSON.stringify({ score: 82, risks: ["人物动机略弱"], reason: "整体连续性基本成立" });
      }
    });

    const result = await workflow.runAgent(
      {
        conversation_id: "",
        content: "做一次一致性检查",
        current_path: "",
        selection: "林默在宗门大比前突然改变了原定策略。",
        project_context_hint: "",
        skill_id: "consistency_check",
        attachment_ids: []
      },
      context
    );

    expect(capturedMessages.at(-1)?.content).toContain("【待审查正文】");
    expect(capturedMessages.at(-1)?.content).toContain("林默在宗门大比前突然改变了原定策略");
    expect(capturedMessages.at(-1)?.content).toContain("【章纲】");
    expect(result.skill_result?.data).toMatchObject({
      score: 82,
      risks: ["人物动机略弱"],
      reason: "整体连续性基本成立",
      model_line: "primary-fallback"
    });
    expect(result.conversation?.messages.at(-1)?.metadata.intent).toBe("skill");
  });

  it("adds GraphMemory advisory fields without changing the model score", async () => {
    seedConfirmedGraphClaim({
      entityName: "林默",
      objectText: "青云宗大弟子",
      sourcePath: "00_设定集/设定库/角色设定.md"
    });
    const workflow = new ConsistencyCheckWorkflow();
    const context = createWorkflowContext({
      requestCompletion: async () => JSON.stringify({ score: 91, risks: ["模型风险"], reason: "模型检查通过" })
    });

    const result = await workflow.runAgent(
      {
        conversation_id: "",
        content: "做一次一致性检查",
        current_path: "",
        selection: "林默不是青云宗大弟子，他另有身份。",
        project_context_hint: "",
        skill_id: "consistency_check",
        attachment_ids: []
      },
      context
    );

    expect(result.skill_result?.data).toMatchObject({
      score: 91,
      risks: ["模型风险"],
      reason: "模型检查通过",
      graph_status: "ok",
      graph_score: 75,
      graph_risks: ["Found 1 draft statement(s) that conflict with confirmed graph claims."],
      blocking_claims: [
        expect.objectContaining({
          claim: expect.stringContaining("青云宗大弟子"),
          source_path: "00_设定集/设定库/角色设定.md"
        })
      ]
    });
    expect(result.skill_result?.result).toContain('"graph_score": 75');
  });

  it("keeps consistency_check successful when GraphMemory is unavailable", async () => {
    await fs.writeFile(path.join(tempDir, "00_设定集", ".agent"), "not a directory", "utf8");
    const workflow = new ConsistencyCheckWorkflow();
    const context = createWorkflowContext({
      requestCompletion: async () => JSON.stringify({ score: 88, risks: [], reason: "模型检查通过" })
    });

    const result = await workflow.runAgent(
      {
        conversation_id: "",
        content: "做一次一致性检查",
        current_path: "",
        selection: "林默在宗门大比前突然改变了原定策略。",
        project_context_hint: "",
        skill_id: "consistency_check",
        attachment_ids: [],
        suppress_conversation_record: true
      } as any,
      context
    );

    expect(result.skill_result?.data).toMatchObject({
      score: 88,
      risks: [],
      reason: "模型检查通过",
      graph_status: "unavailable"
    });
    expect(String((result.skill_result?.data as any).graph_error || "")).not.toHaveLength(0);
  });

  it("falls back safely when model output is not JSON", () => {
    expect(parseConsistencyCheckResult("not json", "primary-fallback")).toEqual({
      score: 0,
      risks: [],
      reason: "not json",
      model_line: "primary-fallback"
    });
  });
});
