import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AGENT_DIR } from "@xiaoshuo/project-session";
import { ProjectFileManifestService } from "./project-file-manifest.js";

let tempDir = "";

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "xiaoshuo-file-manifest-"));
  await fs.mkdir(path.join(tempDir, "01_大纲"), { recursive: true });
  await fs.mkdir(path.join(tempDir, "02_设定"), { recursive: true });
  await fs.mkdir(path.join(tempDir, AGENT_DIR, "cache"), { recursive: true });
  await fs.mkdir(path.join(tempDir, "node_modules", "pkg"), { recursive: true });
  await fs.writeFile(path.join(tempDir, "01_大纲", "章纲.txt"), "第一章：入门\n第二章：试炼", "utf8");
  await fs.writeFile(path.join(tempDir, "02_设定", "人物设定.md"), "# 人物设定\n林默：主角。", "utf8");
  await fs.writeFile(path.join(tempDir, "02_设定", "素材.jsonl"), "{\"text\":\"伏笔\"}\n", "utf8");
  await fs.writeFile(path.join(tempDir, AGENT_DIR, "cache", "ignored.txt"), "ignore", "utf8");
  await fs.writeFile(path.join(tempDir, "node_modules", "pkg", "ignored.txt"), "ignore", "utf8");
  await fs.writeFile(path.join(tempDir, "02_设定", "blocked.json"), "{}", "utf8");
});

afterEach(async () => {
  if (tempDir) {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

describe("project-file-manifest", () => {
  it("builds a lightweight manifest for allowed project text files", async () => {
    const service = new ProjectFileManifestService({
      projectRoot: tempDir,
      now: () => "2026-07-07T00:00:00.000Z"
    });

    const manifest = await service.rebuild();

    expect(manifest).toMatchObject({
      version: 1,
      projectRoot: tempDir,
      generatedAt: "2026-07-07T00:00:00.000Z"
    });
    expect(manifest.entries.map((entry) => entry.path)).toEqual([
      "01_大纲/章纲.txt",
      "02_设定/人物设定.md",
      "02_设定/素材.jsonl"
    ]);
    expect(manifest.entries.find((entry) => entry.path === "02_设定/人物设定.md")?.title).toBe("人物设定");
    expect(manifest.entries.find((entry) => entry.path === "02_设定/人物设定.md")?.keywords).toContain("人物设定");

    const saved = JSON.parse(await fs.readFile(path.join(tempDir, AGENT_DIR, "file-manifest.json"), "utf8")) as { entries: unknown[] };
    expect(saved.entries).toHaveLength(3);
  });

  it("reads an existing manifest before rebuilding", async () => {
    const service = new ProjectFileManifestService({ projectRoot: tempDir });
    await service.rebuild();
    await fs.rm(path.join(tempDir, "01_大纲", "章纲.txt"));

    const manifest = await service.readOrBuild();

    expect(manifest.entries.some((entry) => entry.path === "01_大纲/章纲.txt")).toBe(true);
  });
});
