import { ConversationService } from "@xiaoshuo/conversation-service";
import { DocumentService } from "@xiaoshuo/document-service";
import { GeneratedCacheService } from "@xiaoshuo/generated-cache";
import type { ChatCompletionMessage } from "@xiaoshuo/model-client";
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

  it("falls back safely when model output is not JSON", () => {
    expect(parseConsistencyCheckResult("not json", "primary-fallback")).toEqual({
      score: 0,
      risks: [],
      reason: "not json",
      model_line: "primary-fallback"
    });
  });
});
