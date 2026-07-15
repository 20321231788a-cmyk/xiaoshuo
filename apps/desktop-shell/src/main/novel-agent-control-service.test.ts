import { InMemoryAgentFeatureFlagRegistry } from "@xiaoshuo/agent-runtime";
import { ProjectManifestService } from "@xiaoshuo/project-manifest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NovelAgentControlService } from "./novel-agent-control-service.js";
import type { ProjectIdentityRegistry } from "./project-identity-registry.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("NovelAgentControlService", () => {
  it("activates only exact built-in catalog entries and rejects arbitrary package names", async () => {
    const project = await createProject("catalog");
    const service = createService(project.project_root);
    const snapshot = await service.snapshot(project);
    await expect(service.proposeTool({ ...project, run_id: "run", budget_id: "budget", tool_id: "npm:any-package", version: "latest", reason: "install" })).rejects.toThrow();
    const tool = snapshot.catalog[0]!;
    const proposal = await service.proposeTool({ ...project, run_id: "run", budget_id: "budget", tool_id: tool.tool_id, version: tool.version, reason: "小说创作" });
    const result = await service.installTool({ proposal_id: proposal.proposal_id, expected_catalog_sha256: snapshot.catalog_sha256, confirmation_id: "confirm" });
    expect(result.status).toBe("installed");
    expect((await service.snapshot(project)).installed_tool_ids).toContain(tool.tool_id);
  });

  it("requires the matching activated built-in tool before a typed novel action", async () => {
    const project = await createProject("typed-tool-gate");
    const service = createService(project.project_root);
    const request = {
      action: "rebuild_index" as const,
      ...project,
      confirmation_id: "confirm-action",
      operation_id: "typed-action-1"
    };
    let executions = 0;
    const executor = async () => {
      executions += 1;
      return { action: "rebuild_index" as const, operation_id: request.operation_id, ok: true, output_path: "index.md", message: "done" };
    };

    await expect(service.runTypedAction(request, executor))
      .rejects.toThrowError(expect.objectContaining({ code: "NOVEL_TOOL_REQUIRED" }));
    expect(executions).toBe(0);
    const snapshot = await service.snapshot(project);
    const tool = snapshot.catalog.find((item) => item.tool_id === "novel_story_index")!;
    const proposal = await service.proposeTool({
      ...project,
      run_id: "tool-run",
      budget_id: "tool-budget",
      tool_id: tool.tool_id,
      version: tool.version,
      reason: "重建小说索引"
    });
    await service.installTool({
      proposal_id: proposal.proposal_id,
      expected_catalog_sha256: snapshot.catalog_sha256,
      confirmation_id: "confirm-tool"
    });
    await expect(service.runTypedAction(request, executor)).resolves.toMatchObject({ ok: true });
    expect(executions).toBe(1);
  });

  it("rejects a cross-project transfer when the source revision changes after preview", async () => {
    const source = await createProject("source");
    const target = await createProject("target");
    await fs.writeFile(path.join(source.project_root, "00_设定集", "人物.txt"), "原始人物设定", "utf8");
    await fs.writeFile(path.join(target.project_root, "00_设定集", "人物.txt"), "目标人物设定", "utf8");
    const service = createService(source.project_root);
    const plan = await service.createTransferPlan({
      source_project_id: source.project_id,
      source_project_root: source.project_root,
      target_project_id: target.project_id,
      target_project_root: target.project_root,
      items: [{ kind: "character_setting", source_path: "00_设定集/人物.txt", target_path: "00_设定集/人物.txt", strategy: "replace" }]
    });
    const sourceConfirmation = await service.confirmTransferSource({
      transfer_id: plan.transfer_id,
      plan_sha256: plan.plan_sha256
    });
    await fs.writeFile(path.join(source.project_root, "00_设定集", "人物.txt"), "预览后被修改", "utf8");
    await expect(service.commitTransfer({
      transfer_id: plan.transfer_id,
      plan_sha256: plan.plan_sha256,
      source_confirmation_id: sourceConfirmation.source_confirmation_id,
      target_confirmation_id: "target-confirm",
      operation_id: "transfer-operation"
    })).rejects.toThrowError(expect.objectContaining({ code: "NOVEL_TRANSFER_SOURCE_STALE" }));
    expect(await fs.readFile(path.join(target.project_root, "00_设定集", "人物.txt"), "utf8")).toBe("目标人物设定");
  });

  it("requires separate source and target confirmations before a cross-project write", async () => {
    const source = await createProject("double-confirm-source");
    const target = await createProject("double-confirm-target");
    await fs.writeFile(path.join(source.project_root, "00_设定集", "人物.txt"), "来源设定", "utf8");
    await fs.writeFile(path.join(target.project_root, "00_设定集", "人物.txt"), "目标旧设定", "utf8");
    const service = createService(source.project_root);
    const plan = await service.createTransferPlan({
      source_project_id: source.project_id,
      source_project_root: source.project_root,
      target_project_id: target.project_id,
      target_project_root: target.project_root,
      items: [{ kind: "character_setting", source_path: "00_设定集/人物.txt", target_path: "00_设定集/人物.txt", strategy: "replace" }]
    });
    const commit = (sourceConfirmationId: string, operationId: string) => service.commitTransfer({
      transfer_id: plan.transfer_id,
      plan_sha256: plan.plan_sha256,
      source_confirmation_id: sourceConfirmationId,
      target_confirmation_id: `target-${operationId}`,
      operation_id: operationId
    });

    await expect(commit("fabricated", "before-source-confirm"))
      .rejects.toThrowError(expect.objectContaining({ code: "NOVEL_TRANSFER_PLAN_STALE" }));
    const sourceConfirmation = await service.confirmTransferSource({
      transfer_id: plan.transfer_id,
      plan_sha256: plan.plan_sha256
    });
    await expect(commit("fabricated", "wrong-source-confirm"))
      .rejects.toThrowError(expect.objectContaining({ code: "NOVEL_TRANSFER_SOURCE_CONFIRMATION_REQUIRED" }));
    await expect(commit(sourceConfirmation.source_confirmation_id, "confirmed-write"))
      .resolves.toMatchObject({ status: "committed", committed_items: 1 });
    expect(await fs.readFile(path.join(target.project_root, "00_设定集", "人物.txt"), "utf8")).toBe("来源设定");
  });

  it("restores the old target state from a persistent transfer journal after restart", async () => {
    const source = await createProject("journal-source");
    const target = await createProject("journal-target");
    const sourceFile = path.join(source.project_root, "00_设定集", "人物.txt");
    const targetFile = path.join(target.project_root, "00_设定集", "人物.txt");
    await fs.writeFile(sourceFile, "新设定", "utf8");
    await fs.writeFile(targetFile, "旧设定", "utf8");
    const service = createService(source.project_root);
    const plan = await service.createTransferPlan({
      source_project_id: source.project_id,
      source_project_root: source.project_root,
      target_project_id: target.project_id,
      target_project_root: target.project_root,
      items: [{ kind: "character_setting", source_path: "00_设定集/人物.txt", target_path: "00_设定集/人物.txt", strategy: "replace" }]
    });
    const recoveryRoot = path.join(target.project_root, "00_设定集", ".agent", "transfer-journals", plan.transfer_id);
    const backupPath = path.join(recoveryRoot, "0.bak");
    await fs.mkdir(recoveryRoot, { recursive: true });
    await fs.writeFile(backupPath, "旧设定", "utf8");
    await fs.writeFile(targetFile, "崩溃时的半提交状态", "utf8");
    const statePath = path.join(source.project_root, ".test-state", "novel-agent.json");
    const state = JSON.parse(await fs.readFile(statePath, "utf8"));
    state.transfers[0].status = "committing";
    state.transfer_recoveries = [{
      transfer_id: plan.transfer_id,
      target_project_root: target.project_root,
      entries: [{ target_path: targetFile, backup_path: backupPath, existed: true }]
    }];
    await fs.writeFile(statePath, JSON.stringify(state), "utf8");
    const reopened = createService(source.project_root);
    const snapshot = await reopened.snapshot(target);
    expect(await fs.readFile(targetFile, "utf8")).toBe("旧设定");
    expect(snapshot.transfer_plans.find((item) => item.transfer_id === plan.transfer_id)?.status).toBe("failed");
  });

  it("requires a future deadline and preserves the original budget when paused", async () => {
    const project = await createProject("background");
    const service = createService(project.project_root);
    const base = {
      ...project,
      kind: "full_consistency_scan" as const,
      input_revision: "rev-1",
      chapter_paths: [],
      material_paths: [],
      max_chapters: 1,
      confirmation_id: "confirm",
      budget: {
        budget_id: "budget",
        max_steps: 1,
        max_replans: 0,
        max_model_calls: 1,
        max_input_tokens: 1,
        max_output_tokens: 1,
        max_cost_usd: 0,
        deadline_at: new Date(Date.now() - 1_000).toISOString(),
        max_retries: 0
      }
    };
    await expect(service.createBackgroundTask(base)).rejects.toThrowError(expect.objectContaining({ code: "NOVEL_TASK_DEADLINE_INVALID" }));
    const task = await service.createBackgroundTask({ ...base, budget: { ...base.budget, deadline_at: new Date(Date.now() + 60_000).toISOString() } });
    await service.pauseAll();
    const stored = (await service.snapshot(project)).background_tasks.find((item) => item.task_id === task.task_id)!;
    expect(["paused", "completed"]).toContain(stored.status);
    expect(stored.budget).toEqual(task.budget);
  });

  it("discovers project novel files and seals a trusted multi-file input snapshot", async () => {
    const project = await createProject("background-snapshot");
    await fs.mkdir(path.join(project.project_root, "02_正文"), { recursive: true });
    await fs.writeFile(path.join(project.project_root, "02_正文", "第一章.md"), "第一章", "utf8");
    await fs.writeFile(path.join(project.project_root, "02_正文", "第二章.md"), "第二章", "utf8");
    const service = createService(project.project_root);
    const task = await service.createBackgroundTask({
      ...project,
      kind: "full_consistency_scan",
      input_revision: "renderer-supplied-revision",
      chapter_paths: [],
      material_paths: [],
      max_chapters: 20,
      confirmation_id: "confirm",
      budget: {
        budget_id: "budget-snapshot",
        max_steps: 20,
        max_replans: 0,
        max_model_calls: 2,
        max_input_tokens: 10_000,
        max_output_tokens: 2_000,
        max_cost_usd: 0.5,
        deadline_at: new Date(Date.now() + 60_000).toISOString(),
        max_retries: 0
      }
    });
    await service.pauseAll();

    expect(task.chapter_paths).toEqual(expect.arrayContaining(["02_正文/第一章.md", "02_正文/第二章.md"]));
    expect(task.input_revision).toMatch(/^[a-f0-9]{64}$/);
    expect(task.input_revision).not.toBe("renderer-supplied-revision");
  });

  it("accepts approved chapter drafts only from an explicitly selected outline", async () => {
    const project = await createProject("approved-draft-source");
    await fs.mkdir(path.join(project.project_root, "01_大纲"), { recursive: true });
    await fs.mkdir(path.join(project.project_root, "02_正文"), { recursive: true });
    await fs.writeFile(path.join(project.project_root, "01_大纲", "章纲.md"), "第一章章纲", "utf8");
    await fs.writeFile(path.join(project.project_root, "02_正文", "第一章.md"), "第一章正文", "utf8");
    const service = createService(project.project_root);
    const request = (chapterPaths: string[]) => ({
      ...project,
      kind: "approved_chapter_drafts" as const,
      input_revision: "renderer-revision",
      chapter_paths: chapterPaths,
      material_paths: [],
      max_chapters: 1,
      confirmation_id: "confirm",
      budget: {
        budget_id: "approved-draft-budget",
        max_steps: 1,
        max_replans: 0,
        max_model_calls: 1,
        max_input_tokens: 10_000,
        max_output_tokens: 2_000,
        max_cost_usd: 0.5,
        deadline_at: new Date(Date.now() + 60_000).toISOString(),
        max_retries: 0
      }
    });

    await expect(service.createBackgroundTask(request([])))
      .rejects.toThrowError(expect.objectContaining({ code: "NOVEL_TASK_SOURCE_REQUIRED" }));
    await expect(service.createBackgroundTask(request(["02_正文/第一章.md"])))
      .rejects.toThrowError(expect.objectContaining({ code: "NOVEL_TASK_APPROVED_PLAN_REQUIRED" }));
    const task = await service.createBackgroundTask(request(["01_大纲/章纲.md"]));
    await service.pauseAll();
    expect(task.chapter_paths).toEqual(["01_大纲/章纲.md"]);
  });
});

