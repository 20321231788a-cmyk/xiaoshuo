import {
  Pause,
  Play,
  RefreshCw,
  Square,
  Timer
} from "lucide-react";
import { useEffect, useState } from "react";
import type { NovelBackgroundTask, NovelBackgroundTaskKind, NovelWorkspaceProject, NovelAgentWorkspaceSnapshot } from "@xiaoshuo/shared";
import type { WorkbenchController } from "../../../hooks/useWorkbenchController.js";
import { EmptyState } from "../shared/SharedStates.js";

const backgroundTaskOptions: Array<{ id: NovelBackgroundTaskKind; label: string }> = [
  { id: "full_consistency_scan", label: "全书一致性扫描" },
  { id: "story_index_rebuild", label: "人物/伏笔/时间线索引" },
  { id: "batch_chapter_quality", label: "章节质量报告" },
  { id: "material_summary", label: "素材整理与摘要" },
  { id: "approved_chapter_drafts", label: "已确认计划章节草稿" }
];

export function TasksProductPage({ controller }: { controller: WorkbenchController }) {
  const api = window.xiaoshuoDesktop?.novelAgent;
  const projectRoot = controller.snapshot?.currentProject.path || "";

  const [project, setProject] = useState<NovelWorkspaceProject | null>(null);
  const [snapshot, setSnapshot] = useState<NovelAgentWorkspaceSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [taskKind, setTaskKind] = useState<NovelBackgroundTaskKind>("full_consistency_scan");

  // 初始化项目
  useEffect(() => {
    if (api && projectRoot) {
      api.identifyProject({ project_root: projectRoot })
        .then(async (identified) => {
          setProject(identified);
          setSnapshot(await api.snapshot(identified));
        })
        .catch((err) => setMessage(err instanceof Error ? err.message : String(err)));
    }
  }, [api, projectRoot]);

  async function refresh() {
    if (!api || !project) return;
    setBusy(true);
    try {
      setSnapshot(await api.snapshot(project));
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function createTask() {
    if (!api || !project) return;
    setBusy(true);
    try {
      await api.createBackgroundTask({
        ...project,
        kind: taskKind,
        input_revision: "project-snapshot",
        chapter_paths: [],
        material_paths: [],
        max_chapters: 20,
        budget: {
          budget_id: `bg_${crypto.randomUUID()}`,
          max_steps: 20,
          max_replans: 0,
          max_model_calls: 5,
          max_input_tokens: 100_000,
          max_output_tokens: 20_000,
          max_cost_usd: 0.5,
          deadline_at: new Date(Date.now() + 60 * 60_000).toISOString(),
          max_retries: 1
        },
        confirmation_id: crypto.randomUUID()
      });
      await refresh();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function controlTask(action: "pause" | "resume" | "cancel", task: NovelBackgroundTask) {
    if (!api || !project) return;
    setBusy(true);
    try {
      await api.controlBackgroundTask({
        ...project,
        task_id: task.task_id,
        action,
        expected_status: task.status,
        operation_id: crypto.randomUUID()
      });
      await refresh();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const tasks = snapshot?.background_tasks || [];
  const runningCount = tasks.filter(t => t.status === "running").length;

  if (!api || !projectRoot) {
    return (
      <div style={{ padding: "20px", display: "flex", justifyContent: "center", alignItems: "center", height: "100%" }}>
        <EmptyState title="后台任务不可用" description="请在桌面壳中打开小说项目后重试。" />
      </div>
    );
  }

  return (
    <div className="page-scroll" style={{ padding: "20px", display: "flex", flexDirection: "column", height: "100%" }}>
      <div className="content-head">
        <div>
          <h1>后台任务</h1>
          <p>大纲扫描和一致性分析等后台运行，您可以随时中止或限制额度。</p>
        </div>
        <div className="content-actions">
          <select
            aria-label="选择创建任务"
            value={taskKind}
            onChange={(e) => setTaskKind(e.target.value as NovelBackgroundTaskKind)}
            style={{ padding: "4px 8px", borderRadius: "4px", border: "1px solid var(--line)", fontSize: "12px" }}
          >
            {backgroundTaskOptions.map((opt) => (
              <option key={opt.id} value={opt.id}>{opt.label}</option>
            ))}
          </select>
          <button className="button primary" type="button" onClick={createTask} disabled={busy}>
            <Play size={14} /> 创建任务
          </button>
          <button className="button secondary" type="button" onClick={refresh}>
            <RefreshCw size={14} /> 刷新
          </button>
        </div>
      </div>

      {message && <p style={{ fontSize: "12px", color: "var(--danger)", margin: "8px 0" }}>{message}</p>}

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", margin: "10px 0", fontSize: "12px" }}>
        <span>活跃任务数：<strong>{runningCount}</strong> 个</span>
      </div>

      {/* 任务列表 */}
      <section className="task-list" style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: "12px" }}>
        {tasks.map((task) => (
          <article
            key={task.task_id}
            style={{
              padding: "12px",
              border: "1px solid var(--line)",
              borderRadius: "6px",
              background: "var(--stone-deep)"
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <strong>{backgroundTaskOptions.find((opt) => opt.id === task.kind)?.label || task.kind}</strong>
              <span className={`status-pill ${task.status}`} style={{ fontSize: "12px" }}>
                {task.status === "running" ? "运行中" : task.status === "completed" ? "已完成" : "等待中"}
              </span>
            </div>

            <div style={{ margin: "10px 0" }}>
              <progress
                value={task.completed_units}
                max={Math.max(1, task.total_units)}
                style={{ width: "100%", height: "6px", borderRadius: "3px" }}
              />
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: "12px", color: "var(--muted)", marginTop: "4px" }}>
                <span>进度：{task.completed_units} / {task.total_units}</span>
                <span>使用 Token：{(task.used_input_tokens + task.used_output_tokens).toLocaleString()}</span>
              </div>
            </div>

            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: "12px", color: "var(--muted)" }}>
              <span>使用步骤：{task.used_steps} / {task.budget.max_steps} · 花费：${task.used_cost_usd.toFixed(4)}</span>

              <div style={{ display: "flex", gap: "8px" }}>
                {task.status === "running" ? (
                  <button className="button secondary compact" type="button" onClick={() => void controlTask("pause", task)} style={{ height: "24px" }}>
                    <Pause size={12} /> 暂停
                  </button>
                ) : task.status === "paused" ? (
                  <button className="button secondary compact" type="button" onClick={() => void controlTask("resume", task)} style={{ height: "24px" }}>
                    <Play size={12} /> 恢复
                  </button>
                ) : null}
                {(task.status === "running" || task.status === "queued" || task.status === "paused") && (
                  <button className="button secondary compact" type="button" onClick={() => void controlTask("cancel", task)} style={{ height: "24px" }}>
                    <Square size={12} /> 取消
                  </button>
                )}
              </div>
            </div>
          </article>
        ))}

        {tasks.length === 0 && (
          <div style={{ padding: "40px" }}>
            <EmptyState title="无活跃后台任务" description="后台任务在分析较长文本或复杂规则时自动创建运行。" />
          </div>
        )}
      </section>
    </div>
  );
}
