import {
  BookCheck,
  BookOpen,
  CircleAlert,
  FileText,
  Filter,
  History,
  Search
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { ReviewReportsBundle, ReviewIssueStatus, CreateReviewReportRequest } from "@xiaoshuo/shared";
import type { WorkbenchController } from "../../../hooks/useWorkbenchController.js";
import { EmptyState } from "../shared/SharedStates.js";

type ConsistencyReviewResult = {
  score?: unknown;
  reason?: unknown;
  risks?: unknown;
  graph_score?: unknown;
  graph_risks?: unknown;
};

async function reviewRequest<T>(controller: WorkbenchController, pathname: string, init?: RequestInit): Promise<T> {
  const fetchFn = controller.runtime.fetchFn || fetch;
  const response = await fetchFn(new URL(pathname, controller.runtime.apiBase), {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) }
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(String(payload.detail || response.statusText || "审阅报告请求失败"));
  return payload as T;
}

function useReviewReports(controller: WorkbenchController) {
  const [bundle, setBundle] = useState<ReviewReportsBundle | null>(null);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);
  const projectPath = controller.snapshot?.currentProject.path || "";

  const refresh = useCallback(async () => {
    if (!projectPath) {
      setBundle({ schema_version: 1, revision: 0, reports: [] });
      setMessage("打开小说项目后，可开始审阅并查看历史报告。");
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      setBundle(await reviewRequest<ReviewReportsBundle>(controller, "/api/review-reports"));
      setMessage("");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, [controller, projectPath]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function create(input: Omit<CreateReviewReportRequest, "base_revision">) {
    if (!projectPath) throw new Error("请先打开小说项目。");
    const current = bundle || await reviewRequest<ReviewReportsBundle>(controller, "/api/review-reports");
    const next = await reviewRequest<ReviewReportsBundle>(controller, "/api/review-reports", {
      method: "POST",
      body: JSON.stringify({ ...input, base_revision: current.revision })
    });
    setBundle(next);
    setMessage("审阅报告已保存。");
    return next;
  }

  async function updateIssue(reportId: string, issueId: string, status: ReviewIssueStatus) {
    if (!projectPath) throw new Error("请先打开小说项目。");
    const current = bundle || await reviewRequest<ReviewReportsBundle>(controller, "/api/review-reports");
    const next = await reviewRequest<ReviewReportsBundle>(controller, `/api/review-reports/${encodeURIComponent(reportId)}/issues/${encodeURIComponent(issueId)}`, {
      method: "PATCH",
      body: JSON.stringify({ base_revision: current.revision, status })
    });
    setBundle(next);
    setMessage(status === "accepted" ? "已标记为采纳。" : "已忽略这条建议。");
  }

  return { bundle, loading, message, refresh, create, updateIssue, setMessage };
}

function numericScore(value: unknown): number | null {
  const score = Number(value);
  return Number.isInteger(score) && score >= 0 && score <= 100 ? score : null;
}

function reviewInputFromResult(input: { scope: "chapter" | "project"; sourcePath: string; result: ConsistencyReviewResult }): Omit<CreateReviewReportRequest, "base_revision"> {
  const risks = Array.isArray(input.result.risks) ? input.result.risks : [];
  const graphRisks = Array.isArray(input.result.graph_risks) ? input.result.graph_risks : [];
  return {
    scope: input.scope,
    source_paths: input.sourcePath ? [input.sourcePath] : ["02_正文"],
    summary: String(input.result.reason || "审阅已完成，请逐项处理建议。"),
    dimensions: [
      { id: "continuity", label: "连续性", score: numericScore(input.result.score) },
      ...(input.result.graph_score === undefined ? [] : [{ id: "story_facts", label: "已确认事实", score: numericScore(input.result.graph_score) }])
    ],
    issues: [...risks, ...graphRisks].map((risk) => ({ title: "建议处理", detail: String(risk), source_path: input.sourcePath, excerpt: "" }))
  };
}

export function ReviewProductPage({
  controller,
  onSelectFeature
}: {
  controller: WorkbenchController;
  onSelectFeature: (feature: any) => void;
}) {
  const activeDocument = controller.openDocuments.find((item) => item.path === controller.activeDocumentPath) || null;
  const hasProject = Boolean(controller.snapshot?.currentProject.path);
  const reports = useReviewReports(controller);
  const [selectedReportId, setSelectedReportId] = useState("");
  const [scope, setScope] = useState<"chapter" | "project">("chapter");
  const [issueFilter, setIssueFilter] = useState<"pending" | "accepted" | "ignored">("pending");
  const [dimensionFilter, setDimensionFilter] = useState<"all" | "continuity">("all");
  const [filterOpen, setFilterOpen] = useState(false);
  const [issueQuery, setIssueQuery] = useState("");

  const selectedReport = reports.bundle?.reports.find((item) => item.id === selectedReportId) || reports.bundle?.reports[0] || null;

  useEffect(() => {
    if (!selectedReportId && reports.bundle?.reports[0]?.id) setSelectedReportId(reports.bundle.reports[0].id);
  }, [reports.bundle?.revision, selectedReportId]);

  async function runReview() {
    const sourcePath = scope === "chapter" ? activeDocument?.path || "" : "";
    const skillResult = await controller.runWorkflowSkill("consistency_check", {
      text: scope === "chapter" ? activeDocument?.content || "" : "",
      source_path: sourcePath,
      review_scope: scope,
      instruction: "检查剧情连续性与事实冲突",
      write_result: false
    } as any);

    const result = skillResult?.data as ConsistencyReviewResult | undefined;
    if (!result || numericScore(result.score) === null) return;
    try {
      const next = await reports.create(reviewInputFromResult({ scope, sourcePath, result }));
      setSelectedReportId(next.reports[0]?.id || "");
    } catch (e) {
      reports.setMessage("审阅已完成，但报告未能保存。");
    }
  }

  function prepareRevision(detail: string) {
    controller.setMessageInput(`请针对以下审阅问题给出修改预览：${detail}`);
    onSelectFeature("conversations");
  }

  if (reports.loading) {
    return <div style={{ padding: "20px", fontSize: "12px", color: "var(--muted)" }}>正在读取历史审阅报告...</div>;
  }

  return (
    <div className="page-scroll" style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div className="content-head">
        <div>
          <h1>全文审阅</h1>
          <p>从读者体验出发检查全书，不显示开发Trace或诊断信息。</p>
        </div>
        <div className="content-actions">
          {reports.bundle && reports.bundle.reports.length > 1 && (
            <select
              aria-label="选择历史报告"
              value={selectedReportId}
              onChange={(e) => setSelectedReportId(e.target.value)}
              style={{ padding: "4px 8px", borderRadius: "4px", border: "1px solid var(--line)", fontSize: "12px" }}
            >
              {reports.bundle.reports.map((report) => (
                <option key={report.id} value={report.id}>
                  {report.scope === "project" ? "全书" : "章节"} · {report.updated_at.slice(0, 10)}
                </option>
              ))}
            </select>
          )}
          <button className="button secondary" type="button" onClick={() => setScope(scope === "chapter" ? "project" : "chapter")}>
            切换为{scope === "chapter" ? "全书检查" : "单章检查"}
          </button>
          <button className="button primary" type="button" onClick={runReview} disabled={!hasProject || controller.operationsBusy || (scope === "chapter" && !activeDocument)}>
            <Search size={15} />开始审阅
          </button>
        </div>
      </div>

      {selectedReport ? (
        <>
          {/* 顶部评分栏 */}
          <section className="review-overview">
            <div className="review-score">
              <strong>{selectedReport.dimensions[0]?.score ?? "--"}</strong>
              <span>整体质量</span>
              <small>{new Date(selectedReport.updated_at).toLocaleDateString("zh-CN")}</small>
            </div>
            <div className="score-bars">
              {selectedReport.dimensions.map((dim) => (
                <div key={dim.id}>
                  <span>{dim.label}</span>
                  <i><b style={{ width: `${dim.score ?? 0}%` }} /></i>
                  <strong>{dim.score ?? "--"}</strong>
                </div>
              ))}
            </div>
            <div className="review-next">
              <span>优先建议</span>
              <strong>{selectedReport.issues.find((issue) => issue.status === "pending")?.title || "当前没有待处理问题"}</strong>
              <p>{selectedReport.summary || "审阅完成后会在这里显示优先建议。"}</p>
            </div>
          </section>

          {/* 两栏 */}
          <div className="review-layout" style={{ flex: 1, minHeight: 0, marginTop: "20px" }}>
            {/* 左过滤器 */}
            <aside className="review-filters" style={{ width: "190px" }}>
              <span className="subhead">审阅维度</span>
              <button className={dimensionFilter === "all" ? "active" : ""} type="button" onClick={() => setDimensionFilter("all")}>全部问题 <small>{selectedReport.issues.length}</small></button>
              <button className={dimensionFilter === "continuity" ? "active" : ""} type="button" onClick={() => setDimensionFilter("continuity")}>连续性 <small>{selectedReport.issues.length}</small></button>
              <span className="subhead gap">范围</span>
              <div className="review-scope-label">
                <BookOpen size={14} />{selectedReport.scope === "project" ? "全书" : "单章"}
              </div>
            </aside>

            {/* 右问题列表 */}
            <section className="review-list" style={{ overflowY: "auto" }}>
              <div className="toolbar-line">
                <div className="filter-pills">
                  <button className={issueFilter === "pending" ? "active" : ""} onClick={() => setIssueFilter("pending")}>待处理</button>
                  <button className={issueFilter === "accepted" ? "active" : ""} onClick={() => setIssueFilter("accepted")}>已采纳</button>
                  <button className={issueFilter === "ignored" ? "active" : ""} onClick={() => setIssueFilter("ignored")}>已忽略</button>
                </div>
                <button className="button secondary" type="button" aria-pressed={filterOpen} onClick={() => setFilterOpen((value) => !value)}>
                  <Filter size={14} /> 筛选
                </button>
              </div>
              {filterOpen && <input className="review-search-input" value={issueQuery} onChange={(event) => setIssueQuery(event.target.value)} placeholder="搜索问题内容或来源" aria-label="搜索审阅问题" />}

              <div style={{ display: "flex", flexDirection: "column", gap: "10px", marginTop: "10px" }}>
                {selectedReport.issues
                  .filter((issue) => (issue.status || "pending") === issueFilter)
                  .filter((issue) => !issueQuery.trim() || `${issue.title} ${issue.detail} ${issue.source_path}`.toLocaleLowerCase("zh-CN").includes(issueQuery.trim().toLocaleLowerCase("zh-CN")))
                  .map((issue: any, idx) => (
                    <article className="review-issue" key={idx} style={{ padding: "12px", border: "1px solid var(--line)", borderRadius: "6px" }}>
                      <span className="severity high" style={{ fontSize: "12px", padding: "2px 6px", borderRadius: "4px", background: "var(--stone)" }}>
                        待处理建议
                      </span>
                      <div style={{ marginTop: "6px" }}>
                        <strong style={{ fontSize: "12px" }}>{issue.title}</strong>
                        <p style={{ fontSize: "12px", color: "var(--muted)", margin: "4px 0" }}>{issue.detail}</p>
                        {issueFilter === "pending" && (
                          <div style={{ display: "flex", gap: "8px", marginTop: "8px" }}>
                            {issue.source_path && <button className="button secondary compact" type="button" onClick={() => { void controller.openDocument(issue.source_path); onSelectFeature("editor"); }} style={{ height: "24px" }}>定位原文</button>}
                            <button className="button secondary compact" type="button" onClick={() => prepareRevision(issue.detail)} style={{ height: "24px" }}>
                              生成修改
                            </button>
                            <button className="button secondary compact" type="button" onClick={() => void reports.updateIssue(selectedReport.id, issue.id, "accepted")} style={{ height: "24px" }}>
                              采纳
                            </button>
                            <button className="button secondary compact" type="button" onClick={() => void reports.updateIssue(selectedReport.id, issue.id, "ignored")} style={{ height: "24px" }}>
                              忽略
                            </button>
                          </div>
                        )}
                      </div>
                    </article>
                  ))}
                {selectedReport.issues.filter((issue) => (issue.status || "pending") === issueFilter).filter((issue) => !issueQuery.trim() || `${issue.title} ${issue.detail} ${issue.source_path}`.toLocaleLowerCase("zh-CN").includes(issueQuery.trim().toLocaleLowerCase("zh-CN"))).length === 0 && (
                  <div style={{ padding: "40px", textAlign: "center", color: "var(--muted)" }}>
                    <BookCheck size={20} style={{ display: "block", margin: "0 auto 8px" }} />
                    此状态下没有建议项。
                  </div>
                )}
              </div>
            </section>
          </div>
        </>
      ) : (
        <div style={{ padding: "40px", textAlign: "center", color: "var(--muted)" }}>
          <BookCheck size={24} style={{ display: "block", margin: "0 auto 10px" }} />
          点击右上角“开始审阅”生成第一次全文审阅报告。
        </div>
      )}
    </div>
  );
}
