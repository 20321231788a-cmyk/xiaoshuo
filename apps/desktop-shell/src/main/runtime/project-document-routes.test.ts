import { afterEach, describe, expect, it, vi } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { DocumentSaveConflictError } from "@xiaoshuo/document-service";
import { handleProjectDocumentRoutes } from "./project-document-routes.js";
import type { RuntimeContext } from "./types.js";

const mockArchiveDocument = vi.fn();
const mockListTimeline = vi.fn();
const mockSaveDocument = vi.fn();
const mockProjectChromeSnapshot = vi.fn();

vi.mock("@xiaoshuo/document-service", () => ({
  DocumentSaveConflictError: class extends Error {
    code = "DOCUMENT_SAVE_CONFLICT";
    currentUpdatedAt: string;
    currentUpdatedAtMs: number;

    constructor(currentUpdatedAt: string, currentUpdatedAtMs: number) {
      super("磁盘已有新版内容，普通保存已暂停。请先读取最新版，或确认覆盖磁盘内容。");
      this.currentUpdatedAt = currentUpdatedAt;
      this.currentUpdatedAtMs = currentUpdatedAtMs;
    }
  },
  DocumentService: class {
    archiveDocument = mockArchiveDocument;
    listTimeline = mockListTimeline;
    saveDocument = mockSaveDocument;
  }
}));

vi.mock("@xiaoshuo/project-manifest", () => ({
  ProjectManifestService: class {
    projectChromeSnapshot = mockProjectChromeSnapshot;
  }
}));

vi.mock("@xiaoshuo/vector-service", () => ({
  VectorIndex: class {
    markChanged = vi.fn();
    close = vi.fn();
  }
}));

function createContext(): RuntimeContext {
  return {
    projectRoot: "D:\\xiaoshuo\\ts-migration",
    jobManager: { list: () => [] } as unknown as RuntimeContext["jobManager"],
    projectSession: {
      openProject: vi.fn(),
      createProject: vi.fn(),
      renameCurrentProject: vi.fn()
    } as unknown as RuntimeContext["projectSession"],
    documentSessions: new Map()
  };
}

function createResponse(): ServerResponse {
  return {} as ServerResponse;
}

function createDeps(overrides?: Partial<Parameters<typeof handleProjectDocumentRoutes>[5]>) {
  return {
    ensureProjectSessionCurrent: vi.fn().mockResolvedValue({
      path: "D:\\projects\\novel",
      name: "Novel"
    }),
    ensureDocumentSession: vi.fn().mockReturnValue({}),
    startDocumentSession: vi.fn(),
    readJsonBody: vi.fn(),
    readRequestFields: vi.fn(),
    rebuildProjectManifest: vi.fn(),
    booleanValue: vi.fn((value) => Boolean(value)),
    stringValue: vi.fn((value) => String(value ?? "")),
    readBooleanQuery: vi.fn((value) => value === "true"),
    readIntQuery: vi.fn((_value, fallback) => fallback),
    writeJson: vi.fn(),
    matchDocumentRoute: vi.fn().mockReturnValue("chapters/ch1.txt"),
    matchTimelineRoute: vi.fn().mockReturnValue(null),
    ...overrides
  };
}

describe("handleProjectDocumentRoutes", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns 400 for document reads when no project is open", async () => {
    const deps = createDeps({
      ensureProjectSessionCurrent: vi.fn().mockResolvedValue({ path: "", name: "" })
    });

    const handled = await handleProjectDocumentRoutes(
      { method: "GET" } as IncomingMessage,
      createResponse(),
      "/api/documents/chapters/ch1.txt",
      new URLSearchParams(),
      createContext(),
      deps
    );

    expect(handled).toBe(true);
    expect(deps.writeJson).toHaveBeenCalledWith(expect.anything(), 400, { detail: "尚未打开项目" });
  });

  it("rejects document deletion without explicit confirmation", async () => {
    const deps = createDeps({
      readRequestFields: vi.fn().mockResolvedValue({ confirm_delete: false }),
      booleanValue: vi.fn().mockReturnValue(false)
    });

    const handled = await handleProjectDocumentRoutes(
      { method: "DELETE" } as IncomingMessage,
      createResponse(),
      "/api/documents/chapters/ch1.txt",
      new URLSearchParams(),
      createContext(),
      deps
    );

    expect(handled).toBe(true);
    expect(deps.writeJson).toHaveBeenCalledWith(expect.anything(), 400, {
      detail: "删除/归档文件需要用户确认"
    });
    expect(mockArchiveDocument).not.toHaveBeenCalled();
  });

  it("passes project chrome query options through to the manifest snapshot", async () => {
    const deps = createDeps({
      matchDocumentRoute: vi.fn().mockReturnValue(""),
      readIntQuery: vi.fn().mockReturnValue(120),
      readBooleanQuery: vi.fn((value) => value === "true")
    });
    mockListTimeline.mockResolvedValue([{ id: "tl-1" }]);
    mockProjectChromeSnapshot.mockResolvedValue({ ok: true });

    const handled = await handleProjectDocumentRoutes(
      { method: "GET" } as IncomingMessage,
      createResponse(),
      "/api/project/chrome",
      new URLSearchParams("force=true&include_tree=false&timeline_limit=120"),
      createContext(),
      deps
    );

    expect(handled).toBe(true);
    expect(mockListTimeline).toHaveBeenCalledWith(120);
    expect(mockProjectChromeSnapshot).toHaveBeenCalledWith(
      { path: "D:\\projects\\novel", name: "Novel" },
      [{ id: "tl-1" }],
      { force: true, includeTree: false }
    );
    expect(deps.writeJson).toHaveBeenCalledWith(expect.anything(), 200, { ok: true });
  });

  it("returns 409 when document save detects a stale base version", async () => {
    const deps = createDeps({
      readJsonBody: vi.fn().mockResolvedValue({
        content: "local draft",
        base_updated_at: "2026-06-01 11:00:00",
        base_updated_at_ms: 1
      })
    });

    mockSaveDocument.mockRejectedValue(
      new DocumentSaveConflictError("2026-06-01 12:00:00", 123)
    );

    const handled = await handleProjectDocumentRoutes(
      { method: "PUT" } as IncomingMessage,
      createResponse(),
      "/api/documents/chapters/ch1.txt",
      new URLSearchParams(),
      createContext(),
      deps
    );

    expect(handled).toBe(true);
    expect(deps.writeJson).toHaveBeenCalledWith(expect.anything(), 409, {
      detail: "磁盘已有新版内容，普通保存已暂停。请先读取最新版，或确认覆盖磁盘内容。",
      code: "DOCUMENT_SAVE_CONFLICT",
      current_updated_at: "2026-06-01 12:00:00",
      current_updated_at_ms: 123
    });
  });
});
