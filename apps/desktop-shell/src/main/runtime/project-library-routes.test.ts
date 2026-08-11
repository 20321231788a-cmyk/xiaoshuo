import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { handleProjectLibraryRoutes } from "./project-library-routes.js";
import type { RuntimeContext } from "./types.js";

const {
  mockGet,
  mockSave,
  mockMigrate,
  mockReconcile,
  mockListDrafts,
  mockListDraftGroups,
  mockPreviewDraftGroup,
  mockCommitDraftGroup,
  mockDiscardDraftGroup,
  mockSetDraftGroupOrigin,
  mockCommitDraft,
  mockDiscardDraft,
  mockReadRawText,
  mockManifestRebuild,
  mockMarkChanged,
  mockVectorClose,
  mockInvalidateGovernedMemorySource,
  mockGetProjectAgentRuntime
} = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockSave: vi.fn(),
  mockMigrate: vi.fn(),
  mockReconcile: vi.fn(),
  mockListDrafts: vi.fn(),
  mockListDraftGroups: vi.fn(),
  mockPreviewDraftGroup: vi.fn(),
  mockCommitDraftGroup: vi.fn(),
  mockDiscardDraftGroup: vi.fn(),
  mockSetDraftGroupOrigin: vi.fn(),
  mockCommitDraft: vi.fn(),
  mockDiscardDraft: vi.fn(),
  mockReadRawText: vi.fn(),
  mockManifestRebuild: vi.fn(),
  mockMarkChanged: vi.fn(),
  mockVectorClose: vi.fn(),
  mockInvalidateGovernedMemorySource: vi.fn(),
  mockGetProjectAgentRuntime: vi.fn()
}));

