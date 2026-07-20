import {
  Clock3,
  Filter,
  Info,
  MoreHorizontal,
  Pin,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { LedgerItem, StoryTimelineEvent, StoryPlanningBundle } from "@xiaoshuo/shared";
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
  if (!response.ok) throw new Error(String(payload.detail || response.statusText || "故事时间线请求失败"));
  return payload as T;
}

function newId(): string {
  return globalThis.crypto?.randomUUID?.().replace(/-/g, "") || `${Date.now()}${Math.random().toString(16).slice(2)}`;
}

function stamp(): string {
  return new Date().toISOString();
}

export function CluesProductPage({
  controller,
  onSelectFeature
}: {
  controller: WorkbenchController;
  onSelectFeature: (feature: any) => void;
}) {
  const [view, setView] = useState<"ledger" | "timeline">("ledger");

  // 伏笔相关状态
  const [ledgerDraft, setDraft] = useState("");
  const [scanText, setScanText] = useState("");
  const [scanInstruction, setScanInstruction] = useState("");
  const [ledgerFilter, setLedgerFilter] = useState<"all" | "open" | "closed">("all");
  const [ledgerSearchOpen, setLedgerSearchOpen] = useState(false);
  const [ledgerSearch, setLedgerSearch] = useState("");
  const [phaseFilterOpen, setPhaseFilterOpen] = useState(false);
  const ledger = controller.snapshot?.ledger || [];

  // 时间线相关状态
  const [bundle, setBundle] = useState<StoryPlanningBundle | null>(null);
  const [timelineState, setTimelineState] = useState<LoadState>("loading");
  const [storyTimeInput, setStoryTimeInput] = useState("");
  const [eventTitleInput, setEventTitleInput] = useState("");

  const activeDocument = controller.openDocuments.find((document) => document.path === controller.activeDocumentPath) || null;

  // 获取故事大纲/时间线数据
  const refreshTimeline = useCallback(async () => {
    setTimelineState("loading");
    try {
      const data = await request<StoryPlanningBundle>(controller, "/api/story-planning");
      setBundle(data);
      setTimelineState("ready");
    } catch (e) {
      setTimelineState("error");
    }
  }, [controller]);

  useEffect(() => {
    if (view === "timeline") {
      void refreshTimeline();
    }
  }, [view, refreshTimeline]);

  // 新增伏笔
  async function handleAddLedger() {
    const text = ledgerDraft.trim();
    if (text) {
      await controller.addLedgerItem(text);
      setDraft("");
    }
  }

  // 扫描伏笔
  async function handleScanPits() {
    await controller.runWorkflowSkill("scan_pits", {
      text: scanText || activeDocument?.content || "",
      source_path: activeDocument?.path || "",
      instruction: scanInstruction,
      write_result: false
    });
  }

  // 新增时间线事件
  async function handleAddTimelineEvent() {
    if (!bundle || !storyTimeInput.trim() || !eventTitleInput.trim()) return;
    const now = stamp();
    const newEvent: StoryTimelineEvent = {
      id: newId(),
      title: eventTitleInput.trim(),
      summary: "",
      story_time: storyTimeInput.trim(),
      sort_key: storyTimeInput.trim(),
      order: bundle.timeline.length,
      chapter_paths: [],
      entity_ids: [],
      clue_ids: [],
      status: "planned",
      created_at: now,
      updated_at: now
    };

    const nextTimeline = [...bundle.timeline, newEvent];
    const nextBundle = await request<StoryPlanningBundle>(controller, "/api/story-planning", {
      method: "PUT",
      body: JSON.stringify({ base_revision: bundle.revision, outline: bundle.outline, timeline: nextTimeline })
    });
    setBundle(nextBundle);
    setStoryTimeInput("");
    setEventTitleInput("");
  }

  // 统计数值
  const activeCluesCount = ledger.filter(item => item.status !== "closed").length;
  const resolvedCluesCount = ledger.filter(item => item.status === "closed").length;
  const visibleLedger = ledger.filter((item) => {
    if (ledgerFilter === "open" && item.status === "closed") return false;
    if (ledgerFilter === "closed" && item.status !== "closed") return false;
    return !ledgerSearch.trim() || `${item.desc} ${item.phase || ""}`.toLocaleLowerCase("zh-CN").includes(ledgerSearch.trim().toLocaleLowerCase("zh-CN"));
  });

  return (
    <div className="page-scroll" style={{ padding: "20px", display: "flex", flexDirection: "column", height: "100%" }}>
      <div className="content-head">
        <div>
          <h1>伏笔与时间线</h1>
          <p>集中管理埋设、回应和故事时间，避免长篇写作前后冲突。</p>
        </div>
        <div className="content-actions">
          <div className="segment">
            <button className={view === "ledger" ? "active" : ""} type="button" onClick={() => setView("ledger")}>伏笔</button>
            <button className={view === "timeline" ? "active" : ""} type="button" onClick={() => setView("timeline")}>时间线</button>
          </div>
          {view === "ledger" ? (
            <>
              <button className="button secondary" type="button" onClick={handleScanPits} disabled={controller.operationsBusy}>
                <Search size={15} />扫描全文
              </button>
              <div style={{ display: "flex", gap: "6px" }}>
                <input
                  value={ledgerDraft}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder="输入新伏笔描述..."
                  style={{ padding: "4px 8px", borderRadius: "4px", border: "1px solid var(--line)", fontSize: "12px", width: "160px" }}
                />
                <button className="button primary" type="button" onClick={handleAddLedger} disabled={!ledgerDraft.trim()}>
                  <Plus size={15} />新建伏笔
                </button>
              </div>
            </>
          ) : (
            <button className="button secondary" type="button" onClick={refreshTimeline}>
              <RefreshCw size={15} />刷新
            </button>
          )}
        </div>
      </div>

      {view === "ledger" ? (
        <>
          {/* 伏笔视图 */}
          <div className="clue-summary">
            <div>
              <span>活跃伏笔</span>
              <strong>{activeCluesCount}</strong>
              <small>本卷待回收</small>
            </div>
            <div>
              <span>已回应</span>
              <strong>{resolvedCluesCount}</strong>
              <small>完成率 {ledger.length ? Math.round((resolvedCluesCount / ledger.length) * 100) : 0}%</small>
            </div>
            <div>
              <span>临近章节</span>
              <strong>{ledger.filter((item) => item.phase === "due").length}</strong>
              <small>建议优先处理</small>
            </div>
            <div className="timeline-mini">
              <span>故事跨度</span>
              <strong>{bundle?.timeline.length ? `${bundle.timeline[0]?.story_time || "未设置"} → ${bundle.timeline.at(-1)?.story_time || "未设置"}` : "尚未建立"}</strong>
              <small>{bundle?.timeline.length ? `${bundle.timeline.length} 个故事事件` : "切换到时间线添加事件"}</small>
            </div>
          </div>

          <div className="toolbar-line">
            <div className="filter-pills">
              <button type="button" className={ledgerFilter === "all" ? "active" : ""} onClick={() => setLedgerFilter("all")}>全部 {ledger.length}</button>
              <button type="button" className={ledgerFilter === "open" ? "active" : ""} onClick={() => setLedgerFilter("open")}>待回收 {activeCluesCount}</button>
              <button type="button" className={ledgerFilter === "closed" ? "active" : ""} onClick={() => setLedgerFilter("closed")}>已回收 {resolvedCluesCount}</button>
            </div>
            <div>
              <button className="icon-button" type="button" title="筛选阶段" aria-pressed={phaseFilterOpen} onClick={() => setPhaseFilterOpen((value) => !value)}>
                <Filter size={15} />
              </button>
              <button className="icon-button" type="button" title="搜索伏笔" aria-pressed={ledgerSearchOpen} onClick={() => setLedgerSearchOpen((value) => !value)}>
                <Search size={15} />
              </button>
            </div>
          </div>
          {(ledgerSearchOpen || phaseFilterOpen) && (
            <div className="clue-filter-row">
              {ledgerSearchOpen && <input value={ledgerSearch} onChange={(event) => setLedgerSearch(event.target.value)} placeholder="搜索伏笔内容" aria-label="搜索伏笔内容" />}
              {phaseFilterOpen && <select value={ledgerFilter} onChange={(event) => setLedgerFilter(event.target.value as "all" | "open" | "closed")} aria-label="筛选伏笔状态"><option value="all">全部状态</option><option value="open">待回收</option><option value="closed">已回收</option></select>}
            </div>
          )}

          <section className="clue-table" style={{ marginTop: "10px", overflowY: "auto", flex: 1 }}>
            <div className="table-head">
              <span>伏笔</span>
              <span>状态</span>
              <span>上次更新</span>
              <span>更多操作</span>
            </div>
            {visibleLedger.map((item) => (
              <article key={item.id} className={item.status !== "closed" ? "attention" : ""}>
                <span>
                  <Pin size={14} />
                  <strong>{item.desc}</strong>
                  <small>{item.phase || (item.status === "closed" ? "已回应" : "已埋设")}</small>
                </span>
                <span>
                  <i className={`status-pill clue-${item.status === "closed" ? 1 : 0}`}>
                    {item.status === "closed" ? "已回应" : "待回应"}
                  </i>
                </span>
                <span>{item.updated_at || item.created_at || "一小时前"}</span>
                <span style={{ display: "flex", gap: "6px" }}>
                  {item.status !== "closed" && (
                    <button
                      className="button primary compact"
                      type="button"
                      onClick={() => {
                        onSelectFeature("conversations");
                        void controller.sendLedgerRecoveryPrompt(item);
                      }}
                      style={{ height: "24px", minHeight: "24px" }}
                    >
                      AI回收
                    </button>
                  )}
                  <button
                    className="button secondary compact"
                    type="button"
                    onClick={() => void controller.toggleLedgerItem(item.id)}
                    style={{ height: "24px", minHeight: "24px" }}
                  >
                    {item.status === "closed" ? "重开" : "关闭"}
                  </button>
                </span>
              </article>
            ))}
            {visibleLedger.length === 0 && (
              <div style={{ padding: "40px" }}>
                <EmptyState title="还没有伏笔" description="开始在上方栏里新建一个伏笔吧！" />
              </div>
            )}
          </section>
        </>
      ) : (
        <>
          {/* 时间线视图 */}
          <div style={{ display: "flex", gap: "10px", marginBottom: "15px" }}>
            <input
              value={storyTimeInput}
              onChange={(e) => setStoryTimeInput(e.target.value)}
              placeholder="故事时间，例如：第三日深夜"
              style={{ padding: "6px", borderRadius: "4px", border: "1px solid var(--line)", fontSize: "12px", width: "180px" }}
            />
            <input
              value={eventTitleInput}
              onChange={(e) => setEventTitleInput(e.target.value)}
              placeholder="发生什么事件"
              style={{ padding: "6px", borderRadius: "4px", border: "1px solid var(--line)", fontSize: "12px", flex: 1 }}
            />
            <button className="button primary" type="button" onClick={handleAddTimelineEvent} disabled={!storyTimeInput.trim() || !eventTitleInput.trim()}>
              <Plus size={15} />添加事件
            </button>
          </div>

          <div style={{ flex: 1, overflowY: "auto" }}>
            {timelineState === "loading" && <div style={{ fontSize: "12px", color: "var(--muted)" }}>正在加载故事时间记录...</div>}

            {bundle && bundle.timeline.length > 0 && (
              <div className="aw-timeline-list">
                {bundle.timeline.map((item) => (
                  <article key={item.id} style={{ display: "flex", alignItems: "start", gap: "10px", padding: "10px", borderBottom: "1px solid var(--line)" }}>
                    <span className="aw-timeline-marker" style={{ width: "8px", height: "8px", borderRadius: "50%", background: "var(--accent)", marginTop: "6px" }} />
                    <div>
                      <strong>{item.story_time} · {item.title}</strong>
                      <p style={{ fontSize: "12px", color: "var(--muted)", margin: "4px 0" }}>{item.summary || "尚未填写事件细节说明"}</p>
                    </div>
                  </article>
                ))}
              </div>
            )}

            {bundle && bundle.timeline.length === 0 && (
              <div style={{ padding: "40px" }}>
                <EmptyState title="还没有时间记录" description="使用上方表单记录小说事件发生的 Story Time 吧。" />
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
