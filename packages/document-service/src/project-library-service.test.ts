import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProjectLibraryRecord } from "@xiaoshuo/shared";
import { ProjectLibraryService } from "./project-library-service.js";

let tempDir = "";

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "xiaoshuo-project-library-"));
  await fs.mkdir(path.join(tempDir, "00_设定集"), { recursive: true });
});

afterEach(async () => {
  if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
});

function character(name = "顾淮"): ProjectLibraryRecord {
  return {
    id: `character-${name}`,
    kind: "character",
    name,
    summary: "背负旧案的主角。",
    tags: ["主角"],
    order: 0,
    status: "active",
    origin: "manual",
    created_at: "2026-07-16T00:00:00.000Z",
    updated_at: "2026-07-16T00:00:00.000Z",
    needs_review: false,
    notes: "",
    role: "主角",
    aliases: [],
    age: "32",
    identity: "调查员",
    goal: "查清真相",
    fear: "失去同伴",
    traits: ["克制"],
    appearance: "",
    speech_style: "简短",
    constraints: []
  };
}

describe("ProjectLibraryService", () => {
  it("uses JSONL as the master and writes its text projections atomically", async () => {
    const service = new ProjectLibraryService({ projectRoot: tempDir, now: () => "2026-07-16T00:00:00.000Z" });

    const saved = await service.save("lore", { baseRevision: 0, records: [character()] });
    const master = await fs.readFile(path.join(tempDir, "00_设定集", ".agent", "libraries", "lore.v1.jsonl"), "utf8");
    const projection = await fs.readFile(path.join(tempDir, "00_设定集", "设定集", "人物设定.txt"), "utf8");

    expect(saved).toMatchObject({ domain: "lore", revision: 1, status: "ready" });
    expect(master).toContain("\"record_type\":\"meta\"");
    expect(master).toContain("顾淮");
    expect(projection).toContain("## 人物");
    expect(projection).toContain("### 顾淮");
    expect((await service.get("lore")).status).toBe("ready");
  });

  it("requires confirmation for legacy TXT migration and detects later projection drift", async () => {
    const legacyPath = path.join(tempDir, "00_设定集", "设定集", "人物设定.txt");
    await fs.mkdir(path.dirname(legacyPath), { recursive: true });
    await fs.writeFile(legacyPath, "林默：出身寒门的剑修。", "utf8");
    const service = new ProjectLibraryService({ projectRoot: tempDir });

    expect((await service.get("lore")).status).toBe("migration_required");
    const [migrated] = await service.migrate(["lore"]);
    expect(migrated?.records[0]).toMatchObject({ name: "林默", origin: "legacy_import", needs_review: true });

    await fs.writeFile(legacyPath, "外部改写", "utf8");
    expect((await service.get("lore")).status).toBe("projection_drift");
    expect((await service.reconcile("lore", "reimport_projection")).status).toBe("ready");
  });

  it("keeps generated content as a draft until the user confirms it", async () => {
    const service = new ProjectLibraryService({ projectRoot: tempDir });
    const legacyPath = path.join(tempDir, "00_设定集", "设定集", "人物设定.txt");
    await fs.mkdir(path.dirname(legacyPath), { recursive: true });
    await fs.writeFile(legacyPath, "林默：旧项目主角。", "utf8");
    const draft = await service.createDraft({
      draftId: "generated-draft-0001",
      domain: "lore",
      records: [character("苏晚")],
      source: "prompt_skill:lore_extract"
    });

    expect((await service.get("lore")).status).toBe("migration_required");
    expect((await service.listDrafts()).map((item) => item.draft_id)).toEqual([draft.draft_id]);

    const confirmed = await service.commitDraft(draft.draft_id);
    expect(confirmed.records.map((record) => record.name)).toEqual(expect.arrayContaining(["林默", "苏晚"]));
    expect((await service.listDrafts())).toEqual([]);
  });
});
