import { AgentRuntimeService, type AgentFeatureFlagRegistry } from "@xiaoshuo/agent-runtime";
import { DocumentService } from "@xiaoshuo/document-service";
import { ProjectManifestService, readExistingProjectId } from "@xiaoshuo/project-manifest";
import {
  novelAgentWorkspaceSnapshotSchema,
  novelBackgroundTaskControlSchema,
  novelBackgroundTaskCreateSchema,
  novelBackgroundTaskSchema,
  novelMemoryBatchReviewRequestSchema,
  novelProjectTransferConfirmSchema,
  novelProjectTransferSourceConfirmRequestSchema,
  novelProjectTransferSourceConfirmResultSchema,
  novelProjectTransferPlanRequestSchema,
  novelProjectTransferPlanSchema,
  novelRoomDesktopRequestSchema,
  novelToolInstallProposalRequestSchema,
  novelToolInstallRequestSchema,
  novelTypedActionRequestSchema,
  novelTypedActionResultSchema,
  novelWorkspaceProjectSchema,
  type NovelAgentWorkspaceSnapshot,
  type NovelBackgroundTask,
  type NovelBackgroundTaskControl,
  type NovelBackgroundTaskCreate,
  type NovelMemoryBatchPrepareResult,
  type NovelMemoryBatchReviewRequest,
  type NovelMemoryBatchReviewResult,
  type NovelProjectTransferConfirm,
  type NovelProjectTransferSourceConfirmRequest,
  type NovelProjectTransferSourceConfirmResult,
  type NovelProjectTransferPlan,
  type NovelProjectTransferPlanRequest,
  type NovelProjectTransferResult,
  type NovelRoomDesktopRequest,
  type NovelRoomResponse,
  type NovelToolCatalogEntry,
  type NovelToolInstallProposal,
  type NovelToolInstallProposalRequest,
  type NovelToolInstallRequest,
  type NovelToolInstallResult,
  type NovelTypedActionRequest,
  type NovelTypedActionResult,
  type NovelWorkspaceProject
} from "@xiaoshuo/shared";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { ProjectIdentityRegistry } from "./project-identity-registry.js";

type PersistedState = {
  version: 1;
  proposals: NovelToolInstallProposal[];
  installed_tool_ids: string[];
  tasks: NovelBackgroundTask[];
  transfers: NovelProjectTransferPlan[];
  transfer_recoveries: TransferRecovery[];
  transfer_confirmations: TransferSourceConfirmation[];
  consumed_operation_ids: string[];
};

type TransferRecovery = {
  transfer_id: string;
  target_project_root: string;
  entries: Array<{ target_path: string; backup_path: string; existed: boolean }>;
};

type TransferSourceConfirmation = {
  transfer_id: string;
  source_confirmation_id: string;
  plan_sha256: string;
  expires_at: string;
};

export type NovelAgentControlServiceOptions = {
  appRoot: string;
  statePath: string;
  getFeatureFlags: () => AgentFeatureFlagRegistry | undefined;
  getRuntimeRegistry: () => Map<string, AgentRuntimeService>;
  getProjectIdentityRegistry: () => ProjectIdentityRegistry | undefined;
};

const catalog = buildCatalog();
const catalogSha256 = sha256(JSON.stringify(catalog));

export class NovelAgentControlService {
  private state: PersistedState | null = null;
  private writeBarrier: Promise<void> = Promise.resolve();
  private readonly scheduledTasks = new Set<string>();

  constructor(private readonly options: NovelAgentControlServiceOptions) {}

  async snapshot(projectValue: NovelWorkspaceProject): Promise<NovelAgentWorkspaceSnapshot> {
    const project = novelWorkspaceProjectSchema.parse(projectValue);
    await this.assertProject(project);
    const state = await this.loadState();
    await this.recoverProjectTransfers(project, state);
    return novelAgentWorkspaceSnapshotSchema.parse({
      catalog_sha256: catalogSha256,
      catalog,
      tool_proposals: state.proposals.filter((item) => item.project_id === project.project_id),
      installed_tool_ids: state.installed_tool_ids,
      background_tasks: state.tasks.filter((item) => item.project_id === project.project_id),
      transfer_plans: state.transfers.filter((item) =>
        item.source_project_id === project.project_id || item.target_project_id === project.project_id
      )
    });
  }

  async review(value: NovelRoomDesktopRequest, signal?: AbortSignal): Promise<NovelRoomResponse> {
    this.assertFeature("novel_agent_room_v1");
    const payload = novelRoomDesktopRequestSchema.parse(value);
    const project = { project_id: payload.request.project_id, project_root: payload.project_root };
    const runtime = await this.runtime(project);
    return runtime.reviewNovelRoom(payload.request, signal);
  }

