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
  Columns,
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
import { AppShell } from "./layout/AppShell.js";
import { GuardBanner, AssistantRail, railModes, type RailMode } from "./layout/RightRail.js";
import { LeftSidebar } from "./layout/LeftSidebar.js";
import { CardDrawFeaturePage } from "./features/card-draw/CardDrawFeaturePage.js";
import { DisassembleFeaturePage } from "./features/disassembly/DisassemblyFeaturePage.js";
import { SettingsFeaturePage } from "./features/settings/SettingsFeaturePage.js";
import { SkillFeaturePage } from "./features/skills/SkillFeaturePage.js";
import { LedgerFeaturePage } from "./features/ledger/LedgerFeaturePage.js";
import { LegacyWorkbenchView, type LegacyWorkbenchTab } from "./features/legacy/LegacyWorkbenchView.js";
import { LogsFeaturePage } from "./features/revision/LogsFeaturePage.js";
import { AutoReviewGeneratedToggle, ProjectFileSelect } from "./features/workflow/WorkflowControls.js";
import { AgentTraceView } from "./views/AgentTraceView.js";
import { readWorkbenchRuntime } from "./lib/runtime.js";
import { describeGeneratedSaveAction } from "./lib/workflow.js";
import { buildRailStatusSummary } from "./lib/railStatus.js";
import { attachmentDisplayName } from "./lib/attachments.js";
import { parentDirectoryPath } from "./lib/projectTreeActions.js";
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
const APP_WINDOW_TITLE = "ArcWriter 0.3.2";
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
  | "traces"
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
  const [legacyWorkbenchTab, setLegacyWorkbenchTab] = useState<LegacyWorkbenchTab | null>(null);
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
    setLegacyWorkbenchTab(null);
    setCenterFeature(feature);
    if (feature === "editor" || feature === "conversations" || feature === "terminal") {
      controller.setActiveTab(feature);
      return;
    }
    if (feature === "settings") {
      controller.setActiveTab("config");
      return;
    }
    if (feature === "timeline" || feature === "ledger" || feature === "revision" || feature === "traces") {
      controller.setActiveTab("overview");
      return;
    }
    controller.setActiveTab("operations");
  }

  function selectLegacyWorkbenchTab(tab: LegacyWorkbenchTab) {
    setLegacyWorkbenchTab(tab);
    controller.setActiveTab(tab);
    if (tab === "editor" || tab === "conversations" || tab === "terminal") {
      setCenterFeature(tab);
    }
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
    <AppShell
      rightWidth={rightWidth}
      left={
        <LeftSidebar
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
      }
      center={
        <LegacyWorkbenchView
          controller={controller}
          activeTab={legacyWorkbenchTab}
          onActiveTabChange={selectLegacyWorkbenchTab}
        >
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
        </LegacyWorkbenchView>
      }
      splitter={
        <RightRailSplitter
          onReset={() => setRightWidth(DEFAULT_RIGHT_WIDTH)}
          onDrag={(clientX) => {
            const maxWidth = Math.min(620, Math.max(360, window.innerWidth - 820));
            const next = Math.min(maxWidth, Math.max(340, window.innerWidth - clientX - 14));
            setRightWidth(next);
          }}
        />
      }
      right={<AssistantRail controller={controller} mode={rightMode} onModeChange={selectRightMode} onSelectFeature={selectCenterFeature} />}
      dialog={tutorialOpen ? <WebsiteTutorialDialog onClose={() => setTutorialOpen(false)} /> : undefined}
    />
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

function formatBytes(value: number): string {
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
  return `${value} B`;
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
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function webSearchTogglePatch(config: AppConfig, enabled: boolean): Partial<AppConfig> {
  return {
    web_search_enabled: enabled,
    ...(enabled && config.web_search_provider === "custom" && !config.web_search_base_url?.trim() ? { web_search_provider: "bing" as const } : {})
  };
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
  const rightEditorRef = useRef<HTMLTextAreaElement | null>(null);
  const findInputRef = useRef<HTMLInputElement | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [findMessage, setFindMessage] = useState("");

  // 分屏管理状态
  const [isSplit, setIsSplit] = useState(false);
  const [activePane, setActivePane] = useState<"left" | "right">("left");
  const [rightFeature, setRightFeature] = useState<CenterFeature>("conversations");
  const [rightDocumentPath, setRightDocumentPath] = useState<string | null>(null);

  // 动态降级：计算右侧正在显示的活动文档
  const rightActiveDocument = controller.openDocuments.find((doc) => doc.path === rightDocumentPath) || controller.openDocuments[0] || null;

  // 自动监测右侧文档是否已被关闭，若关闭则降级重置
  useEffect(() => {
    if (rightDocumentPath && !controller.openDocuments.some((doc) => doc.path === rightDocumentPath)) {
      setRightDocumentPath(controller.openDocuments[0]?.path || null);
    }
  }, [controller.openDocuments, rightDocumentPath]);

  // 根据当前聚焦侧获取当前面板对应的文档
  const currentPaneDoc = isSplit
    ? (activePane === "left" ? activeDocument : rightActiveDocument)
    : activeDocument;

  // 根据当前聚焦侧动态计算并展示头部标题
  const title = isSplit
    ? (activePane === "left" ? featureTitle(feature, activeDocument) : featureTitle(rightFeature, rightActiveDocument))
    : featureTitle(feature, activeDocument);

  useEffect(() => {
    if (!findRequestTick) {
      return;
    }
    setFindOpen(true);
    setFindMessage("");
    requestAnimationFrame(() => findInputRef.current?.focus());
  }, [findRequestTick]);

  function handlePaneFocus(pane: "left" | "right") {
    setActivePane(pane);
    if (pane === "left") {
      if (activeDocument) {
        controller.activateDocument(activeDocument.path);
      }
    } else {
      if (rightActiveDocument) {
        controller.activateDocument(rightActiveDocument.path);
      }
    }
  }

  function handleSelectRightFeature(nextFeature: CenterFeature) {
    setRightFeature(nextFeature);
    if (nextFeature === "editor") {
      if (controller.activeDocumentPath) {
        setRightDocumentPath(controller.activeDocumentPath);
      }
    }
  }

  function insertMark(mark: string) {
    const doc = currentPaneDoc;
    if (!doc) {
      return;
    }
    const open = mark.length > 1 ? mark.slice(0, mark.length / 2) : mark;
    const close = mark.length > 1 ? mark.slice(mark.length / 2) : "";
    const ref = isSplit ? (activePane === "left" ? editorRef : rightEditorRef) : editorRef;
    const editor = ref.current;
    const start = editor?.selectionStart ?? doc.content.length;
    const end = editor?.selectionEnd ?? start;
    const selected = doc.content.slice(start, end);
    const insertion = close ? `${open}${selected}${close}` : open;
    const next = `${doc.content.slice(0, start)}${insertion}${doc.content.slice(end)}`;
    controller.updateActiveDocument(next);
    requestAnimationFrame(() => {
      const cursor = close && selected ? start + insertion.length : start + open.length;
      ref.current?.focus();
      ref.current?.setSelectionRange(cursor, cursor);
    });
  }

  function findNext() {
    const doc = currentPaneDoc;
    if (!doc || !findQuery.trim()) {
      setFindMessage(findQuery.trim() ? "当前没有可查找文档" : "请输入查找内容");
      return;
    }
    const ref = isSplit ? (activePane === "left" ? editorRef : rightEditorRef) : editorRef;
    const editor = ref.current;
    const content = doc.content;
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
      ref.current?.focus();
      ref.current?.setSelectionRange(index, index + query.length);
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
          {/* 分屏控制按钮 */}
          <button
            className={`xw-secondary-button compact ${isSplit ? "active" : ""}`}
            onClick={() => {
              setIsSplit(!isSplit);
              if (!isSplit) {
                setActivePane("left");
              }
            }}
            type="button"
            title="左右分屏显示"
          >
            <Columns size={15} />
            <span>{isSplit ? "单屏" : "分屏"}</span>
          </button>

          <button className="xw-secondary-button compact" onClick={() => void controller.reopenDocumentFromDisk()} disabled={!currentPaneDoc || controller.documentBusy}>
            <RefreshCw size={15} />
            <span>刷新</span>
          </button>
          <button className="xw-primary-button compact" onClick={() => void controller.saveActiveDocument()} disabled={!currentPaneDoc || controller.documentBusy}>
            <Save size={15} />
            <span>保存当前</span>
          </button>
        </div>
      </header>

      <div className="xw-editor-body" style={{ display: "flex", flexDirection: "column", minHeight: 0, flex: 1 }}>
        {controller.openDocuments.length > 0 && (
          <div className="xw-editor-tabs">
            {controller.openDocuments.map((document) => {
              const isActive = isSplit
                ? (activePane === "left"
                    ? document.path === controller.activeDocumentPath && feature === "editor"
                    : document.path === rightDocumentPath && rightFeature === "editor")
                : document.path === controller.activeDocumentPath && feature === "editor";
              return (
                <div key={document.path} className={`xw-editor-tab ${isActive ? "active" : ""}`}>
                  <button
                    className="xw-editor-tab-title"
                    onClick={() => {
                      if (isSplit && activePane === "right") {
                        setRightDocumentPath(document.path);
                        handleSelectRightFeature("editor");
                        controller.activateDocument(document.path);
                      } else {
                        controller.activateDocument(document.path);
                        onSelectFeature("editor");
                      }
                    }}
                  >
                    <span>{document.title}</span>
                    {document.dirty && <em>●</em>}
                  </button>
                  <button className="xw-editor-tab-close" aria-label={`关闭 ${document.title}`} onClick={() => controller.closeDocument(document.path)}>
                    <X size={13} />
                  </button>
                </div>
              );
            })}
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
            disabled={!currentPaneDoc || controller.operationsBusy}
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
          {pageTabs.map((tab) => {
            const isActive = isSplit
              ? (activePane === "left" ? feature === tab.key : rightFeature === tab.key)
              : feature === tab.key;
            return (
              <button
                key={tab.key}
                className={isActive ? "active" : ""}
                onClick={() => {
                  if (isSplit && activePane === "right") {
                    handleSelectRightFeature(tab.key);
                  } else {
                    onSelectFeature(tab.key);
                  }
                }}
              >
                {tab.label}
              </button>
            );
          })}
        </div>
        <div className="xw-punctuation-bar">
          {punctuationMarks.map((mark) => (
            <button key={mark} onClick={() => insertMark(mark)} disabled={!currentPaneDoc}>
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
                  const ref = isSplit ? (activePane === "left" ? editorRef : rightEditorRef) : editorRef;
                  ref.current?.focus();
                }
              }}
              placeholder="查找当前文档"
            />
            <button className="xw-secondary-button compact" type="button" onClick={findNext} disabled={!currentPaneDoc}>
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

        {/* 核心页面区域条件渲染 */}
        {isSplit ? (
          <div style={{ display: "flex", gap: "12px", flex: 1, minHeight: 0, width: "100%", overflow: "hidden", marginTop: "8px" }}>
            {/* 左侧分屏窗口 */}
            <div
              className={`xw-split-pane ${activePane === "left" ? "focused" : ""}`}
              style={{
                flex: 1,
                minWidth: 0,
                display: "flex",
                flexDirection: "column",
                border: activePane === "left" ? "2px solid var(--accent)" : "2px solid var(--line)",
                boxShadow: activePane === "left" ? "0 0 8px rgba(11, 110, 104, 0.2)" : "none",
                borderRadius: "12px",
                overflow: "hidden",
                transition: "all 0.2s ease"
              }}
              onMouseDown={() => handlePaneFocus("left")}
            >
              <FeatureContentSurface
                controller={controller}
                feature={feature}
                disassemblyUi={disassemblyUi}
                activeDocument={activeDocument}
                editorRef={editorRef}
                onSelectFeature={onSelectFeature}
              />
            </div>

            {/* 右侧分屏窗口 */}
            <div
              className={`xw-split-pane ${activePane === "right" ? "focused" : ""}`}
              style={{
                flex: 1,
                minWidth: 0,
                display: "flex",
                flexDirection: "column",
                border: activePane === "right" ? "2px solid var(--accent)" : "2px solid var(--line)",
                boxShadow: activePane === "right" ? "0 0 8px rgba(11, 110, 104, 0.2)" : "none",
                borderRadius: "12px",
                overflow: "hidden",
                transition: "all 0.2s ease"
              }}
              onMouseDown={() => handlePaneFocus("right")}
            >
              <FeatureContentSurface
                controller={controller}
                feature={rightFeature}
                disassemblyUi={disassemblyUi}
                activeDocument={rightActiveDocument}
                editorRef={rightEditorRef}
                onSelectFeature={handleSelectRightFeature}
              />
            </div>
          </div>
        ) : (
          <FeatureContentSurface
            controller={controller}
            feature={feature}
            disassemblyUi={disassemblyUi}
            activeDocument={activeDocument}
            editorRef={editorRef}
            onSelectFeature={onSelectFeature}
          />
        )}
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
    traces: "Agent 运行",
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
  if (feature === "traces") {
    return <AgentTraceView runtime={controller.runtime} />;
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
          <label className="xw-check-row" style={{ gridColumnStart: 2 }}>
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
