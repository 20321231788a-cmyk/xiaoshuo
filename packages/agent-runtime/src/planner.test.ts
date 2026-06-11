import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentPlanner } from "./planner.js";

let tempDir = "";
let configPath = "";

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "xiaoshuo-agent-planner-"));
  configPath = path.join(tempDir, "studio_config.json");
  await fs.mkdir(path.join(tempDir, "01_大纲"), { recursive: true });
  await fs.mkdir(path.join(tempDir, "00_设定集", ".agent"), { recursive: true });
  await fs.writeFile(path.join(tempDir, "01_大纲", "大纲.txt"), "第一章", "utf8");
  await fs.writeFile(configPath, "{}", "utf8");
});

afterEach(async () => {
  if (tempDir) {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

describe("agent-planner", () => {
  it("builds a local rename plan without model access", async () => {
    const planner = new AgentPlanner({ projectRoot: tempDir, config: { configPath } });

    const plan = await planner.buildPlan({
      instruction: "把当前文件文件名修改为新大纲",
      current_path: "01_大纲/大纲.txt",
      selection: "",
      project_context_hint: ""
    });

    expect(plan).toMatchObject({
      summary: "重命名 01_大纲/大纲.txt -> 01_大纲/新大纲.txt",
      can_execute: true
    });
    expect(plan.operations[0]).toMatchObject({
      action: "move_file",
      path: "01_大纲/大纲.txt",
      target_path: "01_大纲/新大纲.txt"
    });
  });

  it("returns a clear warning when no model is configured for AI planning", async () => {
    const planner = new AgentPlanner({ projectRoot: tempDir, config: { configPath } });

    const plan = await planner.buildPlan({
      instruction: "请补充完整设定集",
      current_path: "",
      selection: "",
      project_context_hint: ""
    });

    expect(plan.can_execute).toBe(false);
    expect(plan.summary).toContain("需要先配置主线路模型");
    expect(plan.warnings[0]).toContain("未配置主线路");
  });

  it("parses AI JSON operations and normalizes fixed paths", async () => {
    await fs.writeFile(configPath, JSON.stringify({ api_key: "demo-key", model: "demo-model" }), "utf8");
    const planner = new AgentPlanner({
      projectRoot: tempDir,
      config: { configPath },
      modelClient: {
        requestCompletion: async () =>
          JSON.stringify({
            summary: "补充大纲",
            operations: [
              {
                action: "append_text",
                path: "大纲",
                text: "\n追加设定",
                reason: "补充内容"
              }
            ]
          })
      }
    });

    const plan = await planner.buildPlan({
      instruction: "补充大纲内容",
      current_path: "",
      selection: "",
      project_context_hint: ""
    });

    expect(plan.can_execute).toBe(true);
    expect(plan.operations[0]).toMatchObject({
      action: "append_text",
      path: "01_大纲/大纲.txt",
      text: "\n追加设定"
    });
  });
});
