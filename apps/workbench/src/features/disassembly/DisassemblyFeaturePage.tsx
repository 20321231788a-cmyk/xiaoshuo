import type { TreeNode } from "@xiaoshuo/shared";
import { BookOpen, RefreshCw, Save, SlidersHorizontal, Trash2, Wand2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { DisassemblyBookSummary, WorkbenchController } from "../../hooks/useWorkbenchController.js";
import {
  type CrawlSourceOption,
  loadInitialCrawlSources,
  restoreDefaultCrawlSources,
  isHttpUrl,
  SELECTED_CRAWL_SOURCE_KEY,
  CRAWL_SOURCES_STORAGE_KEY
} from "../../lib/crawlSources.js";
import { AutoReviewGeneratedToggle, ProjectFileSelect } from "../workflow/WorkflowControls.js";

type DisassemblyUiState = {
  selectedBookId: string;
  fusionBookIds: string[];
  onSelectBook: (bookId: string) => void;
  onToggleFusionBook: (bookId: string) => void;
};

function disassemblyBookPrimaryPath(book: DisassemblyBookSummary | null): string {
  if (!book) {
    return "";
  }
  return book.paths.source || book.paths.detail_outline || book.paths.reverse_outline || book.paths.lore || "";
}

function disassemblyBookReadyForFusion(book: DisassemblyBookSummary | null): boolean {
  if (!book || book.legacy) {
    return false;
  }
  return Boolean(book.paths.lore || book.paths.reverse_outline || book.paths.detail_outline);
}

function disassemblyBookIsRawSource(book: DisassemblyBookSummary | null): boolean {
  if (!book || book.legacy) {
    return false;
  }
  return Boolean(book.paths.source) && !disassemblyBookReadyForFusion(book);
}

function flattenProjectFilePaths(nodes: TreeNode[] = []): string[] {
  const paths: string[] = [];
  for (const node of nodes) {
    if (node.kind === "file") {
      paths.push(node.path);
    }
    if (node.children?.length) {
      paths.push(...flattenProjectFilePaths(node.children));
    }
  }
  return paths;
}

export function DisassembleFeaturePage({ controller, disassemblyUi }: { controller: WorkbenchController; disassemblyUi: DisassemblyUiState }) {
  const [crawlQuery, setCrawlQuery] = useState("");
  const [sources, setSources] = useState<CrawlSourceOption[]>(() => loadInitialCrawlSources());
  const [selectedSourceId, setSelectedSourceId] = useState<string>(() => {
    if (typeof window === "undefined") return "bing";
    try {
      const storedId = window.localStorage.getItem(SELECTED_CRAWL_SOURCE_KEY);
      const initialList = loadInitialCrawlSources();
      if (storedId && initialList.some((item) => item.id === storedId)) {
        return storedId;
      }
      return initialList[0]?.id || "";
    } catch {
      return "bing";
    }
  });
  const [crawlSourceMessage, setCrawlSourceMessage] = useState("");
  const [crawlStartChapter, setCrawlStartChapter] = useState(1);
  const [crawlMaxChapters, setCrawlMaxChapters] = useState(30);
  const [crawlMinChars, setCrawlMinChars] = useState(60000);
  const [instruction, setInstruction] = useState("");
  const [fusionEnabled, setFusionEnabled] = useState(true);
  const [fusionPrompt, setFusionPrompt] = useState("请抽象融合所选拆书的核心设定、剧情骨架、人物驱动力与题材氛围，输出一个去同质化、可继续展开的原创候选方案。禁止复写原文句式、专有名词、可识别桥段和固定角色关系。");
  const [fusionGenreHint, setFusionGenreHint] = useState("");
  const [fusionOutputMode, setFusionOutputMode] = useState<"candidate" | "outline" | "setting">("candidate");
  const [expandedPanels, setExpandedPanels] = useState<Record<"disassemble" | "distill" | "fusion", boolean>>({
    disassemble: false,
    distill: false,
    fusion: false
  });
  const distillation = controller.styleDistillationProfile;
  const activeDocument = controller.openDocuments.find((document) => document.path === controller.activeDocumentPath) || null;
  const allBooks = controller.disassemblyBooks;
  const books = allBooks.filter((book) => !book.legacy);
  const fusionBooks = books.filter(disassemblyBookReadyForFusion);
  const selectedBook = books.find((book) => book.id === disassemblyUi.selectedBookId) || null;
  const selectedBookSourcePath = disassemblyBookPrimaryPath(selectedBook);
  const selectedFusionBooks = fusionBooks.filter((book) => disassemblyUi.fusionBookIds.includes(book.id));
  const genreCards = controller.snapshot?.projectChrome.libraries.filter((card) => card.group === "题材库") || [];
  const genreReady = genreCards.some((card) => card.exists);
  const distillationSourceTitle = selectedBook?.title || activeDocument?.title || "未选择源书";
  const distillationSourcePath = selectedBook ? selectedBookSourcePath : activeDocument?.path || "";
  const hasDistillationSource = Boolean(selectedBookSourcePath || activeDocument?.content || activeDocument?.path);
  const profilePreview = distillation?.profile_text ? distillation.profile_text.slice(0, 620) : "";

  async function archiveUploadedBook(file: File | null) {
    if (!file) {
      return;
    }
    const attachment = await controller.uploadWorkflowAttachment(file);
    if (!attachment) {
      return;
    }
    const title = file.name.replace(/\.[^.]+$/, "").trim() || file.name;
    const book = await controller.archiveDisassemblySource(attachment.id, title);
    if (book) {
      disassemblyUi.onSelectBook(book.id);
    }
  }

  function runDisassemble() {
    void controller.runWorkflowSkill("disassemble_book", {
      text: selectedBook ? "" : activeDocument?.content || "",
      source_path: selectedBookSourcePath || activeDocument?.path || "",
      source_book_id: selectedBook?.id || "",
      book_title: selectedBook?.title || activeDocument?.title || crawlQuery,
      instruction,
      write_result: true,
      attachment_ids: []
    } as any);
  }

  function runContinueDisassemble() {
    void controller.runWorkflowSkill("continue_disassemble", {
      text: selectedBook ? "" : activeDocument?.content || "",
      source_path: selectedBook?.paths.reverse_outline || selectedBookSourcePath || activeDocument?.path || "",
      source_book_id: selectedBook?.id || "",
      book_title: selectedBook?.title || activeDocument?.title || crawlQuery,
      instruction,
      write_result: true,
      attachment_ids: []
    } as any);
  }

  function runDistillation() {
    if (distillation && !window.confirm("当前项目已有蒸馏文风档案，确认替换为当前源书吗？")) {
      return;
    }

    void controller.runNuwaStyleDistillation({
      replace: Boolean(distillation),
      sourceBookId: selectedBook?.id || "",
      sourcePath: distillationSourcePath,
      bookTitle: selectedBook?.title || activeDocument?.title || "",
      text: selectedBook ? "" : activeDocument?.content || ""
    });
  }

  function runFusion() {
    void controller.runWorkflowSkill("book_fusion", {
      text: "",
      source_path: "",
      instruction: fusionPrompt.trim(),
      custom_prompt: fusionPrompt.trim(),
      genre_hint: fusionGenreHint,
      output_mode: fusionOutputMode,
      source_book_ids: selectedFusionBooks.map((book) => book.id),
      write_result: true,
      attachment_ids: []
    } as any);
  }

  function runNovelCrawl() {
    const query = crawlQuery.trim();
    let finalSource = "";
    let finalCustomUrl = "";

    if (isHttpUrl(query)) {
      finalSource = "custom";
      finalCustomUrl = query;
    } else {
      const selectedSource = sources.find((s) => s.id === selectedSourceId);
      if (!selectedSource) {
        setCrawlSourceMessage("请先恢复或添加爬取来源");
        return;
      }
      if (selectedSource.url) {
        finalSource = "custom";
        finalCustomUrl = selectedSource.url;
      } else {
        finalSource = selectedSource.id;
      }
    }

    void controller.runJob("novel_crawl", {
      query: isHttpUrl(query) ? "" : query,
      source: finalSource,
      custom_source_url: finalCustomUrl,
      start_chapter: crawlStartChapter,
      max_chapters: crawlMaxChapters,
      min_chars: crawlMinChars
    }, { activateTab: false });
  }

  function saveCustomCrawlSource() {
    const value = crawlQuery.trim();
    if (!isHttpUrl(value)) {
      setCrawlSourceMessage("请输入有效 URL");
      return;
    }
    const exists = sources.some((item) => item.url === value || item.id === value);
    if (exists) {
      setCrawlSourceMessage("来源已存在");
      return;
    }

    const newSource: CrawlSourceOption = {
      id: value,
      name: value,
      url: value,
      isCustom: true
    };
    const nextSources = [...sources, newSource];
    setSources(nextSources);
    setSelectedSourceId(value);
    setCrawlSourceMessage("来源已保存");
    try {
      window.localStorage.setItem(CRAWL_SOURCES_STORAGE_KEY, JSON.stringify(nextSources));
      window.localStorage.setItem(SELECTED_CRAWL_SOURCE_KEY, value);
    } catch {
      // Local storage may be unavailable
    }
  }

  function deleteCrawlSource(idToDelete: string) {
    const nextSources = sources.filter((item) => item.id !== idToDelete);
    setSources(nextSources);
    try {
      window.localStorage.setItem(CRAWL_SOURCES_STORAGE_KEY, JSON.stringify(nextSources));
    } catch {}

    if (selectedSourceId === idToDelete) {
      const nextSelected = nextSources[0]?.id || "";
      setSelectedSourceId(nextSelected);
      try {
        window.localStorage.setItem(SELECTED_CRAWL_SOURCE_KEY, nextSelected);
      } catch {}
    }
  }

  function handleRestoreDefaults() {
    const nextSources = restoreDefaultCrawlSources(sources);
    setSources(nextSources);
    try {
      window.localStorage.setItem(CRAWL_SOURCES_STORAGE_KEY, JSON.stringify(nextSources));
    } catch {}
    if (!nextSources.some((item) => item.id === selectedSourceId)) {
      const nextSelected = nextSources[0]?.id || "";
      setSelectedSourceId(nextSelected);
      try {
        window.localStorage.setItem(SELECTED_CRAWL_SOURCE_KEY, nextSelected);
      } catch {}
    }
    setCrawlSourceMessage("已恢复默认来源");
  }

  const canRunNovelCrawl = isHttpUrl(crawlQuery.trim()) || (Boolean(crawlQuery.trim()) && Boolean(selectedSourceId));
  const togglePanel = (panel: "disassemble" | "distill" | "fusion") => {
    setExpandedPanels((current) => ({ ...current, [panel]: !current[panel] }));
  };

  return (
    <section className="xw-feature-page">
      <div className="xw-disassemble-accordion">
        <section className={`xw-disassemble-strip ${expandedPanels.disassemble ? "open" : ""}`}>
          <div className="xw-disassemble-strip-head" role="button" tabIndex={0} onClick={() => togglePanel("disassemble")} onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              togglePanel("disassemble");
            }
          }} aria-expanded={expandedPanels.disassemble}>
            <span className="xw-disassemble-strip-icon"><BookOpen size={16} /></span>
            <div>
              <strong>拆书</strong>
              <span>联网爬取、上传原文，或按当前文档生成拆书结果。</span>
            </div>
            <small>{expandedPanels.disassemble ? "收起" : "展开"}</small>
          </div>
          {expandedPanels.disassemble && (
            <div className="xw-disassemble-strip-body">
              <div className="xw-feature-toolbar disassemble-source">
                <div className="xw-crawl-source-input">
                  <input
                    value={crawlQuery}
                    onChange={(event) => {
                      setCrawlQuery(event.target.value);
                      setCrawlSourceMessage("");
                    }}
                    placeholder="输入书名或目录 URL"
                  />
                  <div className="xw-crawl-source-tools">
                    <select
                      value={selectedSourceId}
                      onChange={(event) => {
                        const val = event.target.value;
                        setSelectedSourceId(val);
                        try {
                          window.localStorage.setItem(SELECTED_CRAWL_SOURCE_KEY, val);
                        } catch {}
                      }}
                      disabled={sources.length === 0}
                      style={{ maxWidth: "160px", padding: "2px 6px", borderRadius: "4px", border: "1px solid var(--border-color, #e5e7eb)" }}
                    >
                      {sources.map((src) => (
                        <option key={src.id} value={src.id}>
                          {src.name}
                        </option>
                      ))}
                      {sources.length === 0 && <option value="">(无可用来源)</option>}
                    </select>

                    {selectedSourceId && (
                      <button
                        type="button"
                        className="xw-danger-button compact icon-only"
                        onClick={() => deleteCrawlSource(selectedSourceId)}
                        title="删除当前来源"
                      >
                        <Trash2 size={14} />
                      </button>
                    )}

                    <button
                      type="button"
                      className="xw-secondary-button compact"
                      onClick={handleRestoreDefaults}
                      title="恢复默认来源"
                    >
                      恢复默认
                    </button>

                    <button
                      type="button"
                      className="xw-secondary-button compact"
                      onClick={saveCustomCrawlSource}
                      disabled={!isHttpUrl(crawlQuery)}
                      title="将输入的目录 URL 保存为自定义来源"
                    >
                      <Save size={14} />
                      <span>保存来源</span>
                    </button>
                    {crawlSourceMessage && <small style={{ color: "var(--text-muted, #999)", marginLeft: "5px" }}>{crawlSourceMessage}</small>}
                  </div>
                  {sources.length === 0 && !isHttpUrl(crawlQuery) && (
                    <p className="xw-crawl-warning-tip" style={{ color: "var(--red, #ef4444)", fontSize: "12px", marginTop: "4px", width: "100%" }}>
                      请先恢复默认来源或添加/输入自定义目录 URL。
                    </p>
                  )}
                </div>
                <button
                  className="xw-primary-button compact"
                  onClick={runNovelCrawl}
                  disabled={controller.operationsBusy || !canRunNovelCrawl}
                >
                  {controller.operationsBusy ? "启动中" : "联网爬取"}
                </button>
                <label className="xw-upload-button compact">
                  上传拆书
                  <input
                    type="file"
                    accept=".txt,.md,.markdown,.json,.csv,.doc,.docx,.pdf"
                    onChange={(event) => {
                      const file = event.target.files?.[0] || null;
                      event.currentTarget.value = "";
                      void archiveUploadedBook(file);
                    }}
                  />
                </label>
                <button className="xw-secondary-button compact" onClick={() => void controller.refreshDisassemblyLibrary()} disabled={controller.disassemblyLibraryBusy}>
                  <RefreshCw size={14} className={controller.disassemblyLibraryBusy ? "spin" : ""} />
                  <span>刷新书库</span>
                </button>
              </div>

              <div className="xw-operation-grid disassemble-meta">
                <label><span>起始章节</span><input type="number" min={1} value={crawlStartChapter} onChange={(event) => setCrawlStartChapter(Math.max(1, Number(event.target.value) || 1))} /></label>
                <label><span>基础章数</span><input type="number" min={1} max={200} value={crawlMaxChapters} onChange={(event) => setCrawlMaxChapters(Math.max(1, Number(event.target.value) || 1))} /></label>
                <label><span>最少字数</span><input type="number" min={0} step={1000} value={crawlMinChars} onChange={(event) => setCrawlMinChars(Math.max(0, Number(event.target.value) || 0))} /></label>
                <label><span>当前文档</span><input value={activeDocument?.title || "未打开文档"} readOnly /></label>
                <label><span>当前源书</span><input value={selectedBook?.title || "尚未选择拆书库书籍"} readOnly /></label>
              </div>

              <textarea value={instruction} onChange={(event) => setInstruction(event.target.value)} placeholder="拆书要求，例如重点提取叙事节奏、人物关系、反转与伏笔。" />

              <div className="xw-operation-actions">
                <button className="xw-primary-button" onClick={runDisassemble} disabled={controller.operationsBusy}>一键拆书</button>
                <button className="xw-secondary-button" onClick={runContinueDisassemble} disabled={controller.operationsBusy}>继续拆细纲</button>
              </div>
            </div>
          )}
        </section>

        <section className={`xw-disassemble-strip ${expandedPanels.distill ? "open" : ""}`}>
          <div className="xw-disassemble-strip-head" role="button" tabIndex={0} onClick={() => togglePanel("distill")} onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              togglePanel("distill");
            }
          }} aria-expanded={expandedPanels.distill}>
            <span className="xw-disassemble-strip-icon"><Wand2 size={16} /></span>
            <div>
              <strong>蒸馏</strong>
              <span>提取一本小说的写作风格、描写模式、对白习惯和叙事节奏。</span>
            </div>
            <span className={distillation?.enabled ? "xw-status-ready" : "xw-status-warn"}>{distillation?.enabled ? "文风使用中" : "未启用"}</span>
            <small>{expandedPanels.distill ? "收起" : "展开"}</small>
          </div>
          {expandedPanels.distill && (
            <div className="xw-disassemble-strip-body">
              <div className="xw-disassembly-note">
                <strong>{distillationSourceTitle}</strong>
                <span>{selectedBook ? selectedBook.source_summary || selectedBookSourcePath || "当前源书" : activeDocument ? "将使用当前打开文档蒸馏" : "请先在拆书库中选择一本书，或打开一个文档。"}</span>
              </div>

              <div className="xw-operation-grid two">
                <label><span>蒸馏来源</span><input value={selectedBook ? "拆书库书籍" : activeDocument ? "当前文档" : "未选择"} readOnly /></label>
                <label><span>来源路径</span><input value={distillationSourcePath || "无可读取路径"} readOnly /></label>
              </div>

              {distillation ? (
                <article className="xw-distill-profile">
                  <div className="xw-feature-card-head">
                    <strong>当前档案：{distillation.book_title || "未命名书籍"}</strong>
                    <span>{distillation.distilled_at || "未记录时间"}</span>
                  </div>
                  <p>{distillation.source_summary || distillation.source_path || "已保存项目级文风档案。"}</p>
                  {profilePreview && <pre>{profilePreview}</pre>}
                </article>
              ) : (
                <p className="xw-feature-empty">当前项目尚未蒸馏书籍。一个项目只保留一本蒸馏文风档案。</p>
              )}

              <div className="xw-operation-actions">
                <button className="xw-primary-button" onClick={runDistillation} disabled={controller.operationsBusy || !hasDistillationSource}>
                  {distillation ? "替换蒸馏" : "开始蒸馏"}
                </button>
                <button className="xw-secondary-button" onClick={() => void controller.toggleNuwaStyleDistillation()} disabled={controller.operationsBusy || !distillation}>
                  {distillation?.enabled ? "停用文风" : "启用文风"}
                </button>
                <button className="xw-danger-button" onClick={() => void controller.deleteNuwaStyleDistillation()} disabled={controller.operationsBusy || !distillation}>
                  删除档案
                </button>
              </div>
            </div>
          )}
        </section>

        <section className={`xw-disassemble-strip ${expandedPanels.fusion ? "open" : ""}`}>
          <div className="xw-disassemble-strip-head" role="button" tabIndex={0} onClick={() => togglePanel("fusion")} onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              togglePanel("fusion");
            }
          }} aria-expanded={expandedPanels.fusion}>
            <span className="xw-disassemble-strip-icon"><SlidersHorizontal size={16} /></span>
            <div>
              <strong>融梗</strong>
              <span>至少选择 3 本已拆书籍，再把题材库和自定义提示词一起压进去。</span>
            </div>
            <label className="xw-check-row fusion-switch" onClick={(event) => event.stopPropagation()}>
              <input type="checkbox" checked={fusionEnabled} onChange={() => setFusionEnabled((value) => !value)} />
              <span>开启</span>
            </label>
            <small>{expandedPanels.fusion ? "收起" : "展开"}</small>
          </div>
          {expandedPanels.fusion && (
            <div className="xw-disassemble-strip-body">
              <div className="xw-operation-grid two">
                <label><span>输出模式</span>
                  <select value={fusionOutputMode} onChange={(event) => setFusionOutputMode(event.target.value as typeof fusionOutputMode)} disabled={!fusionEnabled}>
                    <option value="candidate">候选方案</option>
                    <option value="outline">大纲候选</option>
                    <option value="setting">设定候选</option>
                  </select>
                </label>
                <label><span>题材补充</span><input value={fusionGenreHint} onChange={(event) => setFusionGenreHint(event.target.value)} placeholder="可补充当前题材、禁区或风格方向" disabled={!fusionEnabled} /></label>
              </div>

              <textarea value={fusionPrompt} onChange={(event) => setFusionPrompt(event.target.value)} placeholder="可编辑融梗提示词，系统会自动加入当前题材库。" />

              <div className="xw-disassembly-selection">
                <span>已选 {selectedFusionBooks.length} / 3+</span>
                <div className="xw-disassembly-chip-row">
                  {selectedFusionBooks.length ? selectedFusionBooks.map((book) => (
                    <button key={book.id} className="xw-disassembly-chip active" type="button" onClick={() => disassemblyUi.onToggleFusionBook(book.id)}>
                      {book.title}
                    </button>
                  )) : <span className="xw-feature-empty">先在拆书库中勾选至少 3 个已拆书文件夹。</span>}
                </div>
              </div>

              <div className="xw-operation-actions">
                <button
                  className="xw-primary-button"
                  onClick={runFusion}
                  disabled={!fusionEnabled || selectedFusionBooks.length < 3 || controller.operationsBusy}
                >
                  融梗
                </button>
                <button className="xw-secondary-button" onClick={() => void controller.refreshDisassemblyLibrary()} disabled={controller.disassemblyLibraryBusy}>
                  <RefreshCw size={14} className={controller.disassemblyLibraryBusy ? "spin" : ""} />
                  <span>重载书库</span>
                </button>
              </div>

              <div className="xw-disassembly-note">
                <strong>{selectedBook ? selectedBook.title : activeDocument?.title || "当前文档"}</strong>
                <span>{selectedBook ? selectedBook.source_summary || selectedBook.source_path || "这本书会作为当前拆书源。" : "未选中拆书库书籍时，按当前打开文档继续。"}</span>
              </div>
            </div>
          )}
        </section>
      </div>
    </section>
  );
}
