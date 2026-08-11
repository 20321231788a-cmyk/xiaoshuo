import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AGENT_DIR, ProjectSessionService, projectMetaPath, safeProjectFolderName } from "./service.js";

let tempDir = "";
let stateFilePath = "";

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "xiaoshuo-project-session-"));
  stateFilePath = path.join(tempDir, "state", "project-session.json");
});

afterEach(async () => {
  if (tempDir) {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

function service() {
  return new ProjectSessionService({
    stateFilePath,
    now: () => "2026-06-01 10:00:00"
  });
}

describe("project-session", () => {
  it("creates a project with Python-compatible starter folders, files, and meta", async () => {
    const sessions = service();

    const created = await sessions.createProject(path.join(tempDir, "sandbox-projects"), "Demo Project", true);
    const meta = JSON.parse(await fs.readFile(projectMetaPath(created.path), "utf8")) as Record<string, string>;
    const starterDocument = await fs.readFile(path.join(created.path, "01_大纲", "大纲.txt"), "utf8");

    expect(created.name).toBe("Demo Project");
    expect(meta.display_name).toBe("Demo Project");
    expect(meta.created_at).toBe("2026-06-01 10:00:00");
    expect(starterDocument).toBe("");
    await expect(fs.stat(path.join(created.path, AGENT_DIR))).resolves.toBeTruthy();
  });

  it("opens an existing project and prefers the meta display name", async () => {
    const projectPath = path.join(tempDir, "existing-project");
    await fs.mkdir(path.dirname(projectMetaPath(projectPath)), { recursive: true });
    await fs.writeFile(projectMetaPath(projectPath), JSON.stringify({ display_name: "已有项目" }), "utf8");
    const sessions = service();

    const opened = await sessions.openProject(projectPath);

    expect(opened).toEqual({
      path: path.resolve(projectPath),
      name: "已有项目"
    });
  });

  it("renames the current project folder and persists the state", async () => {
    const sessions = service();
    const created = await sessions.createProject(path.join(tempDir, "rename-me"), "", false);

    const renamed = await sessions.renameCurrentProject("  新项目名  ");
    const reloaded = new ProjectSessionService({ stateFilePath, now: () => "2026-06-01 10:05:00" });

    expect(created.name).toBe("rename-me");
    expect(renamed.name).toBe("新项目名");
    expect(path.basename(renamed.path)).toBe("新项目名");
    expect(renamed.previous_path).toBe(created.path);
    await expect(fs.stat(created.path)).rejects.toThrow();
    await expect(fs.stat(renamed.path)).resolves.toBeTruthy();
    await expect(reloaded.getCurrentProject()).resolves.toEqual({
      path: renamed.path,
      name: "新项目名"
    });
  });

  it("keeps the current folder when the sanitized project name does not change", async () => {
    const sessions = service();
    const created = await sessions.createProject(path.join(tempDir, "Same Name"), "", false);

    const renamed = await sessions.renameCurrentProject("Same   Name");

    expect(renamed).toEqual({
      path: created.path,
      name: "Same   Name",
      previous_path: ""
    });
    await expect(fs.stat(created.path)).resolves.toBeTruthy();
  });

  it("rejects project folder rename when the target sibling already exists", async () => {
    const sessions = service();
    const created = await sessions.createProject(path.join(tempDir, "rename-me"), "", false);
    await fs.mkdir(path.join(tempDir, "Existing"), { recursive: true });

    await expect(sessions.renameCurrentProject("Existing")).rejects.toThrow("同级目录已存在项目文件夹");

    await expect(fs.stat(created.path)).resolves.toBeTruthy();
    await expect(fs.stat(path.join(tempDir, "Existing"))).resolves.toBeTruthy();
  });

  it("creates unique child folders when create_in_parent is enabled", async () => {
    const parent = path.join(tempDir, "sandbox-projects");
    const sessions = service();

    const first = await sessions.createProject(parent, "Novel", true);
    const second = await sessions.createProject(parent, "Novel", true);

    expect(first.path.endsWith(path.join("sandbox-projects", "Novel"))).toBe(true);
    expect(second.path.endsWith(path.join("sandbox-projects", "Novel (2)"))).toBe(true);
  });

  it("restores only valid persisted projects and clears broken state", async () => {
    const projectPath = path.join(tempDir, "persisted-project");
    await fs.mkdir(projectPath, { recursive: true });
    await fs.mkdir(path.dirname(stateFilePath), { recursive: true });
    await fs.writeFile(
      stateFilePath,
      JSON.stringify({
        current_project: {
          path: projectPath,
          name: "持久项目"
        },
        updated_at: "2026-06-01 10:00:00"
      }),
      "utf8"
    );

    const restored = new ProjectSessionService({ stateFilePath });
    const current = await restored.getCurrentProject();
    await fs.rm(projectPath, { recursive: true, force: true });
    const cleared = new ProjectSessionService({ stateFilePath });

    expect(current.name).toBe("持久项目");
    await expect(cleared.getCurrentProject()).resolves.toEqual({ path: "", name: "" });
  });

  it("matches the Python folder sanitizing rules for reserved names", () => {
    expect(safeProjectFolderName(" COM1 ")).toBe("COM1_project");
    expect(safeProjectFolderName(' a<>:"/\\\\|?*b ')).toBe("ab");
  });

  it("builds continuity context from project folders and files", async () => {
    const sessions = service();
    const created = await sessions.createProject(path.join(tempDir, "continuity-project"), "Continuity", false);

    const projectPath = created.path;
    await fs.writeFile(path.join(projectPath, "01_大纲", "大纲.txt"), "测试大纲内容", "utf8");
    await fs.writeFile(path.join(projectPath, "01_大纲", "细纲.txt"), "测试细纲内容", "utf8");
    await fs.writeFile(path.join(projectPath, "01_大纲", "章纲.txt"), "测试章纲内容", "utf8");

    await fs.mkdir(path.join(projectPath, "00_设定集", "设定库"), { recursive: true });
    await fs.writeFile(path.join(projectPath, "00_设定集", "设定库", "人物设定.txt"), "主角张三", "utf8");

    await fs.writeFile(path.join(projectPath, "02_正文", "第一章 启程.txt"), "正文第一章", "utf8");
    await fs.writeFile(path.join(projectPath, "02_正文", "第二章 险境.txt"), "正文第二章", "utf8");

    await fs.writeFile(path.join(projectPath, "00_设定集", "project_state.json"), JSON.stringify({
      updated_at: "2026-06-01 10:00:00",
      body: { chapter: 2 },
      ledger: { active: true }
    }), "utf8");

    const context = await sessions.buildContinuityContext();

    expect(context.outline).toBe("测试大纲内容");
    expect(context.detailed_outline).toBe("测试细纲内容");
    expect(context.chapter_outline).toBe("测试章纲内容");
    expect(context.lore["人物设定"]).toBe("主角张三");
    expect(context.previous_chapters).toHaveLength(2);
    expect(context.previous_chapters[0]?.content).toBe("正文第一章");
    expect(context.previous_chapters[1]?.content).toBe("正文第二章");
    expect(JSON.parse(context.state_summary)).toMatchObject({
      updated_at: "2026-06-01 10:00:00"
    });
  });
});
