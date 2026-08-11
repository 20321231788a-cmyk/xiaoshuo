import type { CreateReviewReportRequest, ReviewReportsBundle } from "@xiaoshuo/shared";
import type { WorkbenchController } from "../../../hooks/useWorkbenchController.js";

export type ConsistencyReviewResult = {
  score?: unknown;
  reason?: unknown;
  risks?: unknown;
  graph_score?: unknown;
  graph_risks?: unknown;
};

export type ConsistencyReviewOutcome = {
  score: number;
  issueCount: number;
  bundle: ReviewReportsBundle | null;
  reportId: string;
  saveError: string;
};

export async function reviewRequest<T>(controller: WorkbenchController, pathname: string, init?: RequestInit): Promise<T> {
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

export async function runConsistencyReview(input: {
  controller: WorkbenchController;
  scope: "chapter" | "project";
  sourcePath: string;
  text: string;
}): Promise<ConsistencyReviewOutcome | null> {
  const skillResult = await input.controller.runWorkflowSkill("consistency_check", {
    text: input.text,
    source_path: input.sourcePath,
    review_scope: input.scope,
    instruction: "检查剧情连续性与事实冲突",
    write_result: false
  } as any);

  const result = skillResult?.data as ConsistencyReviewResult | undefined;
  const score = numericScore(result?.score);
  if (!result || score === null) return null;

  const reportInput = reviewInputFromResult({
    scope: input.scope,
    sourcePath: input.sourcePath,
    result
  });

  try {
    const current = await reviewRequest<ReviewReportsBundle>(input.controller, "/api/review-reports");
    const bundle = await reviewRequest<ReviewReportsBundle>(input.controller, "/api/review-reports", {
      method: "POST",
      body: JSON.stringify({ ...reportInput, base_revision: current.revision })
    });
    return {
      score,
      issueCount: reportInput.issues.length,
      bundle,
      reportId: bundle.reports[0]?.id || "",
      saveError: ""
    };
  } catch (error) {
    return {
      score,
      issueCount: reportInput.issues.length,
      bundle: null,
      reportId: "",
      saveError: error instanceof Error ? error.message : String(error)
    };
  }
}

function numericScore(value: unknown): number | null {
  const score = Number(value);
  return Number.isInteger(score) && score >= 0 && score <= 100 ? score : null;
}

function reviewInputFromResult(input: {
  scope: "chapter" | "project";
  sourcePath: string;
  result: ConsistencyReviewResult;
}): Omit<CreateReviewReportRequest, "base_revision"> {
  const risks = Array.isArray(input.result.risks) ? input.result.risks : [];
  const graphRisks = Array.isArray(input.result.graph_risks) ? input.result.graph_risks : [];
  return {
    scope: input.scope,
    source_paths: input.sourcePath ? [input.sourcePath] : ["02_正文"],
    summary: String(input.result.reason || "审阅已完成，请逐项处理建议。"),
    dimensions: [
      { id: "continuity", label: "连续性", score: numericScore(input.result.score) },
      ...(input.result.graph_score === undefined
        ? []
        : [{ id: "story_facts", label: "已确认事实", score: numericScore(input.result.graph_score) }])
    ],
    issues: [...risks, ...graphRisks].map((risk) => ({
      title: "建议处理",
      detail: String(risk),
      source_path: input.sourcePath,
      excerpt: ""
    }))
  };
}
