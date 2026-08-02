import {
  BookOpen,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  FileText,
  GripVertical,
  MoreHorizontal,
  Network,
  Pin,
  Plus,
  RefreshCw,
  SquarePen,
  Trash2,
  Users,
  X
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { StoryOutlineNode, StoryPlanningBundle } from "@xiaoshuo/shared";
import type { WorkbenchController } from "../../../hooks/useWorkbenchController.js";
import { EmptyState } from "../shared/SharedStates.js";

type LoadState = "loading" | "ready" | "error";

async function request<T>(controller: WorkbenchController, pathname: string, init?: RequestInit): Promise<T> {
  const fetchFn = controller.runtime.fetchFn || fetch;
  const response = await fetchFn(new URL(pathname, controller.runtime.apiBase), {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) }
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(String(payload.detail || response.statusText || "故事规划请求失败"));
  return payload as T;
}

function newId(): string {
  return globalThis.crypto?.randomUUID?.().replace(/-/g, "") || `${Date.now()}${Math.random().toString(16).slice(2)}`;
}

function stamp(): string {
  return new Date().toISOString();
}

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

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function migrate() {
    const next = await request<StoryPlanningBundle>(controller, "/api/story-planning/migrate", {
      method: "POST",
      body: "{}"
    });
    setBundle(next);
    setState("ready");
  }

  async function save(outline: StoryOutlineNode[]) {
    if (!bundle) return;
    const next = await request<StoryPlanningBundle>(controller, "/api/story-planning", {
      method: "PUT",
      body: JSON.stringify({ base_revision: bundle.revision, outline, timeline: bundle.timeline })
    });
    setBundle(next);
    await controller.refreshProjectWorkspace();
  }

  return { bundle, state, message, refresh, migrate, save };
}

