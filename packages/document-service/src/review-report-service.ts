import { randomUUID } from "node:crypto";
import {
  reviewReportSchema,
  reviewReportsBundleSchema,
  type CreateReviewReportRequest,
  type ReviewIssueStatus,
  type ReviewReport,
  type ReviewReportsBundle
} from "@xiaoshuo/shared";
import { AGENT_DIR } from "@xiaoshuo/project-session";
import { DocumentService, type DocumentTimelineSession } from "./service.js";

const REVIEW_REPORTS_PATH = `${AGENT_DIR}/review-reports.jsonl`;

type MetaRecord = {
  record_type: "meta";
  schema_version: 1;
  revision: number;
  updated_at: string;
};

type ReportRecord = ReviewReport & { record_type: "report" };

export class ReviewReportConflictError extends Error {
  readonly code = "REVIEW_REPORT_REVISION_CONFLICT";

  constructor(message = "审阅报告已被其他窗口更新，请刷新后重试。") {
    super(message);
  }
}

export class ReviewReportService {
  private readonly documents: DocumentService;
  private readonly now: () => string;
  private readonly idFactory: () => string;

  constructor(options: { projectRoot: string; now?: () => string; idFactory?: () => string }) {
    this.documents = new DocumentService({ projectRoot: options.projectRoot });
    this.now = options.now || (() => new Date().toISOString());
    this.idFactory = options.idFactory || (() => randomUUID().replace(/-/g, ""));
  }

  async list(): Promise<ReviewReportsBundle> {
    const store = await this.readStore();
    return this.bundle(store.revision, store.reports);
  }

  async create(input: CreateReviewReportRequest, session?: DocumentTimelineSession): Promise<ReviewReportsBundle> {
    const store = await this.readStore();
    this.assertRevision(store.revision, input.base_revision);
    const now = this.now();
    const report = reviewReportSchema.parse({
      schema_version: 1,
      id: this.idFactory(),
      version: 1,
      created_at: now,
      updated_at: now,
      scope: input.scope,
      source_paths: unique(input.source_paths),
      summary: input.summary,
      dimensions: input.dimensions,
      issues: input.issues.map((issue) => ({
        id: this.idFactory(),
        ...issue,
        status: "pending",
        created_at: now,
        updated_at: now
      }))
    });
    return this.append(store, report, session, "保存审阅报告");
  }

  async updateIssue(input: { baseRevision: number; reportId: string; issueId: string; status: ReviewIssueStatus; session?: DocumentTimelineSession }): Promise<ReviewReportsBundle> {
    const store = await this.readStore();
    this.assertRevision(store.revision, input.baseRevision);
    const report = store.reports.get(input.reportId);
    if (!report) throw new Error("未找到审阅报告");
    const issueExists = report.issues.some((issue) => issue.id === input.issueId);
    if (!issueExists) throw new Error("未找到审阅问题");
    const now = this.now();
    const next = reviewReportSchema.parse({
      ...report,
      version: report.version + 1,
      updated_at: now,
      issues: report.issues.map((issue) => issue.id === input.issueId ? { ...issue, status: input.status, updated_at: now } : issue)
    });
    return this.append(store, next, input.session, "更新审阅问题状态");
  }

  private async append(store: ReviewStore, report: ReviewReport, session: DocumentTimelineSession | undefined, summary: string): Promise<ReviewReportsBundle> {
    const nextRevision = store.revision + 1;
    const meta: MetaRecord = { record_type: "meta", schema_version: 1, revision: nextRevision, updated_at: this.now() };
    const content = `${[...store.history, { record_type: "report", ...report } satisfies ReportRecord, meta].map((record) => JSON.stringify(record)).join("\n")}\n`;
    await this.documents.saveDocumentsAtomically([{ path: REVIEW_REPORTS_PATH, content }], {
      source: "review_report",
      summary,
      session
    });
    const reports = new Map(store.reports);
    reports.set(report.id, report);
    return this.bundle(nextRevision, reports);
  }

  private async readStore(): Promise<ReviewStore> {
    const raw = await this.documents.readRawText(REVIEW_REPORTS_PATH, 8_000_000).catch(() => "");
    const reports = new Map<string, ReviewReport>();
    const history: Array<MetaRecord | ReportRecord> = [];
    let revision = 0;
    for (const line of raw.split(/\r?\n/)) {
      const text = line.trim();
      if (!text) continue;
      try {
        const record = JSON.parse(text) as Record<string, unknown>;
        if (record.record_type === "meta" && record.schema_version === 1 && Number.isInteger(record.revision)) {
          const meta: MetaRecord = { record_type: "meta", schema_version: 1, revision: Number(record.revision), updated_at: String(record.updated_at || "") };
          history.push(meta);
          revision = Math.max(revision, meta.revision);
          continue;
        }
        if (record.record_type !== "report") continue;
        const parsed = reviewReportSchema.safeParse(record);
        if (!parsed.success) continue;
        const previous = reports.get(parsed.data.id);
        if (!previous || parsed.data.version >= previous.version) reports.set(parsed.data.id, parsed.data);
        history.push({ record_type: "report", ...parsed.data });
      } catch {
        // A corrupt historical line must not hide other reports.
      }
    }
    return { revision, reports, history };
  }

  private bundle(revision: number, reports: Map<string, ReviewReport>): ReviewReportsBundle {
    return reviewReportsBundleSchema.parse({
      schema_version: 1,
      revision,
      reports: [...reports.values()].sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    });
  }

  private assertRevision(actual: number, expected: number): void {
    if (actual !== expected) throw new ReviewReportConflictError();
  }
}

type ReviewStore = {
  revision: number;
  reports: Map<string, ReviewReport>;
  history: Array<MetaRecord | ReportRecord>;
};

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
