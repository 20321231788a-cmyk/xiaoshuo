import { ConversationService } from "@xiaoshuo/conversation-service";
import { DocumentService } from "@xiaoshuo/document-service";
import { GeneratedCacheService } from "@xiaoshuo/generated-cache";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GeneratedSavePlanner } from "../generated-save-planner.js";
import { PromptSkillRunner } from "../skill-runner.js";
import { StyleGenreGenerateWorkflow } from "./style-genre-generate.js";
import type { WorkflowRunContext } from "./types.js";

let tempDir = "";
let configPath = "";

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "xiaoshuo-style-genre-workflow-"));
  configPath = path.join(tempDir, "studio_config.json");
  await fs.writeFile(configPath, JSON.stringify({ api_key: "demo-key", model: "demo-model" }), "utf8");
});

afterEach(async () => {
  if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
});

function context(): WorkflowRunContext {
  const modelClient = {
    requestCompletion: async (_config: unknown, messages: Array<{ content: string }>) => {
      const prompt = messages.map((message) => message.content).join("\n");
      if (prompt.includes("写作风格分析师")) {
        return [
          "【写作风格】\n都市高武快节奏，短句推进，强冲突收束。",
          "【风格示例】\n1. 先压迫后反转。",
          "【参考素材】\n都市夜景、武馆与异兽裂隙。"
        ].join("\n\n");
      }
      return [
        "【题材规则】\n等级体系：武者必须完成实战晋升。",
        "【题材素材】\n裂隙探索、武馆擂台。",
        "【战斗模板】\n1. 压迫 - 识破 - 反击 - 收束。",
        "【违禁词】\n1. 仙门。"
      ].join("\n\n");
    }
  };
  const documents = new DocumentService({ projectRoot: tempDir });
  const config = { configPath };
  return {
    projectRoot: tempDir,
    config,
    modelClient,
    webSearchClient: { search: async () => [] },
    documents,
    conversations: new ConversationService({ projectRoot: tempDir }),
    cache: new GeneratedCacheService({ projectRoot: tempDir, documentService: documents }),
    savePlanner: new GeneratedSavePlanner({ projectRoot: tempDir, config, modelClient }),
    skillRunner: new PromptSkillRunner({ projectRoot: tempDir, config, modelClient })
  };
}

describe("StyleGenreGenerateWorkflow", () => {
  it("stages both libraries in markdown caches even when the command asks to save", async () => {
    const oldStylePath = path.join(tempDir, "00_设定集", "风格库", "写作风格.txt");
    await fs.mkdir(path.dirname(oldStylePath), { recursive: true });
    await fs.writeFile(oldStylePath, "错误的大纲文字", "utf8");
    const result = await new StyleGenreGenerateWorkflow().runAgent({
      conversation_id: "",
      content: "创建都市高武的风格与题材库并保存",
      current_path: "",
      selection: "",
      project_context_hint: "",
      skill_id: "style_genre_generate",
      attachment_ids: []
    }, context());

    expect(result.saved_paths).toEqual([]);
    expect(result.skill_result?.data).toMatchObject({
      mode: "replace",
      style_records: expect.any(Number),
      genre_records: expect.any(Number),
      requires_confirmation: true
    });
    const rows = (result.skill_result?.data?.results || []) as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => String(row.skill_id)).sort()).toEqual(["genre_generate", "style_extract"]);
    const cache = new GeneratedCacheService({ projectRoot: tempDir });
    for (const row of rows) {
      const cacheId = String(row.cache_id || "");
      expect(cacheId).toBeTruthy();
      await expect(cache.readContent(cacheId)).resolves.toContain(String(row.skill_id) === "style_extract" ? "写作风格" : "题材规则");
    }
    await expect(fs.readFile(oldStylePath, "utf8")).resolves.toBe("错误的大纲文字");
    await expect(fs.access(path.join(tempDir, "00_设定集", ".agent", "libraries", "style.v1.jsonl"))).rejects.toThrow();
    await expect(fs.access(path.join(tempDir, "00_设定集", ".agent", "libraries", "genre.v1.jsonl"))).rejects.toThrow();
  });
});
