import { ConversationService } from "@xiaoshuo/conversation-service";
import { DocumentService } from "@xiaoshuo/document-service";
import { GeneratedCacheService } from "@xiaoshuo/generated-cache";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GeneratedSavePlanner } from "../generated-save-planner.js";
import { ContinueDisassembleWorkflow } from "./continue-disassemble.js";
import { PromptSkillRunner } from "../skill-runner.js";
import type { WorkflowRunContext } from "./types.js";

let tempDir = "";
let configPath = "";

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "xiaoshuo-continue-disassemble-workflow-"));
  configPath = path.join(tempDir, "studio_config.json");
  await fs.writeFile(configPath, JSON.stringify({ api_key: "demo-key", model: "demo-model" }), "utf8");
});

afterEach(async () => {
  if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
});

function context(): WorkflowRunContext {
  const documents = new DocumentService({ projectRoot: tempDir });
  const conversations = new ConversationService({ projectRoot: tempDir });
  const config = { configPath };
  const modelClient = {
    requestCompletion: async (_config: unknown, messages: Array<{ content: string }>) => {
      const prompt = messages.map((message) => message.content).join("\n");
      const keys = /chapter_summaries 必须且只能使用这些 chapter 键：([^\n]+)。/.exec(prompt)?.[1]?.split("、") || ["segment:1"];
      return JSON.stringify({
        chapter_summaries: keys.map((chapter) => ({ chapter, summary: "本段剧情推进。" })),
        stage_summary: "阶段推进。",
        protagonist_arc: [],
        major_characters: [],
        major_settings: []
      });
    }
  };
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

describe("ContinueDisassembleWorkflow", () => {
  it("uses the fast report workflow instead of creating a legacy detail outline", async () => {
    const workflow = new ContinueDisassembleWorkflow();
    const result = await workflow.runAgent({
      conversation_id: "",
      content: "继续拆书",
      current_path: "",
      selection: "第1章：林默入宗门。\n第2章：外门立足。",
      project_context_hint: "",
      skill_id: "continue_disassemble",
      attachment_ids: []
    }, context());
    const book = result.skill_result?.data?.book as { dir?: string } | undefined;

    expect(result.saved_paths).toEqual([`${book?.dir}/拆书报告.md`]);
    expect(await fs.readFile(path.join(tempDir, book?.dir || "", "拆书报告.md"), "utf8")).toContain("## 前100章剧情");
    await expect(fs.readFile(path.join(tempDir, book?.dir || "", "拆书细纲.txt"), "utf8")).rejects.toThrow();
  });
});
