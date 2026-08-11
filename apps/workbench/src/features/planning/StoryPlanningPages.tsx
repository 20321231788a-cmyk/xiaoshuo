import { Check, Clock3, FileText, Network, Plus, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { StoryOutlineNode, StoryPlanningBundle, StoryTimelineEvent } from "@xiaoshuo/shared";
import type { WorkbenchController } from "../../hooks/useWorkbenchController.js";

type LoadState = "loading" | "ready" | "error";

async function request<T>(controller: WorkbenchController, pathname: string, init?: RequestInit): Promise<T> {
  const fetchFn = controller.runtime.fetchFn || fetch;
  const response = await fetchFn(new URL(pathname, controller.runtime.apiBase), { ...init, headers: { "Content-Type": "application/json", ...(init?.headers || {}) } });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(String(payload.detail || response.statusText || "故事规划请求失败"));
  return payload as T;
}

function newId(): string {
  return globalThis.crypto?.randomUUID?.().replace(/-/g, "") || `${Date.now()}${Math.random().toString(16).slice(2)}`;
}

function stamp(): string { return new Date().toISOString(); }

function useStoryPlanning(controller: WorkbenchController) {
  const [bundle, setBundle] = useState<StoryPlanningBundle | null>(null);
  const [state, setState] = useState<LoadState>("loading");
  const [message, setMessage] = useState("");
  const refresh = useCallback(async () => {
    setState("loading");
    setMessage("");
    try {
      setBundle(await request<StoryPlanningBundle>(controller, "/api/story-planning"));
      setState("ready");
    } catch (error) {
      setState("error");
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }, [controller]);
  useEffect(() => { void refresh(); }, [refresh]);
  async function migrate() {
    const next = await request<StoryPlanningBundle>(controller, "/api/story-planning/migrate", { method: "POST", body: "{}" });
    setBundle(next);
    setState("ready");
  }
  async function save(outline: StoryOutlineNode[], timeline: StoryTimelineEvent[]) {
    if (!bundle) return;
    const next = await request<StoryPlanningBundle>(controller, "/api/story-planning", { method: "PUT", body: JSON.stringify({ base_revision: bundle.revision, outline, timeline }) });
    setBundle(next);
  }
  return { bundle, state, message, refresh, migrate, save };
}

export function OutlinePlanningPanel({ controller }: { controller: WorkbenchController }) {
  const planning = useStoryPlanning(controller);
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  if (planning.state === "loading") return <div className="aw-feature-loading">正在读取故事大纲…</div>;
  if (planning.state === "error") return <PlanningError message={planning.message} onRetry={planning.refresh} />;
  const bundle = planning.bundle!;
  if (bundle.status === "migration_required") return <MigrationNotice title="已有大纲文件等待迁移" detail="迁移后会保留原有文本，并生成可排序、可关联章节的结构化大纲。" onMigrate={planning.migrate} />;
  if (bundle.status === "projection_drift") return <PlanningError message="故事大纲文本在外部被修改。为避免覆盖，请先在编辑器确认文本后重新迁移。" onRetry={planning.refresh} />;
  async function add() {
    const name = title.trim();
    if (!name) return;
    const now = stamp();
    await planning.save([...bundle.outline, { id: newId(), kind: "main_arc", title: name, summary: summary.trim(), order: bundle.outline.length, parent_id: null, chapter_paths: [], entity_ids: [], status: "planned", created_at: now, updated_at: now }], bundle.timeline);
    setTitle(""); setSummary("");
  }
  return <section className="aw-planning-panel"><div className="aw-planning-toolbar"><div><strong>结构化大纲</strong><span>保存后会同步生成项目内的《故事大纲》文本。</span></div><button type="button" className="aw-secondary-button" onClick={() => void planning.refresh()}><RefreshCw size={15} />刷新</button></div><div className="aw-planning-add"><input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="主线、人物线或分卷名称" /><input value={summary} onChange={(event) => setSummary(event.target.value)} placeholder="这一条规划要解决什么" /><button type="button" className="aw-primary-button" onClick={() => void add()} disabled={!title.trim()}><Plus size={15} />添加</button></div><div className="aw-file-list">{bundle.outline.map((item) => <article key={item.id}><Network size={17} /><span><strong>{item.title}</strong><small>{item.summary || "尚未填写说明"}{item.chapter_paths.length ? ` · ${item.chapter_paths.length} 个关联章节` : ""}</small></span><em>{outlineStatus(item.status)}</em></article>)}{!bundle.outline.length && <div className="aw-empty-compact"><Network size={20} /><p>先添加一条主线，随后可以补充分卷、章节和情节点。</p></div>}</div></section>;
}

export function TimelinePlanningPanel({ controller }: { controller: WorkbenchController }) {
  const planning = useStoryPlanning(controller);
  const [storyTime, setStoryTime] = useState("");
  const [title, setTitle] = useState("");
  if (planning.state === "loading") return <div className="aw-feature-loading">正在读取故事时间线…</div>;
  if (planning.state === "error") return <PlanningError message={planning.message} onRetry={planning.refresh} />;
  const bundle = planning.bundle!;
  if (bundle.status === "migration_required") return <MigrationNotice title="已有时间线文件等待迁移" detail="迁移会保留旧文本，并将后续事件整理为独立的故事时间记录。" onMigrate={planning.migrate} />;
  if (bundle.status === "projection_drift") return <PlanningError message="故事时间线文本在外部被修改。为避免覆盖，请先在编辑器确认文本后重新迁移。" onRetry={planning.refresh} />;
  async function add() {
    if (!storyTime.trim() || !title.trim()) return;
    const now = stamp();
    await planning.save(bundle.outline, [...bundle.timeline, { id: newId(), title: title.trim(), summary: "", story_time: storyTime.trim(), sort_key: storyTime.trim(), order: bundle.timeline.length, chapter_paths: [], entity_ids: [], clue_ids: [], status: "planned", created_at: now, updated_at: now }]);
    setStoryTime(""); setTitle("");
  }
  return <section className="aw-planning-panel"><div className="aw-planning-toolbar"><div><strong>故事时间线</strong><span>这里记录小说世界中的先后，不等同于文件版本历史。</span></div><button type="button" className="aw-secondary-button" onClick={() => void planning.refresh()}><RefreshCw size={15} />刷新</button></div><div className="aw-planning-add"><input value={storyTime} onChange={(event) => setStoryTime(event.target.value)} placeholder="故事时间，例如 第三日深夜" /><input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="事件名称" /><button type="button" className="aw-primary-button" onClick={() => void add()} disabled={!storyTime.trim() || !title.trim()}><Plus size={15} />添加事件</button></div><div className="aw-timeline-list">{bundle.timeline.map((item) => <article key={item.id}><span className="aw-timeline-marker" /><span><strong>{item.story_time} · {item.title}</strong><small>{item.summary || "尚未填写事件说明"}</small></span><em>{timelineStatus(item.status)}</em></article>)}{!bundle.timeline.length && <div className="aw-empty-compact"><Clock3 size={20} /><p>添加第一个故事事件，后续可关联章节、人物和伏笔。</p></div>}</div></section>;
}

function MigrationNotice({ title, detail, onMigrate }: { title: string; detail: string; onMigrate: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  return <div className="aw-migration-notice"><FileText size={21} /><div><strong>{title}</strong><p>{detail}</p>{message && <p role="status">{message}</p>}</div><button type="button" className="aw-primary-button" disabled={busy} onClick={() => { setBusy(true); setMessage(""); void onMigrate().catch((error) => setMessage(error instanceof Error ? error.message : String(error))).finally(() => setBusy(false)); }}><Check size={15} />迁移并继续</button></div>;
}

function PlanningError({ message, onRetry }: { message: string; onRetry: () => Promise<void> }) {
  return <div className="aw-migration-notice error"><FileText size={21} /><div><strong>无法读取故事规划</strong><p>{message}</p></div><button type="button" className="aw-secondary-button" onClick={() => void onRetry()}>重试</button></div>;
}

function outlineStatus(value: StoryOutlineNode["status"]): string { return value === "done" ? "已完成" : value === "active" ? "进行中" : "待规划"; }
function timelineStatus(value: StoryTimelineEvent["status"]): string { return value === "revealed" ? "已揭示" : value === "occurred" ? "已发生" : "待发生"; }
