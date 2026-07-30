import type { CloudProjectSlot, CurrentProject, LocalStateProject } from "@xiaoshuo/shared";
import { BookOpen, Bot, Cloud, CloudDownload, CloudUpload, FolderOpen, PenLine, Plus, RefreshCw, ShieldCheck } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { WorkbenchController } from "../../../hooks/useWorkbenchController.js";
import type { UserFeature } from "../../../navigation.js";

type ReplacementRequest = {
  project: CurrentProject;
  enableAuto: boolean;
};

export function HomeProductPage({
  controller,
  onSelectFeature
}: {
  controller: WorkbenchController;
  onSelectFeature: (feature: UserFeature) => void;
}) {
  const snapshot = controller.snapshot;
  const [replacement, setReplacement] = useState<ReplacementRequest | null>(null);
  const [replacementSlotId, setReplacementSlotId] = useState<number>(0);
  const [replacementStep, setReplacementStep] = useState<"select" | "confirm">("select");
  const recentProjects = snapshot?.localState?.recent_projects || [];
  const mergedRows = useMemo(() => mergeProjectRows(recentProjects, controller.cloudProjectSlots, controller.cloudSyncPreferences), [recentProjects, controller.cloudProjectSlots, controller.cloudSyncPreferences]);

  useEffect(() => {
    for (const recent of recentProjects.slice(0, 8)) {
      if (!controller.cloudCoreStats[recent.path] && !controller.cloudInspectingPaths.includes(recent.path)) {
        void controller.inspectCloudProject(recent.path);
      }
    }
  }, [controller, recentProjects]);

  if (!snapshot) return null;
  const project = snapshot.currentProject;
  const documentCount = countTreeFiles(snapshot.projectChrome.tree);
  const activeDocument = controller.openDocuments.find((document) => document.path === controller.activeDocumentPath) || controller.openDocuments[0];

  async function syncProject(localProject: CurrentProject, enableAuto = false) {
    const linkedSlot = findLinkedSlot(localProject, controller.cloudProjectSlots, controller.cloudSyncPreferences[localProject.path]);
    const emptySlot = [1, 2, 3].find((slotId) => !controller.cloudProjectSlots.some((slot) => slot.slot_id === slotId));
    const slotId = linkedSlot?.slot_id || emptySlot;
    if (!slotId) {
      setReplacement({ project: localProject, enableAuto });
      setReplacementSlotId(0);
      setReplacementStep("select");
      return;
    }
    const result = await controller.syncProjectToCloud(localProject, slotId, enableAuto ? "auto" : "manual");
    if (result && enableAuto) controller.setProjectAutoSync(localProject.path, true, slotId);
  }

  async function toggleAutoSync(localProject: CurrentProject, enabled: boolean) {
    if (!enabled) {
      const preference = controller.cloudSyncPreferences[localProject.path];
      controller.setProjectAutoSync(localProject.path, false, preference?.slot_id || 1);
      return;
    }
    await syncProject(localProject, true);
  }

  async function confirmReplacement() {
    if (!replacement || !replacementSlotId) return;
    if (replacementStep === "select") {
      setReplacementStep("confirm");
      return;
    }
    const result = await controller.syncProjectToCloud(replacement.project, replacementSlotId, replacement.enableAuto ? "auto" : "manual");
    if (result && replacement.enableAuto) controller.setProjectAutoSync(replacement.project.path, true, replacementSlotId);
    if (result) closeReplacement();
  }

  function closeReplacement() {
    setReplacement(null);
    setReplacementSlotId(0);
    setReplacementStep("select");
  }

  async function restoreCloudOnly(slot: CloudProjectSlot) {
    const picked = await window.xiaoshuoDesktop?.pickProjectDirectory();
    if (!picked?.path || picked.canceled) return;
    await controller.restoreCloudProject(slot, { path: picked.path, name: slot.project_name || "恢复的小说" });
  }

  const summary = controller.cloudProjectSummary;
  const quotaLabel = summary
    ? `云端 ${controller.cloudProjectSlots.length}/3 · 今日剩余 ${summary.today_upload_remaining}/${summary.daily_upload_limit}${summary.monthly_upload_bytes_remaining ? ` · 本月上传剩余 ${formatBytes(summary.monthly_upload_bytes_remaining)}` : ""}`
    : "云端同步需要登录网站账号";

  return (
    <div className="page-scroll home-page">
      <div className="content-head">
        <div>
          <h1>{project.path ? `${greeting()}，主笔` : "开始创作"}</h1>
          <p>{project.path ? (activeDocument ? `继续编辑《${activeDocument.title}》。` : "选择一个章节开始今天的写作。") : "打开已有项目，或创建一部新小说。"}</p>
        </div>
        <div className="content-actions">
          <button className="button secondary" type="button" onClick={() => void controller.pickAndOpenProject("open")} disabled={controller.projectBusy}>
            <FolderOpen size={15} />打开项目
          </button>
          <button className="button primary" type="button" onClick={() => void controller.pickAndOpenProject("create")} disabled={controller.projectBusy}>
            <Plus size={15} />新建小说
          </button>
        </div>
      </div>

      {project.path ? (
        <section className="continue-band">
          <div className="book-cover">{project.name.trim().slice(0, 2) || "小说"}<span>主笔 著</span></div>
          <div className="continue-main">
            <span className="eyebrow">继续创作</span>
            <h2>{activeDocument?.title || "打开正文开始写作"}</h2>
            <p className="home-current-excerpt">{activeDocument?.content ? activeDocument.content.slice(0, 100).replace(/[\r\n]+/g, " ") + (activeDocument.content.length > 100 ? "..." : "") : "项目已就绪，选择正文或大纲文档继续。"}</p>
            <div className="progress-row"><span><i style={{ width: `${Math.min(100, ((activeDocument?.chars || 0) / 4000) * 100)}%` }} /></span><strong>{activeDocument?.chars || 0} / 4,000 字</strong></div>
            <div className="inline-actions">
              <button className="button primary" type="button" onClick={() => onSelectFeature("editor")}><PenLine size={15} />继续写作</button>
              <button className="button secondary" type="button" onClick={() => onSelectFeature("conversations")}><Bot size={15} />询问 AI</button>
            </div>
          </div>
          <dl className="project-facts">
            <div><dt>项目文件</dt><dd>{documentCount}</dd></div>
            <div><dt>打开文档</dt><dd>{controller.openDocuments.length}</dd></div>
            <div><dt>资料卡</dt><dd>{snapshot.projectChrome.libraries.length}</dd></div>
            <div><dt>改稿记录</dt><dd>{snapshot.timeline.length}</dd></div>
          </dl>
        </section>
      ) : (
        <section className="home-welcome-band">
          <span><BookOpen size={22} /></span>
          <div><h2>小说数据保存在你选择的本地目录</h2><p>云端只同步最多三本小说的大纲、正文、设定、风格和题材等核心文件。</p></div>
          <ShieldCheck size={20} />
        </section>
      )}

      <div className="home-grid">
        <section className="home-section recent-section cloud-recent-section">
          <div className="section-title cloud-projects-title">
            <div><h3>最近项目</h3><p>{quotaLabel}</p></div>
            <button type="button" onClick={() => void controller.refreshCloudProjects()} disabled={controller.cloudProjectBusy} aria-label="刷新云端项目">
              <RefreshCw size={14} className={controller.cloudProjectBusy ? "spin" : ""} />刷新
            </button>
          </div>
          <div className="cloud-project-list">
            {mergedRows.slice(0, 8).map((row, index) => row.local ? (
              <article className={`cloud-project-row ${row.local.path === project.path ? "selected" : ""}`} key={`local:${row.local.path}`}>
                <button className="cloud-project-open" type="button" onClick={() => void controller.openProjectFromInput(row.local!.path)}>
                  <span className={`project-glyph tone-${index % 3}`}>{row.local.name.trim().slice(0, 1)}</span>
                  <span className="cloud-project-copy"><strong>{row.local.name}</strong><small title={row.local.path}>{row.local.path}</small></span>
                </button>
                <div className="cloud-project-state">
                  <span className={`sync-status ${syncStatus(row.local.path, row.slot, controller.cloudProjectActivePath, controller.cloudPendingAutoSyncPaths, controller.cloudSyncPreferences[row.local.path]).tone}`}><Cloud size={13} />{syncStatus(row.local.path, row.slot, controller.cloudProjectActivePath, controller.cloudPendingAutoSyncPaths, controller.cloudSyncPreferences[row.local.path]).label}</span>
                  <small>{row.slot ? `云端更新 ${formatDateTime(row.slot.updated_at)}` : `最近打开 ${formatDate(row.local.opened_at)}`}{controller.cloudCoreStats[row.local.path] ? ` · ${formatBytes(controller.cloudCoreStats[row.local.path]!.core_bytes)}` : ""}</small>
                </div>
                <label className="cloud-auto-switch" title="保存核心文件后自动同步">
                  <span>自动</span>
                  <input type="checkbox" role="switch" checked={Boolean(controller.cloudSyncPreferences[row.local.path]?.auto)} disabled={controller.cloudProjectBusy} onChange={(event) => void toggleAutoSync(row.local!, event.target.checked)} />
                </label>
                <button className="button secondary compact cloud-sync-now" type="button" disabled={controller.cloudProjectBusy} onClick={() => void syncProject(row.local!)}><CloudUpload size={14} />立即同步</button>
                {row.slot && <button className="cloud-restore-button" type="button" disabled={controller.cloudProjectBusy} onClick={() => void controller.restoreCloudProject(row.slot!, row.local!)}><CloudDownload size={14} />恢复</button>}
              </article>
            ) : (
              <article className="cloud-project-row cloud-only" key={`cloud:${row.slot!.id}`}>
                <div className="cloud-project-open"><span className="project-glyph cloud-glyph"><Cloud size={16} /></span><span className="cloud-project-copy"><strong>{row.slot!.project_name || `云端槽位 ${row.slot!.slot_id}`}</strong><small>仅保存在云端 · {formatBytes(row.slot!.core_size || row.slot!.size)}</small></span></div>
                <div className="cloud-project-state"><span className="sync-status cloud-only-status"><Cloud size={13} />仅云端</span><small>更新于 {formatDateTime(row.slot!.updated_at)}</small></div>
                <button className="button secondary compact cloud-sync-now" type="button" disabled={controller.cloudProjectBusy} onClick={() => void restoreCloudOnly(row.slot!)}><CloudDownload size={14} />恢复到本地</button>
              </article>
            ))}
          </div>
          {!mergedRows.length && <p className="cloud-project-empty">最近打开或同步过的小说会显示在这里。</p>}
          {controller.cloudProjectMessage && <p className="cloud-sync-message" role="status">{controller.cloudProjectMessage}</p>}
        </section>

        <section className="home-section today-section">
          <div className="section-title"><h3>当前写作</h3></div>
          <div className="today-total"><strong>{activeDocument?.chars || 0}</strong><span>字</span><small>{activeDocument?.dirty ? "有未保存修改" : project.path ? "已保存到本地" : "尚未打开项目"}</small></div>
          <p className="quiet-note">{activeDocument ? `当前章节最后读取于 ${formatDate(activeDocument.updatedAt) || "本次会话"}` : "打开正文后，这里会显示当前章节状态。"}</p>
        </section>
      </div>

      {replacement && (
        <div className="cloud-replace-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeReplacement(); }}>
          <section className="cloud-replace-dialog" role="dialog" aria-modal="true" aria-labelledby="cloud-replace-title">
            <div className="cloud-replace-heading"><CloudUpload size={19} /><div><h2 id="cloud-replace-title">{replacementStep === "select" ? "选择要替换的云端小说" : "确认替换云端数据"}</h2><p>{replacementStep === "select" ? "云端最多保留三本小说，不会自动删除最旧项目。" : "替换后，所选小说将从云端槽位移除。"}</p></div></div>
            {replacementStep === "select" ? (
              <div className="cloud-replace-options">{[1, 2, 3].map((slotId) => { const slot = controller.cloudProjectSlots.find((item) => item.slot_id === slotId); return <label key={slotId} className={replacementSlotId === slotId ? "selected" : ""}><input type="radio" name="replace-slot" checked={replacementSlotId === slotId} onChange={() => setReplacementSlotId(slotId)} /><span><strong>{slot?.project_name || `槽位 ${slotId}`}</strong><small>{slot ? `${formatBytes(slot.core_size || slot.size)} · ${formatDateTime(slot.updated_at)}` : "空槽位"}</small></span></label>; })}</div>
            ) : (
              <div className="cloud-replace-confirm"><p>将使用《{replacement.project.name}》替换《{controller.cloudProjectSlots.find((slot) => slot.slot_id === replacementSlotId)?.project_name || `槽位 ${replacementSlotId}`}》。</p><strong>本地小说不会被删除，但原云端版本将不再占用同步槽位。</strong></div>
            )}
            <div className="cloud-replace-actions"><button className="button secondary" type="button" onClick={replacementStep === "confirm" ? () => setReplacementStep("select") : closeReplacement}>{replacementStep === "confirm" ? "返回" : "取消"}</button><button className="button primary" type="button" disabled={!replacementSlotId || controller.cloudProjectBusy} onClick={() => void confirmReplacement()}>{replacementStep === "confirm" ? "确认替换并同步" : "下一步"}</button></div>
          </section>
        </div>
      )}
    </div>
  );
}

