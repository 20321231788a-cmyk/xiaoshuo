import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GeneratedCacheService } from "./service.js";

let tempDir = "";

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "xiaoshuo-generated-cache-"));
  await fs.mkdir(path.join(tempDir, "01_大纲"), { recursive: true });
  await fs.mkdir(path.join(tempDir, "02_正文"), { recursive: true });
  await fs.writeFile(path.join(tempDir, "01_大纲", "大纲.txt"), "第一章", "utf8");
});

afterEach(async () => {
  if (tempDir) {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

describe("generated-cache-service", () => {
  it("creates a cache entry with empty content and metadata", async () => {
    const service = new GeneratedCacheService({
      projectRoot: tempDir,
      now: () => "2026-06-01 12:00:00",
      idFactory: () => "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6"
    });

    const meta = await service.create({
      source: "chat",
      target_paths: ["02_正文/第一章.txt"],
      skill_id: "write_chapter",
      mode: "replace"
    });

    expect(meta.cache_id).toBe("a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6");
    expect(meta.status).toBe("pending");
    expect(meta.source).toBe("chat");
    expect(meta.skill_id).toBe("write_chapter");
    expect(meta.target_paths).toEqual(["02_正文/第一章.txt"]);
    expect(meta.created_at).toBe("2026-06-01 12:00:00");
    expect(meta.updated_at).toBe("2026-06-01 12:00:00");

    const content = await service.readContent("a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6");
    expect(content).toBe("");
  });

  it("appends and replaces cache content and updates characters count", async () => {
    const service = new GeneratedCacheService({
      projectRoot: tempDir,
      now: () => "2026-06-01 12:05:00",
      idFactory: () => "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6"
    });

    await service.create({ source: "skill" });

    // Append text
    let meta = await service.append("a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6", "Hello ");
    expect(meta.chars).toBe(6);
    expect(await service.readContent("a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6")).toBe("Hello ");

    meta = await service.append("a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6", "World!");
    expect(meta.chars).toBe(12);
    expect(await service.readContent("a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6")).toBe("Hello World!");

    // Replace text
    meta = await service.replace("a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6", "New text");
    expect(meta.chars).toBe(8);
    expect(await service.readContent("a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6")).toBe("New text");
  });

  it("commits pending cache using replace mode", async () => {
    const service = new GeneratedCacheService({
      projectRoot: tempDir,
      now: () => "2026-06-01 12:10:00",
      idFactory: () => "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6"
    });

    await service.create({
      source: "chat",
      target_paths: ["02_正文/第一章.txt"],
      mode: "replace"
    });

    await service.replace("a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6", "   第一章正文内容   ");

    const saved = await service.commitToTargets("a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6");
    expect(saved).toEqual(["02_正文/第一章.txt"]);

    // Verify file content (stripped by default)
    const diskContent = await fs.readFile(path.join(tempDir, "02_正文", "第一章.txt"), "utf8");
    expect(diskContent).toBe("第一章正文内容");

    // Verify state transition to committed and body cleanup
    const meta = await service.get("a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6");
    expect(meta.status).toBe("committed");
    expect(meta.committed_at).toBe("2026-06-01 12:10:00");
    expect(meta.saved_paths).toEqual(["02_正文/第一章.txt"]);

    await expect(service.readContent("a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6")).rejects.toThrow();
  });

  it("commits pending cache using append mode with separators", async () => {
    const service = new GeneratedCacheService({
      projectRoot: tempDir,
      now: () => "2026-06-01 12:15:00",
      idFactory: () => "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6"
    });

    // Write some initial outline
    await fs.writeFile(path.join(tempDir, "01_大纲", "大纲.txt"), "已有大纲段落", "utf8");

    await service.create({
      source: "chat",
      target_paths: ["01_大纲/大纲.txt"],
      mode: "append"
    });

    await service.replace("a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6", "   追加的新增段落   ");

    const saved = await service.commitToTargets("a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6", undefined, { stripContent: true });
    expect(saved).toEqual(["01_大纲/大纲.txt"]);

    const diskContent = await fs.readFile(path.join(tempDir, "01_大纲", "大纲.txt"), "utf8");
    // Verify append template: existing.trimEnd() + "\n\n---\n" + content.trim() + "\n"
    expect(diskContent).toBe("已有大纲段落\n\n---\n追加的新增段落\n");
  });

  it("can commit to multiple targets and ignore duplicates", async () => {
    const service = new GeneratedCacheService({
      projectRoot: tempDir,
      now: () => "2026-06-01 12:20:00",
      idFactory: () => "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6"
    });

    await service.create({
      source: "skill",
      target_paths: ["02_正文/第一章.txt", "02_正文/第二章.txt"]
    });

    await service.replace("a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6", "重复生成文本");

    // Commit override paths including duplicates
    const saved = await service.commitToTargets("a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6", [
      "02_正文/第一章.txt",
      "02_正文/第一章.txt",
      "02_正文/第二章.txt"
    ]);

    expect(saved).toEqual(["02_正文/第一章.txt", "02_正文/第二章.txt"]);

    expect(await fs.readFile(path.join(tempDir, "02_正文", "第一章.txt"), "utf8")).toBe("重复生成文本");
    expect(await fs.readFile(path.join(tempDir, "02_正文", "第二章.txt"), "utf8")).toBe("重复生成文本");
  });

  it("refuses to overwrite restricted file types or paths", async () => {
    const service = new GeneratedCacheService({
      projectRoot: tempDir,
      idFactory: () => "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6"
    });

    await service.create({
      source: "chat",
      target_paths: ["02_正文/code.py"] // forbidden extension
    });
    await service.replace("a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6", "print(1)");

    await expect(service.commitToTargets("a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6")).rejects.toThrow("禁止操作该类型文件");
  });

  it("can discard a pending cache and delete its body file", async () => {
    const service = new GeneratedCacheService({
      projectRoot: tempDir,
      now: () => "2026-06-01 12:30:00",
      idFactory: () => "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6"
    });

    await service.create({ source: "chat" });
    await service.replace("a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6", "要废弃的草稿");

    const discarded = await service.discard("a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6");
    expect(discarded.status).toBe("discarded");
    expect(discarded.discarded_at).toBe("2026-06-01 12:30:00");

    // Body is missing
    await expect(service.readContent("a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6")).rejects.toThrow();

    // Meta is still readable and shows discarded state
    const meta = await service.get("a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6");
    expect(meta.status).toBe("discarded");
  });

  it("can mark a cache as failed with error message", async () => {
    const service = new GeneratedCacheService({
      projectRoot: tempDir,
      now: () => "2026-06-01 12:40:00",
      idFactory: () => "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6"
    });

    await service.create({ source: "chat" });
    const failed = await service.markFailed("a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6", "API Timeout");
    expect(failed.status).toBe("failed");
    expect(failed.error).toBe("API Timeout");
    expect(failed.failed_at).toBe("2026-06-01 12:40:00");
  });

  it("cleans up expired cache directories but keeps active ones", async () => {
    const rootDir = path.join(tempDir, "00_设定集", ".agent", "generated_cache");

    // Cache 1: Pending
    const dir1 = path.join(rootDir, "11111111111111111111111111111111");
    await fs.mkdir(dir1, { recursive: true });
    await fs.writeFile(path.join(dir1, "metadata.json"), JSON.stringify({
      cache_id: "11111111111111111111111111111111",
      status: "pending",
      created_at: "2026-06-01 12:00:00",
      updated_at: "2026-06-01 12:00:00"
    }), "utf8");
    await fs.writeFile(path.join(dir1, "content.txt"), "pending text", "utf8");

    // Cache 2: Settled (Expired) - created 8 days before 2026-06-10 12:00:00 (e.g. 2026-06-02)
    const dir2 = path.join(rootDir, "22222222222222222222222222222222");
    await fs.mkdir(dir2, { recursive: true });
    await fs.writeFile(path.join(dir2, "metadata.json"), JSON.stringify({
      cache_id: "22222222222222222222222222222222",
      status: "committed",
      created_at: "2026-06-02 12:00:00",
      committed_at: "2026-06-02 12:05:00",
      updated_at: "2026-06-02 12:05:00"
    }), "utf8");
    await fs.writeFile(path.join(dir2, "content.txt"), "", "utf8");

    // Cache 3: Settled (Fresh) - created 1 hour before 2026-06-10 12:00:00
    const dir3 = path.join(rootDir, "33333333333333333333333333333333");
    await fs.mkdir(dir3, { recursive: true });
    await fs.writeFile(path.join(dir3, "metadata.json"), JSON.stringify({
      cache_id: "33333333333333333333333333333333",
      status: "committed",
      created_at: "2026-06-10 11:00:00",
      committed_at: "2026-06-10 11:05:00",
      updated_at: "2026-06-10 11:05:00"
    }), "utf8");
    await fs.writeFile(path.join(dir3, "content.txt"), "", "utf8");

    const service = new GeneratedCacheService({
      projectRoot: tempDir,
      now: () => "2026-06-10 12:00:00"
    });

    const result = await service.cleanupExpired();
    expect(result.ok).toBe(true);
    expect(result.deleted).toBe(1); // Only dir2 deleted
    expect(result.kept).toBe(2);    // dir1 and dir3 kept

    // Assert directories exist/missing
    await expect(fs.access(dir1)).resolves.toBeUndefined();
    await expect(fs.access(dir2)).rejects.toThrow();
    await expect(fs.access(dir3)).resolves.toBeUndefined();
  });
});