  async proposeTool(value: NovelToolInstallProposalRequest): Promise<NovelToolInstallProposal> {
    this.assertFeature("novel_tool_catalog_v1");
    const request = novelToolInstallProposalRequestSchema.parse(value);
    await this.assertProject({ project_id: request.project_id, project_root: request.project_root });
    const tool = catalog.find((item) => item.tool_id === request.tool_id && item.version === request.version);
    if (!tool) {
      throw codedError("NOVEL_TOOL_NOT_ALLOWLISTED", "该工具或版本不在 ArcWriter 内置小说工具目录中");
    }
    const now = Date.now();
    const proposal: NovelToolInstallProposal = {
      proposal_id: `tool_${randomUUID().replace(/-/g, "")}`,
      project_id: request.project_id,
      run_id: request.run_id,
      budget_id: request.budget_id,
      tool_id: tool.tool_id,
      version: tool.version,
      reason: request.reason,
      catalog_sha256: catalogSha256,
      status: "pending",
      created_at: new Date(now).toISOString(),
      expires_at: new Date(now + 30 * 60_000).toISOString()
    };
    await this.mutate((state) => { state.proposals.push(proposal); });
    return proposal;
  }

  async installTool(value: NovelToolInstallRequest): Promise<NovelToolInstallResult> {
    this.assertFeature("novel_tool_catalog_v1");
    const request = novelToolInstallRequestSchema.parse(value);
    const state = await this.loadState();
    const proposal = state.proposals.find((item) => item.proposal_id === request.proposal_id);
    if (!proposal || proposal.status !== "pending") {
      throw codedError("NOVEL_TOOL_PROPOSAL_INVALID", "工具申请不存在或已处理");
    }
    if (Date.parse(proposal.expires_at) <= Date.now()) {
      throw codedError("NOVEL_TOOL_PROPOSAL_EXPIRED", "工具申请已过期");
    }
    if (request.expected_catalog_sha256 !== catalogSha256 || proposal.catalog_sha256 !== catalogSha256) {
      throw codedError("NOVEL_TOOL_CATALOG_CHANGED", "工具目录已变化，请重新查看权限并确认");
    }
    const tool = catalog.find((item) => item.tool_id === proposal.tool_id && item.version === proposal.version);
    if (!tool) {
      throw codedError("NOVEL_TOOL_NOT_ALLOWLISTED", "工具已不在内置目录中");
    }
    await this.mutate((next) => {
      const current = next.proposals.find((item) => item.proposal_id === proposal.proposal_id);
      if (!current || current.status !== "pending") {
        throw codedError("NOVEL_TOOL_PROPOSAL_INVALID", "工具申请已被并发处理");
      }
      current.status = "installed";
      next.installed_tool_ids = unique([...next.installed_tool_ids, tool.tool_id]);
    });
    return { proposal_id: proposal.proposal_id, tool_id: tool.tool_id, version: tool.version, status: "installed", message: "已激活随应用发布的内置小说工具" };
  }

  async createBackgroundTask(value: NovelBackgroundTaskCreate): Promise<NovelBackgroundTask> {
    this.assertFeature("novel_background_tasks_v1");
    const request = novelBackgroundTaskCreateSchema.parse(value);
    await this.assertProject(request);
    if (Date.parse(request.budget.deadline_at) <= Date.now()) {
      throw codedError("NOVEL_TASK_DEADLINE_INVALID", "后台任务 deadline 必须晚于当前时间");
    }
    const documents = new DocumentService({ projectRoot: request.project_root });
    const resolvedPaths = await resolveBackgroundTaskPaths(request);
    if ((request.kind === "material_summary" || request.kind === "approved_chapter_drafts") && !resolvedPaths.length) {
      throw codedError("NOVEL_TASK_SOURCE_REQUIRED", "该小说后台任务必须显式选择项目内输入文件");
    }
    if (request.kind === "approved_chapter_drafts" && resolvedPaths.some((item) => !item.replace(/\\/g, "/").startsWith("01_大纲/"))) {
      throw codedError("NOVEL_TASK_APPROVED_PLAN_REQUIRED", "章节草稿后台任务只能绑定 01_大纲 下的已确认计划");
    }
    const chapterPaths = request.kind === "material_summary" ? [] : resolvedPaths;
    const materialPaths = request.kind === "material_summary" ? resolvedPaths : [];
    const inputRevision = resolvedPaths.length
      ? await backgroundSnapshotHash(documents, resolvedPaths)
      : request.input_revision;
    const now = new Date().toISOString();
    const totalUnits = Math.max(1, resolvedPaths.length);
    const task = novelBackgroundTaskSchema.parse({
      ...request,
      chapter_paths: chapterPaths,
      material_paths: materialPaths,
      input_revision: inputRevision,
      task_id: `novtask_${randomUUID().replace(/-/g, "")}`,
      status: "queued",
      completed_units: 0,
      total_units: totalUnits,
      used_steps: 0,
      used_model_calls: 0,
      used_input_tokens: 0,
      used_output_tokens: 0,
      used_cost_usd: 0,
      error_code: "",
      created_at: now,
      updated_at: now
    });
    await this.mutate((state) => { state.tasks.push(task); });
    this.scheduleTask(task.task_id);
    return task;
  }