function createService(appRoot: string): NovelAgentControlService {
  const flags = new InMemoryAgentFeatureFlagRegistry({
    agent_execution_v2_mode: "on",
    model_gateway_v2: true,
    agent_replanning_v2: true,
    context_budget_v2: true,
    memory_v2: true,
    novel_agent_room_v1: true,
    novel_tool_catalog_v1: true,
    novel_typed_actions_v1: true,
    novel_background_tasks_v1: true,
    novel_project_transfer_v1: true,
    novel_memory_batch_review_v1: true
  });
  const identity = { assertWritable: () => undefined } as unknown as ProjectIdentityRegistry;
  return new NovelAgentControlService({
    appRoot,
    statePath: path.join(appRoot, ".test-state", "novel-agent.json"),
    getFeatureFlags: () => flags,
    getRuntimeRegistry: () => new Map(),
    getProjectIdentityRegistry: () => identity
  });
}

async function createProject(name: string): Promise<{ project_id: string; project_root: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `arcwriter-${name}-`));
  roots.push(root);
  await fs.mkdir(path.join(root, "00_设定集"), { recursive: true });
  const manifest = new ProjectManifestService(root);
  await manifest.listDocuments({ force: true });
  const projectId = await manifest.getProjectId();
  return { project_id: projectId, project_root: root };
}