export function OutlineProductPage({ controller }: { controller: WorkbenchController }) {
  const planning = useStoryPlanning(controller);
  const [activeTab, setActiveTab] = useState<"main" | "character" | "chapter">("main");
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [inlineEditingId, setInlineEditingId] = useState<string | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);

  // 编辑详情状态
  const [editTitle, setEditTitle] = useState("");
  const [editSummary, setEditSummary] = useState("");
  const [editChapters, setEditChapters] = useState("");

  const bundle = planning.bundle;

  // 选中节点变化时同步状态
  const selectedNode = bundle?.outline.find((item) => item.id === selectedNodeId) || bundle?.outline[0] || null;
  const visibleOutline = (bundle?.outline || []).filter((item) => activeTab === "main" ? item.kind === "main_arc" || item.kind === "volume" || item.kind === "beat" : activeTab === "character" ? item.kind === "character_arc" : item.kind === "chapter");
  const volumeNodes = (bundle?.outline || []).filter((item) => item.kind === "volume");
  useEffect(() => {
    if (selectedNode) {
      setEditTitle(selectedNode.title);
      setEditSummary(selectedNode.summary || "");
      setEditChapters(selectedNode.chapter_paths.join(", ") || "");
      setSelectedNodeId(selectedNode.id);
    } else {
      setEditTitle("");
      setEditSummary("");
      setEditChapters("");
    }
  }, [selectedNode?.id]);

  if (planning.state === "loading") {
    return <div style={{ padding: "20px", fontSize: "12px", color: "var(--muted)" }}>正在读取故事大纲…</div>;
  }

  if (planning.state === "error") {
    return (
      <div style={{ padding: "20px" }}>
        <p style={{ color: "var(--danger)", fontSize: "12px" }}>无法读取故事规划: {planning.message}</p>
        <button className="button secondary" type="button" onClick={() => void planning.refresh()}>
          重试
        </button>
      </div>
    );
  }

  if (!bundle) return null;

  if (bundle.status === "migration_required") {
    return (
      <div style={{ padding: "20px", textAlign: "center" }}>
        <h3>需要迁移大纲数据</h3>
        <button className="button primary" type="button" onClick={() => void planning.migrate()}>
          立即迁移
        </button>
      </div>
    );
  }

  // 添加情节点
  async function handleAddBeat() {
    if (!bundle) return;
    const now = stamp();
    const newBeat: StoryOutlineNode = {
      id: newId(),
      kind: activeTab === "main" ? "main_arc" : activeTab === "character" ? "character_arc" : "chapter",
      title: "新大纲事件",
      summary: "大纲事件的描述...",
      order: bundle.outline.length,
      parent_id: null,
      chapter_paths: [],
      entity_ids: [],
      status: "planned",
      created_at: now,
      updated_at: now
    };
    const nextOutline = [...bundle.outline, newBeat];
    await planning.save(nextOutline);
    setSelectedNodeId(newBeat.id);
  }

  // 保存当前节点的编辑
  async function handleSaveEdit() {
    if (!bundle || !selectedNodeId) return;
    const nextOutline = bundle.outline.map((item) => {
      if (item.id === selectedNodeId) {
        return {
          ...item,
          title: editTitle,
          summary: editSummary,
          chapter_paths: editChapters.split(/[,，]/).map(x => x.trim()).filter(Boolean),
          updated_at: stamp()
        };
      }
      return item;
    });
    await planning.save(nextOutline);
    setInlineEditingId(null);
  }

  function handleStartInlineEdit(item: StoryOutlineNode) {
    setSelectedNodeId(item.id);
    setEditTitle(item.title);
    setEditSummary(item.summary || "");
    setEditChapters(item.chapter_paths.join(", "));
    setInlineEditingId(item.id);
    setDeleteConfirmId(null);
  }

  async function handleDelete(id: string) {
    if (!bundle) return;
    if (deleteConfirmId !== id) {
      setDeleteConfirmId(id);
      return;
    }
    const nextOutline = bundle.outline.filter((item) => item.id !== id).map((item, index) => ({ ...item, order: index }));
    await planning.save(nextOutline);
    setDeleteConfirmId(null);
    setInlineEditingId(null);
    setSelectedNodeId(nextOutline[0]?.id || null);
  }

  // 改变顺序
  async function handleMove(direction: "up" | "down", id: string) {
    if (!bundle) return;
    const index = bundle.outline.findIndex(item => item.id === id);
    if (index === -1) return;
    const nextIndex = direction === "up" ? index - 1 : index + 1;
    if (nextIndex < 0 || nextIndex >= bundle.outline.length) return;

    const list = [...bundle.outline];
    const temp = list[index]!;
    list[index] = list[nextIndex]!;
    list[nextIndex] = temp;

    // 重排 order
    const updatedList = list.map((item, idx) => ({
      ...item,
      order: idx
    }));

    await planning.save(updatedList);
  }

  return (
    <div className="page-scroll" style={{ padding: "20px", display: "flex", flexDirection: "column", height: "100%" }}>
      <div className="content-head">
        <div>
          <h1>{controller.snapshot?.currentProject.name || "故事大纲"}</h1>
          <p>拖动情节点调整顺序，章节会自动保留关联。</p>
        </div>
        <div className="content-actions">
          <div className="segment">
            <button className={activeTab === "main" ? "active" : ""} type="button" onClick={() => setActiveTab("main")}>主线</button>
            <button className={activeTab === "character" ? "active" : ""} type="button" onClick={() => setActiveTab("character")}>人物线</button>
            <button className={activeTab === "chapter" ? "active" : ""} type="button" onClick={() => setActiveTab("chapter")}>章节</button>
          </div>
          <button className="button secondary" type="button" onClick={() => void controller.runWorkflowSkill("outline_generate", { text: bundle.outline.map((item) => `${item.title}：${item.summary}`).join("\n"), instruction: "完善当前故事大纲，保留既有事件与章节关联，结果先进入预览。", write_result: false })} disabled={controller.operationsBusy}><RefreshCw size={15} />AI 完善大纲</button>
          <button className="button primary" type="button" onClick={handleAddBeat}><Plus size={15} />添加情节点</button>
        </div>
      </div>

      <div className="outline-layout" style={{ flex: 1, minHeight: 0 }}>
        {/* 左栏：故事结构导航 */}
        <aside className="outline-nav">
          <span className="subhead">故事结构</span>
          <button type="button" className={activeTab === "main" ? "active" : ""} onClick={() => setActiveTab("main")}>
            <Network size={15} />主线大纲
          </button>
          <button type="button" className={activeTab === "character" ? "active" : ""} onClick={() => setActiveTab("character")}>
            <Users size={15} />人物线
          </button>
          <button type="button" className={activeTab === "chapter" ? "active" : ""} onClick={() => setActiveTab("chapter")}>
            <Pin size={15} />章节规划
          </button>
          <span className="subhead gap">分卷</span>
          {volumeNodes.map((volume) => <button key={volume.id} type="button" className={selectedNodeId === volume.id ? "active-soft" : ""} onClick={() => setSelectedNodeId(volume.id)}><BookOpen size={15} />{volume.title}</button>)}
          {!volumeNodes.length && <small className="outline-nav-empty">尚未建立分卷</small>}
        </aside>

        {/* 中栏：情节点列表 */}
        <section className="beat-list" style={{ overflowY: "auto" }}>
          <div className="structure-summary">
            <div>
              <span>本卷目标</span>
              <strong>{visibleOutline[0]?.summary || "尚未填写本卷目标"}</strong>
            </div>
            <div>
              <span>核心冲突</span>
              <strong>{visibleOutline[1]?.summary || "尚未填写核心冲突"}</strong>
            </div>
            <div>
              <span>情绪走向</span>
              <strong>{visibleOutline[2]?.summary || "尚未填写情绪走向"}</strong>
            </div>
            <button className="icon-button" type="button" title="编辑当前大纲节点" onClick={() => selectedNode ? setSelectedNodeId(selectedNode.id) : void handleAddBeat()}>
              <SquarePen size={15} />
            </button>
          </div>

          {visibleOutline.length === 0 ? (
            <div style={{ padding: "40px", textAlign: "center" }}>
              <EmptyState title="还没有大纲事件" description="点击右上角“添加情节点”开始梳理您的小说大纲。" />
            </div>
          ) : (
            visibleOutline.map((item, index) => {
              const active = item.id === selectedNodeId;
              return (
                <article
                  key={item.id}
                  className={`beat-row ${active ? "selected" : ""}`}
                >
                  <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                    <button
                      className="icon-button subtle"
                      type="button"
                      title="上移"
                      onClick={(e) => {
                        void handleMove("up", item.id);
                      }}
                      disabled={index === 0}
                    >
                      ▲
                    </button>
                    <button
                      className="icon-button subtle"
                      type="button"
                      title="下移"
                      onClick={(e) => {
                        void handleMove("down", item.id);
                      }}
                      disabled={index === visibleOutline.length - 1}
                    >
                      ▼
                    </button>
                  </div>
                  {inlineEditingId === item.id ? (
                    <div className="beat-inline-editor">
                      <input aria-label="情节点标题" value={editTitle} onChange={(event) => setEditTitle(event.target.value)} />
                      <textarea aria-label="情节点摘要" rows={3} value={editSummary} onChange={(event) => setEditSummary(event.target.value)} />
                      <input aria-label="关联章节" placeholder="关联章节，逗号分隔" value={editChapters} onChange={(event) => setEditChapters(event.target.value)} />
                      <div>
                        <button className="button secondary compact" type="button" onClick={() => setInlineEditingId(null)}><X size={14} />取消</button>
                        <button className="button primary compact" type="button" onClick={() => void handleSaveEdit()} disabled={!editTitle.trim()}><Check size={14} />保存</button>
                      </div>
                    </div>
                  ) : (
                    <button className="beat-select" type="button" onClick={() => setSelectedNodeId(item.id)} onDoubleClick={() => handleStartInlineEdit(item)}>
                      <span className="beat-index">{(index + 1).toString().padStart(2, "0")}</span>
                      <div className="beat-copy">
                        <div>
                          <strong>{item.title}</strong>
                          <span className="state-tag state-2" style={{ marginLeft: "10px" }}>{item.status === "done" ? "已完成" : "待处理"}</span>
                        </div>
                        <p>{item.summary}</p>
                        <small>关联章节：{item.chapter_paths.join(", ") || "未关联"}</small>
                      </div>
                    </button>
                  )}
                  <div className="beat-row-actions">
                    <button className="icon-button subtle" type="button" title="就地编辑" aria-label={`编辑${item.title}`} onClick={() => handleStartInlineEdit(item)}><SquarePen size={14} /></button>
                    <button className={`icon-button subtle${deleteConfirmId === item.id ? " danger" : ""}`} type="button" title={deleteConfirmId === item.id ? "再次点击确认删除" : "删除情节点"} aria-label={deleteConfirmId === item.id ? `确认删除${item.title}` : `删除${item.title}`} onClick={() => void handleDelete(item.id)}><Trash2 size={14} /></button>
                  </div>
                </article>
              );
            })
          )}
        </section>

        {/* 右栏：情节点详情面板 */}
        <aside className="detail-panel" style={{ overflowY: "auto" }}>
          {selectedNode ? (
            <>
              <div className="detail-head">
                <span>情节点详情</span>
              </div>
              <div style={{ padding: "10px", display: "flex", flexDirection: "column", gap: "12px" }}>
                <label style={{ display: "block" }}>
                  <span className="field-label">标题</span>
                  <input
                    value={editTitle}
                    onChange={(e) => setEditTitle(e.target.value)}
                    style={{ width: "100%", padding: "6px", borderRadius: "4px", border: "1px solid var(--line)" }}
                  />
                </label>
                <label style={{ display: "block" }}>
                  <span className="field-label">剧情目标</span>
                  <textarea
                    value={editSummary}
                    onChange={(e) => setEditSummary(e.target.value)}
                    rows={4}
                    style={{ width: "100%", padding: "6px", borderRadius: "4px", border: "1px solid var(--line)", resize: "none" }}
                  />
                </label>
                <label style={{ display: "block" }}>
                  <span className="field-label">关联章节</span>
                  <input
                    value={editChapters}
                    onChange={(e) => setEditChapters(e.target.value)}
                    placeholder="关联的章节名称，逗号分隔"
                    style={{ width: "100%", padding: "6px", borderRadius: "4px", border: "1px solid var(--line)" }}
                  />
                </label>

                <div className="detail-divider" style={{ borderTop: "1px solid var(--line)", margin: "10px 0" }} />

                <span className="field-label">一致性检查结果</span>
                <div className="mini-check success" style={{ display: "flex", alignItems: "center", gap: "6px", color: "var(--success)" }}>
                  <CheckCircle2 size={15} />
                  <span style={{ fontSize: "12px" }}>未发现人物动机冲突</span>
                </div>

                <button className="button primary" style={{ width: "100%", minHeight: "32px", marginTop: "10px" }} type="button" onClick={handleSaveEdit}>
                  <Check size={15} />保存修改
                </button>
              </div>
            </>
          ) : (
            <div style={{ padding: "20px", color: "var(--muted)", textAlign: "center", fontSize: "12px" }}>
              选择或新建一个情节点查看详情
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
