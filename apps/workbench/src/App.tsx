import type {
  AiConfigProfile,
  AppConfig,
  ConversationSummary,
  DesktopUpdateStatus,
  JobInfo,
  SkillDefinition,
  TreeNode,
  WebsiteAiRechargeOption,
  WebsiteAiRechargeOrder
} from "@xiaoshuo/shared";
import {
  ArchiveRestore,
  Bot,
  BookOpen,
  Cable,
  ChevronDown,
  ChevronUp,
  Cloud,
  Copy,
  Download,
  Eye,
  EyeOff,
  ExternalLink,
  FilePenLine,
  FilePlus2,
  FileText,
  Folder,
  FolderKanban,
  FolderOpen,
  FolderPlus,
  Gift,
  History,
  Library,
  Link,
  MessageSquarePlus,
  MessageSquareText,
  Pin,
  RefreshCw,
  Save,
  ScanSearch,
  Send,
  Settings,
  Shield,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Square,
  Trash2,
  Upload,
  Wand2,
  WalletCards,
  Workflow,
  X
} from "lucide-react";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import type { CSSProperties, FormEvent as ReactFormEvent, KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from "react";
import type { DisassemblyBookSummary, OpenDocumentTab, WorkbenchController } from "./hooks/useWorkbenchController.js";
import { useWorkbenchController } from "./hooks/useWorkbenchController.js";
import { readWorkbenchRuntime } from "./lib/runtime.js";
import {
  describeGeneratedSaveAction,
  extractPathsFromUnknownResult,
  describeJobKind
} from "./lib/workflow.js";
import {
  CrawlSourceOption,
  loadInitialCrawlSources,
  restoreDefaultCrawlSources,
  isHttpUrl,
  SELECTED_CRAWL_SOURCE_KEY,
  CRAWL_SOURCES_STORAGE_KEY
} from "./lib/crawlSources.js";

const TerminalView = lazy(() => import("./views/TerminalView.js").then((module) => ({ default: module.TerminalView })));

const runtime = readWorkbenchRuntime();
const DEFAULT_RIGHT_WIDTH = 440;
const APP_WINDOW_TITLE = "ArcWriter 0.2.7";
const WEBSITE_HOME_URL = "https://matian.online/";
const WEBSITE_REGISTER_URL = "https://matian.online/?page=api-relay&auth=register";

const punctuationMarks = ["“”", "‘’", "——", "……", "（）", "《》", "，", "。", "？", "！"];

type CenterFeature =
  | "editor"
  | "conversations"
  | "timeline"
  | "settings-set"
  | "style-library"
  | "theme-library"
  | "batch"
  | "crawl"
  | "card_draw"
  | "ledger"
  | "revision"
  | "skills"
  | "consistency"
  | "settings"
  | "terminal";

const pageTabs: Array<{ key: CenterFeature; label: string }> = [
  { key: "editor", label: "文档" },
  { key: "conversations", label: "AI 对话" },
  { key: "timeline", label: "时间线" },
  { key: "settings-set", label: "设定集" },
  { key: "style-library", label: "风格库" },
  { key: "theme-library", label: "题材库" }
];

const railModes = [
  { key: "ai", label: "AI", icon: Bot, tab: "editor", feature: "editor" },
  { key: "batch", label: "批量", icon: Wand2, tab: "operations", feature: "batch" },
  { key: "crawl", label: "拆书", icon: BookOpen, tab: "operations", feature: "crawl" },
  { key: "card_draw", label: "抽卡", icon: Sparkles, tab: "operations", feature: "card_draw" },
  { key: "ledger", label: "伏笔", icon: Pin, tab: "overview", feature: "ledger" },
  { key: "revision", label: "日志", icon: History, tab: "overview", feature: "revision" },
  { key: "skills", label: "技能", icon: Library, tab: "operations", feature: "skills" },
  { key: "consistency", label: "一致性", icon: ScanSearch, tab: "operations", feature: "consistency" },
  { key: "settings", label: "设置", icon: Settings, tab: "config", feature: "settings" }
] as const;

type RailMode = (typeof railModes)[number]["key"];

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

export function App() {
  const controller = useWorkbenchController(runtime);
  const [rightMode, setRightMode] = useState<RailMode>("ai");
  const [centerFeature, setCenterFeature] = useState<CenterFeature>("editor");
  const [rightWidth, setRightWidth] = useState(DEFAULT_RIGHT_WIDTH);
  const [selectedDisassemblyBookId, setSelectedDisassemblyBookId] = useState("");
  const [fusionBookIds, setFusionBookIds] = useState<string[]>([]);
  const [tutorialOpen, setTutorialOpen] = useState(false);
  const [findRequestTick, setFindRequestTick] = useState(0);
  const [leftSidebarTab, setLeftSidebarTab] = useState<"project" | "disassembly">("project");
  const onboardingRef = useRef(false);

  useEffect(() => {
    if (rightMode === "crawl" || centerFeature === "crawl") {
      setLeftSidebarTab("disassembly");
    }
  }, [rightMode, centerFeature]);

  useEffect(() => {
    document.title = APP_WINDOW_TITLE;
  }, []);

  useEffect(() => {
    const unsubscribeTutorial = window.xiaoshuoDesktop?.onOpenTutorial?.(() => setTutorialOpen(true));
    const unsubscribeRefresh = window.xiaoshuoDesktop?.onRequestRefresh?.(() => {
      void controller.refreshProjectWorkspace();
    });
    const unsubscribeSave = window.xiaoshuoDesktop?.onRequestSave?.(() => {
      void controller.saveActiveDocument();
    });
    const unsubscribeFind = window.xiaoshuoDesktop?.onRequestFind?.(() => {
      setCenterFeature("editor");
      setFindRequestTick((value) => value + 1);
    });
    return () => {
      unsubscribeTutorial?.();
      unsubscribeRefresh?.();
      unsubscribeSave?.();
      unsubscribeFind?.();
    };
  }, [controller]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) {
        return;
      }
      const key = event.key.toLowerCase();
      if (key === "s") {
        event.preventDefault();
        void controller.saveActiveDocument();
        return;
      }
      if (key === "f") {
        event.preventDefault();
        setCenterFeature("editor");
        setFindRequestTick((value) => value + 1);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [controller]);

  useEffect(() => {
    if (controller.snapshot?.currentProject.path) {
      void controller.refreshDisassemblyLibrary();
    }
  }, [controller.snapshot?.currentProject.path]);

  useEffect(() => {
    if (onboardingRef.current || !controller.configDraft || !controller.snapshot) {
      return;
    }
    onboardingRef.current = true;
    const localState = controller.snapshot.localState;
    const hasRecentProjects = Boolean(localState?.recent_projects?.length);
    if (hasUsableAiConfig(controller.configDraft)) {
      return;
    }
    if (hasRecentProjects || controller.snapshot.currentProject.path) {
      return;
    }
    setRightMode("settings");
    setCenterFeature("settings");
    controller.setActiveTab("config");
    if (controller.configDraft.ai_config_mode !== "website") {
      controller.patchConfig({ ai_config_mode: "website" });
    }
  }, [controller]);

  useEffect(() => {
    const books = controller.disassemblyBooks.filter((book) => !book.legacy);
    const ids = new Set(books.map((book) => book.id));
    const fusionIds = new Set(books.filter(disassemblyBookReadyForFusion).map((book) => book.id));
    setSelectedDisassemblyBookId((current) => {
      if (!books.length) {
        return "";
      }
      return current && ids.has(current) ? current : books[0]?.id || "";
    });
    setFusionBookIds((current) => current.filter((id) => fusionIds.has(id)));
  }, [controller.disassemblyBooks]);

  function toggleFusionBook(bookId: string) {
    setFusionBookIds((current) => (current.includes(bookId) ? current.filter((id) => id !== bookId) : [...current, bookId]));
  }

  function selectCenterFeature(feature: CenterFeature) {
    setCenterFeature(feature);
    if (feature === "editor" || feature === "conversations" || feature === "terminal") {
      controller.setActiveTab(feature);
      return;
    }
    if (feature === "settings") {
      controller.setActiveTab("config");
      return;
    }
    if (feature === "timeline" || feature === "ledger" || feature === "revision") {
      controller.setActiveTab("overview");
      return;
    }
    controller.setActiveTab("operations");
  }

  function selectRightMode(mode: RailMode) {
    setRightMode(mode);
    const nextMode = railModes.find((item) => item.key === mode);
    if (nextMode) {
      selectCenterFeature(nextMode.feature);
    }
  }

  const disassemblyUi: DisassemblyUiState = {
    selectedBookId: selectedDisassemblyBookId,
    fusionBookIds,
    onSelectBook: setSelectedDisassemblyBookId,
    onToggleFusionBook: toggleFusionBook
  };

  return (
    <div className="shell xw-shell">
      <main className="xw-workspace-shell" style={{ "--xw-right-col": `${rightWidth}px` } as CSSProperties}>
        <ProjectSidebar
          controller={controller}
          disassemblyUi={disassemblyUi}
          leftSidebarTab={leftSidebarTab}
          onSidebarTabChange={setLeftSidebarTab}
          onOpenDocument={async (path) => {
            const opened = await controller.openDocument(path);
            if (opened) {
              selectCenterFeature("editor");
            }
          }}
          onOpenTimeline={() => selectCenterFeature("timeline")}
        />
        <section className="xw-center surface">
          {controller.status === "loading" && <LoadingState />}
          {controller.status === "error" && <ErrorState message={controller.error} />}
          {controller.status === "ready" && controller.snapshot && controller.configDraft && (
            <CenterWorkspace
              controller={controller}
              disassemblyUi={disassemblyUi}
              feature={centerFeature}
              findRequestTick={findRequestTick}
              onSelectFeature={selectCenterFeature}
              onSelectRightMode={selectRightMode}
            />
          )}
        </section>
        <RightRailSplitter
          onReset={() => setRightWidth(DEFAULT_RIGHT_WIDTH)}
          onDrag={(clientX) => {
            const maxWidth = Math.min(620, Math.max(360, window.innerWidth - 820));
            const next = Math.min(maxWidth, Math.max(340, window.innerWidth - clientX - 14));
            setRightWidth(next);
          }}
        />
        <AssistantRail controller={controller} mode={rightMode} onModeChange={selectRightMode} onSelectFeature={selectCenterFeature} />
      </main>
      {tutorialOpen && <WebsiteTutorialDialog onClose={() => setTutorialOpen(false)} />}
    </div>
  );
}

function hasUsableAiConfig(config: AppConfig): boolean {
  const manualProfile = config.manual_profile;
  const websiteProfile = config.website_profile;
  const legacyManualReady = Boolean(config.api_key && config.base_url && config.model);
  const manualReady = Boolean(manualProfile?.api_key && manualProfile?.base_url && manualProfile?.model);
  const websiteReady = Boolean(websiteProfile?.api_key && websiteProfile?.model);
  return legacyManualReady || manualReady || websiteReady;
}

function WebsiteTutorialDialog({ onClose }: { onClose: () => void }) {
  return (
    <div className="xw-website-modal-backdrop" onClick={onClose}>
      <section className="xw-tutorial-modal" onClick={(event) => event.stopPropagation()} aria-modal="true" role="dialog" aria-label="网站使用教程">
        <div className="xw-tutorial-head">
          <div>
            <strong>网站使用教程</strong>
            <span>注册账号、接入模型、充值兑换和授权状态都从这里开始。</span>
          </div>
          <button className="xw-secondary-button compact" type="button" onClick={onClose} aria-label="关闭教程">
            <X size={15} />
          </button>
        </div>

        <div className="xw-tutorial-actions">
          <a className="xw-primary-button compact" href={WEBSITE_REGISTER_URL} target="_blank" rel="noreferrer">
            <ExternalLink size={14} />
            注册账号
          </a>
          <a className="xw-secondary-button compact" href={WEBSITE_HOME_URL} target="_blank" rel="noreferrer">
            <ExternalLink size={14} />
            前往网站
          </a>
        </div>

        <div className="xw-tutorial-list">
          <article>
            <strong>1. 注册网站账号</strong>
            <p>点击“注册账号”，使用 QQ 邮箱获取验证码，设置密码后完成注册。注册完成后回到软件的“设置 - 网站配置”。</p>
          </article>
          <article>
            <strong>2. 登录网站配置</strong>
            <p>在软件里填写 QQ 邮箱和密码，点击“登录网站”。登录后会读取账号状态、余额、并发限制和可用模型列表。</p>
          </article>
          <article>
            <strong>3. 选择模型并应用</strong>
            <p>在“网站模型”中选择语言模型，按需要调整 temperature 和 top_p，然后点击“应用网站配置”。软件会隐藏写入中转连接信息，不在界面显示 URL、Key 或 token。</p>
          </article>
          <article>
            <strong>4. 充值与兑换</strong>
            <p>登录后可以在网站账号区点击“充值”选择档位，也可以点击“兑换”输入兑换码。支付或兑换成功后刷新网站状态即可看到余额变化。</p>
          </article>
          <article>
            <strong>5. 授权与使用</strong>
            <p>授权绑定网站账号。更换设备后，登录同一网站账号并应用网站配置，即可继续校验授权并使用写作、拆书、批量生成等功能。</p>
          </article>
          <article>
            <strong>6. 常见处理</strong>
            <p>模型列表为空时先刷新账号；余额不足时充值或兑换；登录失败时确认邮箱、密码和验证码注册状态；仍不可用时前往网站检查账号状态。</p>
          </article>
        </div>
      </section>
    </div>
  );
}

function RightRailSplitter({ onDrag, onReset }: { onDrag: (clientX: number) => void; onReset: () => void }) {
  function handleMouseDown(event: ReactMouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    const handleMove = (moveEvent: MouseEvent) => onDrag(moveEvent.clientX);
    const handleUp = () => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
    };
    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
  }

  return (
    <button className="xw-rail-splitter" aria-label="调整右侧助手宽度" onMouseDown={handleMouseDown} onDoubleClick={onReset}>
      <span />
    </button>
  );
}

