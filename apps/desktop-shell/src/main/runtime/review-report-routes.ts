import { createReviewReportRequestSchema, updateReviewIssueRequestSchema } from "@xiaoshuo/shared";
import { ReviewReportConflictError, ReviewReportService, type DocumentTimelineSession } from "@xiaoshuo/document-service";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { RuntimeContext } from "./types.js";

type JsonRecord = Record<string, unknown>;
type RouteDeps = {
  ensureProjectSessionCurrent: (context: RuntimeContext) => Promise<{ path: string; name: string }>;
  ensureDocumentSession: (sessions: Map<string, DocumentTimelineSession>, projectPath: string) => DocumentTimelineSession;
  readJsonBody: (request: IncomingMessage) => Promise<JsonRecord>;
  writeJson: (response: ServerResponse, status: number, payload: unknown) => void;
};

export async function handleReviewReportRoutes(request: IncomingMessage, response: ServerResponse, pathname: string, context: RuntimeContext, deps: RouteDeps): Promise<boolean> {
  const issue = matchReviewIssueRoute(pathname);
  if (pathname !== "/api/review-reports" && !issue) return false;
  const current = await deps.ensureProjectSessionCurrent(context);
  if (!current.path) return false;
  const service = new ReviewReportService({ projectRoot: current.path });
  try {
    if (pathname === "/api/review-reports" && request.method === "GET") {
      deps.writeJson(response, 200, await service.list());
      return true;
    }
    if (pathname === "/api/review-reports" && request.method === "POST") {
      const payload = createReviewReportRequestSchema.parse(await deps.readJsonBody(request));
      const bundle = await service.create(payload, deps.ensureDocumentSession(context.documentSessions, current.path));
      deps.writeJson(response, 201, bundle);
      return true;
    }
    if (issue && request.method === "PATCH") {
      const payload = updateReviewIssueRequestSchema.parse(await deps.readJsonBody(request));
      const bundle = await service.updateIssue({
        baseRevision: payload.base_revision,
        reportId: issue.reportId,
        issueId: issue.issueId,
        status: payload.status,
        session: deps.ensureDocumentSession(context.documentSessions, current.path)
      });
      deps.writeJson(response, 200, bundle);
      return true;
    }
  } catch (error) {
    deps.writeJson(response, error instanceof ReviewReportConflictError ? 409 : 400, {
      detail: error instanceof Error ? error.message : String(error),
      code: error instanceof ReviewReportConflictError ? error.code : undefined
    });
    return true;
  }
  return false;
}

function matchReviewIssueRoute(pathname: string): { reportId: string; issueId: string } | null {
  const match = /^\/api\/review-reports\/([^/]+)\/issues\/([^/]+)$/.exec(pathname);
  if (!match) return null;
  return { reportId: decodeURIComponent(match[1] || ""), issueId: decodeURIComponent(match[2] || "") };
}
