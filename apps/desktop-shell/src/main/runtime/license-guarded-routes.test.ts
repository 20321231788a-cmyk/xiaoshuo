import { afterEach, describe, expect, it, vi } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { handleAgentRoutes } from "./agent-routes.js";
import { handleJobRoutes } from "./job-routes.js";
import { handleSkillRoutes } from "./skill-routes.js";
import { handleVectorRoutes } from "./vector-routes.js";
import type { RuntimeContext } from "./types.js";

const mockAgentPlan = vi.hoisted(() => vi.fn());
const mockRunSkill = vi.hoisted(() => vi.fn());
const mockVectorRebuild = vi.hoisted(() => vi.fn());
const mockWriteAiLicenseRequiredIfNeeded = vi.hoisted(() => vi.fn());

vi.mock("@xiaoshuo/agent-runtime", () => ({
  AgentRuntimeService: class {
    plan = mockAgentPlan;
    runSkill = mockRunSkill;
    draftSkillFromUrl = vi.fn();
    runAgent = vi.fn();
    streamAgentRun = vi.fn();
  },
  DefaultWebSearchClient: class {},
  encodeNdjsonEvent: vi.fn()
}));

vi.mock("@xiaoshuo/vector-service", () => ({
  VectorIndex: class {
    rebuild = mockVectorRebuild;
    close = vi.fn();
  }
}));

vi.mock("./license-guard.js", () => ({
  writeAiLicenseRequiredIfNeeded: mockWriteAiLicenseRequiredIfNeeded
}));

function createContext(): RuntimeContext {
  return {
    projectRoot: "D:\\xiaoshuo\\ts-migration",
    jobManager: {
      list: vi.fn().mockReturnValue([]),
      create: vi.fn()
    } as unknown as RuntimeContext["jobManager"],
    projectSession: {} as RuntimeContext["projectSession"],
    documentSessions: new Map()
  };
}

function createResponse(): ServerResponse {
  return {} as ServerResponse;
}

function blockLicense() {
  mockWriteAiLicenseRequiredIfNeeded.mockImplementation(async (_context, response, writeJson) => {
    writeJson(response, 403, { detail: "当前账号未授权", code: "AI_LICENSE_REQUIRED" });
    return true;
  });
}

describe("AI license guarded runtime routes", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("blocks agent planning when unlicensed", async () => {
    blockLicense();
    const writeJson = vi.fn();

    const handled = await handleAgentRoutes(
      { method: "POST" } as IncomingMessage,
      createResponse(),
      "/api/agent/plan",
      createContext(),
      {
        ensureProjectSessionCurrent: vi.fn().mockResolvedValue({ path: "D:\\projects\\novel" }),
        ensureDocumentSession: vi.fn(),
        readJsonBody: vi.fn(),
        readRawBody: vi.fn(),
        parseJsonRecord: vi.fn(),
        booleanValue: vi.fn(),
        rebuildProjectManifest: vi.fn(),
        writeJson,
        writeNdjsonEvent: vi.fn(),
        addCorsHeaders: vi.fn()
      }
    );

    expect(handled).toBe(true);
    expect(writeJson).toHaveBeenCalledWith(expect.anything(), 403, { detail: "当前账号未授权", code: "AI_LICENSE_REQUIRED" });
    expect(mockAgentPlan).not.toHaveBeenCalled();
  });

  it("blocks skill execution when unlicensed", async () => {
    blockLicense();
    const writeJson = vi.fn();

    const handled = await handleSkillRoutes(
      { method: "POST" } as IncomingMessage,
      createResponse(),
      "/api/skills/body_generate/run",
      createContext(),
      {
        ensureProjectSessionCurrent: vi.fn().mockResolvedValue({ path: "D:\\projects\\novel" }),
        readJsonBody: vi.fn(),
        readRawBody: vi.fn(),
        parseJsonRecord: vi.fn(),
        parseMultipartFile: vi.fn(),
        rebuildProjectManifest: vi.fn(),
        writeJson,
        matchSkillRoute: vi.fn().mockReturnValue({ id: "body_generate", action: "run" }),
        openPath: vi.fn()
      }
    );

    expect(handled).toBe(true);
    expect(writeJson).toHaveBeenCalledWith(expect.anything(), 403, { detail: "当前账号未授权", code: "AI_LICENSE_REQUIRED" });
    expect(mockRunSkill).not.toHaveBeenCalled();
  });

  it("blocks vector rebuild when unlicensed", async () => {
    blockLicense();
    const writeJson = vi.fn();

    const handled = await handleVectorRoutes(
      { method: "POST" } as IncomingMessage,
      createResponse(),
      "/api/vector/rebuild",
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
    expect(mockVectorRebuild).not.toHaveBeenCalled();
  });

  it("blocks novel crawl jobs when unlicensed", async () => {
    blockLicense();
    const context = createContext();
    const writeJson = vi.fn();

    const handled = await handleJobRoutes(
      { method: "POST" } as IncomingMessage,
      createResponse(),
      "/api/jobs",
      context,
      {
        ensureProjectSessionCurrent: vi.fn().mockResolvedValue({ path: "D:\\projects\\novel" }),
        readJsonBody: vi.fn().mockResolvedValue({ kind: "novel_crawl", payload: { query: "测试小说" } }),
        rebuildProjectManifest: vi.fn(),
        stringValue: vi.fn((value) => String(value || "")),
        booleanValue: vi.fn(),
        writeJson
      }
    );

    expect(handled).toBe(true);
    expect(writeJson).toHaveBeenCalledWith(expect.anything(), 403, { detail: "当前账号未授权", code: "AI_LICENSE_REQUIRED" });
    expect(context.jobManager.create).not.toHaveBeenCalled();
  });
});
