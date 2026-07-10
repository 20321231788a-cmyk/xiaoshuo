import { ConversationService } from "@xiaoshuo/conversation-service";
import { DocumentService } from "@xiaoshuo/document-service";
import { GeneratedCacheService } from "@xiaoshuo/generated-cache";
import type { ChatCompletionMessage } from "@xiaoshuo/model-client";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GeneratedSavePlanner } from "../generated-save-planner.js";
import { AgentRuntimeService, closeAllAgentRuntimeServices } from "../runtime.js";
import { PromptSkillRunner } from "../skill-runner.js";
import { NuwaStyleDistillWorkflow } from "./nuwa-style-distill.js";
import type { WorkflowRunContext } from "./types.js";

let tempDir = "";
let configPath = "";

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "xiaoshuo-nuwa-workflow-"));
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

describe("NuwaStyleDistillWorkflow", () => {
  it("distills style, reports status, and toggles the profile", async () => {
    let capturedMessages: ChatCompletionMessage[] = [];
    const workflow = new NuwaStyleDistillWorkflow();
    const context = createWorkflowContext({
      requestCompletion: async (_config, messages) => {
        capturedMessages = messages;
        return "表达DNA：短句冷峻。\n可操作规则：少解释，多动作。";
      }
    });

    const distill = await workflow.runSkill(
      {
        text: "林默站在雨里，没有回头。",
        chapter: 0,
        end_chapter: 0,
        target_words: 2500,
        instruction: "蒸馏文风",
        target_path: "",
        conversation_id: "",
        source_path: "参考书.txt",
        write_result: true,
        attachment_ids: [],
        book_title: "参考书"
      } as any,
      context
    );

    expect(capturedMessages.at(-1)?.content).toContain("【待蒸馏文本】");
    expect(distill.saved_path).toBe("00_设定集/.agent/style_distillation/current.json");
    expect(distill.data.profile).toMatchObject({
      book_title: "参考书",
      enabled: true,
      profile_text: "表达DNA：短句冷峻。\n可操作规则：少解释，多动作。"
    });

    const status = await workflow.runSkill(
      {
        text: "",
        chapter: 0,
        end_chapter: 0,
        target_words: 2500,
        instruction: "",
        target_path: "",
        conversation_id: "",
        source_path: "",
        write_result: false,
        attachment_ids: [],
        action: "status"
      } as any,
      context
    );
    expect(status.data.profile).toMatchObject({ book_title: "参考书", enabled: true });

    const toggled = await workflow.runSkill(
      {
        text: "",
        chapter: 0,
        end_chapter: 0,
        target_words: 2500,
        instruction: "",
        target_path: "",
        conversation_id: "",
        source_path: "",
        write_result: false,
        attachment_ids: [],
        action: "toggle",
        enabled: false
      } as any,
      context
    );
    expect(toggled.data.profile).toMatchObject({ book_title: "参考书", enabled: false });
  });

  it("is used by AgentRuntimeService.runSkill", async () => {
    const runtime = new AgentRuntimeService({
      projectRoot: tempDir,
      config: { configPath },
      modelClient: {
        requestCompletion: async () => "表达DNA：干净利落。"
      }
    });

    const result = await runtime.runSkill("nuwa_style_distill", {
      text: "她合上伞，雨声停在门外。",
      chapter: 0,
      end_chapter: 0,
      target_words: 2500,
      instruction: "蒸馏文风",
      target_path: "",
      conversation_id: "",
      source_path: "样本文档.txt",
      write_result: true,
      attachment_ids: [],
      book_title: "样本文档"
    } as any);

    expect(result.saved_path).toBe("00_设定集/.agent/style_distillation/current.json");
    expect(result.data.profile).toMatchObject({
      book_title: "样本文档",
      profile_text: "表达DNA：干净利落。"
    });
  });
});
