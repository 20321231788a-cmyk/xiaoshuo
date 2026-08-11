import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { handleReviewReportRoutes } from "./review-report-routes.js";
import type { RuntimeContext } from "./types.js";

const { mockList, mockCreate, mockUpdateIssue } = vi.hoisted(() => ({
  mockList: vi.fn(),
  mockCreate: vi.fn(),
  mockUpdateIssue: vi.fn()
}));

vi.mock("@xiaoshuo/document-service", () => ({
  ReviewReportService: class {
    list = mockList;
    create = mockCreate;
    updateIssue = mockUpdateIssue;
  },
  ReviewReportConflictError: class extends Error {
    code = "REVIEW_REPORT_REVISION_CONFLICT";
  }
}));

const bundle = { schema_version: 1 as const, revision: 4, reports: [] };

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

describe("handleReviewReportRoutes", () => {
  beforeEach(() => {
    mockList.mockResolvedValue(bundle);
    mockCreate.mockResolvedValue(bundle);
    mockUpdateIssue.mockResolvedValue(bundle);
  });

  afterEach(() => vi.clearAllMocks());

  it("does not claim unrelated routes", async () => {
    const handled = await handleReviewReportRoutes({ method: "GET" } as IncomingMessage, {} as ServerResponse, "/api/project/summary", createContext(), createDeps());
    expect(handled).toBe(false);
  });

  it("lists persisted reports", async () => {
    const deps = createDeps();
    const handled = await handleReviewReportRoutes({ method: "GET" } as IncomingMessage, {} as ServerResponse, "/api/review-reports", createContext(), deps);
    expect(handled).toBe(true);
    expect(deps.writeJson).toHaveBeenCalledWith(expect.anything(), 200, bundle);
  });

  it("creates reports and updates issue decisions through explicit routes", async () => {
    const createDepsValue = createDeps({ base_revision: 3, scope: "chapter", source_paths: [], summary: "", dimensions: [], issues: [] });
    await handleReviewReportRoutes({ method: "POST" } as IncomingMessage, {} as ServerResponse, "/api/review-reports", createContext(), createDepsValue);
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ base_revision: 3 }), expect.anything());
    expect(createDepsValue.writeJson).toHaveBeenCalledWith(expect.anything(), 201, bundle);

    const updateDeps = createDeps({ base_revision: 4, status: "accepted" });
    await handleReviewReportRoutes({ method: "PATCH" } as IncomingMessage, {} as ServerResponse, "/api/review-reports/report-1/issues/issue-1", createContext(), updateDeps);
    expect(mockUpdateIssue).toHaveBeenCalledWith(expect.objectContaining({ baseRevision: 4, reportId: "report-1", issueId: "issue-1", status: "accepted" }));
  });
});
