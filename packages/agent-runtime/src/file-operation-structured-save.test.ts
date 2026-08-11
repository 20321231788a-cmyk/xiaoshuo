import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectLibraryService, StoryPlanningService } from "@xiaoshuo/document-service";
import { AgentFileOperationRunner } from "./file-operation-runner.js";

const projects: string[] = [];

afterEach(async () => {
  for (const project of projects.splice(0)) {
    await fs.rm(project, { recursive: true, force: true });
  }
});

describe("AgentFileOperationRunner structured direct saves", () => {
  it("keeps the confirmed outline file and synchronizes split planning nodes", async () => {
    const projectRoot = await fixture();
    const buildPlan = vi.fn();
    const runner = new AgentFileOperationRunner({ projectRoot, planner: { buildPlan } as never });

    const result = await runner.runAgent(request("保存到故事大纲：\n# 雨夜入城\n主角带着密信进入被封锁的王城。"));
    const planning = await new StoryPlanningService({ projectRoot }).get();

    expect(buildPlan).not.toHaveBeenCalled();
    expect(result.results).toEqual([expect.objectContaining({ ok: true, path: "01_大纲/大纲.txt" })]);
    expect(planning.outline).toEqual([expect.objectContaining({ title: "雨夜入城", summary: expect.stringContaining("密信") })]);
    expect(await fs.readFile(path.join(projectRoot, "01_大纲", "大纲.txt"), "utf8")).toContain("密信");
    expect(await fs.readFile(path.join(projectRoot, "01_大纲", "故事大纲.md"), "utf8")).toContain("雨夜入城");
  });

  it("writes style, genre, and lore targets into their structured libraries", async () => {
    const projectRoot = await fixture();
    const runner = new AgentFileOperationRunner({ projectRoot, planner: { buildPlan: vi.fn() } as never });

    await runner.runAgent(request("写入写作风格：\n冷峻克制\n叙述采用近距离第三人称，避免解释性抒情。"));
    await runner.runAgent(request("写入题材规则：\n世界规则：灵力耗尽后必须通过休眠恢复。"));
    await runner.runAgent(request("写入设定资料：\n灵力恢复\n灵力耗尽后必须通过休眠恢复。"));

    const libraries = new ProjectLibraryService({ projectRoot });
    const [style, genre, lore] = await Promise.all([libraries.get("style"), libraries.get("genre"), libraries.get("lore")]);
    expect(style.records).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "style_profile", name: "冷峻克制" })]));
    expect(genre.records).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "genre_rule" })]));
    expect(lore.records).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "world_rule", summary: expect.stringContaining("灵力恢复") })]));
  });
});

async function fixture(): Promise<string> {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "structured-direct-save-"));
  projects.push(projectRoot);
  return projectRoot;
}

function request(content: string) {
  return {
    conversation_id: "",
    content,
    current_path: "",
    selection: "",
    project_context_hint: "",
    skill_id: "",
    attachment_ids: []
  };
}
