import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProjectSessionService } from "@xiaoshuo/project-session";
import { MANIFEST_REL_PATH, ProjectManifestService } from "./service.js";
import { parseProjectId } from "./project-identity.js";

let tempDir = "";
let projectPath = "";

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "xiaoshuo-project-manifest-"));
  const sessions = new ProjectSessionService({
    stateFilePath: path.join(tempDir, "state", "project-session.json"),
    now: () => "2026-06-01 11:00:00"
  });
  const created = await sessions.createProject(path.join(tempDir, "sandbox-projects"), "manifest-demo", true);
  projectPath = created.path;
  await fs.writeFile(path.join(projectPath, "01_大纲", "细纲.txt"), "outline", "utf8");
  await fs.mkdir(path.join(projectPath, "02_正文", "章节"), { recursive: true });
  await fs.writeFile(path.join(projectPath, "02_正文", "章节", "第一章.md"), "chapter 1", "utf8");
  await fs.writeFile(path.join(projectPath, "00_设定集", "风格库", "写作风格.txt"), "冷静 克制\n留白", "utf8");
  await fs.mkdir(path.join(projectPath, "00_设定集", ".agent"), { recursive: true });
  await fs.writeFile(path.join(projectPath, "00_设定集", ".agent", "skip.txt"), "skip", "utf8");
});

afterEach(async () => {
  if (tempDir) {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

describe("project-manifest", () => {
  it("rebuilds manifest entries and ignores .agent content", async () => {
    const manifest = new ProjectManifestService(projectPath);

    const documents = await manifest.listDocuments({ force: true });

    expect(documents.some((item) => item.path.includes(".agent"))).toBe(false);
    expect(documents.some((item) => item.path === "02_正文/章节/第一章.md")).toBe(true);
    await expect(fs.access(path.join(projectPath, MANIFEST_REL_PATH))).resolves.toBeUndefined();
  });

  it("loads status and entries from disk after the initial rebuild", async () => {
    const first = new ProjectManifestService(projectPath);
    await first.listDocuments({ force: true });
    const second = new ProjectManifestService(projectPath);

    const status = await second.status();
    const documents = await second.listDocuments();

    expect(status.ready).toBe(true);
    expect(status.source).toBe("disk");
    expect(documents.length).toBeGreaterThan(0);
  });

  it("atomically assigns a stable project UUID to a legacy manifest", async () => {
    const manifestPath = path.join(projectPath, MANIFEST_REL_PATH);
    await fs.mkdir(path.dirname(manifestPath), { recursive: true });
    await fs.writeFile(
      manifestPath,
      JSON.stringify({
        project_path: projectPath,
        version: 1,
        generated_at: "2026-06-01 11:00:00",
        entries: []
      }),
      "utf8"
    );

    const manifest = new ProjectManifestService(projectPath);
    const projectId = await manifest.getProjectId();
    const diskPayload = JSON.parse(await fs.readFile(manifestPath, "utf8")) as Record<string, unknown>;
    const siblingFiles = await fs.readdir(path.dirname(manifestPath));

    expect(parseProjectId(projectId)).toBe(projectId);
    expect(diskPayload.project_id).toBe(projectId);
    expect(JSON.parse(await fs.readFile(manifestPath, "utf8"))).toMatchObject({ project_id: projectId });
    expect(siblingFiles.some((name) => name.includes("project_manifest.json") && name.endsWith(".tmp"))).toBe(false);
  });

  it("coalesces concurrent first manifests so every caller receives one UUID", async () => {
    const manifestPath = path.join(projectPath, MANIFEST_REL_PATH);
    await fs.rm(manifestPath, { force: true });

    const projectIds = await Promise.all(
      Array.from({ length: 12 }, () => new ProjectManifestService(projectPath).getProjectId())
    );

    expect(new Set(projectIds).size).toBe(1);
    expect(parseProjectId(projectIds[0])).toBe(projectIds[0]);
    await expect(fs.access(manifestPath)).resolves.toBeUndefined();
  });

  it("keeps the project UUID when the project directory moves", async () => {
    const original = new ProjectManifestService(projectPath);
    await original.rebuild();
    const projectId = await original.getProjectId();
    const movedProjectPath = path.join(tempDir, "moved-project");

    await fs.rename(projectPath, movedProjectPath);
    const moved = new ProjectManifestService(movedProjectPath);
    const movedProjectId = await moved.getProjectId();
    const diskPayload = JSON.parse(await fs.readFile(path.join(movedProjectPath, MANIFEST_REL_PATH), "utf8")) as Record<string, unknown>;

    expect(movedProjectId).toBe(projectId);
    expect(diskPayload.project_path).toBe(path.resolve(movedProjectPath));
    expect((await moved.listDocuments()).some((item) => item.path === "02_正文/章节/第一章.md")).toBe(true);
  });

  it("does not rewrite the manifest when scanned entries are unchanged", async () => {
    const manifest = new ProjectManifestService(projectPath);
    const manifestPath = path.join(projectPath, MANIFEST_REL_PATH);

    await manifest.rebuild();
    const firstStats = await fs.stat(manifestPath);

    await new Promise((resolve) => setTimeout(resolve, 20));
    await manifest.rebuild();
    const secondStats = await fs.stat(manifestPath);

    expect(secondStats.mtimeMs).toBe(firstStats.mtimeMs);
  });

  it("rewrites the manifest when a browsable file changes", async () => {
    const manifest = new ProjectManifestService(projectPath);
    const manifestPath = path.join(projectPath, MANIFEST_REL_PATH);

    await manifest.rebuild();
    const firstStats = await fs.stat(manifestPath);

    await new Promise((resolve) => setTimeout(resolve, 20));
    await fs.writeFile(path.join(projectPath, "01_大纲", "细纲.txt"), "outline updated", "utf8");
    await manifest.rebuild();
    const secondStats = await fs.stat(manifestPath);

    expect(secondStats.mtimeMs).toBeGreaterThan(firstStats.mtimeMs);
  });

  it("builds tree and subtree views", async () => {
    const manifest = new ProjectManifestService(projectPath);

    const tree = await manifest.tree({ force: true });
    const subtree = await manifest.subtree("02_正文", "manifest-demo");

    expect(tree.some((node) => node.path === "02_正文")).toBe(true);
    expect(subtree.kind).toBe("directory");
    expect(subtree.children.some((child) => child.path === "02_正文/章节")).toBe(true);
  });

  it("builds library cards with summaries", async () => {
    const manifest = new ProjectManifestService(projectPath);

    const libraries = await manifest.listLibraryCards();

    const styleRules = libraries.find((item) => item.key === "style_rules");
    expect(styleRules?.exists).toBe(true);
    expect(styleRules?.summary).toContain("冷静 克制");
  });

  it("builds project chrome snapshots with injected timeline", async () => {
    const manifest = new ProjectManifestService(projectPath);

    const snapshot = await manifest.projectChromeSnapshot(
      { path: projectPath, name: "manifest-demo" },
      [{ id: "timeline_1", time: "2026-06-01 11:00:00", source: "agent", summary: "demo", files: [], operations: [] }],
      { force: true }
    );

    expect(snapshot.current.name).toBe("manifest-demo");
    expect(snapshot.timeline).toHaveLength(1);
    expect(snapshot.tree.length).toBeGreaterThan(0);
    expect(snapshot.libraries.length).toBeGreaterThan(0);
  });
});