  async runTypedAction(
    value: NovelTypedActionRequest,
    executor: (request: NovelTypedActionRequest) => Promise<NovelTypedActionResult>
  ): Promise<NovelTypedActionResult> {
    this.assertFeature("novel_typed_actions_v1");
    const request = novelTypedActionRequestSchema.parse(value);
    await this.assertProject(request);
    const requiredTool = requiredToolForAction(request.action);
    if (requiredTool && !(await this.loadState()).installed_tool_ids.includes(requiredTool)) {
      throw codedError("NOVEL_TOOL_REQUIRED", `请先激活内置小说工具 ${requiredTool}`);
    }
    let result: NovelTypedActionResult | null = null;
    await this.consumeOperation(request.operation_id, async () => {
      result = novelTypedActionResultSchema.parse(await executor(request));
    });
    return result!;
  }

  async controlBackgroundTask(value: NovelBackgroundTaskControl): Promise<NovelBackgroundTask> {
    this.assertFeature("novel_background_tasks_v1");
    const request = novelBackgroundTaskControlSchema.parse(value);
    await this.assertProject(request);
    await this.consumeOperation(request.operation_id, (state) => {
      const task = state.tasks.find((item) => item.task_id === request.task_id && item.project_id === request.project_id);
      if (!task || task.status !== request.expected_status) {
        throw codedError("NOVEL_TASK_STATE_CONFLICT", "后台任务状态已变化，请刷新后重试");
      }
      if (request.action === "resume") {
        if (task.status !== "paused") {
          throw codedError("NOVEL_TASK_RESUME_REJECTED", "只有用户暂停或应用退出暂停的任务可以恢复");
        }
        if (Date.parse(task.budget.deadline_at) <= Date.now()) {
          task.status = "paused_budget_exhausted";
          task.error_code = "NOVEL_TASK_DEADLINE_EXHAUSTED";
        } else {
          task.status = "queued";
          task.error_code = "";
        }
      } else if (request.action === "pause") {
        if (task.status !== "queued" && task.status !== "running") {
          throw codedError("NOVEL_TASK_PAUSE_REJECTED", "当前任务不能暂停");
        }
        task.status = "paused";
      } else {
        if (task.status === "completed" || task.status === "cancelled") {
          throw codedError("NOVEL_TASK_CANCEL_REJECTED", "任务已经结束");
        }
        task.status = "cancelled";
      }
      task.updated_at = new Date().toISOString();
    }, true);
    const updated = (await this.loadState()).tasks.find((item) => item.task_id === request.task_id);
    if (!updated) throw codedError("NOVEL_TASK_NOT_FOUND", "后台任务不存在");
    if (updated.status === "queued") this.scheduleTask(updated.task_id);
    return novelBackgroundTaskSchema.parse(updated);
  }

  async pauseAll(): Promise<void> {
    const state = await this.loadState();
    if (!state.tasks.some((task) => task.status === "queued" || task.status === "running")) {
      return;
    }
    await this.mutate((next) => {
      for (const task of next.tasks) {
        if (task.status === "queued" || task.status === "running") {
          task.status = "paused";
          task.error_code = "APPLICATION_EXIT_PAUSE";
          task.updated_at = new Date().toISOString();
        }
      }
    });
  }

  async createTransferPlan(value: NovelProjectTransferPlanRequest): Promise<NovelProjectTransferPlan> {
    this.assertFeature("novel_project_transfer_v1");
    const request = novelProjectTransferPlanRequestSchema.parse(value);
    if (request.source_project_id === request.target_project_id) {
      throw codedError("NOVEL_TRANSFER_SAME_PROJECT", "来源项目和目标项目必须不同");
    }
    await this.assertProject({ project_id: request.source_project_id, project_root: request.source_project_root });
    await this.assertProject({ project_id: request.target_project_id, project_root: request.target_project_root });
    const sourceDocuments = new DocumentService({ projectRoot: request.source_project_root });
    const targetDocuments = new DocumentService({ projectRoot: request.target_project_root });
    const items = [];
    for (const [index, item] of request.items.entries()) {
      const sourcePath = sourceDocuments.normalizeRelativePath(item.source_path);
      const targetPath = targetDocuments.normalizeRelativePath(item.target_path);
      const sourceTarget = await sourceDocuments.resolveSafePath(sourcePath);
      const sourceContent = await fs.readFile(sourceTarget, "utf8");
      const sourceStats = await fs.stat(sourceTarget);
      const targetTarget = await targetDocuments.resolveSafePath(targetPath, { allowMissing: true });
      const targetContent = await fs.readFile(targetTarget, "utf8").catch(() => "");
      const targetStats = await fs.stat(targetTarget).catch(() => null);
      if (item.strategy === "create" && targetStats) {
        throw codedError("NOVEL_TRANSFER_TARGET_EXISTS", `目标文件已存在，不能使用 create：${targetPath}`);
      }
      items.push({
        item_id: `transfer_item_${index + 1}`,
        kind: item.kind,
        source_path: sourcePath,
        source_revision: String(sourceStats.mtimeMs),
        source_sha256: sha256(sourceContent),
        target_path: targetPath,
        target_revision: targetStats ? String(targetStats.mtimeMs) : "",
        target_sha256: targetStats ? sha256(targetContent) : "",
        strategy: item.strategy,
        diff_preview: buildDiffPreview(targetContent, sourceContent, item.strategy)
      });
    }
    const unsigned = {
      transfer_id: `transfer_${randomUUID().replace(/-/g, "")}`,
      source_project_id: request.source_project_id,
      source_project_root: path.resolve(request.source_project_root),
      target_project_id: request.target_project_id,
      target_project_root: path.resolve(request.target_project_root),
      items,
      status: "awaiting_confirmation" as const,
      expires_at: new Date(Date.now() + 15 * 60_000).toISOString()
    };
    const plan = novelProjectTransferPlanSchema.parse({ ...unsigned, plan_sha256: sha256Stable(unsigned) });
    await this.mutate((state) => { state.transfers.push(plan); });
    return plan;
  }

