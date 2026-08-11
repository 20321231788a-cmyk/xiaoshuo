import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { handleStoryPlanningRoutes } from "./story-planning-routes.js";
import type { RuntimeContext } from "./types.js";

const { mockGet, mockSave, mockMigrate, mockManifestRebuild, mockMarkChanged, mockVectorClose } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockSave: vi.fn(),
  mockMigrate: vi.fn(),
  mockManifestRebuild: vi.fn(),
  mockMarkChanged: vi.fn(),
  mockVectorClose: vi.fn()
}));

vi.mock("@xiaoshuo/document-service", () => ({
  StoryPlanningService: class {
    get = mockGet;
    save = mockSave;
    migrate = mockMigrate;
  },
  StoryPlanningConflictError: class extends Error {
    code = "STORY_PLANNING_REVISION_CONFLICT";
  }
}));

vi.mock("@xiaoshuo/project-manifest", () => ({
  ProjectManifestService: class {
    rebuild = mockManifestRebuild;
  }
}));

vi.mock("@xiaoshuo/vector-service", () => ({
  VectorIndex: class {
    markChanged = mockMarkChanged;
    close = mockVectorClose;
  }
}));

const bundle = {
  schema_version: 1 as const,
  revision: 2,
  updated_at: "2026-07-16T00:00:00.000Z",
  outline: [],
  timeline: [],
  projection_paths: ["01_大纲/故事大纲.md", "01_大纲/故事时间线.md"],
  status: "ready" as const
};

function createContext(): RuntimeContext {
  return {
    projectRoot: "D:\\xiaoshuo\\ts-migration",
    jobManager: { list: () => [] } as unknown as RuntimeContext["jobManager"],
    projectSession: {} as RuntimeContext["projectSession"],
    documentSessions: new Map()
  };
}

function createDeps(body: Record<string, unknown> = {}) {
  return {
    ensureProjectSessionCurrent: vi.fn().mockResolvedValue({ path: "D:\\projects\\novel", name: "Novel" }),
    ensureDocumentSession: vi.fn().mockReturnValue({ id: "timeline-session" }),
    readJsonBody: vi.fn().mockResolvedValue(body),
    writeJson: vi.fn()
  };
}

describe("handleStoryPlanningRoutes", () => {
  beforeEach(() => {
    mockGet.mockResolvedValue(bundle);
    mockSave.mockResolvedValue(bundle);
    mockMigrate.mockResolvedValue(bundle);
    mockManifestRebuild.mockResolvedValue(undefined);
    mockMarkChanged.mockReturnValue(undefined);
    mockVectorClose.mockReturnValue(undefined);
  });

  afterEach(() => vi.clearAllMocks());

  it("does not claim unrelated routes", async () => {
    const handled = await handleStoryPlanningRoutes({ method: "GET" } as IncomingMessage, {} as ServerResponse, "/api/project/summary", createContext(), createDeps());
    expect(handled).toBe(false);
  });

  it("serves the structured outline and timeline bundle", async () => {
    const deps = createDeps();
    const handled = await handleStoryPlanningRoutes({ method: "GET" } as IncomingMessage, {} as ServerResponse, "/api/story-planning", createContext(), deps);
    expect(handled).toBe(true);
    expect(mockGet).toHaveBeenCalledTimes(1);
    expect(deps.writeJson).toHaveBeenCalledWith(expect.anything(), 200, bundle);
  });

  it("saves planning data and refreshes derived project readers", async () => {
    const deps = createDeps({ base_revision: 1, outline: [], timeline: [] });
    const handled = await handleStoryPlanningRoutes({ method: "PUT" } as IncomingMessage, {} as ServerResponse, "/api/story-planning", createContext(), deps);
    expect(handled).toBe(true);
    expect(mockSave).toHaveBeenCalledWith(expect.objectContaining({ baseRevision: 1, outline: [], timeline: [] }));
    expect(mockManifestRebuild).toHaveBeenCalledTimes(1);
    expect(mockMarkChanged).toHaveBeenCalledWith(bundle.projection_paths, "upsert");
    expect(mockVectorClose).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid planning data before it reaches persistence", async () => {
    const deps = createDeps({ base_revision: -1, outline: [], timeline: [] });
    const handled = await handleStoryPlanningRoutes({ method: "PUT" } as IncomingMessage, {} as ServerResponse, "/api/story-planning", createContext(), deps);
    expect(handled).toBe(true);
    expect(mockSave).not.toHaveBeenCalled();
    expect(deps.writeJson).toHaveBeenCalledWith(expect.anything(), 400, expect.objectContaining({ detail: expect.any(String) }));
  });
});
