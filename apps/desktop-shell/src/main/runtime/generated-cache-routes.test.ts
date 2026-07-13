import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GeneratedCacheService } from "@xiaoshuo/generated-cache";
import { handleGeneratedCacheRoutes } from "./generated-cache-routes.js";
import type { RuntimeContext } from "./types.js";

const runtimeMocks = vi.hoisted(() => ({
  commitGeneratedCache: vi.fn()
}));

vi.mock("./agent-runtime-registry.js", () => ({
  getProjectAgentRuntime: vi.fn(() => runtimeMocks)
}));

let tempDir = "";

beforeEach(async () => {
  vi.clearAllMocks();
  runtimeMocks.commitGeneratedCache.mockResolvedValue({
    run_id: "run_generated_cache",
    cache_id: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6",
    saved_paths: ["02_正文/第一章.txt"],
    journal_ids: ["journal_1"],
    replayed: false,
    cache: {}
  });
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
  it("delegates typed cached saves to the durable runtime committer", async () => {
    const writeJson = vi.fn();
    const deps = createDeps(writeJson);
    vi.mocked(deps.readJsonBody).mockResolvedValue({
      cache_id: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6",
      content: "",
      skill_id: "chat_generated",
      mode: "replace",
      target_paths: ["02_正文/第一章.txt"],
      target_path: "",
      chapter: 0
    });

    const handled = await handleGeneratedCacheRoutes(
      { method: "POST" } as IncomingMessage,
      {} as ServerResponse,
      "/api/agent/generated/save",
      createContext(),
      deps
    );

    expect(handled).toBe(true);
    expect(runtimeMocks.commitGeneratedCache).toHaveBeenCalledWith(expect.objectContaining({
      cache_id: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6",
      skill_id: "chat_generated",
      target_paths: ["02_正文/第一章.txt"],
      cleanup_content: true
    }));
    expect(writeJson).toHaveBeenCalledWith(expect.anything(), 200, {
      saved_paths: ["02_正文/第一章.txt"],
      save_plan: undefined
    });
  });

  it("delegates direct generated content to a deterministic durable cache commit", async () => {
    const writeJson = vi.fn();
    const deps = createDeps(writeJson);
    vi.mocked(deps.readJsonBody).mockResolvedValue({
      cache_id: "",
      content: "草稿正文",
      skill_id: "chat_generated",
      mode: "replace",
      target_paths: [],
      target_path: "02_正文/第一章.txt",
      chapter: 1,
      save_plan: {
        action: "no_save",
        mode: "replace",
        target_paths: [],
        segments: [],
        reason: "legacy direct draft ignores this field",
        confidence: 1,
        requires_confirmation: false,
        should_auto_commit: false,
        source: "chat",
        skill_id: "chat_generated"
      }
    });

    const handled = await handleGeneratedCacheRoutes(
      { method: "POST" } as IncomingMessage,
      {} as ServerResponse,
      "/api/agent/generated/save",
      createContext(),
      deps
    );

    expect(handled).toBe(true);
    expect(runtimeMocks.commitGeneratedCache).toHaveBeenCalledWith(expect.objectContaining({
      content: "草稿正文",
      target_paths: ["02_正文/第一章.txt"],
      mode: "replace"
    }));
    expect(runtimeMocks.commitGeneratedCache.mock.calls[0]?.[0].save_plan).toBeUndefined();
    expect(writeJson).toHaveBeenCalledWith(
      expect.anything(),
      200,
      expect.objectContaining({
        saved_paths: ["02_正文/第一章.txt"],
        save_plan: expect.objectContaining({ action: "no_save" })
      })
    );
  });

  it("returns a stable quality report when the runtime rejects a generated save", async () => {
    runtimeMocks.commitGeneratedCache.mockRejectedValue(Object.assign(new Error("quality rejected"), {
      code: "QUALITY_GATE_REJECTED",
      report: { artifact_type: "generated_text", passed: false }
    }));
    const writeJson = vi.fn();
    const deps = createDeps(writeJson);
    vi.mocked(deps.readJsonBody).mockResolvedValue({
      cache_id: "",
      content: "#不合规标题",
      skill_id: "chat_generated",
      mode: "replace",
      target_paths: ["02_正文/第一章.txt"],
      target_path: "",
      chapter: 1
    });

    const handled = await handleGeneratedCacheRoutes(
      { method: "POST" } as IncomingMessage,
      {} as ServerResponse,
      "/api/agent/generated/save",
      createContext(),
      deps
    );

    expect(handled).toBe(true);
    expect(writeJson).toHaveBeenCalledWith(expect.anything(), 422, expect.objectContaining({
      code: "QUALITY_GATE_REJECTED"
    }));
  });

  it("delegates cached sectioned saves without writing through PromptSkillRunner", async () => {
    runtimeMocks.commitGeneratedCache.mockResolvedValueOnce({
      run_id: "run_style",
      cache_id: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6",
      saved_paths: [
        "00_设定集/风格库/写作风格.txt",
        "00_设定集/风格库/风格示例.txt",
        "00_设定集/风格库/参考素材.txt"
      ],
      journal_ids: ["journal_style_1", "journal_style_2", "journal_style_3"],
      replayed: false,
      cache: {}
    });
    const writeJson = vi.fn();
    const deps = createDeps(writeJson);
    vi.mocked(deps.readJsonBody).mockResolvedValue({
      cache_id: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6",
      content: "",
      skill_id: "style_extract",
      mode: "replace",
      target_paths: ["02_正文/不应写入.txt"],
      target_path: "",
      chapter: 0,
      save_plan: {
        action: "no_save",
        mode: "replace",
        target_paths: [],
        segments: [],
        reason: "response compatibility",
        confidence: 1,
        requires_confirmation: false,
        should_auto_commit: false,
        source: "skill",
        skill_id: "style_extract"
      }
    });

    const handled = await handleGeneratedCacheRoutes(
      { method: "POST" } as IncomingMessage,
      {} as ServerResponse,
      "/api/agent/generated/save",
      createContext(),
      deps
    );

    expect(handled).toBe(true);
    expect(runtimeMocks.commitGeneratedCache).toHaveBeenCalledWith(expect.objectContaining({
      cache_id: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6",
      skill_id: "style_extract",
      cleanup_content: true
    }));
    expect(writeJson).toHaveBeenCalledWith(expect.anything(), 200, {
      saved_paths: [
        "00_设定集/风格库/写作风格.txt",
        "00_设定集/风格库/风格示例.txt",
        "00_设定集/风格库/参考素材.txt"
      ],
      save_plan: expect.objectContaining({ reason: "response compatibility" })
    });
    expect(await fs.stat(path.join(tempDir, "00_设定集", "风格库", "写作风格.txt")).catch(() => null)).toBeNull();
    expect(await fs.stat(path.join(tempDir, "00_设定集", "风格库", "风格示例.txt")).catch(() => null)).toBeNull();
    expect(await fs.stat(path.join(tempDir, "00_设定集", "风格库", "参考素材.txt")).catch(() => null)).toBeNull();
  });

  it("allows raw sectioned content with no caller-supplied target paths", async () => {
    runtimeMocks.commitGeneratedCache.mockResolvedValueOnce({
      run_id: "run_lore",
      cache_id: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6",
      saved_paths: ["00_设定集/设定集/人物设定.txt"],
      journal_ids: ["journal_lore"],
      replayed: false,
      cache: {}
    });
    const writeJson = vi.fn();
    const deps = createDeps(writeJson);
    vi.mocked(deps.readJsonBody).mockResolvedValue({
      cache_id: "",
      content: "人物设定\n林烬：流亡剑修。",
      skill_id: "lore_extract",
      mode: "replace",
      target_paths: [],
      target_path: "",
      chapter: 0
    });

    const handled = await handleGeneratedCacheRoutes(
      { method: "POST" } as IncomingMessage,
      {} as ServerResponse,
      "/api/agent/generated/save",
      createContext(),
      deps
    );

    expect(handled).toBe(true);
    expect(runtimeMocks.commitGeneratedCache).toHaveBeenCalledWith(expect.objectContaining({
      content: "人物设定\n林烬：流亡剑修。",
      skill_id: "lore_extract",
      target_paths: []
    }));
    expect(writeJson).toHaveBeenCalledWith(expect.anything(), 200, {
      saved_paths: ["00_设定集/设定集/人物设定.txt"],
      save_plan: undefined
    });
  });

  it("maps cache skill identity conflicts to a 409 response", async () => {
    runtimeMocks.commitGeneratedCache.mockRejectedValueOnce(Object.assign(
      new Error("生成缓存技能身份不匹配"),
      { code: "GENERATED_CACHE_SKILL_MISMATCH" }
    ));
    const writeJson = vi.fn();
    const deps = createDeps(writeJson);
    vi.mocked(deps.readJsonBody).mockResolvedValue({
      cache_id: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6",
      content: "",
      skill_id: "style_extract",
      mode: "replace",
      target_paths: [],
      target_path: "",
      chapter: 0
    });

    const handled = await handleGeneratedCacheRoutes(
      { method: "POST" } as IncomingMessage,
      {} as ServerResponse,
      "/api/agent/generated/save",
      createContext(),
      deps
    );

    expect(handled).toBe(true);
    expect(writeJson).toHaveBeenCalledWith(expect.anything(), 409, {
      detail: "生成缓存技能身份不匹配",
      code: "GENERATED_CACHE_SKILL_MISMATCH"
    });
    expect(vi.mocked(deps.rebuildProjectManifest)).not.toHaveBeenCalled();
  });

  it("delegates the compatibility cache commit endpoint to the same runtime method", async () => {
    const writeJson = vi.fn();
    const deps = createDeps(writeJson);
    vi.mocked(deps.readRawBody).mockResolvedValue(Buffer.from(JSON.stringify({
      mode: "replace",
      target_paths: ["02_正文/第一章.txt"]
    })));
    vi.mocked(deps.parseJsonRecord).mockReturnValue({
      mode: "replace",
      target_paths: ["02_正文/第一章.txt"]
    });

    const handled = await handleGeneratedCacheRoutes(
      { method: "POST" } as IncomingMessage,
      {} as ServerResponse,
      "/api/agent/generated/cache/a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6/commit",
      createContext(),
      deps
    );

    expect(handled).toBe(true);
    expect(runtimeMocks.commitGeneratedCache).toHaveBeenCalledWith(expect.objectContaining({
      cache_id: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6",
      target_paths: ["02_正文/第一章.txt"],
      cleanup_content: true
    }));
    expect(writeJson).toHaveBeenCalledWith(expect.anything(), 200, {
      saved_paths: ["02_正文/第一章.txt"]
    });
  });

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