vi.mock("@xiaoshuo/document-service", () => ({
  ProjectLibraryService: class {
    get = mockGet;
    save = mockSave;
    migrate = mockMigrate;
    reconcile = mockReconcile;
    listDrafts = mockListDrafts;
    listDraftGroups = mockListDraftGroups;
    previewDraftGroup = mockPreviewDraftGroup;
    commitDraftGroup = mockCommitDraftGroup;
    discardDraftGroup = mockDiscardDraftGroup;
    setDraftGroupOrigin = mockSetDraftGroupOrigin;
    commitDraft = mockCommitDraft;
    discardDraft = mockDiscardDraft;
  },
  ProjectLibraryConflictError: class extends Error {
    code = "LIBRARY_REVISION_CONFLICT";
  },
  DocumentService: class {
    readRawText = mockReadRawText;
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

vi.mock("./agent-runtime-registry.js", () => ({
  getProjectAgentRuntime: mockGetProjectAgentRuntime
}));

const bundle = {
  schema_version: 1 as const,
  domain: "genre" as const,
  revision: 4,
  updated_at: "2026-07-16T00:00:00.000Z",
  records: [],
  status: "ready" as const,
  projection_paths: ["00_设定集/题材库/题材规则.txt"]
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

describe("handleProjectLibraryRoutes", () => {
  beforeEach(() => {
    mockGet.mockResolvedValue(bundle);
    mockSave.mockResolvedValue(bundle);
    mockMigrate.mockResolvedValue([bundle]);
    mockReconcile.mockResolvedValue(bundle);
    mockListDrafts.mockResolvedValue([]);
    mockListDraftGroups.mockResolvedValue([]);
    mockPreviewDraftGroup.mockResolvedValue({ group_id: "style-genre-group-1", drafts: [], preview: [] });
    mockCommitDraftGroup.mockResolvedValue([bundle]);
    mockDiscardDraftGroup.mockResolvedValue(undefined);
    mockSetDraftGroupOrigin.mockResolvedValue({ group_id: "style-genre-group-1", drafts: [] });
    mockCommitDraft.mockResolvedValue(bundle);
    mockDiscardDraft.mockResolvedValue(undefined);
    mockReadRawText.mockResolvedValue("题材规则内容");
    mockManifestRebuild.mockResolvedValue(undefined);
    mockMarkChanged.mockReturnValue(undefined);
    mockVectorClose.mockReturnValue(undefined);
    mockInvalidateGovernedMemorySource.mockResolvedValue(undefined);
    mockGetProjectAgentRuntime.mockResolvedValue({ invalidateGovernedMemorySource: mockInvalidateGovernedMemorySource });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("does not claim unrelated runtime routes", async () => {
    const deps = createDeps();

    const handled = await handleProjectLibraryRoutes({ method: "GET" } as IncomingMessage, {} as ServerResponse, "/api/project/summary", createContext(), deps);

    expect(handled).toBe(false);
  });

  it("serves structured library data through the desktop runtime route", async () => {
    const deps = createDeps();

    const handled = await handleProjectLibraryRoutes({ method: "GET" } as IncomingMessage, {} as ServerResponse, "/api/project-libraries/genre", createContext(), deps);

    expect(handled).toBe(true);
    expect(mockGet).toHaveBeenCalledWith("genre");
    expect(deps.writeJson).toHaveBeenCalledWith(expect.anything(), 200, bundle);
  });

  it("saves through the route, then refreshes the project-derived readers", async () => {
    const deps = createDeps({ base_revision: 3, records: [] });

    const handled = await handleProjectLibraryRoutes({ method: "PUT" } as IncomingMessage, {} as ServerResponse, "/api/project-libraries/genre", createContext(), deps);

    expect(handled).toBe(true);
    expect(mockSave).toHaveBeenCalledWith("genre", expect.objectContaining({ baseRevision: 3, records: [] }));
    expect(mockManifestRebuild).toHaveBeenCalledTimes(1);
    expect(mockMarkChanged).toHaveBeenCalledWith(bundle.projection_paths, "upsert");
    expect(mockInvalidateGovernedMemorySource).toHaveBeenCalledWith(expect.objectContaining({ sourceRef: bundle.projection_paths[0] }));
    expect(deps.writeJson).toHaveBeenCalledWith(expect.anything(), 200, bundle);
  });

  it("keeps a generated library draft separate until the commit route is explicitly called", async () => {
    const deps = createDeps();

    const handled = await handleProjectLibraryRoutes({ method: "POST" } as IncomingMessage, {} as ServerResponse, "/api/project-library-drafts/draft_20260716/commit", createContext(), deps);

    expect(handled).toBe(true);
    expect(mockCommitDraft).toHaveBeenCalledWith("draft_20260716", expect.anything());
    expect(mockManifestRebuild).toHaveBeenCalledTimes(1);
    expect(deps.writeJson).toHaveBeenCalledWith(expect.anything(), 200, bundle);
  });

  it("serves and atomically commits grouped library drafts through dedicated routes", async () => {
    const deps = createDeps();
    mockListDraftGroups.mockResolvedValue([{ group_id: "style-genre-group-1", domains: ["style", "genre"] }]);

    await handleProjectLibraryRoutes({ method: "GET" } as IncomingMessage, {} as ServerResponse, "/api/project-library-draft-groups", createContext(), deps);
    expect(mockListDraftGroups).toHaveBeenCalled();
    expect(deps.writeJson).toHaveBeenCalledWith(expect.anything(), 200, expect.objectContaining({ groups: expect.any(Array) }));

    vi.clearAllMocks();
    const commitDeps = createDeps();
    await handleProjectLibraryRoutes({ method: "POST" } as IncomingMessage, {} as ServerResponse, "/api/project-library-draft-groups/style-genre-group-1/commit", createContext(), commitDeps);
    expect(mockCommitDraftGroup).toHaveBeenCalledWith("style-genre-group-1", expect.anything());
    expect(mockManifestRebuild).toHaveBeenCalledTimes(1);
    expect(commitDeps.writeJson).toHaveBeenCalledWith(expect.anything(), 200, { bundles: [bundle] });
  });

  it("rejects invalid save data before it reaches the persistence service", async () => {
    const deps = createDeps({ base_revision: -1, records: [] });

    const handled = await handleProjectLibraryRoutes({ method: "PUT" } as IncomingMessage, {} as ServerResponse, "/api/project-libraries/genre", createContext(), deps);

    expect(handled).toBe(true);
    expect(mockSave).not.toHaveBeenCalled();
    expect(deps.writeJson).toHaveBeenCalledWith(expect.anything(), 400, expect.objectContaining({ detail: expect.any(String) }));
  });
});
