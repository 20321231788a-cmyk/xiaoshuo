import { afterEach, describe, expect, it, vi } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { handleVectorRoutes } from "./vector-routes.js";
import type { RuntimeContext } from "./types.js";

const mockEmbeddingTest = vi.hoisted(() => vi.fn());
const mockVectorIndexConstructor = vi.hoisted(() => vi.fn());
const mockVectorClose = vi.hoisted(() => vi.fn());
const mockWriteAiLicenseRequiredIfNeeded = vi.hoisted(() => vi.fn());

vi.mock("@xiaoshuo/vector-service", () => ({
  EmbeddingClient: class {
    constructor(public readonly config: unknown) {}
    test = mockEmbeddingTest;
  },
  VectorIndex: class {
    constructor(projectPath: string) {
      mockVectorIndexConstructor(projectPath);
    }
    status = vi.fn();
    rebuild = vi.fn();
    processPending = vi.fn();
    search = vi.fn();
    close = mockVectorClose;
  }
}));

vi.mock("./license-guard.js", () => ({
  writeAiLicenseRequiredIfNeeded: mockWriteAiLicenseRequiredIfNeeded
}));

function createContext(): RuntimeContext {
  return {
    projectRoot: "D:\\xiaoshuo\\ts-migration",
    jobManager: {} as RuntimeContext["jobManager"],
    projectSession: {} as RuntimeContext["projectSession"],
    documentSessions: new Map()
  };
}

function createResponse(): ServerResponse {
  return {} as ServerResponse;
}

describe("vector-routes", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("tests embedding draft config without opening the vector index", async () => {
    mockWriteAiLicenseRequiredIfNeeded.mockResolvedValue(false);
    mockEmbeddingTest.mockResolvedValue({
      ok: true,
      model: "ep-draft",
      configured_model: "ep-draft",
      base_url: "https://ark.cn-beijing.volces.com/api/v3",
      provider: "doubao_multimodal",
      dimensions: 1024
    });
    const writeJson = vi.fn();

    const handled = await handleVectorRoutes(
      { method: "POST" } as IncomingMessage,
      createResponse(),
      "/api/vector/test",
      new URLSearchParams(),
      createContext(),
      {
        ensureProjectSessionCurrent: vi.fn().mockResolvedValue({ path: "D:\\projects\\novel" }),
        readJsonBody: vi.fn().mockResolvedValue({
          embedding_enabled: true,
          embedding_api_key: "draft-key",
          embedding_base_url: "https://ark.cn-beijing.volces.com/api/v3",
          embedding_model: "ep-draft",
          embedding_timeout: 30,
          embedding_batch_size: 8
        }),
        stringValue: vi.fn(),
        writeJson
      }
    );

    expect(handled).toBe(true);
    expect(mockWriteAiLicenseRequiredIfNeeded).toHaveBeenCalled();
    expect(mockEmbeddingTest).toHaveBeenCalled();
    expect(mockVectorIndexConstructor).not.toHaveBeenCalled();
    expect(mockVectorClose).not.toHaveBeenCalled();
    expect(writeJson).toHaveBeenCalledWith(
      expect.anything(),
      200,
      expect.objectContaining({
        ok: true,
        model: "ep-draft",
        dimensions: 1024
      })
    );
  });

  it("blocks embedding tests when AI license is required", async () => {
    mockWriteAiLicenseRequiredIfNeeded.mockImplementation(async (_context, response, writeJson) => {
      writeJson(response, 403, { detail: "当前账号未授权", code: "AI_LICENSE_REQUIRED" });
      return true;
    });
    const writeJson = vi.fn();

    const handled = await handleVectorRoutes(
      { method: "POST" } as IncomingMessage,
      createResponse(),
      "/api/vector/test",
      new URLSearchParams(),
      createContext(),
      {
        ensureProjectSessionCurrent: vi.fn().mockResolvedValue({ path: "D:\\projects\\novel" }),
        readJsonBody: vi.fn(),
        stringValue: vi.fn(),
        writeJson
      }
    );

    expect(handled).toBe(true);
    expect(writeJson).toHaveBeenCalledWith(expect.anything(), 403, { detail: "当前账号未授权", code: "AI_LICENSE_REQUIRED" });
    expect(mockEmbeddingTest).not.toHaveBeenCalled();
    expect(mockVectorIndexConstructor).not.toHaveBeenCalled();
  });
});
