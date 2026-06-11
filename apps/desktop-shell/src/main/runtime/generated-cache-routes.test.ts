import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GeneratedCacheService } from "@xiaoshuo/generated-cache";
import { handleGeneratedCacheRoutes } from "./generated-cache-routes.js";
import type { RuntimeContext } from "./types.js";

let tempDir = "";

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "xiaoshuo-generated-cache-route-"));
});

afterEach(async () => {
  if (tempDir) {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

function createContext(): RuntimeContext {
  return {
    projectRoot: "D:\\xiaoshuo\\ts-migration",
    jobManager: {} as RuntimeContext["jobManager"],
    projectSession: {} as RuntimeContext["projectSession"],
    documentSessions: new Map()
  };
}

function createDeps(writeJson = vi.fn()): Parameters<typeof handleGeneratedCacheRoutes>[4] {
  return {
    ensureProjectSessionCurrent: vi.fn().mockResolvedValue({ path: tempDir, name: "Demo" }),
    readJsonBody: vi.fn(),
    readRawBody: vi.fn(),
    parseJsonRecord: vi.fn(),
    rebuildProjectManifest: vi.fn(),
    stringValue: (value: unknown) => String(value || ""),
    writeJson
  };
}

describe("handleGeneratedCacheRoutes", () => {
  it("returns pending generated cache metadata and content", async () => {
    const service = new GeneratedCacheService({
      projectRoot: tempDir,
      now: () => "2026-06-01 12:00:00",
      idFactory: () => "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6"
    });
    await service.create({
      source: "skill",
      skill_id: "body_generate",
      target_paths: ["02_正文/第一章.txt"],
      mode: "replace"
    });
    await service.replace("a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6", "第一章正文");

    const writeJson = vi.fn();
    const handled = await handleGeneratedCacheRoutes(
      { method: "GET" } as IncomingMessage,
      {} as ServerResponse,
      "/api/agent/generated/cache/a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6",
      createContext(),
      createDeps(writeJson)
    );

    expect(handled).toBe(true);
    expect(writeJson).toHaveBeenCalledWith(
      expect.anything(),
      200,
      expect.objectContaining({
        content: "第一章正文",
        meta: expect.objectContaining({
          cache_id: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6",
          status: "pending",
          target_paths: ["02_正文/第一章.txt"]
        })
      })
    );
  });

  it("returns 404 when generated cache content cannot be recovered", async () => {
    const writeJson = vi.fn();
    const handled = await handleGeneratedCacheRoutes(
      { method: "GET" } as IncomingMessage,
      {} as ServerResponse,
      "/api/agent/generated/cache/a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6",
      createContext(),
      createDeps(writeJson)
    );

    expect(handled).toBe(true);
    expect(writeJson).toHaveBeenCalledWith(
      expect.anything(),
      404,
      expect.objectContaining({
        detail: expect.stringContaining("生成缓存")
      })
    );
  });
});
