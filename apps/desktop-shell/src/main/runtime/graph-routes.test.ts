import { afterEach, describe, expect, it, vi } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { handleGraphRoutes } from "./graph-routes.js";
import type { RuntimeContext } from "./types.js";

const mockGetStatus = vi.hoisted(() => vi.fn());
const mockRebuildGraph = vi.hoisted(() => vi.fn());
const mockBuildWritingContext = vi.hoisted(() => vi.fn());
const mockCheckConsistency = vi.hoisted(() => vi.fn());
const mockClose = vi.hoisted(() => vi.fn());

vi.mock("@xiaoshuo/vector-service", () => ({
  GraphContext: class {
    getStatus = mockGetStatus;
    rebuildGraph = mockRebuildGraph;
    buildWritingContext = mockBuildWritingContext;
    checkConsistency = mockCheckConsistency;
    close = mockClose;
  }
}));

vi.mock("./license-guard.js", () => ({
  writeAiLicenseRequiredIfNeeded: vi.fn().mockResolvedValue(false)
}));

function createContext(): RuntimeContext {
  return {
    projectRoot: "D:\\xiaoshuo\\ts-migration",
    jobManager: {} as any,
    projectSession: {} as any,
    documentSessions: new Map()
  };
}

function createResponse(): ServerResponse {
  return {} as ServerResponse;
}

describe("graph-routes", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns 400 when no project is opened", async () => {
    const writeJson = vi.fn();
    const deps = {
      ensureProjectSessionCurrent: vi.fn().mockResolvedValue({ path: "" }),
      readJsonBody: vi.fn(),
      stringValue: vi.fn(),
      writeJson
    };

    const handled = await handleGraphRoutes(
      { method: "GET" } as IncomingMessage,
      createResponse(),
      "/api/graph/status",
      new URLSearchParams(),
      createContext(),
      deps
    );

    expect(handled).toBe(true);
    expect(writeJson).toHaveBeenCalledWith(expect.anything(), 400, { detail: "尚未打开项目" });
  });

  it("handles GET /api/graph/status correctly", async () => {
    mockGetStatus.mockReturnValue({ entities: 10, relations: 5, claims: 20, communities: 2 });
    const writeJson = vi.fn();
    const deps = {
      ensureProjectSessionCurrent: vi.fn().mockResolvedValue({ path: "D:\\projects\\novel" }),
      readJsonBody: vi.fn(),
      stringValue: vi.fn(),
      writeJson
    };

    const handled = await handleGraphRoutes(
      { method: "GET" } as IncomingMessage,
      createResponse(),
      "/api/graph/status",
      new URLSearchParams(),
      createContext(),
      deps
    );

    expect(handled).toBe(true);
    expect(mockGetStatus).toHaveBeenCalled();
    expect(writeJson).toHaveBeenCalledWith(expect.anything(), 200, { entities: 10, relations: 5, claims: 20, communities: 2 });
    expect(mockClose).toHaveBeenCalled();
  });

  it("handles POST /api/graph/rebuild correctly", async () => {
    mockGetStatus.mockReturnValue({ entities: 12, relations: 6, claims: 24, communities: 2 });
    const writeJson = vi.fn();
    const deps = {
      ensureProjectSessionCurrent: vi.fn().mockResolvedValue({ path: "D:\\projects\\novel" }),
      readJsonBody: vi.fn(),
      stringValue: vi.fn(),
      writeJson
    };

    const handled = await handleGraphRoutes(
      { method: "POST" } as IncomingMessage,
      createResponse(),
      "/api/graph/rebuild",
      new URLSearchParams(),
      createContext(),
      deps
    );

    expect(handled).toBe(true);
    expect(mockRebuildGraph).toHaveBeenCalled();
    expect(writeJson).toHaveBeenCalledWith(expect.anything(), 200, { status: "ok", entities: 12, relations: 6, claims: 24, communities: 2 });
    expect(mockClose).toHaveBeenCalled();
  });

  it("handles POST /api/graph/writing-context correctly", async () => {
    mockBuildWritingContext.mockResolvedValue("mocked context content");
    const writeJson = vi.fn();
    const deps = {
      ensureProjectSessionCurrent: vi.fn().mockResolvedValue({ path: "D:\\projects\\novel" }),
      readJsonBody: vi.fn().mockResolvedValue({ query: "林风", top_k: 8 }),
      stringValue: vi.fn((val) => String(val || "")),
      writeJson
    };

    const handled = await handleGraphRoutes(
      { method: "POST" } as IncomingMessage,
      createResponse(),
      "/api/graph/writing-context",
      new URLSearchParams(),
      createContext(),
      deps
    );

    expect(handled).toBe(true);
    expect(mockBuildWritingContext).toHaveBeenCalledWith("林风", { topK: 8 });
    expect(writeJson).toHaveBeenCalledWith(expect.anything(), 200, { context: "mocked context content" });
    expect(mockClose).toHaveBeenCalled();
  });

  it("handles POST /api/graph/check correctly", async () => {
    mockCheckConsistency.mockResolvedValue({ score: 95, risks: ["设定偏离"], reason: "已匹配" });
    const writeJson = vi.fn();
    const deps = {
      ensureProjectSessionCurrent: vi.fn().mockResolvedValue({ path: "D:\\projects\\novel" }),
      readJsonBody: vi.fn().mockResolvedValue({ text: "林风拔出长枪" }),
      stringValue: vi.fn((val) => String(val || "")),
      writeJson
    };

    const handled = await handleGraphRoutes(
      { method: "POST" } as IncomingMessage,
      createResponse(),
      "/api/graph/check",
      new URLSearchParams(),
      createContext(),
      deps
    );

    expect(handled).toBe(true);
    expect(mockCheckConsistency).toHaveBeenCalledWith("林风拔出长枪");
    expect(writeJson).toHaveBeenCalledWith(expect.anything(), 200, { score: 95, risks: ["设定偏离"], reason: "已匹配" });
    expect(mockClose).toHaveBeenCalled();
  });

  it("returns 500 on unexpected exceptions", async () => {
    mockGetStatus.mockImplementation(() => {
      throw new Error("Sqlite database lock error");
    });
    const writeJson = vi.fn();
    const deps = {
      ensureProjectSessionCurrent: vi.fn().mockResolvedValue({ path: "D:\\projects\\novel" }),
      readJsonBody: vi.fn(),
      stringValue: vi.fn(),
      writeJson
    };

    const handled = await handleGraphRoutes(
      { method: "GET" } as IncomingMessage,
      createResponse(),
      "/api/graph/status",
      new URLSearchParams(),
      createContext(),
      deps
    );

    expect(handled).toBe(true);
    expect(writeJson).toHaveBeenCalledWith(expect.anything(), 500, { detail: "Sqlite database lock error" });
    expect(mockClose).toHaveBeenCalled();
  });
});
