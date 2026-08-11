import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ReviewReportConflictError, ReviewReportService } from "./review-report-service.js";

let tempDir = "";
let sequence = 0;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "xiaoshuo-review-report-"));
  sequence = 0;
});

afterEach(async () => {
  if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
});

describe("ReviewReportService", () => {
  it("persists only user-facing report data and keeps issue decisions as versions", async () => {
    const service = new ReviewReportService({
      projectRoot: tempDir,
      now: () => "2026-07-16T00:00:00.000Z",
      idFactory: () => `review-${++sequence}`
    });
    const created = await service.create({
      base_revision: 0,
      scope: "chapter",
      source_paths: ["02_正文/第01章.md"],
      summary: "人物动机需要补强。",
      dimensions: [{ id: "continuity", label: "连续性", score: 76 }],
      issues: [{ title: "动机跳跃", detail: "主角决定缺少铺垫。", source_path: "02_正文/第01章.md", excerpt: "林默决定离开。" }]
    });
    const report = created.reports[0]!;
    const issue = report.issues[0]!;
    const updated = await service.updateIssue({
      baseRevision: created.revision,
      reportId: report.id,
      issueId: issue.id,
      status: "accepted"
    });
    const raw = await fs.readFile(path.join(tempDir, "00_设定集", ".agent", "review-reports.jsonl"), "utf8");

    expect(updated).toMatchObject({ revision: 2 });
    expect(updated.reports[0]).toMatchObject({ version: 2, issues: [expect.objectContaining({ status: "accepted" })] });
    expect(raw).toContain('"record_type":"report"');
    expect(raw).not.toContain("prompt");
    expect(raw).not.toContain("trace");
    expect((await service.list()).reports[0]?.issues[0]?.status).toBe("accepted");
  });

  it("rejects stale report updates", async () => {
    const service = new ReviewReportService({ projectRoot: tempDir });
    const created = await service.create({ base_revision: 0, scope: "project", source_paths: [], summary: "", dimensions: [], issues: [{ title: "问题", detail: "", source_path: "", excerpt: "" }] });
    const report = created.reports[0]!;
    await service.updateIssue({ baseRevision: 1, reportId: report.id, issueId: report.issues[0]!.id, status: "ignored" });
    await expect(service.updateIssue({ baseRevision: 1, reportId: report.id, issueId: report.issues[0]!.id, status: "accepted" })).rejects.toBeInstanceOf(ReviewReportConflictError);
  });
});
