import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ProjectManifestService } from "@xiaoshuo/project-manifest";
import { afterEach, describe, expect, it } from "vitest";
import { InMemoryAgentFeatureFlagRegistry } from "./kernel/feature-flag-registry.js";
import { NovelRoomCoordinator, type NovelRoleReviewer } from "./novel-room-coordinator.js";
import { AgentRuntimeService } from "./runtime.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("NovelRoomCoordinator", () => {
  it("runs at most three fixed reviewers, degrades failures, and filters stale evidence", async () => {
    const root = await temporaryProject();
    const calls: string[] = [];
    const reviewer: NovelRoleReviewer = {
      review: async (input) => {
        calls.push(input.role);
        if (input.role === "character_reviewer") throw new Error("offline");
        return {
          role: input.role,
          status: "completed",
          summary: "完成",
          issues: [{
            issue_id: `issue-${input.role}`,
            category: input.role === "plot_reviewer" ? "plot" : "continuity",
            severity: "warning",
            summary: "需要检查",
            suggestion: "修订",
            evidence: [
              { source_path: "02_正文/第一章.md", source_revision: "rev-1", excerpt: "证据", claim_id: "" },
              { source_path: "../outside.txt", source_revision: "rev-1", excerpt: "越权", claim_id: "" },
              { source_path: "02_正文/第一章.md", source_revision: "old", excerpt: "过期", claim_id: "" }
            ],
            requires_user_decision: false
          }],
          error_code: "",
          duration_ms: 1
        };
      }
    };
    const coordinator = new NovelRoomCoordinator({ projectRoot: root, reviewer });
    const result = await coordinator.review({
      domain: "novel_creation",
      project_id: "project-a",
      run_id: "run-a",
      budget_id: "budget-a",
      instruction: "审校",
      draft: "",
      current_path: "02_正文/第一章.md",
      source_revision: "rev-1",
      requested_roles: ["plot_reviewer", "character_reviewer", "continuity_reviewer"],
      context_paths: ["02_正文/第一章.md"]
    });

    expect(calls).toHaveLength(3);
    expect(result.degraded).toBe(true);
    expect(result.reviews.find((review) => review.role === "character_reviewer")?.status).toBe("failed");
    expect(result.reviews.find((review) => review.role === "plot_reviewer")?.issues[0]?.evidence).toHaveLength(1);
  });

  it("blocks save proposals when fixed roles report a user-decision conflict", async () => {
    const root = await temporaryProject();
    const reviewer: NovelRoleReviewer = {
      review: async (input) => ({
        role: input.role,
        status: "completed",
        summary: "有分歧",
        issues: [{
          issue_id: `issue-${input.role}`,
          category: "plot",
          severity: "warning",
          summary: "剧情方向",
          suggestion: "",
          evidence: [],
          requires_user_decision: true
        }],
        error_code: "",
        duration_ms: 1
      })
    };
    const coordinator = new NovelRoomCoordinator({ projectRoot: root, reviewer });
    const result = await coordinator.review({
      domain: "novel_creation",
      project_id: "project-a",
      run_id: "run-a",
      budget_id: "budget-a",
      instruction: "审校",
      draft: "",
      current_path: "02_正文/第一章.md",
      source_revision: "rev-1",
      requested_roles: ["plot_reviewer", "style_reviewer"],
      context_paths: []
    });
    expect(result.conflicts).toHaveLength(1);
    expect(result.save_proposal_allowed).toBe(false);
  });

  it("replaces renderer run and budget identities with a trusted durable review run", async () => {
    const root = await temporaryProject();
    const configPath = path.join(root, "studio_config.json");
    await fs.writeFile(configPath, JSON.stringify({ api_key: "test-key", model: "test-model" }), "utf8");
    const runtime = new AgentRuntimeService({
      projectRoot: root,
      config: { configPath },
      featureFlags: novelFlags(),
      modelClient: budgetedModelClient(JSON.stringify({
          role: "plot_reviewer",
          status: "completed",
          summary: "剧情推进成立",
          issues: [],
          error_code: "",
          duration_ms: 1
        }))
    });
    try {
      const projectId = await new ProjectManifestService(root).getProjectId();
      const result = await runtime.reviewNovelRoom({
        domain: "novel_creation",
        project_id: projectId,
        run_id: "renderer-run-id",
        budget_id: "renderer-budget-id",
        instruction: "检查剧情",
        draft: "第一章正文",
        current_path: "02_正文/第一章.md",
        source_revision: "rev-1",
        requested_roles: ["plot_reviewer"],
        context_paths: []
      });
      const run = runtime.getDurableRun(result.run_id);

      expect(result.run_id).not.toBe("renderer-run-id");
      expect(run?.status, JSON.stringify(run, null, 2)).toBe("completed");
      expect(run && "legacy_unbudgeted" in run.budget).toBe(false);
      if (run && !("legacy_unbudgeted" in run.budget)) {
        expect(run.budget.budget_id).not.toBe("renderer-budget-id");
        expect(run.budget.used_model_calls).toBe(1);
      }
    } finally {
      runtime.close();
    }
  });

  it("executes a background novel unit through a budgeted durable model run", async () => {
    const root = await temporaryProject();
    const configPath = path.join(root, "studio_config.json");
    await fs.writeFile(configPath, JSON.stringify({ api_key: "test-key", model: "test-model" }), "utf8");
    const runtime = new AgentRuntimeService({
      projectRoot: root,
      config: { configPath },
      featureFlags: novelFlags(),
      modelClient: budgetedModelClient("## 一致性报告\n\n未发现阻断冲突。")
    });
    try {
      const projectId = await new ProjectManifestService(root).getProjectId();
      const result = await runtime.runNovelBackgroundUnit({
        request_id: "background-unit-1",
        project_id: projectId,
        kind: "full_consistency_scan",
        relative_path: "02_正文/第一章.md",
      input_revision: "rev-1",
      content: "第一章正文",
      max_input_tokens: 10_000,
      max_output_tokens: 512,
      max_cost_usd: 0.5
      });
      const run = runtime.getDurableRun(result.run_id);

      expect(result.report).toContain("一致性报告");
      expect(result.used_model_calls).toBe(1);
      expect(run?.status).toBe("completed");
    } finally {
      runtime.close();
    }
  });

  it("rejects an insufficient background cost budget before creating a run or calling the model", async () => {
    const root = await temporaryProject();
    const configPath = path.join(root, "studio_config.json");
    await fs.writeFile(configPath, JSON.stringify({ api_key: "test-key", model: "test-model" }), "utf8");
    let modelCalls = 0;
    const runtime = new AgentRuntimeService({
      projectRoot: root,
      config: { configPath },
      featureFlags: novelFlags(),
      modelClient: { requestCompletion: async () => { modelCalls += 1; return "unexpected"; } }
    });
    try {
      const projectId = await new ProjectManifestService(root).getProjectId();
      await expect(runtime.runNovelBackgroundUnit({
        request_id: "background-no-budget",
        project_id: projectId,
        kind: "material_summary",
        relative_path: "02_正文/第一章.md",
        input_revision: "rev-1",
        content: "第一章正文",
        max_input_tokens: 10_000,
        max_output_tokens: 512,
        max_cost_usd: 0
      })).rejects.toThrowError(expect.objectContaining({ code: "NOVEL_TASK_COST_BUDGET_EXHAUSTED" }));
      expect(modelCalls).toBe(0);
      expect(runtime.listDurableRuns()).toHaveLength(0);
    } finally {
      runtime.close();
    }
  });
});

async function temporaryProject(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "arcwriter-novel-room-"));
  roots.push(root);
  await fs.mkdir(path.join(root, "02_正文"), { recursive: true });
  await fs.writeFile(path.join(root, "02_正文", "第一章.md"), "第一章正文", "utf8");
  return root;
}

function novelFlags(): InMemoryAgentFeatureFlagRegistry {
  return new InMemoryAgentFeatureFlagRegistry({
    agent_execution_v2_mode: "on",
    model_gateway_v2: true,
    context_budget_v2: true,
    memory_v2: true,
    novel_agent_room_v1: true,
    novel_background_tasks_v1: true
  });
}

function budgetedModelClient(response: string) {
  return {
    requestCompletion: async (config: any, messages: any, _temperature?: number, options: any = {}) => {
      const input = { config, messages, maxOutputTokens: options.maxOutputTokens, stream: false };
      const context = options.dispatchLifecycle?.beforeDispatch?.(input);
      options.dispatchLifecycle?.onDispatchStarted?.({ ...input, context });
      options.dispatchLifecycle?.onDispatchFinished?.({ ...input, context });
      return response;
    }
  };
}
