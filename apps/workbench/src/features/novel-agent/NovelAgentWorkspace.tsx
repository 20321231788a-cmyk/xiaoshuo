import type {
  NovelAgentWorkspaceSnapshot,
  NovelBackgroundTask,
  NovelBackgroundTaskKind,
  NovelMemoryBatchPrepareResult,
  NovelProjectTransferPlan,
  NovelProjectTransferSourceConfirmResult,
  NovelReviewRole,
  NovelRoomResponse,
  NovelTypedAction,
  NovelWorkspaceProject
} from "@xiaoshuo/shared";
import {
  BookCheck,
  Boxes,
  Check,
  Download,
  FolderOpen,
  MemoryStick,
  Pause,
  Play,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Square,
  Upload
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

export type NovelWorkspaceTab = "room" | "tools" | "tasks" | "transfer" | "memory";

const roleOptions: Array<{ id: NovelReviewRole; label: string }> = [
  { id: "plot_reviewer", label: "剧情" },
  { id: "character_reviewer", label: "人物" },
  { id: "continuity_reviewer", label: "连续性" },
  { id: "style_reviewer", label: "文风" }
];

const backgroundTaskOptions: Array<{ id: NovelBackgroundTaskKind; label: string }> = [
  { id: "full_consistency_scan", label: "全书一致性扫描" },
  { id: "story_index_rebuild", label: "人物/伏笔/时间线索引" },
  { id: "batch_chapter_quality", label: "章节质量报告" },
  { id: "material_summary", label: "素材整理与摘要" },
  { id: "approved_chapter_drafts", label: "已确认计划章节草稿" }
];

export function NovelAgentWorkspace({
  projectRoot,
  activePath,
  activeContent,
  sourceRevision,
  initialTab = "room",
  onOpenSkills
}: {
  projectRoot: string;
  activePath: string;
  activeContent: string;
  sourceRevision: string;
  initialTab?: NovelWorkspaceTab;
  onOpenSkills: () => void;
}) {
  const api = window.xiaoshuoDesktop?.novelAgent;
  const [project, setProject] = useState<NovelWorkspaceProject | null>(null);
  const [snapshot, setSnapshot] = useState<NovelAgentWorkspaceSnapshot | null>(null);
  const [tab, setTab] = useState<NovelWorkspaceTab>(initialTab);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function refresh(current = project) {
    if (!api || !current) return;
    setSnapshot(await api.snapshot(current));
  }

  useEffect(() => {
    let cancelled = false;
    if (!api || !projectRoot) {
      setProject(null);
      setSnapshot(null);
      return;
    }
    void api.identifyProject({ project_root: projectRoot })
      .then(async (identified) => {
        if (cancelled) return;
        setProject(identified);
        setSnapshot(await api.snapshot(identified));
      })
      .catch((error) => !cancelled && setMessage(errorMessage(error)));
    return () => { cancelled = true; };
  }, [api, projectRoot]);

  useEffect(() => {
    setTab(initialTab);
  }, [initialTab]);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setMessage("");
    try {
      await action();
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  if (!api) {
    return <EmptyState text="小说 Agent 控制面仅在 ArcWriter Desktop 中可用。" />;
  }
  if (!projectRoot) {
    return <EmptyState text="请先打开一个小说项目。" />;
  }

  return (
    <section className="xw-feature-page xw-novel-agent-page">
      <div className="xw-novel-agent-tabs" role="tablist" aria-label="小说 Agent 工作区">
        {([
          ["room", "编辑室"],
          ["tools", "工具与动作"],
          ["tasks", "后台任务"],
          ["transfer", "素材迁移"],
          ["memory", "记忆审核"]
        ] as Array<[NovelWorkspaceTab, string]>).map(([key, label]) => (
          <button key={key} id={`novel-tab-${key}`} role="tab" aria-selected={tab === key} aria-controls={`novel-panel-${key}`} type="button" className={tab === key ? "active" : ""} onClick={() => setTab(key)}>{label}</button>
        ))}
        <button type="button" className="xw-icon-button" title="刷新" aria-label="刷新小说 Agent 状态" onClick={() => void run(() => refresh())} disabled={!project || busy}>
          <RefreshCw size={15} />
        </button>
      </div>

      {tab === "room" && project && (
        <div id="novel-panel-room" role="tabpanel" aria-labelledby="novel-tab-room"><RoomPanel
          project={project}
          activePath={activePath}
          activeContent={activeContent}
          sourceRevision={sourceRevision}
          busy={busy}
          run={run}
          onOpenSkills={onOpenSkills}
        /></div>
      )}
      {tab === "tools" && project && snapshot && (
        <div id="novel-panel-tools" role="tabpanel" aria-labelledby="novel-tab-tools"><ToolsPanel project={project} snapshot={snapshot} busy={busy} run={run} refresh={() => refresh(project)} /></div>
      )}
      {tab === "tasks" && project && snapshot && (
        <div id="novel-panel-tasks" role="tabpanel" aria-labelledby="novel-tab-tasks"><TasksPanel project={project} tasks={snapshot.background_tasks} activePath={activePath} sourceRevision={sourceRevision} busy={busy} run={run} refresh={() => refresh(project)} /></div>
      )}
      {tab === "transfer" && project && (
        <div id="novel-panel-transfer" role="tabpanel" aria-labelledby="novel-tab-transfer"><TransferPanel project={project} busy={busy} run={run} refresh={() => refresh(project)} /></div>
      )}
      {tab === "memory" && project && <div id="novel-panel-memory" role="tabpanel" aria-labelledby="novel-tab-memory"><MemoryPanel project={project} busy={busy} run={run} /></div>}
      {message && <p className="xw-status-line" role="status">{message}</p>}
    </section>
  );
}

function RoomPanel({ project, activePath, activeContent, sourceRevision, busy, run, onOpenSkills }: {
  project: NovelWorkspaceProject;
  activePath: string;
  activeContent: string;
  sourceRevision: string;
  busy: boolean;
  run: (action: () => Promise<void>) => Promise<void>;
  onOpenSkills: () => void;
}) {
  const [instruction, setInstruction] = useState("检查当前章节的剧情推进、人物动机、连续性和文风，并给出可执行修订建议。");
  const [roles, setRoles] = useState<NovelReviewRole[]>(["plot_reviewer", "character_reviewer", "continuity_reviewer"]);
  const [result, setResult] = useState<NovelRoomResponse | null>(null);

  function toggleRole(role: NovelReviewRole) {
    setRoles((current) => current.includes(role) ? current.filter((item) => item !== role) : current.length < 3 ? [...current, role] : current);
  }

  return (
    <div className="xw-novel-agent-grid">
      <section className="xw-novel-agent-section">
        <h3>固定角色审校</h3>
        <div className="xw-novel-role-picker">
          {roleOptions.map((role) => (
            <label key={role.id}><input type="checkbox" checked={roles.includes(role.id)} onChange={() => toggleRole(role.id)} />{role.label}</label>
          ))}
        </div>
        <textarea value={instruction} onChange={(event) => setInstruction(event.target.value)} rows={4} aria-label="审校目标" />
        <div className="xw-novel-action-row">
          <button className="xw-primary-button" type="button" disabled={busy || !activePath || !roles.length} onClick={() => void run(async () => {
            const response = await window.xiaoshuoDesktop!.novelAgent.review({
              project_root: project.project_root,
              request: {
                domain: "novel_creation",
                project_id: project.project_id,
                run_id: `novel_room_${crypto.randomUUID()}`,
                budget_id: `novel_budget_${crypto.randomUUID()}`,
                instruction,
                draft: activeContent,
                current_path: activePath,
                source_revision: sourceRevision || "unsaved",
                requested_roles: roles,
                context_paths: activePath ? [activePath] : []
              }
            });
            setResult(response);
          })}>
            <Sparkles size={15} />运行审校
          </button>
          <button className="xw-secondary-button" type="button" onClick={onOpenSkills}><ShieldCheck size={15} />Skill 草稿</button>
        </div>
      </section>
      <section className="xw-novel-agent-section xw-novel-review-results">
        <h3>合并结果</h3>
        {!result && <span className="xw-muted">尚无审校结果</span>}
        {result && (
          <div className="xw-novel-merged-summary">
            <div><strong>主笔合并摘要</strong><span>{result.degraded ? "部分审校角色降级" : "全部审校完成"}</span></div>
            <p>{result.merged_summary || "审校已完成，查看各角色建议。"}</p>
            <small>运行 {result.run_id} · 来源版本 {result.source_revision}</small>
          </div>
        )}
        {result?.reviews.map((review) => (
          <article key={review.role}>
            <strong>{roleOptions.find((item) => item.id === review.role)?.label} · {reviewStatusLabel(review.status)}</strong>
            <p>{review.summary}</p>
            {review.issues.map((issue) => (
              <div key={issue.issue_id} className={`xw-novel-issue ${issue.severity}`}>
                <div><strong>{severityLabel(issue.severity)} · {issue.summary}</strong>{issue.requires_user_decision && <em>需要作者决定</em>}</div>
                {issue.suggestion && <p>建议：{issue.suggestion}</p>}
                {issue.evidence.map((evidence, index) => (
                  <small key={`${evidence.source_path}-${index}`}>证据：{evidence.source_path} · {evidence.excerpt || "已引用项目内容"}</small>
                ))}
              </div>
            ))}
          </article>
        ))}
        {result?.conflicts.map((conflict) => <div key={conflict.conflict_id} className="xw-novel-conflict">需用户决定：{conflict.summary}</div>)}
        {result && <span className={`xw-job-pill ${result.save_proposal_allowed ? "done" : "failed"}`}>{result.save_proposal_allowed ? "可生成保存提案" : "保存提案已暂停"}</span>}
      </section>
    </div>
  );
}

function ToolsPanel({ project, snapshot, busy, run, refresh }: {
  project: NovelWorkspaceProject;
  snapshot: NovelAgentWorkspaceSnapshot;
  busy: boolean;
  run: (action: () => Promise<void>) => Promise<void>;
  refresh: () => Promise<void>;
}) {
  const actions: Array<[NovelTypedAction, string, typeof Download]> = [
    ["backup_project", "备份项目", Download],
    ["export_project", "导出项目", Upload],
    ["rebuild_index", "重建索引", RefreshCw],
    ["import_material", "导入素材", FolderOpen],
    ["convert_document", "转换文档", BookCheck],
    ["open_project_folder", "打开目录", FolderOpen]
  ];
  const requiredTools: Partial<Record<NovelTypedAction, string>> = {
    rebuild_index: "novel_story_index",
    import_material: "novel_text_import",
    convert_document: "novel_document_convert"
  };
  return (
    <div className="xw-novel-agent-grid">
      <section className="xw-novel-agent-section">
        <h3>内置小说工具</h3>
        <div className="xw-novel-tool-list">
          {snapshot.catalog.map((tool) => {
            const installed = snapshot.installed_tool_ids.includes(tool.tool_id);
            const pending = snapshot.tool_proposals.find((item) => item.tool_id === tool.tool_id && item.status === "pending");
            return <article key={tool.tool_id}>
              <div><strong>{tool.name}</strong><small>{tool.version}</small></div>
              <span>{tool.permissions.join(" · ")}</span>
              {installed ? <em><Check size={13} />已激活</em> : pending ? (
                <button data-novel-user-gesture="install_tool" type="button" disabled={busy} onClick={() => void run(async () => {
                  await window.xiaoshuoDesktop!.novelAgent.installTool({ proposal_id: pending.proposal_id, expected_catalog_sha256: snapshot.catalog_sha256, confirmation_id: crypto.randomUUID() });
                  await refresh();
                })}>确认激活</button>
              ) : (
                <button type="button" disabled={busy} onClick={() => void run(async () => {
                  await window.xiaoshuoDesktop!.novelAgent.proposeTool({
                    ...project,
                    run_id: `tool_run_${crypto.randomUUID()}`,
                    budget_id: `tool_budget_${crypto.randomUUID()}`,
                    tool_id: tool.tool_id,
                    version: tool.version,
                    reason: "用于当前小说项目的创作与整理"
                  });
                  await refresh();
                })}>提交申请</button>
              )}
            </article>;
          })}
        </div>
      </section>
      <section className="xw-novel-agent-section">
        <h3>类型化项目动作</h3>
        <div className="xw-novel-action-grid">
          {actions.map(([action, label, Icon]) => {
            const requiredTool = requiredTools[action];
            const unavailable = Boolean(requiredTool && !snapshot.installed_tool_ids.includes(requiredTool));
            return <button key={action} data-novel-user-gesture="typed_action" type="button" disabled={busy || unavailable} title={unavailable ? "请先激活对应的内置小说工具" : label} onClick={() => void run(async () => {
            await window.xiaoshuoDesktop!.novelAgent.runAction({ action, ...project, format: action === "convert_document" ? "md" : undefined, confirmation_id: crypto.randomUUID(), operation_id: crypto.randomUUID() });
            await refresh();
          })}><Icon size={15} />{label}</button>;
          })}
        </div>
      </section>
    </div>
  );
}

function TasksPanel({ project, tasks, activePath, sourceRevision, busy, run, refresh }: {
  project: NovelWorkspaceProject;
  tasks: NovelBackgroundTask[];
  activePath: string;
  sourceRevision: string;
  busy: boolean;
  run: (action: () => Promise<void>) => Promise<void>;
  refresh: () => Promise<void>;
}) {
  const [kind, setKind] = useState<NovelBackgroundTaskKind>("full_consistency_scan");
  const selectedTask = backgroundTaskOptions.find((item) => item.id === kind)!;
  const materialTask = kind === "material_summary";
  const selectedDocumentTask = materialTask || kind === "approved_chapter_drafts";
  const approvedPlanUnavailable = kind === "approved_chapter_drafts" && !activePath.replace(/\\/g, "/").startsWith("01_大纲/");
  return <section className="xw-novel-agent-section">
    <div className="xw-section-head"><h3>有预算后台任务</h3><div className="xw-novel-action-row"><select aria-label="后台任务类型" value={kind} onChange={(event) => setKind(event.target.value as NovelBackgroundTaskKind)}>{backgroundTaskOptions.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select><button className="xw-primary-button compact" data-novel-user-gesture="background_create" type="button" title={approvedPlanUnavailable ? "请先打开 01_大纲 下的已确认计划" : selectedTask.label} disabled={busy || (selectedDocumentTask && !activePath) || approvedPlanUnavailable} onClick={() => void run(async () => {
      await window.xiaoshuoDesktop!.novelAgent.createBackgroundTask({
        ...project,
        kind,
        input_revision: sourceRevision || "project-snapshot",
        chapter_paths: activePath && kind === "approved_chapter_drafts" ? [activePath] : [],
        material_paths: activePath && materialTask ? [activePath] : [],
        max_chapters: 20,
        budget: {
          budget_id: `bg_${crypto.randomUUID()}`,
          max_steps: 20,
          max_replans: 0,
          max_model_calls: 1,
          max_input_tokens: 100_000,
          max_output_tokens: 20_000,
          max_cost_usd: 0.5,
          deadline_at: new Date(Date.now() + 60 * 60_000).toISOString(),
          max_retries: 1
        },
        confirmation_id: crypto.randomUUID()
      });
      await refresh();
    })}><Play size={14} />创建{selectedTask.label}</button></div></div>
    <div className="xw-novel-task-list">
      {tasks.map((task) => <article key={task.task_id}>
        <div><strong>{backgroundTaskOptions.find((item) => item.id === task.kind)?.label || task.kind}</strong><span className={`xw-job-pill ${task.status}`}>{taskStatusLabel(task.status)}</span></div>
        <progress value={task.completed_units} max={Math.max(1, task.total_units)} />
        <small>{task.completed_units}/{task.total_units} · 步骤 {task.used_steps}/{task.budget.max_steps} · 模型调用 {task.used_model_calls}/{task.budget.max_model_calls}</small>
        <small>Token {task.used_input_tokens + task.used_output_tokens}/{task.budget.max_input_tokens + task.budget.max_output_tokens} · 费用 ${task.used_cost_usd.toFixed(4)}/${task.budget.max_cost_usd.toFixed(2)} · 截止 {formatTaskDeadline(task.budget.deadline_at)}</small>
        {task.error_code && <p className="xw-novel-task-error">失败原因：{task.error_code}</p>}
        {(task.status === "running" || task.status === "queued" || task.status === "paused") && <div className="xw-novel-action-row">
          {task.status === "paused" ? <button data-novel-user-gesture="background_control" type="button" onClick={() => void controlTask("resume", task)}><Play size={13} />恢复</button> : <button data-novel-user-gesture="background_control" type="button" onClick={() => void controlTask("pause", task)}><Pause size={13} />暂停</button>}
          <button data-novel-user-gesture="background_control" type="button" onClick={() => void controlTask("cancel", task)}><Square size={13} />取消</button>
        </div>}
      </article>)}
      {!tasks.length && <span className="xw-muted">暂无后台任务</span>}
    </div>
  </section>;

  async function controlTask(action: "pause" | "resume" | "cancel", task: NovelBackgroundTask) {
    await run(async () => {
      await window.xiaoshuoDesktop!.novelAgent.controlBackgroundTask({ ...project, task_id: task.task_id, action, expected_status: task.status, operation_id: crypto.randomUUID() });
      await refresh();
    });
  }
}

function TransferPanel({ project, busy, run, refresh }: {
  project: NovelWorkspaceProject;
  busy: boolean;
  run: (action: () => Promise<void>) => Promise<void>;
  refresh: () => Promise<void>;
}) {
  const [source, setSource] = useState<NovelWorkspaceProject | null>(null);
  const [sourcePath, setSourcePath] = useState("00_设定集/设定集/人物设定.txt");
  const [targetPath, setTargetPath] = useState("00_设定集/设定集/人物设定.txt");
  const [kind, setKind] = useState<NovelProjectTransferPlan["items"][number]["kind"]>("character_setting");
  const [strategy, setStrategy] = useState<NovelProjectTransferPlan["items"][number]["strategy"]>("create");
  const [plan, setPlan] = useState<NovelProjectTransferPlan | null>(null);
  const [sourceConfirmation, setSourceConfirmation] = useState<NovelProjectTransferSourceConfirmResult | null>(null);
  return <section className="xw-novel-agent-section">
    <h3>跨项目素材迁移</h3>
    <div className="xw-novel-transfer-projects">
      <button type="button" className="xw-secondary-button" onClick={() => void run(async () => setSource(await window.xiaoshuoDesktop!.novelAgent.pickTransferProject()))}><FolderOpen size={15} />选择来源项目</button>
      <span>{source?.project_root || "未选择"}</span>
      <strong>目标：{project.project_root}</strong>
    </div>
    <div className="xw-novel-transfer-fields">
      <label>内容类型<select value={kind} onChange={(event) => setKind(event.target.value as typeof kind)}><option value="character_setting">人物设定</option><option value="world_setting">世界观规则</option><option value="style_rule">文风规则</option><option value="reference_material">参考素材</option></select></label>
      <label>冲突策略<select value={strategy} onChange={(event) => setStrategy(event.target.value as typeof strategy)}><option value="create">仅新建</option><option value="append">追加</option><option value="replace">替换</option><option value="skip">跳过冲突</option></select></label>
      <label>来源相对路径<input value={sourcePath} onChange={(event) => setSourcePath(event.target.value)} /></label>
      <label>目标相对路径<input value={targetPath} onChange={(event) => setTargetPath(event.target.value)} /></label>
    </div>
    <div className="xw-novel-action-row">
      <button className="xw-primary-button" data-novel-user-gesture="transfer_plan" type="button" disabled={busy || !source} onClick={() => void run(async () => {
        const nextPlan = await window.xiaoshuoDesktop!.novelAgent.createTransferPlan({
          source_project_id: source!.project_id,
          source_project_root: source!.project_root,
          target_project_id: project.project_id,
          target_project_root: project.project_root,
          items: [{ kind, source_path: sourcePath, target_path: targetPath, strategy }]
        });
        setPlan(nextPlan);
        setSourceConfirmation(null);
        await refresh();
      })}><Boxes size={15} />生成迁移预览</button>
      {plan && !sourceConfirmation && <button className="xw-secondary-button" data-novel-user-gesture="transfer_source_confirm" type="button" disabled={busy} onClick={() => void run(async () => {
        setSourceConfirmation(await window.xiaoshuoDesktop!.novelAgent.confirmTransferSource({
          transfer_id: plan.transfer_id,
          plan_sha256: plan.plan_sha256
        }));
        await refresh();
      })}><Check size={15} />确认读取来源</button>}
      {plan && sourceConfirmation && <button className="xw-primary-button" data-novel-user-gesture="transfer_target_confirm" type="button" disabled={busy} onClick={() => void run(async () => {
        await window.xiaoshuoDesktop!.novelAgent.commitTransfer({
          transfer_id: plan.transfer_id,
          plan_sha256: plan.plan_sha256,
          source_confirmation_id: sourceConfirmation.source_confirmation_id,
          operation_id: crypto.randomUUID()
        });
        setPlan(null);
        setSourceConfirmation(null);
        await refresh();
      })}><Check size={15} />确认写入目标并提交</button>}
    </div>
    {plan?.items.map((item) => <pre key={item.item_id} className="xw-novel-diff">{item.diff_preview}</pre>)}
  </section>;
}

function MemoryPanel({ project, busy, run }: {
  project: NovelWorkspaceProject;
  busy: boolean;
  run: (action: () => Promise<void>) => Promise<void>;
}) {
  const [batch, setBatch] = useState<NovelMemoryBatchPrepareResult | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const eligibleItems = useMemo(() => batch?.items.filter((item) => !item.subjective && !item.conflict_summary) || [], [batch]);
  const selectedItems = useMemo(() => batch?.items.filter((item) => selected.includes(item.claim_id) && !item.subjective && !item.conflict_summary) || [], [batch, selected]);
  return <section className="xw-novel-agent-section">
    <div className="xw-section-head"><h3>Confirmed Memory 批量审核</h3><button className="xw-secondary-button compact" type="button" disabled={busy} onClick={() => void run(async () => {
      const prepared = await window.xiaoshuoDesktop!.novelAgent.prepareMemoryBatch(project);
      setBatch(prepared);
      setSelected([]);
    })}><MemoryStick size={14} />准备审核</button></div>
    <div className="xw-novel-memory-list">
      {batch?.items.map((item) => {
        const requiresIndividualReview = item.subjective || Boolean(item.conflict_summary);
        return <label key={item.claim_id} className={requiresIndividualReview ? "disabled" : ""}>
        <input type="checkbox" disabled={requiresIndividualReview} checked={selected.includes(item.claim_id)} onChange={() => setSelected((current) => current.includes(item.claim_id) ? current.filter((id) => id !== item.claim_id) : [...current, item.claim_id])} />
        <span><strong>{item.claim_type}</strong>{item.content}<small>{item.source_path} · rev {item.source_revision} · {item.content_hash.slice(0, 10)}</small></span>
        {requiresIndividualReview && <em>{item.conflict_summary || "需逐条确认"}</em>}
      </label>})}
      {batch && !batch.items.length && <span className="xw-muted">没有待审核的 draft/proposed memory</span>}
    </div>
    <div className="xw-novel-action-row">
      <button className="xw-secondary-button" type="button" disabled={busy || !eligibleItems.length} onClick={() => setSelected(eligibleItems.map((item) => item.claim_id))}>选择全部可确认项</button>
      <button className="xw-secondary-button" type="button" disabled={busy || !selected.length} onClick={() => setSelected([])}>取消选择</button>
    </div>
    <button className="xw-primary-button" data-novel-user-gesture="memory_batch" type="button" disabled={busy || !selectedItems.length} onClick={() => void run(async () => {
      const confirmationIds = Object.fromEntries(selectedItems.map((item) => [item.claim_id, crypto.randomUUID()]));
      await window.xiaoshuoDesktop!.novelAgent.confirmMemoryBatch({
        project_root: project.project_root,
        request: { project_id: project.project_id, batch_id: `memory_${crypto.randomUUID()}`, items: selectedItems, confirmation_ids: confirmationIds, operation_id: crypto.randomUUID() }
      });
      const prepared = await window.xiaoshuoDesktop!.novelAgent.prepareMemoryBatch(project);
      setBatch(prepared);
      setSelected([]);
    })}><Check size={15} />确认所选 {selectedItems.length} 条</button>
  </section>;
}

function EmptyState({ text }: { text: string }) {
  return <section className="xw-feature-page"><div className="xw-editor-empty"><span>{text}</span></div></section>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function reviewStatusLabel(status: "completed" | "failed" | "skipped"): string {
  return status === "completed" ? "已完成" : status === "failed" ? "失败" : "已跳过";
}

function severityLabel(severity: "info" | "warning" | "blocking"): string {
  return severity === "blocking" ? "阻断" : severity === "warning" ? "注意" : "建议";
}

function taskStatusLabel(status: NovelBackgroundTask["status"]): string {
  const labels: Record<NovelBackgroundTask["status"], string> = {
    queued: "等待中",
    running: "运行中",
    paused: "已暂停",
    paused_budget_exhausted: "预算已用尽",
    completed: "已完成",
    failed: "失败",
    cancelled: "已取消"
  };
  return labels[status];
}

function formatTaskDeadline(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
}
