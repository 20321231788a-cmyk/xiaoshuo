import {
  ArrowLeftRight,
  BookOpen,
  ChevronDown,
  Download,
  FileText,
  FolderOpen,
  Info,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Search,
  SlidersHorizontal,
  Sparkles,
  Upload,
  Wand2
} from "lucide-react";
import { useEffect, useState } from "react";
import type { WorkbenchController, DisassemblyBookSummary } from "../../../hooks/useWorkbenchController.js";
import { EmptyState } from "../shared/SharedStates.js";

type DisassemblyUiState = {
  selectedBookId: string;
  fusionBookIds: string[];
  onSelectBook: (bookId: string) => void;
  onToggleFusionBook: (bookId: string) => void;
};

type AnalysisArtifactId = "source" | "detail_outline" | "reverse_outline" | "lore";
type AnalysisArtifact = { id: AnalysisArtifactId; label: string; path: string };

function isReadyForFusion(book: DisassemblyBookSummary): boolean {
  return Boolean(!book.legacy && (book.paths.detail_outline || book.paths.reverse_outline || book.paths.lore));
}

function primaryBookPath(book: DisassemblyBookSummary | null): string {
  if (!book) return "";
  return book.paths.source || book.paths.detail_outline || book.paths.reverse_outline || book.paths.lore || book.source_path || "";
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
  const [methodTarget, setMethodTarget] = useState("style/narrative");
  const [selectedMethods, setSelectedMethods] = useState<AnalysisArtifactId[]>([]);

  const books = controller.disassemblyBooks.filter((book) => !book.legacy);
  const fusionReadyBooks = books.filter(isReadyForFusion);
  const selectedBook = books.find((book) => book.id === disassemblyUi.selectedBookId) || books[0] || null;
  const selectedFusionBooks = fusionReadyBooks.filter((book) => disassemblyUi.fusionBookIds.includes(book.id));
  const allAnalysisArtifacts: AnalysisArtifact[] = selectedBook ? [
    { id: "source", label: "原始文本", path: selectedBook.paths.source || selectedBook.source_path || "" },
    { id: "detail_outline", label: "章节细纲", path: selectedBook.paths.detail_outline || "" },
    { id: "reverse_outline", label: "逆向大纲", path: selectedBook.paths.reverse_outline || "" },
    { id: "lore", label: "设定提取", path: selectedBook.paths.lore || "" }
  ] : [];
  const analysisArtifacts = allAnalysisArtifacts.filter((item) => item.path);

  useEffect(() => {
    setActiveAnalysisTab("summary");
    setSelectedMethods(analysisArtifacts.filter((item) => item.id !== "source").map((item) => item.id));
  }, [selectedBook?.id]);

  async function handleUploadBook(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) {
      const attachment = await controller.uploadWorkflowAttachment(file);
      if (attachment) {
        const title = file.name.replace(/\.[^.]+$/, "").trim() || file.name;
        const book = await controller.archiveDisassemblySource(attachment.id, title);
        if (book) {
          disassemblyUi.onSelectBook(book.id);
        }
      }
    }
  }

  // 运行一键拆解
  function runDisassemble() {
    if (!selectedBook) return;
    void controller.runWorkflowSkill("disassemble_book", {
      text: "",
      source_path: selectedBook.paths.source || "",
      source_book_id: selectedBook.id,
      book_title: selectedBook.title,
      instruction: "一键拆解全书结构与黄金开篇节奏",
      write_result: true,
      attachment_ids: []
    } as any);
  }

  // 刷新书库
  function refreshLibrary() {
    void controller.refreshDisassemblyLibrary();
  }

  function openReport() {
    if (!selectedBook) return;
    const path = selectedBook.paths.detail_outline || selectedBook.paths.reverse_outline || selectedBook.paths.lore || selectedBook.paths.source || "";
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

  function generateMigrationPreview() {
    if (!selectedBook || !selectedMethods.length) return;
    void controller.runWorkflowSkill("style_extract", {
      text: `参考书：${selectedBook.title}\n选择资料：${analysisArtifacts.filter((item) => selectedMethods.includes(item.id)).map((item) => item.label).join("、")}`,
      source_path: analysisArtifacts.find((item) => selectedMethods.includes(item.id))?.path || "",
      reference_paths: analysisArtifacts.filter((item) => selectedMethods.includes(item.id)).map((item) => item.path),
      instruction: `生成适配当前项目的规则迁移预览，目标：${methodTarget}。不要直接写入。`,
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

  function runFusion() {
    if (selectedFusionBooks.length < 3) return;
    void controller.runWorkflowSkill("book_fusion", {
      text: "",
      source_path: "",
      instruction: "抽象融合所选作品的核心设定、剧情骨架、人物驱动力与题材氛围，生成去同质化的原创候选方案。不得复写原文句式、专有名词、可识别桥段或固定角色关系。",
      custom_prompt: "优先保留可迁移的方法与冲突结构，主动拆散原作组合关系，输出可继续展开的原创方案。",
      output_mode: "candidate",
      source_book_ids: selectedFusionBooks.map((book) => book.id),
      write_result: true,
      attachment_ids: []
    } as any);
  }

  // 过滤书库
  const filteredBooks = books.filter((b) => b.title.toLowerCase().includes(searchQuery.toLowerCase()));

  return (
    <div className="page-scroll" style={{ padding: "20px", display: "flex", flexDirection: "column", height: "100%" }}>
      <div className="content-head">
        <div>
          <h1>拆书工作台</h1>
          <p>导入参考作品，提取结构、人物、节奏和可迁移的写作方法。</p>
        </div>
        <div className="content-actions">
          <label className="button secondary compact" style={{ cursor: "pointer" }}>
            <Upload size={15} /> 导入文本
            <input type="file" onChange={handleUploadBook} style={{ display: "none" }} />
          </label>
          <button className="button primary" type="button" onClick={runDisassemble} disabled={!selectedBook || controller.operationsBusy}>
            <Sparkles size={15} /> 一键拆解
          </button>
        </div>
      </div>

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
                    <small style={{ fontSize: "12px", color: "var(--muted)" }}>{Object.values(book.paths).filter(Boolean).length > 1 ? "已有拆解结果" : "等待拆解"}</small>
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
                  <span className="eyebrow" style={{ fontSize: "12px", color: "var(--success)" }}>{analysisArtifacts.length > 1 ? "已有拆解结果" : "等待拆解"}</span>
                  <h2>{selectedBook.title}</h2>
                  <p style={{ fontSize: "12px", color: "var(--muted)" }}>{analysisArtifacts.length} 份项目资料可用</p>
                </div>
                <div style={{ display: "flex", gap: "8px" }}>
                  <button className="button secondary compact" type="button" onClick={openReport} disabled={!Object.values(selectedBook.paths).some(Boolean)}>
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
                      已生成 {analysisArtifacts.length} 份可用资料。选择上方标签查看文件位置，或从右侧选择资料生成迁移预览。
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
                        {artifact.id !== "source" && <button className="button primary compact" type="button" onClick={() => addMethodToPreview(artifact)}>提取写作方法</button>}
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

        {/* 右栏：应用到当前项目 */}
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
              disabled={!selectedBook || !primaryBookPath(selectedBook) || controller.operationsBusy}
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
          </section>

          <div className="disassembly-panel-divider" />
          <div className="detail-head">
            <span>应用到当前项目</span>
          </div>
          <p style={{ fontSize: "12px", color: "var(--muted)", lineHeight: "1.5", margin: "8px 0" }}>
            选择要参考的拆解资料，AI 会为当前项目生成规则迁移预览。
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: "8px", margin: "10px 0" }}>
            {analysisArtifacts.filter((artifact) => artifact.id !== "source").map((artifact) => (
              <label key={artifact.id} className="check-line" style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "12px" }}>
                <input type="checkbox" checked={selectedMethods.includes(artifact.id)} onChange={() => setSelectedMethods((current) => current.includes(artifact.id) ? current.filter((item) => item !== artifact.id) : [...current, artifact.id])} />
                <span>{artifact.label}</span>
              </label>
            ))}
            {!analysisArtifacts.some((artifact) => artifact.id !== "source") && <p className="panel-note">当前参考书还没有可迁移的拆解资料。</p>}
          </div>
          <label style={{ display: "block", marginTop: "12px" }}>
            <span style={{ fontSize: "12px", color: "var(--muted)", display: "block" }}>目标位置</span>
            <select
              value={methodTarget}
              onChange={(e) => setMethodTarget(e.target.value)}
              style={{ width: "100%", padding: "4px", fontSize: "12px", border: "1px solid var(--line)", borderRadius: "4px", marginTop: "4px" }}
            >
              <option value="style/narrative">风格与题材 / 题材规则</option>
              <option value="sources/rules">设定资料 / 规则集</option>
            </select>
          </label>

          <button className="button primary" style={{ width: "100%", minHeight: "32px", marginTop: "20px" }} type="button" onClick={generateMigrationPreview} disabled={!selectedBook || !selectedMethods.length || controller.operationsBusy}>
            <ArrowLeftRight size={14} /> 生成迁移预览
          </button>
          {controller.operationsMessage && (
            <p className="disassembly-action-status" role="status">{controller.operationsMessage}</p>
          )}
        </aside>
      </div>
    </div>
  );
}