  async confirmTransferSource(
    value: NovelProjectTransferSourceConfirmRequest
  ): Promise<NovelProjectTransferSourceConfirmResult> {
    this.assertFeature("novel_project_transfer_v1");
    const request = novelProjectTransferSourceConfirmRequestSchema.parse(value);
    let result: NovelProjectTransferSourceConfirmResult | null = null;
    await this.mutate((state) => {
      const plan = state.transfers.find((item) => item.transfer_id === request.transfer_id);
      if (!plan || plan.status !== "awaiting_confirmation" || plan.plan_sha256 !== request.plan_sha256) {
        throw codedError("NOVEL_TRANSFER_PLAN_STALE", "迁移计划不存在、已确认或内容已变化");
      }
      if (Date.parse(plan.expires_at) <= Date.now()) {
        throw codedError("NOVEL_TRANSFER_PLAN_EXPIRED", "迁移计划已过期");
      }
      const confirmation = novelProjectTransferSourceConfirmResultSchema.parse({
        transfer_id: plan.transfer_id,
        source_confirmation_id: `transfer_source_${randomUUID().replace(/-/g, "")}`,
        expires_at: new Date(Math.min(Date.parse(plan.expires_at), Date.now() + 5 * 60_000)).toISOString()
      });
      plan.status = "approved";
      state.transfer_confirmations = state.transfer_confirmations.filter((item) => item.transfer_id !== plan.transfer_id);
      state.transfer_confirmations.push({ ...confirmation, plan_sha256: plan.plan_sha256 });
      result = confirmation;
    });
    return result!;
  }

