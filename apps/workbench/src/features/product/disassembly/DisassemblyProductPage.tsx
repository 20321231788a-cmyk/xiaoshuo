import {
  BookOpen,
  ChevronDown,
  Download,
  FileText,
  FolderOpen,
  Info,
  MoreHorizontal,
  Pause,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  SlidersHorizontal,
  Sparkles,
  Upload,
  Wand2,
  X
} from "lucide-react";
import { useEffect, useState } from "react";
import type { StoryPlanningBundle } from "@xiaoshuo/shared";
import type { WorkbenchController, DisassemblyBookSummary } from "../../../hooks/useWorkbenchController.js";
import { EmptyState } from "../shared/SharedStates.js";
import { LibraryDraftReview } from "../shared/LibraryDraftReview.js";

type DisassemblyUiState = {
  selectedBookId: string;
  fusionBookIds: string[];
  onSelectBook: (bookId: string) => void;
  onToggleFusionBook: (bookId: string) => void;
};

type AnalysisArtifactId = "report" | "source" | "detail_outline" | "reverse_outline" | "lore";
type AnalysisArtifact = { id: AnalysisArtifactId; label: string; path: string };

function isReadyForFusion(book: DisassemblyBookSummary): boolean {
  return Boolean(book.status === "ready" && (book.paths.report || (book.paths.reverse_outline && book.paths.lore)));
}

function primaryBookPath(book: DisassemblyBookSummary | null): string {
  if (!book) return "";
  return book.paths.source || book.paths.detail_outline || book.paths.reverse_outline || book.paths.lore || book.source_path || "";
}

function progressValue(message: string, busy: boolean): number | undefined {
  const match = /(\d+)\s*\/\s*(\d+)/.exec(message);
  const completed = Number(match?.[1] || 0);
  const total = Number(match?.[2] || 0);
  if (total > 0 && completed >= 0) {
    return Math.min(100, Math.round((completed / total) * 100));
  }
  return busy ? undefined : 100;
}