function DisassemblyLibraryTree({
  controller,
  disassemblyUi,
  onOpenDocument
}: {
  controller: WorkbenchController;
  disassemblyUi: DisassemblyUiState;
  onOpenDocument: (path: string) => void | Promise<void>;
}) {
  const books = controller.disassemblyBooks.filter((book) => !book.legacy);
  const legacyBooks = controller.disassemblyBooks.filter((book) => book.legacy);
  const selectedBook = books.find((book) => book.id === disassemblyUi.selectedBookId) || null;

  function runTreeDistillation(book: DisassemblyBookSummary) {
    if (controller.styleDistillationProfile && !window.confirm("当前项目已有蒸馏文风档案，确认替换为当前原文吗？")) {
      return;
    }
    void controller.runNuwaStyleDistillation({
      replace: Boolean(controller.styleDistillationProfile),
      sourceBookId: book.id,
      sourcePath: disassemblyBookPrimaryPath(book),
      bookTitle: book.title,
      text: ""
    });
  }

  return (
    <>
      {books.length ? (
        books.map((book) => {
          const active = book.id === selectedBook?.id;
          const fused = disassemblyUi.fusionBookIds.includes(book.id);
          const readyForFusion = disassemblyBookReadyForFusion(book);
          const rawSource = disassemblyBookIsRawSource(book);
          return (
            <article key={book.id} className={`xw-disassembly-tree-item ${active ? "active" : ""}`} style={{ marginBottom: "6px" }}>
              <button 
                className="xw-disassembly-tree-main" 
                onClick={() => disassemblyUi.onSelectBook(book.id)} 
                type="button"
                style={{ width: "100%", padding: 0 }}
              >
                <div style={{ display: "grid", textAlign: "left" }}>
                  <strong style={{ fontSize: "13px", fontWeight: "bold" }}>{book.title}</strong>
                  <span style={{ fontSize: "11px", color: "var(--xw-muted)" }}>
                    {book.source_summary || (readyForFusion ? "已拆书文件夹" : rawSource ? "原文文件夹" : book.origin || "拆书库书籍")}
                  </span>
                </div>
                <small style={{ fontSize: "11px", color: active ? "var(--xw-primary)" : "var(--xw-muted)", marginTop: "2px" }}>
                  {active ? "当前源书" : readyForFusion ? "已拆书" : `${book.chars} 字`}
                </small>
              </button>
              <div className="xw-disassembly-tree-actions" style={{ display: "flex", gap: "6px", marginTop: "6px" }}>
                {readyForFusion ? (
                  <button className={`xw-secondary-button compact ${fused ? "active" : ""}`} onClick={() => disassemblyUi.onToggleFusionBook(book.id)} type="button">
                    {fused ? "已融" : "融梗"}
                  </button>
                ) : rawSource ? (
                  <button className="xw-secondary-button compact" onClick={() => runTreeDistillation(book)} type="button" disabled={controller.operationsBusy}>
                    蒸馏
                  </button>
                ) : null}
                {disassemblyBookPrimaryPath(book) && (
                  <button className="xw-secondary-button compact icon-only" onClick={() => void onOpenDocument(disassemblyBookPrimaryPath(book))} type="button" title="打开源文件">
                    <FileText size={13} />
                  </button>
                )}
              </div>
            </article>
          );
        })
      ) : (
        <p className="xw-empty">先联网爬取、上传拆书或执行一键拆书，这里会自动出现拆书库。</p>
      )}

      {!!legacyBooks.length && (
        <details className="xw-disassembly-tree-legacy" style={{ marginTop: "12px" }}>
          <summary style={{ fontSize: "12px", cursor: "pointer", color: "var(--xw-muted)" }}>历史拆书产物</summary>
          <div className="xw-disassembly-tree-scroll legacy" style={{ display: "grid", gap: "6px", marginTop: "6px" }}>
            {legacyBooks.map((book) => (
              <article key={book.id} className="xw-disassembly-tree-item legacy" style={{ padding: "6px 8px" }}>
                <div className="xw-disassembly-tree-main static" style={{ display: "grid", textAlign: "left" }}>
                  <div>
                    <strong style={{ fontSize: "12px" }}>{book.title}</strong>
                    <span style={{ fontSize: "10px", color: "var(--xw-muted)" }}>{book.source_summary || "历史拆书产物"}</span>
                  </div>
                </div>
                <div className="xw-disassembly-tree-actions" style={{ display: "flex", gap: "4px", marginTop: "4px" }}>
                  {book.paths.source && (
                    <button className="xw-secondary-button compact" onClick={() => void onOpenDocument(book.paths.source!)} type="button">
                      原文
                    </button>
                  )}
                  {book.paths.detail_outline && (
                    <button className="xw-secondary-button compact" onClick={() => void onOpenDocument(book.paths.detail_outline!)} type="button">
                      细纲
                    </button>
                  )}
                </div>
              </article>
            ))}
          </div>
        </details>
      )}
    </>
  );
}

function ProjectSidebar({
  controller,
  disassemblyUi,
  leftSidebarTab,
  onSidebarTabChange,
  onOpenDocument,
  onOpenTimeline
}: {
  controller: WorkbenchController;
  disassemblyUi: DisassemblyUiState;
  leftSidebarTab: "project" | "disassembly";
  onSidebarTabChange: (tab: "project" | "disassembly") => void;
  onOpenDocument: (path: string) => void | Promise<void>;
  onOpenTimeline: () => void;
}) {
  const snapshot = controller.snapshot;
  const project = snapshot?.currentProject;
  const projectName = project?.name || "未打开项目";
  const projectPath = project?.path || "先打开一个小说目录";
  const [renamingProject, setRenamingProject] = useState(false);
  const [cloudPanelOpen, setCloudPanelOpen] = useState(false);
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const cancelRenameRef = useRef(false);
  const cloudSlots = [1, 2, 3].map((slotId) => ({
    slotId,
    slot: controller.cloudProjectSlots.find((item) => item.slot_id === slotId) || null
  }));

  useEffect(() => {
    if (!renamingProject) {
      controller.setProjectNameInput(project?.name || "");
    }
  }, [project?.name, renamingProject]);

  useEffect(() => {
    if (renamingProject) {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    }
  }, [renamingProject]);

  function beginRenameProject(event: ReactMouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    if (!project?.path || controller.projectBusy) {
      return;
    }
    controller.setProjectNameInput(project.name);
    setRenamingProject(true);
  }

  function cancelRenameProject() {
    cancelRenameRef.current = true;
    controller.setProjectNameInput(project?.name || "");
    setRenamingProject(false);
  }

  function commitRenameProject() {
    if (!renamingProject) {
      return;
    }
    setRenamingProject(false);
    void controller.renameCurrentProject();
  }

  function handleRenameKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      commitRenameProject();
    }
    if (event.key === "Escape") {
      event.preventDefault();
      cancelRenameProject();
    }
  }

  return (
    <aside className="xw-left surface">
      <div className="xw-brand">
        <Sparkles size={24} />
        <strong>ArcWriter</strong>
      </div>

      <section className="xw-project-card">
        <div className="xw-card-head">
          <span>项目</span>
          <small>双击名称可重命名</small>
        </div>
        <div className="xw-project-picker">
          <button className="xw-project-open-icon" onClick={() => controller.pickAndOpenProject("open")} disabled={controller.projectBusy} aria-label="打开项目">
            <FolderOpen size={20} />
          </button>
          <div>
            {renamingProject ? (
              <input
                ref={renameInputRef}
                className="xw-project-name-input"
                value={controller.projectNameInput}
                onChange={(event) => controller.setProjectNameInput(event.target.value)}
                onBlur={() => {
                  if (cancelRenameRef.current) {
                    cancelRenameRef.current = false;
                    return;
                  }
                  commitRenameProject();
                }}
                onKeyDown={handleRenameKeyDown}
                disabled={controller.projectBusy}
                aria-label="项目显示名"
              />
            ) : (
              <button className="xw-project-name-button" onDoubleClick={beginRenameProject} disabled={controller.projectBusy}>
                <strong>{projectName}</strong>
              </button>
            )}
            <button className="xw-project-path-button" title={projectPath} onClick={() => controller.pickAndOpenProject("open")} disabled={controller.projectBusy}>
              {projectPath}
            </button>
          </div>
        </div>
        <div className="xw-project-actions">
          <button className="xw-primary-button" onClick={() => controller.pickAndOpenProject("create")} disabled={controller.projectBusy}>
            <FolderPlus size={15} />
            <span>新建项目</span>
          </button>
          <button className="xw-secondary-button" onClick={() => controller.pickAndOpenProject("open")} disabled={controller.projectBusy}>
            <FolderOpen size={15} />
            <span>打开项目</span>
          </button>
          <button className="xw-secondary-button" onClick={controller.rebuildVectorIndex} disabled={controller.projectBusy || !project?.path}>
            <Shield size={15} />
            <span>补全索引</span>
          </button>
          <button className="xw-secondary-button" onClick={controller.refreshProjectWorkspace} disabled={controller.projectBusy}>
            <RefreshCw size={15} className={controller.projectBusy ? "spin" : ""} />
            <span>刷新项目</span>
          </button>
          <div className={`xw-cloud-project-strip ${cloudPanelOpen ? "open" : ""}`}>
            <button
              className="xw-cloud-project-strip-head"
              onClick={() => {
                setCloudPanelOpen((value) => !value);
                if (!cloudPanelOpen) {
                  void controller.refreshCloudProjects({ silent: true });
                }
              }}
              type="button"
            >
              <Cloud size={15} />
              <strong>上传/同步项目</strong>
              <small>{controller.cloudProjectSlots.length}/3</small>
              {cloudPanelOpen ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
            </button>
            {cloudPanelOpen && (
              <div className="xw-cloud-project-panel">
                <div className="xw-cloud-project-group">
                  <span>本地项目</span>
                  <div className="xw-cloud-project-local">
                    <button className="xw-secondary-button compact" onClick={() => void controller.exportCurrentProject()} disabled={controller.projectBusy || !project?.path}>
                      <Download size={14} />
                      <span>导出项目 ZIP</span>
                    </button>
                    <button className="xw-secondary-button compact" onClick={() => void controller.importProjectArchive()} disabled={controller.projectBusy}>
                      <ArchiveRestore size={14} />
                      <span>导入项目 ZIP</span>
                    </button>
                  </div>
                </div>
                <div className="xw-cloud-project-group">
                  <div className="xw-cloud-project-group-head">
                    <span>云项目</span>
                    <button className="xw-icon-button" onClick={() => void controller.refreshCloudProjects()} disabled={controller.cloudProjectBusy} aria-label="刷新云项目">
                      <RefreshCw size={13} className={controller.cloudProjectBusy ? "spin" : ""} />
                    </button>
                  </div>
                  <div className="xw-cloud-slot-list">
                    {cloudSlots.map(({ slotId, slot }) => (
                      <article key={slotId} className={`xw-cloud-slot ${slot ? "filled" : "empty"}`}>
                        <div className="xw-cloud-slot-main">
                          <strong>槽位 {slotId}</strong>
                          <span>{slot ? slot.project_name || slot.file_name : "空槽"}</span>
                          {slot && <small>{formatBytes(slot.size)} · {formatDateShort(slot.updated_at)}</small>}
                        </div>
                        <div className="xw-cloud-slot-actions">
                          <button
                            className="xw-secondary-button compact"
                            onClick={() => void controller.uploadCurrentProjectToCloud(slotId)}
                            disabled={controller.cloudProjectBusy || controller.projectBusy || !project?.path}
                          >
                            <Upload size={13} />
                            <span>{slot ? "覆盖上传" : "上传当前项目"}</span>
                          </button>
                          {slot && (
                            <>
                              <button
                                className="xw-secondary-button compact"
                                onClick={() => void controller.syncCloudProjectToCurrent(slot)}
                                disabled={controller.cloudProjectBusy || controller.projectBusy || !project?.path}
                              >
                                <ArchiveRestore size={13} />
                                <span>同步</span>
                              </button>
                              <button className="xw-danger-button compact" onClick={() => void controller.deleteCloudProject(slot)} disabled={controller.cloudProjectBusy}>
                                <Trash2 size={13} />
                                <span>删除</span>
                              </button>
                            </>
                          )}
                        </div>
                      </article>
                    ))}
                  </div>
                </div>
                {controller.cloudProjectMessage && <p className="xw-cloud-project-message">{controller.cloudProjectMessage}</p>}
              </div>
            )}
          </div>
        </div>
      </section>

      <section className="xw-tree-card">
        <div className="xw-card-head" style={{ justifyContent: "flex-start", gap: "10px" }}>
          <button
            className={`xw-sidebar-tab-btn ${leftSidebarTab === "project" ? "active" : ""}`}
            onClick={() => onSidebarTabChange("project")}
            style={{
              background: "none",
              border: "none",
              padding: 0,
              fontSize: "12px",
              fontWeight: leftSidebarTab === "project" ? "bold" : "normal",
              color: leftSidebarTab === "project" ? "var(--xw-text, #111)" : "var(--xw-muted, #777)",
              cursor: "pointer"
            }}
          >
            项目树
          </button>
          <span style={{ color: "var(--xw-line, #ccc)" }}>|</span>
          <button
            className={`xw-sidebar-tab-btn ${leftSidebarTab === "disassembly" ? "active" : ""}`}
            onClick={() => onSidebarTabChange("disassembly")}
            style={{
              background: "none",
              border: "none",
              padding: 0,
              fontSize: "12px",
              fontWeight: leftSidebarTab === "disassembly" ? "bold" : "normal",
              color: leftSidebarTab === "disassembly" ? "var(--xw-text, #111)" : "var(--xw-muted, #777)",
              cursor: "pointer"
            }}
          >
            拆书库
          </button>
          {leftSidebarTab === "disassembly" && (
            <button
              className="xw-tree-refresh"
              onClick={() => void controller.refreshDisassemblyLibrary()}
              disabled={controller.disassemblyLibraryBusy}
              style={{ marginLeft: "auto", border: "none", background: "none", cursor: "pointer", display: "inline-flex", alignItems: "center" }}
              title="刷新书库"
            >
              <RefreshCw size={12} className={controller.disassemblyLibraryBusy ? "spin" : ""} />
            </button>
          )}
        </div>
        <div className="xw-tree-scroll">
          {leftSidebarTab === "project" ? (
            snapshot?.projectChrome.tree.length ? (
              snapshot.projectChrome.tree.map((node) => (
                <ProjectTreeNode key={node.path} node={node} activePath={controller.activeDocumentPath} onOpenDocument={onOpenDocument} />
              ))
            ) : (
              <p className="xw-empty">打开项目后显示全部文本文件。</p>
            )
          ) : (
            <DisassemblyLibraryTree
              controller={controller}
              disassemblyUi={disassemblyUi}
              onOpenDocument={onOpenDocument}
            />
          )}
        </div>
      </section>

      <button className="xw-timeline-button" onClick={onOpenTimeline}>
        <History size={16} />
        <strong>时间线</strong>
        <span>{snapshot?.timeline.length || 0}</span>
      </button>
    </aside>
  );
}