  async commitTransfer(value: NovelProjectTransferConfirm): Promise<NovelProjectTransferResult> {
    this.assertFeature("novel_project_transfer_v1");
    const request = novelProjectTransferConfirmSchema.parse(value);
    if (request.source_confirmation_id === request.target_confirmation_id) {
      throw codedError("NOVEL_TRANSFER_DOUBLE_CONFIRM_REQUIRED", "来源读取和目标写入必须分别确认");
    }
    const state = await this.loadState();
    const plan = state.transfers.find((item) => item.transfer_id === request.transfer_id);
    if (!plan || plan.status !== "approved" || plan.plan_sha256 !== request.plan_sha256) {
      throw codedError("NOVEL_TRANSFER_PLAN_STALE", "迁移计划不存在、已处理或内容已变化");
    }
    if (Date.parse(plan.expires_at) <= Date.now()) {
      throw codedError("NOVEL_TRANSFER_PLAN_EXPIRED", "迁移计划已过期");
    }
    const sourceConfirmation = state.transfer_confirmations.find((item) =>
      item.transfer_id === plan.transfer_id
      && item.plan_sha256 === plan.plan_sha256
      && item.source_confirmation_id === request.source_confirmation_id
    );
    if (!sourceConfirmation || Date.parse(sourceConfirmation.expires_at) <= Date.now()) {
      throw codedError("NOVEL_TRANSFER_SOURCE_CONFIRMATION_REQUIRED", "来源项目读取确认不存在、已过期或不匹配");
    }
    await this.assertProject({ project_id: plan.source_project_id, project_root: plan.source_project_root });
    await this.assertProject({ project_id: plan.target_project_id, project_root: plan.target_project_root });
    const sourceDocuments = new DocumentService({ projectRoot: plan.source_project_root });
    const targetDocuments = new DocumentService({ projectRoot: plan.target_project_root });
    const prepared: Array<{ target: string; content: string; before: string | null }> = [];
    for (const item of plan.items) {
      if (item.strategy === "skip") continue;
      const sourceTarget = await sourceDocuments.resolveSafePath(item.source_path);
      const sourceContent = await fs.readFile(sourceTarget, "utf8");
      const sourceStats = await fs.stat(sourceTarget);
      const targetTarget = await targetDocuments.resolveSafePath(item.target_path, { allowMissing: true });
      const targetContent = await fs.readFile(targetTarget, "utf8").catch(() => null);
      const targetStats = await fs.stat(targetTarget).catch(() => null);
      if (String(sourceStats.mtimeMs) !== item.source_revision || sha256(sourceContent) !== item.source_sha256) {
        throw codedError("NOVEL_TRANSFER_SOURCE_STALE", `来源文件已变化：${item.source_path}`);
      }
      const targetRevision = targetStats ? String(targetStats.mtimeMs) : "";
      const targetHash = targetContent === null ? "" : sha256(targetContent);
      if (targetRevision !== item.target_revision || targetHash !== item.target_sha256) {
        throw codedError("NOVEL_TRANSFER_TARGET_STALE", `目标文件已变化：${item.target_path}`);
      }
      const content = item.strategy === "append" && targetContent ? `${targetContent.trimEnd()}\n\n${sourceContent}` : sourceContent;
      prepared.push({ target: targetTarget, content, before: targetContent });
    }
    if (state.consumed_operation_ids.includes(request.operation_id)) {
      throw codedError("NOVEL_OPERATION_REPLAYED", "该迁移操作已消费，不能重放");
    }
    const recoveryRoot = path.join(plan.target_project_root, "00_设定集", ".agent", "transfer-journals", plan.transfer_id);
    const recovery: TransferRecovery = { transfer_id: plan.transfer_id, target_project_root: plan.target_project_root, entries: [] };
    await fs.mkdir(recoveryRoot, { recursive: true });
    for (const [index, entry] of prepared.entries()) {
      const backupPath = path.join(recoveryRoot, `${index}.bak`);
      if (entry.before !== null) await fs.writeFile(backupPath, entry.before, "utf8");
      recovery.entries.push({ target_path: entry.target, backup_path: backupPath, existed: entry.before !== null });
    }
    await this.mutate((next) => {
      const current = next.transfers.find((item) => item.transfer_id === plan.transfer_id);
      if (!current || current.status !== "approved") throw codedError("NOVEL_TRANSFER_PLAN_STALE", "迁移计划已被并发处理");
      current.status = "committing";
      next.transfer_recoveries.push(recovery);
      next.transfer_confirmations = next.transfer_confirmations.filter((item) => item.transfer_id !== plan.transfer_id);
      next.consumed_operation_ids.push(request.operation_id);
    });
    let committed = 0;
    try {
      for (const entry of prepared) {
        await fs.mkdir(path.dirname(entry.target), { recursive: true });
        await targetDocuments.revalidateAbsoluteProjectPath(entry.target);
        const temporary = `${entry.target}.${randomUUID()}.tmp`;
        await fs.writeFile(temporary, entry.content, "utf8");
        await fs.rename(temporary, entry.target);
        committed += 1;
      }
      await fs.rm(recoveryRoot, { recursive: true, force: true });
      await this.mutate((next) => {
        const current = next.transfers.find((item) => item.transfer_id === plan.transfer_id);
        if (current) current.status = "committed";
        next.transfer_recoveries = next.transfer_recoveries.filter((item) => item.transfer_id !== plan.transfer_id);
      });
    } catch (error) {
      await restoreTransferRecovery(recovery);
      await this.mutate((next) => {
        const current = next.transfers.find((item) => item.transfer_id === plan.transfer_id);
        if (current) current.status = "failed";
        next.transfer_recoveries = next.transfer_recoveries.filter((item) => item.transfer_id !== plan.transfer_id);
      });
      throw error;
    }
    return { transfer_id: plan.transfer_id, status: "committed", committed_items: committed, message: "跨项目小说素材已按双确认计划提交" };
  }

  async prepareMemoryBatch(projectValue: NovelWorkspaceProject): Promise<NovelMemoryBatchPrepareResult> {
    this.assertFeature("novel_memory_batch_review_v1");
    return (await this.runtime(novelWorkspaceProjectSchema.parse(projectValue))).prepareGovernedMemoryBatch();
  }

  async confirmMemoryBatch(projectRoot: string, value: NovelMemoryBatchReviewRequest): Promise<NovelMemoryBatchReviewResult> {
    this.assertFeature("novel_memory_batch_review_v1");
    const request = novelMemoryBatchReviewRequestSchema.parse(value);
    let result: NovelMemoryBatchReviewResult | null = null;
    await this.consumeOperation(request.operation_id, async () => {
      result = await (await this.runtime({ project_id: request.project_id, project_root: projectRoot }))
        .confirmGovernedMemoryBatch(request);
    });
    return result!;
  }

  private async runtime(project: NovelWorkspaceProject): Promise<AgentRuntimeService> {
    await this.assertProject(project);
    const root = path.resolve(project.project_root);
    const key = process.platform === "win32" ? root.toLowerCase() : root;
    const registry = this.options.getRuntimeRegistry();
    const existing = registry.get(key);
    if (existing) return existing;
    const featureFlags = this.options.getFeatureFlags();
    if (!featureFlags) throw codedError("NOVEL_AGENT_FLAGS_UNAVAILABLE", "Agent 功能开关尚未初始化");
    const runtime = new AgentRuntimeService({
      projectRoot: root,
      config: { rootDir: this.options.appRoot, env: process.env },
      featureFlags,
      autoRecoverStaleRuns: false
    });
    registry.set(key, runtime);
    return runtime;
  }