function mergeProjectRows(recentProjects: LocalStateProject[], slots: CloudProjectSlot[], preferences: Record<string, { slot_id: number; remote_id?: string } | undefined>) {
  const usedSlots = new Set<string>();
  const localRows = recentProjects.map((local) => {
    const slot = findLinkedSlot(local, slots, preferences[local.path]);
    if (slot) usedSlots.add(slot.id);
    return { local, slot: slot || null };
  });
  return [...localRows, ...slots.filter((slot) => !usedSlots.has(slot.id)).map((slot) => ({ local: null, slot }))];
}

function findLinkedSlot(project: CurrentProject, slots: CloudProjectSlot[], preference?: { slot_id: number; remote_id?: string }) {
  if (preference?.remote_id) {
    const preferred = slots.find((slot) => slot.id === preference.remote_id);
    if (preferred) return preferred;
  }
  return slots.find((slot) => slot.project_name.trim() === project.name.trim()) || null;
}

function syncStatus(projectPath: string, slot: CloudProjectSlot | null, activePath: string, pendingPaths: string[], preference?: { auto_sync_day: string; auto_sync_count: number }) {
  if (activePath === projectPath) return { label: "同步中", tone: "syncing" };
  if (pendingPaths.includes(projectPath)) return { label: "待同步", tone: "pending" };
  if (preference?.auto_sync_day === localDay(new Date()) && preference.auto_sync_count >= 6) return { label: "已暂停", tone: "paused" };
  return slot ? { label: "已同步", tone: "synced" } : { label: "未同步", tone: "local-only" };
}
function greeting(): string { const hour = new Date().getHours(); return hour < 6 ? "夜深了" : hour < 12 ? "上午好" : hour < 18 ? "下午好" : "晚上好"; }
function countTreeFiles(nodes: Array<{ kind: string; children: any[] }>): number { return nodes.reduce((total, node) => total + (node.kind === "file" ? 1 : countTreeFiles(node.children || [])), 0); }
function formatDate(value: string): string { const date = new Date(value); return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" }); }
function formatDateTime(value: string): string { const date = new Date(value); return Number.isNaN(date.getTime()) ? "未知" : date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }); }
function formatBytes(bytes: number): string { if (!bytes) return "0 KB"; if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`; return `${(bytes / 1024 / 1024).toFixed(bytes >= 10 * 1024 * 1024 ? 1 : 2)} MB`; }
function localDay(date: Date): string { return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`; }
