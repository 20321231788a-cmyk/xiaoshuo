import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GeneratedSavePlanner } from "./generated-save-planner.js";

let tempDir = "";

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "xiaoshuo-save-planner-"));
  await fs.mkdir(path.join(tempDir, "01_大纲"), { recursive: true });
  await fs.mkdir(path.join(tempDir, "02_正文"), { recursive: true });
  await fs.mkdir(path.join(tempDir, "00_设定集", "设定集"), { recursive: true });
  await fs.writeFile(path.join(tempDir, "01_大纲", "大纲.txt"), "已有大纲", "utf8");
});

afterEach(async () => {
  if (tempDir) {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

describe("GeneratedSavePlanner", () => {
  it("maps explicit outline save requests to the legacy outline path and auto-commits old-project style", async () => {
    const planner = new GeneratedSavePlanner({ projectRoot: tempDir });

    const plan = await planner.planGeneratedSave({
      instruction: "把这份新大纲保存到大纲",
      content: "新大纲内容",
      source: "chat",
      skillId: "chat_generated",
      writeRequested: true
    });

    expect(plan.target_paths).toEqual(["01_大纲/大纲.txt"]);
    expect(plan.mode).toBe("replace");
    expect(plan.requires_confirmation).toBe(false);
    expect(plan.should_auto_commit).toBe(true);
  });

  it("auto-commits explicit body generation when the chapter file does not exist", async () => {
    const planner = new GeneratedSavePlanner({ projectRoot: tempDir });

    const plan = await planner.planGeneratedSave({
      instruction: "生成第1章正文并写入文件",
      content: "第一章正文",
      source: "workflow",
      skillId: "body_generate",
      chapter: 1,
      writeRequested: true
    });

    expect(plan.target_paths).toEqual(["02_正文/第001章.txt"]);
    expect(plan.requires_confirmation).toBe(false);
    expect(plan.should_auto_commit).toBe(true);
  });

  it("keeps generated content pending when there is no write intent", async () => {
    const planner = new GeneratedSavePlanner({ projectRoot: tempDir });

    const plan = await planner.planGeneratedSave({
      instruction: "生成第2章正文",
      content: "第二章正文",
      source: "workflow",
      skillId: "body_generate",
      chapter: 2,
      writeRequested: false
    });

    expect(plan.target_paths).toEqual(["02_正文/第002章.txt"]);
    expect(plan.requires_confirmation).toBe(true);
    expect(plan.should_auto_commit).toBe(false);
  });
});