  private async recoverProjectTransfers(project: NovelWorkspaceProject, state: PersistedState): Promise<void> {
    const projectRoot = normalizeRoot(project.project_root);
    const recoveries = state.transfer_recoveries.filter((recovery) => {
      const plan = state.transfers.find((item) => item.transfer_id === recovery.transfer_id);
      return plan?.target_project_id === project.project_id && normalizeRoot(recovery.target_project_root) === projectRoot;
    });
    if (!recoveries.length) return;
    for (const recovery of recoveries) await restoreTransferRecovery(recovery);
    const recoveredIds = new Set(recoveries.map((item) => item.transfer_id));
    for (const plan of state.transfers) {
      if (recoveredIds.has(plan.transfer_id) && plan.status === "committing") plan.status = "failed";
    }
    state.transfer_recoveries = state.transfer_recoveries.filter((item) => !recoveredIds.has(item.transfer_id));
    await this.writeState(state);
  }

  private async assertProject(value: Pick<NovelWorkspaceProject, "project_id" | "project_root">): Promise<void> {
    const root = path.resolve(value.project_root);
    const actual = await readExistingProjectId(root);
    if (!actual || actual !== value.project_id) {
      throw codedError("NOVEL_PROJECT_ID_MISMATCH", "小说项目 UUID 与目录不匹配");
    }
    const identities = this.options.getProjectIdentityRegistry();
    if (!identities) throw codedError("NOVEL_PROJECT_IDENTITY_UNAVAILABLE", "项目身份注册表尚未初始化");
    identities.assertWritable(root, value.project_id);
  }

  private assertFeature(key: keyof ReturnType<AgentFeatureFlagRegistry["snapshot"]>): void {
    const snapshot = this.options.getFeatureFlags()?.snapshot();
    if (!snapshot || snapshot.agent_execution_v2_mode !== "on" || !snapshot[key]) {
      throw codedError("NOVEL_AGENT_FEATURE_DISABLED", `小说 Agent 能力 ${key} 当前已关闭`);
    }
  }

  private scheduleTask(taskId: string): void {
    if (this.scheduledTasks.has(taskId)) return;
    this.scheduledTasks.add(taskId);
    setTimeout(() => {
      void this.runTask(taskId).finally(() => this.scheduledTasks.delete(taskId));
    }, 0);
  }

  private async runTask(taskId: string): Promise<void> {
    let task = (await this.loadState()).tasks.find((item) => item.task_id === taskId);
    if (!task || task.status !== "queued") return;
    await this.mutate((state) => {
      const current = state.tasks.find((item) => item.task_id === taskId);
      if (current?.status === "queued") {
        current.status = "running";
        current.updated_at = new Date().toISOString();
      }
    });
    const documents = new DocumentService({ projectRoot: task.project_root });
    const paths = unique([...task.chapter_paths, ...task.material_paths]).slice(0, task.max_chapters);
    const reportPath = `00_设定集/.agent/novel-reports/${taskId}.md`;
    const previousReport = await documents.readRawText(reportPath, 500_000).catch(() => "");
    const report: string[] = previousReport.trim()
      ? [previousReport.trimEnd(), ""]
      : [`# 小说后台任务报告`, ``, `任务：${task.kind}`, `输入 revision：${task.input_revision}`, ``];
    try {
      const units = paths.length ? paths : [""];
      for (const [unitIndex, relativePath] of units.entries()) {
        if (unitIndex < task.completed_units) continue;
        task = (await this.loadState()).tasks.find((item) => item.task_id === taskId);
        if (!task || task.status !== "running") return;
        if (Date.parse(task.budget.deadline_at) <= Date.now()
          || task.used_steps >= task.budget.max_steps
          || task.used_model_calls >= task.budget.max_model_calls
          || task.used_input_tokens >= task.budget.max_input_tokens
          || task.used_output_tokens >= task.budget.max_output_tokens
          || task.used_cost_usd >= task.budget.max_cost_usd) {
          await this.finishTask(taskId, "paused_budget_exhausted", "NOVEL_TASK_BUDGET_EXHAUSTED");
          return;
        }
        if (relativePath) {
          if (await backgroundSnapshotHash(documents, paths) !== task.input_revision) {
            await this.finishTask(taskId, "failed", "NOVEL_TASK_INPUT_REVISION_STALE");
            return;
          }
          const document = await documents.readDocument(relativePath);
          const content = document.content.slice(0, 60_000);
          const estimatedInputTokens = Math.max(1, Math.ceil(content.length / 3));
          const remainingInputTokens = task.budget.max_input_tokens - task.used_input_tokens;
          const remainingOutputTokens = task.budget.max_output_tokens - task.used_output_tokens;
          if (estimatedInputTokens > remainingInputTokens || remainingOutputTokens <= 0) {
            await this.finishTask(taskId, "paused_budget_exhausted", "NOVEL_TASK_TOKEN_BUDGET_EXHAUSTED");
            return;
          }
          const runtime = await this.runtime({ project_id: task.project_id, project_root: task.project_root });
          const result = await runtime.runNovelBackgroundUnit({
            request_id: `${task.task_id}:unit:${unitIndex}:${sha256(`${relativePath}:${task.input_revision}`)}`,
            project_id: task.project_id,
            kind: task.kind,
            relative_path: relativePath,
            input_revision: task.input_revision,
            content,
            max_input_tokens: remainingInputTokens,
            max_output_tokens: remainingOutputTokens,
            max_cost_usd: task.budget.max_cost_usd - task.used_cost_usd
          });
          report.push(`## ${relativePath}`, ``, result.report.trim(), "", `Durable run：${result.run_id}`, "");
          await documents.saveDocument(reportPath, `${report.join("\n")}\n`, {
            source: "novel_background_task",
            summary: "保存小说后台任务检查点"
          });
          await this.mutate((state) => {
            const current = state.tasks.find((item) => item.task_id === taskId);
            if (!current || current.status !== "running") return;
            current.completed_units += 1;
            current.used_steps += 1;
            current.used_model_calls += result.used_model_calls;
            current.used_input_tokens += result.used_input_tokens;
            current.used_output_tokens += result.used_output_tokens;
            current.used_cost_usd += result.used_cost_usd;
            current.updated_at = new Date().toISOString();
          });
        } else {
          report.push("当前任务未指定文件，已完成项目级检查点。", "");
          await this.mutate((state) => {
            const current = state.tasks.find((item) => item.task_id === taskId);
            if (!current || current.status !== "running") return;
            current.completed_units += 1;
            current.used_steps += 1;
            current.updated_at = new Date().toISOString();
          });
        }
      }
      await documents.saveDocument(reportPath, `${report.join("\n")}\n`, {
        source: "novel_background_task",
        summary: "保存小说后台任务报告"
      });
      await this.finishTask(taskId, "completed", "");
    } catch (error) {
      const code = String((error as { code?: unknown })?.code || "NOVEL_TASK_EXECUTION_FAILED");
      await this.finishTask(taskId, code.includes("BUDGET") ? "paused_budget_exhausted" : "failed", code);
    }
  }

