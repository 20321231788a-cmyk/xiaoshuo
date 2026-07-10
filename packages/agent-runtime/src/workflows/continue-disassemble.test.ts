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
import { ContinueDisassembleWorkflow } from "./continue-disassemble.js";
import type { WorkflowRunContext } from "./types.js";

let tempDir = "";
let configPath = "";

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "xiaoshuo-continue-disassemble-workflow-"));
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

describe("ContinueDisassembleWorkflow", () => {
  it("writes 拆书细纲 into a fresh book directory and legacy path", async () => {
    const workflow = new ContinueDisassembleWorkflow();
    const result = await workflow.runAgent(
      {
        conversation_id: "",
        content: "继续拆细纲",
        current_path: "",
        selection: "第一章：林默入宗门。\n第二章：外门立足。",
        project_context_hint: "",
        skill_id: "continue_disassemble",
        attachment_ids: []
      },
      createWorkflowContext({
        requestCompletion: async () => "第001章：宗门初见\n- 林默初入宗门，感受等级压迫。"
      })
    );

    const book = result.skill_result?.data?.book as { dir?: string } | undefined;
    expect(result.intent).toBe("skill");
    expect(book?.dir).toContain("00_设定集/拆书库/");
    expect(result.saved_paths).toEqual([`${book?.dir}/拆书细纲.txt`]);
    expect(await fs.readFile(path.join(tempDir, "01_大纲", "拆书细纲.txt"), "utf8")).toContain("第001章");
    expect(await fs.readFile(path.join(tempDir, book?.dir || "", "拆书细纲.txt"), "utf8")).toContain("第001章");
  });

  it("is used by AgentRuntimeService.runAgent", async () => {
    const runtime = new AgentRuntimeService({
      projectRoot: tempDir,
      config: { configPath },
      modelClient: {
        requestCompletion: async () => "第001章：继续扩展"
      }
    });

    const result = await runtime.runAgent({
      conversation_id: "",
      content: "继续拆细纲",
      current_path: "",
      selection: "第一章：林默入宗门。",
      project_context_hint: "",
      skill_id: "continue_disassemble",
      attachment_ids: []
    });

    const book = result.skill_result?.data?.book as { dir?: string } | undefined;
    expect(result.saved_paths).toEqual([`${book?.dir}/拆书细纲.txt`]);
    expect(await fs.readFile(path.join(tempDir, "01_大纲", "拆书细纲.txt"), "utf8")).toContain("继续扩展");
  });

  it("journals durable detail-outline, legacy-sync, and manifest writes", async () => {
    const runtime = new AgentRuntimeService({
      projectRoot: tempDir,
      config: { configPath },
      modelClient: {
        requestCompletion: async () => "第001章：继续扩展"
      }
    });
    const response = await runtime.runAgent({
      request_id: "durable-continue-disassemble-journal",
      conversation_id: "",
      content: "继续拆细纲",
      current_path: "",
      selection: "第一章：林默入宗门。",
      project_context_hint: "",
      skill_id: "continue_disassemble",
      attachment_ids: []
    });
    const journal = runtime.listDurableCommitJournal(response.run_id);

    expect(journal).toHaveLength(5);
    expect(journal).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "workflow.continue_disassemble.book.source", stage: "finalized" }),
      expect.objectContaining({ action: "workflow.continue_disassemble.book.manifest.initial", stage: "finalized" }),
      expect.objectContaining({ action: "workflow.continue_disassemble.detail_outline.output", stage: "finalized" }),
      expect.objectContaining({ action: "workflow.continue_disassemble.detail_outline.legacy_sync", stage: "finalized" }),
      expect.objectContaining({ action: "workflow.continue_disassemble.book.manifest.detail_outline", stage: "finalized" })
    ]));
    expect(new Set(journal.map((entry) => `${entry.run_id}:${entry.step_id}:${entry.attempt_id}`))).toEqual(
      new Set([journal.map((entry) => `${response.run_id}:${entry.step_id}:${entry.attempt_id}`)[0]])
    );
  });
});
