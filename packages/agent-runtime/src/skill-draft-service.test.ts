import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SkillService } from "@xiaoshuo/skill-service";
import { SkillDraftService } from "./skill-draft-service.js";

let tempDir = "";
let configPath = "";

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "xiaoshuo-skill-draft-"));
  configPath = path.join(tempDir, "empty_config.json");
  await fs.writeFile(configPath, "{}", "utf8");
});

afterEach(async () => {
  if (tempDir) {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

describe("skill-draft-service", () => {
  it("drafts a prompt skill from selection without importing it", async () => {
    const service = new SkillDraftService({
      projectRoot: tempDir,
      config: { configPath }
    });

    const draft = await service.draftSkill({
      kind: "selection",
      instruction: "生成短篇审稿技能",
      selection: "重点检查情绪张力、反转和结尾余味。",
      text: "",
      url: "",
      current_path: "",
      attachment_ids: [],
      source_skill_id: "",
      target_name: "短篇审稿",
      target_id: "short_review"
    });

    expect(draft.skill).toMatchObject({
      id: "short_review",
      name: "短篇审稿",
      handler_type: "prompt",
      input_mode: "text",
      writable: false
    });
    expect(draft.skill.prompt).toContain("## 适用场景");
    expect(draft.warnings).toContain("未配置主线路模型，已生成安全的 prompt 型草稿模板。");
    expect(await new SkillService({ projectRoot: tempDir }).getSkill("short_review")).toBeNull();
  });

  it("drafts from the current document", async () => {
    await fs.mkdir(path.join(tempDir, "01_大纲"), { recursive: true });
    await fs.writeFile(path.join(tempDir, "01_大纲", "审稿规则.txt"), "必须输出问题等级。", "utf8");
    const service = new SkillDraftService({
      projectRoot: tempDir,
      config: { configPath }
    });

    const draft = await service.draftSkill({
      kind: "current_document",
      instruction: "",
      text: "",
      url: "",
      current_path: "01_大纲/审稿规则.txt",
      selection: "",
      attachment_ids: [],
      source_skill_id: "",
      target_name: "",
      target_id: "review_from_doc"
    });

    expect(draft.skill.id).toBe("review_from_doc");
    expect(draft.source_name).toBe("01_大纲/审稿规则.txt");
    expect(draft.source_text).toContain("必须输出问题等级");
    expect(draft.skill.prompt).toContain("必须输出问题等级");
  });
});