  private async finishTask(taskId: string, status: NovelBackgroundTask["status"], errorCode: string): Promise<void> {
    await this.mutate((state) => {
      const task = state.tasks.find((item) => item.task_id === taskId);
      if (!task || task.status === "cancelled" || task.status === "paused") return;
      task.status = status;
      task.error_code = errorCode;
      task.updated_at = new Date().toISOString();
    });
  }

  private async consumeOperation(
    operationId: string,
    action: (state: PersistedState) => void | Promise<void>,
    persistStateMutation = false
  ): Promise<void> {
    let reservedState: PersistedState | null = null;
    await this.mutate((state) => {
      if (state.consumed_operation_ids.includes(operationId)) {
        throw codedError("NOVEL_OPERATION_REPLAYED", "该操作回执已消费，不能重放");
      }
      state.consumed_operation_ids.push(operationId);
      reservedState = state;
    });
    if (persistStateMutation) {
      await this.mutate(action);
      return;
    }
    await action(reservedState!);
  }

  private async loadState(): Promise<PersistedState> {
    if (this.state) return this.state;
    const raw = await fs.readFile(this.options.statePath, "utf8").catch(() => "");
    const parsed = raw.trim() ? JSON.parse(raw) as Partial<PersistedState> : {};
    this.state = {
      version: 1,
      proposals: Array.isArray(parsed.proposals) ? parsed.proposals : [],
      installed_tool_ids: Array.isArray(parsed.installed_tool_ids) ? parsed.installed_tool_ids : [],
      tasks: Array.isArray(parsed.tasks) ? parsed.tasks.map((task) => novelBackgroundTaskSchema.parse(task)) : [],
      transfers: Array.isArray(parsed.transfers) ? parsed.transfers.map((plan) => novelProjectTransferPlanSchema.parse(plan)) : [],
      transfer_recoveries: Array.isArray(parsed.transfer_recoveries) ? parsed.transfer_recoveries as TransferRecovery[] : [],
      transfer_confirmations: Array.isArray(parsed.transfer_confirmations)
        ? parsed.transfer_confirmations as TransferSourceConfirmation[]
        : [],
      consumed_operation_ids: Array.isArray(parsed.consumed_operation_ids) ? parsed.consumed_operation_ids : []
    };
    this.state.transfer_confirmations = this.state.transfer_confirmations.filter((item) => Date.parse(item.expires_at) > Date.now());
    let changed = false;
    for (const task of this.state.tasks) {
      if (task.status === "queued" || task.status === "running") {
        task.status = "paused";
        task.error_code = "APPLICATION_RESTART_PAUSE";
        task.updated_at = new Date().toISOString();
        changed = true;
      }
    }
    if (changed) await this.writeState(this.state);
    return this.state;
  }

  private async mutate(action: (state: PersistedState) => void | Promise<void>): Promise<void> {
    const previous = this.writeBarrier;
    let release!: () => void;
    this.writeBarrier = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      const state = await this.loadState();
      await action(state);
      await this.writeState(state);
    } finally {
      release();
    }
  }

  private async writeState(state: PersistedState): Promise<void> {
    await fs.mkdir(path.dirname(this.options.statePath), { recursive: true });
    const temporary = path.join(path.dirname(this.options.statePath), `.${path.basename(this.options.statePath)}.${randomUUID()}.tmp`);
    await fs.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await fs.rename(temporary, this.options.statePath);
    this.state = state;
  }
}