export function DisassemblyProductPage({
  controller,
  disassemblyUi
}: {
  controller: WorkbenchController;
  disassemblyUi: DisassemblyUiState;
}) {
  const [searchQuery, setSearchQuery] = useState("");
  const [activeAnalysisTab, setActiveAnalysisTab] = useState<"summary" | AnalysisArtifactId>("summary");
  const [fusionPreview, setFusionPreview] = useState<{ text: string; fusionId: string } | null>(null);
  const [applyingFusion, setApplyingFusion] = useState(false);

  // Keep historical split books visible and available to fusion.  A fast run
  // only changes the active outputs of the book currently being re-analysed.
  const books = controller.disassemblyBooks;
  const fusionReadyBooks = books.filter(isReadyForFusion);
  const selectedBook = books.find((book) => book.id === disassemblyUi.selectedBookId) || books[0] || null;
  const selectedFusionBooks = fusionReadyBooks.filter((book) => disassemblyUi.fusionBookIds.includes(book.id));
  const allAnalysisArtifacts: AnalysisArtifact[] = selectedBook
    ? selectedBook.analysis_scope?.mode === "prefix_chapters"
      ? [
        { id: "report", label: "拆书报告", path: selectedBook.paths.report || "" },
        { id: "source", label: "原始文本", path: selectedBook.paths.source || selectedBook.source_path || "" }
      ]
      : [
        { id: "report", label: "拆书报告", path: selectedBook.paths.report || "" },
        { id: "source", label: "原始文本", path: selectedBook.paths.source || selectedBook.source_path || "" },
        { id: "detail_outline", label: "章节细纲", path: selectedBook.paths.detail_outline || "" },
        { id: "reverse_outline", label: "逆向大纲", path: selectedBook.paths.reverse_outline || "" },
        { id: "lore", label: "设定提取", path: selectedBook.paths.lore || "" }
      ]
    : [];
  const analysisArtifacts = allAnalysisArtifacts.filter((item) => item.path);

  useEffect(() => {
    setActiveAnalysisTab("summary");
  }, [selectedBook?.id]);

  async function handleUploadBook(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) {
      const title = file.name.replace(/\.[^.]+$/, "").trim() || file.name;
      const attachment = await controller.uploadWorkflowAttachment(file, { bookTitle: title });
      if (attachment) {
        const book = await controller.archiveDisassemblySource(attachment.id, title, attachment.conversation_id);
        if (book) {
          disassemblyUi.onSelectBook(book.id);
        }
      }
    }
  }

  // 运行一键拆解
  async function runDisassemble() {
    if (!selectedBook) return;
    await controller.runWorkflowSkill("disassemble_book", {
      text: "",
      source_path: selectedBook.paths.source || "",
      conversation_id: selectedBook.conversation_id || "",
      source_book_id: selectedBook.id,
      book_title: selectedBook.title,
      instruction: "一键拆解前100章：逐章一句剧情、每10章阶段总结、主角成长弧光、主要角色配置和主要设定。",
      write_result: true,
      attachment_ids: []
    } as any);
    await controller.refreshDisassemblyLibrary();
  }

  // 刷新书库
  function refreshLibrary() {
    void controller.refreshDisassemblyLibrary();
  }

  function openReport() {
    if (!selectedBook) return;
    const path = selectedBook.paths.report || selectedBook.paths.reverse_outline || selectedBook.paths.lore || selectedBook.paths.source || "";
    if (path) void controller.openDocument(path);
  }

  function addMethodToPreview(artifact: AnalysisArtifact) {
    void controller.runWorkflowSkill("style_extract", {
      text: `参考作品：${selectedBook?.title || ""}\n分析资料：${artifact.label}`,
      source_path: artifact.path,
      instruction: "从这份拆解结果中提取可复用的写作方法，改写为适合当前项目的规则；只生成预览，不直接覆盖规则库。",
      write_result: false
    });
  }

  function runDistillation() {
    if (!selectedBook) return;
    if (
      controller.styleDistillationProfile
      && !window.confirm(`当前项目已使用《${controller.styleDistillationProfile.book_title || "未命名作品"}》的蒸馏文风，确认替换为《${selectedBook.title}》吗？`)
    ) {
      return;
    }
    void controller.runNuwaStyleDistillation({
      replace: Boolean(controller.styleDistillationProfile),
      sourceBookId: selectedBook.id,
      sourcePath: primaryBookPath(selectedBook),
      bookTitle: selectedBook.title,
      text: ""
    });
  }

  async function runFusion() {
    if (selectedFusionBooks.length < 3) return;
    const result = await controller.runWorkflowSkill("book_fusion", {
      text: "",
      source_path: "",
      instruction: "抽象融合所选作品的核心设定、剧情骨架、人物驱动力与题材氛围，生成去同质化的原创候选方案。不得复写原文句式、专有名词、可识别桥段或固定角色关系。",
      custom_prompt: "优先保留可迁移的方法与冲突结构，主动拆散原作组合关系，输出可继续展开的原创方案。",
      output_mode: "candidate",
      source_book_ids: selectedFusionBooks.map((book) => book.id),
      write_result: true,
      attachment_ids: []
    } as any);
    if (result?.result) {
      setFusionPreview({ text: result.result, fusionId: String(result.data?.fusion_id || "") });
    }
  }

  async function applyFusionToOutline() {
    if (!fusionPreview || applyingFusion) return;
    setApplyingFusion(true);
    try {
      const current = await planningRequest<StoryPlanningBundle>(controller, "/api/story-planning");
      const now = new Date().toISOString();
      const node = {
        id: globalThis.crypto?.randomUUID?.().replace(/-/g, "") || `${Date.now()}${Math.random().toString(16).slice(2)}`,
        kind: "main_arc" as const,
        parent_id: null,
        title: "融梗候选方案",
        summary: fusionPreview.text,
        order: current.outline.length,
        chapter_paths: [],
        entity_ids: [],
        status: "planned" as const,
        created_at: now,
        updated_at: now
      };
      const nextBundle = await planningRequest<StoryPlanningBundle>(controller, "/api/story-planning", {
        method: "PUT",
        body: JSON.stringify({ base_revision: current.revision, outline: [...current.outline, node], timeline: current.timeline })
      });
      if (fusionPreview.fusionId) {
        await controller.runWorkflowSkill("book_fusion", {
          action: "mark_applied",
          fusion_id: fusionPreview.fusionId,
          applied_target: "story_planning",
          target_revision: nextBundle.revision,
          source_book_ids: []
        } as any);
      }
      await controller.refreshProjectWorkspace();
      setFusionPreview(null);
    } finally {
      setApplyingFusion(false);
    }
  }

  // 过滤书库
  const filteredBooks = books.filter((b) => b.title.toLowerCase().includes(searchQuery.toLowerCase()));
  const disassemblyTask = selectedBook
    ? controller.longTasks.find((task) => (
      (task.skill_id === "disassemble_book" || task.skill_id === "continue_disassemble")
      && task.conversation_id === selectedBook.conversation_id
    )) || null
    : null;
  const operationProgress = disassemblyTask
    ? taskProgressValue(disassemblyTask.completed, disassemblyTask.total, disassemblyTask.status)
    : progressValue(controller.operationsMessage, controller.operationsBusy);

  return (
    <div className="page-scroll" style={{ padding: "20px", display: "flex", flexDirection: "column", height: "100%" }}>
      <div className="content-head">
        <div>
          <h1>拆书工作台</h1>
          <p>导入参考作品，极速拆解前100章的剧情、主角成长、角色配置和主要设定。</p>
        </div>
        <div className="content-actions">
          <label className="button secondary compact" style={{ cursor: "pointer" }}>
            <Upload size={15} /> 导入文本
            <input type="file" onChange={handleUploadBook} style={{ display: "none" }} />
          </label>
          <button className="button primary" type="button" onClick={() => void runDisassemble()} disabled={!selectedBook || selectedBook.legacy || Boolean(disassemblyTask && !isTerminalTask(disassemblyTask.status)) || controller.operationsBusy}>
            <Sparkles size={15} /> 拆解前100章
          </button>
        </div>
      </div>

      {(disassemblyTask || controller.operationsBusy || controller.operationsMessage) && (
        <section
          aria-live="polite"
          style={{
            display: "grid",
            gridTemplateColumns: "auto minmax(120px, 1fr)",
            alignItems: "center",
            gap: "10px",
            padding: "9px 12px",
            marginBottom: "12px",
            border: "1px solid var(--line)",
            borderRadius: "6px",
            background: "var(--stone-deep)"
          }}
        >
          <strong style={{ fontSize: "13px" }}>{disassemblyTask ? taskStatusLabel(disassemblyTask.status) : controller.operationsBusy ? "拆书进行中" : "拆书任务状态"}</strong>
          <progress aria-label="拆书进度" max={100} value={operationProgress} style={{ width: "100%" }} />
          <p role="status" style={{ gridColumn: "1 / -1", margin: 0, fontSize: "12px", color: "var(--muted)" }}>
            {disassemblyTask?.message || controller.operationsMessage || `正在准备《${selectedBook?.title || "参考作品"}》的拆解任务...`}
          </p>
          {disassemblyTask && (
            <div style={{ gridColumn: "1 / -1" }}>
              <TaskControls task={disassemblyTask} onControl={(action) => void controller.controlLongTask(disassemblyTask.task_id, action)} />
            </div>
          )}
        </section>
      )}

      <div className="disassembly-layout" style={{ flex: 1, minHeight: 0 }}>
        {/* 左栏：参考书库 */}
        <aside className="book-library" style={{ display: "flex", flexDirection: "column" }}>
          <div className="panel-head">
            <strong>参考书库</strong>
            <button className="icon-button subtle" type="button" onClick={refreshLibrary}>
              <RefreshCw size={15} />
            </button>
          </div>
          <div className="session-search">
            <Search size={14} />
            <input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="搜索书名..."
              style={{ border: 0, outline: 0, background: "transparent", fontSize: "12px", width: "100%" }}
            />
          </div>

          <div style={{ flex: 1, overflowY: "auto", padding: "8px" }}>
            {filteredBooks.map((book) => {
              const active = selectedBook && book.id === selectedBook.id;
              return (
                <button
                  key={book.id}
                  className={`reference-book ${active ? "active" : ""}`}
                  type="button"
                  onClick={() => disassemblyUi.onSelectBook(book.id)}
                  style={{
                    width: "100%",
                    display: "flex",
                    alignItems: "center",
                    gap: "10px",
                    padding: "8px",
                    border: 0,
                    borderRadius: "6px",
                    background: active ? "var(--accent-soft)" : "transparent",
                    textAlign: "left",
                    cursor: "pointer",
                    marginBottom: "6px"
                  }}
                >
                  <span className="ref-cover" style={{ width: "24px", height: "30px", background: "var(--accent)", color: "#fff", display: "grid", placeItems: "center", borderRadius: "3px", fontSize: "12px", fontWeight: "bold" }}>
                    {book.title.slice(0, 1)}
                  </span>
                  <span style={{ flex: 1 }}>
                    <strong style={{ fontSize: "12px", display: "block" }}>{book.title}</strong>
                    <small style={{ fontSize: "12px", color: book.status === "failed" ? "var(--danger)" : "var(--muted)" }}>{bookStatusLabel(book)}</small>
                  </span>
                </button>
              );
            })}
            {filteredBooks.length === 0 && (
              <p style={{ textAlign: "center", fontSize: "12px", color: "var(--muted)", padding: "10px" }}>暂无书籍数据</p>
            )}
          </div>
        </aside>

        {/* 中栏：作品拆解分析内容 */}
        <main className="disassembly-main" style={{ flex: 1, overflowY: "auto" }}>
          {selectedBook ? (
            <>
              <div className="book-profile" style={{ display: "flex", gap: "15px", alignItems: "center", paddingBottom: "15px", borderBottom: "1px solid var(--line)" }}>
                <span className="ref-cover large" style={{ width: "50px", height: "64px", background: "var(--accent)", color: "#fff", display: "grid", placeItems: "center", borderRadius: "4px", fontSize: "18px", fontWeight: "bold" }}>
                  {selectedBook.title.slice(0, 1)}
                </span>
                <div style={{ flex: 1 }}>
                  <span className="eyebrow" style={{ fontSize: "12px", color: selectedBook.status === "failed" ? "var(--danger)" : "var(--success)" }}>{bookStatusLabel(selectedBook)}</span>
                  <h2>{selectedBook.title}</h2>
                    <p style={{ fontSize: "12px", color: "var(--muted)" }}>
                      {selectedBook.analysis_scope
                        ? selectedBook.analysis_scope.mode === "prefix_chapters"
                          ? `已分析前${selectedBook.analysis_scope.requested_chapters || 100}章（实际 ${selectedBook.analysis_scope.actual_chapters || 0} 章，第${selectedBook.analysis_scope.first_chapter || 1}-${selectedBook.analysis_scope.last_chapter || selectedBook.analysis_scope.actual_chapters || 1}章）`
                          : `已分析前${Math.round((selectedBook.analysis_scope.requested_chars || 0) / 10_000)}万字（实际 ${selectedBook.analysis_scope.actual_chars.toLocaleString()} 字，含跨界完整章）`
                        : `${analysisArtifacts.length} 份项目资料可用`}
                    </p>
                </div>
                <div style={{ display: "flex", gap: "8px" }}>
                  <button className="button secondary compact" type="button" onClick={openReport} disabled={!selectedBook.paths.report}>
                    <Download size={14} /> 打开报告
                  </button>
                  <button className="button primary compact" type="button" onClick={refreshLibrary}>
                    <RefreshCw size={14} /> 刷新
                  </button>
                </div>
              </div>

              <div className="analysis-tabs" style={{ display: "flex", gap: "10px", margin: "15px 0", borderBottom: "1px solid var(--line)" }}>
                <button className={activeAnalysisTab === "summary" ? "active" : ""} onClick={() => setActiveAnalysisTab("summary")}>总览</button>
                {analysisArtifacts.map((artifact) => (
                  <button key={artifact.id} className={activeAnalysisTab === artifact.id ? "active" : ""} onClick={() => setActiveAnalysisTab(artifact.id)}>{artifact.label}</button>
                ))}
              </div>

              <section className="analysis-content">
                {activeAnalysisTab === "summary" ? (
                  <div className="analysis-summary" style={{ background: "var(--stone-deep)", padding: "12px", borderRadius: "6px", marginBottom: "15px" }}>
                    <h3 style={{ fontSize: "14px", marginBottom: "6px" }}>拆解产物</h3>
                    <p style={{ fontSize: "12px", color: "var(--muted)", lineHeight: "1.6" }}>
                      {selectedBook.analysis_scope?.mode === "prefix_chapters"
                        ? "报告固定包含前100章剧情、主角成长弧光、主要角色配置和主要设定四个板块。"
                        : `已生成 ${analysisArtifacts.length} 份可用资料。选择上方标签查看文件位置，或直接提取其中可复用的写作方法。`}
                    </p>
                  </div>
                ) : (() => {
                  const artifact = analysisArtifacts.find((item) => item.id === activeAnalysisTab);
                  return artifact ? (
                    <article className="method-row" style={{ padding: "12px", border: "1px solid var(--line)", borderRadius: "6px" }}>
                      <strong>{artifact.label}</strong>
                      <p style={{ fontSize: "12px", color: "var(--muted)", margin: "6px 0", overflowWrap: "anywhere" }}>{artifact.path}</p>
                      <div style={{ display: "flex", gap: "8px" }}>
                        <button className="button secondary compact" type="button" onClick={() => void controller.openDocument(artifact.path)}>打开资料</button>
                        {artifact.id !== "source" && artifact.id !== "report" && <button className="button primary compact" type="button" onClick={() => addMethodToPreview(artifact)}>提取写作方法</button>}
                      </div>
                    </article>
                  ) : null;
                })()}
              </section>
            </>
          ) : (
            <div style={{ padding: "40px", textAlign: "center", color: "var(--muted)" }}>
              请在左侧书库中选择一本书籍，或导入新书籍。
            </div>
          )}
        </main>

        {/* 右栏：蒸馏、融梗与资料草稿 */}
        <aside className="extract-panel disassembly-transform-panel" style={{ overflowY: "auto", borderLeft: "1px solid var(--line)", paddingLeft: "10px" }}>
          <div className="detail-head">
            <span>融梗与蒸馏</span>
          </div>

          <section className="disassembly-action-section">
            <div className="disassembly-action-title">
              <Wand2 size={15} />
              <strong>蒸馏当前作品</strong>
            </div>
            <p>
              {selectedBook
                ? `提取《${selectedBook.title}》的叙事节奏、对白和描写习惯。`
                : "先从左侧选择一本参考作品。"}
            </p>
            {controller.styleDistillationProfile && (
              <small>当前使用：{controller.styleDistillationProfile.book_title || "未命名作品"}</small>
            )}
            <button
              className="button secondary"
              type="button"
              onClick={runDistillation}
              disabled={!selectedBook || selectedBook.status !== "ready" || !selectedBook.paths.source || controller.operationsBusy}
            >
              <Wand2 size={14} />
              {controller.styleDistillationProfile ? "替换蒸馏文风" : "蒸馏此书"}
            </button>
          </section>

          <section className="disassembly-action-section">
            <div className="disassembly-action-title">
              <SlidersHorizontal size={15} />
              <strong>多书融梗</strong>
              <span>{selectedFusionBooks.length} / 3+</span>
            </div>
            <p>选择至少三本已完成拆解的作品，生成原创候选方案。</p>
            <div className="disassembly-fusion-books">
              {fusionReadyBooks.map((book) => (
                <label key={book.id}>
                  <input
                    type="checkbox"
                    checked={disassemblyUi.fusionBookIds.includes(book.id)}
                    onChange={() => disassemblyUi.onToggleFusionBook(book.id)}
                  />
                  <span>{book.title}</span>
                </label>
              ))}
              {!fusionReadyBooks.length && <small>完成拆解后，作品会出现在这里。</small>}
            </div>
            <button
              className="button primary"
              type="button"
              onClick={runFusion}
              disabled={selectedFusionBooks.length < 3 || controller.operationsBusy}
            >
              <SlidersHorizontal size={14} />
              生成融梗方案
            </button>
            {fusionPreview && (
              <div className="disassembly-fusion-preview">
                <strong>写入大纲前预览</strong>
                <pre>{fusionPreview.text}</pre>
                <div className="content-actions">
                  <button className="button secondary compact" type="button" onClick={() => setFusionPreview(null)}>丢弃</button>
                  <button className="button primary compact" type="button" onClick={applyFusionToOutline} disabled={applyingFusion}>
                    {applyingFusion ? "写入中..." : "确认写入故事大纲"}
                  </button>
                </div>
              </div>
            )}
          </section>

          <LibraryDraftReview
            controller={controller}
            domains={["style"]}
            refreshKey={String(controller.latestSkillResult?.data?.library_draft && JSON.stringify(controller.latestSkillResult.data.library_draft))}
          />
        </aside>
      </div>
    </div>
  );
}

