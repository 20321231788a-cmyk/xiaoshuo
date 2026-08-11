import { ConversationService } from "@xiaoshuo/conversation-service";
import { DocumentService } from "@xiaoshuo/document-service";
import { GeneratedCacheService } from "@xiaoshuo/generated-cache";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GeneratedSavePlanner } from "../generated-save-planner.js";
import type { PromptSkillRunner } from "../skill-runner.js";
import { ScanPitsWorkflow } from "./scan-pits.js";
import type { WorkflowRunContext } from "./types.js";

let tempDir = "";
let configPath = "";

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "xiaoshuo-scan-pits-workflow-"));
  configPath = path.join(tempDir, "studio_config.json");
  await fs.writeFile(configPath, JSON.stringify({ api_key: "demo-key", model: "demo-model" }), "utf8");
});

afterEach(async () => {
  if (tempDir) {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

function createWorkflowContext(): WorkflowRunContext {
  const documents = new DocumentService({ projectRoot: tempDir });
  const conversations = new ConversationService({ projectRoot: tempDir });
  const config = { configPath };
  const modelClient = {
    requestCompletion: async () => ""
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
    skillRunner: {
      runSkill: async () => ({
        status: "done",
        result: "- 林默答应三个月后回宗门复命\n- 黑石戒来源成谜",
        saved_path: "",
        data: {}
      })
    } as unknown as PromptSkillRunner
  };
}

describe("ScanPitsWorkflow", () => {
  it("extracts pit items and writes the ledger", async () => {
    const workflow = new ScanPitsWorkflow();
    const result = await workflow.runAgent(
      {
        conversation_id: "",
        content: "扫描伏笔",
        current_path: "",
        selection: "林默留下黑石戒的线索，并与宗门约定三月后归来。",
        project_context_hint: "",
        skill_id: "scan_pits",
        attachment_ids: []
      },
      createWorkflowContext()
    );

    expect(result.reply).toBe("伏笔账本已更新");
    expect(result.skill_result?.data?.skill_id).toBe("scan_pits");
    const ledgerRaw = await fs.readFile(path.join(tempDir, "00_设定集", ".agent", "ledger.json"), "utf8");
    expect(ledgerRaw).toContain("林默答应三个月后回宗门复命");
    expect(ledgerRaw).toContain("黑石戒来源成谜");
  });
});
