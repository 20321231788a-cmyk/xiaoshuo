import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { StoryPlanningService } from "@xiaoshuo/document-service";
import { commitGeneratedBodySummary, commitGeneratedStoryPlanning } from "./generated-story-planning.js";

const projects: string[] = [];

afterEach(async () => {
  for (const project of projects.splice(0)) {
    await fs.rm(project, { recursive: true, force: true });
  }
});

describe("generated story planning", () => {
  it("splits a saved outline into main and character nodes without copying the full document", async () => {
    const projectRoot = await fixture();
    await commitGeneratedStoryPlanning({
      projectRoot,
      skillId: "outline_generate",
      mode: "replace",
      content: [
        "# 主线：雨夜入城",
        "主角携带密信进入被封锁的王城，发现旧案与王族有关。",
        "# 人物线：顾淮",
        "顾淮从只求自保转为追查父亲失踪真相。"
      ].join("\n")
    });
    const planning = await new StoryPlanningService({ projectRoot }).get();

    expect(planning.outline).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "main_arc", title: "主线：雨夜入城", summary: expect.stringContaining("密信") }),
      expect.objectContaining({ kind: "character_arc", title: "人物线：顾淮", summary: expect.stringContaining("顾淮") })
    ]));
    expect(planning.outline.every((item) => item.summary.length < 1_201)).toBe(true);
  });

  it("replaces only the node kinds owned by the saved source", async () => {
    const projectRoot = await fixture();
    await commitGeneratedStoryPlanning({
      projectRoot,
      skillId: "outline_generate",
      mode: "replace",
      content: "# 主线\n旧主线"
    });
    await commitGeneratedStoryPlanning({
      projectRoot,
      skillId: "detail_outline_generate",
      mode: "replace",
      content: "# 第一幕\n主角取得密信。"
    });
    await commitGeneratedStoryPlanning({
      projectRoot,
      skillId: "detail_outline_generate",
      mode: "replace",
      content: "# 第二幕\n主角进入王城。"
    });
    const planning = await new StoryPlanningService({ projectRoot }).get();

    expect(planning.outline).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "main_arc", summary: "旧主线" })]));
    expect(planning.outline.filter((item) => item.kind === "beat")).toEqual([
      expect.objectContaining({ title: "第二幕", summary: "主角进入王城。" })
    ]);
  });

  it("stores only one sentence when a body chapter is saved", async () => {
    const projectRoot = await fixture();
    await commitGeneratedBodySummary({
      projectRoot,
      chapter: 1,
      outputPath: "02_正文/第001章.txt",
      content: "顾淮在雨夜抵达王城，凭密信躲过城门搜查。随后他发现追兵已经入城。"
    });
    const planning = await new StoryPlanningService({ projectRoot }).get();
    const chapter = planning.outline.find((item) => item.kind === "chapter");

    expect(chapter).toMatchObject({ title: "第1章", body_summary: "顾淮在雨夜抵达王城，凭密信躲过城门搜查。" });
    expect(chapter?.summary).toBe("");
  });
});

async function fixture(): Promise<string> {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "generated-story-planning-"));
  projects.push(projectRoot);
  return projectRoot;
}