function bookStatusLabel(book: DisassemblyBookSummary): string {
  if (book.status === "ready") {
    if (book.analysis_scope?.mode === "prefix_chapters") {
      return book.analysis_scope.truncated ? "已完成前100章拆解" : "拆解完成";
    }
    return book.analysis_scope?.truncated ? "已完成前20万字拆解" : "拆解完成";
  }
  if (book.status === "analyzing") return "正在拆解";
  if (book.status === "failed") return book.error ? `拆解失败：${book.error}` : "拆解失败";
  if (book.status === "cancelled") return "拆解已取消，可继续拆解";
  if (book.status === "stale") return "结果待重新拆解";
  return "已导入，等待拆解";
}

function taskProgressValue(completed: number, total: number, status: string): number | undefined {
  if (total > 0) return Math.min(100, Math.round((completed / total) * 100));
  return isTerminalTask(status) ? 100 : undefined;
}

function isTerminalTask(status: string): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function taskStatusLabel(status: string): string {
  if (status === "paused") return "拆书任务已暂停";
  if (status === "failed") return "拆书任务失败";
  if (status === "cancelled") return "拆书任务已取消";
  if (status === "completed") return "拆书任务已完成";
  return "拆书进行中";
}

function TaskControls({
  task,
  onControl
}: {
  task: { status: string };
  onControl: (action: "pause" | "resume" | "cancel" | "retry") => void;
}) {
  if (task.status === "completed" || task.status === "cancelled") return null;
  return (
    <div style={{ display: "flex", gap: "6px" }}>
      {task.status === "paused" ? (
        <button className="button secondary compact" type="button" onClick={() => onControl("resume")}><Sparkles size={13} />继续</button>
      ) : task.status === "failed" ? (
        <button className="button secondary compact" type="button" onClick={() => onControl("retry")}><RotateCcw size={13} />重试</button>
      ) : (
        <button className="button secondary compact" type="button" onClick={() => onControl("pause")}><Pause size={13} />暂停</button>
      )}
      {task.status !== "failed" && <button className="button secondary compact" type="button" onClick={() => onControl("cancel")}><X size={13} />取消</button>}
    </div>
  );
}

async function planningRequest<T>(controller: WorkbenchController, pathname: string, init?: RequestInit): Promise<T> {
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
