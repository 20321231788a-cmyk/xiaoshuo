import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StoryPlanningConflictError, StoryPlanningService } from "./story-planning-service.js";

let tempDir = "";

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "xiaoshuo-story-planning-"));
});

afterEach(async () => {
  if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
});

describe("StoryPlanningService", () => {
  it("keeps structured planning as JSONL and generates readable outline projections", async () => {
    const service = new StoryPlanningService({ projectRoot: tempDir, now: () => "2026-07-16T00:00:00.000Z", idFactory: () => "plan-1" });
    const saved = await service.save({
      baseRevision: 0,
      outline: [{ id: "arc-1", kind: "main_arc", title: "旧港谜案", summary: "查清船票日期的来历。", order: 0, parent_id: null, chapter_paths: ["02_正文/第03章.md"], entity_ids: [], status: "active", created_at: "", updated_at: "" }],
      timeline: [{ id: "event-1", title: "船票出现", summary: "顾淮在码头发现线索。", story_time: "第 1 日深夜", sort_key: "0001", order: 0, chapter_paths: ["02_正文/第03章.md"], entity_ids: [], clue_ids: [], status: "occurred", created_at: "", updated_at: "" }]
    });

    const master = await fs.readFile(path.join(tempDir, "00_设定集", ".agent", "story-planning.jsonl"), "utf8");
    const outline = await fs.readFile(path.join(tempDir, "01_大纲", "故事大纲.md"), "utf8");
    const timeline = await fs.readFile(path.join(tempDir, "01_大纲", "故事时间线.md"), "utf8");

    expect(saved).toMatchObject({ revision: 1, status: "ready" });
    expect(master).toContain("\"record_type\":\"outline\"");
    expect(outline).toContain("旧港谜案");
    expect(timeline).toContain("第 1 日深夜");
    expect((await service.get()).status).toBe("ready");
  });

  it("migrates legacy planning text once and blocks stale projection writes", async () => {
    const legacy = path.join(tempDir, "01_大纲", "故事大纲.md");
    await fs.mkdir(path.dirname(legacy), { recursive: true });
    await fs.writeFile(legacy, "# 旧大纲\n\n第一卷的内容。\n", "utf8");
    const service = new StoryPlanningService({ projectRoot: tempDir });

    expect((await service.get()).status).toBe("migration_required");
    const migrated = await service.migrate();
    expect(migrated.outline[0]).toMatchObject({ title: "导入的大纲", status: "active" });

    await fs.writeFile(legacy, "外部修改", "utf8");
    expect((await service.get()).status).toBe("projection_drift");
    await expect(service.save({ baseRevision: migrated.revision, outline: migrated.outline, timeline: migrated.timeline })).rejects.toBeInstanceOf(StoryPlanningConflictError);
  });
});