function buildCatalog(): NovelToolCatalogEntry[] {
  return [
    ["novel_tokenizer", "小说分词与字数统计", "离线统计章节字数、段落和词频", ["project_read"]],
    ["novel_text_import", "TXT/EPUB 素材导入", "通过主进程选择并导入小说参考素材", ["project_write"]],
    ["novel_document_convert", "小说文档格式转换", "在 TXT 与 Markdown 之间做本地转换", ["project_read", "project_write", "document_convert"]],
    ["novel_story_index", "本地故事索引", "重建人物、伏笔和时间线的本地索引", ["project_read", "project_write", "local_index"]]
  ].map(([toolId, name, description, permissions]) => ({
    tool_id: toolId as string,
    version: "1.0.0",
    name: name as string,
    description: description as string,
    sha256: sha256(`arcwriter-builtin:${toolId}:1.0.0`),
    compatible_app_versions: ">=0.9.0 <1.0.0",
    permissions: permissions as NovelToolCatalogEntry["permissions"],
    input_schema_id: `${toolId}.input.v1`,
    output_schema_id: `${toolId}.output.v1`,
    installer_id: `activate_builtin_${toolId}`,
    uninstaller_id: `deactivate_builtin_${toolId}`,
    rollback_version: ""
  }));
}

function requiredToolForAction(action: NovelTypedActionRequest["action"]): string {
  return ({
    rebuild_index: "novel_story_index",
    import_material: "novel_text_import",
    convert_document: "novel_document_convert"
  } as Partial<Record<NovelTypedActionRequest["action"], string>>)[action] || "";
}

function buildDiffPreview(before: string, source: string, strategy: "create" | "append" | "replace" | "skip"): string {
  const preview = strategy === "skip"
    ? "跳过，不写入目标项目。"
    : `策略：${strategy}\n--- 目标当前内容 ---\n${before}\n+++ 来源内容 +++\n${source}`;
  return preview.slice(0, 20_000);
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function sha256Stable(value: unknown): string {
  return sha256(stableJson(value));
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

async function resolveBackgroundTaskPaths(request: NovelBackgroundTaskCreate): Promise<string[]> {
  const requested = unique([...request.chapter_paths, ...request.material_paths]);
  if (requested.length) return requested.slice(0, request.max_chapters);
  if (request.kind === "material_summary" || request.kind === "approved_chapter_drafts") return [];
  const manifest = new ProjectManifestService(request.project_root);
  const documents = await manifest.listDocuments({ force: true });
  return documents
    .map((document) => document.path.replace(/\\/g, "/"))
    .filter((documentPath) => /\.(md|txt)$/i.test(documentPath) && !documentPath.includes("/.agent/"))
    .filter((documentPath) => request.kind === "batch_chapter_quality"
      ? documentPath.startsWith("02_正文/")
      : /^(00_设定集|01_大纲|02_正文)\//.test(documentPath))
    .slice(0, request.max_chapters);
}

async function backgroundSnapshotHash(documents: DocumentService, paths: readonly string[]): Promise<string> {
  const revisions = [];
  for (const relativePath of paths) {
    const document = await documents.readDocument(relativePath);
    revisions.push({
      path: relativePath,
      updated_at: document.updated_at,
      content_sha256: sha256(document.content)
    });
  }
  return sha256Stable(revisions);
}

function codedError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

async function restoreTransferRecovery(recovery: TransferRecovery): Promise<void> {
  const root = path.resolve(recovery.target_project_root);
  const documents = new DocumentService({ projectRoot: root });
  const journalRoot = path.resolve(root, "00_设定集", ".agent", "transfer-journals", recovery.transfer_id);
  if (!isInside(root, journalRoot)) throw codedError("NOVEL_TRANSFER_JOURNAL_INVALID", "迁移恢复 journal 目录无效");
  for (const entry of [...recovery.entries].reverse()) {
    const target = path.resolve(entry.target_path);
    const backup = path.resolve(entry.backup_path);
    if (!isInside(root, target) || !isInside(journalRoot, backup)) {
      throw codedError("NOVEL_TRANSFER_JOURNAL_INVALID", "迁移恢复 journal 包含越权路径");
    }
    await documents.revalidateAbsoluteProjectPath(target);
    if (entry.existed) {
      await documents.revalidateAbsoluteProjectPath(backup, false);
      const content = await fs.readFile(backup);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content);
    } else {
      await fs.rm(target, { force: true });
    }
  }
  await fs.rm(journalRoot, { recursive: true, force: true });
}

function normalizeRoot(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isInside(root: string, target: string): boolean {
  const normalizedRoot = normalizeRoot(root);
  const normalizedTarget = normalizeRoot(target);
  return normalizedTarget !== normalizedRoot && normalizedTarget.startsWith(`${normalizedRoot}${path.sep}`);
}
