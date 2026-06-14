import AdmZip from "adm-zip";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { exportProjectArchive, importProjectArchive, importProjectArchiveToExisting } from "./project-archive.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "arcwriter-project-archive-"));
  tempDirs.push(tempDir);
  return tempDir;
}

async function writeText(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
}

describe("project archive", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((tempDir) => fs.rm(tempDir, { recursive: true, force: true })));
  });

  it("exports the full project as zip while excluding non-project transient files", async () => {
    const tempDir = await makeTempDir();
    const projectPath = path.join(tempDir, "Demo Novel");
    await writeText(path.join(projectPath, "02_正文", "正文.txt"), "正文内容");
    await writeText(path.join(projectPath, "00_设定集", ".agent", "project_meta.json"), "{\"display_name\":\"Demo Novel\"}");
    await writeText(path.join(projectPath, ".git", "config"), "private git data");
    await writeText(path.join(projectPath, "node_modules", "pkg", "index.js"), "module data");
    await writeText(path.join(projectPath, "debug.log"), "log data");
    await writeText(path.join(projectPath, "scratch.tmp"), "tmp data");

    const archivePath = await exportProjectArchive({
      projectPath,
      targetPath: path.join(tempDir, "Demo Novel.arcwriter.zip")
    });

    const zip = new AdmZip(archivePath);
    const entryNames = zip.getEntries().map((entry) => entry.entryName);
    expect(entryNames).toContain("02_正文/正文.txt");
    expect(entryNames).toContain("00_设定集/.agent/project_meta.json");
    expect(entryNames).not.toContain(".git/config");
    expect(entryNames).not.toContain("node_modules/pkg/index.js");
    expect(entryNames).not.toContain("debug.log");
    expect(entryNames).not.toContain("scratch.tmp");
  });

  it("imports a project archive into a non-conflicting folder", async () => {
    const tempDir = await makeTempDir();
    const projectPath = path.join(tempDir, "Novel");
    await writeText(path.join(projectPath, "02_正文", "正文.txt"), "第一章");
    const archivePath = await exportProjectArchive({
      projectPath,
      targetPath: path.join(tempDir, "Novel.arcwriter.zip")
    });
    const importParent = path.join(tempDir, "imports");
    await fs.mkdir(path.join(importParent, "Novel"), { recursive: true });

    const importedPath = await importProjectArchive({
      archivePath,
      targetParentPath: importParent,
      now: () => new Date("2026-06-14T01:02:03")
    });

    expect(path.basename(importedPath)).toBe("Novel-20260614-010203");
    await expect(fs.readFile(path.join(importedPath, "02_正文", "正文.txt"), "utf8")).resolves.toBe("第一章");
  });

  it("rejects zip entries that try to write outside the import target", async () => {
    const tempDir = await makeTempDir();
    const archivePath = path.join(tempDir, "unsafe.arcwriter.zip");
    const zip = new AdmZip();
    zip.addFile("C:/evil.txt", Buffer.from("nope", "utf8"));
    zip.writeZip(archivePath);
    const importParent = path.join(tempDir, "imports");
    await fs.mkdir(importParent, { recursive: true });

    await expect(importProjectArchive({ archivePath, targetParentPath: importParent })).rejects.toThrow("不安全路径");
  });

  it("imports a project archive over an existing project after safe path validation", async () => {
    const tempDir = await makeTempDir();
    const sourceProject = path.join(tempDir, "Cloud Source");
    const targetProject = path.join(tempDir, "Current Project");
    await writeText(path.join(sourceProject, "02_正文", "云端.txt"), "云端正文");
    await writeText(path.join(targetProject, "02_正文", "本地.txt"), "旧正文");
    const archivePath = await exportProjectArchive({
      projectPath: sourceProject,
      targetPath: path.join(tempDir, "Cloud Source.arcwriter.zip")
    });

    await importProjectArchiveToExisting({ archivePath, targetProjectPath: targetProject });

    await expect(fs.readFile(path.join(targetProject, "02_正文", "云端.txt"), "utf8")).resolves.toBe("云端正文");
    await expect(fs.stat(path.join(targetProject, "02_正文", "本地.txt"))).rejects.toThrow();
  });

  it("rejects unsafe overwrite archives before clearing the existing project", async () => {
    const tempDir = await makeTempDir();
    const targetProject = path.join(tempDir, "Current Project");
    await writeText(path.join(targetProject, "02_正文", "本地.txt"), "保留正文");
    const archivePath = path.join(tempDir, "unsafe.arcwriter.zip");
    const zip = new AdmZip();
    zip.addFile("C:/evil.txt", Buffer.from("nope", "utf8"));
    zip.writeZip(archivePath);

    await expect(importProjectArchiveToExisting({ archivePath, targetProjectPath: targetProject })).rejects.toThrow("不安全路径");
    await expect(fs.readFile(path.join(targetProject, "02_正文", "本地.txt"), "utf8")).resolves.toBe("保留正文");
  });
});
