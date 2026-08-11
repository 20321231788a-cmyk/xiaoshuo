import { ConversationService } from "@xiaoshuo/conversation-service";
import { DocumentService } from "@xiaoshuo/document-service";
import { GeneratedCacheService } from "@xiaoshuo/generated-cache";
import type { AgentRunRequest, AgentRunResponse } from "@xiaoshuo/shared";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GeneratedSavePlanner } from "../generated-save-planner.js";
import { PromptSkillRunner } from "../skill-runner.js";
import { BatchGenerateWorkflow } from "./batch-generate.js";
import type { WorkflowHandler, WorkflowRunContext } from "./types.js";

let tempDir = "";
let configPath = "";

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "xiaoshuo-batch-workflow-"));
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
    skillRunner: new PromptSkillRunner({ projectRoot: tempDir, config, modelClient })
  };
}

describe("BatchGenerateWorkflow", () => {
  it("runs body handler for each chapter and aggregates results", async () => {
    const calls: AgentRunRequest[] = [];
    const bodyHandler: WorkflowHandler = {
      id: "body_generate",
      async runAgent(request): Promise<AgentRunResponse> {
        calls.push(request);
        const chapter = Number(/第(\d+)章/.exec(request.content || "")?.[1] || 0);
        const savedPath = `02_正文/第${String(chapter).padStart(3, "0")}章.txt`;
        return {
          intent: "skill",
          reply: `已写入 ${savedPath}`,
          results: [],
          skill_result: {
            status: "done",
            result: `第${chapter}章正文`,
            saved_path: savedPath,
            data: {
              chapter,
              saved_paths: [savedPath],
              web_search_sources: [{ title: "素材", url: "https://example.test/source" }]
            }
          },
          saved_paths: [savedPath],
          requires_confirmation: false,
          web_search_sources: [{ title: "素材", url: "https://example.test/source" }]
        };
      }
    };
    const workflow = new BatchGenerateWorkflow(bodyHandler);

    const result = await workflow.runAgent(
      {
        conversation_id: "",
        content: "生成第1章到第2章正文并写入文件",
        current_path: "",
        selection: "",
        project_context_hint: "",
        skill_id: "batch_generate",
        attachment_ids: []
      },
      createWorkflowContext()
    );

    expect(calls).toHaveLength(2);
    expect(calls.map((item) => item.content)).toEqual([
      "生成第1章正文并写入文件。原始批量指令：生成第1章到第2章正文并写入文件",
      "生成第2章正文并写入文件。原始批量指令：生成第1章到第2章正文并写入文件"
    ]);
    expect(result.saved_paths).toEqual(["02_正文/第001章.txt", "02_正文/第002章.txt"]);
    expect(result.skill_result?.data?.chapters).toEqual([1, 2]);
    expect(result.web_search_sources).toEqual([{ title: "素材", url: "https://example.test/source" }]);
  });

  it("does not start chapter 2 after chapter 1 aborts", async () => {
    const controller = new AbortController();
    const calls: AgentRunRequest[] = [];
    const bodyHandler: WorkflowHandler = {
      id: "body_generate",
      async runAgent(request): Promise<AgentRunResponse> {
        calls.push(request);
        controller.abort();
        return {
          intent: "skill",
          reply: "已写入 02_正文/第001章.txt",
          results: [],
          skill_result: {
            status: "done",
            result: "第1章正文",
            saved_path: "02_正文/第001章.txt",
            data: {
              chapter: 1,
              saved_paths: ["02_正文/第001章.txt"]
            }
          },
          saved_paths: ["02_正文/第001章.txt"],
          requires_confirmation: false
        };
      }
    };
    const workflow = new BatchGenerateWorkflow(bodyHandler);
    const context = createWorkflowContext();
    context.signal = controller.signal;

    await expect(
      workflow.runAgent(
        {
          conversation_id: "",
          content: "生成第1章到第2章正文并写入文件",
          current_path: "",
          selection: "",
          project_context_hint: "",
          skill_id: "batch_generate",
          attachment_ids: []
        },
        context
      )
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.content).toMatch(/^生成第1章正文并写入文件。/);
  });
});
