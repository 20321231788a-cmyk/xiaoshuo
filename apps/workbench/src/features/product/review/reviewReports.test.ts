import { describe, expect, it, vi } from "vitest";
import type { WorkbenchController } from "../../../hooks/useWorkbenchController.js";
import { runConsistencyReview } from "./reviewReports.js";

describe("runConsistencyReview", () => {
  it("runs a chapter check and saves a revisioned review report", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const controller = {
      runtime: {
        apiBase: "http://127.0.0.1:18453",
        fetchFn: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          requests.push({ url: String(input), init });
          if (init?.method === "POST") {
            return new Response(JSON.stringify({
              schema_version: 1,
              revision: 5,
              reports: [{ id: "report-1" }]
            }), { status: 200, headers: { "Content-Type": "application/json" } });
          }
          return new Response(JSON.stringify({ schema_version: 1, revision: 4, reports: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          });
        })
      },
      runWorkflowSkill: vi.fn(async () => ({
        data: {
          score: 86,
          reason: "连续性基本稳定",
          risks: ["人物动机需要补强"],
          graph_score: 78,
          graph_risks: ["已确认设定存在冲突"]
        }
      }))
    } as unknown as WorkbenchController;

    const outcome = await runConsistencyReview({
      controller,
      scope: "chapter",
      sourcePath: "02_正文/第01章.txt",
      text: "章节正文"
    });

    expect(controller.runWorkflowSkill).toHaveBeenCalledWith("consistency_check", expect.objectContaining({
      source_path: "02_正文/第01章.txt",
      review_scope: "chapter",
      write_result: false
    }));
    expect(outcome).toMatchObject({ score: 86, issueCount: 2, reportId: "report-1", saveError: "" });
    const payload = JSON.parse(String(requests[1]?.init?.body));
    expect(payload).toMatchObject({
      base_revision: 4,
      scope: "chapter",
      source_paths: ["02_正文/第01章.txt"]
    });
    expect(payload.issues).toHaveLength(2);
  });

  it("keeps the completed score when report persistence fails", async () => {
    const controller = {
      runtime: {
        apiBase: "http://127.0.0.1:18453",
        fetchFn: vi.fn(async () => new Response(JSON.stringify({ detail: "本地报告写入失败" }), {
          status: 500,
          headers: { "Content-Type": "application/json" }
        }))
      },
      runWorkflowSkill: vi.fn(async () => ({ data: { score: 72, risks: [], reason: "检查完成" } }))
    } as unknown as WorkbenchController;

    await expect(runConsistencyReview({
      controller,
      scope: "chapter",
      sourcePath: "02_正文/正文.txt",
      text: "章节正文"
    })).resolves.toMatchObject({
      score: 72,
      issueCount: 0,
      bundle: null,
      saveError: "本地报告写入失败"
    });
  });
});