function ProjectTreeNode({
  node,
  activePath,
  onOpenDocument
}: {
  node: TreeNode;
  activePath: string;
  onOpenDocument: (path: string) => void | Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  const isFile = node.kind === "file";

  return (
    <div className="xw-tree-node">
      <button
        className={`xw-tree-row ${isFile ? "file" : "dir"} ${activePath === node.path ? "active" : ""}`}
        onClick={() => {
          if (isFile) {
            void onOpenDocument(node.path);
            return;
          }
          setExpanded((value) => !value);
        }}
      >
        {isFile ? <FileText size={15} /> : <Folder size={15} />}
        <span>{node.name}</span>
        {!isFile && <em>{expanded ? "-" : "+"}</em>}
      </button>
      {!isFile && expanded && node.children.length > 0 && (
        <div className="xw-tree-children">
          {node.children.map((child) => (
            <ProjectTreeNode key={child.path} node={child} activePath={activePath} onOpenDocument={onOpenDocument} />
          ))}
        </div>
      )}
    </div>
  );
}

function CenterWorkspace({
  controller,
  feature,
  findRequestTick,
  disassemblyUi,
  onSelectFeature,
  onSelectRightMode
}: {
  controller: WorkbenchController;
  feature: CenterFeature;
  findRequestTick: number;
  disassemblyUi: DisassemblyUiState;
  onSelectFeature: (feature: CenterFeature) => void;
  onSelectRightMode: (mode: RailMode) => void;
}) {
  if (!controller.snapshot || !controller.configDraft) {
    return null;
  }

  return <FeatureWorkbenchPanel controller={controller} feature={feature} findRequestTick={findRequestTick} disassemblyUi={disassemblyUi} onSelectFeature={onSelectFeature} onSelectRightMode={onSelectRightMode} />;
}

function FeatureWorkbenchPanel({
  controller,
  feature,
  findRequestTick,
  disassemblyUi,
  onSelectFeature,
  onSelectRightMode
}: {
  controller: WorkbenchController;
  feature: CenterFeature;
  findRequestTick: number;
  disassemblyUi: DisassemblyUiState;
  onSelectFeature: (feature: CenterFeature) => void;
  onSelectRightMode: (mode: RailMode) => void;
}) {
  const activeDocument = controller.openDocuments.find((document) => document.path === controller.activeDocumentPath) || null;
  const editorRef = useRef<HTMLTextAreaElement | null>(null);
  const findInputRef = useRef<HTMLInputElement | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [findMessage, setFindMessage] = useState("");
  const title = featureTitle(feature, activeDocument);

  useEffect(() => {
    if (!findRequestTick) {
      return;
    }
    setFindOpen(true);
    setFindMessage("");
    requestAnimationFrame(() => findInputRef.current?.focus());
  }, [findRequestTick]);

  function insertMark(mark: string) {
    if (!activeDocument) {
      return;
    }
    const open = mark.length > 1 ? mark.slice(0, mark.length / 2) : mark;
    const close = mark.length > 1 ? mark.slice(mark.length / 2) : "";
    const editor = editorRef.current;
    const start = editor?.selectionStart ?? activeDocument.content.length;
    const end = editor?.selectionEnd ?? start;
    const selected = activeDocument.content.slice(start, end);
    const insertion = close ? `${open}${selected}${close}` : open;
    const next = `${activeDocument.content.slice(0, start)}${insertion}${activeDocument.content.slice(end)}`;
    controller.updateActiveDocument(next);
    requestAnimationFrame(() => {
      const cursor = close && selected ? start + insertion.length : start + open.length;
      editorRef.current?.focus();
      editorRef.current?.setSelectionRange(cursor, cursor);
    });
  }

  function findNext() {
    if (!activeDocument || !findQuery.trim()) {
      setFindMessage(findQuery.trim() ? "当前没有可查找文档" : "请输入查找内容");
      return;
    }
    const editor = editorRef.current;
    const content = activeDocument.content;
    const query = findQuery.trim();
    const source = content.toLowerCase();
    const needle = query.toLowerCase();
    const start = Math.max(editor?.selectionEnd ?? 0, 0);
    let index = source.indexOf(needle, start);
    if (index < 0 && start > 0) {
      index = source.indexOf(needle, 0);
    }
    if (index < 0) {
      setFindMessage("未找到");
      return;
    }
    setFindMessage(`已定位第 ${index + 1} 个字符`);
    requestAnimationFrame(() => {
      editorRef.current?.focus();
      editorRef.current?.setSelectionRange(index, index + query.length);
    });
  }

  return (
    <div className="xw-editor-workbench">
      <header className="xw-editor-topbar">
        <div className="xw-editor-title">
          <FilePenLine size={19} />
          <strong>{title}</strong>
        </div>
        <div className="xw-top-actions">
          <button className="xw-secondary-button compact" onClick={() => void controller.reopenDocumentFromDisk()} disabled={!activeDocument || controller.documentBusy}>
            <RefreshCw size={15} />
            <span>刷新</span>
          </button>
          <button className="xw-primary-button compact" onClick={() => void controller.saveActiveDocument()} disabled={!activeDocument || controller.documentBusy}>
            <Save size={15} />
            <span>保存当前</span>
          </button>
        </div>
      </header>

      <div className="xw-editor-body">
        {controller.openDocuments.length > 0 && (
          <div className="xw-editor-tabs">
            {controller.openDocuments.map((document) => (
              <div key={document.path} className={`xw-editor-tab ${document.path === controller.activeDocumentPath ? "active" : ""}`}>
                <button
                  className="xw-editor-tab-title"
                  onClick={() => {
                    controller.activateDocument(document.path);
                    onSelectFeature("editor");
                  }}
                >
                  <span>{document.title}</span>
                  {document.dirty && <em>●</em>}
                </button>
                <button className="xw-editor-tab-close" aria-label={`关闭 ${document.title}`} onClick={() => controller.closeDocument(document.path)}>
                  <X size={13} />
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="xw-quickbar">
          <span>快速工具</span>
          <button onClick={() => onSelectRightMode("ai")}>润色选段</button>
          <button onClick={() => onSelectRightMode("ai")}>续写此处</button>
          <button
            onClick={() => void controller.runWorkflowSkill("lore_extract", {
              instruction: "提取当前页面设定：只提取当前打开文档中明确出现的人物、体系、地图、道具设定，并与现有设定合并，避免臆造。",
              write_result: true
            } as any)}
            disabled={!activeDocument || controller.operationsBusy}
          >
            提取设定
          </button>
          <button
            className={controller.configDraft?.auto_lore_extract_enabled ? "active" : ""}
            onClick={() => controller.patchConfig({ auto_lore_extract_enabled: !controller.configDraft?.auto_lore_extract_enabled })}
          >
            自动提取设定
          </button>
        </div>
        <div className="xw-page-tabs">
          <span>页面</span>
          {pageTabs.map((tab) => (
            <button
              key={tab.key}
              className={feature === tab.key ? "active" : ""}
              onClick={() => {
                onSelectFeature(tab.key);
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <div className="xw-punctuation-bar">
          {punctuationMarks.map((mark) => (
            <button key={mark} onClick={() => insertMark(mark)} disabled={!activeDocument}>
              {mark}
            </button>
          ))}
        </div>

        {findOpen && (
          <div className="xw-find-bar">
            <input
              ref={findInputRef}
              value={findQuery}
              onChange={(event) => setFindQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  findNext();
                }
                if (event.key === "Escape") {
                  setFindOpen(false);
                  setFindMessage("");
                  editorRef.current?.focus();
                }
              }}
              placeholder="查找当前文档"
            />
            <button className="xw-secondary-button compact" type="button" onClick={findNext} disabled={!activeDocument}>
              查找
            </button>
            <button className="xw-secondary-button compact" type="button" onClick={() => setFindOpen(false)}>
              关闭
            </button>
            <span>{findMessage || "Enter 查找下一个，Esc 关闭"}</span>
          </div>
        )}

        {feature === "editor" && controller.pendingCloseRequest && (
          <GuardBanner
            title={`${controller.pendingCloseRequest.title} 还有未保存修改`}
            detail="继续关闭会直接丢掉本地草稿。"
            primaryLabel="仍然关闭"
            secondaryLabel="返回编辑"
            onPrimary={controller.confirmCloseDocument}
            onSecondary={controller.cancelCloseDocument}
          />
        )}
        {feature === "editor" && controller.pendingReloadRequest && (
          <GuardBanner
            title={`${controller.pendingReloadRequest.title} 还有未保存修改`}
            detail="读取最新版会用磁盘内容覆盖当前本地草稿。"
            primaryLabel="丢弃草稿并读取"
            secondaryLabel="继续编辑"
            onPrimary={controller.confirmReloadDocument}
            onSecondary={controller.cancelReloadDocument}
          />
        )}
        {feature === "editor" && controller.pendingSaveConflictRequest && (
          <GuardBanner
            title={`${controller.pendingSaveConflictRequest.title} 磁盘已有新版`}
            detail="普通保存已暂停，避免覆盖后台或其他窗口写入的内容。"
            primaryLabel="确认覆盖"
            secondaryLabel="继续编辑"
            onPrimary={controller.confirmSaveOverwrite}
            onSecondary={controller.cancelSaveConflict}
          />
        )}

        <FeatureContentSurface controller={controller} feature={feature} disassemblyUi={disassemblyUi} activeDocument={activeDocument} editorRef={editorRef} onSelectFeature={onSelectFeature} />
      </div>
    </div>
  );
}

function featureTitle(feature: CenterFeature, activeDocument: OpenDocumentTab | null): string {
  const titles: Record<CenterFeature, string> = {
    editor: activeDocument?.title || "未打开文档",
    conversations: "AI 对话",
    timeline: "时间线",
    "settings-set": "设定集",
    "style-library": "风格库",
    "theme-library": "题材库",
    batch: "批量生成",
    crawl: "拆书",
    card_draw: "抽卡",
    ledger: "伏笔",
    revision: "日志",
    skills: "技能",
    consistency: "一致性检查",
    settings: "设置",
    terminal: "终端"
  };
  return titles[feature];
}

function FeatureContentSurface({
  controller,
  feature,
  disassemblyUi,
  activeDocument,
  editorRef,
  onSelectFeature
}: {
  controller: WorkbenchController;
  feature: CenterFeature;
  disassemblyUi: DisassemblyUiState;
  activeDocument: OpenDocumentTab | null;
  editorRef: React.RefObject<HTMLTextAreaElement | null>;
  onSelectFeature: (feature: CenterFeature) => void;
}) {
  if (feature === "editor") {
    return <EditorFeaturePage controller={controller} activeDocument={activeDocument} editorRef={editorRef} />;
  }
  if (feature === "conversations") {
    return <ConversationFeaturePage controller={controller} />;
  }
  if (feature === "timeline") {
    return <TimelineFeaturePage controller={controller} />;
  }
  if (feature === "settings-set") {
    return (
      <DocumentLibraryFeaturePage
        hint="点击卡片后在文档页打开并编辑"
        cards={[
          ["人物设定", "主角、配角、势力关系", "00_设定集/设定集/人物设定.txt"],
          ["体系设定", "修炼、能力、规则边界", "00_设定集/设定集/体系设定.txt"],
          ["地图设定", "地理、区域、移动路线", "00_设定集/设定集/地图设定.txt"],
          ["道具设定", "关键物品、资源、装备", "00_设定集/设定集/道具设定.txt"]
        ]}
        onOpenDocument={async (path) => {
          const opened = await controller.openDocument(path);
          if (opened) {
            onSelectFeature("editor");
          }
        }}
      />
    );
  }
  if (feature === "style-library") {
    return (
      <DocumentLibraryFeaturePage
        hint="点击卡片后在文档页打开并编辑"
        cards={[
          ["写作风格", "项目默认文风与叙事规则", "00_设定集/风格库/写作风格.txt"],
          ["风格示例", "可复用的段落样本", "00_设定集/风格库/风格示例.txt"],
          ["参考素材", "语感、意象、资料摘录", "00_设定集/风格库/参考素材.txt"]
        ]}
        onOpenDocument={async (path) => {
          const opened = await controller.openDocument(path);
          if (opened) {
            onSelectFeature("editor");
          }
        }}
      />
    );
  }
  if (feature === "theme-library") {
    return (
      <DocumentLibraryFeaturePage
        hint="点击卡片后在文档页打开并编辑"
        cards={[
          ["题材规则", "世界类型、爽点、禁区", "00_设定集/题材库/题材规则.txt"],
          ["题材素材", "桥段、场景、关键词", "00_设定集/题材库/题材素材.txt"],
          ["战斗模板", "冲突推进与场面调度", "00_设定集/题材库/战斗模板.txt"],
          ["违禁词", "敏感词与替代表达", "00_设定集/题材库/违禁词.txt"]
        ]}
        onOpenDocument={async (path) => {
          const opened = await controller.openDocument(path);
          if (opened) {
            onSelectFeature("editor");
          }
        }}
      />
    );
  }
  if (feature === "ledger") {
    return <LedgerFeaturePage controller={controller} onSelectFeature={onSelectFeature} />;
  }
  if (feature === "revision") {
    return <LogsFeaturePage controller={controller} onSelectFeature={onSelectFeature} />;
  }
  if (feature === "skills") {
    return <SkillFeaturePage controller={controller} />;
  }
  if (feature === "settings") {
    return <SettingsFeaturePage controller={controller} />;
  }
  if (feature === "terminal") {
    return <TerminalFeaturePage controller={controller} />;
  }
  return <WorkflowFeaturePage controller={controller} feature={feature} disassemblyUi={disassemblyUi} />;
}

function EditorFeaturePage({
  controller,
  activeDocument,
  editorRef
}: {
  controller: WorkbenchController;
  activeDocument: OpenDocumentTab | null;
  editorRef: React.RefObject<HTMLTextAreaElement | null>;
}) {
  return (
    <div className="xw-editor-surface-wrap">
      {activeDocument ? (
        <textarea
          ref={editorRef}
          className="xw-editor-surface"
          value={activeDocument.content}
          onChange={(event) => controller.updateActiveDocument(event.target.value)}
          spellCheck={false}
          aria-label={`${activeDocument.title} 正文编辑器`}
        />
      ) : (
        <div className="xw-editor-empty" aria-label="空白编辑区" />
      )}
    </div>
  );
}

function DocumentLibraryFeaturePage({
  cards,
  hint,
  onOpenDocument
}: {
  cards: Array<[string, string, string]>;
  hint: string;
  onOpenDocument: (path: string) => void | Promise<void>;
}) {
  return (
    <section className="xw-feature-page">
      <div className="xw-feature-grid">
        {cards.map(([title, detail, path]) => (
          <button key={path} className="xw-feature-card action" onClick={() => onOpenDocument(path)}>
            <strong>{title}</strong>
            <span>{detail}</span>
            <small>{path}</small>
          </button>
        ))}
      </div>
      <p className="xw-feature-empty">{hint}</p>
    </section>
  );
}

function TimelineFeaturePage({ controller }: { controller: WorkbenchController }) {
  const timeline = controller.snapshot?.timeline || [];
  return (
    <section className="xw-feature-page">
      <div className="xw-feature-list">
        {timeline.map((entry) => {
          const firstFile = entry.files[0]?.path || entry.path || "";
          return (
            <article key={entry.id} className="xw-feature-card">
              <div className="xw-feature-card-head">
                <strong>{entry.summary || entry.title || "项目变更"}</strong>
                <small>{entry.time || entry.timestamp || "未记录时间"}</small>
              </div>
              <span>{entry.source || "工作台"} · {entry.files.length} 个文件</span>
              {firstFile && <small>{firstFile}</small>}
              <div className="xw-feature-actions">
                {firstFile && <button className="xw-secondary-button compact" onClick={() => void controller.openDocument(firstFile)}>打开</button>}
                <button className="xw-secondary-button compact" onClick={() => void controller.rollbackTimelineEntry(entry.id)} disabled={controller.projectBusy}>
                  回滚
                </button>
              </div>
            </article>
          );
        })}
      </div>
      {!timeline.length && <p className="xw-feature-empty">暂无时间线记录</p>}
    </section>
  );
}

function ConversationFeaturePage({ controller }: { controller: WorkbenchController }) {
  const messages = controller.conversationDetail?.messages || [];
  const threadEndRef = useRef<HTMLDivElement | null>(null);
  const lastMessage = messages.at(-1);

  useEffect(() => {
    if (!messages.length) {
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      threadEndRef.current?.scrollIntoView({ block: "end" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [controller.conversationDetail?.id, messages.length, lastMessage?.id, lastMessage?.content.length]);

  return (
    <section className="xw-feature-page">
      <div className="xw-feature-list conversation">
        {messages.map((message) => (
          <article key={message.id} className={`xw-message-row ${message.role}`}>
            <strong>{message.role === "assistant" ? "AI" : message.role === "user" ? "我" : "系统"}</strong>
            <p>{message.content}</p>
          </article>
        ))}
        <div ref={threadEndRef} aria-hidden="true" />
      </div>
      {!messages.length && <p className="xw-feature-empty">右侧选择或新建会话后开始写作</p>}
    </section>
  );
}

function WorkflowFeaturePage({ controller, feature, disassemblyUi }: { controller: WorkbenchController; feature: CenterFeature; disassemblyUi: DisassemblyUiState }) {
  if (feature === "batch") {
    return <BatchFeaturePage controller={controller} />;
  }
  if (feature === "crawl") {
    return <DisassembleFeaturePage controller={controller} disassemblyUi={disassemblyUi} />;
  }
  if (feature === "card_draw") {
    return <CardDrawFeaturePage controller={controller} />;
  }
  if (feature === "consistency") {
    return <ConsistencyFeaturePage controller={controller} />;
  }
  return <BatchFeaturePage controller={controller} />;
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

function ProjectFileSelect({
  label,
  value,
  onChange,
  controller,
  emptyLabel = "留空使用当前文档或粘贴文本"
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  controller: WorkbenchController;
  emptyLabel?: string;
}) {
  const files = flattenProjectFilePaths(controller.snapshot?.projectChrome.tree || []);
  const activeDocument = controller.openDocuments.find((document) => document.path === controller.activeDocumentPath) || null;
  const hasValue = Boolean(value && (files.includes(value) || value === activeDocument?.path));
  const selectableFiles = activeDocument ? files.filter((path) => path !== activeDocument.path) : files;
  return (
    <label>
      <span>{label}</span>
      <select value={hasValue ? value : ""} onChange={(event) => onChange(event.target.value)}>
        <option value="">{emptyLabel}</option>
        {activeDocument && <option value={activeDocument.path}>当前文档：{activeDocument.title}</option>}
        {selectableFiles.map((path) => (
          <option key={path} value={path}>{path}</option>
        ))}
      </select>
      <input value={value} onChange={(event) => onChange(event.target.value)} placeholder="也可输入项目相对路径" />
    </label>
  );
}

function AutoReviewGeneratedToggle({ controller }: { controller: WorkbenchController }) {
  const enabled = Boolean(controller.configDraft?.enable_consistency_revision);
  return (
    <label className="xw-check-row">
      <input
        type="checkbox"
        checked={enabled}
        onChange={() => controller.patchConfig({ enable_consistency_revision: !enabled })}
      />
      <span>自动审查生成文件</span>
    </label>
  );
}

function BatchFeaturePage({ controller }: { controller: WorkbenchController }) {
  const [startChapter, setStartChapter] = useState(1);
  const [endChapter, setEndChapter] = useState(3);
  const [targetWords, setTargetWords] = useState(2500);
  const [writeResult, setWriteResult] = useState(true);
  const [instruction, setInstruction] = useState("");
  const autoReview = Boolean(controller.configDraft?.enable_consistency_revision);
  const reviewThreshold = controller.configDraft?.consistency_revision_score || 80;
  return (
    <section className="xw-feature-page">
      <div className="xw-operation-form">
        <div className="xw-operation-grid">
          <label><span>起始章节</span><input type="number" min={1} value={startChapter} onChange={(event) => setStartChapter(Number(event.target.value))} /></label>
          <label><span>结束章节</span><input type="number" min={startChapter} value={endChapter} onChange={(event) => setEndChapter(Number(event.target.value))} /></label>
          <label><span>目标字数</span><input type="number" min={300} max={20000} value={targetWords} onChange={(event) => setTargetWords(Number(event.target.value))} /></label>
          <label className="xw-check-row"><input type="checkbox" checked={writeResult} onChange={(event) => setWriteResult(event.target.checked)} /><span>生成后直接写入正文文件</span></label>
          <AutoReviewGeneratedToggle controller={controller} />
        </div>
        <textarea value={instruction} onChange={(event) => setInstruction(event.target.value)} placeholder="批量写作要求，例如节奏、爽点、角色行动、禁用桥段。" />
        <button
          className="xw-primary-button"
          onClick={() => void controller.runWorkflowSkill("batch_generate", {
            chapter: startChapter,
            end_chapter: Math.max(startChapter, endChapter),
            target_words: targetWords,
            instruction,
            write_result: writeResult,
            auto_revision: autoReview,
            score_threshold: reviewThreshold
          } as any)}
          disabled={controller.operationsBusy}
        >
          开始批量生成
        </button>
      </div>
    </section>
  );
}

function DisassembleFeaturePage({ controller, disassemblyUi }: { controller: WorkbenchController; disassemblyUi: DisassemblyUiState }) {
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

function CardDrawFeaturePage({ controller }: { controller: WorkbenchController }) {
  const [mode, setMode] = useState<"outline" | "detail_outline" | "chapter_outline" | "body">("outline");
  const [candidateCount, setCandidateCount] = useState(5);
  const [chapter, setChapter] = useState(1);
  const [startChapter, setStartChapter] = useState(1);
  const [chapterCount, setChapterCount] = useState(1);
  const [sectionWords, setSectionWords] = useState(300);
  const [targetWords, setTargetWords] = useState(2500);
  const [targetPath, setTargetPath] = useState("");
  const [sourcePath, setSourcePath] = useState("");
  const [instruction, setInstruction] = useState("");
  const result = controller.latestCardDrawResult;
  const activeDocument = controller.openDocuments.find((document) => document.path === controller.activeDocumentPath) || null;
  return (
    <section className="xw-feature-page">
      <div className="xw-operation-form">
        <div className="xw-operation-grid">
          <label><span>生成类型</span><select value={mode} onChange={(event) => setMode(event.target.value as typeof mode)}><option value="outline">大纲</option><option value="detail_outline">细纲</option><option value="chapter_outline">章纲</option><option value="body">正文</option></select></label>
          <label><span>候选数量</span><input type="number" min={2} max={5} value={candidateCount} onChange={(event) => setCandidateCount(Number(event.target.value))} /></label>
          <label><span>章节</span><input type="number" min={1} value={chapter} onChange={(event) => setChapter(Number(event.target.value))} /></label>
          <label><span>目标字数</span><input type="number" min={300} max={20000} value={targetWords} onChange={(event) => setTargetWords(Number(event.target.value))} /></label>
          <label><span>章纲起始章</span><input type="number" min={1} value={startChapter} onChange={(event) => setStartChapter(Number(event.target.value))} /></label>
          <label><span>章纲数量</span><input type="number" min={1} max={300} value={chapterCount} onChange={(event) => setChapterCount(Number(event.target.value))} /></label>
          <label><span>每节字数</span><input type="number" min={100} max={2000} value={sectionWords} onChange={(event) => setSectionWords(Number(event.target.value))} /></label>
          <label><span>写入路径</span><input value={targetPath} onChange={(event) => setTargetPath(event.target.value)} placeholder="留空按类型写入默认目标" /></label>
          <ProjectFileSelect label="参考来源文件" value={sourcePath} onChange={setSourcePath} controller={controller} />
        </div>
        <textarea value={instruction} onChange={(event) => setInstruction(event.target.value)} placeholder="写卡要求，例如更强爽点、更换因果、更偏情绪拉扯。当前打开文档会作为输入参考。" />
        <button
          className="xw-primary-button"
          onClick={() => void controller.generateCardDraw({ mode, candidate_count: candidateCount, chapter, start_chapter: startChapter, chapter_count: chapterCount, section_words: sectionWords, target_words: targetWords, target_path: targetPath, instruction, source_path: sourcePath || activeDocument?.path || "", text: activeDocument?.content || "" })}
          disabled={controller.operationsBusy}
        >
          开始抽卡
        </button>
      </div>
      {result && (
        <div className="xw-candidate-list">
          {result.candidates.map((candidate) => (
            <article key={candidate.id} className={`xw-candidate-card ${result.selected_id === candidate.id ? "selected" : ""}`}>
              <div>
                <strong>{candidate.id}</strong>
                <span>{candidate.excerpt}</span>
                <small>{candidate.path} · {candidate.chars} 字</small>
              </div>
              <div className="xw-operation-actions">
                <button className="xw-secondary-button compact" onClick={() => void controller.openDocument(candidate.path)}>打开</button>
                <button className="xw-primary-button compact" onClick={() => void controller.selectCardDraw(result.draw_id, { candidate_id: candidate.id, target_path: targetPath || result.target_path })} disabled={controller.operationsBusy}>选中写入</button>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function ConsistencyFeaturePage({ controller }: { controller: WorkbenchController }) {
  const [sourcePath, setSourcePath] = useState("");
  const [text, setText] = useState("");
  const [threshold, setThreshold] = useState(controller.configDraft?.consistency_revision_score || 80);
  const [instruction, setInstruction] = useState("");
  const activeDocument = controller.openDocuments.find((document) => document.path === controller.activeDocumentPath) || null;
  const data = controller.latestSkillResult?.data || {};
  const autoConsistency = Boolean(controller.configDraft?.enable_consistency_revision);
  const updateThreshold = (nextValue: number) => {
    const nextThreshold = Math.max(1, Math.min(100, Number.isFinite(nextValue) ? nextValue : 80));
    setThreshold(nextThreshold);
    controller.patchConfig({ consistency_revision_score: nextThreshold });
  };
  return (
    <section className="xw-feature-page">
      <div className="xw-operation-form">
        <div className="xw-operation-grid two">
          <ProjectFileSelect label="检查来源文件" value={sourcePath} onChange={setSourcePath} controller={controller} />
          <label><span>风险阈值</span><input type="number" min={1} max={100} value={threshold} onChange={(event) => updateThreshold(Number(event.target.value))} /></label>
          <label className="xw-check-row">
            <input
              type="checkbox"
              checked={autoConsistency}
              onChange={() => controller.patchConfig({ enable_consistency_revision: !autoConsistency })}
            />
            <span>自动一致性检查</span>
          </label>
        </div>
        <textarea value={text} onChange={(event) => setText(event.target.value)} placeholder="可粘贴待检查正文。留空则使用当前文档或来源路径。" />
        <textarea value={instruction} onChange={(event) => setInstruction(event.target.value)} placeholder="补充检查要求，例如重点看人物动机、地图距离、伏笔承接。" />
        <button className="xw-primary-button" onClick={() => void controller.runWorkflowSkill("consistency_check", { text: text || activeDocument?.content || "", source_path: sourcePath || activeDocument?.path || "", instruction, score_threshold: threshold } as any)} disabled={controller.operationsBusy}>开始一致性检查</button>
      </div>
      {controller.latestSkillResult?.data && (
        <article className="xw-operation-result">
          <strong>评分：{String(data.score ?? "未返回")}</strong>
          <span>{String(data.reason || controller.latestSkillResult.result || "")}</span>
          {Array.isArray(data.risks) && data.risks.length > 0 && <ul>{data.risks.map((risk, index) => <li key={index}>{String(risk)}</li>)}</ul>}
        </article>
      )}
    </section>
  );
}

function SkillFeaturePage({ controller }: { controller: WorkbenchController }) {
  const [pathInput, setPathInput] = useState("");
  const [urlInput, setUrlInput] = useState("");
  const [skillPage, setSkillPage] = useState(0);
  const [skillDescriptionDrafts, setSkillDescriptionDrafts] = useState<Record<string, string>>({});
  const [pendingSkillAction, setPendingSkillAction] = useState<{ skillId: string; action: "run" | "delete-disable" | "restore" } | null>(null);
  const [skillRefreshError, setSkillRefreshError] = useState("");
  const attemptedEmptySkillRefreshRef = useRef(false);
  const skillFileInputRef = useRef<HTMLInputElement | null>(null);
  const skills = controller.snapshot?.skills || [];
  const skillsPerPage = 12;
  const pageCount = Math.max(1, Math.ceil(skills.length / skillsPerPage));
  const currentPage = Math.min(skillPage, pageCount - 1);
  const pageSkills = skills.slice(currentPage * skillsPerPage, currentPage * skillsPerPage + skillsPerPage);

  async function refreshSkills() {
    setSkillRefreshError("");
    try {
      await controller.refreshSkillCatalog();
    } catch (error) {
      setSkillRefreshError(error instanceof Error ? error.message : String(error));
    }
  }

  useEffect(() => {
    if (skillPage > pageCount - 1) {
      setSkillPage(pageCount - 1);
    }
  }, [pageCount, skillPage]);

  useEffect(() => {
    if (!controller.snapshot || skills.length || attemptedEmptySkillRefreshRef.current) {
      return;
    }
    attemptedEmptySkillRefreshRef.current = true;
    void refreshSkills();
  }, [controller.snapshot, skills.length]);

  useEffect(() => {
    if (!pendingSkillAction || controller.operationsBusy) {
      return;
    }
    if (controller.selectedSkillId !== pendingSkillAction.skillId || controller.selectedSkillDetail?.id !== pendingSkillAction.skillId) {
      return;
    }
    const action = pendingSkillAction.action;
    setPendingSkillAction(null);
    if (action === "run") {
      void controller.invokeSelectedSkill();
      return;
    }
    if (action === "restore") {
      void controller.restoreSelectedBuiltinSkill();
      return;
    }
    void controller.deleteOrDisableSelectedSkill();
  }, [controller, pendingSkillAction]);

  function queueSkillAction(skillId: string, action: "run" | "delete-disable" | "restore") {
    setPendingSkillAction({ skillId, action });
    void controller.selectSkill(skillId, { activateTab: false });
  }

  function submitPathImport() {
    const path = pathInput.trim();
    if (path) {
      void controller.importSkillFromPath(path);
      return;
    }
    skillFileInputRef.current?.click();
  }

  async function saveSkillDescription(skill: SkillDefinition) {
    if (skill.builtin) {
      return;
    }
    const draft = skillDescriptionDrafts[skill.id] ?? skill.description;
    if (draft.trim() === String(skill.description || "").trim()) {
      return;
    }
    const updated = await controller.updateSkillDescription(skill.id, draft);
    if (updated) {
      setSkillDescriptionDrafts((current) => {
        const next = { ...current };
        delete next[skill.id];
        return next;
      });
    }
  }

  return (
    <section className="xw-feature-page">
      <div className="xw-skill-import-row">
        <input value={pathInput} onChange={(event) => setPathInput(event.target.value)} placeholder="本地技能路径" />
        <button className="xw-secondary-button compact" onClick={submitPathImport} disabled={controller.operationsBusy}>导入</button>
        <input
          ref={skillFileInputRef}
          type="file"
          className="xw-hidden-file"
          accept=".md,.markdown,.txt,.zip"
          onChange={(event) => {
            const file = event.currentTarget.files?.[0] || null;
            event.currentTarget.value = "";
            if (file) {
              void controller.uploadSkillFile(file);
            }
          }}
        />
        <input value={urlInput} onChange={(event) => setUrlInput(event.target.value)} placeholder="GitHub 或网页 URL" />
        <button className="xw-secondary-button compact" onClick={() => void controller.importSkillFromUrl(urlInput)} disabled={controller.operationsBusy || !urlInput.trim()}>URL 导入</button>
        <button className="xw-secondary-button compact" onClick={controller.openSkillFolder} disabled={controller.operationsBusy}>技能目录</button>
        <button className="xw-secondary-button compact" onClick={() => void refreshSkills()} disabled={controller.operationsBusy}>刷新技能</button>
      </div>
      <div className="xw-skill-grid">
        {pageSkills.map((skill) => {
          const selected = skill.id === controller.selectedSkillId;
          const restoreBuiltin = Boolean(skill.builtin && skill.disabled);
          const secondLabel = restoreBuiltin ? "恢复" : skill.builtin ? "禁用" : "删除技能";
          const descriptionDraft = skillDescriptionDrafts[skill.id] ?? skill.description;
          return (
            <article
              key={skill.id}
              className={`xw-skill-card ${selected ? "selected" : ""} ${skill.disabled ? "muted" : ""}`}
              onClick={() => controller.selectSkill(skill.id)}
            >
              <div className="xw-skill-main">
                <strong>{skill.disabled ? "已禁用 / " : ""}{skill.name}</strong>
                {skill.builtin ? (
                  <span>{skill.description}</span>
                ) : (
                  <input
                    className="xw-skill-description-input"
                    value={descriptionDraft}
                    onChange={(event) => setSkillDescriptionDrafts((current) => ({ ...current, [skill.id]: event.target.value }))}
                    onBlur={() => void saveSkillDescription(skill)}
                    onClick={(event) => event.stopPropagation()}
                    onKeyDown={(event) => {
                      event.stopPropagation();
                      if (event.key === "Enter") {
                        event.preventDefault();
                        event.currentTarget.blur();
                      }
                    }}
                    placeholder="输入技能简介，AI 调用时会参考"
                    disabled={controller.operationsBusy}
                  />
                )}
                <small>{skill.builtin ? "默认技能" : "导入技能"} · {skill.input_mode} · {skill.handler_type} · {skill.id}</small>
                {skill.disabled && <em>AI 自动判断时会跳过它，尝试调用相近可用技能。</em>}
              </div>
              <div className="xw-skill-actions">
                <button
                  className="xw-primary-button compact"
                  onClick={(event) => {
                    event.stopPropagation();
                    queueSkillAction(skill.id, "run");
                  }}
                  disabled={controller.operationsBusy || Boolean(skill.disabled)}
                >
                  运行
                </button>
                <button
                  className={restoreBuiltin ? "xw-secondary-button compact" : "xw-danger-button compact"}
                  onClick={(event) => {
                    event.stopPropagation();
                    queueSkillAction(skill.id, restoreBuiltin ? "restore" : "delete-disable");
                  }}
                  disabled={controller.operationsBusy}
                >
                  {secondLabel}
                </button>
              </div>
            </article>
          );
        })}
      </div>
      {!pageSkills.length && (
        <div className="xw-empty-action">
          <p className="xw-feature-empty">{skillRefreshError ? `技能目录读取失败：${skillRefreshError}` : "暂无技能，正在尝试重新读取技能目录。"}</p>
          <button className="xw-secondary-button compact" onClick={() => void refreshSkills()} disabled={controller.operationsBusy}>重新读取技能</button>
        </div>
      )}
      {pageCount > 1 && (
        <div className="xw-skill-pager">
          <button className="xw-secondary-button compact" onClick={() => setSkillPage((page) => Math.max(0, page - 1))} disabled={currentPage <= 0}>
            上一页
          </button>
          <span>{currentPage + 1} / {pageCount}</span>
          <button className="xw-secondary-button compact" onClick={() => setSkillPage((page) => Math.min(pageCount - 1, page + 1))} disabled={currentPage >= pageCount - 1}>
            下一页
          </button>
        </div>
      )}
    </section>
  );
}

function LedgerFeaturePage({ controller, onSelectFeature }: { controller: WorkbenchController; onSelectFeature: (feature: CenterFeature) => void }) {
  const [draft, setDraft] = useState("");
  const [scanPath, setScanPath] = useState("");
  const [scanText, setScanText] = useState("");
  const [scanInstruction, setScanInstruction] = useState("");
  const ledger = controller.snapshot?.ledger || [];
  const activeDocument = controller.openDocuments.find((document) => document.path === controller.activeDocumentPath) || null;
  return (
    <section className="xw-feature-page">
      <div className="xw-feature-toolbar">
        <input value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="新增伏笔或待回收线索" />
        <button
          className="xw-primary-button compact"
          onClick={() => {
            const text = draft.trim();
            if (text) {
              void controller.addLedgerItem(text);
              setDraft("");
            }
          }}
          disabled={controller.projectBusy || !draft.trim()}
        >
          新增
        </button>
      </div>
      <div className="xw-operation-form">
        <div className="xw-operation-grid two">
          <ProjectFileSelect label="扫描来源文件" value={scanPath} onChange={setScanPath} controller={controller} />
          <label><span>当前文档</span><input value={activeDocument?.title || "未打开文档"} readOnly /></label>
        </div>
        <textarea value={scanText} onChange={(event) => setScanText(event.target.value)} placeholder="可粘贴正文片段。留空则使用当前文档或来源路径。" />
        <textarea value={scanInstruction} onChange={(event) => setScanInstruction(event.target.value)} placeholder="扫描要求，例如只提取未回收伏笔、人物承诺、物品线索。" />
        <button
          className="xw-primary-button"
          onClick={() => void controller.runWorkflowSkill("scan_pits", {
            text: scanText || activeDocument?.content || "",
            source_path: scanPath || activeDocument?.path || "",
            instruction: scanInstruction,
            write_result: true
          })}
          disabled={controller.operationsBusy}
        >
          扫描伏笔
        </button>
      </div>
      <div className="xw-feature-list">
        {ledger.map((item) => (
          <article key={item.id} className={`xw-feature-card ${item.status === "closed" ? "muted" : ""}`}>
            <div className="xw-feature-card-head">
              <strong>{item.desc}</strong>
              <small>{item.status === "closed" ? "已关闭" : "未关闭"}</small>
            </div>
            <span>{item.updated_at || item.created_at}</span>
            <div className="xw-feature-actions">
              {item.status !== "closed" && (
                <button
                  className="xw-primary-button compact"
                  onClick={() => {
                    onSelectFeature("conversations");
                    void controller.sendLedgerRecoveryPrompt(item);
                  }}
                  disabled={controller.sendingMessage || controller.conversationBusy}
                >
                  发给AI回收
                </button>
              )}
              <button className="xw-secondary-button compact" onClick={() => void controller.toggleLedgerItem(item.id)} disabled={controller.projectBusy}>
                {item.status === "closed" ? "重新打开" : "关闭"}
              </button>
            </div>
          </article>
        ))}
      </div>
      {!ledger.length && <p className="xw-feature-empty">暂无伏笔记录</p>}
    </section>
  );
}

function LogsFeaturePage({ controller, onSelectFeature }: { controller: WorkbenchController; onSelectFeature: (feature: CenterFeature) => void }) {
  const logs = controller.snapshot?.revisionLog || [];
  const caches = controller.snapshot?.localState?.generated_caches || [];
  return (
    <section className="xw-feature-page">
      <div className="xw-feature-toolbar">
        <strong>修正日志</strong>
        <button className="xw-secondary-button compact" onClick={() => void controller.clearRevisionLog()} disabled={controller.projectBusy || !logs.length}>清空日志</button>
      </div>
      <div className="xw-feature-list">
        {logs.map((log, index) => (
          <article key={`${log.path}-${index}`} className="xw-feature-card">
            <div className="xw-feature-card-head">
              <strong>{log.path || "修正记录"}</strong>
              <small>{log.timestamp || (log.score ? `评分 ${log.score}` : "")}</small>
            </div>
            <span>{log.risks.length ? log.risks.join("、") : log.excerpt || log.raw || "记录了正文二次修正结果"}</span>
          </article>
        ))}
        {caches.filter((cache) => cache.status === "pending").map((cache) => (
          <article key={cache.cache_id} className="xw-feature-card">
            <div className="xw-feature-card-head">
              <strong>生成缓存：{cache.skill_id || cache.source}</strong>
              <small>{cache.cache_chars} 字</small>
            </div>
            <span>{cache.target_path || cache.target_paths.join("、") || "未指定目标"}</span>
            <div className="xw-feature-actions">
              <button className="xw-secondary-button compact" onClick={() => void controller.restoreGeneratedCache(cache)}>恢复</button>
              <button className="xw-secondary-button compact" onClick={() => void controller.copyGeneratedCacheContent(cache)}>复制</button>
              <button className="xw-danger-button compact" onClick={() => void controller.discardGeneratedCacheRecord(cache)}>丢弃</button>
            </div>
          </article>
        ))}
      </div>
      {!logs.length && !caches.length && <p className="xw-feature-empty">暂无日志或生成缓存</p>}
      <button className="xw-secondary-button compact" onClick={() => onSelectFeature("timeline")}>查看时间线</button>
    </section>
  );
}

function SettingsFeaturePage({ controller }: { controller: WorkbenchController }) {
  const config = controller.configDraft;
  const [showSecrets, setShowSecrets] = useState(false);
  const [websiteEmail, setWebsiteEmail] = useState("");
  const [websitePassword, setWebsitePassword] = useState("");
  const [websiteLoginVisible, setWebsiteLoginVisible] = useState(false);
  const [websiteDialog, setWebsiteDialog] = useState<"redeem" | "recharge" | null>(null);
  const [redeemCode, setRedeemCode] = useState("");
  const [selectedRechargeIndex, setSelectedRechargeIndex] = useState(0);
  const websiteDashboard = controller.websiteAiDashboard;
  const rechargeOptions = websiteDashboard?.recharge_options || [];
  const rechargeOptionKey = rechargeOptions.map((item) => item.option_index).join("|");

  useEffect(() => {
    if (!rechargeOptions.length) {
      setSelectedRechargeIndex(0);
      return;
    }
    if (!rechargeOptions.some((item) => item.option_index === selectedRechargeIndex)) {
      setSelectedRechargeIndex(rechargeOptions[0]?.option_index ?? 0);
    }
  }, [rechargeOptionKey, selectedRechargeIndex]);

  if (!config) {
    return null;
  }
  const activeConfig = config;
  const mode: AppConfig["ai_config_mode"] = activeConfig.ai_config_mode === "website" ? "website" : "manual";
  const manualProfile = normalizeUiAiProfile(activeConfig.manual_profile);
  const websiteProfile = normalizeUiAiProfile(activeConfig.website_profile);
  const websiteLoggedIn = Boolean(websiteDashboard?.logged_in);
  const websiteModels = websiteDashboard?.models || [];
  const websiteEmbeddingModels = websiteDashboard?.embedding_models || [];
  const websiteModel = websiteProfile.model || websiteDashboard?.selected_model || websiteModels[0]?.id || "";
  const websiteEmbeddingModel = websiteProfile.embedding_model || websiteDashboard?.selected_embedding_model || websiteEmbeddingModels[0]?.id || "";
  const websiteTemp = websiteProfile.temp ?? websiteDashboard?.temp ?? 0.7;
  const websiteTopP = websiteProfile.top_p ?? websiteDashboard?.top_p ?? 1;
  const selectedRechargeOption = rechargeOptions.find((item) => item.option_index === selectedRechargeIndex) || rechargeOptions[0] || null;

  function switchMode(nextMode: AppConfig["ai_config_mode"]) {
    controller.patchConfig({ ai_config_mode: nextMode });
    if (nextMode === "website") {
      void controller.refreshWebsiteAiDashboard();
    }
  }

  function submitWebsiteLogin(event: ReactFormEvent<HTMLFormElement>) {
    event.preventDefault();
    void controller.loginWebsiteAi(websiteEmail, websitePassword);
  }

  function applyWebsiteConfig() {
    if (!websiteModel) {
      return;
    }
    void controller.applyWebsiteAiConfig({
      model: websiteModel,
      embedding_model: websiteEmbeddingModel,
      temp: websiteTemp,
      top_p: websiteTopP
    });
  }

  function patchManualProfile(patch: Partial<AiConfigProfile>) {
    controller.patchConfig({ manual_profile: { ...manualProfile, ...patch } });
  }

  function patchWebsiteProfile(patch: Partial<AiConfigProfile>) {
    controller.patchConfig({ website_profile: { ...websiteProfile, ...patch } });
  }

  function openWebsiteDialog(kind: "redeem" | "recharge") {
    if (!websiteLoggedIn) {
      void controller.refreshWebsiteAiDashboard();
      return;
    }
    if (kind === "recharge" && selectedRechargeOption) {
      setSelectedRechargeIndex(selectedRechargeOption.option_index);
    }
    setWebsiteDialog(kind);
  }

  async function submitRedeem(event: ReactFormEvent<HTMLFormElement>) {
    event.preventDefault();
    const success = await controller.redeemWebsiteAiCode(redeemCode);
    if (success) {
      setRedeemCode("");
    }
  }

  function createRechargeOrder() {
    if (!selectedRechargeOption) {
      return;
    }
    void controller.createWebsiteAiRechargeOrder(selectedRechargeOption.option_index);
  }

  function refreshRechargeOrder() {
    const orderId = controller.websiteAiRechargeOrder?.order_id || "";
    if (orderId) {
      void controller.refreshWebsiteAiRechargeOrder(orderId);
    }
  }

  return (
    <section className="xw-feature-page">
      <div className="xw-settings-header">
        <div>
          <strong>AI 配置</strong>
        </div>
        <div className="xw-settings-header-actions">
          <div className="xw-segmented-control" role="tablist" aria-label="AI 配置模式">
            <button type="button" className={mode === "website" ? "active" : ""} onClick={() => switchMode("website")}>
              网站配置
            </button>
            <button type="button" className={mode === "manual" ? "active" : ""} onClick={() => switchMode("manual")}>
              手动配置
            </button>
          </div>
          {mode === "manual" ? (
            <button className="xw-secondary-button compact" type="button" onClick={() => setShowSecrets((value) => !value)}>
              {showSecrets ? <EyeOff size={15} /> : <Eye size={15} />}
              {showSecrets ? "隐藏密钥" : "显示密钥"}
            </button>
          ) : (
            <button className="xw-secondary-button compact" type="button" onClick={() => void controller.refreshWebsiteAiDashboard()} disabled={controller.websiteAiBusy}>
              <RefreshCw size={15} />
              刷新账号
            </button>
          )}
        </div>
      </div>
      {mode === "manual" ? (
        <ManualAiSettings config={activeConfig} profile={manualProfile} controller={controller} showSecrets={showSecrets} onProfileChange={patchManualProfile} />
      ) : (
        <div className="xw-settings-list ai">
          <section className="xw-settings-section">
            <div className="xw-settings-section-head">
              <strong>网站账号</strong>
              <span>{websiteLoggedIn ? "已接入网站个人页中转配置。" : "使用 QQ 邮箱登录后读取个人页模型和额度。"}</span>
            </div>
            <div className="xw-website-entry-actions">
              <a className="xw-secondary-button compact" href={WEBSITE_REGISTER_URL} target="_blank" rel="noreferrer">
                <ExternalLink size={14} />
                注册
              </a>
              <a className="xw-secondary-button compact" href={WEBSITE_HOME_URL} target="_blank" rel="noreferrer">
                <ExternalLink size={14} />
                前往网站
              </a>
            </div>
            {websiteLoggedIn && websiteDashboard?.account ? (
              <div className="xw-website-account">
                <div>
                  <strong>{websiteDashboard.account.email || websiteDashboard.account.name || "网站账号"}</strong>
                  <span>{websiteDashboard.account.enabled ? "账号可用" : "账号已停用"}</span>
                </div>
                <div className="xw-website-account-actions">
                  <button className="xw-secondary-button compact" type="button" onClick={() => openWebsiteDialog("redeem")} disabled={!websiteLoggedIn || controller.websiteAiRedeemBusy}>
                    <Gift size={14} />
                    兑换
                  </button>
                  <button className="xw-secondary-button compact" type="button" onClick={() => openWebsiteDialog("recharge")} disabled={!websiteLoggedIn || controller.websiteAiRechargeBusy}>
                    <WalletCards size={14} />
                    充值
                  </button>
                  <button className="xw-secondary-button compact" type="button" onClick={() => setWebsiteLoginVisible((value) => !value)}>
                    切换账号
                  </button>
                </div>
                <div className="xw-website-stat-row">
                  <span>余额 {formatCompactNumber(websiteDashboard.account.balance)}</span>
                  <span>已用 {formatCompactNumber(websiteDashboard.account.used)}</span>
                  <span>并发 {websiteDashboard.max_concurrency || "-"}</span>
                  <span>RPM {websiteDashboard.max_rpm || "-"}</span>
                  <span>TPM {websiteDashboard.max_tpm || "-"}</span>
                </div>
              </div>
            ) : (
              <p className="xw-feature-empty">尚未登录网站配置。</p>
            )}
            {(websiteLoginVisible || !websiteLoggedIn) && (
              <form className="xw-website-login-form" onSubmit={submitWebsiteLogin}>
                <TextSettingRow label="QQ 邮箱" value={websiteEmail} placeholder="123456@qq.com" onChange={setWebsiteEmail} />
                <label className="xw-setting-field">
                  <span>密码</span>
                  <input type="password" value={websitePassword} autoComplete="current-password" onChange={(event) => setWebsitePassword(event.target.value)} />
                </label>
                <button className="xw-primary-button compact" type="submit" disabled={controller.websiteAiBusy || !websiteEmail.trim() || !websitePassword}>
                  登录网站
                </button>
              </form>
            )}
          </section>

          <section className="xw-settings-section">
            <div className="xw-settings-section-head">
              <strong>网站模型</strong>
              <span>软件会在本地隐藏写入中转连接信息，界面只保留可选模型。</span>
            </div>
            <div className="xw-settings-grid">
              <SelectSettingRow
                label="语言模型"
                value={websiteModel}
                placeholder="登录后读取模型"
                options={websiteModels.map((item) => ({ value: item.id, label: item.provider ? `${item.name} · ${item.provider}` : item.name }))}
                onChange={(value) => patchWebsiteProfile({ model: value })}
              />
              {websiteEmbeddingModels.length > 0 && (
                <SelectSettingRow
                  label="向量模型"
                  value={websiteEmbeddingModel}
                  placeholder="可选"
                  options={websiteEmbeddingModels.map((item) => ({ value: item.id, label: item.provider ? `${item.name} · ${item.provider}` : item.name }))}
                  onChange={(value) => patchWebsiteProfile({ embedding_model: value, embedding_enabled: true })}
                />
              )}
              <SliderSettingRow label="temperature" value={websiteTemp} min={0} max={2} step={0.01} onChange={(value) => patchWebsiteProfile({ temp: value })} />
              <SliderSettingRow label="top_p" value={websiteTopP} min={0} max={1} step={0.01} onChange={(value) => patchWebsiteProfile({ top_p: value })} />
            </div>
          </section>

          <WebsiteWebSearchSettings config={activeConfig} controller={controller} />
        </div>
      )}
      <SoftwareUpdateSettings />
      <div className="xw-feature-actions">
        {mode === "manual" ? (
          <>
            <button className="xw-primary-button compact" onClick={controller.saveConfig} disabled={controller.configBusy}>保存设置</button>
            <button className="xw-secondary-button compact" onClick={controller.refreshLicense} disabled={controller.configBusy}>刷新授权</button>
            <span>{controller.configMessage || "设置会应用到后续生成和会话。"}</span>
          </>
        ) : (
          <>
            <button className="xw-primary-button compact" onClick={applyWebsiteConfig} disabled={controller.websiteAiBusy || !websiteModel}>应用网站配置</button>
            <button className="xw-secondary-button compact" onClick={() => void controller.refreshWebsiteAiDashboard()} disabled={controller.websiteAiBusy}>刷新网站状态</button>
            <span>{controller.websiteAiMessage || websiteDashboard?.message || "网站配置会应用到后续聊天、生成和技能调用。"}</span>
          </>
        )}
      </div>
      {websiteDialog === "redeem" && (
        <WebsiteRedeemDialog
          code={redeemCode}
          busy={controller.websiteAiRedeemBusy}
          message={controller.websiteAiRedeemMessage}
          purchaseUrl={websiteDashboard?.redeem_purchase_url || ""}
          onChange={setRedeemCode}
          onSubmit={submitRedeem}
          onClose={() => setWebsiteDialog(null)}
        />
      )}
      {websiteDialog === "recharge" && (
        <WebsiteRechargeDialog
          options={rechargeOptions}
          selectedIndex={selectedRechargeIndex}
          order={controller.websiteAiRechargeOrder}
          busy={controller.websiteAiRechargeBusy}
          message={controller.websiteAiRechargeMessage}
          fallbackQr={websiteDashboard?.recharge_qr || ""}
          onSelect={setSelectedRechargeIndex}
          onCreate={createRechargeOrder}
          onRefresh={refreshRechargeOrder}
          onClose={() => setWebsiteDialog(null)}
        />
      )}
    </section>
  );
}

function SoftwareUpdateSettings() {
  const [status, setStatus] = useState<DesktopUpdateStatus | null>(null);
  const [busyAction, setBusyAction] = useState<"check" | "download" | "install" | "">("");
  const updatesApi = typeof window !== "undefined" ? window.xiaoshuoDesktop?.updates : undefined;
  const desktopAvailable = Boolean(updatesApi);
  const busy = busyAction !== "" || status?.state === "checking" || status?.state === "downloading";
  const canCheck = Boolean(updatesApi && status?.canCheck) && status?.state !== "checking" && status?.state !== "downloading";
  const canDownload = Boolean(updatesApi && status?.state === "available") && !busyAction;
  const canInstall = Boolean(updatesApi && status?.state === "downloaded") && !busyAction;

  useEffect(() => {
    if (!updatesApi) {
      return;
    }
    let mounted = true;
    void updatesApi.getStatus().then((nextStatus) => {
      if (mounted) {
        setStatus(nextStatus);
      }
    });
    const unsubscribe = updatesApi.onStatus((nextStatus) => {
      if (mounted) {
        setStatus(nextStatus);
      }
    });
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, [updatesApi]);

  async function runUpdateAction(action: "check" | "download" | "install") {
    if (!updatesApi) {
      return;
    }
    setBusyAction(action);
    try {
      if (action === "check") {
        setStatus(await updatesApi.check());
      } else if (action === "download") {
        setStatus(await updatesApi.download());
      } else {
        await updatesApi.installAndRestart();
      }
    } finally {
      setBusyAction("");
    }
  }

  return (
    <section className="xw-settings-section xw-update-section">
      <div className="xw-settings-section-head">
        <strong>软件更新</strong>
        <span>优先通过国内镜像检查完整桌面软件更新，失败后回退 GitHub，不使用网站授权或客户端 GitHub token。</span>
      </div>
      <div className="xw-update-panel">
        <div className="xw-update-status-grid">
          <StatusRow label="当前版本" value={status?.currentVersion || "开发预览"} />
          <StatusRow label="最新版本" value={status?.latestVersion || "-"} />
          <StatusRow label="状态" value={describeUpdateStatus(status, desktopAvailable)} />
          <StatusRow label="更新源" value={describeUpdateSource(status?.updateSource)} />
          <StatusRow label="检查时间" value={status?.checkedAt ? formatDateTime(status.checkedAt) : "-"} />
        </div>
        {status?.state === "downloading" && (
          <div className="xw-update-progress">
            <div>
              <span>下载进度</span>
              <strong>{Math.round(status.percent || 0)}%</strong>
            </div>
            <div className="xw-update-progress-track">
              <span style={{ width: `${Math.max(0, Math.min(100, status.percent || 0))}%` }} />
            </div>
            <small>
              {formatUpdateBytes(status.transferred || 0)} / {formatUpdateBytes(status.total || 0)}
              {status.bytesPerSecond ? ` · ${formatUpdateBytes(status.bytesPerSecond)}/s` : ""}
            </small>
          </div>
        )}
        {status?.releaseNotes && <pre className="xw-update-notes">{trimUpdateNotes(status.releaseNotes)}</pre>}
        {status?.error && <p className="xw-update-error">{status.error}</p>}
        {!desktopAvailable && <p className="xw-feature-empty">仅桌面安装版可用。当前浏览器预览不能执行自动更新。</p>}
        <div className="xw-update-actions">
          <button className="xw-secondary-button compact" type="button" onClick={() => void runUpdateAction("check")} disabled={!canCheck}>
            <RefreshCw size={14} />
            {busyAction === "check" || status?.state === "checking" ? "检查中" : "检查更新"}
          </button>
          <button className="xw-secondary-button compact" type="button" onClick={() => void runUpdateAction("download")} disabled={!canDownload}>
            <Download size={14} />
            {busyAction === "download" || status?.state === "downloading" ? "下载中" : "下载更新"}
          </button>
          <button className="xw-primary-button compact" type="button" onClick={() => void runUpdateAction("install")} disabled={!canInstall}>
            <ArchiveRestore size={14} />
            重启安装
          </button>
        </div>
      </div>
    </section>
  );
}

function StatusRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="xw-status-row">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function describeUpdateStatus(status: DesktopUpdateStatus | null, desktopAvailable: boolean): string {
  if (!desktopAvailable) {
    return "非桌面环境";
  }
  if (!status) {
    return "读取中";
  }
  if (!status.canCheck) {
    return "开发模式不可用";
  }
  if (status.state === "checking") {
    return "正在检查";
  }
  if (status.state === "available") {
    return "发现新版本";
  }
  if (status.state === "not_available") {
    return "已是最新";
  }
  if (status.state === "downloading") {
    return "正在下载";
  }
  if (status.state === "downloaded") {
    return "已下载，等待安装";
  }
  if (status.state === "error") {
    return "检查失败";
  }
  return "待检查";
}

function describeUpdateSource(source: DesktopUpdateStatus["updateSource"]): string {
  if (source === "mirror") {
    return "国内镜像";
  }
  if (source === "github") {
    return "GitHub";
  }
  return "-";
}

function formatUpdateBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return "0 B";
  }
  if (value >= 1024 * 1024 * 1024) {
    return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
  }
  if (value >= 1024 * 1024) {
    return `${(value / 1024 / 1024).toFixed(1)} MB`;
  }
  if (value >= 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }
  return `${Math.round(value)} B`;
}

function formatBytes(value: number): string {
  return formatUpdateBytes(value);
}

function formatDateShort(value: string): string {
  if (!value) {
    return "-";
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return value;
  }
  return new Date(timestamp).toLocaleDateString("zh-CN", {
    month: "2-digit",
    day: "2-digit"
  });
}

function trimUpdateNotes(value: string): string {
  const normalized = value.trim();
  if (normalized.length <= 900) {
    return normalized;
  }
  return `${normalized.slice(0, 900)}...`;
}

function normalizeUiAiProfile(profile: Partial<AiConfigProfile> | null | undefined): AiConfigProfile {
  return {
    api_key: profile?.api_key || "",
    base_url: profile?.base_url || "",
    model: profile?.model || "",
    temp: profile?.temp ?? 0.7,
    top_p: profile?.top_p ?? 1,
    secondary_api_key: profile?.secondary_api_key || "",
    secondary_base_url: profile?.secondary_base_url || "",
    secondary_model: profile?.secondary_model || "",
    secondary_temp: profile?.secondary_temp ?? 0.5,
    secondary_top_p: profile?.secondary_top_p ?? 1,
    embedding_enabled: Boolean(profile?.embedding_enabled),
    embedding_api_key: profile?.embedding_api_key || "",
    embedding_base_url: profile?.embedding_base_url || "",
    embedding_model: profile?.embedding_model || "",
    license_account_key: profile?.license_account_key || ""
  };
}

function webSearchTogglePatch(config: AppConfig, enabled: boolean): Partial<AppConfig> {
  return {
    web_search_enabled: enabled,
    ...(enabled && config.web_search_provider === "custom" && !config.web_search_base_url?.trim() ? { web_search_provider: "bing" as const } : {})
  };
}

function WebsiteWebSearchSettings({ config, controller }: { config: AppConfig; controller: WorkbenchController }) {
  function savePatch(patch: Partial<AppConfig>) {
    void controller.patchAndSaveConfig(patch, "联网素材搜索设置已保存。");
  }

  return (
    <section className="xw-settings-section">
      <div className="xw-settings-section-head">
        <strong>联网素材搜索</strong>
        <span>网站配置也会使用这组搜索设置；Bing 无需额外密钥，自定义搜索密钥仍在手动配置页维护。</span>
      </div>
      <div className="xw-settings-grid">
        <ToggleSettingRow
          label="联网素材搜索"
          checked={Boolean(config.web_search_enabled)}
          onChange={() => savePatch(webSearchTogglePatch(config, !config.web_search_enabled))}
        />
        <label className="xw-setting-field">
          <span>搜索来源</span>
          <select
            value={config.web_search_provider === "custom" ? "custom" : "bing"}
            onChange={(event) => savePatch({ web_search_provider: event.target.value === "custom" ? "custom" : "bing" })}
          >
            <option value="bing">Bing</option>
            <option value="custom">自定义 API</option>
          </select>
        </label>
        <NumberSettingRow label="结果数量" value={config.web_search_max_results || 3} min={1} max={5} onChange={(value) => savePatch({ web_search_max_results: value })} />
        <NumberSettingRow label="搜索超时秒数" value={config.web_search_timeout || 10} min={3} max={60} onChange={(value) => savePatch({ web_search_timeout: value })} />
        <NumberSettingRow label="素材上下文字符" value={config.web_search_context_chars || 3000} min={800} max={8000} onChange={(value) => savePatch({ web_search_context_chars: value })} />
      </div>
    </section>
  );
}

function WebsiteRedeemDialog({
  code,
  busy,
  message,
  purchaseUrl,
  onChange,
  onSubmit,
  onClose
}: {
  code: string;
  busy: boolean;
  message: string;
  purchaseUrl: string;
  onChange: (value: string) => void;
  onSubmit: (event: ReactFormEvent<HTMLFormElement>) => void;
  onClose: () => void;
}) {
  return (
    <div className="xw-website-modal-backdrop" onClick={onClose}>
      <form className="xw-website-modal" onSubmit={onSubmit} onClick={(event) => event.stopPropagation()} aria-modal="true" role="dialog">
        <div className="xw-website-modal-head">
          <div>
            <strong>兑换码</strong>
            <span>额度码和工具授权码都可以在这里兑换。</span>
          </div>
          <button className="xw-secondary-button compact" type="button" onClick={onClose}>
            关闭
          </button>
        </div>
        {purchaseUrl && (
          <a className="xw-website-link-button" href={purchaseUrl} target="_blank" rel="noreferrer">
            <ExternalLink size={14} />
            购买兑换码
          </a>
        )}
        <label className="xw-setting-field">
          <span>输入兑换码</span>
          <input value={code} autoFocus placeholder="XXXX-XXXX-XXXX" onChange={(event) => onChange(event.target.value)} />
        </label>
        <button className="xw-primary-button compact" type="submit" disabled={busy || !code.trim()}>
          {busy ? "兑换中..." : "立即兑换"}
        </button>
        {message && <p className="xw-website-modal-message">{message}</p>}
      </form>
    </div>
  );
}

function WebsiteRechargeDialog({
  options,
  selectedIndex,
  order,
  busy,
  message,
  fallbackQr,
  onSelect,
  onCreate,
  onRefresh,
  onClose
}: {
  options: WebsiteAiRechargeOption[];
  selectedIndex: number;
  order: WebsiteAiRechargeOrder | null;
  busy: boolean;
  message: string;
  fallbackQr: string;
  onSelect: (value: number) => void;
  onCreate: () => void;
  onRefresh: () => void;
  onClose: () => void;
}) {
  const selected = options.find((item) => item.option_index === selectedIndex) || options[0] || null;
  const paymentQr = order?.payment_qr || (!options.length ? fallbackQr : "");
  const paymentLink = order?.payment_url || order?.payment_code || "";
  const canCreate = Boolean(selected) && !busy && order?.status !== "pending" && order?.status !== "paid";

  return (
    <div className="xw-website-modal-backdrop" onClick={onClose}>
      <section className="xw-website-modal recharge" onClick={(event) => event.stopPropagation()} aria-modal="true" role="dialog">
        <div className="xw-website-modal-head">
          <div>
            <strong>充值中心</strong>
            <span>选择档位后创建订单，支付成功会自动刷新余额。</span>
          </div>
          <button className="xw-secondary-button compact" type="button" onClick={onClose}>
            关闭
          </button>
        </div>

        {options.length > 0 ? (
          <>
            <div className="xw-recharge-option-grid">
              {options.map((option) => (
                <button
                  key={option.option_index}
                  type="button"
                  className={`xw-recharge-option ${option.option_index === selectedIndex ? "selected" : ""}`}
                  onClick={() => onSelect(option.option_index)}
                  disabled={busy || order?.status === "pending"}
                >
                  <strong>到账 {formatMoney(option.amount)}</strong>
                  <span>实付 {formatMoney(option.real_price)}</span>
                  {option.real_price < option.amount && <small>节省 {formatMoney(option.amount - option.real_price)}</small>}
                </button>
              ))}
            </div>
            {selected && (
              <div className="xw-recharge-summary">
                <span>本次实付</span>
                <strong>{formatMoney(selected.real_price || selected.amount)}</strong>
              </div>
            )}
            <button className="xw-primary-button compact" type="button" onClick={onCreate} disabled={!canCreate}>
              {describeRechargeActionLabel(order, busy)}
            </button>
          </>
        ) : (
          <div className="xw-recharge-empty">
            {fallbackQr ? (
              <>
                <span>管理员暂未配置充值档位，请扫码联系充值。</span>
                <img src={fallbackQr} alt="充值二维码" />
              </>
            ) : (
              <span>管理员暂未配置充值方式</span>
            )}
          </div>
        )}

        {order && (
          <div className="xw-recharge-order">
            <div>
              <span>订单号</span>
              <strong>{order.order_id}</strong>
            </div>
            <div>
              <span>当前状态</span>
              <strong>{describeRechargeStatus(order.status)}{order.status === "pending" ? "（自动同步中）" : ""}</strong>
            </div>
            {order.expire_at && (
              <div>
                <span>过期时间</span>
                <strong>{formatDateTime(order.expire_at)}</strong>
              </div>
            )}
            {order.payment_error && <p>{order.payment_error}</p>}
            <button className="xw-secondary-button compact" type="button" onClick={onRefresh} disabled={busy || !order.order_id}>
              <RefreshCw size={14} />
              手动刷新
            </button>
          </div>
        )}

        {paymentQr && (
          <div className="xw-recharge-qr">
            <img src={paymentQr} alt="充值二维码" />
          </div>
        )}
        {paymentLink && (
          <a className="xw-website-link-button" href={paymentLink} target="_blank" rel="noreferrer">
            <ExternalLink size={14} />
            打开支付链接
          </a>
        )}
        {message && <p className="xw-website-modal-message">{message}</p>}
      </section>
    </div>
  );
}

function ManualAiSettings({
  config,
  profile,
  controller,
  showSecrets,
  onProfileChange
}: {
  config: AppConfig;
  profile: Partial<AiConfigProfile>;
  controller: WorkbenchController;
  showSecrets: boolean;
  onProfileChange: (patch: Partial<AiConfigProfile>) => void;
}) {
  return (
    <div className="xw-settings-list ai">
      <section className="xw-settings-section">
        <div className="xw-settings-section-head">
          <strong>主模型</strong>
          <span>聊天、写作和技能执行的默认线路</span>
        </div>
        <div className="xw-settings-grid">
          <SecretSettingRow label="API Key" value={profile.api_key || ""} visible={showSecrets} onChange={(value) => onProfileChange({ api_key: value })} />
          <TextSettingRow label="Base URL" value={profile.base_url || ""} placeholder="https://api.openai.com/v1" onChange={(value) => onProfileChange({ base_url: value })} />
          <TextSettingRow label="模型" value={profile.model || ""} placeholder="gpt-4.1-mini" onChange={(value) => onProfileChange({ model: value })} />
          <SliderSettingRow label="temperature" value={profile.temp ?? 0.7} min={0} max={2} step={0.01} onChange={(value) => onProfileChange({ temp: value })} />
          <SliderSettingRow label="top_p" value={profile.top_p ?? 1} min={0} max={1} step={0.01} onChange={(value) => onProfileChange({ top_p: value })} />
        </div>
      </section>

      <section className="xw-settings-section">
        <div className="xw-settings-section-head">
          <strong>副模型</strong>
          <span>可用于备用线路或轻量任务，未填写时继续使用主模型</span>
        </div>
        <div className="xw-settings-grid">
          <SecretSettingRow label="副 API Key" value={profile.secondary_api_key || ""} visible={showSecrets} onChange={(value) => onProfileChange({ secondary_api_key: value })} />
          <TextSettingRow label="副 Base URL" value={profile.secondary_base_url || ""} placeholder="留空沿用主 Base URL" onChange={(value) => onProfileChange({ secondary_base_url: value })} />
          <TextSettingRow label="副模型" value={profile.secondary_model || ""} placeholder="可选" onChange={(value) => onProfileChange({ secondary_model: value })} />
          <SliderSettingRow label="temperature" value={profile.secondary_temp ?? 0.5} min={0} max={2} step={0.01} onChange={(value) => onProfileChange({ secondary_temp: value })} />
          <SliderSettingRow label="top_p" value={profile.secondary_top_p ?? 1} min={0} max={1} step={0.01} onChange={(value) => onProfileChange({ secondary_top_p: value })} />
        </div>
      </section>

      <section className="xw-settings-section">
        <div className="xw-settings-section-head">
          <strong>Embedding 与向量召回</strong>
          <span>用于项目索引、长期记忆和素材召回</span>
        </div>
        <div className="xw-settings-grid">
          <ToggleSettingRow label="启用向量召回" checked={Boolean(profile.embedding_enabled)} onChange={() => onProfileChange({ embedding_enabled: !profile.embedding_enabled })} />
          <SecretSettingRow label="Embedding API Key" value={profile.embedding_api_key || ""} visible={showSecrets} onChange={(value) => onProfileChange({ embedding_api_key: value })} />
          <TextSettingRow label="Embedding Base URL" value={profile.embedding_base_url || ""} onChange={(value) => onProfileChange({ embedding_base_url: value })} />
          <TextSettingRow label="Embedding 模型" value={profile.embedding_model || ""} onChange={(value) => onProfileChange({ embedding_model: value })} />
          <NumberSettingRow label="超时秒数" value={config.embedding_timeout || 60} min={5} max={300} onChange={(value) => controller.patchConfig({ embedding_timeout: value })} />
          <NumberSettingRow label="批大小" value={config.embedding_batch_size || 16} min={1} max={128} onChange={(value) => controller.patchConfig({ embedding_batch_size: value })} />
          <NumberSettingRow label="召回条数" value={config.vector_top_k || 10} min={1} max={40} onChange={(value) => controller.patchConfig({ vector_top_k: value })} />
          <NumberSettingRow label="召回上下文字符" value={config.vector_context_chars || 9000} min={1000} max={80000} onChange={(value) => controller.patchConfig({ vector_context_chars: value })} />
        </div>
      </section>

      <section className="xw-settings-section">
        <div className="xw-settings-section-head">
          <strong>联网素材搜索</strong>
          <span>优先使用 Bing，为会话和生成任务补充外部素材来源</span>
        </div>
        <div className="xw-settings-grid">
          <ToggleSettingRow label="联网素材搜索" checked={Boolean(config.web_search_enabled)} onChange={() => controller.patchConfig({ web_search_enabled: !config.web_search_enabled })} />
          <label className="xw-setting-field">
            <span>搜索来源</span>
            <select value={config.web_search_provider === "custom" ? "custom" : "bing"} onChange={(event) => controller.patchConfig({ web_search_provider: event.target.value === "custom" ? "custom" : "bing" })}>
              <option value="bing">Bing</option>
              <option value="custom">自定义 API</option>
            </select>
          </label>
          <SecretSettingRow label="Bing / 自定义 API Key" value={config.web_search_api_key || ""} visible={showSecrets} onChange={(value) => controller.patchConfig({ web_search_api_key: value })} />
          <TextSettingRow label="自定义 Base URL" value={config.web_search_base_url || ""} placeholder="自定义搜索时填写，Bing 可留空" onChange={(value) => controller.patchConfig({ web_search_base_url: value })} />
          <NumberSettingRow label="结果数量" value={config.web_search_max_results || 3} min={1} max={5} onChange={(value) => controller.patchConfig({ web_search_max_results: value })} />
          <NumberSettingRow label="搜索超时秒数" value={config.web_search_timeout || 10} min={3} max={60} onChange={(value) => controller.patchConfig({ web_search_timeout: value })} />
          <NumberSettingRow label="素材上下文字符" value={config.web_search_context_chars || 3000} min={800} max={8000} onChange={(value) => controller.patchConfig({ web_search_context_chars: value })} />
        </div>
      </section>

      <section className="xw-settings-section">
        <div className="xw-settings-section-head">
          <strong>授权</strong>
          <span>保存后可刷新当前设备授权状态</span>
        </div>
        <div className="xw-settings-grid">
          <SecretSettingRow label="授权账号 Key" value={profile.license_account_key || ""} visible={showSecrets} onChange={(value) => onProfileChange({ license_account_key: value })} />
        </div>
      </section>
    </div>
  );
}

function SelectSettingRow({
  label,
  value,
  placeholder,
  options,
  onChange
}: {
  label: string;
  value: string;
  placeholder?: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
}) {
  return (
    <label className="xw-setting-field">
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)} disabled={!options.length}>
        {!options.length && <option value="">{placeholder || "暂无可选项"}</option>}
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function formatCompactNumber(value: number): string {
  if (!Number.isFinite(value)) {
    return "0";
  }
  if (Math.abs(value) >= 10000) {
    return `${(value / 10000).toFixed(1)}万`;
  }
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function formatMoney(value: number): string {
  const amount = Number.isFinite(value) ? value : 0;
  return `¥${amount.toFixed(2)}`;
}

function describeRechargeStatus(status: string): string {
  if (status === "paid") {
    return "已支付";
  }
  if (status === "expired") {
    return "已过期";
  }
  if (status === "pending") {
    return "待支付";
  }
  return status || "未创建";
}

function describeRechargeActionLabel(order: WebsiteAiRechargeOrder | null, busy: boolean): string {
  if (busy) {
    return "创建订单中...";
  }
  if (order?.status === "paid") {
    return "余额已到账";
  }
  if (order?.status === "pending") {
    return "等待支付完成";
  }
  return "发起充值并自动到账";
}

function formatDateTime(value: string): string {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) {
    return value;
  }
  return new Date(timestamp).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function TextSettingRow({
  label,
  value,
  placeholder,
  onChange
}: {
  label: string;
  value: string;
  placeholder?: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="xw-setting-field">
      <span>{label}</span>
      <input value={value} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function SecretSettingRow({
  label,
  value,
  visible,
  onChange
}: {
  label: string;
  value: string;
  visible: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <label className="xw-setting-field">
      <span>{label}</span>
      <input type={visible ? "text" : "password"} value={value} autoComplete="off" onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function NumberSettingRow({
  label,
  value,
  min,
  max,
  onChange
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(Number.isFinite(value) ? value : min));

  useEffect(() => {
    setDraft(String(Number.isFinite(value) ? value : min));
  }, [value, min]);

  function commitDraft() {
    const parsed = Number(draft);
    const fallback = Number.isFinite(value) ? value : min;
    const next = Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.trunc(parsed))) : fallback;
    setDraft(String(next));
    if (next !== value) {
      onChange(next);
    }
  }

  return (
    <label className="xw-setting-field">
      <span>{label}</span>
      <input
        type="number"
        min={min}
        max={max}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commitDraft}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            commitDraft();
            event.currentTarget.blur();
          }
        }}
      />
    </label>
  );
}

function ToggleSettingRow({ label, checked, onChange }: { label: string; checked: boolean; onChange: () => void }) {
  return (
    <label className="xw-setting-row">
      <span>{label}</span>
      <input type="checkbox" checked={checked} onChange={onChange} />
    </label>
  );
}

function SliderSettingRow({
  label,
  value,
  min,
  max,
  step,
  onChange
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
}) {
  const displayValue = Number.isFinite(value) ? value : min;
  return (
    <label className="xw-setting-field slider">
      <span>{label}</span>
      <div className="xw-slider-control">
        <input type="range" min={min} max={max} step={step} value={displayValue} onChange={(event) => onChange(Number(event.target.value))} />
        <output>{displayValue.toFixed(2)}</output>
      </div>
    </label>
  );
}

function TerminalFeaturePage({ controller }: { controller: WorkbenchController }) {
  return (
    <section className="xw-feature-page terminal">
      <div className="xw-feature-toolbar">
        <strong>维护终端</strong>
        <span>常用命令和项目维护集中在这里</span>
      </div>
      {controller.snapshot && (
        <Suspense fallback={<LoadingState />}>
          <TerminalView runtime={runtime} snapshot={controller.snapshot} />
        </Suspense>
      )}
    </section>
  );
}

function ResultPreview({ controller }: { controller: WorkbenchController }) {
  const result = controller.latestSkillResult;
  const resultText = latestRunResultText(controller);
  if (!result && !controller.pendingGeneratedSave) {
    return null;
  }
  return (
    <article className="xw-feature-card result">
      <strong>运行结果</strong>
      <p>{resultText || "暂无文本结果"}</p>
      {controller.pendingGeneratedSave && (
        <div className="xw-feature-actions">
          <button className="xw-secondary-button compact" onClick={() => controller.savePendingGenerated("append")} disabled={controller.operationsBusy}>追加保存</button>
          <button className="xw-primary-button compact" onClick={() => controller.savePendingGenerated("replace")} disabled={controller.operationsBusy}>覆盖保存</button>
          <button className="xw-secondary-button compact" onClick={controller.copyPendingGeneratedContent} disabled={controller.operationsBusy}>复制</button>
          <button className="xw-danger-button compact" onClick={controller.discardPendingGenerated} disabled={controller.operationsBusy}>丢弃</button>
        </div>
      )}
    </article>
  );
}

function describeSkillId(skillId: string): string {
  const labels: Record<string, string> = {
    batch_generate: "批量生成",
    disassemble_book: "拆书",
    continue_disassemble: "继续拆书",
    book_fusion: "融梗",
    consistency_check: "一致性检查",
    scan_pits: "扫描伏笔",
    lore_extract: "提取设定"
  };
  return labels[skillId] || skillId;
}

function RailResultPreview({ controller }: { controller: WorkbenchController }) {
  const activeJob = [
    controller.selectedJobDetail,
    ...(controller.snapshot?.jobs || []).slice().reverse()
  ].find((job) => job && (job.status === "running" || job.status === "queued") && job.kind !== "summarize_conversation") || null;

  const latestJob = [
    controller.selectedJobDetail,
    ...(controller.snapshot?.jobs || []).slice().reverse()
  ].find((job) => job && job.kind !== "summarize_conversation") || null;

  const isSkillRunning = controller.operationsBusy || controller.conversationBusy || controller.sendingMessage;
  const isJobRunning = activeJob !== null;
  const isLive = isSkillRunning || isJobRunning;

  const resultText = latestRunResultText(controller);

  if (!isLive && !resultText && !latestJob) {
    return null;
  }

  let progressPercent = 0;
  let showProgressBar = false;
  let isIndeterminate = false;
  let title = "运行结果";
  let statusMessage = "";

  if (activeJob) {
    showProgressBar = true;
    progressPercent = Math.max(0, Math.min(100, Math.round((activeJob.progress || 0) * 100)));
    title = describeJobKind(activeJob.kind);
    statusMessage = activeJob.message || crawlJobStatusLabel(activeJob.status);
  } else if (isSkillRunning) {
    showProgressBar = true;
    isIndeterminate = true;
    const skillId = controller.latestSkillResult?.data?.skill_id;
    title = skillId ? `正在执行: ${describeSkillId(String(skillId))}` : "正在执行技能";
    statusMessage = controller.operationsMessage || controller.conversationMessage || "正在处理中...";
  } else if (controller.pendingGeneratedSave) {
    const skillId = controller.pendingGeneratedSave.skillId;
    title = skillId ? `${describeSkillId(String(skillId))}结果已就绪` : "生成结果已就绪";
    statusMessage = controller.operationsMessage || "等待选择写入方式";
  } else if (controller.latestSkillResult) {
    const skillId = controller.latestSkillResult?.data?.skill_id;
    title = skillId ? `${describeSkillId(String(skillId))}执行完成` : "执行完成";
    statusMessage = controller.operationsMessage || "技能执行完成";
  } else if (latestJob) {
    title = describeJobKind(latestJob.kind);
    statusMessage = latestJob.status === "done" 
      ? "任务已完成" 
      : latestJob.status === "failed" 
        ? `任务失败: ${latestJob.message || "未知错误"}` 
        : crawlJobStatusLabel(latestJob.status);
  }

  const resultPaths = (latestJob && latestJob.status === "done") 
    ? extractPathsFromUnknownResult(latestJob.result) 
    : [];

  return (
    <article className="xw-rail-result" aria-live="polite">
      <div className="xw-crawl-progress-head">
        <strong>{title}</strong>
        {showProgressBar && !isIndeterminate && <span>{progressPercent}%</span>}
      </div>

      {showProgressBar && (
        <div className={`xw-crawl-progress-track ${isIndeterminate ? "xw-progress-indeterminate" : ""}`} aria-hidden="true">
          <span style={isIndeterminate ? undefined : { width: `${progressPercent}%` }} />
        </div>
      )}

      {statusMessage && <small style={{ color: "var(--xw-muted)", fontSize: "12px", display: "block", marginTop: "4px" }}>{statusMessage}</small>}

      {resultText && (
        <p style={{ marginTop: "6px" }}>{resultText}</p>
      )}

      {controller.pendingGeneratedSave && (
        <div className="xw-feature-actions" style={{ display: "flex", gap: "8px", marginTop: "8px", flexWrap: "wrap" }}>
          <button className="xw-secondary-button compact" onClick={() => controller.savePendingGenerated("append")} disabled={controller.operationsBusy}>追加保存</button>
          <button className="xw-primary-button compact" onClick={() => controller.savePendingGenerated("replace")} disabled={controller.operationsBusy}>覆盖保存</button>
          <button className="xw-secondary-button compact" onClick={controller.copyPendingGeneratedContent} disabled={controller.operationsBusy}>复制</button>
          <button className="xw-danger-button compact" onClick={controller.discardPendingGenerated} disabled={controller.operationsBusy}>丢弃</button>
        </div>
      )}

      {resultPaths.length > 0 && (
        <div className="xw-crawl-result-card" style={{ padding: 0, border: "none", background: "none", gap: "6px", marginTop: "8px" }}>
          <strong style={{ fontSize: "13px" }}>已写入文件</strong>
          <div style={{ display: "grid", gap: "6px" }}>
            {resultPaths.map((path) => (
              <button 
                key={path} 
                className="xw-secondary-button compact" 
                type="button" 
                onClick={() => void controller.openDocument(path)}
                style={{ justifyContent: "flex-start", textOverflow: "ellipsis", overflow: "hidden", whiteSpace: "nowrap" }}
              >
                {path}
              </button>
            ))}
          </div>
        </div>
      )}
    </article>
  );
}

function latestRunResultText(controller: WorkbenchController): string {
  return String(controller.pendingGeneratedSave?.content || controller.latestSkillResult?.result || controller.latestSkillResult?.content || "").trim();
}

function GuardBanner({
  title,
  detail,
  primaryLabel,
  secondaryLabel,
  onPrimary,
  onSecondary
}: {
  title: string;
  detail: string;
  primaryLabel: string;
  secondaryLabel: string;
  onPrimary: () => void;
  onSecondary: () => void;
}) {
  return (
    <section className="xw-guard-banner">
      <div>
        <strong>{title}</strong>
        <p>{detail}</p>
      </div>
      <div>
        <button className="xw-secondary-button compact" onClick={onSecondary}>{secondaryLabel}</button>
        <button className="xw-primary-button compact" onClick={onPrimary}>{primaryLabel}</button>
      </div>
    </section>
  );
}

function AssistantRail({
  controller,
  mode,
  onModeChange,
  onSelectFeature
}: {
  controller: WorkbenchController;
  mode: RailMode;
  onModeChange: (mode: RailMode) => void;
  onSelectFeature: (feature: CenterFeature) => void;
}) {
  const activeConversationId = controller.conversationDetail?.id || controller.activeConversationSummary?.id || "";
  const selectedMode = railModes.find((item) => item.key === mode) || railModes[0];
  const webSearchEnabled = Boolean(controller.configDraft?.web_search_enabled);
  const humanizerEnabled = Boolean(controller.configDraft?.humanizer_enabled);
  const activeConversation = controller.conversationDetail || controller.activeConversationSummary;
  const currentSkillId = activeConversation?.current_skill || "";
  const currentSkill = controller.snapshot?.skills.find((skill) => skill.id === currentSkillId) || null;
  const currentSkillName = currentSkill?.name || currentSkillId || (controller.sendingMessage ? "自动判断中" : "未调用技能");
  const currentSkillStatus = controller.sendingMessage ? "调用中" : currentSkillId ? "已完成" : "待命";
  const conversationItems = controller.snapshot?.conversations || [];
  const activeConversationTitle = activeConversation?.title || (activeConversationId ? "未命名对话" : "未选择会话");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [renamingConversationId, setRenamingConversationId] = useState("");
  const [conversationTitleDraft, setConversationTitleDraft] = useState("");
  const sessionSelectorRef = useRef<HTMLDivElement | null>(null);
  const selectConversationTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!historyOpen) {
      return;
    }

    function handlePointerDown(event: PointerEvent) {
      const target = event.target as Node | null;
      if (target && sessionSelectorRef.current?.contains(target)) {
        return;
      }
      setHistoryOpen(false);
      setRenamingConversationId("");
    }

    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [historyOpen]);

  useEffect(() => {
    return () => {
      if (selectConversationTimerRef.current) {
        window.clearTimeout(selectConversationTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!renamingConversationId) {
      return;
    }
    if (conversationItems.some((item) => item.id === renamingConversationId)) {
      return;
    }
    setRenamingConversationId("");
  }, [conversationItems, renamingConversationId]);

  function scheduleConversationSelection(item: ConversationSummary) {
    if (controller.conversationBusy || renamingConversationId === item.id) {
      return;
    }

    if (selectConversationTimerRef.current) {
      window.clearTimeout(selectConversationTimerRef.current);
    }

    selectConversationTimerRef.current = window.setTimeout(() => {
      selectConversationTimerRef.current = null;
      setHistoryOpen(false);
      void controller.loadConversation(item.id, { activateTab: false });
    }, 220);
  }

  function beginConversationRename(item: ConversationSummary) {
    if (selectConversationTimerRef.current) {
      window.clearTimeout(selectConversationTimerRef.current);
      selectConversationTimerRef.current = null;
    }

    setHistoryOpen(true);
    setRenamingConversationId(item.id);
    setConversationTitleDraft(item.title || "");
  }

  async function submitConversationRename(item: ConversationSummary) {
    const nextTitle = conversationTitleDraft.trim();
    setRenamingConversationId("");
    if (!nextTitle || nextTitle === item.title) {
      return;
    }

    await controller.updateConversationTitle(nextTitle, item.id);
  }

  function toggleWebSearch() {
    const config = controller.configDraft;
    if (!config) {
      return;
    }
    void controller.patchAndSaveConfig(webSearchTogglePatch(config, !webSearchEnabled), !webSearchEnabled ? "联网搜索已开启。" : "联网搜索已关闭。");
  }

  function submitAiMessage() {
    if (controller.conversationBusy || controller.sendingMessage || !controller.messageInput.trim()) {
      return;
    }
    onSelectFeature("conversations");
    void controller.sendMessage();
  }

  function handleAiInputKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) {
      return;
    }
    event.preventDefault();
    submitAiMessage();
  }

  const latestCrawlJob =
    [
      controller.selectedJobDetail,
      ...(controller.snapshot?.jobs || []).slice().reverse()
    ].find((job): job is JobInfo => Boolean(job && job.kind === "novel_crawl")) || null;

  return (
    <aside className="xw-right surface">
      <LicensePill licensed={Boolean(controller.snapshot?.license.licensed)} />
      <div className="xw-rail-grid">
        {railModes.map((item) => (
          <button
            key={item.key}
            className={mode === item.key ? "active" : ""}
            onClick={() => {
              onModeChange(item.key);
            }}
          >
            <item.icon size={16} />
            <span>{item.label}</span>
          </button>
        ))}
      </div>

      {mode === "ai" ? (
        <section className="xw-ai-panel">
          <h2>多会话写作助手</h2>
          <div className="xw-ai-actions">
            <button
              className={`xw-secondary-button ${webSearchEnabled ? "active" : ""}`}
              onClick={toggleWebSearch}
              disabled={controller.configBusy}
            >
              <ScanSearch size={15} />
              <span>联网搜索</span>
            </button>
            <button className="xw-secondary-button" onClick={() => onSelectFeature("conversations")}>
              <Bot size={15} />
              <span>AI 对话框</span>
            </button>
            <button className="xw-secondary-button" onClick={controller.createConversation} disabled={controller.conversationBusy}>
              <MessageSquarePlus size={15} />
              <span>新开对话</span>
            </button>
            <button
              className={`xw-secondary-button ${humanizerEnabled ? "active" : ""}`}
              onClick={() => controller.patchConfig({ humanizer_enabled: !humanizerEnabled })}
            >
              <Sparkles size={15} />
              <span>去AI味</span>
            </button>
          </div>
          <div className="xw-session-tools">
            <div className="xw-session-label">
              <span>当前会话</span>
              <small>{controller.snapshot?.conversations.length || 0} 个会话可用</small>
            </div>
            <div className={`xw-session-selector ${historyOpen ? "open" : ""}`} ref={sessionSelectorRef}>
              <button
                className={`xw-session-current ${historyOpen ? "active" : ""}`}
                onClick={() => setHistoryOpen((value) => !value)}
                disabled={controller.conversationBusy && !conversationItems.length}
              >
                <div>
                  <span>当前会话</span>
                  <strong title={activeConversationTitle}>{activeConversationTitle}</strong>
                </div>
                <small>{conversationItems.length ? `${conversationItems.length} 条历史` : "暂无历史"}</small>
              </button>
              {historyOpen && (
                <div className="xw-session-popover">
                  <div className="xw-session-popover-head">
                    <span>历史对话</span>
                    <small>{controller.conversationBusy ? "处理中" : `${conversationItems.length} 条`}</small>
                  </div>
                  <div className="xw-session-popover-list">
                    {conversationItems.length ? (
                      conversationItems.map((item) =>
                        renamingConversationId === item.id ? (
                          <div key={item.id} className={`xw-session-popover-item active ${item.id === activeConversationId ? "current" : ""}`}>
                            <input
                              className="xw-session-rename-input"
                              value={conversationTitleDraft}
                              placeholder="未命名对话"
                              onChange={(event) => setConversationTitleDraft(event.target.value)}
                              onBlur={() => void submitConversationRename(item)}
                              onKeyDown={(event) => {
                                if (event.key === "Enter") {
                                  event.preventDefault();
                                  void submitConversationRename(item);
                                }
                                if (event.key === "Escape") {
                                  event.preventDefault();
                                  setRenamingConversationId("");
                                }
                              }}
                              autoFocus
                            />
                            <small>{item.id === activeConversationId ? "当前" : `${item.message_count} 条`}</small>
                          </div>
                        ) : (
                          <button
                            key={item.id}
                            className={`xw-session-popover-item ${item.id === activeConversationId ? "active current" : ""}`}
                            onClick={() => scheduleConversationSelection(item)}
                            onDoubleClick={(event) => {
                              event.preventDefault();
                              beginConversationRename(item);
                            }}
                            disabled={controller.conversationBusy}
                          >
                            <span title={item.title || "未命名对话"}>{item.title || "未命名对话"}</span>
                            <small>{item.id === activeConversationId ? "当前" : `${item.message_count} 条`}</small>
                          </button>
                        )
                      )
                    ) : (
                      <div className="xw-session-empty">未选择会话</div>
                    )}
                  </div>
                </div>
              )}
            </div>
            <button className="xw-secondary-button compact" onClick={() => controller.summarizeConversation(true)} disabled={controller.conversationBusy || !activeConversationId}>
              <History size={15} />
              <span>压缩摘要</span>
            </button>
          </div>
          <div className="xw-current-skill-strip">
            <span>当前技能</span>
            <strong>{currentSkillName}</strong>
            <small>{currentSkillStatus}</small>
          </div>
          <div className="xw-context-actions">
            <button className="xw-secondary-button compact" onClick={controller.pinCurrentDocumentToConversation} disabled={!controller.activeDocumentPath || controller.conversationBusy}>
              <Pin size={14} />
              <span>固定文档</span>
            </button>
            <button className="xw-secondary-button compact" disabled>
              <Link size={14} />
              <span>固定段落</span>
            </button>
            <label className="xw-upload-button">
              <ArchiveRestore size={14} />
              <span>{controller.uploadingAttachment ? "上传中" : "上传文件"}</span>
              <input
                type="file"
                disabled={controller.uploadingAttachment || controller.conversationBusy}
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0] || null;
                  controller.uploadConversationAttachment(file);
                  event.currentTarget.value = "";
                }}
              />
            </label>
            <button className="xw-secondary-button compact" onClick={() => controller.setMessageInput("")}>清空上下文</button>
          </div>
          <textarea
            className="xw-ai-input"
            value={controller.messageInput}
            onChange={(event) => controller.setMessageInput(event.target.value)}
            onKeyDown={handleAiInputKeyDown}
            placeholder="输入写作目标、修稿要求或拆书要求，系统会按内容自动调用合适的技能。"
            spellCheck={false}
          />
          <div className="xw-send-row">
            <button className="xw-primary-button" onClick={submitAiMessage} disabled={controller.conversationBusy || controller.sendingMessage || !controller.messageInput.trim()}>
              <Send size={15} />
              <span>发送</span>
            </button>
            <button className="xw-secondary-button" onClick={controller.stopMessage} disabled={!controller.sendingMessage}>
              <Square size={15} />
              <span>停止</span>
            </button>
          </div>
          {(controller.conversationMessage || controller.documentMessage) && <p className="xw-status-line">{controller.conversationMessage || controller.documentMessage}</p>}
        </section>
      ) : mode === "crawl" ? (
        <CrawlRailPanel
          controller={controller}
          job={latestCrawlJob}
          onOpenFeature={() => onSelectFeature("crawl")}
          onBackToAi={() => onModeChange("ai")}
        />
      ) : (
        <section className="xw-ai-panel">
          <h2>{selectedMode.label}</h2>
          <p className="xw-helper">已在中间工作区打开对应功能页。常用写作入口仍保留在这里。</p>
          <button className="xw-primary-button" onClick={() => onSelectFeature(selectedMode.feature)}>
            <selectedMode.icon size={15} />
            <span>打开{selectedMode.label}</span>
          </button>
          <button className="xw-secondary-button" onClick={() => onModeChange("ai")}>
            <Bot size={15} />
            <span>返回 AI</span>
          </button>
        </section>
      )}
      <RailResultPreview controller={controller} />
    </aside>
  );
}

function CrawlRailPanel({
  controller,
  job,
  onOpenFeature,
  onBackToAi
}: {
  controller: WorkbenchController;
  job: JobInfo | null;
  onOpenFeature: () => void;
  onBackToAi: () => void;
}) {
  return (
    <section className="xw-ai-panel xw-crawl-rail">
      <div className="xw-rail-panel-head">
        <div>
          <h2>拆书</h2>
          <span>已在中间工作区打开对应功能页。联网爬取结果保留在下方。</span>
        </div>
        {job && <small className={`xw-job-pill ${job.status}`}>{crawlJobStatusLabel(job.status)}</small>}
      </div>

      <div className="xw-crawl-rail-actions">
        <button className="xw-primary-button" onClick={onOpenFeature}>
          <BookOpen size={15} />
          <span>打开拆书</span>
        </button>
        <button className="xw-secondary-button" onClick={onBackToAi}>
          <Bot size={15} />
          <span>返回 AI</span>
        </button>
      </div>
    </section>
  );
}

function crawlJobStatusLabel(status: JobInfo["status"]): string {
  const labels: Record<JobInfo["status"], string> = {
    queued: "排队中",
    running: "爬取中",
    done: "已完成",
    failed: "失败",
    cancelled: "已取消"
  };
  return labels[status];
}

function LicensePill({ licensed }: { licensed: boolean }) {
  return (
    <div className={`xw-license ${licensed ? "ready" : "idle"}`}>
      <ShieldCheck size={15} />
      <span>{licensed ? "已授权 / 永久" : "未授权"}</span>
    </div>
  );
}

function LoadingState() {
  return (
    <section className="state-panel">
      <div className="loading-line" />
      <div className="loading-line short" />
      <div className="loading-grid">
        <div className="loading-card" />
        <div className="loading-card" />
        <div className="loading-card" />
        <div className="loading-card" />
      </div>
    </section>
  );
}

function ErrorState({ message }: { message: string }) {
  return (
    <section className="state-panel error-panel">
      <h2>ArcWriter 暂时没连上本地服务</h2>
      <p>{message}</p>
      <p>当前默认后端地址是 `http://127.0.0.1:18453`，也可以用 `?api=` 指向别的实例。</p>
    </section>
  );
}
