import { ConversationService } from "@xiaoshuo/conversation-service";
import { DocumentService } from "@xiaoshuo/document-service";
import { GeneratedCacheService } from "@xiaoshuo/generated-cache";
import type { ChatCompletionMessage } from "@xiaoshuo/model-client";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GeneratedSavePlanner } from "../generated-save-planner.js";
import { PromptSkillRunner } from "../skill-runner.js";
import { BookFusionWorkflow } from "./book-fusion.js";
import type { WorkflowRunContext } from "./types.js";

let tempDir = "";
let configPath = "";

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "xiaoshuo-book-fusion-workflow-"));
  configPath = path.join(tempDir, "studio_config.json");
  await fs.mkdir(path.join(tempDir, "00_设定集", "题材库"), { recursive: true });
  await fs.writeFile(configPath, JSON.stringify({ api_key: "demo-key", model: "demo-model" }), "utf8");
  await fs.writeFile(path.join(tempDir, "00_设定集", "题材库", "题材规则.txt"), "东方玄幻升级流", "utf8");
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

async function writeReadyBook(index: number): Promise<string> {
  const id = `书${index}-2026060912000${index}-abcd123${index}`;
  const relDir = `00_设定集/拆书库/${id}`;
  const bookDir = path.join(tempDir, relDir);
  await fs.mkdir(bookDir, { recursive: true });
  await fs.writeFile(
    path.join(bookDir, "manifest.jsonl"),
    JSON.stringify({
      id,
      title: `书${index}`,
      dir: relDir,
      created_at: `2026-06-09T12:00:0${index}.000Z`,
      updated_at: `2026-06-09T12:00:0${index}.000Z`,
      origin: "document",
      source_path: `${relDir}/原文.txt`,
      source_summary: `测试书${index}`,
      chars: 12,
      paths: {
        source: `${relDir}/原文.txt`,
        lore: `${relDir}/拆书设定提取.txt`,
        reverse_outline: `${relDir}/反向细纲.txt`,
        detail_outline: `${relDir}/拆书细纲.txt`
      }
    }) + "\n",
    "utf8"
  );
  await fs.writeFile(path.join(bookDir, "原文.txt"), `原文${index}`, "utf8");
  await fs.writeFile(path.join(bookDir, "拆书设定提取.txt"), `设定${index}`, "utf8");
  await fs.writeFile(path.join(bookDir, "反向细纲.txt"), `反向细纲${index}`, "utf8");
  await fs.writeFile(path.join(bookDir, "拆书细纲.txt"), `拆书细纲${index}`, "utf8");
  return id;
}

describe("BookFusionWorkflow", () => {
  it("rejects fewer than three source books", async () => {
    const workflow = new BookFusionWorkflow();
    await expect(
      workflow.runAgent(
        {
          conversation_id: "",
          content: "融梗",
          current_path: "",
          selection: "",
          project_context_hint: "",
          skill_id: "book_fusion",
          attachment_ids: [],
          source_book_ids: ["a", "b"]
        } as any,
        createWorkflowContext({ requestCompletion: async () => "unused" })
      )
    ).rejects.toThrow("融梗至少需要选择三本已拆书籍");
  });

  it("writes fusion candidates into the fusion library", async () => {
    const ids = [await writeReadyBook(1), await writeReadyBook(2), await writeReadyBook(3)];
    let capturedMessages: ChatCompletionMessage[] = [];
    const workflow = new BookFusionWorkflow();

    const result = await workflow.runAgent(
      {
        conversation_id: "",
        content: "",
        current_path: "",
        selection: "",
        project_context_hint: "",
        skill_id: "book_fusion",
        attachment_ids: [],
        source_book_ids: ids,
        custom_prompt: "保留升级节奏",
        genre_hint: "东方玄幻",
        output_mode: "candidate"
      } as any,
      createWorkflowContext({
        requestCompletion: async (_config, messages) => {
          capturedMessages = messages;
          return "融合候选方案";
        }
      })
    );

    const saved = result.skill_result?.data?.saved_paths as string[] | undefined;
    expect(capturedMessages.at(-1)?.content).toContain("【待融合书籍资料】");
    expect(capturedMessages.at(-1)?.content).toContain("当前题材库");
    expect(saved?.[0]).toMatch(/^00_设定集\/融梗方案\/.+\/融梗候选\.txt$/);
    expect(saved?.[1]).toMatch(/^00_设定集\/融梗方案\/.+\/融梗提示词\.txt$/);
    expect(saved?.[2]).toMatch(/^00_设定集\/融梗方案\/.+\/来源书籍\.jsonl$/);
    expect(saved?.[3]).toMatch(/^00_设定集\/融梗方案\/.+\/manifest\.jsonl$/);
    expect(await fs.readFile(path.join(tempDir, saved?.[0] || ""), "utf8")).toContain("融合候选方案");
    expect(await fs.readFile(path.join(tempDir, saved?.[1] || ""), "utf8")).toContain("保留升级节奏");
  });
});
