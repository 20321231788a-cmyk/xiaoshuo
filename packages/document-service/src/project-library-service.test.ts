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

function style(name = "旧文风"): ProjectLibraryRecord {
  return {
    id: `style-${name}`,
    kind: "style_profile",
    name,
    summary: `${name}说明`,
    tags: [],
    order: 0,
    status: "active",
    origin: "manual",
    created_at: "2026-07-16T00:00:00.000Z",
    updated_at: "2026-07-16T00:00:00.000Z",
    needs_review: false,
    notes: "",
    narrative_pov: "第三人称",
    description: `${name}说明`,
    active: true
  };
}

function genre(name = "旧规则"): ProjectLibraryRecord {
  return {
    id: `genre-${name}`,
    kind: "genre_rule",
    name,
    summary: `${name}说明`,
    tags: [],
    order: 0,
    status: "active",
    origin: "manual",
    created_at: "2026-07-16T00:00:00.000Z",
    updated_at: "2026-07-16T00:00:00.000Z",
    needs_review: false,
    notes: "",
    category: "custom",
    instruction: `${name}说明`,
    severity: "hard",
    enabled: true
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

  it("previews and atomically confirms a replace-style-and-genre draft group", async () => {
    const service = new ProjectLibraryService({ projectRoot: tempDir });
    await service.saveMany([
      { domain: "style", baseRevision: 0, records: [style()] },
      { domain: "genre", baseRevision: 0, records: [genre()] }
    ]);
    await service.createDraft({
      draftId: "style-genre-draft-style-0001",
      group_id: "style-genre-group-0001",
      domain: "style",
      records: [style("都市高武")],
      source: "workflow",
      commit_mode: "replace",
      base_revision: 1,
      target_paths: ["00_设定集/风格库/写作风格.txt"]
    });
    await service.createDraft({
      draftId: "style-genre-draft-genre-0001",
      group_id: "style-genre-group-0001",
      domain: "genre",
      records: [genre("高武升级节奏")],
      source: "workflow",
      commit_mode: "replace",
      base_revision: 1,
      target_paths: ["00_设定集/题材库/题材规则.txt"]
    });

    const preview = await service.previewDraftGroup("style-genre-group-0001");
    expect(preview.mode).toBe("replace");
    expect(preview.preview.find((item) => item.domain === "style")?.removed.map((item) => item.name)).toContain("旧文风");

    await service.commitDraftGroup("style-genre-group-0001");
    expect((await service.get("style")).records.map((item) => item.name)).toEqual(["都市高武"]);
    expect((await service.get("genre")).records.map((item) => item.name)).toEqual(["高武升级节奏"]);
    await expect(service.commitDraftGroup("style-genre-group-0001")).resolves.toHaveLength(2);
    expect((await service.listDraftGroups())).toEqual([]);
  });
});
